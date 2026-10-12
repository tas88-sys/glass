/**
 * modelCatalog.test.js
 *
 * The model catalog (spec 2026-10-12-model-catalog): resolution order
 * (override, API, provider default), the provider of an ID, refresh and
 * lookups (TTL, one fetch at a time, failures keep what is known),
 * ensureKnown's wait, what is learned from refusals, and the SQLite table
 * (through node:sqlite: the app's better-sqlite3 is built for Electron).
 * Run: node --test src/features/common/ai/__tests__/modelCatalog.test.js
 */

'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const catalog = require('../modelCatalog');
const LATEST_SCHEMA = require('../../config/schema');
const { createRepository } = require('../../repositories/modelCatalog/sqlite.repository');

const QWEN = 'qwen/qwen3.8-27b';
const OSS = 'openai/gpt-oss-120b';

let clock;
beforeEach(() => {
  catalog.resetCatalog();
  clock = 1_000_000;
  catalog.configure({ now: () => clock });
});

/** A fetcher whose list/get answers come from a table, counting calls. */
function fakeFetcher({ list = [], get = {}, listError = null, delayMs = 0 } = {}) {
  const calls = { list: 0, get: [] };
  const wait = () => (delayMs ? new Promise((r) => setTimeout(r, delayMs)) : Promise.resolve());
  return {
    calls,
    list: async () => {
      calls.list++;
      await wait();
      if (listError) throw listError;
      return list;
    },
    get: async (_key, id) => {
      calls.get.push(id);
      await wait();
      return Object.prototype.hasOwnProperty.call(get, id) ? get[id] : null;
    },
  };
}

/** An in-memory model_catalog table with the app's schema. */
function memoryStore() {
  const db = new DatabaseSync(':memory:');
  const schema = LATEST_SCHEMA.model_catalog;
  const cols = schema.columns.map((c) => `${c.name} ${c.type}`).join(', ');
  db.exec(`CREATE TABLE model_catalog (${cols}, ${schema.constraints.join(', ')})`);
  return { db, repo: createRepository(() => db) };
}

describe('capabilities: override, then API, then provider default', () => {
  it('uses the provider default when nothing is known', () => {
    assert.equal(catalog.capabilities('groq', 'x/new-model').vision, false);
    assert.equal(catalog.capabilities('gemini', 'gemini-9-pro').vision, true);
    assert.equal(catalog.capabilities('anthropic', 'claude-new').vision, true);
    const caps = catalog.capabilities('groq', 'x/new-model');
    assert.equal(caps.maxOutput, null);
    assert.equal(caps.reasoning, null);
    assert.deepEqual(caps.source, { vision: 'default', maxOutput: 'unknown', reasoning: 'unknown' });
  });

  it('uses what the API reported over the default', () => {
    catalog.seed('groq', [{ id: QWEN, vision: true, maxOutput: 16384, reasoning: true }]);
    const caps = catalog.capabilities('groq', QWEN);
    assert.equal(caps.vision, true);
    assert.equal(caps.maxOutput, 16384);
    assert.equal(caps.reasoning, true);
    assert.deepEqual(caps.source, { vision: 'api', maxOutput: 'api', reasoning: 'api' });
  });

  it('an override wins over the API, and null goes back to automatic', () => {
    catalog.seed('gemini', [{ id: 'gemini-3.5-flash-lite', vision: null, maxOutput: 65536 }]);
    catalog.setOverride('gemini', 'gemini-3.5-flash-lite', 'vision', false);
    catalog.setOverride('gemini', 'gemini-3.5-flash-lite', 'maxOutput', 8000);
    let caps = catalog.capabilities('gemini', 'gemini-3.5-flash-lite');
    assert.equal(caps.vision, false);
    assert.equal(caps.maxOutput, 8000);
    assert.deepEqual(caps.source, { vision: 'override', maxOutput: 'override', reasoning: 'unknown' });

    catalog.setOverride('gemini', 'gemini-3.5-flash-lite', 'vision', null);
    caps = catalog.capabilities('gemini', 'gemini-3.5-flash-lite');
    assert.equal(caps.vision, true);
    assert.equal(caps.source.vision, 'default');
  });

  it('rejects a bad override', () => {
    assert.throws(() => catalog.setOverride('groq', QWEN, 'temperature', 1), /not an override field/);
    assert.throws(() => catalog.setOverride('groq', QWEN, 'vision', 'yes'), /true, false or null/);
    assert.throws(() => catalog.setOverride('groq', QWEN, 'maxOutput', -5), /positive/);
    assert.throws(() => catalog.setOverride('ollama', 'llama3', 'vision', true), /no catalog/);
  });

  it('a refresh keeps the override', async () => {
    const fetcher = fakeFetcher({ list: [{ id: QWEN, vision: true, maxOutput: 16384, reasoning: true }] });
    catalog.configure({ fetchers: { groq: fetcher } });
    catalog.setOverride('groq', QWEN, 'vision', false);
    await catalog.refresh('groq', 'gsk_test', { force: true });
    assert.equal(catalog.capabilities('groq', QWEN).vision, false);
    assert.equal(catalog.capabilities('groq', QWEN).source.vision, 'override');
  });
});

describe('providerOf: the provider whose list has the ID', () => {
  it('one provider lists it', () => {
    catalog.seed('groq', [{ id: OSS }]);
    assert.equal(catalog.providerOf(OSS), 'groq');
  });

  it('no provider lists it', () => {
    assert.equal(catalog.providerOf('openai/gpt-oss-120b'), null);
  });

  it('several list it: the context when it is one of them, else the first', () => {
    catalog.seed('groq', [{ id: 'shared/model' }]);
    catalog.seed('gemini', [{ id: 'shared/model' }]);
    assert.deepEqual(catalog.providersListing('shared/model'), ['gemini', 'groq']);
    assert.equal(catalog.providerOf('shared/model', 'groq'), 'groq');
    assert.equal(catalog.providerOf('shared/model', 'anthropic'), 'gemini');
  });

  it('a model the provider said it lacks has no provider', async () => {
    catalog.configure({ fetchers: { groq: fakeFetcher({ list: [], get: {} }) } });
    await catalog.ensureKnown('groq', 'gsk_test', ['typo/model']);
    assert.equal(catalog.providerOf('typo/model'), null);
    assert.equal(catalog.capabilities('groq', 'typo/model').listed, false);
  });
});

describe('refresh', () => {
  it('reads the list once per TTL, and again with force or after it', async () => {
    const fetcher = fakeFetcher({ list: [{ id: OSS, vision: false }] });
    catalog.configure({ fetchers: { groq: fetcher } });
    assert.equal(await catalog.refresh('groq', 'gsk_test'), true);
    await catalog.refresh('groq', 'gsk_test');
    assert.equal(fetcher.calls.list, 1);
    await catalog.refresh('groq', 'gsk_test', { force: true });
    assert.equal(fetcher.calls.list, 2);
    clock += catalog.REFRESH_TTL_MS + 1;
    await catalog.refresh('groq', 'gsk_test');
    assert.equal(fetcher.calls.list, 3);
  });

  it('runs one read at a time per provider', async () => {
    const fetcher = fakeFetcher({ list: [{ id: OSS }], delayMs: 20 });
    catalog.configure({ fetchers: { groq: fetcher } });
    await Promise.all([catalog.refresh('groq', 'k', { force: true }), catalog.refresh('groq', 'k', { force: true })]);
    assert.equal(fetcher.calls.list, 1);
  });

  it('a failure keeps what is known', async () => {
    catalog.configure({ fetchers: { groq: fakeFetcher({ list: [{ id: QWEN, vision: true }] }) } });
    await catalog.refresh('groq', 'k');
    catalog.configure({ fetchers: { groq: fakeFetcher({ listError: new Error('503 overloaded') }) } });
    assert.equal(await catalog.refresh('groq', 'k', { force: true }), false);
    assert.equal(catalog.capabilities('groq', QWEN).vision, true);
    assert.equal(catalog.providerOf(QWEN), 'groq');
  });

  it('a model the new list lacks becomes unknown and is looked up again', async () => {
    const first = fakeFetcher({ list: [{ id: QWEN, vision: true }, { id: OSS, vision: false }] });
    catalog.configure({ fetchers: { groq: first } });
    await catalog.refresh('groq', 'k');
    const second = fakeFetcher({ list: [{ id: OSS, vision: false }], get: { [QWEN]: { id: QWEN, vision: true } } });
    catalog.configure({ fetchers: { groq: second } });
    await catalog.refresh('groq', 'k', { force: true });
    assert.equal(catalog.isKnown('groq', QWEN), false);
    await catalog.ensureKnown('groq', 'k', [QWEN]);
    assert.deepEqual(second.calls.get, [QWEN]);
    assert.equal(catalog.providerOf(QWEN), 'groq');
  });

  it('without a key or a fetcher it reads nothing', async () => {
    assert.equal(await catalog.refresh('groq', 'k'), false);
    catalog.configure({ fetchers: { groq: fakeFetcher() } });
    assert.equal(await catalog.refresh('groq', ''), false);
  });
});

describe('ensureKnown', () => {
  it('returns at once when every ID is known', async () => {
    const fetcher = fakeFetcher({ list: [{ id: OSS }] });
    catalog.configure({ fetchers: { groq: fetcher } });
    catalog.seed('groq', [{ id: OSS }]);
    await catalog.ensureKnown('groq', 'k', [OSS]);
    assert.equal(fetcher.calls.list, 0);
  });

  it('reads the list, then looks up an ID it lacks (an alias)', async () => {
    const fetcher = fakeFetcher({ list: [{ id: 'claude-opus-5-5' }], get: { 'claude-latest': { id: 'claude-latest', vision: true, maxOutput: 128000 } } });
    catalog.configure({ fetchers: { anthropic: fetcher } });
    await catalog.ensureKnown('anthropic', 'k', ['claude-opus-5-5', 'claude-latest']);
    assert.equal(fetcher.calls.list, 1);
    assert.deepEqual(fetcher.calls.get, ['claude-latest']);
    assert.equal(catalog.capabilities('anthropic', 'claude-latest').maxOutput, 128000);
    assert.equal(catalog.providerOf('claude-latest'), 'anthropic');
  });

  it('waits at most timeoutMs, and the work finishes in the background', async () => {
    const fetcher = fakeFetcher({ list: [{ id: QWEN, vision: true }], delayMs: 80 });
    catalog.configure({ fetchers: { groq: fetcher } });
    const started = Date.now();
    await catalog.ensureKnown('groq', 'k', [QWEN], { timeoutMs: 10 });
    assert.ok(Date.now() - started < 70, 'returned before the fetch ended');
    assert.equal(catalog.isKnown('groq', QWEN), false);
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(catalog.isKnown('groq', QWEN), true);
  });

  it('a model the provider lacks is not looked up again within the TTL', async () => {
    const fetcher = fakeFetcher({ list: [], get: {} });
    catalog.configure({ fetchers: { groq: fetcher } });
    await catalog.ensureKnown('groq', 'k', ['typo/model']);
    await catalog.ensureKnown('groq', 'k', ['typo/model']);
    assert.deepEqual(fetcher.calls.get, ['typo/model']);
    clock += catalog.REFRESH_TTL_MS + 1;
    await catalog.ensureKnown('groq', 'k', ['typo/model']);
    assert.deepEqual(fetcher.calls.get, ['typo/model', 'typo/model']);
  });

  it('does nothing without fetchers (tests, or before startup)', async () => {
    await catalog.ensureKnown('groq', 'k', ['x/y']);
    assert.equal(catalog.isKnown('groq', 'x/y'), false);
  });
});

describe('learned from refusals', () => {
  it('records the key output limit, which expires and is cleared with the key', () => {
    catalog.recordKeyOutputLimit('groq', QWEN, 1000);
    assert.equal(catalog.keyOutputLimit('groq', QWEN), 1000);
    assert.equal(catalog.capabilities('groq', QWEN).keyOutputLimit, 1000);
    clock += catalog.KEY_LIMIT_TTL_MS + 1;
    assert.equal(catalog.keyOutputLimit('groq', QWEN), null);

    catalog.recordKeyOutputLimit('groq', QWEN, 1000);
    catalog.clearKeyLimits('groq');
    assert.equal(catalog.keyOutputLimit('groq', QWEN), null);
  });

  it('records the server-side fallback refusal per model', () => {
    assert.equal(catalog.capabilities('anthropic', 'claude-haiku-5-5').serverFallback, null);
    catalog.markServerFallback('anthropic', 'claude-haiku-5-5', false);
    assert.equal(catalog.capabilities('anthropic', 'claude-haiku-5-5').serverFallback, false);
    assert.equal(catalog.capabilities('anthropic', 'claude-opus-5-5').serverFallback, null);
  });
});

describe('the model_catalog table', () => {
  it('saves what is written and loads it back', async () => {
    const { repo } = memoryStore();
    catalog.configure({ store: repo, fetchers: { anthropic: fakeFetcher({ list: [{ id: 'claude-opus-5-5', vision: true, maxOutput: 128000, reasoning: true, thinking: true, effortLevels: ['low', 'high', 'max'] }] }) } });
    await catalog.refresh('anthropic', 'k');
    catalog.setOverride('anthropic', 'claude-opus-5-5', 'maxOutput', 32000);
    catalog.markServerFallback('anthropic', 'claude-opus-5-5', false);
    catalog.recordKeyOutputLimit('anthropic', 'claude-opus-5-5', 4000);

    catalog.resetCatalog();
    catalog.configure({ store: repo, now: () => clock });
    assert.equal(catalog.load(), 1);
    const caps = catalog.capabilities('anthropic', 'claude-opus-5-5');
    assert.equal(caps.vision, true);
    assert.equal(caps.maxOutput, 32000);
    assert.equal(caps.source.maxOutput, 'override');
    assert.deepEqual(caps.effortLevels, ['low', 'high', 'max']);
    assert.equal(caps.thinking, true);
    assert.equal(caps.serverFallback, false);
    assert.equal(caps.keyOutputLimit, 4000);
    assert.equal(catalog.providerOf('claude-opus-5-5'), 'anthropic');
  });

  it('an upsert from a refresh does not erase the override', async () => {
    const { db, repo } = memoryStore();
    catalog.configure({ store: repo, fetchers: { groq: fakeFetcher({ list: [{ id: QWEN, vision: true }] }) } });
    catalog.setOverride('groq', QWEN, 'reasoning', false);
    await catalog.refresh('groq', 'k', { force: true });
    const row = db.prepare('SELECT * FROM model_catalog WHERE model_id = ?').get(QWEN);
    assert.equal(row.override_reasoning, 0);
    assert.equal(row.vision, 1);
    assert.equal(row.listed, 1);
  });

  it('a store that throws is logged, not raised', () => {
    catalog.configure({ store: { getAll: () => { throw new Error('locked'); }, upsert: () => { throw new Error('locked'); } } });
    assert.equal(catalog.load(), 0);
    assert.doesNotThrow(() => catalog.setOverride('groq', QWEN, 'vision', true));
    assert.equal(catalog.capabilities('groq', QWEN).vision, true);
  });
});

describe('snapshot', () => {
  it('describes the asked IDs, known or not', () => {
    catalog.seed('groq', [{ id: QWEN, vision: true, maxOutput: 16384 }]);
    const [qwen, unknown] = catalog.snapshot({ provider: 'groq', ids: [QWEN, 'typo/x'] });
    assert.equal(qwen.listed, true);
    assert.equal(qwen.vision, true);
    assert.equal(qwen.source.vision, 'api');
    assert.equal(unknown.listed, null);
    assert.equal(unknown.vision, false);
    assert.equal(unknown.source.vision, 'default');
  });
});

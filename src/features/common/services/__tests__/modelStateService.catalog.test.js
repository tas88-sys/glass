/**
 * modelStateService.catalog.test.js
 *
 * The main-process side of the model catalog (spec 2026-10-12-model-catalog):
 * startup loads the saved catalog and reads the lists of the providers with a
 * key; saving a list learns its models first, so their provider comes from
 * the providers' lists; planModelList is what Settings shows; an override is
 * kept; a new key forgets the learned key limits. The repositories, auth and
 * electron-store are faked; the catalog is the real module.
 * Run: node --test src/features/common/services/__tests__/modelStateService.catalog.test.js
 */

'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

// --- fakes -----------------------------------------------------------------

const rows = new Map(); // provider → provider_settings row
const providerSettings = {
  getAll: async () => [...rows.values()].map((r) => ({ ...r })),
  getByProvider: async (p) => (rows.has(p) ? { ...rows.get(p) } : null),
  upsert: async (p, s) => { rows.set(p, { ...(rows.get(p) || {}), ...s, provider: p }); },
  getRawApiKeys: async () => [...rows.values()].map((r) => ({ api_key: r.api_key })),
  setActiveProvider: async (p, type) => {
    const col = type === 'llm' ? 'is_active_llm' : 'is_active_stt';
    for (const r of rows.values()) r[col] = r.provider === p ? 1 : 0;
  },
  getActiveProvider: async (type) => [...rows.values()].find((r) => r[type === 'llm' ? 'is_active_llm' : 'is_active_stt']) || null,
  getActiveSettings: async () => ({
    llm: [...rows.values()].find((r) => r.is_active_llm) || null,
    stt: [...rows.values()].find((r) => r.is_active_stt) || null,
  }),
};
const catalogStore = { saved: [], getAll: () => catalogStore.saved, upsert: (row) => { catalogStore.saved = catalogStore.saved.filter((r) => !(r.provider === row.provider && r.model_id === row.model_id)).concat(row); } };

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron-store') return class { get() {} set() {} delete() {} };
  if (request === '../repositories/providerSettings') return providerSettings;
  if (request === '../repositories/modelCatalog') return catalogStore;
  if (request === '../repositories/ollamaModel') return { getInstalledModels: () => [] };
  if (request === './authService') return { getCurrentUserId: () => 'default_user', getCurrentUser: () => ({ isLoggedIn: false }) };
  if (request === './encryptionService') return { looksEncrypted: () => false, initializeKey: async () => {} };
  return originalLoad.apply(this, arguments);
};

const catalog = require('../../ai/modelCatalog');
const service = require('../modelStateService');

// The providers' models lists, as the fetchers return them.
const LISTS = {
  groq: [
    { id: 'openai/gpt-oss-120b', vision: false, maxOutput: 65536, reasoning: true },
    { id: 'qwen/qwen3.9-27b', vision: true, maxOutput: 32768, reasoning: true },
    { id: 'allam-2-7b', vision: false, maxOutput: 4096, reasoning: false },
  ],
  gemini: [{ id: 'gemini-3.5-flash-lite', vision: null, maxOutput: 65536, thinking: true }],
};
let fetchCalls;
function fetchers() {
  const of = (p) => ({
    list: async (key) => { fetchCalls.push(`${p} list ${key}`); return LISTS[p] || []; },
    get: async (key, id) => { fetchCalls.push(`${p} get ${id}`); return null; },
  });
  return { groq: of('groq'), gemini: of('gemini'), anthropic: of('anthropic') };
}

beforeEach(() => {
  rows.clear();
  catalogStore.saved = [];
  catalog.resetCatalog();
  catalog.configure({ store: catalogStore, fetchers: fetchers() });
  fetchCalls = [];
  service.removeAllListeners();
});

const withKeys = (keys) => { for (const [p, k] of Object.entries(keys)) rows.set(p, { provider: p, api_key: k }); };

describe('saving a model list', () => {
  it('learns the models first: a new vision model is known, with its provider from the list', async () => {
    withKeys({ groq: 'gsk_x', gemini: 'AIza_x' });
    const list = 'openai/gpt-oss-120b,qwen/qwen3.9-27b,allam-2-7b,gemini-3.5-flash-lite';
    assert.equal(await service.setSelectedModel('llm', list, 'groq'), true);
    assert.ok(fetchCalls.includes('groq list gsk_x') && fetchCalls.includes('gemini list AIza_x'), fetchCalls.join(', '));
    assert.equal(rows.get('groq').selected_llm_model, list);
    assert.equal(rows.get('groq').is_active_llm, 1);
    assert.equal(catalog.capabilities('groq', 'qwen/qwen3.9-27b').vision, true);
    assert.ok(catalogStore.saved.some((r) => r.model_id === 'qwen/qwen3.9-27b' && r.vision === 1), 'saved in the table');

    const plan = await service.planModelList({ list, fieldProvider: 'groq' });
    assert.deepEqual(plan.segments, [
      { provider: 'groq', models: ['openai/gpt-oss-120b', 'qwen/qwen3.9-27b', 'allam-2-7b'] },
      { provider: 'gemini', models: ['gemini-3.5-flash-lite'] },
    ], 'allam-2-7b has no slash: Groq because its list has it');
    const byId = Object.fromEntries(plan.models.map((m) => [m.modelId, m]));
    assert.equal(byId['qwen/qwen3.9-27b'].vision, true);
    assert.equal(byId['qwen/qwen3.9-27b'].source.vision, 'api');
    assert.equal(byId['gemini-3.5-flash-lite'].vision, true);
    assert.equal(byId['gemini-3.5-flash-lite'].source.vision, 'default');
    assert.equal(byId['allam-2-7b'].providerSource, 'catalog');
    assert.deepEqual(plan.missingKeys, []);
  });

  it('an ID no provider has: looked up, then shown as missing', async () => {
    withKeys({ groq: 'gsk_x' });
    await service.setSelectedModel('llm', 'openai/gpt-oss-120b,typo/model', 'groq');
    assert.ok(fetchCalls.includes('groq get typo/model'), fetchCalls.join(', '));
    const plan = await service.planModelList({ list: 'openai/gpt-oss-120b,typo/model', fieldProvider: 'groq' });
    const typo = plan.models.find((m) => m.modelId === 'typo/model');
    assert.equal(typo.listed, false);
    assert.equal(typo.providerSource, 'prefix');
  });

  it('planModelList names a provider without a key', async () => {
    withKeys({ groq: 'gsk_x' });
    const plan = await service.planModelList({ list: 'openai/gpt-oss-120b,gemini-3.5-flash-lite', fieldProvider: 'groq' });
    assert.deepEqual(plan.missingKeys, ['gemini']);
  });
});

describe('overrides from Settings', () => {
  it('are kept, and say so in the plan', async () => {
    withKeys({ gemini: 'AIza_x' });
    catalog.seed('gemini', LISTS.gemini);
    assert.deepEqual(await service.setCapabilityOverride({ provider: 'gemini', modelId: 'gemini-3.5-flash-lite', field: 'vision', value: false }), { success: true });
    const [model] = (await service.planModelList({ list: 'gemini-3.5-flash-lite', fieldProvider: 'gemini' })).models;
    assert.equal(model.vision, false);
    assert.equal(model.source.vision, 'override');
    assert.equal(model.override.vision, false);
  });

  it('a bad one is refused with a message', async () => {
    const result = await service.setCapabilityOverride({ provider: 'groq', modelId: 'x/y', field: 'maxOutput', value: -1 });
    assert.equal(result.success, false);
    assert.match(result.error, /positive/);
  });
});

describe('keys and startup', () => {
  it('a new key forgets the learned key limits and reads the list again', async (t) => {
    t.mock.method(service, 'validateApiKey', async () => ({ success: true }));
    t.mock.method(service, '_autoSelectAvailableModels', async () => {});
    catalog.recordKeyOutputLimit('groq', 'qwen/qwen3.9-27b', 1000);
    await service.setApiKey('groq', 'gsk_new');
    assert.equal(catalog.keyOutputLimit('groq', 'qwen/qwen3.9-27b'), null);
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(fetchCalls.includes('groq list gsk_new'), fetchCalls.join(', '));
  });

  it('refreshCatalog reads the lists of the providers with a key, then tells the windows', async () => {
    withKeys({ groq: 'gsk_x' });
    let updated = 0;
    service.on('state-updated', () => updated++);
    await service.refreshCatalog({ force: true });
    assert.deepEqual(fetchCalls, ['groq list gsk_x']);
    assert.equal(updated, 1);
    assert.equal(catalog.providerOf('allam-2-7b'), 'groq');
  });

  it('getSelectedModels names the row of the active list, and the offered models carry their provider', async () => {
    withKeys({ groq: 'gsk_x' });
    await service.setSelectedModel('llm', 'openai/gpt-oss-120b', 'groq');
    const selected = await service.getSelectedModels();
    assert.equal(selected.llmProvider, 'groq');
    const offered = await service.getAvailableModels('llm');
    assert.ok(offered.length > 0 && offered.every((m) => m.provider === 'groq'));
    assert.equal(service.getProviderConfig().groq.catalog, true);
    assert.equal(service.getProviderConfig().openai.catalog, false);
  });
});

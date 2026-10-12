/**
 * factory.test.js
 *
 * Provider presets and the model-ID prefix rule that maps a typed model (or
 * CSV list) to its provider.
 * Run: node --test src/features/common/ai/__tests__/factory.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { PROVIDERS, inferProviderFromModelId } = require('../factory');

describe('Anthropic presets (FR-001)', () => {
  it('are the current Opus, Sonnet and Haiku', () => {
    assert.deepEqual(PROVIDERS.anthropic.llmModels.map(m => m.id), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
  });

  it('list no retired Claude 3 model', () => {
    for (const provider of Object.values(PROVIDERS)) {
      for (const m of [...provider.llmModels, ...provider.sttModels]) assert.doesNotMatch(m.id, /^claude-3/);
    }
  });

  it('have no STT model', () => {
    assert.deepEqual(PROVIDERS.anthropic.sttModels, []);
  });
});

describe('inferProviderFromModelId (FR-002)', () => {
  const cases = [
    ['claude-haiku-5-5', 'anthropic'],
    ['claude-haiku-5-5,claude-sonnet-5-5', 'anthropic'],
    [' claude-opus-5-5 ', 'anthropic'],
    [' , claude-sonnet-5-5', 'anthropic'],
    ['gemini-3-flash-preview', 'gemini'],
    ['gemini-3.1-flash-lite,gemini-3-flash-preview', 'gemini'],
    ['gpt-4.1', null],
    ['llama3.2:latest', null],
    ['', null],
    [null, null],
    [undefined, null],
    [42, null],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} → ${expected}`, () => assert.equal(inferProviderFromModelId(input), expected));
  }
});

describe('Groq provider (spec 2026-10-12-groq-provider FR-001)', () => {
  const RETIRED = /^(llama-3\.[13]-|qwen\/qwen3-32b|qwen\/qwen3\.6-|meta-llama\/llama-4-|moonshotai\/|groq\/compound)/;

  it('is registered with the three active chat models and no STT model', () => {
    assert.equal(PROVIDERS.groq.name, 'Groq');
    assert.deepEqual(PROVIDERS.groq.llmModels.map(m => m.id), ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b']);
    assert.deepEqual(PROVIDERS.groq.sttModels, []);
  });

  it('offers no model retired for free and developer tiers', () => {
    for (const m of PROVIDERS.groq.llmModels) assert.doesNotMatch(m.id, RETIRED);
  });

  it('getProviderClass resolves GroqProvider', () => {
    const { getProviderClass } = require('../factory');
    const { GroqProvider } = require('../providers/groq');
    assert.equal(getProviderClass('groq'), GroqProvider);
  });
});

describe('inferProviderFromModelId: Groq (spec 2026-10-12-groq-provider FR-002)', () => {
  const cases = [
    ['openai/gpt-oss-120b', 'groq'],
    ['qwen/qwen3.8-27b,openai/gpt-oss-20b', 'groq'],
    [' openai/gpt-oss-20b', 'groq'],
    [' , qwen/qwen3.8-27b', 'groq'],
    ['acme/model-1', 'groq'],
    ['claude-haiku-5-5,openai/gpt-oss-120b', 'anthropic'],
    ['gemini-3-flash-preview,openai/gpt-oss-120b', 'gemini'],
    ['llama-3.3-70b-versatile', null],
    ['a b/c', null],
    ['/model', null],
    ['vendor/', null],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} → ${expected}`, () => assert.equal(inferProviderFromModelId(input), expected));
  }
});

describe('splitByProvider (spec 2026-10-12-cross-provider-failover FR-001)', () => {
  const { splitByProvider } = require('../factory');
  const cases = [
    ['', 'groq', []],
    ['  , ', 'groq', []],
    [null, 'groq', []],
    [undefined, 'groq', []],
    ['openai/gpt-oss-120b', 'groq', [{ provider: 'groq', models: ['openai/gpt-oss-120b'] }]],
    ['openai/gpt-oss-120b,openai/gpt-oss-20b', 'groq', [{ provider: 'groq', models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'] }]],
    ['openai/gpt-oss-120b,gemini-3.5-flash-lite', 'groq', [{ provider: 'groq', models: ['openai/gpt-oss-120b'] }, { provider: 'gemini', models: ['gemini-3.5-flash-lite'] }]],
    [' openai/gpt-oss-120b , ,gemini-3.5-flash-lite ', 'groq', [{ provider: 'groq', models: ['openai/gpt-oss-120b'] }, { provider: 'gemini', models: ['gemini-3.5-flash-lite'] }]],
    ['openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b,gemini-3.5-flash-lite,gemini-3.1-flash-lite', 'groq', [
      { provider: 'groq', models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'] },
      { provider: 'gemini', models: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'] },
    ]],
    ['gemini-3.5-flash-lite,custom-model', 'gemini', [{ provider: 'gemini', models: ['gemini-3.5-flash-lite', 'custom-model'] }]],
    ['foo,gemini-y', 'gemini', [{ provider: 'gemini', models: ['foo', 'gemini-y'] }]],
    ['openai/gpt-oss-120b,custom,gemini-y', 'groq', [{ provider: 'groq', models: ['openai/gpt-oss-120b', 'custom'] }, { provider: 'gemini', models: ['gemini-y'] }]],
    ['a/x,gemini-y,b/z', 'groq', [{ provider: 'groq', models: ['a/x'] }, { provider: 'gemini', models: ['gemini-y'] }, { provider: 'groq', models: ['b/z'] }]],
    ['claude-haiku-5-5,openai/gpt-oss-120b', 'anthropic', [{ provider: 'anthropic', models: ['claude-haiku-5-5'] }, { provider: 'groq', models: ['openai/gpt-oss-120b'] }]],
    ['gemini-3.5-flash-lite,claude-haiku-5-5,claude-sonnet-5-5', 'gemini', [{ provider: 'gemini', models: ['gemini-3.5-flash-lite'] }, { provider: 'anthropic', models: ['claude-haiku-5-5', 'claude-sonnet-5-5'] }]],
    ['gpt-4.1,gemini-y', 'openai', [{ provider: 'openai', models: ['gpt-4.1', 'gemini-y'] }]],
    ['llama3.2:latest,library/x', 'ollama', [{ provider: 'ollama', models: ['llama3.2:latest', 'library/x'] }]],
  ];
  for (const [csv, first, expected] of cases) {
    it(`${JSON.stringify(csv)} (${first}) → ${expected.map(s => s.provider).join(',') || '[]'}`, () => {
      assert.deepEqual(splitByProvider(csv, first), expected);
    });
  }
});

describe('factory routing (spec 2026-10-12-cross-provider-failover FR-002, SC-005)', () => {
  const factory = require('../factory');
  const providerChain = require('../providerChain');

  /**
   * Replace provider modules in require.cache with recording stubs; the
   * factory's handlers and the chain's adapters require them lazily.
   * Returns { calls, restore }.
   */
  function stubProviders(names) {
    const calls = [];
    const saved = [];
    for (const name of names) {
      const path = require.resolve(`../providers/${name}`);
      saved.push([path, require.cache[path]]);
      const instance = (kind, opts) => {
        const call = { provider: name, kind, opts };
        calls.push(call);
        const body = () => new Response(new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ _final_model: name })}\n\ndata: [DONE]\n\n`));
            c.close();
          },
        }));
        return kind === 'stream'
          ? { stub: name, streamChat: async () => body() }
          : { stub: name, chat: async () => ({ content: name, raw: null, _modelUsed: name }), generateContent: async () => ({ response: { text: () => name } }) };
      };
      require.cache[path] = {
        id: path, filename: path, loaded: true,
        exports: {
          createStreamingLLM: (opts) => instance('stream', opts),
          createLLM: (opts) => instance('once', opts),
          requestDeadlineMs: () => 45_000,
          modelTraits: () => ({ vision: false }),
          orderForImages: (models) => [...models],
        },
      };
    }
    return {
      calls,
      restore: () => { for (const [path, entry] of saved) { if (entry) require.cache[path] = entry; else delete require.cache[path]; } },
    };
  }

  const KEYS = { groq: 'gsk_test', gemini: 'AIza_test' };
  const LANE = { apiKey: 'gsk_test', temperature: 0.7, maxTokens: 900, usePortkey: false, portkeyVirtualKey: undefined };

  it('a single-provider list calls its provider once with the caller\'s options minus keys; no chain (E1, E2)', (t) => {
    const stubs = stubProviders(['groq']);
    t.after(stubs.restore);
    const chainStream = t.mock.method(providerChain, 'createChainStreamingLLM');
    const chainOnce = t.mock.method(providerChain, 'createChainLLM');
    const model = 'openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b';
    const streaming = factory.createStreamingLLM('groq', { ...LANE, model, keys: KEYS });
    const once = factory.createLLM('groq', { ...LANE, model, keys: KEYS });
    assert.equal(streaming.stub, 'groq');
    assert.equal(once.stub, 'groq');
    assert.deepEqual(stubs.calls.map(c => [c.kind, c.opts]), [['stream', { ...LANE, model }], ['once', { ...LANE, model }]]);
    for (const c of stubs.calls) assert.equal('keys' in c.opts, false);
    assert.equal(chainStream.mock.callCount(), 0);
    assert.equal(chainOnce.mock.callCount(), 0);
  });

  it('options without keys reach a single provider as they were', (t) => {
    const stubs = stubProviders(['gemini']);
    t.after(stubs.restore);
    const opts = { ...LANE, apiKey: 'AIza_test', model: 'gemini-3.5-flash-lite' };
    factory.createStreamingLLM('gemini', opts);
    assert.deepEqual(stubs.calls[0].opts, opts);
  });

  it('a mixed list returns the chain; each provider gets its own key and never keys', async (t) => {
    const stubs = stubProviders(['groq', 'gemini']);
    t.after(stubs.restore);
    const chainStream = t.mock.method(providerChain, 'createChainStreamingLLM');
    const chainOnce = t.mock.method(providerChain, 'createChainLLM');
    const model = 'openai/gpt-oss-120b,gemini-3.5-flash-lite';
    const streaming = factory.createStreamingLLM('groq', { ...LANE, model, keys: KEYS });
    const once = factory.createLLM('groq', { ...LANE, model, keys: KEYS });
    assert.equal(streaming.stub, undefined);
    assert.equal(chainStream.mock.callCount(), 1);
    assert.equal(chainOnce.mock.callCount(), 1);
    assert.deepEqual(chainStream.mock.calls[0].arguments[0].segments, [
      { provider: 'groq', models: ['openai/gpt-oss-120b'] },
      { provider: 'gemini', models: ['gemini-3.5-flash-lite'] },
    ]);
    assert.equal(stubs.calls.length, 0, 'providers are created per request');

    await (await streaming.streamChat([{ role: 'user', content: 'q' }])).text();
    assert.deepEqual(stubs.calls.map(c => [c.provider, c.opts.apiKey, c.opts.model, 'keys' in c.opts]), [['groq', 'gsk_test', 'openai/gpt-oss-120b', false]]);
    assert.equal((await once.chat([{ role: 'user', content: 'q' }])).content, 'groq');
  });

  it('openai and ollama lists are never split (E9)', (t) => {
    const stubs = stubProviders(['openai', 'ollama']);
    t.after(stubs.restore);
    const chainStream = t.mock.method(providerChain, 'createChainStreamingLLM');
    factory.createStreamingLLM('openai', { ...LANE, apiKey: 'sk-x', model: 'gpt-4.1,gemini-3.5-flash-lite', keys: { openai: 'sk-x' } });
    factory.createStreamingLLM('openai-glass', { ...LANE, apiKey: 'sk-x', model: 'gpt-4.1-glass,gemini-3.5-flash-lite', keys: { 'openai-glass': 'sk-x' } });
    factory.createLLM('ollama', { ...LANE, apiKey: 'local', model: 'llama3.2:latest,library/x', keys: { ollama: 'local' } });
    assert.equal(chainStream.mock.callCount(), 0);
    assert.deepEqual(stubs.calls.map(c => [c.provider, c.opts.model, 'keys' in c.opts]), [
      ['openai', 'gpt-4.1,gemini-3.5-flash-lite', false],
      ['openai', 'gpt-4.1-glass,gemini-3.5-flash-lite', false],
      ['ollama', 'llama3.2:latest,library/x', false],
    ]);
  });
});

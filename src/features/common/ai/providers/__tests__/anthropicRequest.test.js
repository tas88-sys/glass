/**
 * anthropicRequest.test.js
 *
 * The pure half of the Anthropic provider: request building (data-model
 * "Request params"), the effort gate (from the catalog, seeded with a Models
 * API response in the SDK's shape), the timeout settings, and key validation
 * and the models list against a mocked SDK.
 * Every env read is injected; process.env is never touched.
 * Run: node --test src/features/common/ai/providers/__tests__/anthropicRequest.test.js
 */

'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

// The real SDK, loaded before the interceptor, so the fake raises its real
// error classes and instanceof checks match production.
const realSdk = require('@anthropic-ai/sdk');

let modelsList = null; // (params, options) => Promise, set per test
let modelsRetrieve = null; // (id, params, options) => Promise, set per test
let sdkCalls = [];
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '@anthropic-ai/sdk') {
    return {
      ...realSdk,
      Anthropic: class {
        constructor(opts) {
          this.models = {
            list: (params, options) => {
              sdkCalls.push({ kind: 'models.list', clientOpts: opts, params, options });
              return modelsList(params, options);
            },
            retrieve: (id, params, options) => {
              sdkCalls.push({ kind: 'models.retrieve', id, params, options });
              return modelsRetrieve(id, params, options);
            },
          };
          const noMessages = () => { sdkCalls.push({ kind: 'messages' }); throw new Error('unexpected messages call'); };
          this.messages = { create: noMessages };
          this.beta = { messages: { create: noMessages } };
        }
      },
    };
  }
  return originalLoad.apply(this, arguments);
};
for (const k of Object.keys(require.cache)) if (k.includes('anthropic.js')) delete require.cache[k];

const catalog = require('../../modelCatalog');
const ANTHROPIC_MODELS = require('../../__tests__/fixtures/anthropic-models.json');
const {
  AnthropicProvider,
  listModels,
  getModel,
  normalizeModel,
  buildRequest,
  acceptsEffort,
  effortLevels,
  firstTextTimeoutMs,
  requestDeadlineMs,
  idleTimeoutMs,
} = require('../anthropic');

const PRESETS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
const user = (content) => ({ role: 'user', content });
const build = (input) => buildRequest({ messages: [user('hi')], env: {}, ...input });
const LISTED = ANTHROPIC_MODELS.data.filter((m) => m.lifecycle !== 'retired');

// What the Models API reports, as the catalog keeps it.
beforeEach(() => {
  catalog.resetCatalog();
  catalog.seed('anthropic', LISTED.map(normalizeModel));
});

describe('buildRequest: never sends sampling parameters or thinking (SC-005)', () => {
  for (const modelId of [...PRESETS, 'claude-haiku-4-5', 'claude-sonnet-4-5']) {
    it(modelId, () => {
      for (const mode of ['stream', 'once']) {
        const { params } = build({ modelId, mode, maxTokens: 900 });
        for (const key of ['temperature', 'top_p', 'top_k', 'thinking']) {
          assert.equal(key in params, false, `${mode}: ${key}`);
        }
      }
    });
  }
});

describe('acceptsEffort (catalog: capabilities.effort)', () => {
  for (const id of PRESETS) it(`${id} → true`, () => assert.equal(acceptsEffort(id), true));
  for (const id of ['claude-haiku-4-5', 'claude-sonnet-4-5']) it(`${id} → false (effort.supported false)`, () => assert.equal(acceptsEffort(id), false));
  for (const id of ['claude-opus-9', 'gemini-3-flash-preview', '', undefined]) {
    it(`${String(id)} → false (not in the catalog: no effort sent)`, () => assert.equal(acceptsEffort(id), false));
  }

  it('the levels are the ones the API marks supported', () => {
    assert.deepEqual([...effortLevels('claude-opus-5-5')].sort(), ['high', 'low', 'max', 'medium', 'xhigh']);
    assert.deepEqual([...effortLevels('claude-haiku-5-5')].sort(), ['high', 'low', 'max', 'medium'], 'xhigh: null');
    assert.deepEqual(effortLevels('claude-haiku-4-5'), []);
  });

  it('a new model the API reports gets effort with no code change', () => {
    catalog.seed('anthropic', [{ id: 'claude-opus-6', vision: true, maxOutput: 256_000, effortLevels: ['low', 'high'], thinking: true }]);
    assert.equal(build({ modelId: 'claude-opus-6', effort: 'high' }).params.output_config.effort, 'high');
    assert.equal(build({ modelId: 'claude-opus-6', effort: 'xhigh' }).params.output_config.effort, 'low', 'a level the model lacks falls back to low');
  });
});

describe('models list for the catalog', () => {
  it('normalizes capabilities, max_tokens and the effort levels', () => {
    const opus = normalizeModel(LISTED[0]);
    assert.equal(opus.id, 'claude-opus-5-5');
    assert.equal(opus.vision, true);
    assert.equal(opus.maxOutput, 128_000);
    assert.equal(opus.thinking, true);
    assert.equal(opus.reasoning, true);
    assert.deepEqual([...opus.effortLevels].sort(), ['high', 'low', 'max', 'medium', 'xhigh']);
    assert.deepEqual(normalizeModel(LISTED.find((m) => m.id === 'claude-haiku-4-5')).effortLevels, []);
  });

  it('capabilities null: every field unknown', () => {
    assert.deepEqual(normalizeModel({ id: 'claude-x', max_tokens: null, capabilities: null }), {
      id: 'claude-x', vision: null, maxOutput: null, reasoning: null, effortLevels: null, thinking: null,
    });
  });

  it('listModels pages through the list and leaves out retired models', async () => {
    sdkCalls = [];
    modelsList = () => (async function* () { yield* ANTHROPIC_MODELS.data; })();
    const models = await listModels('sk-ant-test');
    assert.deepEqual(models.map((m) => m.id), LISTED.map((m) => m.id));
    assert.equal(sdkCalls[0].clientOpts.apiKey, 'sk-ant-test');
  });

  it('getModel: an alias, null on 404, other errors thrown', async () => {
    modelsRetrieve = async (id) => ({ ...LISTED[0], id });
    assert.equal((await getModel('sk-ant-test', 'claude-opus-latest')).maxOutput, 128_000);
    const { APIError } = realSdk;
    modelsRetrieve = async () => { throw APIError.generate(404, { type: 'error', error: { type: 'not_found_error', message: 'model: x' } }, undefined, new Headers()); };
    assert.equal(await getModel('sk-ant-test', 'claude-typo'), null);
    modelsRetrieve = async () => { throw APIError.generate(500, { type: 'error', error: { type: 'api_error', message: 'boom' } }, undefined, new Headers()); };
    await assert.rejects(getModel('sk-ant-test', 'claude-x'), /boom/);
  });
});

describe('buildRequest: what the catalog says about the model', () => {
  it('a model the catalog does not know: no effort, but the thinking floor', () => {
    const { params } = build({ modelId: 'claude-opus-9', maxTokens: 900 });
    assert.equal('output_config' in params, false);
    assert.equal(params.max_tokens, 4_096);
  });

  it('the cap never goes over the model maximum', () => {
    assert.equal(build({ modelId: 'claude-haiku-4-5', maxTokens: 100_000 }).params.max_tokens, 64_000);
    catalog.setOverride('anthropic', 'claude-opus-5-5', 'maxOutput', 10_000);
    assert.equal(build({ modelId: 'claude-opus-5-5', maxTokens: 20_000 }).params.max_tokens, 10_000);
  });

  it('a model set to not see images gets the request without them', () => {
    catalog.setOverride('anthropic', 'claude-haiku-5-5', 'vision', false);
    const built = build({ modelId: 'claude-haiku-5-5', messages: [user(['q', { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }])] });
    assert.deepEqual(built.params.messages[0].content, [{ type: 'text', text: 'q' }]);
    assert.equal(built.imagesDropped, 1);
  });
});

describe('buildRequest: effort (FR-006)', () => {
  const effortOf = (input) => build({ modelId: 'claude-sonnet-5-5', ...input }).params.output_config?.effort;

  it('defaults to low', () => assert.equal(effortOf({}), 'low'));
  it('takes the caller value first', () => assert.equal(effortOf({ effort: 'high', env: { ANTHROPIC_EFFORT: 'medium' } }), 'high'));
  it('then ANTHROPIC_EFFORT', () => assert.equal(effortOf({ env: { ANTHROPIC_EFFORT: 'medium' } }), 'medium'));
  it('ignores invalid values (E6)', () => {
    assert.equal(effortOf({ env: { ANTHROPIC_EFFORT: 'extreme' } }), 'low');
    assert.equal(effortOf({ effort: 'extreme', env: { ANTHROPIC_EFFORT: 'xhigh' } }), 'xhigh');
  });
  it('accepts every level, trimmed and in any case', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) assert.equal(effortOf({ effort: ` ${level.toUpperCase()} ` }), level);
  });
  it('is not sent to models that reject it (E5)', () => {
    const { params } = build({ modelId: 'claude-haiku-4-5', effort: 'high' });
    assert.equal('output_config' in params, false);
  });
});

describe('buildRequest: max_tokens (FR-007)', () => {
  const maxOf = (input) => build(input).params.max_tokens;

  it('defaults to 16000 when streaming and 8192 once', () => {
    assert.equal(maxOf({ modelId: 'claude-haiku-5-5', mode: 'stream' }), 16_000);
    assert.equal(maxOf({ modelId: 'claude-haiku-5-5', mode: 'once' }), 8_192);
    assert.equal(maxOf({ modelId: 'claude-haiku-4-5' }), 16_000, 'stream is the default mode');
  });
  it('raises a small cap to 4096 on models that think (E7)', () => {
    assert.equal(maxOf({ modelId: 'claude-sonnet-5-5', maxTokens: 900 }), 4_096);
  });
  it('keeps the caller cap on models without effort', () => {
    assert.equal(maxOf({ modelId: 'claude-haiku-4-5', maxTokens: 900 }), 900);
  });
  it('keeps a cap above the floor', () => {
    assert.equal(maxOf({ modelId: 'claude-opus-5-5', maxTokens: 20_000 }), 20_000);
  });
  it('ANTHROPIC_MIN_MAX_TOKENS moves the floor; invalid values are ignored', () => {
    assert.equal(maxOf({ modelId: 'claude-opus-5-5', maxTokens: 900, env: { ANTHROPIC_MIN_MAX_TOKENS: '8000' } }), 8_000);
    assert.equal(maxOf({ modelId: 'claude-opus-5-5', maxTokens: 900, env: { ANTHROPIC_MIN_MAX_TOKENS: 'abc' } }), 4_096);
    assert.equal(maxOf({ modelId: 'claude-opus-5-5', maxTokens: 900, env: { ANTHROPIC_MIN_MAX_TOKENS: '-1' } }), 4_096);
  });
  it('ignores a caller value that is not a positive number', () => {
    assert.equal(maxOf({ modelId: 'claude-haiku-4-5', maxTokens: 0 }), 16_000);
    assert.equal(maxOf({ modelId: 'claude-haiku-4-5', maxTokens: 'lots' }), 16_000);
  });
});

describe('buildRequest: messages (FR-008)', () => {
  it('always streams and names the model', () => {
    for (const mode of ['stream', 'once']) {
      const { params } = build({ modelId: 'claude-haiku-5-5', mode });
      assert.equal(params.stream, true);
      assert.equal(params.model, 'claude-haiku-5-5');
    }
  });

  it('joins system messages with a blank line, text parts included', () => {
    const { params } = build({
      modelId: 'claude-haiku-5-5',
      messages: [
        { role: 'system', content: 'You are Glass.' },
        { role: 'system', content: [{ type: 'text', text: 'Be brief.' }, 'Reply in English.'] },
        user('hi'),
      ],
    });
    assert.equal(params.system, 'You are Glass.\n\nBe brief.\nReply in English.');
    assert.deepEqual(params.messages, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
  });

  it('omits system when there is none', () => {
    assert.equal('system' in build({ modelId: 'claude-haiku-5-5' }).params, false);
  });

  it('merges consecutive messages with the same role (E8)', () => {
    const { params } = build({
      modelId: 'claude-haiku-5-5',
      messages: [user('one'), user([{ type: 'text', text: 'two' }]), { role: 'assistant', content: 'three' }, user('four')],
    });
    assert.deepEqual(params.messages, [
      { role: 'user', content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'three' }] },
      { role: 'user', content: [{ type: 'text', text: 'four' }] },
    ]);
  });

  it('maps image data URLs, defaulting the MIME type to image/jpeg (E10)', () => {
    const { params } = build({
      modelId: 'claude-haiku-5-5',
      messages: [user([
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        { type: 'image_url', image_url: { url: 'data:;base64,BBBB' } },
      ])],
    });
    assert.deepEqual(params.messages[0].content, [
      { type: 'text', text: 'what is this?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' } },
    ]);
  });

  it('maps generateContent parts as user content, never as system (E9)', () => {
    const { params } = build({
      modelId: 'claude-haiku-5-5',
      messages: [user(['You are a helpful assistant.', 'question', { inlineData: { mimeType: 'image/png', data: 'CCCC' } }])],
    });
    assert.equal('system' in params, false);
    assert.deepEqual(params.messages[0].content, [
      { type: 'text', text: 'You are a helpful assistant.' },
      { type: 'text', text: 'question' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'CCCC' } },
    ]);
  });

  it('drops empty text, which the API rejects', () => {
    const { params } = build({ modelId: 'claude-haiku-5-5', messages: [user(['', { type: 'text', text: '' }, 'kept'])] });
    assert.deepEqual(params.messages[0].content, [{ type: 'text', text: 'kept' }]);
  });
});

describe('buildRequest: server-side fallback (FR-009)', () => {
  for (const modelId of [...PRESETS, 'claude-haiku-4-5', 'claude-opus-9']) {
    it(`${modelId} goes through the beta method with fallbacks until the API refuses it (E11)`, () => {
      const { method, params } = build({ modelId });
      assert.equal(method, 'beta');
      assert.deepEqual(params.betas, ['server-side-fallback-2026-07-01']);
      assert.equal(params.fallbacks, 'default');
    });
  }

  it('a model the API refused the beta for gets no fallbacks (E12)', () => {
    catalog.markServerFallback('anthropic', 'claude-haiku-5-5', false);
    const { method, params } = build({ modelId: 'claude-haiku-5-5' });
    assert.equal(method, 'messages');
    assert.equal('betas' in params, false);
    assert.equal('fallbacks' in params, false);
    assert.equal(build({ modelId: 'claude-opus-5-5' }).method, 'beta', 'per model');
  });

  it('ANTHROPIC_SERVER_FALLBACK=off turns it off', () => {
    const { method, params } = build({ modelId: 'claude-opus-5-5', env: { ANTHROPIC_SERVER_FALLBACK: 'off' } });
    assert.equal(method, 'messages');
    assert.equal('fallbacks' in params, false);
  });

  it('serverFallback: false turns it off (beta rejected earlier in the process)', () => {
    const { method, params } = build({ modelId: 'claude-sonnet-5-5', serverFallback: false });
    assert.equal(method, 'messages');
    assert.equal('fallbacks' in params, false);
  });
});

describe('timeout settings (FR-013, FR-014)', () => {
  it('first text: 20 s for the Haiku family, 45 s otherwise', () => {
    assert.equal(firstTextTimeoutMs('claude-haiku-5-5', {}), 20_000);
    assert.equal(firstTextTimeoutMs('claude-haiku-4-5', {}), 20_000);
    assert.equal(firstTextTimeoutMs('claude-sonnet-5-5', {}), 45_000);
    assert.equal(firstTextTimeoutMs('claude-opus-5-5', {}), 45_000);
  });

  it('first text: ANTHROPIC_FIRST_TEXT_TIMEOUT_MS overrides; 0 and invalid are ignored', () => {
    assert.equal(firstTextTimeoutMs('claude-opus-5-5', { ANTHROPIC_FIRST_TEXT_TIMEOUT_MS: '5000' }), 5_000);
    assert.equal(firstTextTimeoutMs('claude-opus-5-5', { ANTHROPIC_FIRST_TEXT_TIMEOUT_MS: '0' }), 45_000);
    assert.equal(firstTextTimeoutMs('claude-opus-5-5', { ANTHROPIC_FIRST_TEXT_TIMEOUT_MS: 'abc' }), 45_000);
  });

  it('request deadline: 60 s; ANTHROPIC_REQUEST_DEADLINE_MS overrides; 0 disables', () => {
    assert.equal(requestDeadlineMs({}), 60_000);
    assert.equal(requestDeadlineMs({ ANTHROPIC_REQUEST_DEADLINE_MS: '30000' }), 30_000);
    assert.equal(requestDeadlineMs({ ANTHROPIC_REQUEST_DEADLINE_MS: '0' }), null);
    assert.equal(requestDeadlineMs({ ANTHROPIC_REQUEST_DEADLINE_MS: 'abc' }), 60_000);
    assert.equal(requestDeadlineMs({ ANTHROPIC_REQUEST_DEADLINE_MS: ' ' }), 60_000);
  });

  it('idle: 30 s; ANTHROPIC_IDLE_TIMEOUT_MS overrides; 0 disables', () => {
    assert.equal(idleTimeoutMs({}), 30_000);
    assert.equal(idleTimeoutMs({ ANTHROPIC_IDLE_TIMEOUT_MS: '10000' }), 10_000);
    assert.equal(idleTimeoutMs({ ANTHROPIC_IDLE_TIMEOUT_MS: '0' }), null);
    assert.equal(idleTimeoutMs({ ANTHROPIC_IDLE_TIMEOUT_MS: '-5' }), 30_000);
  });
});

describe('AnthropicProvider.validateApiKey (FR-004)', () => {
  const { APIError, APIConnectionError } = realSdk;
  const httpError = (status, type, message) =>
    APIError.generate(status, { type: 'error', error: { type, message } }, undefined, new Headers());

  beforeEach(() => {
    sdkCalls = [];
    modelsList = async () => ({ data: [{ id: 'claude-opus-5-5' }] });
  });

  it('lists one model with the key and never calls Messages (E1)', async () => {
    const result = await AnthropicProvider.validateApiKey('sk-ant-good');
    assert.deepEqual(result, { success: true });
    assert.equal(sdkCalls.length, 1);
    const [call] = sdkCalls;
    assert.equal(call.kind, 'models.list');
    assert.equal(call.clientOpts.apiKey, 'sk-ant-good');
    assert.deepEqual(call.params, { limit: 1 });
    assert.equal(call.options.maxRetries, 0);
    assert.equal(call.options.timeout, 15_000);
  });

  it('401 → "Invalid Anthropic API key." (E2)', async () => {
    modelsList = async () => { throw httpError(401, 'authentication_error', 'invalid x-api-key'); };
    assert.deepEqual(await AnthropicProvider.validateApiKey('sk-ant-bad'), { success: false, error: 'Invalid Anthropic API key.' });
  });

  it('another API error → the server message', async () => {
    modelsList = async () => { throw httpError(403, 'permission_error', 'This key cannot list models'); };
    assert.deepEqual(await AnthropicProvider.validateApiKey('sk-ant-x'), { success: false, error: 'This key cannot list models' });
  });

  it('no network → the network message (E3)', async () => {
    modelsList = async () => { throw new APIConnectionError({ message: 'Connection error.' }); };
    assert.deepEqual(await AnthropicProvider.validateApiKey('sk-ant-x'), { success: false, error: 'A network error occurred during validation.' });
  });

  it('a key without the sk-ant- prefix fails without any call', async () => {
    for (const key of ['', null, 'AIza-gemini-key', 42]) {
      assert.deepEqual(await AnthropicProvider.validateApiKey(key), { success: false, error: 'Invalid Anthropic API key format.' });
    }
    assert.equal(sdkCalls.length, 0);
  });
});

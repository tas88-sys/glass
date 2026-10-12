/**
 * groqRequest.test.js
 *
 * The pure half of the Groq provider: model traits (from the catalog, seeded
 * with a recorded GET /openai/v1/models response), request building
 * (data-model "Request params"), image routing ("Attempt order"), the timeout
 * settings, and key validation and the models list against a mocked SDK.
 * Every env read is injected; process.env is never touched.
 * Run: node --test src/features/common/ai/providers/__tests__/groqRequest.test.js
 */

'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

// The real SDK, loaded before the interceptor, so the fake raises its real
// error classes and instanceof checks match production.
const realSdk = require('groq-sdk');

let modelsList = null; // (options) => Promise, set per test
let modelsRetrieve = null; // (id, options) => Promise, set per test
let sdkCalls = [];
class FakeGroq {
  constructor(opts) {
    this.models = {
      list: (options) => {
        sdkCalls.push({ kind: 'models.list', clientOpts: opts, options });
        return modelsList(options);
      },
      retrieve: (id, options) => {
        sdkCalls.push({ kind: 'models.retrieve', id, options });
        return modelsRetrieve(id, options);
      },
    };
    this.chat = { completions: { create: () => { sdkCalls.push({ kind: 'chat' }); throw new Error('unexpected chat call'); } } };
  }
}
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'groq-sdk') return { ...realSdk, Groq: FakeGroq, default: FakeGroq };
  return originalLoad.apply(this, arguments);
};
for (const k of Object.keys(require.cache)) if (/[\\/]groq\.js$/.test(k)) delete require.cache[k];

const catalog = require('../../modelCatalog');
const GROQ_MODELS = require('../../__tests__/fixtures/groq-models.json');
const {
  GroqProvider,
  listModels,
  getModel,
  normalizeModel,
  modelTraits,
  buildRequest,
  orderForImages,
  firstTextTimeoutMs,
  requestDeadlineMs,
  idleTimeoutMs,
} = require('../groq');

const PRESETS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'];
const IMAGE = { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } };
const user = (content) => ({ role: 'user', content });
const build = (input) => buildRequest({ messages: [user('hi')], env: {}, ...input });

// What Groq's models API reported (recorded 2026-10-12), as the catalog keeps it.
beforeEach(() => {
  catalog.resetCatalog();
  catalog.seed('groq', GROQ_MODELS.data.map(normalizeModel));
});

describe('modelTraits (catalog)', () => {
  it('gpt-oss: text only, 65,536 out, the gpt-oss dialect (from the API)', () => {
    for (const id of ['openai/gpt-oss-120b', 'openai/gpt-oss-20b']) {
      assert.deepEqual(modelTraits(id), { reasoning: 'gpt-oss', vision: false, maxOutput: 65_536 }, id);
    }
  });

  it('qwen/qwen3.8-27b sees images and caps output at 16,384 (from the API)', () => {
    assert.deepEqual(modelTraits('qwen/qwen3.8-27b'), { reasoning: 'qwen3', vision: true, maxOutput: 16_384 });
  });

  it('a new model the API says sees images gets them, with no code change', () => {
    catalog.seed('groq', [{ id: 'qwen/qwen3.9-27b', vision: true, maxOutput: 32_768, reasoning: true }]);
    assert.deepEqual(modelTraits('qwen/qwen3.9-27b'), { reasoning: 'qwen3', vision: true, maxOutput: 32_768 });
    assert.equal(build({ modelId: 'qwen/qwen3.9-27b', messages: [user(['q', IMAGE])] }).imagesSent, 1);
  });

  it('a model the catalog does not know: no image, no cap, its family dialect', () => {
    assert.deepEqual(modelTraits('qwen/qwen3.9-32b'), { reasoning: 'qwen3', vision: false, maxOutput: null });
    for (const id of ['acme/foo-1', 'allam-2-7b', '', null, undefined]) {
      assert.deepEqual(modelTraits(id), { reasoning: null, vision: false, maxOutput: null }, String(id));
    }
  });

  it('reasoning false in the catalog sends no reasoning field', () => {
    catalog.setOverride('groq', 'openai/gpt-oss-20b', 'reasoning', false);
    assert.equal(modelTraits('openai/gpt-oss-20b').reasoning, null);
    assert.equal(build({ modelId: 'openai/gpt-oss-20b' }).params.reasoning_effort, undefined);
  });

  it('an override in Settings wins over the API', () => {
    catalog.setOverride('groq', 'qwen/qwen3.8-27b', 'vision', false);
    catalog.setOverride('groq', 'openai/gpt-oss-120b', 'maxOutput', 4_000);
    assert.equal(modelTraits('qwen/qwen3.8-27b').vision, false);
    assert.equal(build({ modelId: 'openai/gpt-oss-120b' }).params.max_completion_tokens, 4_000);
  });
});

describe('models list for the catalog', () => {
  it('normalizes the recorded response: vision, max output and reasoning', () => {
    const byId = Object.fromEntries(GROQ_MODELS.data.map(normalizeModel).map((m) => [m.id, m]));
    assert.deepEqual(byId['qwen/qwen3.8-27b'], { id: 'qwen/qwen3.8-27b', vision: true, maxOutput: 16_384, reasoning: true, effortLevels: null, thinking: null });
    assert.deepEqual(byId['openai/gpt-oss-120b'], { id: 'openai/gpt-oss-120b', vision: false, maxOutput: 65_536, reasoning: true, effortLevels: null, thinking: null });
    assert.equal(byId['whisper-large-v3'].reasoning, null, 'no supported_features: unknown, not false');
  });

  it('a field Groq does not send is unknown', () => {
    assert.deepEqual(normalizeModel({ id: 'x/y' }), { id: 'x/y', vision: null, maxOutput: null, reasoning: null, effortLevels: null, thinking: null });
  });

  it('listModels reads the list and leaves out inactive models', async () => {
    sdkCalls = [];
    modelsList = async () => ({ object: 'list', data: [...GROQ_MODELS.data, { id: 'old/model', active: false }] });
    const models = await listModels('gsk_test');
    assert.deepEqual(models.map((m) => m.id).sort(), GROQ_MODELS.data.map((m) => m.id).sort());
    assert.equal(sdkCalls[0].kind, 'models.list');
    assert.equal(sdkCalls[0].clientOpts.apiKey, 'gsk_test');
  });

  it('getModel: one model, null on 404, other errors thrown', async () => {
    modelsRetrieve = async (id) => GROQ_MODELS.data.find((m) => m.id === id);
    assert.equal((await getModel('gsk_test', 'qwen/qwen3.8-27b')).vision, true);
    modelsRetrieve = async () => { throw new realSdk.NotFoundError(404, { error: { message: 'not found' } }, 'not found', new Headers()); };
    assert.equal(await getModel('gsk_test', 'typo/model'), null);
    modelsRetrieve = async () => { throw new realSdk.InternalServerError(500, { error: { message: 'boom' } }, 'boom', new Headers()); };
    await assert.rejects(getModel('gsk_test', 'x/y'), /boom/);
  });
});

describe('buildRequest: fields (FR-006, SC-005)', () => {
  const BANNED = ['max_tokens', 'top_p', 'logprobs', 'logit_bias', 'top_logprobs', 'n', 'stream_options', 'service_tier', 'tools', 'response_format'];
  for (const modelId of [...PRESETS, 'acme/foo-1']) {
    it(modelId, () => {
      for (const mode of ['stream', 'once']) {
        const { params } = build({
          modelId, mode, maxTokens: 900, temperature: 0.7,
          messages: [{ role: 'system', content: 's', name: 'x' }, { role: 'user', content: 'q', name: 'y' }],
        });
        assert.equal(params.model, modelId);
        assert.equal(params.stream, true, `${mode}: stream`);
        assert.ok(params.max_completion_tokens > 0, `${mode}: budget`);
        for (const key of BANNED) assert.equal(key in params, false, `${mode}: ${key}`);
        assert.equal(params.messages.some((m) => 'name' in m), false, `${mode}: name`);
        assert.equal('include_reasoning' in params && 'reasoning_format' in params, false, `${mode}: both reasoning forms`);
      }
    });
  }
});

describe('buildRequest: temperature (FR-007)', () => {
  it('passes a number in [0, 2]', () => {
    assert.equal(build({ modelId: 'openai/gpt-oss-120b', temperature: 0.7 }).params.temperature, 0.7);
    assert.equal(build({ modelId: 'openai/gpt-oss-120b', temperature: 0 }).params.temperature, 0);
    assert.equal(build({ modelId: 'openai/gpt-oss-120b', temperature: 2 }).params.temperature, 2);
  });

  it('omits anything else (E6)', () => {
    for (const temperature of [3, -0.1, NaN, Infinity, '0.7', null, undefined]) {
      assert.equal('temperature' in build({ modelId: 'openai/gpt-oss-120b', temperature }).params, false, String(temperature));
    }
  });
});

describe('buildRequest: reasoning (FR-008)', () => {
  it('gpt-oss: low and no reasoning text by default (E7)', () => {
    const { params, effort } = build({ modelId: 'openai/gpt-oss-120b' });
    assert.equal(params.reasoning_effort, 'low');
    assert.equal(params.include_reasoning, false);
    assert.equal('reasoning_format' in params, false);
    assert.equal(effort, 'low');
  });

  it('qwen3: none by default, no other reasoning field (E8)', () => {
    const { params, effort } = build({ modelId: 'qwen/qwen3.8-27b' });
    assert.equal(params.reasoning_effort, 'none');
    assert.equal('reasoning_format' in params, false);
    assert.equal('include_reasoning' in params, false);
    assert.equal(effort, 'none');
  });

  it('qwen3 with an effort hides the reasoning (E9)', () => {
    const { params } = build({ modelId: 'qwen/qwen3.8-27b', env: { GROQ_REASONING_EFFORT: 'medium' } });
    assert.equal(params.reasoning_effort, 'medium');
    assert.equal(params.reasoning_format, 'hidden');
    assert.equal('include_reasoning' in params, false);
  });

  it('precedence: opts, then GROQ_REASONING_EFFORT, then the family default', () => {
    assert.equal(build({ modelId: 'openai/gpt-oss-20b', effort: 'high', env: { GROQ_REASONING_EFFORT: 'medium' } }).params.reasoning_effort, 'high');
    assert.equal(build({ modelId: 'openai/gpt-oss-20b', env: { GROQ_REASONING_EFFORT: ' Medium ' } }).params.reasoning_effort, 'medium');
    assert.equal(build({ modelId: 'qwen/qwen3.8-27b', effort: 'default' }).params.reasoning_effort, 'default');
  });

  it('a value the family does not accept is ignored (E10)', () => {
    assert.equal(build({ modelId: 'openai/gpt-oss-20b', env: { GROQ_REASONING_EFFORT: 'none' } }).params.reasoning_effort, 'low');
    assert.equal(build({ modelId: 'openai/gpt-oss-20b', effort: 'max' }).params.reasoning_effort, 'low');
    assert.equal(build({ modelId: 'qwen/qwen3.8-27b', effort: 'xhigh' }).params.reasoning_effort, 'none');
    assert.equal(build({ modelId: 'openai/gpt-oss-20b', effort: 'bogus', env: { GROQ_REASONING_EFFORT: 'high' } }).params.reasoning_effort, 'high');
  });

  it('unknown models get no reasoning field (E11)', () => {
    const { params, effort } = build({ modelId: 'acme/foo-1', effort: 'low', env: { GROQ_REASONING_EFFORT: 'high' } });
    for (const key of ['reasoning_effort', 'include_reasoning', 'reasoning_format']) assert.equal(key in params, false, key);
    assert.equal(effort, null);
  });
});

describe('buildRequest: max_completion_tokens (FR-009)', () => {
  it('caller cap plus the reasoning allowance on gpt-oss (E12)', () => {
    assert.equal(build({ modelId: 'openai/gpt-oss-120b', maxTokens: 900 }).params.max_completion_tokens, 1924);
  });

  it('no allowance on qwen3 at none, one at another effort (E13)', () => {
    assert.equal(build({ modelId: 'qwen/qwen3.8-27b', maxTokens: 900 }).params.max_completion_tokens, 900);
    assert.equal(build({ modelId: 'qwen/qwen3.8-27b', maxTokens: 900, effort: 'low' }).params.max_completion_tokens, 1924);
  });

  it('capped at the model maximum (E14)', () => {
    assert.equal(build({ modelId: 'qwen/qwen3.8-27b', maxTokens: 20_000, effort: 'medium' }).params.max_completion_tokens, 16_384);
    assert.equal(build({ modelId: 'openai/gpt-oss-20b', maxTokens: 70_000 }).params.max_completion_tokens, 65_536);
  });

  it('default 16,384, plus the allowance when reasoning (E15)', () => {
    assert.equal(build({ modelId: 'qwen/qwen3.8-27b' }).params.max_completion_tokens, 16_384);
    assert.equal(build({ modelId: 'openai/gpt-oss-120b' }).params.max_completion_tokens, 17_408);
    assert.equal(build({ modelId: 'acme/foo-1' }).params.max_completion_tokens, 16_384);
  });

  it('GROQ_MAX_TOKENS and GROQ_REASONING_TOKENS override; invalid values ignored', () => {
    assert.equal(build({ modelId: 'openai/gpt-oss-120b', env: { GROQ_MAX_TOKENS: '4000', GROQ_REASONING_TOKENS: '0' } }).params.max_completion_tokens, 4000);
    assert.equal(build({ modelId: 'openai/gpt-oss-120b', maxTokens: 900, env: { GROQ_MAX_TOKENS: '4000' } }).params.max_completion_tokens, 1924, 'the caller cap wins');
    assert.equal(build({ modelId: 'openai/gpt-oss-120b', env: { GROQ_MAX_TOKENS: 'lots', GROQ_REASONING_TOKENS: '-5' } }).params.max_completion_tokens, 17_408);
  });

  it('unknown models are not capped', () => {
    assert.equal(build({ modelId: 'acme/foo-1', maxTokens: 200_000 }).params.max_completion_tokens, 200_000);
  });

  it('the mode does not change the budget', () => {
    assert.equal(build({ modelId: 'openai/gpt-oss-120b', mode: 'once' }).params.max_completion_tokens, 17_408);
  });
});

describe('buildRequest: messages (FR-010)', () => {
  it('keeps roles and order; a text-only array becomes one string', () => {
    const { params } = build({
      modelId: 'openai/gpt-oss-120b',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: [{ type: 'text', text: 'a' }, 'b'] },
        { role: 'assistant', content: 'c' },
        { role: 'user', content: 'd' },
        { role: 'user', content: 'e' },
      ],
    });
    assert.deepEqual(params.messages, [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'a\nb' },
      { role: 'assistant', content: 'c' },
      { role: 'user', content: 'd' },
      { role: 'user', content: 'e' },
    ]);
  });

  it('drops empty text and messages left empty', () => {
    const { params } = build({
      modelId: 'openai/gpt-oss-120b',
      messages: [null, user(''), user([{ type: 'text', text: '' }, '']), { role: 'system', content: 'sys' }, user('q')],
    });
    assert.deepEqual(params.messages, [{ role: 'system', content: 'sys' }, { role: 'user', content: 'q' }]);
  });

  it('keeps images on the vision model, as parts', () => {
    const { params, imagesSent, imagesDropped } = build({ modelId: 'qwen/qwen3.8-27b', messages: [user([{ type: 'text', text: 'what is this?' }, IMAGE])] });
    assert.deepEqual(params.messages, [{ role: 'user', content: [{ type: 'text', text: 'what is this?' }, IMAGE] }]);
    assert.equal(imagesSent, 1);
    assert.equal(imagesDropped, 0);
  });

  it('drops images on a text-only model and counts them (E16)', () => {
    const { params, imagesSent, imagesDropped } = build({ modelId: 'openai/gpt-oss-120b', messages: [user([{ type: 'text', text: 'what is this?' }, IMAGE])] });
    assert.deepEqual(params.messages, [{ role: 'user', content: 'what is this?' }]);
    assert.equal(imagesSent, 0);
    assert.equal(imagesDropped, 1);
  });

  it('sends at most three images (E18)', () => {
    const { params, imagesSent, imagesDropped } = build({ modelId: 'qwen/qwen3.8-27b', messages: [user(['look', IMAGE, IMAGE, IMAGE, IMAGE, IMAGE])] });
    assert.equal(params.messages[0].content.filter((p) => p.type === 'image_url').length, 3);
    assert.equal(imagesSent, 3);
    assert.equal(imagesDropped, 2);
  });

  it('maps generateContent parts: strings and inlineData, no system promotion (E19)', () => {
    const { params } = build({
      modelId: 'qwen/qwen3.8-27b',
      messages: [user(['You are a helpful assistant.', { inlineData: { mimeType: 'image/png', data: 'BBBB' } }, { inlineData: { data: 'CCCC' } }])],
    });
    assert.deepEqual(params.messages, [{
      role: 'user',
      content: [
        { type: 'text', text: 'You are a helpful assistant.' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,BBBB' } },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,CCCC' } },
      ],
    }]);
  });

  it('a message whose only content is an image is dropped on a text-only model (E20)', () => {
    const { params } = build({ modelId: 'openai/gpt-oss-20b', messages: [user([IMAGE]), user('q')] });
    assert.deepEqual(params.messages, [{ role: 'user', content: 'q' }]);
  });

  it('an unknown role is sent as user', () => {
    assert.deepEqual(build({ modelId: 'acme/foo-1', messages: [{ role: 'tool', content: 'x' }] }).params.messages, [{ role: 'user', content: 'x' }]);
  });
});

describe('orderForImages (FR-011)', () => {
  const list = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'];

  it('keeps the list order without images', () => {
    assert.deepEqual(orderForImages(list, [user('q')]), list);
  });

  it('puts the vision models first with an image, otherwise stable (E17)', () => {
    assert.deepEqual(orderForImages(list, [user(['q', IMAGE])]), ['qwen/qwen3.8-27b', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b']);
  });

  it('counts generateContent inlineData as an image', () => {
    assert.deepEqual(orderForImages(list, [user(['q', { inlineData: { mimeType: 'image/png', data: 'B' } }])])[0], 'qwen/qwen3.8-27b');
  });

  it('returns a copy', () => {
    const out = orderForImages(list, [user('q')]);
    assert.notEqual(out, list);
  });
});

describe('timeouts (FR-015, FR-016)', () => {
  it('first text: 15 s, env override, invalid ignored', () => {
    assert.equal(firstTextTimeoutMs({}), 15_000);
    assert.equal(firstTextTimeoutMs({ GROQ_FIRST_TEXT_TIMEOUT_MS: '5000' }), 5_000);
    assert.equal(firstTextTimeoutMs({ GROQ_FIRST_TEXT_TIMEOUT_MS: '0' }), 15_000);
    assert.equal(firstTextTimeoutMs({ GROQ_FIRST_TEXT_TIMEOUT_MS: 'soon' }), 15_000);
  });

  it('deadline: 45 s, env override, 0 disables', () => {
    assert.equal(requestDeadlineMs({}), 45_000);
    assert.equal(requestDeadlineMs({ GROQ_REQUEST_DEADLINE_MS: '30000' }), 30_000);
    assert.equal(requestDeadlineMs({ GROQ_REQUEST_DEADLINE_MS: '0' }), null);
    assert.equal(requestDeadlineMs({ GROQ_REQUEST_DEADLINE_MS: '-1' }), 45_000);
  });

  it('idle: 15 s, env override, 0 disables', () => {
    assert.equal(idleTimeoutMs({}), 15_000);
    assert.equal(idleTimeoutMs({ GROQ_IDLE_TIMEOUT_MS: '8000' }), 8_000);
    assert.equal(idleTimeoutMs({ GROQ_IDLE_TIMEOUT_MS: '0' }), null);
    assert.equal(idleTimeoutMs({ GROQ_IDLE_TIMEOUT_MS: '' }), 15_000);
  });
});

describe('GroqProvider.validateApiKey (FR-004)', () => {
  const { APIError, APIConnectionError } = realSdk;
  const httpError = (status, type, message) =>
    APIError.generate(status, { error: { message, type, code: type } }, undefined, new Headers());

  beforeEach(() => {
    sdkCalls = [];
    modelsList = async () => ({ object: 'list', data: [{ id: 'openai/gpt-oss-120b' }] });
  });

  it('lists models with the key and never calls chat (E1)', async () => {
    const result = await GroqProvider.validateApiKey('gsk_good');
    assert.deepEqual(result, { success: true });
    assert.equal(sdkCalls.length, 1);
    const [call] = sdkCalls;
    assert.equal(call.kind, 'models.list');
    assert.equal(call.clientOpts.apiKey, 'gsk_good');
    assert.equal(call.clientOpts.maxRetries, 0);
    assert.equal(call.options.maxRetries, 0);
    assert.equal(call.options.timeout, 15_000);
  });

  it('401 → "Invalid Groq API key." (E2)', async () => {
    modelsList = async () => { throw httpError(401, 'invalid_api_key', 'Invalid API Key'); };
    assert.deepEqual(await GroqProvider.validateApiKey('gsk_bad'), { success: false, error: 'Invalid Groq API key.' });
  });

  it('another API error → the server message', async () => {
    modelsList = async () => { throw httpError(403, 'permission_denied', 'Organization is restricted'); };
    assert.deepEqual(await GroqProvider.validateApiKey('gsk_x'), { success: false, error: 'Organization is restricted' });
  });

  it('no network → the network message (E3)', async () => {
    modelsList = async () => { throw new APIConnectionError({ message: 'Connection error.' }); };
    assert.deepEqual(await GroqProvider.validateApiKey('gsk_x'), { success: false, error: 'A network error occurred during validation.' });
  });

  it('a key without the gsk_ prefix fails without any call (E4)', async () => {
    for (const key of ['', null, 'sk-ant-key', 'AIza-gemini-key', 42]) {
      assert.deepEqual(await GroqProvider.validateApiKey(key), { success: false, error: 'Invalid Groq API key format.' });
    }
    assert.equal(sdkCalls.length, 0);
  });
});

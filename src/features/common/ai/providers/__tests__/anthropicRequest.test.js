/**
 * anthropicRequest.test.js
 *
 * The pure half of the Anthropic provider: request building (data-model
 * "Request params"), the effort gate, the timeout settings, and key
 * validation against a mocked SDK.
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

const {
  AnthropicProvider,
  buildRequest,
  acceptsEffort,
  firstTextTimeoutMs,
  requestDeadlineMs,
  idleTimeoutMs,
} = require('../anthropic');

const PRESETS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
const user = (content) => ({ role: 'user', content });
const build = (input) => buildRequest({ messages: [user('hi')], env: {}, ...input });

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

describe('acceptsEffort', () => {
  const yes = [
    'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5', 'claude-sonnet-5',
    'claude-fable-5-1', 'claude-mythos-5-1', 'claude-opus-6',
    'claude-opus-4-5', 'claude-opus-4-5-20251101', 'claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8',
    'claude-sonnet-4-6',
  ];
  const no = [
    'claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-5', 'claude-sonnet-4', 'claude-sonnet-4-20250514',
    'claude-opus-4-1', 'claude-opus-4-50', 'claude-3-5-sonnet-20241022', 'gemini-3-flash-preview', '', undefined,
  ];
  for (const id of yes) it(`${id} → true`, () => assert.equal(acceptsEffort(id), true));
  for (const id of no) it(`${id} → false`, () => assert.equal(acceptsEffort(id), false));
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
  for (const modelId of ['claude-opus-5-5', 'claude-sonnet-5-5']) {
    it(`${modelId} goes through the beta method with fallbacks (E11)`, () => {
      const { method, params } = build({ modelId });
      assert.equal(method, 'beta');
      assert.deepEqual(params.betas, ['server-side-fallback-2026-07-01']);
      assert.equal(params.fallbacks, 'default');
    });
  }

  for (const modelId of ['claude-haiku-5-5', 'claude-haiku-4-5', 'claude-opus-4-8', 'claude-sonnet-5']) {
    it(`${modelId} gets no fallbacks (E12)`, () => {
      const { method, params } = build({ modelId });
      assert.equal(method, 'messages');
      assert.equal('betas' in params, false);
      assert.equal('fallbacks' in params, false);
    });
  }

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

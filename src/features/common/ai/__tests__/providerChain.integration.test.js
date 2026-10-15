/**
 * providerChain.integration.test.js
 *
 * The cross-provider chain (spec 2026-10-12-cross-provider-failover) over the
 * real groq.js, gemini.js and anthropic.js, with their SDKs mocked through
 * Module._load as in each provider's own test. The Groq and Anthropic fakes
 * re-export the real SDKs' error classes (loaded before the interceptor), so
 * status, headers and classification match production. The fakes' streams
 * honour the request's signal and end without throwing on abort, as the real
 * SDKs do. This checks the protocol end to end: the providers' own _resets,
 * the chain's 'provider' _reset, _final_model and [DONE], the cooldowns the
 * providers write and the chain reads, and cancellation down to the request.
 * Run: node --test src/features/common/ai/__tests__/providerChain.integration.test.js
 */

'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const realGroq = require('groq-sdk');
const realAnthropic = require('@anthropic-ai/sdk');
const realOpenAI = require('openai');

// ---------------------------------------------------------------------------
// Fake SDKs
// ---------------------------------------------------------------------------

/** Resolve after ms, or as soon as signal aborts. */
function abortable(ms, signal) {
  return new Promise((resolve) => {
    if (!signal) return setTimeout(resolve, ms);
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/** Replays plan.items; a { hang: true } plan waits for the signal. Ends quietly on abort. */
async function* replay(plan, signal) {
  for (const item of plan.items || []) {
    if (signal?.aborted) return;
    yield item;
  }
  if (signal?.aborted) return;
  if (plan.hang) await abortable(2 ** 31 - 1, signal);
}

/** A script by model ID: a plan, an Error to throw, or a list used in call order. */
function byModel(plans) {
  const seen = {};
  return async (call) => {
    if (!(call.model in plans)) throw new Error(`unscripted model ${call.model}`);
    const i = (seen[call.model] = (seen[call.model] ?? -1) + 1);
    const entry = plans[call.model];
    const plan = Array.isArray(entry) ? entry[Math.min(i, entry.length - 1)] : entry;
    if (plan instanceof Error) throw plan;
    return plan;
  };
}

const sdk = {
  groq: { script: null, calls: [] },
  gemini: { script: null, calls: [] },
  anthropic: { script: null, calls: [] },
  compat: { script: null, calls: [] },
};

/** groq-sdk / @anthropic-ai/sdk create(): a promise of the stream, with withResponse(). */
function fakeCreate(name, params, options) {
  const call = { model: params.model, params: structuredClone(params), signal: options?.signal, apiKey: options?.apiKey };
  sdk[name].calls.push(call);
  const opened = (async () => {
    const plan = await sdk[name].script(call);
    return replay(plan, call.signal);
  })();
  const promise = opened;
  promise.catch(() => {}); // the providers await withResponse() instead
  promise.withResponse = async () => ({ data: await opened, request_id: `req_${sdk[name].calls.length}`, response: new Response(null, { headers: { 'x-request-id': 'req_hdr' } }) });
  return promise;
}

class FakeGroq {
  constructor(opts) {
    this.apiKey = opts.apiKey;
    this.chat = { completions: { create: (params, options) => fakeCreate('groq', params, { ...options, apiKey: this.apiKey }) } };
  }
}

class FakeAnthropic {
  constructor(opts) {
    this.apiKey = opts.apiKey;
    this.messages = { create: (params, options) => fakeCreate('anthropic', params, { ...options, apiKey: this.apiKey }) };
    this.beta = { messages: { create: (params, options) => fakeCreate('anthropic', params, { ...options, apiKey: this.apiKey }) } };
  }
}

class FakeOpenAI {
  constructor(opts) {
    this.apiKey = opts.apiKey;
    this.baseURL = opts.baseURL;
    this.chat = { completions: { create: (params, options) => fakeCreate('compat', params, { ...options, apiKey: `${this.baseURL} ${this.apiKey}` }) } };
  }
}
Object.assign(FakeOpenAI, realOpenAI, { default: FakeOpenAI });

class FakeGemini {
  constructor(apiKey) { this.apiKey = apiKey; }
  getGenerativeModel({ model }) {
    const apiKey = this.apiKey;
    const record = (extra) => {
      const call = { model, apiKey, ...extra };
      sdk.gemini.calls.push(call);
      return call;
    };
    return {
      generateContentStream: async (request, options) => {
        const call = record({ request, signal: options?.signal });
        const plan = await sdk.gemini.script(call);
        const texts = plan.texts;
        return {
          stream: (async function* () {
            for (let i = 0; i < texts.length; i++) {
              if (call.signal?.aborted) return;
              yield { text: () => texts[i], candidates: [i === texts.length - 1 ? { finishReason: 'STOP' } : {}] };
            }
          })(),
        };
      },
      startChat: () => ({
        sendMessage: async (content) => {
          const call = record({ content });
          const plan = await sdk.gemini.script(call);
          const text = plan.texts.join('');
          return { response: { text: () => text, usageMetadata: null } };
        },
      }),
    };
  }
}

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'groq-sdk') return { ...realGroq, Groq: FakeGroq, default: FakeGroq };
  if (request === '@anthropic-ai/sdk') return { ...realAnthropic, Anthropic: FakeAnthropic, default: FakeAnthropic };
  if (request === '@google/generative-ai') return { GoogleGenerativeAI: FakeGemini };
  if (request === '@google/genai') return { GoogleGenAI: class {} };
  if (request === 'openai') return FakeOpenAI;
  return originalLoad.apply(this, arguments);
};
for (const k of Object.keys(require.cache)) {
  if (/[\\/](groq|gemini|anthropic|geminiModelRotator|openaiCompatible|providerChain|factory)\.js$/.test(k)) delete require.cache[k];
}

const health = require('../providers/modelHealth');
const catalog = require('../modelCatalog');
const GROQ_MODELS_RESPONSE = require('./fixtures/groq-models.json');
// Through the factory, as the three lanes call it.
const { splitByProvider, createStreamingLLM, createLLM } = require('../factory');
const { normalizeModel: groqModel } = require('../providers/groq');

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------

const groqChunk = {
  text: (model, content) => ({ id: 'c', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: { content }, finish_reason: null }] }),
  finish: (model) => ({ id: 'c', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], x_groq: { id: 'req_x', usage: { prompt_tokens: 10, completion_tokens: 5 } } }),
};
const groqAnswer = (model, ...texts) => ({ items: [...texts.map(t => groqChunk.text(model, t)), groqChunk.finish(model)] });

function groqHttpError(status, { message = 'server said no', type, code, headers = {} } = {}) {
  const error = { message, type: type || (status >= 500 ? 'internal_server_error' : 'invalid_request_error') };
  if (code) error.code = code;
  return realGroq.APIError.generate(status, { error }, undefined, new Headers({ 'x-request-id': `req_err_${status}`, ...headers }));
}

// The daily-limit 429 as Groq sends it (research R2): the hint is minutes.
const dailyLimit = (model) => groqHttpError(429, {
  message: `Rate limit reached for model \`${model}\` in organization \`org_x\` service tier \`on_demand\` on tokens per day (TPD): Limit 200000, Used 199336, Requested 1524. Please try again in 6m11.52s.`,
  type: 'tokens', code: 'rate_limit_exceeded', headers: { 'retry-after': '371' },
});

const claudeEvents = (model, ...texts) => ({
  items: [
    { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ...texts.map(text => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ],
});

const GROQ_MODELS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'];
const RECOMMENDED = 'openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b,gemini-3.5-flash-lite,gemini-3.1-flash-lite';
const KEYS = { groq: 'gsk_test', gemini: 'AIza_test', anthropic: 'sk-ant-test' };
const MSGS = [{ role: 'system', content: 'You are an assistant.' }, { role: 'user', content: 'What is a mutex?' }];

/** What the Live Answer lane passes (summaryService), with the keys. */
const laneOpts = (model, keys = KEYS) => ({ apiKey: keys.groq, model, temperature: 0.7, maxTokens: 900, usePortkey: false, portkeyVirtualKey: undefined, keys });

// ---------------------------------------------------------------------------
// Stream reading
// ---------------------------------------------------------------------------

function parseEvents(raw) {
  return raw.split('\n').filter(l => l.startsWith('data: ')).map((l) => {
    const d = l.slice(6);
    if (d === '[DONE]') return { done: true };
    const json = JSON.parse(d);
    if (json.choices) return { text: json.choices[0].delta.content };
    return json;
  });
}

async function readAll(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let error = null;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
    }
  } catch (err) {
    error = err;
  }
  const events = parseEvents(raw);
  return { events, error, text: events.filter(e => e.text).map(e => e.text).join('') };
}

const resets = (events) => events.filter(e => e._reset);
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Provider and chain log lines, captured (and kept out of the test output).
const logs = [];
for (const level of ['log', 'warn', 'error']) {
  console[level] = (...args) => { logs.push(args.map(String).join(' ')); };
}
const chainLine = (kind) => logs.find(l => l.startsWith(`[LLM Chain] ${kind}`));

beforeEach(() => {
  health.resetHealth();
  // What Groq's models API reported (recorded 2026-10-12): Qwen sees images.
  catalog.resetCatalog();
  catalog.seed('groq', GROQ_MODELS_RESPONSE.data.map(groqModel));
  logs.length = 0;
  for (const s of Object.values(sdk)) { s.calls = []; s.script = async (call) => { throw new Error(`unexpected ${call.model} call`); }; }
});

// ---------------------------------------------------------------------------
// Tests (T018)
// ---------------------------------------------------------------------------

describe('chain over the real providers (SC-003)', () => {
  it('the recommended list splits into Groq ×3 then Gemini ×2', () => {
    assert.deepEqual(splitByProvider(RECOMMENDED, 'groq'), [
      { provider: 'groq', models: GROQ_MODELS },
      { provider: 'gemini', models: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'] },
    ]);
  });

  it('Groq spent (daily 429 on every model) → Gemini answers; then Groq is skipped while it cools down', async () => {
    sdk.groq.script = byModel(Object.fromEntries(GROQ_MODELS.map(m => [m, dailyLimit(m)])));
    sdk.gemini.script = async () => ({ texts: ['A mutex ', 'is a lock.'] });

    const first = await readAll(await createStreamingLLM('groq', laneOpts(RECOMMENDED)).streamChat(MSGS));
    assert.equal(first.error, null);
    assert.equal(first.text, 'A mutex is a lock.');
    assert.deepEqual(resets(first.events), [
      { _reset: true, next_model: 'openai/gpt-oss-20b', reason: 'transient' },
      { _reset: true, next_model: 'qwen/qwen3.8-27b', reason: 'transient' },
      { _reset: true, next_model: 'gemini-3.5-flash-lite', reason: 'provider' },
    ]);
    assert.equal(first.events.find(e => e._final_model)._final_model, 'gemini-3.5-flash-lite');
    assert.ok(first.events.at(-1).done);
    assert.equal(first.events.filter(e => e.done).length, 1);
    assert.deepEqual(sdk.groq.calls.map(c => c.model), GROQ_MODELS, 'one pass, no second round: the hint is minutes');
    assert.ok(sdk.groq.calls.every(c => c.apiKey === 'gsk_test'));
    assert.deepEqual(sdk.gemini.calls.map(c => [c.model, c.apiKey]), [['gemini-3.5-flash-lite', 'AIza_test']]);
    for (const m of GROQ_MODELS) assert.equal(health.isCoolingDown(m), true, `${m} cooling`);

    sdk.groq.calls = [];
    sdk.gemini.calls = [];
    logs.length = 0;
    const second = await readAll(await createStreamingLLM('groq', laneOpts(RECOMMENDED)).streamChat(MSGS));
    assert.equal(second.text, 'A mutex is a lock.');
    assert.equal(sdk.groq.calls.length, 0, 'no Groq request while every model cools down');
    assert.deepEqual(resets(second.events), []);
    assert.match(chainLine('segment 1/2'), /provider=groq .*outcome=skipped-cooling$/);
    assert.match(chainLine('request'), /answered_by=gemini-3\.5-flash-lite provider=gemini segments_run=1 /);
  });

  it('Groq answers → the Gemini SDK is never called', async () => {
    sdk.groq.script = byModel({ 'openai/gpt-oss-120b': groqAnswer('openai/gpt-oss-120b', 'From ', 'Groq.') });
    const { text, events } = await readAll(await createStreamingLLM('groq', laneOpts(RECOMMENDED)).streamChat(MSGS));
    assert.equal(text, 'From Groq.');
    assert.equal(events.find(e => e._final_model)._final_model, 'openai/gpt-oss-120b');
    assert.equal(sdk.gemini.calls.length, 0);
    assert.match(chainLine('segment 1/2'), /outcome=ok answered_by=openai\/gpt-oss-120b /);
  });

  it('Groq 503 on every model: Groq keeps its 2 s wait and second round, then Gemini', async () => {
    sdk.groq.script = byModel(Object.fromEntries(GROQ_MODELS.map(m => [m, groqHttpError(503, { message: 'Service unavailable' })])));
    sdk.gemini.script = async () => ({ texts: ['ok'] });
    const started = Date.now();
    const { text, events } = await readAll(await createStreamingLLM('groq', laneOpts(RECOMMENDED)).streamChat(MSGS));
    const elapsed = Date.now() - started;
    assert.equal(text, 'ok');
    assert.equal(sdk.groq.calls.length, 6, 'two rounds of three');
    assert.deepEqual(resets(events).map(e => e.reason), ['transient', 'transient', 'retry', 'transient', 'transient', 'provider']);
    assert.ok(elapsed >= 1_900 && elapsed < 4_000, `Groq's own 2 s wait before its second round (${elapsed} ms)`);
    assert.ok(logs.some(l => l.includes('[Groq Provider] all models failed — retry round 2 in 2000ms')));
  });

  it('a brief Groq overload (429, retry-after 1 s, every model) resolves on Groq\'s second round; Gemini is not called', async () => {
    const perMinute = (m) => groqHttpError(429, { message: `Rate limit reached for model \`${m}\` on tokens per minute (TPM): Limit 8000, Used 7900, Requested 1200. Please try again in 1s.`, type: 'tokens', code: 'rate_limit_exceeded', headers: { 'retry-after': '1' } });
    sdk.groq.script = byModel(Object.fromEntries(GROQ_MODELS.map(m => [m, [perMinute(m), groqAnswer(m, 'From Groq after the wait.')]])));
    sdk.gemini.script = async () => ({ texts: ['no'] });
    const { text, events } = await readAll(await createStreamingLLM('groq', laneOpts(RECOMMENDED)).streamChat(MSGS));
    assert.equal(text, 'From Groq after the wait.');
    assert.equal(sdk.gemini.calls.length, 0);
    assert.deepEqual(resets(events).map(e => e.reason), ['transient', 'transient', 'retry']);
    assert.equal(events.find(e => e._final_model)._final_model, 'openai/gpt-oss-120b');
    assert.equal(sdk.groq.calls.length, 4, 'three 429s, then the first model answers in round 2');
  });

  it('Groq 401 (key revoked) moves on to Gemini (D4)', async () => {
    sdk.groq.script = byModel({ 'openai/gpt-oss-120b': groqHttpError(401, { message: 'Invalid API Key', type: 'invalid_request_error', code: 'invalid_api_key' }) });
    sdk.gemini.script = async () => ({ texts: ['ok'] });
    const { text, events } = await readAll(await createStreamingLLM('groq', laneOpts(RECOMMENDED)).streamChat(MSGS));
    assert.equal(text, 'ok');
    assert.equal(sdk.groq.calls.length, 1);
    assert.deepEqual(resets(events).map(e => e.reason), ['provider']);
  });

  it('Groq → Anthropic: Claude answers with its own key', async () => {
    sdk.groq.script = byModel({ 'openai/gpt-oss-120b': dailyLimit('openai/gpt-oss-120b') });
    sdk.anthropic.script = byModel({ 'claude-haiku-5-5': claudeEvents('claude-haiku-5-5', 'From ', 'Claude.') });
    const { text, events } = await readAll(await createStreamingLLM('groq', laneOpts('openai/gpt-oss-120b,claude-haiku-5-5')).streamChat(MSGS));
    assert.equal(text, 'From Claude.');
    assert.deepEqual(resets(events), [{ _reset: true, next_model: 'claude-haiku-5-5', reason: 'provider' }]);
    assert.equal(events.find(e => e._final_model)._final_model, 'claude-haiku-5-5');
    assert.equal(sdk.anthropic.calls[0].apiKey, 'sk-ant-test');
  });

  it('every provider fails: All providers failed (groq → gemini), naming Gemini\'s failure', async () => {
    sdk.groq.script = byModel({ 'openai/gpt-oss-120b': dailyLimit('openai/gpt-oss-120b') });
    sdk.gemini.script = async () => { throw Object.assign(new Error('[429 Too Many Requests] Quota exceeded for metric generate_content_free_tier_requests.'), { status: 429 }); };
    const { error } = await readAll(await createStreamingLLM('groq', laneOpts('openai/gpt-oss-120b,gemini-3.5-flash-lite')).streamChat(MSGS));
    assert.match(error.userMessage, /^All providers failed \(groq → gemini\)\. Last: All Gemini models failed \(1 attempt\)\. Last: gemini-3\.5-flash-lite — .*Quota exceeded/);
  });

  it('cancel during the Groq attempt aborts its SDK request; Gemini is never called (SC-004)', async () => {
    sdk.groq.script = byModel({ 'openai/gpt-oss-120b': { items: [groqChunk.text('openai/gpt-oss-120b', 'thinking ')], hang: true } });
    sdk.gemini.script = async () => ({ texts: ['no'] });
    const response = await createStreamingLLM('groq', laneOpts(RECOMMENDED)).streamChat(MSGS);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let raw = '';
    while (!raw.includes('thinking')) raw += decoder.decode((await reader.read()).value, { stream: true });
    assert.equal(sdk.groq.calls[0].signal.aborted, false);
    reader.cancel();
    assert.equal(sdk.groq.calls[0].signal.aborted, true, 'aborted within the same turn');
    await sleep(20);
    assert.equal(sdk.gemini.calls.length, 0);
    assert.match(chainLine('request'), / cancelled$/);
  });

  it('a screenshot without a Groq vision model goes to Gemini first, with the image', async () => {
    sdk.gemini.script = async () => ({ texts: ['I see a terminal.'] });
    const msgs = [{ role: 'user', content: [{ type: 'text', text: 'what is on screen?' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }] }];
    const { text } = await readAll(await createStreamingLLM('groq', laneOpts('openai/gpt-oss-120b,openai/gpt-oss-20b,gemini-3.5-flash-lite')).streamChat(msgs));
    assert.equal(text, 'I see a terminal.');
    assert.equal(sdk.groq.calls.length, 0);
    assert.deepEqual(sdk.gemini.calls[0].request.contents[0].parts.find(p => p.inlineData), { inlineData: { mimeType: 'image/png', data: 'AAAA' } });
    assert.match(chainLine('request'), / order=images-first$/);
  });

  it('an Ask screenshot on the recommended list: Qwen refused on output tokens (OTPM) → Gemini with the image; gpt-oss never answers blind', async () => {
    const otpm = groqHttpError(429, {
      message: "Request too large for model `qwen/qwen3.8-27b` in organization `org_x` service tier `on_demand` on output tokens per minute (OTPM): Limit 1000, Requested 1679. The request's expected output tokens exceed the enforced limit; reduce max_tokens (or the request's expected output) and try again.",
      type: 'tokens', code: 'rate_limit_exceeded',
    });
    sdk.groq.script = byModel({ 'qwen/qwen3.8-27b': otpm, 'openai/gpt-oss-120b': groqAnswer('openai/gpt-oss-120b', 'blind') });
    sdk.gemini.script = async () => ({ texts: ['I see the problem.'] });
    const msgs = [{ role: 'user', content: [{ type: 'text', text: 'User Request: solve it' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }] }];
    // What askService passes: no maxTokens.
    const askOpts = { apiKey: KEYS.groq, model: RECOMMENDED, keys: KEYS, temperature: 0.7, usePortkey: false, portkeyVirtualKey: undefined };
    const { text, events } = await readAll(await createStreamingLLM('groq', askOpts).streamChat(msgs));
    assert.equal(text, 'I see the problem.');
    assert.deepEqual(sdk.groq.calls.map(c => c.model), ['qwen/qwen3.8-27b']);
    assert.equal(sdk.groq.calls[0].params.max_completion_tokens, 16_384, 'Ask\'s budget: an answer is not cut to fit');
    assert.deepEqual(resets(events), [{ _reset: true, next_model: 'gemini-3.5-flash-lite', reason: 'provider' }]);
    assert.deepEqual(sdk.gemini.calls[0].request.contents[0].parts.find(p => p.inlineData), { inlineData: { mimeType: 'image/png', data: 'AAAA' } });
    assert.equal(health.isCoolingDown('qwen/qwen3.8-27b'), false, 'a request with a smaller cap may still use Qwen');
    assert.ok(logs.some(l => l.includes('model=qwen/qwen3.8-27b outcome=too-large') && l.includes('limit=1000 requested=1679')), logs.join('\n'));
  });

  it('chat() (Live Insights) through a Groq failure returns Gemini\'s result', async () => {
    sdk.groq.script = byModel(Object.fromEntries(GROQ_MODELS.map(m => [m, dailyLimit(m)])));
    sdk.gemini.script = async () => ({ texts: ['**Summary Overview**'] });
    const result = await createLLM('groq', { ...laneOpts(RECOMMENDED), maxTokens: 1024 }).chat(MSGS);
    assert.equal(result.content, '**Summary Overview**');
    assert.equal(result._modelUsed, 'gemini-3.5-flash-lite');
    assert.equal(sdk.groq.calls.length, 3);
    assert.match(chainLine('request once'), /answered_by=gemini-3\.5-flash-lite provider=gemini segments_run=2 /);
  });

  it('a Groq-only list takes today\'s path: no chain line, no Gemini call (G3, SC-005)', async () => {
    sdk.groq.script = byModel({ 'openai/gpt-oss-120b': groqAnswer('openai/gpt-oss-120b', 'Groq alone.') });
    const { text, events } = await readAll(await createStreamingLLM('groq', laneOpts(GROQ_MODELS.join(','))).streamChat(MSGS));
    assert.equal(text, 'Groq alone.');
    assert.equal(events.filter(e => e.done).length, 1);
    assert.equal(sdk.gemini.calls.length, 0);
    assert.equal(logs.some(l => l.startsWith('[LLM Chain]')), false);
    assert.ok(logs.some(l => l.startsWith('[Groq Provider] request stream answered_by=openai/gpt-oss-120b')));
  });

  it('logs carry no prompt, answer or key', async () => {
    sdk.groq.script = byModel(Object.fromEntries(GROQ_MODELS.map(m => [m, dailyLimit(m)])));
    sdk.gemini.script = async () => ({ texts: ['SECRET ANSWER'] });
    const keys = { groq: 'gsk_SECRET', gemini: 'AIza_SECRET' };
    await readAll(await createStreamingLLM('groq', laneOpts(RECOMMENDED, keys)).streamChat([{ role: 'user', content: 'SECRET PROMPT' }]));
    const chainLogs = logs.filter(l => l.startsWith('[LLM Chain]'));
    assert.equal(chainLogs.length, 3);
    for (const line of chainLogs) assert.doesNotMatch(line, /SECRET/);
  });
});

describe('chain into an OpenAI-compatible endpoint (spec 2026-10-14-openai-compatible-provider)', () => {
  const { formatCredential } = require('../providers/openaiCompatible');
  const COMPAT_KEY = formatCredential('http://localhost:20128/v1', 'sk-omni');
  // A gateway that serves Groq's gpt-oss ID from another upstream, then a free model.
  const LIST = 'openai/gpt-oss-120b,openai/gpt-oss-20b,openai/gpt-oss-120b,meta-llama/llama-3.3-70b-instruct:free';
  const keys = { ...KEYS, 'openai-compatible': COMPAT_KEY };

  beforeEach(() => {
    catalog.seed('openai-compatible', [{ id: 'openai/gpt-oss-120b' }, { id: 'meta-llama/llama-3.3-70b-instruct:free' }]);
  });

  it("a Groq-field list runs Groq first, and the endpoint's own IDs go to the endpoint", () => {
    assert.deepEqual(splitByProvider(LIST, 'groq'), [
      { provider: 'groq', models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'openai/gpt-oss-120b'] },
      { provider: 'openai-compatible', models: ['meta-llama/llama-3.3-70b-instruct:free'] },
    ]);
  });

  it("Groq spent → the endpoint answers with the same model ID, which Groq's cooldown does not block", async () => {
    const list = 'openai/gpt-oss-120b,openai/gpt-oss-20b,openai/gpt-oss-120b';
    // In the endpoint's field, an ID both list stays the endpoint's; one only Groq lists starts a Groq run.
    assert.deepEqual(splitByProvider(`meta-llama/llama-3.3-70b-instruct:free,${list}`, 'openai-compatible'), [
      { provider: 'openai-compatible', models: ['meta-llama/llama-3.3-70b-instruct:free', 'openai/gpt-oss-120b'] },
      { provider: 'groq', models: ['openai/gpt-oss-20b', 'openai/gpt-oss-120b'] },
    ]);
    sdk.groq.script = byModel(Object.fromEntries(GROQ_MODELS.map(m => [m, dailyLimit(m)])));
    sdk.compat.script = byModel({ 'meta-llama/llama-3.3-70b-instruct:free': groqAnswer('meta-llama/llama-3.3-70b-instruct', 'Via the gateway.') });

    const { text, error, events } = await readAll(await createStreamingLLM('groq', laneOpts(LIST, keys)).streamChat(MSGS));
    assert.equal(error, null);
    assert.equal(text, 'Via the gateway.');
    assert.deepEqual(resets(events).at(-1), { _reset: true, next_model: 'meta-llama/llama-3.3-70b-instruct:free', reason: 'provider' });
    assert.equal(sdk.compat.calls.length, 1);
    assert.equal(sdk.compat.calls[0].apiKey, 'http://localhost:20128/v1 sk-omni', 'the endpoint gets its own URL and key');
    assert.equal(sdk.compat.calls[0].params.max_tokens, 900);
    assert.ok(sdk.groq.calls.every(c => c.apiKey === 'gsk_test'), 'Groq never sees the endpoint credential');
    assert.match(chainLine('request stream'), /provider=openai-compatible segments_run=2 /);
    assert.equal(health.isCoolingDown('openai/gpt-oss-120b'), true, "Groq's model cools down");
  });

  it("the endpoint's copy of a spent Groq ID still runs: cooldowns are per provider", async () => {
    sdk.groq.script = byModel(Object.fromEntries(GROQ_MODELS.map(m => [m, dailyLimit(m)])));
    sdk.compat.script = byModel({ 'openai/gpt-oss-120b': groqAnswer('openai/gpt-oss-120b', 'Same ID, other upstream.') });
    const list = 'openai/gpt-oss-120b,openai/gpt-oss-20b';
    // Groq is spent: its models cool down in the registry.
    await readAll(await createStreamingLLM('groq', laneOpts(list, keys)).streamChat(MSGS)).catch(() => {});
    assert.equal(health.isCoolingDown('openai/gpt-oss-120b'), true);

    const { text, error } = await readAll(await createStreamingLLM('openai-compatible', { ...laneOpts('openai/gpt-oss-120b', keys), apiKey: COMPAT_KEY }).streamChat(MSGS));
    assert.equal(error, null);
    assert.equal(text, 'Same ID, other upstream.');
  });

  it('logs carry no prompt, answer or credential', async () => {
    sdk.groq.script = byModel(Object.fromEntries(GROQ_MODELS.map(m => [m, dailyLimit(m)])));
    sdk.compat.script = byModel({ 'meta-llama/llama-3.3-70b-instruct:free': groqAnswer('m', 'SECRET ANSWER') });
    const secretKeys = { groq: 'gsk_SECRET', 'openai-compatible': formatCredential('http://localhost:20128/v1', 'sk-SECRET') };
    await readAll(await createStreamingLLM('groq', laneOpts(LIST, secretKeys)).streamChat([{ role: 'user', content: 'SECRET PROMPT' }]));
    assert.ok(logs.some(l => l.startsWith('[OpenAI-compatible Provider] request stream host=localhost:20128 answered_by=m')));
    for (const line of logs) assert.doesNotMatch(line, /SECRET/);
  });
});

/**
 * groq.test.js
 *
 * Failover for the Groq provider, streaming (streamChat) and non-streaming
 * (chat, generateContent), against a scripted fake SDK.
 *
 * The fake re-exports the real groq-sdk error classes (loaded before the
 * interceptor), so status, body shapes and instanceof match production. Its
 * streams replay scripted chunks, honour the request's signal, and end
 * without throwing on abort, as the real SDK does. A plan can also hang after
 * its last chunk, as a server that keeps the connection open would (the real
 * SDK keeps reading past [DONE] until the connection closes).
 * Timeouts are shortened through the options, so the suite runs on real timers.
 * Run: node --test src/features/common/ai/providers/__tests__/groq.test.js
 */

'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const realSdk = require('groq-sdk');
const { APIError, APIUserAbortError } = realSdk;

// ---------------------------------------------------------------------------
// Fake SDK
// ---------------------------------------------------------------------------

let script = null; // async (call) => plan | throws; set per test
let calls = []; // { params, options, signal }

/** Resolve after ms, or as soon as signal aborts. */
function abortable(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/**
 * Replays a plan: { chunks: [chunk | { wait: ms }], error?, hang?, tpmLeft?, headersAfterMs? }.
 * Ends quietly when the signal aborts, like the real SDK stream.
 */
async function* replay(plan, signal) {
  for (const item of plan.chunks || []) {
    if (signal.aborted) return;
    if (item.wait != null) { await abortable(item.wait, signal); continue; }
    yield item;
  }
  if (signal.aborted) return;
  if (plan.error) throw plan.error;
  if (plan.hang) await abortable(2 ** 31 - 1, signal);
}

function fakeCreate(params, options) {
  const call = { params: structuredClone(params), options, signal: options?.signal };
  calls.push(call);
  const n = calls.length;
  const opened = (async () => {
    const plan = await script(call);
    if (plan.headersAfterMs != null) {
      await abortable(plan.headersAfterMs, call.signal);
      if (call.signal.aborted) throw new APIUserAbortError();
    }
    return { plan, data: replay(plan, call.signal) };
  })();
  const promise = opened.then(r => r.data);
  promise.catch(() => {}); // the provider awaits withResponse() instead
  promise.withResponse = async () => {
    const { plan, data } = await opened;
    const headers = { 'x-request-id': `req_hdr_${n}`, 'x-ratelimit-remaining-tokens': plan.tpmLeft ?? '7986' };
    return { data, response: new Response(null, { headers }) };
  };
  return promise;
}

class FakeGroq {
  constructor(opts) {
    this.clientOpts = opts;
    this.chat = { completions: { create: (params, options) => fakeCreate(params, options) } };
    this.models = { list: async () => ({ data: [] }) };
  }
}

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'groq-sdk') return { ...realSdk, Groq: FakeGroq, default: FakeGroq };
  return originalLoad.apply(this, arguments);
};
for (const k of Object.keys(require.cache)) if (/[\\/]groq\.js$/.test(k)) delete require.cache[k];

const health = require('../modelHealth');
const { createLLM, createStreamingLLM } = require('../groq');

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------

const USAGE = {
  prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, queue_time: 0.012,
  prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 2 },
};
const rid = (model) => `req_x_${model.split('/').pop()}`;
const base = (model) => ({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model });
const ch = {
  first: (model) => ({ ...base(model), choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }], x_groq: { id: rid(model) } }),
  text: (model, content) => ({ ...base(model), choices: [{ index: 0, delta: { content }, finish_reason: null }] }),
  reasoning: (model, reasoning) => ({ ...base(model), choices: [{ index: 0, delta: { reasoning }, finish_reason: null }] }),
  finish: (model, reason = 'stop') => ({ ...base(model), choices: [{ index: 0, delta: {}, finish_reason: reason }], x_groq: { id: rid(model), usage: USAGE } }),
  xerror: (model, error) => ({ ...base(model), choices: [], x_groq: { error } }),
};

/** A complete answer from `model`. */
function answer(model, ...texts) {
  return { chunks: [ch.first(model), ...texts.map(t => ch.text(model, t)), ch.finish(model)] };
}

/** An answer that streams `texts`, then ends with the given finish reason. */
function finishesWith(model, reason, texts = []) {
  return { chunks: [ch.first(model), ...texts.map(t => ch.text(model, t)), ch.finish(model, reason)] };
}

function httpError(status, { message = 'server said no', type, code, headers = {} } = {}) {
  const error = { message, type: type || (status >= 500 ? 'internal_server_error' : 'invalid_request_error') };
  if (code) error.code = code;
  return APIError.generate(status, { error }, undefined, new Headers({ 'x-request-id': `req_err_${status}`, ...headers }));
}

function streamError(type = 'server_error', message = 'Service unavailable') {
  return new APIError(undefined, { message, type }, undefined, new Headers());
}

const TOO_LARGE = 'Request too large for model `openai/gpt-oss-120b` in organization `org_x` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 9400, please reduce your message size and try again.';
const tooLarge = (message = TOO_LARGE) => httpError(413, { message, type: 'tokens', code: 'rate_limit_exceeded' });
const rateLimited = (headers = {}) => httpError(429, { message: 'rate limited', type: 'tokens', code: 'rate_limit_exceeded', headers });

/** Script by model ID: each entry is a plan, an Error to throw, or a list used in call order. */
function byModel(plans) {
  const seen = {};
  return async (call) => {
    const model = call.params.model;
    if (!(model in plans)) throw new Error(`unscripted model ${model}`);
    const i = (seen[model] = (seen[model] ?? -1) + 1);
    const entry = plans[model];
    const plan = Array.isArray(entry) ? entry[Math.min(i, entry.length - 1)] : entry;
    if (plan instanceof Error) throw plan;
    return plan;
  };
}

// ---------------------------------------------------------------------------
// Stream reading
// ---------------------------------------------------------------------------

function parseChunk(raw) {
  return raw.split('\n').filter(l => l.startsWith('data: ')).map((l) => {
    const d = l.slice(6);
    if (d === '[DONE]') return { done: true };
    const json = JSON.parse(d);
    if (json.choices) return { text: json.choices[0].delta.content };
    return json;
  });
}

/** Read the whole stream: { events, text, error }. */
async function readAll(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let error = null;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      events.push(...parseChunk(decoder.decode(value)));
    }
  } catch (err) {
    error = err;
  }
  return { events, error, text: events.filter(e => e.text != null).map(e => e.text).join('') };
}

/** Read until an event matches, then return the reader (to cancel it). */
async function readUntil(response, match) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) throw new Error('stream ended before the expected event');
    if (parseChunk(decoder.decode(value)).some(match)) return reader;
  }
}

const resets = (events) => events.filter(e => e._reset);
const finalModel = (events) => events.find(e => e._final_model)?._final_model;
const nextTick = () => new Promise(resolve => setImmediate(resolve));
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const hasImage = (params) => JSON.stringify(params.messages).includes('image_url');

/** Capture console output for the test; returns the lines. */
function captureLogs(t) {
  const lines = [];
  for (const level of ['log', 'warn', 'error']) {
    t.mock.method(console, level, (...args) => lines.push(args.map(a => (typeof a === 'string' ? a : a?.message ?? String(a))).join(' ')));
  }
  return lines;
}

const QUICK = { firstTextTimeoutMs: 200, idleTimeoutMs: null, requestDeadlineMs: null, retryRoundDelayMs: 10 };
const stream = (model, opts = {}) => createStreamingLLM({ apiKey: 'gsk_test', model, ...QUICK, ...opts });
const once = (model, opts = {}) => createLLM({ apiKey: 'gsk_test', model, ...QUICK, ...opts });
const ask = [{ role: 'system', content: 'You are Glass.' }, { role: 'user', content: 'What is 2+2?' }];
const IMAGE = { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } };
const askWithScreen = [{ role: 'system', content: 'You are Glass.' }, { role: 'user', content: [{ type: 'text', text: 'What is on screen?' }, IMAGE] }];
const test = (name, fn) => it(name, { timeout: 5000 }, fn);

const A = 'openai/gpt-oss-120b';
const B = 'openai/gpt-oss-20b';
const Q = 'qwen/qwen3.8-27b';
const D = 'acme/model-d';
const E = 'acme/model-e';

beforeEach(() => {
  health.resetHealth();
  script = null;
  calls = [];
});

// ---------------------------------------------------------------------------
// streamChat
// ---------------------------------------------------------------------------

describe('streamChat: success', () => {
  test('streams text, then _final_model and [DONE]; stops at finish_reason although the connection stays open (E44)', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: { ...answer(A, 'Hello', ' world'), hang: true } });
    const { events, error, text } = await readAll(await stream(A).streamChat(ask));
    assert.equal(error, null);
    assert.equal(text, 'Hello world');
    assert.deepEqual(events.slice(-2), [{ _final_model: A }, { done: true }]);
    assert.equal(resets(events).length, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].signal.aborted, true, 'connection closed at finish_reason');
  });

  test('every SDK call gets maxRetries 0, timeout 15000 and its own signal (FR-019)', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: rateLimited(), [B]: answer(B, 'ok') });
    await readAll(await stream(`${A},${B}`).streamChat(ask));
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.options.maxRetries, 0);
      assert.equal(call.options.timeout, 15_000);
      assert.ok(call.signal instanceof AbortSignal);
    }
    assert.notEqual(calls[0].signal, calls[1].signal);
  });

  test('sends the caller temperature, the budget and gpt-oss reasoning fields (FR-007..FR-009)', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: answer(A, 'ok') });
    await readAll(await stream(A, { temperature: 0.7, maxTokens: 900 }).streamChat(ask));
    const { params } = calls[0];
    assert.equal(params.temperature, 0.7);
    assert.equal(params.max_completion_tokens, 1924);
    assert.equal(params.reasoning_effort, 'low');
    assert.equal(params.include_reasoning, false);
    assert.equal(params.stream, true);
    assert.deepEqual(params.messages[0], { role: 'system', content: 'You are Glass.' });
    for (const key of ['max_tokens', 'top_p', 'n', 'stream_options', 'service_tier']) assert.equal(key in params, false, key);
  });

  test('resolves at once, even when every model fails', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: httpError(401, { type: 'invalid_request_error', code: 'invalid_api_key', message: 'Invalid API Key' }) });
    const response = await stream(A).streamChat(ask);
    assert.ok(response instanceof Response);
    const { error } = await readAll(response);
    assert.ok(error);
  });

  test('defaults to openai/gpt-oss-120b', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: answer(A, 'ok') });
    const llm = createStreamingLLM({ apiKey: 'gsk_test', ...QUICK });
    assert.equal((await readAll(await llm.streamChat(ask))).text, 'ok');
  });

  test('reasoning deltas are ignored: not text, not first text, never logged (E48)', async (t) => {
    const logs = captureLogs(t);
    script = byModel({ [A]: { chunks: [ch.first(A), ch.reasoning(A, 'SECRET-REASONING'), { wait: 30 }, ch.text(A, 'ok'), ch.finish(A)] } });
    const { error, text } = await readAll(await stream(A, { firstTextTimeoutMs: 500 }).streamChat(ask));
    assert.equal(error, null);
    assert.equal(text, 'ok');
    const line = logs.find(l => l.includes('outcome=ok'));
    assert.match(line, /ttft=(\d+)ms/);
    assert.ok(Number(/ttft=(\d+)ms/.exec(line)[1]) >= 25, 'first text is the content delta, not the reasoning');
    for (const l of logs) assert.equal(l.includes('SECRET-REASONING'), false, l);
  });
});

describe('streamChat: failover', () => {
  test('429 before the stream on model 1 of 2: one _reset, model 2 answers (SC-003, E22)', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: rateLimited({ 'retry-after': '20' }), [B]: answer(B, 'from B') });
    const { events, error, text } = await readAll(await stream(`${A},${B}`).streamChat(ask));
    assert.equal(error, null);
    assert.deepEqual(resets(events), [{ _reset: true, next_model: B, reason: 'transient' }]);
    assert.equal(text, 'from B');
    assert.equal(finalModel(events), B);
    assert.equal(events.at(-1).done, true);
    assert.equal(health.pickModel([A, B]), B, 'model 1 cools down');
  });

  test('a mid-stream {"error"} after text: _reset, model 2 answers (E36)', async (t) => {
    captureLogs(t);
    script = byModel({
      [A]: { chunks: [ch.first(A), ch.text(A, 'partial ')], error: streamError('server_error') },
      [B]: answer(B, 'full answer'),
    });
    const { events, error } = await readAll(await stream(`${A},${B}`).streamChat(ask));
    assert.equal(error, null);
    const iReset = events.findIndex(e => e._reset);
    assert.ok(iReset > 0, 'the partial text came before the _reset');
    assert.deepEqual(events[iReset], { _reset: true, next_model: B, reason: 'transient' });
    assert.equal(events.slice(iReset).filter(e => e.text).map(e => e.text).join(''), 'full answer');
  });

  test('a chunk with x_groq.error: STREAM_ERROR, failover, 10 s cooldown, the string is not logged (E37)', async (t) => {
    const logs = captureLogs(t);
    script = byModel({ [A]: { chunks: [ch.first(A), ch.text(A, 'partial'), ch.xerror(A, 'SECRET-STREAM-ERROR')], hang: true }, [B]: answer(B, 'ok') });
    const { events } = await readAll(await stream(`${A},${B}`).streamChat(ask));
    assert.deepEqual(resets(events), [{ _reset: true, next_model: B, reason: 'transient' }]);
    assert.equal(finalModel(events), B);
    assert.equal(calls[0].signal.aborted, true);
    for (const l of logs) assert.equal(l.includes('SECRET-STREAM-ERROR'), false, l);
    assert.ok(logs.some(l => l.includes(`model=${A} outcome=transient`) && l.includes('error="the stream was stopped early"')), logs.join('\n'));
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    assert.equal(health.pickModel([A, B]), B);
    t.mock.timers.tick(10_000);
    assert.equal(health.pickModel([A, B]), A);
  });

  test('404 model_not_found on model 1 of 2: reason unavailable, 5 min cooldown (E29)', async (t) => {
    captureLogs(t);
    script = byModel({ [D]: httpError(404, { code: 'model_not_found', message: `The model \`${D}\` does not exist or you do not have access to it.` }), [B]: answer(B, 'ok') });
    const { events } = await readAll(await stream(`${D},${B}`).streamChat(ask));
    assert.deepEqual(resets(events), [{ _reset: true, next_model: B, reason: 'unavailable' }]);
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    t.mock.timers.tick(5 * 60_000 - 1_000);
    assert.equal(health.pickModel([D, B]), B, 'still cooling before 5 min');
    t.mock.timers.tick(1_000);
    assert.equal(health.pickModel([D, B]), D, 'healthy after 5 min');
  });

  test('400 model_decommissioned on the only model: tells the user to pick another model (E30)', async (t) => {
    captureLogs(t);
    const retired = 'llama/retired-70b';
    script = byModel({ [retired]: httpError(400, { code: 'model_decommissioned', message: 'The model has been decommissioned.' }) });
    const { error } = await readAll(await stream(retired).streamChat(ask));
    assert.equal(error.userMessage, `${retired} is not available to this API key (decommissioned, blocked or not found). Pick a current model in Settings.`);
    assert.equal(calls.length, 1, 'no second round for an unavailable model');
  });

  test('413 TPM on model 1 of 2: _reset too-large, no cooldown, model 2 answers (E26)', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: tooLarge(), [B]: answer(B, 'ok') });
    const { events, text } = await readAll(await stream(`${A},${B}`).streamChat(ask));
    assert.deepEqual(resets(events), [{ _reset: true, next_model: B, reason: 'too-large' }]);
    assert.equal(text, 'ok');
    assert.equal(health.pickModel([A, B]), A, 'the next, smaller request may fit');
  });

  test('413 on the only model: the numbers, no second round (E27)', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: tooLarge() });
    const { error } = await readAll(await stream(A).streamChat(ask));
    assert.equal(calls.length, 1);
    assert.equal(error.userMessage, `${A} — request needs 9400 tokens; this key allows 8000 per minute. This request alone is over the limit: shorten the context or use a higher Groq tier.`);
  });

  test('413 without numbers: the server reason (E28)', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: tooLarge('Request Entity Too Large') });
    const { error } = await readAll(await stream(A).streamChat(ask));
    assert.equal(error.userMessage, `${A} — Request Entity Too Large`);
  });

  for (const [status, code] of [[400, undefined], [401, 'invalid_api_key'], [403, undefined]]) {
    test(`${status} on model 1 of 2: error at once, model 2 never called (E32, E33)`, async (t) => {
      captureLogs(t);
      script = byModel({ [A]: httpError(status, { code, message: 'the reason' }), [B]: answer(B, 'unreachable') });
      const { events, error } = await readAll(await stream(`${A},${B}`).streamChat(ask));
      assert.equal(calls.length, 1);
      assert.equal(resets(events).length, 0);
      assert.equal(error.userMessage, `${A} — the reason`);
    });
  }

  test('422 on model 1 of 2: the next model, and 422 stays out of the second round (E34)', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: httpError(422, { message: 'could not process' }), [B]: httpError(503, { message: 'busy' }) });
    const { events, error } = await readAll(await stream(`${A},${B}`).streamChat(ask));
    assert.deepEqual(calls.map(c => c.params.model), [A, B, B]);
    assert.deepEqual(resets(events).map(r => r.reason), ['transient', 'retry']);
    assert.equal(error.userMessage, `All Groq models failed (3 attempts, 2 rounds). Last: ${B} — busy`);
  });

  test('every model fails fast: "All Groq models failed (n attempts, 2 rounds)"', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: httpError(503, { message: 'busy A' }), [B]: httpError(503, { message: 'busy B' }) });
    const { events, error } = await readAll(await stream(`${A},${B}`).streamChat(ask));
    assert.equal(calls.length, 4);
    assert.deepEqual(resets(events).map(r => r.reason), ['transient', 'retry', 'transient']);
    assert.equal(error.userMessage, `All Groq models failed (4 attempts, 2 rounds). Last: ${B} — busy B`);
  });
});

describe('streamChat: second round (FR-019)', () => {
  test('503 twice on the only model: _reset retry, a wait, one more attempt (E23)', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: httpError(503, { message: 'Service Unavailable' }) });
    const startedAt = Date.now();
    const { events, error } = await readAll(await stream(A, { retryRoundDelayMs: 60 }).streamChat(ask));
    assert.equal(calls.length, 2);
    assert.deepEqual(resets(events), [{ _reset: true, next_model: A, reason: 'retry' }]);
    assert.ok(Date.now() - startedAt >= 55, 'waited before the second round');
    assert.equal(error.userMessage, `All Groq models failed (2 attempts, 2 rounds). Last: ${A} — Service Unavailable`);
  });

  test('a second-round success answers normally', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: [httpError(503), answer(A, 'second time lucky')] });
    const { events, error, text } = await readAll(await stream(A).streamChat(ask));
    assert.equal(error, null);
    assert.equal(text, 'second time lucky');
    assert.equal(finalModel(events), A);
  });

  test('429 with a retry-after longer than the wait: no second round (E24)', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: rateLimited({ 'retry-after': '30' }), [B]: rateLimited({ 'retry-after': '30' }) });
    const { error } = await readAll(await stream(`${A},${B}`).streamChat(ask));
    assert.equal(calls.length, 2);
    assert.equal(error.userMessage, `All Groq models failed (2 attempts). Last: ${B} — rate limited`);
  });

  test('429 whose retry-after fits the wait joins the second round (E25)', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: [rateLimited({ 'retry-after-ms': '5' }), answer(A, 'ok')] });
    const { events, text } = await readAll(await stream(A, { retryRoundDelayMs: 20 }).streamChat(ask));
    assert.equal(calls.length, 2);
    assert.deepEqual(resets(events).map(r => r.reason), ['retry']);
    assert.equal(text, 'ok');
  });

  test('429 without retry-after stays out of the second round', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: rateLimited() });
    await readAll(await stream(A).streamChat(ask));
    assert.equal(calls.length, 1);
  });

  test('timeouts, an empty length stop, stream errors, unavailable and too-large stay out of the second round', async (t) => {
    captureLogs(t);
    script = byModel({
      [A]: { chunks: [ch.first(A)], hang: true },
      [B]: finishesWith(B, 'length'),
      [Q]: { chunks: [ch.first(Q), ch.xerror(Q, 'stopped')] },
      [D]: httpError(404, { code: 'model_not_found' }),
      [E]: tooLarge(),
    });
    const { events } = await readAll(await stream(`${A},${B},${Q},${D},${E}`, { firstTextTimeoutMs: 30 }).streamChat(ask));
    assert.equal(calls.length, 5);
    assert.equal(resets(events).some(r => r.reason === 'retry'), false);
  });

  test('the deadline leaves less than the wait: no second round, deadline message', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: httpError(503, { message: 'Service Unavailable' }) });
    const { events, error } = await readAll(await stream(A, { requestDeadlineMs: 40, retryRoundDelayMs: 100 }).streamChat(ask));
    assert.equal(calls.length, 1);
    assert.equal(resets(events).length, 0);
    assert.equal(error.userMessage, `No answer within 0.04s (1 attempt). Last: ${A} — Service Unavailable`);
  });

  test('cancel during the wait: no new attempt, no error (E51)', async (t) => {
    const logs = captureLogs(t);
    script = byModel({ [A]: httpError(503) });
    const response = await stream(A, { retryRoundDelayMs: 150 }).streamChat(ask);
    const reader = await readUntil(response, e => e._reset && e.reason === 'retry');
    await reader.cancel();
    await sleep(250);
    assert.equal(calls.length, 1);
    assert.ok(logs.some(l => /request stream answered_by=none attempts=1 total=\d+ms cancelled/.test(l)), logs.join('\n'));
  });
});

describe('streamChat: timeouts (FR-015, FR-016)', () => {
  test('no text before the first-text timeout: _reset timeout, 10 s cooldown (E38)', async (t) => {
    const logs = captureLogs(t);
    script = byModel({ [A]: { chunks: [ch.first(A), ch.reasoning(A, 'thinking')], hang: true }, [B]: answer(B, 'ok') });
    const { events, text } = await readAll(await stream(`${A},${B}`, { firstTextTimeoutMs: 40 }).streamChat(ask));
    assert.deepEqual(resets(events), [{ _reset: true, next_model: B, reason: 'timeout' }]);
    assert.equal(text, 'ok');
    assert.equal(calls[0].signal.aborted, true);
    assert.ok(logs.some(l => l.includes(`model=${A} outcome=timeout`) && l.includes(`request_id=${rid(A)}`)), logs.join('\n'));
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    assert.equal(health.pickModel([A, B]), B);
    t.mock.timers.tick(10_000);
    assert.equal(health.pickModel([A, B]), A);
  });

  test('headers that never come count as a first-text timeout (E54)', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: { headersAfterMs: 10_000, chunks: [] }, [B]: answer(B, 'ok') });
    const { events, text } = await readAll(await stream(`${A},${B}`, { firstTextTimeoutMs: 30 }).streamChat(ask));
    assert.deepEqual(resets(events).map(r => r.reason), ['timeout']);
    assert.equal(text, 'ok');
  });

  test('the deadline cuts the next attempt to what is left, then gives up (E39, E41)', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: { chunks: [ch.first(A)], hang: true }, [B]: { chunks: [ch.first(B)], hang: true }, [Q]: answer(Q, 'never reached') });
    const startedAt = Date.now();
    const { error } = await readAll(await stream(`${A},${B},${Q}`, { firstTextTimeoutMs: 60, requestDeadlineMs: 90 }).streamChat(ask));
    const elapsed = Date.now() - startedAt;
    assert.equal(calls.length, 2, 'model 3 is never tried');
    assert.ok(elapsed < 140, `gave up near the deadline (${elapsed}ms)`);
    assert.match(error.userMessage, new RegExp(`^No answer within 0\\.09s \\(2 attempts\\)\\. Last: ${B} — no text after 0\\.0[0-4]\\d*s$`));
  });

  test('an answer streaming at the deadline is not cut (E42)', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: { chunks: [ch.first(A), ch.text(A, 'first '), { wait: 80 }, ch.text(A, 'second'), ch.finish(A)] } });
    const { error, text } = await readAll(await stream(A, { requestDeadlineMs: 40 }).streamChat(ask));
    assert.equal(error, null);
    assert.equal(text, 'first second');
  });

  test('silence after text started: idle timeout, failover (E43)', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: { chunks: [ch.first(A), ch.text(A, 'half')], hang: true }, [B]: answer(B, 'whole') });
    const { events } = await readAll(await stream(`${A},${B}`, { idleTimeoutMs: 40 }).streamChat(ask));
    assert.deepEqual(resets(events), [{ _reset: true, next_model: B, reason: 'timeout' }]);
    assert.equal(finalModel(events), B);
  });

  test('the idle timeout does not run before the first text', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: { chunks: [ch.first(A), { wait: 80 }, ch.text(A, 'late'), ch.finish(A)] } });
    const { error, text } = await readAll(await stream(A, { idleTimeoutMs: 30, firstTextTimeoutMs: 500 }).streamChat(ask));
    assert.equal(error, null);
    assert.equal(text, 'late');
  });

  test('a stream that ends without finish_reason is a transient failure (E47)', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: { chunks: [ch.first(A), ch.text(A, 'cut')] }, [B]: answer(B, 'ok') });
    const { events } = await readAll(await stream(`${A},${B}`).streamChat(ask));
    assert.deepEqual(resets(events).map(r => r.reason), ['transient']);
    assert.equal(finalModel(events), B);
  });
});

describe('streamChat: finish reasons (FR-017)', () => {
  test('length before any text: failure, failover (E45)', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: { chunks: [ch.first(A), ch.reasoning(A, 'long thought'), ch.finish(A, 'length')] }, [B]: answer(B, 'ok') });
    const { events } = await readAll(await stream(`${A},${B}`).streamChat(ask));
    assert.deepEqual(resets(events), [{ _reset: true, next_model: B, reason: 'transient' }]);
    assert.equal(finalModel(events), B);
  });

  test('length after text: success, logged stop=length (E46)', async (t) => {
    const logs = captureLogs(t);
    script = byModel({ [A]: finishesWith(A, 'length', ['long answer, cut']) });
    const { error, text } = await readAll(await stream(A).streamChat(ask));
    assert.equal(error, null);
    assert.equal(text, 'long answer, cut');
    assert.ok(logs.some(l => l.includes('outcome=ok') && l.includes('stop=length')));
  });
});

describe('streamChat: images (FR-010, FR-011)', () => {
  test('a screenshot goes to the vision model first; the text-only model gets it without the image (E17)', async (t) => {
    const logs = captureLogs(t);
    script = byModel({ [Q]: httpError(503, { message: 'busy' }), [A]: answer(A, 'from text') });
    const { events, text } = await readAll(await stream(`${A},${Q}`).streamChat(askWithScreen));
    assert.deepEqual(calls.map(c => c.params.model), [Q, A]);
    assert.equal(hasImage(calls[0].params), true);
    assert.equal(hasImage(calls[1].params), false);
    assert.deepEqual(resets(events), [{ _reset: true, next_model: A, reason: 'transient' }]);
    assert.equal(text, 'from text');
    assert.ok(logs.some(l => l.includes(`model=${Q}`) && l.includes('images=sent:1')), logs.join('\n'));
    assert.ok(logs.some(l => l.includes(`model=${A}`) && l.includes('images=dropped:1')), logs.join('\n'));
    assert.ok(logs.some(l => /request stream answered_by=openai\/gpt-oss-120b attempts=2 total=\d+ms order=vision-first$/.test(l)), logs.join('\n'));
  });

  test('without an image the list order is kept', async (t) => {
    const logs = captureLogs(t);
    script = byModel({ [A]: answer(A, 'ok') });
    await readAll(await stream(`${A},${Q}`).streamChat(ask));
    assert.equal(calls[0].params.model, A);
    assert.equal(logs.some(l => l.includes('order=vision-first')), false);
    assert.equal(logs.some(l => l.includes('images=')), false);
  });
});

describe('streamChat: cancellation (FR-018)', () => {
  test('cancel during an attempt: signal aborted within one turn, no failover, no error (SC-004, E49)', async (t) => {
    const logs = captureLogs(t);
    script = byModel({ [A]: { chunks: [ch.first(A)], hang: true }, [B]: answer(B, 'unreachable') });
    const response = await stream(`${A},${B}`).streamChat(ask);
    const reader = response.body.getReader();
    const pending = reader.read();
    await sleep(20);
    assert.equal(calls.length, 1);
    await reader.cancel();
    await nextTick();
    assert.equal(calls[0].signal.aborted, true);
    assert.deepEqual(await pending, { done: true, value: undefined });
    await sleep(50);
    assert.equal(calls.length, 1, 'no failover after cancel');
    assert.ok(logs.some(l => /request stream answered_by=none attempts=1 total=\d+ms cancelled/.test(l)), logs.join('\n'));
  });

  test('cancel after text: answered_by names the model, kept healthy (E50)', async (t) => {
    const logs = captureLogs(t);
    script = byModel({ [A]: { chunks: [ch.first(A), ch.text(A, 'half')], hang: true } });
    const response = await stream(A).streamChat(ask);
    const reader = await readUntil(response, e => e.text === 'half');
    await reader.cancel();
    await nextTick();
    assert.equal(calls[0].signal.aborted, true);
    await sleep(20);
    assert.ok(logs.some(l => l.includes(`request stream answered_by=${A}`) && l.includes('cancelled')), logs.join('\n'));
    assert.equal(health.pickModel([A, B]), A);
  });

  test('chunks after the cancel are not enqueued and nothing throws (E52)', async (t) => {
    const logs = captureLogs(t);
    script = byModel({ [A]: { chunks: [ch.first(A), ch.text(A, 'one'), { wait: 20 }, ch.text(A, 'two'), ch.text(A, 'three'), ch.finish(A)] } });
    const response = await stream(A).streamChat(ask);
    const reader = await readUntil(response, e => e.text === 'one');
    await reader.cancel();
    await sleep(60);
    assert.equal(logs.some(l => /ERR_INVALID_STATE|Invalid state/i.test(l)), false, logs.join('\n'));
    assert.ok(logs.some(l => l.includes('cancelled')));
  });
});

describe('streamChat: logs (FR-021, C3)', () => {
  test('one line per attempt and a request line, without prompt, answer or reasoning text (E61)', async (t) => {
    const logs = captureLogs(t);
    script = byModel({
      [A]: rateLimited({ 'retry-after': '30', 'x-ratelimit-remaining-tokens': '0' }),
      [B]: { chunks: [ch.first(B), ch.reasoning(B, 'SECRET-REASONING'), ch.text(B, 'SECRET-ANSWER '), ch.text(B, 'more'), ch.finish(B)], tpmLeft: '6100' },
    });
    const messages = [{ role: 'system', content: 'SECRET-SYSTEM' }, { role: 'user', content: 'SECRET-PROMPT' }];
    await readAll(await stream(`${A},${B}`).streamChat(messages));
    const lines = logs.filter(l => l.startsWith('[Groq Provider]'));
    assert.ok(lines.some(l => /^\[Groq Provider\] attempt 1\/2 stream model=openai\/gpt-oss-120b outcome=transient status=429 code=rate_limit_exceeded total=\d+ms effort=low tpm_left=0 request_id=req_err_429 error="rate limited"$/.test(l)), lines.join('\n'));
    assert.ok(lines.some(l => /^\[Groq Provider\] attempt 2\/2 stream model=openai\/gpt-oss-20b outcome=ok ttft=\d+ms last=\d+ms total=\d+ms chunks=2 stop=stop effort=low tokens=in:10,out:5,reasoning:2,cached:3 queue=12ms tpm_left=6100 request_id=req_x_gpt-oss-20b$/.test(l)), lines.join('\n'));
    assert.ok(lines.some(l => /^\[Groq Provider\] request stream answered_by=openai\/gpt-oss-20b attempts=2 total=\d+ms$/.test(l)), lines.join('\n'));
    for (const line of logs) {
      for (const secret of ['SECRET-ANSWER', 'SECRET-PROMPT', 'SECRET-SYSTEM', 'SECRET-REASONING']) assert.equal(line.includes(secret), false, line);
    }
  });

  test('the request id falls back to the x-request-id header', async (t) => {
    const logs = captureLogs(t);
    script = byModel({ [A]: { chunks: [ch.text(A, 'ok'), { ...base(A), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }] } });
    await readAll(await stream(A).streamChat(ask));
    assert.ok(logs.some(l => l.includes('outcome=ok') && l.endsWith('request_id=req_hdr_1')), logs.join('\n'));
  });
});

// ---------------------------------------------------------------------------
// chat / generateContent
// ---------------------------------------------------------------------------

describe('chat and generateContent (FR-022)', () => {
  test('joins the text; _modelUsed and the finish reason', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: answer(A, 'Hello ', 'world') });
    const result = await once(A).chat(ask);
    assert.equal(result.content, 'Hello world');
    assert.equal(result._modelUsed, A);
    assert.equal(result.raw.choices[0].finish_reason, 'stop');
    assert.equal(result.raw.choices[0].message.content, 'Hello world');
    assert.equal(result.raw.usage.prompt_tokens, 10);
  });

  test('every call streams with maxRetries 0; temperature sent; default budget', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: rateLimited(), [B]: answer(B, 'ok') });
    await once(`${A},${B}`, { temperature: 0.7 }).chat(ask);
    for (const call of calls) {
      assert.equal(call.options.maxRetries, 0);
      assert.equal(call.options.timeout, 15_000);
      assert.equal(call.params.stream, true);
      assert.equal(call.params.temperature, 0.7);
    }
    assert.equal(calls[1].params.max_completion_tokens, 3072, '2048 + the reasoning allowance');
  });

  test('429 on the first model: the second answers, _modelUsed names it', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: rateLimited(), [B]: answer(B, 'from B') });
    const result = await once(`${A},${B}`).chat(ask);
    assert.equal(result.content, 'from B');
    assert.equal(result._modelUsed, B);
  });

  test('a partial answer from a failed attempt is dropped', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: { chunks: [ch.first(A), ch.text(A, 'stale ')], error: streamError() }, [B]: answer(B, 'fresh') });
    assert.equal((await once(`${A},${B}`).chat(ask)).content, 'fresh');
  });

  test('503 twice on the only model: second round, then thrown with userMessage', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: httpError(503, { message: 'Service Unavailable' }) });
    await assert.rejects(once(A).chat(ask), (err) => {
      assert.equal(err.userMessage, `All Groq models failed (2 attempts, 2 rounds). Last: ${A} — Service Unavailable`);
      return true;
    });
    assert.equal(calls.length, 2);
  });

  test('400: thrown at once with userMessage', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: httpError(400, { message: 'bad' }), [B]: answer(B, 'unreachable') });
    await assert.rejects(once(`${A},${B}`).chat(ask), (err) => {
      assert.equal(err.status, 400);
      assert.equal(err.userMessage, `${A} — bad`);
      return true;
    });
    assert.equal(calls.length, 1);
  });

  test('413: the next model answers', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: tooLarge(), [B]: answer(B, 'ok') });
    const result = await once(`${A},${B}`).chat(ask);
    assert.equal(result._modelUsed, B);
  });

  test('logs mode once', async (t) => {
    const logs = captureLogs(t);
    script = byModel({ [A]: answer(A, 'ok') });
    await once(A).chat(ask);
    assert.ok(logs.some(l => l.startsWith(`[Groq Provider] attempt 1/1 once model=${A} outcome=ok`)), logs.join('\n'));
    assert.ok(logs.some(l => l.startsWith(`[Groq Provider] request once answered_by=${A} attempts=1`)), logs.join('\n'));
  });

  test('generateContent: strings and images as user content, the vision model first (E19)', async (t) => {
    captureLogs(t);
    script = byModel({ [Q]: answer(Q, 'described') });
    const result = await once(`${A},${Q}`).generateContent(['You are a helpful assistant.', 'Describe it.', { inlineData: { mimeType: 'image/png', data: 'AAAA' } }]);
    assert.equal(result.response.text(), 'described');
    assert.equal(result._modelUsed, Q);
    assert.deepEqual(calls[0].params.messages, [{ role: 'user', content: [
      { type: 'text', text: 'You are a helpful assistant.' },
      { type: 'text', text: 'Describe it.' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ] }]);
  });
});

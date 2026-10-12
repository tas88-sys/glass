/**
 * anthropic.test.js
 *
 * Failover for the Anthropic provider, streaming (streamChat) and
 * non-streaming (chat, generateContent), against a scripted fake SDK.
 *
 * The fake re-exports the real SDK's error classes (loaded before the
 * interceptor), so status, type, requestID and instanceof match production.
 * Its streams replay scripted events, honour the request's signal, and end
 * without throwing on abort, as the real SDK does.
 * Timeouts are shortened through the options, so the suite runs on real timers.
 * Run: node --test src/features/common/ai/providers/__tests__/anthropic.test.js
 */

'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const realSdk = require('@anthropic-ai/sdk');
const { APIError, APIUserAbortError } = realSdk;

// ---------------------------------------------------------------------------
// Fake SDK
// ---------------------------------------------------------------------------

let script = null; // async (call) => plan | throws; set per test
let calls = []; // { method, params, options, signal }

/** Resolve after ms, or as soon as signal aborts. */
function abortable(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/**
 * Replays a plan: { events: [event | { wait: ms }], error?, hang? }.
 * Ends quietly when the signal aborts, like the real SDK stream.
 */
async function* replay(plan, signal) {
  for (const item of plan.events || []) {
    if (signal.aborted) return;
    if (item.wait != null) { await abortable(item.wait, signal); continue; }
    yield item;
  }
  if (signal.aborted) return;
  if (plan.error) throw plan.error;
  if (plan.hang) await abortable(2 ** 31 - 1, signal);
}

function fakeCreate(method, params, options) {
  const call = { method, params: structuredClone(params), options, signal: options?.signal };
  calls.push(call);
  const requestId = `req_${calls.length}`;
  const promise = (async () => {
    const plan = await script(call);
    if (plan.headersAfterMs != null) {
      await abortable(plan.headersAfterMs, call.signal);
      if (call.signal.aborted) throw new APIUserAbortError();
    }
    return replay(plan, call.signal);
  })();
  promise.withResponse = async () => ({ data: await promise, request_id: requestId, response: null });
  return promise;
}

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '@anthropic-ai/sdk') {
    return {
      ...realSdk,
      Anthropic: class {
        constructor(opts) {
          this.clientOpts = opts;
          this.messages = { create: (params, options) => fakeCreate('messages', params, options) };
          this.beta = { messages: { create: (params, options) => fakeCreate('beta', params, options) } };
        }
      },
    };
  }
  return originalLoad.apply(this, arguments);
};
for (const k of Object.keys(require.cache)) if (k.includes('anthropic.js')) delete require.cache[k];

const health = require('../modelHealth');
const catalog = require('../../modelCatalog');
const ANTHROPIC_MODELS = require('../../__tests__/fixtures/anthropic-models.json');
const { createLLM, createStreamingLLM, normalizeModel } = require('../anthropic');

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------

const ev = {
  start: (model) => ({
    type: 'message_start',
    message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0 } },
  }),
  block: (index, type) => ({ type: 'content_block_start', index, content_block: type === 'thinking' ? { type, thinking: '' } : { type, text: '' } }),
  text: (text, index = 0) => ({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } }),
  thinkingDelta: (index = 0) => ({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: '' } }),
  blockStop: (index = 0) => ({ type: 'content_block_stop', index }),
  fallback: (index, from, to) => ({ type: 'content_block_start', index, content_block: { type: 'fallback', from: { model: from }, to: { model: to } } }),
  delta: (stopReason, extra = {}) => ({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null, ...extra }, usage: { output_tokens: 5 } }),
  stop: () => ({ type: 'message_stop' }),
};

/** A complete answer from `model`. */
function answer(model, ...texts) {
  return { events: [ev.start(model), ev.block(0, 'text'), ...texts.map(t => ev.text(t)), ev.blockStop(), ev.delta('end_turn'), ev.stop()] };
}

/** An answer that streams `texts`, then ends with the given stop reason. */
function stopsWith(model, stopReason, texts = [], extra = {}) {
  return { events: [ev.start(model), ev.block(0, 'text'), ...texts.map(t => ev.text(t)), ev.blockStop(), ev.delta(stopReason, extra), ev.stop()] };
}

function httpError(status, { type, message = 'server said no', headers = {} } = {}) {
  const body = { type: 'error', error: { type: type || (status === 529 ? 'overloaded_error' : 'api_error'), message } };
  return APIError.generate(status, body, undefined, new Headers({ 'request-id': `req_err_${status}`, ...headers }));
}

function streamError(type = 'overloaded_error', message = 'Overloaded') {
  return new APIError(undefined, { type: 'error', error: { type, message } }, undefined, new Headers(), type);
}

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

/** Capture console output for the test; returns the lines. */
function captureLogs(t) {
  const lines = [];
  for (const level of ['log', 'warn', 'error']) {
    t.mock.method(console, level, (...args) => lines.push(args.map(a => (typeof a === 'string' ? a : a?.message ?? String(a))).join(' ')));
  }
  return lines;
}

const QUICK = { firstTextTimeoutMs: 200, idleTimeoutMs: null, requestDeadlineMs: null, retryRoundDelayMs: 10 };
const stream = (model, opts = {}) => createStreamingLLM({ apiKey: 'sk-ant-test', model, ...QUICK, ...opts });
const once = (model, opts = {}) => createLLM({ apiKey: 'sk-ant-test', model, ...QUICK, ...opts });
const ask = [{ role: 'system', content: 'You are Glass.' }, { role: 'user', content: 'What is 2+2?' }];
const test = (name, fn) => it(name, { timeout: 5000 }, fn);

const A = 'claude-haiku-5-5';
const B = 'claude-haiku-4-5';
const C = 'claude-opus-4-8';

beforeEach(() => {
  health.resetHealth();
  // What the Models API reports, as the catalog keeps it.
  catalog.resetCatalog();
  catalog.seed('anthropic', ANTHROPIC_MODELS.data.filter((m) => m.lifecycle !== 'retired').map(normalizeModel));
  script = null;
  calls = [];
});

// ---------------------------------------------------------------------------
// streamChat
// ---------------------------------------------------------------------------

describe('streamChat: success', () => {
  test('streams text, then _final_model and [DONE]; stops reading at message_stop (E27)', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: { ...answer(A, 'Hello', ' world'), hang: true } });
    const { events, error, text } = await readAll(await stream(A).streamChat(ask));
    assert.equal(error, null);
    assert.equal(text, 'Hello world');
    assert.deepEqual(events.slice(-2), [{ _final_model: A }, { done: true }]);
    assert.equal(resets(events).length, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].signal.aborted, true, 'connection closed after message_stop');
  });

  test('every SDK call gets maxRetries 0, timeout 15000 and its own signal (FR-018)', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: httpError(529), [B]: answer(B, 'ok') });
    await readAll(await stream(`${A},${B}`).streamChat(ask));
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.options.maxRetries, 0);
      assert.equal(call.options.timeout, 15_000);
      assert.ok(call.signal instanceof AbortSignal);
    }
    assert.notEqual(calls[0].signal, calls[1].signal);
  });

  test('never sends the temperature the caller passes (SC-005)', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: answer(A, 'ok') });
    await readAll(await stream(A, { temperature: 0.7, maxTokens: 900 }).streamChat(ask));
    const { params } = calls[0];
    for (const key of ['temperature', 'top_p', 'top_k', 'thinking']) assert.equal(key in params, false, key);
    assert.equal(params.max_tokens, 4096);
    assert.deepEqual(params.output_config, { effort: 'low' });
    assert.equal(params.system, 'You are Glass.');
  });

  test('resolves at once, even when every model fails', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: httpError(401, { type: 'authentication_error', message: 'invalid x-api-key' }) });
    const response = await stream(A).streamChat(ask);
    assert.ok(response instanceof Response);
    const { error } = await readAll(response);
    assert.ok(error);
  });

  test('defaults to claude-opus-5-5', async (t) => {
    captureLogs(t);
    script = byModel({ 'claude-opus-5-5': answer('claude-opus-5-5', 'ok') });
    const llm = createStreamingLLM({ apiKey: 'sk-ant-test', ...QUICK });
    assert.equal((await readAll(await llm.streamChat(ask))).text, 'ok');
  });
});

describe('streamChat: failover', () => {
  test('529 before the stream on model 1 of 2: one _reset, model 2 answers (SC-003, E14)', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: httpError(529, { message: 'Overloaded' }), [B]: answer(B, 'from B') });
    const { events, error, text } = await readAll(await stream(`${A},${B}`).streamChat(ask));
    assert.equal(error, null);
    assert.deepEqual(resets(events), [{ _reset: true, next_model: B, reason: 'transient' }]);
    assert.equal(text, 'from B');
    assert.equal(finalModel(events), B);
    assert.equal(events.at(-1).done, true);
    assert.equal(health.pickModel([A, B]), B, 'model 1 cools down');
  });

  test('stream error event after text: _reset, model 2 answers (E17)', async (t) => {
    captureLogs(t);
    script = byModel({
      [A]: { events: [ev.start(A), ev.block(0, 'text'), ev.text('partial ')], error: streamError('overloaded_error') },
      [B]: answer(B, 'full answer'),
    });
    const { events, error } = await readAll(await stream(`${A},${B}`).streamChat(ask));
    assert.equal(error, null);
    const iReset = events.findIndex(e => e._reset);
    assert.ok(iReset > 0, 'the partial text came before the _reset');
    assert.deepEqual(events[iReset], { _reset: true, next_model: B, reason: 'transient' });
    assert.equal(events.slice(iReset).filter(e => e.text).map(e => e.text).join(''), 'full answer');
  });

  test('404 on model 1 of 2: reason unavailable, 5 min cooldown (E18)', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: httpError(404, { type: 'not_found_error', message: `model: ${A}` }), [B]: answer(B, 'ok') });
    const { events } = await readAll(await stream(`${A},${B}`).streamChat(ask));
    assert.deepEqual(resets(events), [{ _reset: true, next_model: B, reason: 'unavailable' }]);
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    t.mock.timers.tick(5 * 60_000 - 1_000);
    assert.equal(health.pickModel([A, B]), B, 'still cooling before 5 min');
    t.mock.timers.tick(1_000);
    assert.equal(health.pickModel([A, B]), A, 'healthy after 5 min');
  });

  test('404 on the only model: tells the user to pick another model (E19)', async (t) => {
    captureLogs(t);
    script = byModel({ 'claude-3-5-sonnet-20241022': httpError(404, { type: 'not_found_error', message: 'model: claude-3-5-sonnet-20241022' }) });
    const { error } = await readAll(await stream('claude-3-5-sonnet-20241022').streamChat(ask));
    assert.equal(error.userMessage, 'claude-3-5-sonnet-20241022 is not available to this API key (retired or not enabled). Pick a current model in Settings.');
    assert.equal(calls.length, 1, 'no second round for an unavailable model');
  });

  for (const [status, type] of [[400, 'invalid_request_error'], [401, 'authentication_error'], [403, 'permission_error']]) {
    test(`${status} on model 1 of 2: error at once, model 2 never called (E20, E21)`, async (t) => {
      captureLogs(t);
      script = byModel({ [A]: httpError(status, { type, message: 'the reason' }), [B]: answer(B, 'unreachable') });
      const { events, error } = await readAll(await stream(`${A},${B}`).streamChat(ask));
      // A 400 on the beta method is resent once without the beta (it fails the same way).
      assert.deepEqual(calls.map(c => c.method), status === 400 ? ['beta', 'messages'] : ['beta']);
      assert.ok(calls.every(c => c.params.model === A), 'model 2 never called');
      assert.equal(resets(events).length, 0);
      assert.equal(error.userMessage, `${A} — the reason`);
      assert.equal(catalog.capabilities('anthropic', A).serverFallback, null, 'not mistaken for a refused beta');
    });
  }

  test('every model fails fast: "All Claude models failed (n attempts, 2 rounds)"', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: httpError(503, { message: 'busy A' }), [B]: httpError(503, { message: 'busy B' }) });
    const { events, error } = await readAll(await stream(`${A},${B}`).streamChat(ask));
    assert.equal(calls.length, 4);
    assert.deepEqual(resets(events).map(r => r.reason), ['transient', 'retry', 'transient']);
    assert.equal(error.userMessage, `All Claude models failed (4 attempts, 2 rounds). Last: ${B} — busy B`);
  });
});

describe('streamChat: second round (FR-018)', () => {
  test('529 twice on the only model: _reset retry, a wait, one more attempt (E15)', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: httpError(529, { message: 'Overloaded' }) });
    const startedAt = Date.now();
    const { events, error } = await readAll(await stream(A, { retryRoundDelayMs: 60 }).streamChat(ask));
    assert.equal(calls.length, 2);
    assert.deepEqual(resets(events), [{ _reset: true, next_model: A, reason: 'retry' }]);
    assert.ok(Date.now() - startedAt >= 55, 'waited before the second round');
    assert.equal(error.userMessage, `All Claude models failed (2 attempts, 2 rounds). Last: ${A} — Overloaded`);
  });

  test('a second-round success answers normally', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: [httpError(529), answer(A, 'second time lucky')] });
    const { events, error, text } = await readAll(await stream(A).streamChat(ask));
    assert.equal(error, null);
    assert.equal(text, 'second time lucky');
    assert.equal(finalModel(events), A);
  });

  test('429 with a retry-after longer than the wait: no second round (E42)', async (t) => {
    captureLogs(t);
    const limited = () => httpError(429, { type: 'rate_limit_error', message: 'rate limited', headers: { 'retry-after': '30' } });
    script = byModel({ [A]: limited(), [B]: limited() });
    const { error } = await readAll(await stream(`${A},${B}`).streamChat(ask));
    assert.equal(calls.length, 2);
    assert.equal(error.userMessage, `All Claude models failed (2 attempts). Last: ${B} — rate limited`);
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    t.mock.timers.tick(29_000);
    assert.equal(health.pickModel([A]), A, 'every model cooling: the soonest is tried anyway');
  });

  test('429 whose retry-after fits the wait joins the second round (E43)', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: [httpError(429, { type: 'rate_limit_error', headers: { 'retry-after-ms': '5' } }), answer(A, 'ok')] });
    const { events, text } = await readAll(await stream(A, { retryRoundDelayMs: 20 }).streamChat(ask));
    assert.equal(calls.length, 2);
    assert.deepEqual(resets(events).map(r => r.reason), ['retry']);
    assert.equal(text, 'ok');
  });

  test('429 without retry-after stays out of the second round', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: httpError(429, { type: 'rate_limit_error' }) });
    await readAll(await stream(A).streamChat(ask));
    assert.equal(calls.length, 1);
  });

  test('timeouts, refusals and unavailable models stay out of the second round', async (t) => {
    captureLogs(t);
    script = byModel({
      [A]: { events: [ev.start(A)], hang: true },
      [B]: stopsWith(B, 'refusal'),
      [C]: httpError(404, { type: 'not_found_error' }),
    });
    const { events } = await readAll(await stream(`${A},${B},${C}`, { firstTextTimeoutMs: 30 }).streamChat(ask));
    assert.equal(calls.length, 3);
    assert.equal(resets(events).some(r => r.reason === 'retry'), false);
  });

  test('the deadline leaves less than the wait: no second round, deadline message (E44)', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: httpError(529, { message: 'Overloaded' }) });
    const { events, error } = await readAll(await stream(A, { requestDeadlineMs: 40, retryRoundDelayMs: 100 }).streamChat(ask));
    assert.equal(calls.length, 1);
    assert.equal(resets(events).length, 0);
    assert.equal(error.userMessage, `No answer within 0.04s (1 attempt). Last: ${A} — Overloaded`);
  });

  test('cancel during the wait: no new attempt, no error (E45)', async (t) => {
    const logs = captureLogs(t);
    script = byModel({ [A]: httpError(529) });
    const response = await stream(A, { retryRoundDelayMs: 150 }).streamChat(ask);
    const reader = await readUntil(response, e => e._reset && e.reason === 'retry');
    await reader.cancel();
    await sleep(250);
    assert.equal(calls.length, 1);
    assert.ok(logs.some(l => /request stream answered_by=none attempts=1 total=\d+ms cancelled/.test(l)), logs.join('\n'));
  });
});

describe('streamChat: timeouts (FR-013, FR-014)', () => {
  test('no text before the first-text timeout: _reset timeout, 10 s cooldown (E22)', async (t) => {
    const logs = captureLogs(t);
    script = byModel({
      [A]: { events: [ev.start(A), ev.block(0, 'thinking'), ev.thinkingDelta()], hang: true },
      [B]: answer(B, 'ok'),
    });
    const { events, text } = await readAll(await stream(`${A},${B}`, { firstTextTimeoutMs: 40 }).streamChat(ask));
    assert.deepEqual(resets(events), [{ _reset: true, next_model: B, reason: 'timeout' }]);
    assert.equal(text, 'ok');
    assert.equal(calls[0].signal.aborted, true);
    assert.ok(logs.some(l => l.includes(`model=${A} outcome=timeout`) && l.includes('request_id=req_1')), logs.join('\n'));
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    assert.equal(health.pickModel([A, B]), B);
    t.mock.timers.tick(10_000);
    assert.equal(health.pickModel([A, B]), A);
  });

  test('headers that never come count as a first-text timeout', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: { headersAfterMs: 10_000, events: [] }, [B]: answer(B, 'ok') });
    const { events, text } = await readAll(await stream(`${A},${B}`, { firstTextTimeoutMs: 30 }).streamChat(ask));
    assert.deepEqual(resets(events).map(r => r.reason), ['timeout']);
    assert.equal(text, 'ok');
  });

  test('the deadline cuts the next attempt to what is left, then gives up (E23, E24)', async (t) => {
    captureLogs(t);
    const silent = { events: [ev.start('x')], hang: true };
    script = byModel({ [A]: silent, [B]: silent, [C]: answer(C, 'never reached') });
    const startedAt = Date.now();
    const { error } = await readAll(await stream(`${A},${B},${C}`, { firstTextTimeoutMs: 60, requestDeadlineMs: 90 }).streamChat(ask));
    const elapsed = Date.now() - startedAt;
    assert.equal(calls.length, 2, 'model 3 is never tried');
    assert.ok(elapsed < 140, `gave up near the deadline (${elapsed}ms)`);
    assert.match(error.userMessage, new RegExp(`^No answer within 0\\.09s \\(2 attempts\\)\\. Last: ${B} — no text after 0\\.0[0-4]\\d*s$`));
  });

  test('an answer streaming at the deadline is not cut (E25)', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: { events: [ev.start(A), ev.block(0, 'text'), ev.text('first '), { wait: 80 }, ev.text('second'), ev.blockStop(), ev.delta('end_turn'), ev.stop()] } });
    const { error, text } = await readAll(await stream(A, { requestDeadlineMs: 40 }).streamChat(ask));
    assert.equal(error, null);
    assert.equal(text, 'first second');
  });

  test('silence after text started: idle timeout, failover (E26)', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: { events: [ev.start(A), ev.block(0, 'text'), ev.text('half')], hang: true }, [B]: answer(B, 'whole') });
    const { events } = await readAll(await stream(`${A},${B}`, { idleTimeoutMs: 40 }).streamChat(ask));
    assert.deepEqual(resets(events), [{ _reset: true, next_model: B, reason: 'timeout' }]);
    assert.equal(finalModel(events), B);
  });

  test('the idle timeout does not run before the first text', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: { events: [ev.start(A), { wait: 80 }, ev.block(0, 'text'), ev.text('late'), ev.blockStop(), ev.delta('end_turn'), ev.stop()] } });
    const { error, text } = await readAll(await stream(A, { idleTimeoutMs: 30, firstTextTimeoutMs: 500 }).streamChat(ask));
    assert.equal(error, null);
    assert.equal(text, 'late');
  });

  test('a stream that ends without message_stop is a transient failure', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: { events: [ev.start(A), ev.block(0, 'text'), ev.text('cut')] }, [B]: answer(B, 'ok') });
    const { events } = await readAll(await stream(`${A},${B}`).streamChat(ask));
    assert.deepEqual(resets(events).map(r => r.reason), ['transient']);
    assert.equal(finalModel(events), B);
  });
});

describe('streamChat: stop reasons (FR-015)', () => {
  test('refusal after partial text, model 1 of 2: _reset refusal, no cooldown (E28)', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: stopsWith(A, 'refusal', ['I'], { stop_details: { category: 'cyber' } }), [B]: answer(B, 'answer') });
    const { events } = await readAll(await stream(`${A},${B}`).streamChat(ask));
    assert.deepEqual(resets(events), [{ _reset: true, next_model: B, reason: 'refusal' }]);
    assert.equal(finalModel(events), B);
    assert.equal(health.pickModel([A, B]), A, 'a refusal does not cool the model down');
  });

  test('refusal on the only model: "<model> declined to answer" (E29)', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: stopsWith(A, 'refusal', ['Partial']) });
    const { error, text } = await readAll(await stream(A).streamChat(ask));
    assert.equal(text, 'Partial');
    assert.equal(error.userMessage, `${A} declined to answer.`);
    assert.equal(calls.length, 1);
  });

  test('max_tokens before any text: failure, failover (E30)', async (t) => {
    captureLogs(t);
    script = byModel({
      [A]: { events: [ev.start(A), ev.block(0, 'thinking'), ev.thinkingDelta(), ev.blockStop(), ev.delta('max_tokens'), ev.stop()] },
      [B]: answer(B, 'ok'),
    });
    const { events } = await readAll(await stream(`${A},${B}`).streamChat(ask));
    assert.deepEqual(resets(events), [{ _reset: true, next_model: B, reason: 'transient' }]);
    assert.equal(finalModel(events), B);
  });

  test('max_tokens after text: success, logged stop=max_tokens (E31)', async (t) => {
    const logs = captureLogs(t);
    script = byModel({ [A]: stopsWith(A, 'max_tokens', ['long answer, cut']) });
    const { error, text } = await readAll(await stream(A).streamChat(ask));
    assert.equal(error, null);
    assert.equal(text, 'long answer, cut');
    assert.ok(logs.some(l => l.includes('outcome=ok') && l.includes('stop=max_tokens')));
  });
});

describe('streamChat: server-side fallback (FR-009, FR-016)', () => {
  const S = 'claude-sonnet-5-5';

  test('a fallback block mid-stream: no _reset, _final_model is the model that finished (E32)', async (t) => {
    const logs = captureLogs(t);
    script = byModel({
      [S]: { events: [
        ev.start(S), ev.block(0, 'text'), ev.text('Part one. '), ev.blockStop(0),
        ev.fallback(1, S, 'claude-sonnet-5'), ev.blockStop(1),
        ev.block(2, 'text'), ev.text('Part two.', 2), ev.blockStop(2), ev.delta('end_turn'), ev.stop(),
      ] },
    });
    const { events, text } = await readAll(await stream(S).streamChat(ask));
    assert.equal(calls[0].method, 'beta');
    assert.deepEqual(calls[0].params.betas, ['server-side-fallback-2026-07-01']);
    assert.equal(calls[0].params.fallbacks, 'default');
    assert.equal(resets(events).length, 0);
    assert.equal(text, 'Part one. Part two.');
    assert.equal(finalModel(events), 'claude-sonnet-5');
    assert.ok(logs.some(l => l.includes(`fallback=${S}→claude-sonnet-5`)), logs.join('\n'));
  });

  test('beta rejected: the attempt is resent once without it, and the model is not sent it again (E41)', async (t) => {
    const logs = captureLogs(t);
    const rejected = httpError(400, { type: 'invalid_request_error', message: 'Unexpected value(s) `server-side-fallback-2026-07-01` for the `anthropic-beta` header.' });
    script = async (call) => {
      if (call.method === 'beta') throw rejected;
      return answer(call.params.model, 'ok');
    };
    const first = await readAll(await stream(S).streamChat(ask));
    assert.equal(first.error, null);
    assert.equal(first.text, 'ok');
    assert.deepEqual(calls.map(c => c.method), ['beta', 'messages']);
    assert.equal('fallbacks' in calls[1].params, false);
    assert.equal(logs.filter(l => l.includes(`server-side fallback off for model=${S}`)).length, 1);
    assert.equal(catalog.capabilities('anthropic', S).serverFallback, false, 'kept in the catalog');

    await readAll(await stream(S).streamChat(ask));
    assert.deepEqual(calls.map(c => c.method), ['beta', 'messages', 'messages']);

    // Another model still tries the beta: the refusal is per model.
    await readAll(await stream(A).streamChat(ask));
    assert.deepEqual(calls.slice(3).map(c => c.method), ['beta', 'messages']);
  });

  test('another 400 on the beta method: resent once, fails the same way, nothing recorded', async (t) => {
    captureLogs(t);
    script = byModel({ [S]: httpError(400, { type: 'invalid_request_error', message: 'messages: text content blocks must be non-empty' }) });
    const { error } = await readAll(await stream(S).streamChat(ask));
    assert.deepEqual(calls.map(c => c.method), ['beta', 'messages']);
    assert.equal(error.userMessage, `${S} — messages: text content blocks must be non-empty`);
    assert.equal(catalog.capabilities('anthropic', S).serverFallback, null);
  });
});

describe('streamChat: images (catalog)', () => {
  const screen = [{ role: 'user', content: [{ type: 'text', text: 'What is on screen?' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }] }];
  const hasImage = (params) => JSON.stringify(params.messages).includes('"type":"image"');

  test('a screenshot goes to the models that see images first', async (t) => {
    captureLogs(t);
    catalog.setOverride('anthropic', A, 'vision', false);
    script = byModel({ [B]: answer(B, 'I see it') });
    const { text } = await readAll(await stream(`${A},${B}`).streamChat(screen));
    assert.deepEqual(calls.map(c => c.params.model), [B]);
    assert.equal(hasImage(calls[0].params), true);
    assert.equal(text, 'I see it');
  });

  test('visionOnly: a model that does not see images is not tried; none left is NO_VISION_MODEL', async (t) => {
    captureLogs(t);
    catalog.setOverride('anthropic', A, 'vision', false);
    script = byModel({ [A]: answer(A, 'blind') });
    const { error } = await readAll(await stream(A, { visionOnly: true }).streamChat(screen));
    assert.equal(calls.length, 0);
    assert.equal(error.code, 'NO_VISION_MODEL');
    assert.equal(error.userMessage, 'No Anthropic model in the list sees images.');
  });

  test('without visionOnly, a model that does not see images gets the request without them', async (t) => {
    captureLogs(t);
    catalog.setOverride('anthropic', A, 'vision', false);
    script = byModel({ [A]: answer(A, 'blind') });
    const { text } = await readAll(await stream(A).streamChat(screen));
    assert.equal(hasImage(calls[0].params), false);
    assert.equal(text, 'blind');
  });
});

describe('streamChat: cancellation (FR-017)', () => {
  test('cancel during an attempt: signal aborted within one turn, no failover, no error (SC-004, E33)', async (t) => {
    const logs = captureLogs(t);
    script = byModel({ [A]: { events: [ev.start(A)], hang: true }, [B]: answer(B, 'unreachable') });
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

  test('cancel after text: answered_by names the model, kept healthy (E34)', async (t) => {
    const logs = captureLogs(t);
    script = byModel({ [A]: { events: [ev.start(A), ev.block(0, 'text'), ev.text('half')], hang: true } });
    const response = await stream(A).streamChat(ask);
    const reader = await readUntil(response, e => e.text === 'half');
    await reader.cancel();
    await nextTick();
    assert.equal(calls[0].signal.aborted, true);
    await sleep(20);
    assert.ok(logs.some(l => l.includes(`request stream answered_by=${A}`) && l.includes('cancelled')), logs.join('\n'));
    assert.equal(health.pickModel([A, B]), A);
  });

  test('events after the cancel are not enqueued and nothing throws (E35)', async (t) => {
    const logs = captureLogs(t);
    script = byModel({ [A]: { events: [ev.start(A), ev.block(0, 'text'), ev.text('one'), { wait: 20 }, ev.text('two'), ev.text('three'), ev.blockStop(), ev.delta('end_turn'), ev.stop()] } });
    const response = await stream(A).streamChat(ask);
    const reader = await readUntil(response, e => e.text === 'one');
    await reader.cancel();
    await sleep(60);
    assert.equal(logs.some(l => /ERR_INVALID_STATE|Invalid state/i.test(l)), false, logs.join('\n'));
    assert.ok(logs.some(l => l.includes('cancelled')));
  });
});

describe('streamChat: logs (FR-020, C3)', () => {
  test('one line per attempt and a request line, without prompt or answer text', async (t) => {
    const logs = captureLogs(t);
    script = byModel({ [A]: httpError(529, { message: 'Overloaded' }), [B]: answer(B, 'SECRET-ANSWER ', 'more') });
    const messages = [{ role: 'user', content: 'SECRET-PROMPT' }];
    await readAll(await stream(`${A},${B}`).streamChat(messages));
    const lines = logs.filter(l => l.startsWith('[Anthropic Provider]'));
    assert.ok(lines.some(l => /^\[Anthropic Provider\] attempt 1\/2 stream model=claude-haiku-5-5 outcome=transient status=529 total=\d+ms request_id=req_err_529 error="Overloaded"$/.test(l)), lines.join('\n'));
    assert.ok(lines.some(l => /^\[Anthropic Provider\] attempt 2\/2 stream model=claude-haiku-4-5 outcome=ok ttft=\d+ms last=\d+ms total=\d+ms chunks=2 stop=end_turn tokens=in:10,out:5,cache_read:0 request_id=req_2$/.test(l)), lines.join('\n'));
    assert.ok(lines.some(l => /^\[Anthropic Provider\] request stream answered_by=claude-haiku-4-5 attempts=2 total=\d+ms$/.test(l)), lines.join('\n'));
    for (const line of logs) {
      assert.equal(line.includes('SECRET-ANSWER'), false, line);
      assert.equal(line.includes('SECRET-PROMPT'), false, line);
    }
  });
});

// ---------------------------------------------------------------------------
// chat / generateContent
// ---------------------------------------------------------------------------

describe('chat and generateContent (FR-021)', () => {
  test('joins the text blocks after a thinking block (E36)', async (t) => {
    captureLogs(t);
    script = byModel({
      [A]: { events: [
        ev.start(A), ev.block(0, 'thinking'), ev.thinkingDelta(0), ev.blockStop(0),
        ev.block(1, 'text'), ev.text('Hello ', 1), ev.blockStop(1),
        ev.block(2, 'text'), ev.text('world', 2), ev.blockStop(2), ev.delta('end_turn'), ev.stop(),
      ] },
    });
    const result = await once(A).chat(ask);
    assert.equal(result.content, 'Hello world');
    assert.equal(result._modelUsed, A);
    assert.equal(result.raw.stop_reason, 'end_turn');
  });

  test('every call streams with maxRetries 0, and the caller temperature is not sent', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: httpError(529), [B]: answer(B, 'ok') });
    await once(`${A},${B}`, { temperature: 0.7 }).chat(ask);
    for (const call of calls) {
      assert.equal(call.options.maxRetries, 0);
      assert.equal(call.options.timeout, 15_000);
      assert.equal(call.params.stream, true);
      assert.equal('temperature' in call.params, false);
    }
    assert.equal(calls[1].params.max_tokens, 8192, 'once default');
  });

  test('529 on the first model: the second answers, _modelUsed names it', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: httpError(529), [B]: answer(B, 'from B') });
    const result = await once(`${A},${B}`).chat(ask);
    assert.equal(result.content, 'from B');
    assert.equal(result._modelUsed, B);
  });

  test('a partial answer from a failed attempt is dropped', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: { events: [ev.start(A), ev.block(0, 'text'), ev.text('stale ')], error: streamError() }, [B]: answer(B, 'fresh') });
    assert.equal((await once(`${A},${B}`).chat(ask)).content, 'fresh');
  });

  test('529 twice on the only model: second round, then thrown with userMessage', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: httpError(529, { message: 'Overloaded' }) });
    await assert.rejects(once(A).chat(ask), (err) => {
      assert.equal(err.userMessage, `All Claude models failed (2 attempts, 2 rounds). Last: ${A} — Overloaded`);
      return true;
    });
    assert.equal(calls.length, 2);
  });

  test('400: thrown at once with userMessage', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: httpError(400, { type: 'invalid_request_error', message: 'bad' }), [B]: answer(B, 'unreachable') });
    await assert.rejects(once(`${A},${B}`).chat(ask), (err) => {
      assert.equal(err.status, 400);
      assert.equal(err.userMessage, `${A} — bad`);
      return true;
    });
    assert.deepEqual(calls.map(c => `${c.params.model} ${c.method}`), [`${A} beta`, `${A} messages`]);
  });

  test('refusal: the next model answers', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: stopsWith(A, 'refusal'), [B]: answer(B, 'ok') });
    const result = await once(`${A},${B}`).chat(ask);
    assert.equal(result._modelUsed, B);
  });

  test('logs mode once', async (t) => {
    const logs = captureLogs(t);
    script = byModel({ [A]: answer(A, 'ok') });
    await once(A).chat(ask);
    assert.ok(logs.some(l => l.startsWith(`[Anthropic Provider] attempt 1/1 once model=${A} outcome=ok`)), logs.join('\n'));
    assert.ok(logs.some(l => l.startsWith(`[Anthropic Provider] request once answered_by=${A} attempts=1`)), logs.join('\n'));
  });

  test('generateContent: strings and images as user content, no system (E9)', async (t) => {
    captureLogs(t);
    script = byModel({ [A]: answer(A, 'described') });
    const result = await once(A).generateContent(['You are a helpful assistant.', 'Describe it.', { inlineData: { mimeType: 'image/png', data: 'AAAA' } }]);
    assert.equal(result.response.text(), 'described');
    assert.equal(result._modelUsed, A);
    const { params } = calls[0];
    assert.equal('system' in params, false);
    assert.deepEqual(params.messages, [{ role: 'user', content: [
      { type: 'text', text: 'You are a helpful assistant.' },
      { type: 'text', text: 'Describe it.' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ] }]);
  });
});

/**
 * providerChain.test.js
 *
 * The cross-provider chain (spec 2026-10-12-cross-provider-failover): the
 * pure plan (image order, skip rules, segment timing, messages) and the
 * stream and non-stream paths over fake providers. The fakes record the
 * options each segment receives and replay scripted SSE streams: deltas,
 * _reset, _final_model, [DONE], an error carrying userMessage, an error after
 * text, an end without [DONE], and a hang that records cancel().
 * The real providers over mocked SDKs are in providerChain.integration.test.js.
 * Run: node --test src/features/common/ai/__tests__/providerChain.test.js
 */

'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const health = require('../providers/modelHealth');
const chain = require('../providerChain');
const {
  CHAIN_PROVIDERS,
  FALLBACK_RESERVE_MS,
  DEFAULT_ADAPTERS,
  chainDeadlineMs,
  hasImages,
  orderSegments,
  skipReason,
  segmentTiming,
  failureMessage,
} = chain;

beforeEach(() => {
  health.resetHealth();
});

const seg = (provider, ...models) => ({ provider, models });
const GROQ = seg('groq', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b');
const GROQ_VISION = seg('groq', 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b');
const GEMINI = seg('gemini', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite');
const CLAUDE = seg('anthropic', 'claude-haiku-5-5');
const IMAGE = { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } };

// ---------------------------------------------------------------------------
// Pure plan (T012)
// ---------------------------------------------------------------------------

describe('constants', () => {
  it('chain providers are anthropic, gemini and groq', () => {
    assert.deepEqual([...CHAIN_PROVIDERS].sort(), ['anthropic', 'gemini', 'groq']);
  });

  it('keeps 15 s for the fallback', () => {
    assert.equal(FALLBACK_RESERVE_MS, 15_000);
  });

  it('loading the chain loads no provider SDK', () => {
    const loaded = Object.keys(require.cache).filter(p => /groq-sdk|@anthropic-ai|@google[\\/]/.test(p));
    assert.deepEqual(loaded, []);
  });
});

describe('chainDeadlineMs (FR-010)', () => {
  const cases = [
    [{}, 60_000],
    [{ LLM_CHAIN_DEADLINE_MS: '' }, 60_000],
    [{ LLM_CHAIN_DEADLINE_MS: '  ' }, 60_000],
    [{ LLM_CHAIN_DEADLINE_MS: '0' }, null],
    [{ LLM_CHAIN_DEADLINE_MS: '30000' }, 30_000],
    [{ LLM_CHAIN_DEADLINE_MS: 'abc' }, 60_000],
    [{ LLM_CHAIN_DEADLINE_MS: '-5' }, 60_000],
  ];
  for (const [env, expected] of cases) {
    it(`${JSON.stringify(env)} → ${expected}`, () => assert.equal(chainDeadlineMs(env), expected));
  }

  it('reads process.env by default', () => {
    const before = process.env.LLM_CHAIN_DEADLINE_MS;
    try {
      process.env.LLM_CHAIN_DEADLINE_MS = '12345';
      assert.equal(chainDeadlineMs(), 12_345);
    } finally {
      if (before === undefined) delete process.env.LLM_CHAIN_DEADLINE_MS;
      else process.env.LLM_CHAIN_DEADLINE_MS = before;
    }
  });
});

describe('hasImages (FR-007)', () => {
  it('finds an image_url part in any message', () => {
    assert.equal(hasImages([
      { role: 'system', content: 'sys' },
      { role: 'user', content: [{ type: 'text', text: 'q' }, IMAGE] },
    ]), true);
  });

  it('finds an inlineData part (generateContent)', () => {
    assert.equal(hasImages(['describe', { inlineData: { mimeType: 'image/png', data: 'AAAA' } }]), true);
  });

  it('is false for string content, text parts, empty and missing input', () => {
    assert.equal(hasImages([{ role: 'user', content: 'q' }]), false);
    assert.equal(hasImages([{ role: 'user', content: [{ type: 'text', text: 'q' }] }]), false);
    assert.equal(hasImages(['just text']), false);
    assert.equal(hasImages([]), false);
    assert.equal(hasImages(undefined), false);
  });
});

describe('orderSegments (FR-007, D8)', () => {
  it('keeps the list order without an image', () => {
    const out = orderSegments([GROQ, GEMINI], false, DEFAULT_ADAPTERS);
    assert.deepEqual(out, { segments: [GROQ, GEMINI], reordered: false });
  });

  it('puts Gemini first for an image when the Groq segment has no vision model', () => {
    const out = orderSegments([GROQ, GEMINI], true, DEFAULT_ADAPTERS);
    assert.deepEqual(out, { segments: [GEMINI, GROQ], reordered: true });
  });

  it('keeps a Groq segment that has qwen/qwen3.8-27b first (E25)', () => {
    const out = orderSegments([GROQ_VISION, GEMINI], true, DEFAULT_ADAPTERS);
    assert.deepEqual(out, { segments: [GROQ_VISION, GEMINI], reordered: false });
  });

  it('is stable among image-capable and among blind segments', () => {
    const blind2 = seg('groq', 'openai/gpt-oss-20b');
    const out = orderSegments([GROQ, CLAUDE, blind2, GEMINI], true, DEFAULT_ADAPTERS);
    assert.deepEqual(out.segments, [CLAUDE, GEMINI, GROQ, blind2]);
    assert.equal(out.reordered, true);
  });

  it('returns a new array and leaves the input as it was', () => {
    const input = [GROQ, GEMINI];
    const out = orderSegments(input, true, DEFAULT_ADAPTERS);
    assert.notEqual(out.segments, input);
    assert.deepEqual(input, [GROQ, GEMINI]);
  });
});

describe('skipReason (FR-007, D5, D6)', () => {
  const KEYS = { groq: 'gsk_x', gemini: 'AIza_x', anthropic: 'sk-ant-x' };
  const at = (index, segments, keys = KEYS) => skipReason({ index, segments, keys, isCoolingDown: health.isCoolingDown });
  const cool = (...ids) => { for (const id of ids) health.markFailed(id, 300_000); };

  it('no-key for a missing, null, undefined or empty key', () => {
    assert.equal(at(1, [GROQ, GEMINI], { groq: 'k' }), 'no-key');
    assert.equal(at(1, [GROQ, GEMINI], { groq: 'k', gemini: null }), 'no-key');
    assert.equal(at(1, [GROQ, GEMINI], { groq: 'k', gemini: undefined }), 'no-key');
    assert.equal(at(1, [GROQ, GEMINI], { groq: 'k', gemini: '' }), 'no-key');
    assert.equal(skipReason({ index: 0, segments: [GROQ, GEMINI], keys: undefined, isCoolingDown: health.isCoolingDown }), 'no-key');
  });

  it('null for a healthy segment with a key', () => {
    assert.equal(at(0, [GROQ, GEMINI]), null);
  });

  it('cooling when every model cools down and a later segment has a healthy model', () => {
    cool(...GROQ.models);
    assert.equal(at(0, [GROQ, GEMINI]), 'cooling');
  });

  it('not cooling while one of its models is healthy (E18)', () => {
    cool('openai/gpt-oss-120b');
    assert.equal(at(0, [GROQ, GEMINI]), null);
  });

  it('not cooling when every later segment cools down too (E19, E20)', () => {
    cool(...GROQ.models, ...GEMINI.models);
    assert.equal(at(0, [GROQ, GEMINI]), null);
    assert.equal(at(1, [GROQ, GEMINI]), null);
  });

  it('not cooling when the only healthy later segment has no key', () => {
    cool(...GROQ.models);
    assert.equal(at(0, [GROQ, GEMINI], { groq: 'k' }), null);
  });

  it('cooling when a later healthy segment past a keyless one exists', () => {
    cool(...GROQ.models);
    assert.equal(at(0, [GROQ, CLAUDE, GEMINI], { groq: 'k', gemini: 'g' }), 'cooling');
  });

  it('the last segment is never skipped for cooling', () => {
    cool(...GEMINI.models);
    assert.equal(at(1, [GROQ, GEMINI]), null);
  });

  it('a cooldown that ended no longer counts', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
    for (const id of GROQ.models) health.markFailed(id, 5_000);
    assert.equal(at(0, [GROQ, GEMINI]), 'cooling');
    t.mock.timers.tick(5_000);
    assert.equal(at(0, [GROQ, GEMINI]), null);
  });
});

describe('segmentTiming (FR-009, FR-010, D7)', () => {
  const cases = [
    ['later segment: provider deadline when it fits the reserve',
      { providerDeadlineMs: 45_000, leftMs: 60_000, laterCanRun: true, answerStarted: false },
      { requestDeadlineMs: 45_000 }],
    ['later segment: chain time left minus 15 s when smaller',
      { providerDeadlineMs: 45_000, leftMs: 50_000, laterCanRun: true, answerStarted: false },
      { requestDeadlineMs: 35_000 }],
    ['last segment: all the time left',
      { providerDeadlineMs: 60_000, leftMs: 59_000, laterCanRun: false, answerStarted: false },
      { requestDeadlineMs: 59_000 }],
    ['last segment: its own deadline when smaller',
      { providerDeadlineMs: 45_000, leftMs: 59_000, laterCanRun: false, answerStarted: false },
      { requestDeadlineMs: 45_000 }],
    ['provider deadline disabled (E32): the chain time applies',
      { providerDeadlineMs: null, leftMs: 40_000, laterCanRun: true, answerStarted: false },
      { requestDeadlineMs: 25_000 }],
    ['chain deadline disabled (E31): the provider deadline, no reserve',
      { providerDeadlineMs: 45_000, leftMs: Infinity, laterCanRun: true, answerStarted: false },
      { requestDeadlineMs: 45_000 }],
    ['both disabled: nothing',
      { providerDeadlineMs: null, leftMs: Infinity, laterCanRun: false, answerStarted: false },
      {}],
    ['answer started (E33), last: nothing',
      { providerDeadlineMs: 60_000, leftMs: 5_000, laterCanRun: false, answerStarted: true },
      {}],
    ['answer started, later can run: nothing',
      { providerDeadlineMs: 60_000, leftMs: -1_000, laterCanRun: true, answerStarted: true },
      {}],
  ];
  const defined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  for (const [name, input, expected] of cases) {
    it(name, () => assert.deepEqual(defined(segmentTiming(input)), expected));
  }

  it('skips a segment with no time left when a later one can run (E30)', () => {
    assert.equal(segmentTiming({ providerDeadlineMs: 45_000, leftMs: 10_000, laterCanRun: true, answerStarted: false }).skip, 'deadline');
    assert.equal(segmentTiming({ providerDeadlineMs: 45_000, leftMs: 15_000, laterCanRun: true, answerStarted: false }).skip, 'deadline');
  });

  it('never sets the provider\'s wait before its second round (each keeps its own 2-3 s)', () => {
    for (const laterCanRun of [true, false]) {
      for (const answerStarted of [true, false]) {
        const timing = segmentTiming({ providerDeadlineMs: 45_000, leftMs: 60_000, laterCanRun, answerStarted });
        assert.equal('retryRoundDelayMs' in timing, false);
      }
    }
  });

  it('never skips the last runnable segment', () => {
    assert.equal(segmentTiming({ providerDeadlineMs: 45_000, leftMs: 10_000, laterCanRun: false, answerStarted: false }).skip, undefined);
  });
});

describe('failureMessage (FR-013, D11)', () => {
  const gem = Object.assign(new Error('raw'), { userMessage: 'All Gemini models failed (2 attempts). Last: gemini-3.1-flash-lite — 503' });

  it('one provider ran: its own message, unchanged (E41)', () => {
    assert.equal(failureMessage({ ran: ['groq'], last: gem }), gem.userMessage);
  });

  it('two ran: All providers failed (E40)', () => {
    assert.equal(failureMessage({ ran: ['groq', 'gemini'], last: gem }), `All providers failed (groq → gemini). Last: ${gem.userMessage}`);
  });

  it('three ran, interleaved', () => {
    assert.equal(failureMessage({ ran: ['groq', 'gemini', 'groq'], last: gem }), `All providers failed (groq → gemini → groq). Last: ${gem.userMessage}`);
  });

  it('chain deadline: No answer within (E29)', () => {
    assert.equal(failureMessage({ ran: ['groq', 'gemini'], last: gem, deadlineMs: 60_000 }), `No answer within 60s (groq → gemini). Last: ${gem.userMessage}`);
    assert.equal(failureMessage({ ran: ['groq'], last: gem, deadlineMs: 30_000 }), `No answer within 30s (groq). Last: ${gem.userMessage}`);
  });

  it('a last error without userMessage uses its message (E42)', () => {
    assert.equal(failureMessage({ ran: ['groq', 'gemini'], last: new Error('plain') }), 'All providers failed (groq → gemini). Last: plain');
    assert.equal(failureMessage({ ran: ['groq'], last: new Error('plain') }), 'plain');
  });
});

describe('DEFAULT_ADAPTERS', () => {
  it('cover the three chain providers', () => {
    assert.deepEqual(Object.keys(DEFAULT_ADAPTERS).sort(), ['anthropic', 'gemini', 'groq']);
    for (const [id, a] of Object.entries(DEFAULT_ADAPTERS)) {
      assert.equal(a.id, id);
      for (const fn of ['createStreamingLLM', 'createLLM', 'requestDeadlineMs', 'seesImages', 'firstModel']) assert.equal(typeof a[fn], 'function', `${id}.${fn}`);
    }
  });

  it('read each provider\'s own deadline', () => {
    assert.equal(DEFAULT_ADAPTERS.groq.requestDeadlineMs(), require('../providers/groq').requestDeadlineMs());
    assert.equal(DEFAULT_ADAPTERS.gemini.requestDeadlineMs(), require('../providers/gemini').requestDeadlineMs());
    assert.equal(DEFAULT_ADAPTERS.anthropic.requestDeadlineMs(), require('../providers/anthropic').requestDeadlineMs());
  });

  it('Groq sees images only through a vision model; Gemini and Anthropic always', () => {
    assert.equal(DEFAULT_ADAPTERS.groq.seesImages(GROQ.models), false);
    assert.equal(DEFAULT_ADAPTERS.groq.seesImages(GROQ_VISION.models), true);
    assert.equal(DEFAULT_ADAPTERS.gemini.seesImages(GEMINI.models), true);
    assert.equal(DEFAULT_ADAPTERS.anthropic.seesImages(CLAUDE.models), true);
  });

  it('firstModel is the model the provider will try first (E27)', () => {
    const text = [{ role: 'user', content: 'q' }];
    const image = [{ role: 'user', content: [IMAGE] }];
    assert.equal(DEFAULT_ADAPTERS.groq.firstModel(GROQ_VISION.models, text), 'openai/gpt-oss-120b');
    assert.equal(DEFAULT_ADAPTERS.groq.firstModel(GROQ_VISION.models, image), 'qwen/qwen3.8-27b');
    health.markFailed('gemini-3.5-flash-lite', 60_000);
    assert.equal(DEFAULT_ADAPTERS.gemini.firstModel(GEMINI.models, text), 'gemini-3.1-flash-lite');
    assert.equal(DEFAULT_ADAPTERS.anthropic.firstModel(CLAUDE.models, text), 'claude-haiku-5-5');
  });
});

// ---------------------------------------------------------------------------
// Fake providers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const delta = (text) => sse({ choices: [{ delta: { content: text } }] });
const reset = (next_model, reason = 'transient') => sse({ _reset: true, next_model, reason });
const final = (model) => sse({ _final_model: model });
const DONE = 'data: [DONE]\n\n';
const answer = (model, ...texts) => [...texts.map(delta), final(model), DONE];
const providerErr = (userMessage, message = `raw ${userMessage}`) => Object.assign(new Error(message), { userMessage });

/** A gate a fake waits on: open() lets it go on. */
function gate() {
  let open;
  const promise = new Promise(resolve => { open = resolve; });
  return { promise, open };
}

/**
 * A Response whose body replays `steps`: a string is enqueued as its bytes,
 * { bytes } as is, { wait: ms } pauses, { gate } waits for it, { error }
 * errors the body, { hang: true } waits for cancel(). The body closes after
 * the last step unless it errored or hung. cancel() is recorded on `call`.
 */
function sseResponse(steps, call) {
  const encoder = new TextEncoder();
  let wake = null;
  const body = new ReadableStream({
    async start(controller) {
      for (const step of steps) {
        if (call.cancelled) return;
        if (typeof step === 'string') { controller.enqueue(encoder.encode(step)); continue; }
        if (step.bytes) { controller.enqueue(step.bytes); continue; }
        if (step.wait != null) { await sleep(step.wait); continue; }
        if (step.gate) { await step.gate.promise; continue; }
        if (step.error) {
          // A provider errors after network I/O, once the reader took what was
          // queued (an errored stream drops its queue).
          await new Promise(resolve => setImmediate(resolve));
          if (!call.cancelled) controller.error(step.error);
          return;
        }
        if (step.hang) { await new Promise(resolve => { wake = resolve; }); return; }
      }
      if (!call.cancelled) controller.close();
    },
    cancel() {
      call.cancelled = true;
      wake?.();
    },
  });
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}

/**
 * A fake provider adapter. `plan` scripts it:
 *  - steps: the SSE steps of its stream (sseResponse);
 *  - throwOnCreate: createStreamingLLM / createLLM throws it;
 *  - reject: streamChat rejects with it;
 *  - before(call): awaited inside streamChat / chat / generateContent first;
 *  - once(method, input, call): the chat / generateContent result, or throws.
 * Every call records { opts, messages | input, method, cancelled }.
 */
function fakeProvider(id, plan = {}, { seesImages = true, deadline = 60_000 } = {}) {
  const calls = [];
  const adapter = {
    id,
    requestDeadlineMs: () => deadline,
    seesImages: () => seesImages,
    firstModel: (models) => health.pickModel(models),
    createStreamingLLM: (opts) => {
      const call = { opts, cancelled: false };
      calls.push(call);
      if (plan.throwOnCreate) throw plan.throwOnCreate;
      return {
        streamChat: async (messages) => {
          call.messages = messages;
          if (plan.reject) throw plan.reject;
          if (plan.before) await plan.before(call);
          return sseResponse(plan.steps || [], call);
        },
      };
    },
    createLLM: (opts) => {
      const call = { opts };
      calls.push(call);
      if (plan.throwOnCreate) throw plan.throwOnCreate;
      const run = async (method, input) => {
        call.method = method;
        call.input = input;
        if (plan.before) await plan.before(call);
        return plan.once(method, input, call);
      };
      return { chat: (messages) => run('chat', messages), generateContent: (parts) => run('generateContent', parts) };
    },
  };
  return { adapter, calls };
}

const adaptersOf = (...fakes) => Object.fromEntries(fakes.map(f => [f.adapter.id, f.adapter]));

function parseEvents(raw) {
  return raw.split('\n').filter(l => l.startsWith('data: ')).map((l) => {
    const d = l.slice(6);
    if (d === '[DONE]') return { done: true };
    const json = JSON.parse(d);
    if (json.choices) return { text: json.choices[0].delta.content };
    return json;
  });
}

/** Read the whole stream: { raw, events, text, error }. */
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
  return { raw, events, error, text: events.filter(e => e.text != null).map(e => e.text).join('') };
}

/** Read until an event matches; returns the reader (to cancel it) and the events so far. */
async function readUntil(response, match) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) throw new Error('stream ended before the expected event');
    raw += decoder.decode(value, { stream: true });
    const events = parseEvents(raw.slice(0, raw.lastIndexOf('\n\n') + 2));
    if (events.some(match)) return { reader, events };
  }
}

const resets = (events) => events.filter(e => e._reset);
const MSGS = [{ role: 'system', content: 'You are an assistant.' }, { role: 'user', content: 'What is a mutex?' }];
const KEYS = { groq: 'gsk_test', gemini: 'AIza_test', anthropic: 'sk-ant-test' };
const OPTS = { apiKey: 'gsk_test', model: 'ignored', temperature: 0.7, maxTokens: 900, usePortkey: false };

// Chain log lines, captured (and kept out of the test output).
const logs = [];
for (const level of ['log', 'warn', 'error']) {
  const original = console[level];
  console[level] = (...args) => {
    const line = args.map(String).join(' ');
    if (line.startsWith('[LLM Chain]')) logs.push({ level, line });
    else original.apply(console, args);
  };
}
beforeEach(() => { logs.length = 0; });
const chainLines = (kind) => logs.filter(l => l.line.startsWith(`[LLM Chain] ${kind}`)).map(l => l.line);

/** A streaming chain over fakes; `now` is the test's clock when given. */
function streamingChain({ segments, fakes, keys = KEYS, opts = OPTS, env = {}, now }) {
  return chain.createChainStreamingLLM({ segments, keys, opts, adapters: adaptersOf(...fakes), env, now });
}

// ---------------------------------------------------------------------------
// Stream (T014)
// ---------------------------------------------------------------------------

describe('createChainStreamingLLM: pass-through and switch (FR-008, FR-011)', () => {
  it('segment 1 answers: its events byte for byte, one [DONE], segment 2 never created (E10)', async () => {
    const steps = [reset('openai/gpt-oss-20b'), ...answer('openai/gpt-oss-20b', 'A mutex ', 'is a lock.')];
    const groq = fakeProvider('groq', { steps });
    const gemini = fakeProvider('gemini', { steps: answer('gemini-3.5-flash-lite', 'no') });
    const response = await streamingChain({ segments: [GROQ, GEMINI], fakes: [groq, gemini] }).streamChat(MSGS);
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    const { raw, events, error } = await readAll(response);
    assert.equal(error, null);
    assert.equal(raw, steps.join(''));
    assert.equal(events.filter(e => e.done).length, 1);
    assert.equal(gemini.calls.length, 0);
    assert.deepEqual(groq.calls[0].messages, MSGS);
  });

  it('segment 1 errors before text: one provider _reset naming segment 2\'s first model, then segment 2 (E11)', async () => {
    const groq = fakeProvider('groq', { steps: [reset('openai/gpt-oss-20b'), { error: providerErr('All Groq models failed') }] });
    const gemini = fakeProvider('gemini', { steps: answer('gemini-3.5-flash-lite', 'From Gemini.') });
    const { events, text, error } = await readAll(await streamingChain({ segments: [GROQ, GEMINI], fakes: [groq, gemini] }).streamChat(MSGS));
    assert.equal(error, null);
    assert.equal(text, 'From Gemini.');
    assert.deepEqual(resets(events), [
      { _reset: true, next_model: 'openai/gpt-oss-20b', reason: 'transient' },
      { _reset: true, next_model: 'gemini-3.5-flash-lite', reason: 'provider' },
    ]);
    assert.equal(events.find(e => e._final_model)._final_model, 'gemini-3.5-flash-lite');
    assert.ok(events.at(-1).done);
    assert.equal(events.filter(e => e.done).length, 1);
  });

  it('next_model is the model segment 2 will try first (pickModel)', async () => {
    health.markFailed('gemini-3.5-flash-lite', 60_000);
    const groq = fakeProvider('groq', { steps: [{ error: providerErr('x') }] });
    const gemini = fakeProvider('gemini', { steps: answer('gemini-3.1-flash-lite', 'ok') });
    const { events } = await readAll(await streamingChain({ segments: [GROQ, GEMINI], fakes: [groq, gemini] }).streamChat(MSGS));
    assert.deepEqual(resets(events), [{ _reset: true, next_model: 'gemini-3.1-flash-lite', reason: 'provider' }]);
  });

  it('segment 1 streams text then errors: the text, the provider _reset, then segment 2 (E12)', async () => {
    const groq = fakeProvider('groq', { steps: [delta('partial '), { error: providerErr('cut') }] });
    const gemini = fakeProvider('gemini', { steps: answer('gemini-3.5-flash-lite', 'whole') });
    const { events } = await readAll(await streamingChain({ segments: [GROQ, GEMINI], fakes: [groq, gemini] }).streamChat(MSGS));
    const order = events.map(e => (e.text != null ? `text:${e.text}` : e._reset ? `reset:${e.reason}` : e._final_model ? 'final' : e.done ? 'done' : '?'));
    assert.deepEqual(order, ['text:partial ', 'reset:provider', 'text:whole', 'final', 'done']);
  });

  it('a segment that ends without [DONE] fails (E13)', async () => {
    const groq = fakeProvider('groq', { steps: [delta('half'), final('openai/gpt-oss-120b')] });
    const gemini = fakeProvider('gemini', { steps: answer('gemini-3.5-flash-lite', 'ok') });
    const { events, text } = await readAll(await streamingChain({ segments: [GROQ, GEMINI], fakes: [groq, gemini] }).streamChat(MSGS));
    assert.equal(resets(events).length, 1);
    assert.equal(text, 'halfok');
    assert.equal(events.filter(e => e.done).length, 1);
  });

  it('createStreamingLLM that throws, or streamChat that rejects, fails the segment (E14)', async () => {
    for (const plan of [{ throwOnCreate: new Error('bad options') }, { reject: providerErr('rejected') }]) {
      const groq = fakeProvider('groq', plan);
      const gemini = fakeProvider('gemini', { steps: answer('gemini-3.5-flash-lite', 'ok') });
      const { text, error, events } = await readAll(await streamingChain({ segments: [GROQ, GEMINI], fakes: [groq, gemini] }).streamChat(MSGS));
      assert.equal(error, null);
      assert.equal(text, 'ok');
      assert.equal(resets(events).length, 1);
    }
  });

  it('passes the segment\'s own _resets through before the chain\'s (E15)', async () => {
    const groq = fakeProvider('groq', { steps: [reset('openai/gpt-oss-20b', 'transient'), reset('openai/gpt-oss-120b', 'retry'), { error: providerErr('x') }] });
    const gemini = fakeProvider('gemini', { steps: answer('gemini-3.5-flash-lite', 'ok') });
    const { events } = await readAll(await streamingChain({ segments: [GROQ, GEMINI], fakes: [groq, gemini] }).streamChat(MSGS));
    assert.deepEqual(resets(events).map(e => e.reason), ['transient', 'retry', 'provider']);
  });

  it('reads events split mid-JSON, inside a multi-byte character, and several per chunk', async () => {
    const whole = [delta('héllo '), delta('wörld'), final('openai/gpt-oss-120b'), DONE].join('');
    const bytes = new TextEncoder().encode(whole);
    const inJson = 7;
    const inChar = new TextEncoder().encode(whole.slice(0, whole.indexOf('ö'))).length + 1;
    const steps = [{ bytes: bytes.slice(0, inJson) }, { bytes: bytes.slice(inJson, inChar) }, { bytes: bytes.slice(inChar) }];
    const groq = fakeProvider('groq', { steps });
    const gemini = fakeProvider('gemini', { steps: answer('gemini-3.5-flash-lite', 'no') });
    const { raw, text } = await readAll(await streamingChain({ segments: [GROQ, GEMINI], fakes: [groq, gemini] }).streamChat(MSGS));
    assert.equal(raw, whole);
    assert.equal(text, 'héllo wörld');
    assert.equal(gemini.calls.length, 0);
  });

  it('an interleaved list runs three segments with two switches (E8)', async () => {
    const tail = seg('groq', 'qwen/qwen3.8-27b');
    const groq = fakeProvider('groq', { steps: [{ error: providerErr('groq down') }] });
    const qwen = fakeProvider('groq', { steps: answer('qwen/qwen3.8-27b', 'q') });
    const gemini = fakeProvider('gemini', { steps: [{ error: providerErr('gemini down') }] });
    const byModel = { ...groq.adapter, createStreamingLLM: (opts) => (opts.model === 'qwen/qwen3.8-27b' ? qwen : groq).adapter.createStreamingLLM(opts) };
    const response = await chain.createChainStreamingLLM({ segments: [GROQ, GEMINI, tail], keys: KEYS, opts: OPTS, env: {}, adapters: { groq: byModel, gemini: gemini.adapter } }).streamChat(MSGS);
    const { events, text } = await readAll(response);
    assert.equal(text, 'q');
    assert.deepEqual(resets(events).map(e => e.next_model), ['gemini-3.5-flash-lite', 'qwen/qwen3.8-27b']);
    assert.match(chainLines('request')[0], /segments_run=3 /);
  });
});

describe('createChainStreamingLLM: skips (FR-007, D5, D6)', () => {
  it('skips a segment whose models all cool down: no request, no _reset (E17)', async () => {
    for (const id of GROQ.models) health.markFailed(id, 300_000);
    const groq = fakeProvider('groq', { steps: answer('openai/gpt-oss-120b', 'no') });
    const gemini = fakeProvider('gemini', { steps: answer('gemini-3.5-flash-lite', 'From Gemini.') });
    const { events, text } = await readAll(await streamingChain({ segments: [GROQ, GEMINI], fakes: [groq, gemini] }).streamChat(MSGS));
    assert.equal(groq.calls.length, 0);
    assert.equal(text, 'From Gemini.');
    assert.deepEqual(resets(events), []);
    assert.match(chainLines('segment 1/2')[0], /provider=groq .*outcome=skipped-cooling$/);
  });

  it('runs every segment in order when all cool down (E19)', async () => {
    for (const id of [...GROQ.models, ...GEMINI.models]) health.markFailed(id, 300_000);
    const groq = fakeProvider('groq', { steps: answer('openai/gpt-oss-120b', 'Groq anyway') });
    const gemini = fakeProvider('gemini', { steps: answer('gemini-3.5-flash-lite', 'no') });
    const { text } = await readAll(await streamingChain({ segments: [GROQ, GEMINI], fakes: [groq, gemini] }).streamChat(MSGS));
    assert.equal(text, 'Groq anyway');
    assert.equal(gemini.calls.length, 0);
  });

  it('skips a segment with no key; when segment 1 then fails the user reads its own message (E21, E41)', async () => {
    const groq = fakeProvider('groq', { steps: [{ error: providerErr('All Groq models failed (3 attempts). Last: x') }] });
    const gemini = fakeProvider('gemini', { steps: answer('gemini-3.5-flash-lite', 'no') });
    const { error, events } = await readAll(await streamingChain({ segments: [GROQ, GEMINI], fakes: [groq, gemini], keys: { groq: 'gsk_test', gemini: null } }).streamChat(MSGS));
    assert.equal(gemini.calls.length, 0);
    assert.equal(error.userMessage, 'All Groq models failed (3 attempts). Last: x');
    assert.deepEqual(resets(events), []);
    assert.match(chainLines('segment 2/2')[0], /provider=gemini .*outcome=skipped-no-key$/);
  });

  it('without keys the first provider uses opts.apiKey and the others are skipped (E3)', async () => {
    const groq = fakeProvider('groq', { steps: [{ error: providerErr('groq failed') }] });
    const gemini = fakeProvider('gemini', { steps: answer('gemini-3.5-flash-lite', 'no') });
    const llm = chain.createChainStreamingLLM({ segments: [GROQ, GEMINI], keys: undefined, opts: OPTS, adapters: adaptersOf(groq, gemini), env: {} });
    const { error } = await readAll(await llm.streamChat(MSGS));
    assert.equal(groq.calls[0].opts.apiKey, 'gsk_test');
    assert.equal(gemini.calls.length, 0);
    assert.equal(error.userMessage, 'groq failed');
  });
});

describe('createChainStreamingLLM: options per segment (FR-009, E34-E36)', () => {
  it('each segment gets its own key, its models, no keys, and its timing', async () => {
    let clock = 0;
    const groq = fakeProvider('groq', { steps: [{ error: providerErr('x') }], before: () => { clock += 20_000; } }, { deadline: 45_000 });
    const gemini = fakeProvider('gemini', { steps: answer('gemini-3.5-flash-lite', 'ok') }, { deadline: 60_000 });
    await readAll(await streamingChain({ segments: [GROQ, GEMINI], fakes: [groq, gemini], opts: { ...OPTS, keys: { groq: 'leak' } }, now: () => clock }).streamChat(MSGS));
    assert.deepEqual(groq.calls[0].opts, {
      apiKey: 'gsk_test', model: 'openai/gpt-oss-120b,openai/gpt-oss-20b', temperature: 0.7, maxTokens: 900, usePortkey: false,
      requestDeadlineMs: 45_000,
    });
    assert.deepEqual(gemini.calls[0].opts, {
      apiKey: 'AIza_test', model: 'gemini-3.5-flash-lite,gemini-3.1-flash-lite', temperature: 0.7, maxTokens: 900, usePortkey: false,
      requestDeadlineMs: 40_000,
    });
  });

  it('cuts a non-last segment to the time left minus 15 s (E28)', async () => {
    let clock = 0;
    const claude = fakeProvider('anthropic', { steps: [{ error: providerErr('x') }], before: () => { clock += 30_000; } });
    const groq = fakeProvider('groq', { steps: [{ error: providerErr('y') }], before: () => { clock += 10_000; } }, { deadline: 45_000 });
    const gemini = fakeProvider('gemini', { steps: answer('gemini-3.5-flash-lite', 'ok') });
    await readAll(await streamingChain({ segments: [CLAUDE, GROQ, GEMINI], fakes: [claude, groq, gemini], now: () => clock }).streamChat(MSGS));
    assert.equal(claude.calls[0].opts.requestDeadlineMs, 45_000);
    assert.equal(groq.calls[0].opts.requestDeadlineMs, 15_000);
    assert.equal(gemini.calls[0].opts.requestDeadlineMs, 20_000);
    for (const fake of [claude, groq, gemini]) assert.equal('retryRoundDelayMs' in fake.calls[0].opts, false, `${fake.adapter.id} keeps its own round wait`);
  });

  it('skips a non-last segment with no time left; the last runs with what is left (E30)', async () => {
    let clock = 0;
    const claude = fakeProvider('anthropic', { steps: [{ error: providerErr('x') }], before: () => { clock += 50_000; } });
    const groq = fakeProvider('groq', { steps: answer('openai/gpt-oss-120b', 'no') });
    const gemini = fakeProvider('gemini', { steps: answer('gemini-3.5-flash-lite', 'ok') });
    const { events, text } = await readAll(await streamingChain({ segments: [CLAUDE, GROQ, GEMINI], fakes: [claude, groq, gemini], now: () => clock }).streamChat(MSGS));
    assert.equal(text, 'ok');
    assert.equal(groq.calls.length, 0);
    assert.equal(gemini.calls[0].opts.requestDeadlineMs, 10_000);
    assert.deepEqual(resets(events).map(e => e.next_model), ['gemini-3.5-flash-lite']);
    assert.match(chainLines('segment 2/3')[0], /outcome=skipped-deadline$/);
  });

  it('starts no segment once the chain deadline passed (E29)', async () => {
    let clock = 0;
    const groq = fakeProvider('groq', { steps: [{ error: providerErr('Groq timed out') }], before: () => { clock += 30_000; } }, { deadline: 45_000 });
    const gemini = fakeProvider('gemini', { steps: [{ error: providerErr('Gemini timed out') }], before: () => { clock += 31_000; } });
    const claude = fakeProvider('anthropic', { steps: answer('claude-haiku-5-5', 'no') });
    const { error } = await readAll(await streamingChain({ segments: [GROQ, GEMINI, CLAUDE], fakes: [groq, gemini, claude], now: () => clock }).streamChat(MSGS));
    assert.equal(claude.calls.length, 0);
    assert.equal(gemini.calls[0].opts.requestDeadlineMs, 15_000);
    assert.equal(error.userMessage, 'No answer within 60s (groq → gemini). Last: Gemini timed out');
  });

  it('LLM_CHAIN_DEADLINE_MS=0: segments keep their own deadline, no reserve (E31)', async () => {
    let clock = 0;
    const groq = fakeProvider('groq', { steps: [{ error: providerErr('x') }], before: () => { clock += 100_000; } }, { deadline: 45_000 });
    const gemini = fakeProvider('gemini', { steps: answer('gemini-3.5-flash-lite', 'ok') }, { deadline: 60_000 });
    const { text } = await readAll(await streamingChain({ segments: [GROQ, GEMINI], fakes: [groq, gemini], env: { LLM_CHAIN_DEADLINE_MS: '0' }, now: () => clock }).streamChat(MSGS));
    assert.equal(text, 'ok');
    assert.equal(groq.calls[0].opts.requestDeadlineMs, 45_000);
    assert.equal(gemini.calls[0].opts.requestDeadlineMs, 60_000);
  });

  it('once text was forwarded, the next segment runs with no chain deadline (E33)', async () => {
    let clock = 0;
    const groq = fakeProvider('groq', { steps: [delta('started'), { error: providerErr('cut') }], before: () => { clock += 70_000; } });
    const gemini = fakeProvider('gemini', { steps: answer('gemini-3.5-flash-lite', 'ok') });
    const { text } = await readAll(await streamingChain({ segments: [GROQ, GEMINI], fakes: [groq, gemini], now: () => clock }).streamChat(MSGS));
    assert.equal(text, 'startedok');
    assert.equal('requestDeadlineMs' in gemini.calls[0].opts, false);
  });
});

describe('createChainStreamingLLM: when every segment fails (FR-013)', () => {
  it('two ran: All providers failed, naming the last provider\'s message (E40)', async () => {
    const groq = fakeProvider('groq', { steps: [{ error: providerErr('All Groq models failed (3 attempts). Last: openai/gpt-oss-20b — rate limit') }] });
    const gemini = fakeProvider('gemini', { steps: [{ error: providerErr('All Gemini models failed (2 attempts). Last: gemini-3.1-flash-lite — 503') }] });
    const { error, events } = await readAll(await streamingChain({ segments: [GROQ, GEMINI], fakes: [groq, gemini] }).streamChat(MSGS));
    assert.equal(error.userMessage, 'All providers failed (groq → gemini). Last: All Gemini models failed (2 attempts). Last: gemini-3.1-flash-lite — 503');
    assert.equal(error.message, 'raw All Gemini models failed (2 attempts). Last: gemini-3.1-flash-lite — 503');
    assert.equal(resets(events).length, 1);
    assert.equal(events.some(e => e.done), false);
  });

  it('a last segment that ends without [DONE] still gives a readable message (E42)', async () => {
    const groq = fakeProvider('groq', { steps: [{ error: providerErr('x') }] });
    const gemini = fakeProvider('gemini', { steps: [delta('half')] });
    const { error } = await readAll(await streamingChain({ segments: [GROQ, GEMINI], fakes: [groq, gemini] }).streamChat(MSGS));
    assert.match(error.userMessage, /^All providers failed \(groq → gemini\)\. Last: .+/);
  });
});

describe('createChainStreamingLLM: images (FR-007, D8)', () => {
  it('tries the segment that sees images first and logs order=images-first (E24)', async () => {
    const msgs = [{ role: 'user', content: [{ type: 'text', text: 'what is on screen?' }, IMAGE] }];
    const groq = fakeProvider('groq', { steps: answer('openai/gpt-oss-120b', 'blind') }, { seesImages: false });
    const gemini = fakeProvider('gemini', { steps: answer('gemini-3.5-flash-lite', 'I see it') });
    const { text } = await readAll(await streamingChain({ segments: [GROQ, GEMINI], fakes: [groq, gemini] }).streamChat(msgs));
    assert.equal(text, 'I see it');
    assert.equal(groq.calls.length, 0);
    assert.deepEqual(gemini.calls[0].messages, msgs);
    assert.match(chainLines('segment 1/2')[0], /provider=gemini/);
    assert.match(chainLines('request')[0], / order=images-first$/);
  });

  it('keeps the list order without an image', async () => {
    const groq = fakeProvider('groq', { steps: answer('openai/gpt-oss-120b', 'Groq') }, { seesImages: false });
    const gemini = fakeProvider('gemini', { steps: answer('gemini-3.5-flash-lite', 'no') });
    const { text } = await readAll(await streamingChain({ segments: [GROQ, GEMINI], fakes: [groq, gemini] }).streamChat(MSGS));
    assert.equal(text, 'Groq');
    assert.doesNotMatch(chainLines('request')[0], /order=/);
  });
});

describe('createChainStreamingLLM: cancel (FR-012, SC-004)', () => {
  it('cancelling during segment 1 cancels its body at once; segment 2 is never created; no error (E37)', async () => {
    const groq = fakeProvider('groq', { steps: [delta('thinking '), { hang: true }] });
    const gemini = fakeProvider('gemini', { steps: answer('gemini-3.5-flash-lite', 'no') });
    const response = await streamingChain({ segments: [GROQ, GEMINI], fakes: [groq, gemini] }).streamChat(MSGS);
    const { reader } = await readUntil(response, e => e.text === 'thinking ');
    const cancelling = reader.cancel();
    assert.equal(groq.calls[0].cancelled, true, 'cancelled within the same turn');
    await cancelling;
    await sleep(10);
    assert.equal(gemini.calls.length, 0);
    assert.match(chainLines('segment 1/2')[0], /outcome=cancelled total=\d+ms$/);
    assert.match(chainLines('request')[0], / cancelled$/);
  });

  it('cancelling while segment 2\'s streamChat is pending cancels its body on arrival; nothing else starts (E38)', async () => {
    const opened = gate();
    const groq = fakeProvider('groq', { steps: [{ error: providerErr('x') }] });
    const gemini = fakeProvider('gemini', { steps: [delta('late'), { hang: true }], before: () => opened.promise });
    const claude = fakeProvider('anthropic', { steps: answer('claude-haiku-5-5', 'no') });
    const response = await streamingChain({ segments: [GROQ, GEMINI, CLAUDE], fakes: [groq, gemini, claude] }).streamChat(MSGS);
    const { reader } = await readUntil(response, e => e._reset && e.reason === 'provider');
    await reader.cancel();
    opened.open();
    await sleep(10);
    assert.equal(gemini.calls[0].cancelled, true);
    assert.equal(claude.calls.length, 0);
    assert.match(chainLines('request')[0], / cancelled$/);
  });

  it('a segment that keeps writing after cancel raises nothing (E39)', async () => {
    const opened = gate();
    const groq = fakeProvider('groq', { steps: [delta('a'), { gate: opened }, delta('b'), ...answer('openai/gpt-oss-120b')] });
    const response = await streamingChain({ segments: [GROQ, GEMINI], fakes: [groq, fakeProvider('gemini')] }).streamChat(MSGS);
    const { reader } = await readUntil(response, e => e.text === 'a');
    await reader.cancel();
    opened.open();
    await sleep(10);
    assert.equal(groq.calls[0].cancelled, true);
    assert.equal(chainLines('request').length, 1);
  });
});

describe('createChainStreamingLLM: logs (FR-015, C3, C4)', () => {
  it('one line per segment whose turn came and one request line; no text and no key', async () => {
    const groq = fakeProvider('groq', { steps: [delta('SECRET PARTIAL'), { error: providerErr('All Groq models failed (3 attempts). Last: x') }] });
    const gemini = fakeProvider('gemini', { steps: answer('gemini-3.5-flash-lite', 'SECRET ANSWER') });
    const claude = fakeProvider('anthropic', { steps: answer('claude-haiku-5-5', 'no') });
    const msgs = [{ role: 'user', content: 'SECRET PROMPT' }];
    const keys = { groq: 'gsk_SECRET', gemini: 'AIza_SECRET', anthropic: 'sk-ant-SECRET' };
    await readAll(await streamingChain({ segments: [GROQ, GEMINI, CLAUDE], fakes: [groq, gemini, claude], keys, opts: { ...OPTS, apiKey: 'gsk_SECRET' } }).streamChat(msgs));
    const segments = chainLines('segment');
    assert.equal(segments.length, 2, 'segment 3 never had its turn');
    assert.match(segments[0], /^\[LLM Chain\] segment 1\/3 stream provider=groq models=openai\/gpt-oss-120b,openai\/gpt-oss-20b outcome=failed total=\d+ms error="All Groq models failed \(3 attempts\)\. Last: x"$/);
    assert.match(segments[1], /^\[LLM Chain\] segment 2\/3 stream provider=gemini models=gemini-3\.5-flash-lite,gemini-3\.1-flash-lite outcome=ok answered_by=gemini-3\.5-flash-lite total=\d+ms$/);
    assert.match(chainLines('request')[0], /^\[LLM Chain\] request stream answered_by=gemini-3\.5-flash-lite provider=gemini segments_run=2 total=\d+ms$/);
    for (const { line } of logs) assert.doesNotMatch(line, /SECRET/);
  });

  it('the request line on failure reads answered_by=none provider=none, as a warning', async () => {
    const groq = fakeProvider('groq', { steps: [{ error: providerErr('x') }] });
    const gemini = fakeProvider('gemini', { steps: [{ error: providerErr('y') }] });
    await readAll(await streamingChain({ segments: [GROQ, GEMINI], fakes: [groq, gemini] }).streamChat(MSGS));
    assert.match(chainLines('request')[0], /^\[LLM Chain\] request stream answered_by=none provider=none segments_run=2 total=\d+ms$/);
    assert.equal(logs.find(l => l.line.startsWith('[LLM Chain] request')).level, 'warn');
  });
});

// ---------------------------------------------------------------------------
// Non-stream (T016)
// ---------------------------------------------------------------------------

/** A non-streaming chain over fakes. */
function onceChain({ segments, fakes, keys = KEYS, opts = OPTS, env = {}, now }) {
  return chain.createChainLLM({ segments, keys, opts, adapters: adaptersOf(...fakes), env, now });
}

const chatResult = (model, content) => ({ content, raw: { model, choices: [{ message: { content } }] }, _modelUsed: model });

describe('createChainLLM (FR-014)', () => {
  it('segment 1 answers: its chat() result unchanged; segment 2 never created', async () => {
    const result = chatResult('openai/gpt-oss-120b', 'Insights from Groq');
    const groq = fakeProvider('groq', { once: () => result });
    const gemini = fakeProvider('gemini', { once: () => chatResult('gemini-3.5-flash-lite', 'no') });
    const out = await onceChain({ segments: [GROQ, GEMINI], fakes: [groq, gemini] }).chat(MSGS);
    assert.equal(out, result);
    assert.equal(gemini.calls.length, 0);
    assert.equal(groq.calls[0].method, 'chat');
    assert.deepEqual(groq.calls[0].input, MSGS);
  });

  it('segment 1 throws: segment 2\'s chat() result (E43)', async () => {
    const result = chatResult('gemini-3.5-flash-lite', 'Insights from Gemini');
    const groq = fakeProvider('groq', { once: () => { throw providerErr('All Groq models failed (3 attempts). Last: rate limit'); } });
    const gemini = fakeProvider('gemini', { once: () => result });
    const out = await onceChain({ segments: [GROQ, GEMINI], fakes: [groq, gemini] }).chat(MSGS);
    assert.equal(out, result);
    assert.deepEqual(gemini.calls[0].input, MSGS);
  });

  it('createLLM that throws fails the segment', async () => {
    const groq = fakeProvider('groq', { throwOnCreate: new Error('cannot load') });
    const gemini = fakeProvider('gemini', { once: () => chatResult('gemini-3.5-flash-lite', 'ok') });
    const out = await onceChain({ segments: [GROQ, GEMINI], fakes: [groq, gemini] }).chat(MSGS);
    assert.equal(out.content, 'ok');
  });

  it('every segment throws: the FR-013 error (E44)', async () => {
    const groq = fakeProvider('groq', { once: () => { throw providerErr('groq failed'); } });
    const geminiErr = Object.assign(new Error('[503 Service Unavailable] high demand'), { status: 503 });
    const gemini = fakeProvider('gemini', { once: () => { throw geminiErr; } });
    await assert.rejects(onceChain({ segments: [GROQ, GEMINI], fakes: [groq, gemini] }).chat(MSGS), (err) => {
      assert.equal(err, geminiErr);
      assert.equal(err.userMessage, 'All providers failed (groq → gemini). Last: [503 Service Unavailable] high demand');
      return true;
    });
  });

  it('generateContent with inlineData tries the segment that sees images first (E26)', async () => {
    const parts = ['describe the screen', { inlineData: { mimeType: 'image/png', data: 'AAAA' } }];
    const result = { response: { text: () => 'a screen' }, _modelUsed: 'gemini-3.5-flash-lite' };
    const groq = fakeProvider('groq', { once: () => ({ response: { text: () => 'blind' } }) }, { seesImages: false });
    const gemini = fakeProvider('gemini', { once: () => result });
    const out = await onceChain({ segments: [GROQ, GEMINI], fakes: [groq, gemini] }).generateContent(parts);
    assert.equal(out, result);
    assert.equal(groq.calls.length, 0);
    assert.equal(gemini.calls[0].method, 'generateContent');
    assert.deepEqual(gemini.calls[0].input, parts);
    assert.match(chainLines('request')[0], /^\[LLM Chain\] request once answered_by=gemini-3\.5-flash-lite provider=gemini segments_run=1 total=\d+ms order=images-first$/);
  });

  it('skips a cooling segment and a keyless one, as the stream path does', async () => {
    for (const id of GROQ.models) health.markFailed(id, 300_000);
    const groq = fakeProvider('groq', { once: () => chatResult('openai/gpt-oss-120b', 'no') });
    const claude = fakeProvider('anthropic', { once: () => chatResult('claude-haiku-5-5', 'no') });
    const gemini = fakeProvider('gemini', { once: () => chatResult('gemini-3.5-flash-lite', 'ok') });
    const out = await onceChain({ segments: [GROQ, CLAUDE, GEMINI], fakes: [groq, claude, gemini], keys: { groq: 'gsk_test', gemini: 'AIza_test' } }).chat(MSGS);
    assert.equal(out.content, 'ok');
    assert.equal(groq.calls.length, 0);
    assert.equal(claude.calls.length, 0);
    const lines = chainLines('segment');
    assert.match(lines[0], /^\[LLM Chain\] segment 1\/3 once provider=groq .*outcome=skipped-cooling$/);
    assert.match(lines[1], /^\[LLM Chain\] segment 2\/3 once provider=anthropic .*outcome=skipped-no-key$/);
    assert.match(lines[2], /^\[LLM Chain\] segment 3\/3 once provider=gemini .*outcome=ok answered_by=gemini-3\.5-flash-lite total=\d+ms$/);
  });

  it('gives each segment its own key, its models, no keys, and its timing', async () => {
    let clock = 0;
    const groq = fakeProvider('groq', { once: () => { throw providerErr('x'); }, before: () => { clock += 20_000; } }, { deadline: 45_000 });
    const gemini = fakeProvider('gemini', { once: () => chatResult('gemini-3.5-flash-lite', 'ok') });
    await onceChain({ segments: [GROQ, GEMINI], fakes: [groq, gemini], opts: { ...OPTS, keys: KEYS }, now: () => clock }).chat(MSGS);
    assert.deepEqual(groq.calls[0].opts, {
      apiKey: 'gsk_test', model: 'openai/gpt-oss-120b,openai/gpt-oss-20b', temperature: 0.7, maxTokens: 900, usePortkey: false,
      requestDeadlineMs: 45_000,
    });
    assert.deepEqual(gemini.calls[0].opts, {
      apiKey: 'AIza_test', model: 'gemini-3.5-flash-lite,gemini-3.1-flash-lite', temperature: 0.7, maxTokens: 900, usePortkey: false,
      requestDeadlineMs: 40_000,
    });
  });

  it('starts no segment once the chain deadline passed', async () => {
    let clock = 0;
    const groq = fakeProvider('groq', { once: () => { throw providerErr('Groq timed out'); }, before: () => { clock += 61_000; } });
    const gemini = fakeProvider('gemini', { once: () => chatResult('gemini-3.5-flash-lite', 'no') });
    await assert.rejects(onceChain({ segments: [GROQ, GEMINI], fakes: [groq, gemini], now: () => clock }).chat(MSGS), { userMessage: 'No answer within 60s (groq). Last: Groq timed out' });
    assert.equal(gemini.calls.length, 0);
  });

  it('logs a failed segment with its message and the request as once; no text, no key', async () => {
    const groq = fakeProvider('groq', { once: () => { throw providerErr('All Groq models failed (3 attempts). Last: x'); } });
    const gemini = fakeProvider('gemini', { once: () => chatResult('gemini-3.5-flash-lite', 'SECRET ANSWER') });
    await onceChain({ segments: [GROQ, GEMINI], fakes: [groq, gemini], keys: { groq: 'gsk_SECRET', gemini: 'AIza_SECRET' } }).chat([{ role: 'user', content: 'SECRET PROMPT' }]);
    assert.match(chainLines('segment 1/2')[0], /outcome=failed total=\d+ms error="All Groq models failed \(3 attempts\)\. Last: x"$/);
    assert.match(chainLines('request')[0], /^\[LLM Chain\] request once answered_by=gemini-3\.5-flash-lite provider=gemini segments_run=2 total=\d+ms$/);
    for (const { line } of logs) assert.doesNotMatch(line, /SECRET/);
  });

  it('a result without _modelUsed is logged with the segment\'s first model', async () => {
    const groq = fakeProvider('groq', { once: () => ({ content: 'ok', raw: null }) });
    await onceChain({ segments: [GROQ, GEMINI], fakes: [groq, fakeProvider('gemini')] }).chat(MSGS);
    assert.match(chainLines('request')[0], /answered_by=openai\/gpt-oss-120b provider=groq /);
  });
});

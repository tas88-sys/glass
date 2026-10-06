/**
 * gemini.test.js
 *
 * Integration tests for gemini.js failover loop (non-streaming + streaming).
 * Test runner: node:test (Node 18+ built-in)
 *
 * Mocks @google/generative-ai and @google/genai with scripted responses.
 * Run: node --test src/features/common/ai/providers/__tests__/gemini.test.js
 */

'use strict';

const { describe, it, beforeEach, mock, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

// ---------------------------------------------------------------------------
// Module mock helpers
// ---------------------------------------------------------------------------

// We override Module._resolveFilename to intercept require('@google/generative-ai')
// This is simpler than jest.mock and works with node:test.

let mockGenerateContent = null;
let mockSendMessage = null;
let mockGenerateContentStream = null;

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === '@google/generative-ai') {
    return {
      GoogleGenerativeAI: class {
        constructor(apiKey) { this.apiKey = apiKey; }
        getGenerativeModel({ model }) {
          return {
            _model: model,
            generateContent: async (...args) => mockGenerateContent(model, ...args),
            startChat: (opts) => ({
              sendMessage: async (...args) => mockSendMessage(model, ...args),
            }),
            generateContentStream: async (...args) => mockGenerateContentStream(model, ...args),
          };
        }
      }
    };
  }
  if (request === '@google/genai') {
    return { GoogleGenAI: class { constructor() {} } };
  }
  return originalLoad.apply(this, arguments);
};

// Clear require cache for gemini.js and rotator before loading
function clearCache() {
  const keys = Object.keys(require.cache).filter(k =>
    k.includes('gemini.js') ||
    k.includes('geminiModelRotator')
  );
  keys.forEach(k => delete require.cache[k]);
}

clearCache();

const rotator = require('../geminiModelRotator');
const { createLLM, createStreamingLLM, firstChunkTimeoutMs, hedgeDelayMs, requestDeadlineMs } = require('../gemini');

// ---------------------------------------------------------------------------
// Reset state before each test
// ---------------------------------------------------------------------------
beforeEach(() => {
  rotator.resetHealth();
  mockGenerateContent = null;
  mockSendMessage = null;
  mockGenerateContentStream = null;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeSuccessGenerateContent(text = 'hello') {
  return async (modelId) => ({
    response: { text: () => text },
  });
}

function makeError(status, message = 'error') {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * Collect all chunks emitted by a ReadableStream Response into an array of
 * decoded string segments (SSE lines).
 */
async function collectStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(decoder.decode(value));
  }
  return chunks.join('');
}

function parseSseEvents(raw) {
  return raw
    .split('\n')
    .filter(l => l.startsWith('data: '))
    .map(l => {
      const d = l.slice(6);
      if (d === '[DONE]') return { _done: true };
      try { return JSON.parse(d); } catch { return d; }
    });
}

// ---------------------------------------------------------------------------
// createLLM — non-streaming failover
// ---------------------------------------------------------------------------
describe('createLLM failover (non-streaming)', () => {
  it('success on first model — returns _modelUsed === first model', async () => {
    mockGenerateContent = async (modelId) => ({
      response: { text: () => 'ok' },
    });

    const llm = createLLM({ apiKey: 'test', model: 'modelA,modelB' });
    const result = await llm.generateContent(['hello']);
    assert.equal(result._modelUsed, 'modelA');
    assert.equal(result.response.text(), 'ok');
  });

  it('429 on first, success on second — _modelUsed === second model', async () => {
    let calls = 0;
    mockGenerateContent = async (modelId) => {
      calls++;
      if (modelId === 'modelA') throw makeError(429);
      return { response: { text: () => 'fallback' } };
    };

    const llm = createLLM({ apiKey: 'test', model: 'modelA,modelB' });
    const result = await llm.generateContent(['hello']);
    assert.equal(result._modelUsed, 'modelB');
    assert.equal(calls, 2);
  });

  it('429 on all models — throws last error', async () => {
    mockGenerateContent = async (modelId) => { throw makeError(429, 'quota'); };
    const llm = createLLM({ apiKey: 'test', model: 'modelA,modelB' });
    await assert.rejects(() => llm.generateContent(['hello']), /quota/i);
  });

  it('400 on first — throws immediately, second never called', async () => {
    let callCount = 0;
    mockGenerateContent = async (modelId) => {
      callCount++;
      if (modelId === 'modelA') throw makeError(400, 'bad model');
      return { response: { text: () => 'should not reach' } };
    };
    const llm = createLLM({ apiKey: 'test', model: 'modelA,modelB' });
    await assert.rejects(() => llm.generateContent(['hello']), /bad model/i);
    assert.equal(callCount, 1, 'second model must not be called on fatal-request');
  });

  it('401 on first — throws immediately, second never called', async () => {
    let callCount = 0;
    mockGenerateContent = async (modelId) => {
      callCount++;
      if (modelId === 'modelA') throw makeError(401, 'unauthorized');
      return { response: { text: () => 'unreachable' } };
    };
    const llm = createLLM({ apiKey: 'test', model: 'modelA,modelB' });
    await assert.rejects(() => llm.generateContent(['hello']), /unauthorized/i);
    assert.equal(callCount, 1);
  });
});

// ---------------------------------------------------------------------------
// createStreamingLLM — streaming failover
// ---------------------------------------------------------------------------

/**
 * Helper to build an async iterable stream of chunks
 */
function makeStream(...chunks) {
  return {
    stream: (async function*() {
      for (const c of chunks) yield c;
    })(),
  };
}

/**
 * Build a chunk with .text() method
 */
function chunk(text) {
  return { text: () => text };
}

/**
 * Build a stream that yields some chunks then throws
 */
function makeStreamWithError(chunks, err) {
  return {
    stream: (async function*() {
      for (const c of chunks) yield c;
      throw err;
    })(),
  };
}

describe('createStreamingLLM failover (streaming)', () => {
  it('503 mid-stream triggers _reset, second model streams cleanly, _final_model + [DONE]', async () => {
    let callCount = 0;
    mockGenerateContentStream = async (modelId) => {
      callCount++;
      if (modelId === 'modelA') {
        return makeStreamWithError([chunk('hello '), chunk('world')], makeError(503, 'service unavailable'));
      }
      return makeStream(chunk('fallback response'));
    };

    const llm = createStreamingLLM({ apiKey: 'test', model: 'modelA,modelB' });
    const response = await llm.streamChat([{ role: 'user', content: 'hi' }]);
    const raw = await collectStream(response);
    const events = parseSseEvents(raw);

    // Find _reset sentinel
    const resetEvent = events.find(e => e._reset);
    assert.ok(resetEvent, '_reset sentinel must be emitted');
    assert.equal(resetEvent.next_model, 'modelB');

    // Find _final_model sentinel
    const finalEvent = events.find(e => e._final_model);
    assert.ok(finalEvent, '_final_model sentinel must be emitted');
    assert.equal(finalEvent._final_model, 'modelB');

    // [DONE] must be last non-sentinel event
    const doneEvent = events[events.length - 1];
    assert.ok(doneEvent._done, '[DONE] must be the last event');

    assert.equal(callCount, 2);
  });

  it('all models fail streaming — controller.error() called (not thrown to outer scope)', async () => {
    mockGenerateContentStream = async (modelId) => {
      return makeStreamWithError([chunk('partial')], makeError(503, 'all fail'));
    };

    const llm = createStreamingLLM({ apiKey: 'test', model: 'modelA,modelB', retryRoundDelayMs: 0 });
    const response = await llm.streamChat([{ role: 'user', content: 'hi' }]);

    // When controller.error() is called, reading from the stream should throw
    const reader = response.body.getReader();
    let errorThrown = false;
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch (e) {
      errorThrown = true;
    }
    assert.ok(errorThrown, 'Stream reader should throw when controller.error() is called');
  });

  it('single model success — _final_model emitted, no _reset', async () => {
    mockGenerateContentStream = async (modelId) => makeStream(chunk('single model response'));

    const llm = createStreamingLLM({ apiKey: 'test', model: 'gemini-2.5-flash' });
    const response = await llm.streamChat([{ role: 'user', content: 'hello' }]);
    const raw = await collectStream(response);
    const events = parseSseEvents(raw);

    assert.ok(!events.some(e => e._reset), 'No _reset should be emitted on success');
    const finalEvent = events.find(e => e._final_model);
    assert.ok(finalEvent, '_final_model must be emitted');
    assert.equal(finalEvent._final_model, 'gemini-2.5-flash');
  });

  it('fatal error (400) — surfaces immediately, second model never called', async () => {
    let callCount = 0;
    mockGenerateContentStream = async (modelId) => {
      callCount++;
      return makeStreamWithError([], makeError(400, 'bad request'));
    };

    const llm = createStreamingLLM({ apiKey: 'test', model: 'modelA,modelB' });
    const response = await llm.streamChat([{ role: 'user', content: 'hi' }]);
    const reader = response.body.getReader();

    let caughtError = false;
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      caughtError = true;
    }
    assert.ok(caughtError, 'Fatal error must propagate to stream consumer');
    assert.equal(callCount, 1, 'Second model must not be called on fatal-request error');
  });
});

// ---------------------------------------------------------------------------
// Per-attempt diagnostics logging
// ---------------------------------------------------------------------------
describe('attempt logging', () => {
  let lines;
  beforeEach(() => {
    lines = [];
    const capture = (...args) => { lines.push(args.map(String).join(' ')); };
    mock.method(console, 'log', capture);
    mock.method(console, 'warn', capture);
    mock.method(console, 'error', capture);
  });
  afterEach(() => mock.restoreAll());

  const find = (re) => lines.find(l => re.test(l));

  it('streaming: logs the failed attempt, the answering attempt with ttft/tokens, and a request summary', async () => {
    mockGenerateContentStream = async (modelId) => {
      if (modelId === 'modelA') return makeStreamWithError([], makeError(503, 'service unavailable'));
      const last = chunk('done');
      last.usageMetadata = { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 7 };
      return makeStream(chunk('partial '), last);
    };

    const llm = createStreamingLLM({ apiKey: 'test', model: 'modelA,modelB' });
    await collectStream(await llm.streamChat([{ role: 'user', content: 'hi' }]));

    const failed = find(/attempt 1\/2 stream model=modelA outcome=transient/);
    assert.ok(failed, `missing failed-attempt line in:\n${lines.join('\n')}`);
    assert.match(failed, /status=503/);
    assert.match(failed, /total=\d+ms/);
    assert.match(failed, /error="service unavailable"/);

    const ok = find(/attempt 2\/2 stream model=modelB outcome=ok/);
    assert.ok(ok, `missing ok-attempt line in:\n${lines.join('\n')}`);
    assert.match(ok, /ttft=\d+ms/);
    assert.match(ok, /tokens=in:10,out:5,thoughts:7/);

    assert.ok(find(/request stream answered_by=modelB attempts=2 total=\d+ms/));
  });

  it('streaming: strips the SDK prefix and request URL from the error message', async () => {
    mockGenerateContentStream = async (modelId) => {
      if (modelId === 'modelA') {
        return makeStreamWithError([], makeError(503,
          '[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/modelA:streamGenerateContent?alt=sse: [503 Service Unavailable] The model is overloaded.'));
      }
      return makeStream(chunk('ok'));
    };

    const llm = createStreamingLLM({ apiKey: 'test', model: 'modelA,modelB' });
    await collectStream(await llm.streamChat([{ role: 'user', content: 'hi' }]));

    const failed = find(/model=modelA outcome=transient/);
    assert.ok(failed);
    assert.match(failed, /error="\[503 Service Unavailable\] The model is overloaded\."/);
    assert.doesNotMatch(failed, /googleapis\.com/);
  });

  it('streaming: fatal error logs outcome=fatal-request and answered_by=none', async () => {
    mockGenerateContentStream = async () => makeStreamWithError([], makeError(400, 'bad request'));

    const llm = createStreamingLLM({ apiKey: 'test', model: 'modelA,modelB' });
    const reader = (await llm.streamChat([{ role: 'user', content: 'hi' }])).body.getReader();
    try { while (!(await reader.read()).done); } catch {}

    assert.ok(find(/attempt 1\/2 stream model=modelA outcome=fatal-request status=400/));
    assert.ok(find(/request stream answered_by=none attempts=1/));
  });

  it('non-streaming: logs each attempt and the request summary', async () => {
    mockGenerateContent = async (modelId) => {
      if (modelId === 'modelA') throw makeError(429, 'rate limited');
      return { response: { text: () => 'ok', usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } } };
    };

    const llm = createLLM({ apiKey: 'test', model: 'modelA,modelB' });
    await llm.generateContent(['hi']);

    assert.ok(find(/attempt 1\/2 once model=modelA outcome=transient status=429/));
    const ok = find(/attempt 2\/2 once model=modelB outcome=ok/);
    assert.ok(ok);
    assert.match(ok, /tokens=in:3,out:2,thoughts:0/);
    assert.ok(find(/request once answered_by=modelB attempts=2/));
  });
});

// ---------------------------------------------------------------------------
// First-chunk timeout, cancellation and userMessage
// ---------------------------------------------------------------------------

/**
 * A stream whose first chunk never arrives; rejects with AbortError once the
 * request's signal is aborted (what the real SDK does on fetch abort).
 */
function makeHangingStream(signal) {
  return {
    stream: (async function*() {
      await new Promise((_, reject) => {
        const fail = () => {
          const e = new Error('Request aborted when reading from the stream');
          e.name = 'AbortError';
          reject(e);
        };
        if (signal?.aborted) return fail();
        signal?.addEventListener('abort', fail, { once: true });
      });
    })(),
  };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

describe('first-chunk timeout, cancellation and userMessage', () => {
  let lines;
  beforeEach(() => {
    lines = [];
    const capture = (...args) => { lines.push(args.map(String).join(' ')); };
    mock.method(console, 'log', capture);
    mock.method(console, 'warn', capture);
    mock.method(console, 'error', capture);
  });
  afterEach(() => mock.restoreAll());

  const find = (re) => lines.find(l => re.test(l));

  it('first model sends nothing before the timeout — aborts it, emits _reset(reason=timeout), next model answers', async () => {
    let signalA;
    mockGenerateContentStream = async (modelId, request, opts) => {
      if (modelId === 'modelA') { signalA = opts.signal; return makeHangingStream(opts.signal); }
      return makeStream(chunk('fast answer'));
    };

    const llm = createStreamingLLM({ apiKey: 'test', model: 'modelA,modelB', firstChunkTimeoutMs: 30 });
    const events = parseSseEvents(await collectStream(await llm.streamChat([{ role: 'user', content: 'hi' }])));

    assert.equal(signalA.aborted, true, 'the stalled request must be aborted');
    const reset = events.find(e => e._reset);
    assert.ok(reset, '_reset must be emitted');
    assert.equal(reset.reason, 'timeout');
    assert.equal(reset.next_model, 'modelB');
    assert.equal(events.find(e => e._final_model)._final_model, 'modelB');
    assert.match(find(/model=modelA outcome=timeout/) || '', /error="no response after 0\.03s"/);
  });

  it('timer only covers the first chunk — a slow stream after the first chunk is not cut off', async () => {
    mockGenerateContentStream = async () => ({
      stream: (async function*() {
        yield chunk('first ');
        await sleep(60);
        yield chunk('second');
      })(),
    });

    const llm = createStreamingLLM({ apiKey: 'test', model: 'modelA,modelB', firstChunkTimeoutMs: 20 });
    const events = parseSseEvents(await collectStream(await llm.streamChat([{ role: 'user', content: 'hi' }])));

    assert.ok(!events.some(e => e._reset), 'no failover once the first chunk arrived');
    assert.equal(events.find(e => e._final_model)._final_model, 'modelA');
  });

  it('timeout on the last model — stream errors with a userMessage naming the timeout', async () => {
    mockGenerateContentStream = async (modelId, request, opts) => makeHangingStream(opts.signal);

    const llm = createStreamingLLM({ apiKey: 'test', model: 'modelA,modelB', firstChunkTimeoutMs: 20 });
    const reader = (await llm.streamChat([{ role: 'user', content: 'hi' }])).body.getReader();
    let caught;
    try { while (!(await reader.read()).done); } catch (e) { caught = e; }

    assert.ok(caught, 'stream must error');
    assert.equal(caught.code, 'FIRST_CHUNK_TIMEOUT');
    assert.equal(caught.userMessage, 'All Gemini models failed (2 attempts). Last: modelB — no response after 0.02s');
  });

  it('consumer cancels while waiting — in-flight request aborted, no failover, no stream error', async () => {
    let calls = 0;
    let seenSignal;
    mockGenerateContentStream = async (modelId, request, opts) => {
      calls++;
      seenSignal = opts.signal;
      return makeHangingStream(opts.signal);
    };

    const llm = createStreamingLLM({ apiKey: 'test', model: 'modelA,modelB', firstChunkTimeoutMs: 10_000 });
    const reader = (await llm.streamChat([{ role: 'user', content: 'hi' }])).body.getReader();
    const pendingRead = reader.read();
    await sleep(10);
    await reader.cancel('Window closed by user');
    assert.deepEqual(await pendingRead, { done: true, value: undefined });
    await sleep(10);

    assert.equal(seenSignal.aborted, true, 'the HTTP request must be aborted');
    assert.equal(calls, 1, 'no failover after the consumer cancelled');
    assert.ok(find(/attempt 1\/2 stream model=modelA outcome=aborted/));
    assert.ok(find(/request stream answered_by=none attempts=1 total=\d+ms cancelled/));
    assert.ok(!find(/All models failed/));
  });

  it('all models 503 — userMessage keeps the server reason, without SDK prefix or URL', async () => {
    mockGenerateContentStream = async () => makeStreamWithError([], makeError(503,
      '[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/m:streamGenerateContent?alt=sse: [503 Service Unavailable] The model is overloaded.'));

    const llm = createStreamingLLM({ apiKey: 'test', model: 'modelA,modelB', retryRoundDelayMs: 0 });
    const reader = (await llm.streamChat([{ role: 'user', content: 'hi' }])).body.getReader();
    let caught;
    try { while (!(await reader.read()).done); } catch (e) { caught = e; }

    assert.equal(caught.userMessage, 'All Gemini models failed (4 attempts, 2 rounds). Last: modelB — [503 Service Unavailable] The model is overloaded.');
  });

  it('fatal error — userMessage names the model and the reason', async () => {
    mockGenerateContentStream = async () => makeStreamWithError([], makeError(400, 'bad request'));

    const llm = createStreamingLLM({ apiKey: 'test', model: 'modelA,modelB' });
    const reader = (await llm.streamChat([{ role: 'user', content: 'hi' }])).body.getReader();
    let caught;
    try { while (!(await reader.read()).done); } catch (e) { caught = e; }

    assert.equal(caught.userMessage, 'modelA — bad request');
  });
});

// ---------------------------------------------------------------------------
// End of the answer (finishReason) and the automatic second round
// ---------------------------------------------------------------------------

/**
 * Last chunk of an answer, as the API sends it: carries the finishReason.
 */
function finalChunk(text) {
  return {
    text: () => text,
    candidates: [{ finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, thoughtsTokenCount: 0 },
  };
}

/**
 * Yields `chunks`, then keeps the connection open until the request's signal aborts.
 */
function makeLingeringStream(chunks, signal) {
  const hang = makeHangingStream(signal).stream;
  return {
    stream: (async function*() {
      for (const c of chunks) yield c;
      yield* hang;
    })(),
  };
}

async function readUntilError(reader) {
  try { while (!(await reader.read()).done); } catch (e) { return e; }
  return undefined;
}

describe('stream end (finishReason) and retry round', () => {
  let lines;
  beforeEach(() => {
    lines = [];
    const capture = (...args) => { lines.push(args.map(String).join(' ')); };
    mock.method(console, 'log', capture);
    mock.method(console, 'warn', capture);
    mock.method(console, 'error', capture);
  });
  afterEach(() => mock.restoreAll());

  const find = (re) => lines.find(l => re.test(l));

  it('finishReason ends the attempt at once — the lingering connection is closed', { timeout: 2000 }, async () => {
    let seenSignal;
    mockGenerateContentStream = async (modelId, request, opts) => {
      seenSignal = opts.signal;
      return makeLingeringStream([finalChunk('Bom dia!')], opts.signal);
    };

    const llm = createStreamingLLM({ apiKey: 'test', model: 'modelA,modelB', firstChunkTimeoutMs: 10_000 });
    const events = parseSseEvents(await collectStream(await llm.streamChat([{ role: 'user', content: 'hi' }])));

    assert.equal(seenSignal.aborted, true, 'the connection left open must be closed');
    assert.equal(events[0].choices[0].delta.content, 'Bom dia!');
    assert.equal(events.find(e => e._final_model)._final_model, 'modelA');
    assert.ok(events[events.length - 1]._done, '[DONE] must be the last event');
    assert.match(find(/attempt 1\/2 stream model=modelA outcome=ok/) || '', /last=\d+ms total=\d+ms chunks=1 finish=STOP/);
    assert.ok(find(/request stream answered_by=modelA attempts=1/));
  });

  it('consumer cancels after text arrived — reported as answered_by the model, cancelled', async () => {
    mockGenerateContentStream = async (modelId, request, opts) => makeLingeringStream([chunk('Bom dia')], opts.signal);

    const llm = createStreamingLLM({ apiKey: 'test', model: 'modelA,modelB', firstChunkTimeoutMs: 10_000 });
    const reader = (await llm.streamChat([{ role: 'user', content: 'hi' }])).body.getReader();
    await reader.read(); // the first token
    await reader.cancel('Window closed by user');
    await sleep(10);

    assert.match(find(/attempt 1\/2 stream model=modelA outcome=aborted/) || '', /chunks=1/);
    assert.ok(find(/request stream answered_by=modelA attempts=1 total=\d+ms cancelled/));
  });

  it('every model fails with 503 — waits, emits _reset(reason=retry), and the second round answers', async () => {
    const calls = [];
    mockGenerateContentStream = async (modelId) => {
      calls.push(modelId);
      if (calls.length <= 2) return makeStreamWithError([], makeError(503, 'overloaded'));
      return makeStream(chunk('second round answer'));
    };

    const llm = createStreamingLLM({ apiKey: 'test', model: 'modelA,modelB', retryRoundDelayMs: 20 });
    const events = parseSseEvents(await collectStream(await llm.streamChat([{ role: 'user', content: 'hi' }])));

    assert.deepEqual(calls, ['modelA', 'modelB', 'modelA']);
    const retry = events.find(e => e._reset && e.reason === 'retry');
    assert.ok(retry, '_reset with reason=retry must announce the second round');
    assert.equal(retry.next_model, 'modelA');
    assert.equal(events.find(e => e._final_model)._final_model, 'modelA');
    assert.ok(find(/all models failed — retry round 2 in 20ms: modelA,modelB/));
    assert.ok(find(/attempt 3\/4 stream model=modelA outcome=ok/));
    assert.ok(find(/request stream answered_by=modelA attempts=3/));
  });

  it('second round only repeats models that failed fast — not 429 or timeouts', async () => {
    const calls = [];
    mockGenerateContentStream = async (modelId, request, opts) => {
      calls.push(modelId);
      if (modelId === 'modelA') return makeStreamWithError([], makeError(429, 'quota'));
      if (modelId === 'modelB') return makeHangingStream(opts.signal);
      return makeStreamWithError([], makeError(503, 'overloaded'));
    };

    const llm = createStreamingLLM({ apiKey: 'test', model: 'modelA,modelB,modelC', firstChunkTimeoutMs: 20, retryRoundDelayMs: 0 });
    const caught = await readUntilError((await llm.streamChat([{ role: 'user', content: 'hi' }])).body.getReader());

    assert.deepEqual(calls, ['modelA', 'modelB', 'modelC', 'modelC']);
    assert.equal(caught.userMessage, 'All Gemini models failed (4 attempts, 2 rounds). Last: modelC — overloaded');
  });

  it('no second round when every model hit a quota limit (429)', async () => {
    const calls = [];
    mockGenerateContentStream = async (modelId) => {
      calls.push(modelId);
      return makeStreamWithError([], makeError(429, 'quota'));
    };

    const llm = createStreamingLLM({ apiKey: 'test', model: 'modelA,modelB', retryRoundDelayMs: 0 });
    const caught = await readUntilError((await llm.streamChat([{ role: 'user', content: 'hi' }])).body.getReader());

    assert.deepEqual(calls, ['modelA', 'modelB']);
    assert.equal(caught.userMessage, 'All Gemini models failed (2 attempts). Last: modelB — quota');
    assert.ok(!find(/retry round/));
  });

  it('consumer cancels during the wait between rounds — no new attempt, no stream error', async () => {
    let calls = 0;
    mockGenerateContentStream = async () => {
      calls++;
      return makeStreamWithError([], makeError(503, 'overloaded'));
    };

    const llm = createStreamingLLM({ apiKey: 'test', model: 'modelA,modelB', retryRoundDelayMs: 10_000 });
    const reader = (await llm.streamChat([{ role: 'user', content: 'hi' }])).body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      assert.ok(!done, 'the stream must still be open while waiting');
      if (decoder.decode(value).includes('"reason":"retry"')) break;
    }
    await reader.cancel('Window closed by user');
    await sleep(20);

    assert.equal(calls, 2, 'the second round must not start');
    assert.ok(find(/request stream answered_by=none attempts=2 total=\d+ms cancelled/));
    assert.ok(!find(/All models failed/));
  });
});

// ---------------------------------------------------------------------------
// Hedged requests and the cooldown after a timeout
// ---------------------------------------------------------------------------

describe('hedged requests', () => {
  let lines;
  beforeEach(() => {
    lines = [];
    const capture = (...args) => { lines.push(args.map(String).join(' ')); };
    mock.method(console, 'log', capture);
    mock.method(console, 'warn', capture);
    mock.method(console, 'error', capture);
  });
  afterEach(() => mock.restoreAll());

  const find = (re) => lines.find(l => re.test(l));
  const msgs = [{ role: 'user', content: 'hi' }];

  it('first request stalls — a parallel request to the same model answers and the first is aborted', async () => {
    const calls = [];
    mockGenerateContentStream = async (modelId, request, opts) => {
      calls.push({ modelId, signal: opts.signal });
      if (calls.length === 1) return makeHangingStream(opts.signal);
      return makeStream(chunk('hedged answer'));
    };

    const llm = createStreamingLLM({ apiKey: 'test', model: 'a-flash-lite,b-flash-lite', firstChunkTimeoutMs: 1000, hedgeDelayMs: 20 });
    const events = parseSseEvents(await collectStream(await llm.streamChat(msgs)));

    assert.deepEqual(calls.map(c => c.modelId), ['a-flash-lite', 'a-flash-lite']);
    assert.equal(calls[0].signal.aborted, true, 'the stalled request must be aborted');
    assert.ok(!events.some(e => e._reset), 'hedging is invisible to the consumer');
    assert.equal(events[0].choices[0].delta.content, 'hedged answer');
    assert.equal(events.find(e => e._final_model)._final_model, 'a-flash-lite');
    assert.match(find(/attempt 1\/2 stream model=a-flash-lite outcome=ok/) || '', /hedge=\d+ms winner=hedge/);
    assert.ok(find(/request stream answered_by=a-flash-lite attempts=1 hedges=1 total=/));
  });

  it('first request answers after the hedge started — the parallel request is aborted', async () => {
    const signals = [];
    mockGenerateContentStream = async (modelId, request, opts) => {
      signals.push(opts.signal);
      if (signals.length === 1) {
        return { stream: (async function*() { await sleep(60); yield chunk('first answer'); })() };
      }
      return makeHangingStream(opts.signal);
    };

    const llm = createStreamingLLM({ apiKey: 'test', model: 'a-flash-lite', firstChunkTimeoutMs: 1000, hedgeDelayMs: 20 });
    const events = parseSseEvents(await collectStream(await llm.streamChat(msgs)));

    assert.equal(signals.length, 2);
    assert.equal(signals[1].aborted, true, 'the losing parallel request must be aborted');
    assert.equal(events[0].choices[0].delta.content, 'first answer');
    assert.match(find(/model=a-flash-lite outcome=ok/) || '', /winner=first/);
  });

  it('no parallel request when the first chunk arrives before the delay', async () => {
    let calls = 0;
    mockGenerateContentStream = async () => { calls++; return makeStream(chunk('quick')); };

    const llm = createStreamingLLM({ apiKey: 'test', model: 'a-flash-lite', hedgeDelayMs: 50 });
    await collectStream(await llm.streamChat(msgs));
    await sleep(70);

    assert.equal(calls, 1);
    assert.ok(!find(/hedge/));
  });

  it('a 503 before the delay fails the attempt at once — no parallel request, next model', async () => {
    const calls = [];
    mockGenerateContentStream = async (modelId) => {
      calls.push(modelId);
      if (modelId === 'a-flash-lite') return makeStreamWithError([], makeError(503, 'overloaded'));
      return makeStream(chunk('b answer'));
    };

    const llm = createStreamingLLM({ apiKey: 'test', model: 'a-flash-lite,b-flash-lite', hedgeDelayMs: 50 });
    const events = parseSseEvents(await collectStream(await llm.streamChat(msgs)));
    await sleep(70);

    assert.deepEqual(calls, ['a-flash-lite', 'b-flash-lite']);
    assert.equal(events.find(e => e._final_model)._final_model, 'b-flash-lite');
  });

  it('a 503 on the first request after the hedge started — keeps waiting for the parallel one', async () => {
    let calls = 0;
    mockGenerateContentStream = async () => {
      calls++;
      if (calls === 1) {
        return { stream: (async function*() { await sleep(40); throw makeError(503, 'overloaded'); })() };
      }
      return { stream: (async function*() { await sleep(60); yield chunk('hedge answer'); })() };
    };

    const llm = createStreamingLLM({ apiKey: 'test', model: 'a-flash-lite,b-flash-lite', firstChunkTimeoutMs: 1000, hedgeDelayMs: 20 });
    const events = parseSseEvents(await collectStream(await llm.streamChat(msgs)));

    assert.equal(calls, 2, 'no failover to b-flash-lite');
    assert.ok(!events.some(e => e._reset));
    assert.equal(events[0].choices[0].delta.content, 'hedge answer');
    assert.match(find(/model=a-flash-lite outcome=ok/) || '', /winner=hedge/);
  });

  it('both requests stall — timeout counted from the attempt start, both aborted, 10 s cooldown', async () => {
    const calls = [];
    mockGenerateContentStream = async (modelId, request, opts) => {
      calls.push({ modelId, signal: opts.signal });
      if (modelId === 'a-flash-lite') return makeHangingStream(opts.signal);
      return makeStream(chunk('b answer'));
    };
    const failed = [];
    mock.method(rotator, 'markFailed', (id, ms) => { failed.push([id, ms]); });

    const llm = createStreamingLLM({ apiKey: 'test', model: 'a-flash-lite,b-flash-lite', firstChunkTimeoutMs: 80, hedgeDelayMs: 20 });
    const events = parseSseEvents(await collectStream(await llm.streamChat(msgs)));

    const onA = calls.filter(c => c.modelId === 'a-flash-lite');
    assert.equal(onA.length, 2);
    assert.ok(onA.every(c => c.signal.aborted), 'both stalled requests must be aborted');
    assert.equal(events.find(e => e._reset).reason, 'timeout');
    assert.equal(events.find(e => e._final_model)._final_model, 'b-flash-lite');
    assert.match(find(/model=a-flash-lite outcome=timeout/) || '', /hedge=\d+ms .*error="no response after 0\.08s"/);
    assert.deepEqual(failed, [['a-flash-lite', 10_000]]);
  });

  it('a 503 keeps the default cooldown (60 s)', async () => {
    mockGenerateContentStream = async (modelId) => modelId === 'a-flash-lite'
      ? makeStreamWithError([], makeError(503, 'overloaded'))
      : makeStream(chunk('b answer'));
    const failed = [];
    mock.method(rotator, 'markFailed', (id, ms) => { failed.push([id, ms]); });

    const llm = createStreamingLLM({ apiKey: 'test', model: 'a-flash-lite,b-flash-lite' });
    await collectStream(await llm.streamChat(msgs));

    assert.deepEqual(failed, [['a-flash-lite', 60_000]]);
  });

  it('consumer cancels during the race — both requests aborted, no failover, no stream error', async () => {
    const calls = [];
    mockGenerateContentStream = async (modelId, request, opts) => {
      calls.push({ modelId, signal: opts.signal });
      return makeHangingStream(opts.signal);
    };

    const llm = createStreamingLLM({ apiKey: 'test', model: 'a-flash-lite,b-flash-lite', firstChunkTimeoutMs: 10_000, hedgeDelayMs: 10 });
    const reader = (await llm.streamChat(msgs)).body.getReader();
    const pendingRead = reader.read();
    await sleep(40);
    await reader.cancel('Window closed by user');
    assert.deepEqual(await pendingRead, { done: true, value: undefined });
    await sleep(10);

    assert.deepEqual(calls.map(c => c.modelId), ['a-flash-lite', 'a-flash-lite']);
    assert.ok(calls.every(c => c.signal.aborted), 'both requests must be aborted');
    assert.ok(find(/request stream answered_by=none attempts=1 hedges=1 total=\d+ms cancelled/));
    assert.ok(!find(/All models failed/));
  });
});

describe('request deadline', () => {
  let lines;
  beforeEach(() => {
    lines = [];
    const capture = (...args) => { lines.push(args.map(String).join(' ')); };
    mock.method(console, 'log', capture);
    mock.method(console, 'warn', capture);
    mock.method(console, 'error', capture);
  });
  afterEach(() => mock.restoreAll());

  const find = (re) => lines.find(l => re.test(l));
  const msgs = [{ role: 'user', content: 'hi' }];

  it('shortens the attempt to the deadline and gives up without trying the next model', async () => {
    const calls = [];
    mockGenerateContentStream = async (modelId, request, opts) => {
      calls.push(modelId);
      return makeHangingStream(opts.signal);
    };

    const llm = createStreamingLLM({ apiKey: 'test', model: 'modelA,modelB', firstChunkTimeoutMs: 1000, requestDeadlineMs: 150 });
    const started = Date.now();
    const caught = await readUntilError((await llm.streamChat(msgs)).body.getReader());
    const took = Date.now() - started;

    assert.deepEqual(calls, ['modelA']);
    assert.ok(took < 600, `gave up at the deadline, not the 1 s attempt timeout (took ${took}ms)`);
    assert.equal(caught.userMessage, 'No answer within 0.15s (1 attempt). Last: modelA — no response after 0.15s');
    assert.ok(find(/request deadline reached — no answer within 150ms/));
  });

  it('the next model only gets what is left of the deadline', async () => {
    const calls = [];
    mockGenerateContentStream = async (modelId, request, opts) => {
      calls.push(modelId);
      return makeHangingStream(opts.signal);
    };

    const llm = createStreamingLLM({ apiKey: 'test', model: 'modelA,modelB,modelC', firstChunkTimeoutMs: 100, requestDeadlineMs: 150 });
    const started = Date.now();
    const caught = await readUntilError((await llm.streamChat(msgs)).body.getReader());
    const took = Date.now() - started;

    assert.deepEqual(calls, ['modelA', 'modelB'], 'modelC is never tried');
    assert.ok(took < 400, `took ${took}ms`);
    assert.match(caught.userMessage, /^No answer within 0\.15s \(2 attempts\)\. Last: modelB — no response after 0\.\d+s$/);
  });

  it('skips the second round when less time is left than its wait', async () => {
    const calls = [];
    mockGenerateContentStream = async (modelId) => {
      calls.push(modelId);
      return makeStreamWithError([], makeError(503, 'overloaded'));
    };

    const llm = createStreamingLLM({ apiKey: 'test', model: 'modelA,modelB', retryRoundDelayMs: 200, requestDeadlineMs: 100 });
    const caught = await readUntilError((await llm.streamChat(msgs)).body.getReader());

    assert.deepEqual(calls, ['modelA', 'modelB']);
    assert.ok(!find(/retry round/));
    assert.equal(caught.userMessage, 'No answer within 0.1s (2 attempts). Last: modelB — overloaded');
  });

  it('never cuts an answer that is already streaming', async () => {
    mockGenerateContentStream = async () => ({
      stream: (async function*() {
        yield chunk('first ');
        await sleep(120);
        yield chunk('second');
      })(),
    });

    const llm = createStreamingLLM({ apiKey: 'test', model: 'modelA', requestDeadlineMs: 50 });
    const events = parseSseEvents(await collectStream(await llm.streamChat(msgs)));

    assert.equal(events.filter(e => e.choices).map(e => e.choices[0].delta.content).join(''), 'first second');
    assert.equal(events.find(e => e._final_model)._final_model, 'modelA');
  });

  it('null disables the deadline', async () => {
    const calls = [];
    mockGenerateContentStream = async (modelId, request, opts) => {
      calls.push(modelId);
      return makeHangingStream(opts.signal);
    };

    const llm = createStreamingLLM({ apiKey: 'test', model: 'modelA,modelB', firstChunkTimeoutMs: 30, requestDeadlineMs: null });
    const caught = await readUntilError((await llm.streamChat(msgs)).body.getReader());

    assert.deepEqual(calls, ['modelA', 'modelB']);
    assert.equal(caught.userMessage, 'All Gemini models failed (2 attempts). Last: modelB — no response after 0.03s');
  });
});

describe('requestDeadlineMs', () => {
  let saved;
  beforeEach(() => { saved = process.env.GEMINI_REQUEST_DEADLINE_MS; delete process.env.GEMINI_REQUEST_DEADLINE_MS; });
  afterEach(() => {
    if (saved === undefined) delete process.env.GEMINI_REQUEST_DEADLINE_MS;
    else process.env.GEMINI_REQUEST_DEADLINE_MS = saved;
  });

  it('60 s by default', () => {
    assert.equal(requestDeadlineMs(), 60_000);
  });

  it('GEMINI_REQUEST_DEADLINE_MS overrides it; 0 disables; invalid values are ignored', () => {
    process.env.GEMINI_REQUEST_DEADLINE_MS = '45000';
    assert.equal(requestDeadlineMs(), 45_000);
    process.env.GEMINI_REQUEST_DEADLINE_MS = '0';
    assert.equal(requestDeadlineMs(), null);
    process.env.GEMINI_REQUEST_DEADLINE_MS = 'abc';
    assert.equal(requestDeadlineMs(), 60_000);
  });
});

describe('hedgeDelayMs', () => {
  let saved;
  beforeEach(() => { saved = process.env.GEMINI_HEDGE_DELAY_MS; delete process.env.GEMINI_HEDGE_DELAY_MS; });
  afterEach(() => {
    if (saved === undefined) delete process.env.GEMINI_HEDGE_DELAY_MS;
    else process.env.GEMINI_HEDGE_DELAY_MS = saved;
  });

  it('10 s for Flash-Lite models', () => {
    assert.equal(hedgeDelayMs('gemini-3.5-flash-lite'), 10_000);
    assert.equal(hedgeDelayMs('gemini-3.1-flash-lite'), 10_000);
  });

  it('no parallel request (null) for other models', () => {
    assert.equal(hedgeDelayMs('gemini-3-flash-preview'), null);
    assert.equal(hedgeDelayMs('gemini-3.8-flash'), null);
  });

  it('GEMINI_HEDGE_DELAY_MS overrides every model; 0 disables; invalid values are ignored', () => {
    process.env.GEMINI_HEDGE_DELAY_MS = '1500';
    assert.equal(hedgeDelayMs('gemini-3.5-flash-lite'), 1500);
    assert.equal(hedgeDelayMs('gemini-3-flash-preview'), 1500);
    process.env.GEMINI_HEDGE_DELAY_MS = '0';
    assert.equal(hedgeDelayMs('gemini-3.5-flash-lite'), null);
    process.env.GEMINI_HEDGE_DELAY_MS = 'abc';
    assert.equal(hedgeDelayMs('gemini-3.5-flash-lite'), 10_000);
    assert.equal(hedgeDelayMs('gemini-3-flash-preview'), null);
  });
});

describe('firstChunkTimeoutMs', () => {
  let saved;
  beforeEach(() => { saved = process.env.GEMINI_FIRST_CHUNK_TIMEOUT_MS; delete process.env.GEMINI_FIRST_CHUNK_TIMEOUT_MS; });
  afterEach(() => {
    if (saved === undefined) delete process.env.GEMINI_FIRST_CHUNK_TIMEOUT_MS;
    else process.env.GEMINI_FIRST_CHUNK_TIMEOUT_MS = saved;
  });

  it('25 s for Flash-Lite models', () => {
    assert.equal(firstChunkTimeoutMs('gemini-3.5-flash-lite'), 25_000);
    assert.equal(firstChunkTimeoutMs('gemini-3.1-flash-lite'), 25_000);
  });

  it('60 s for models that think before answering', () => {
    assert.equal(firstChunkTimeoutMs('gemini-3-flash-preview'), 60_000);
    assert.equal(firstChunkTimeoutMs('gemini-3.8-flash'), 60_000);
  });

  it('GEMINI_FIRST_CHUNK_TIMEOUT_MS overrides every model; invalid values are ignored', () => {
    process.env.GEMINI_FIRST_CHUNK_TIMEOUT_MS = '1500';
    assert.equal(firstChunkTimeoutMs('gemini-3.5-flash-lite'), 1500);
    assert.equal(firstChunkTimeoutMs('gemini-3-flash-preview'), 1500);
    process.env.GEMINI_FIRST_CHUNK_TIMEOUT_MS = 'abc';
    assert.equal(firstChunkTimeoutMs('gemini-3-flash-preview'), 60_000);
  });
});

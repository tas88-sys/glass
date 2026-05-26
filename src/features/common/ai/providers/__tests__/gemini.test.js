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
const { createLLM, createStreamingLLM } = require('../gemini');

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

    const llm = createStreamingLLM({ apiKey: 'test', model: 'modelA,modelB' });
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

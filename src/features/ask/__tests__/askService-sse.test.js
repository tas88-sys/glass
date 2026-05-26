/**
 * askService-sse.test.js
 *
 * Tests for the SSE consumer sentinel handling (_reset and _final_model)
 * added in T-P4.2 to askService.js _processStream.
 *
 * Test runner: node:test (Node 18+ built-in)
 * Run: node --test src/features/ask/__tests__/askService-sse.test.js
 *
 * Strategy: extract the inner SSE parsing logic into a standalone function
 * that mirrors the _processStream loop. This avoids Electron/repo coupling.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Minimal SSE consumer extracted from _processStream (mirrors the real impl)
// ---------------------------------------------------------------------------
/**
 * Process a synthetic SSE stream, applying the same sentinel-handling logic
 * as askService.js _processStream.
 *
 * @param {string[]} sseLines - raw SSE line strings, e.g. ["data: {\"_reset\":true}", "data: [DONE]"]
 * @param {object} state - mutable state object (currentResponse, responseModel, responseHadFallback)
 * @param {function} broadcastState - spy called whenever state changes
 * @returns {{ fullResponse: string }}
 */
function processSseLines(sseLines, state, broadcastState) {
  let fullResponse = '';

  for (const line of sseLines) {
    if (!line.startsWith('data: ')) continue;
    const data = line.substring(6);
    if (data === '[DONE]') break;

    let json;
    try {
      json = JSON.parse(data);
    } catch {
      continue;
    }

    // Handle _reset sentinel
    if (json._reset) {
      fullResponse = '';
      state.currentResponse = '';
      state.responseHadFallback = true;
      broadcastState();
      continue;
    }

    // Handle _final_model sentinel
    if (json._final_model) {
      state.responseModel = json._final_model;
      broadcastState();
      continue;
    }

    // Normal token
    const token = json.choices?.[0]?.delta?.content || '';
    if (token) {
      fullResponse += token;
      state.currentResponse = fullResponse;
      broadcastState();
    }
  }

  return { fullResponse };
}

function makeState() {
  return {
    currentResponse: '',
    responseModel: null,
    responseHadFallback: false,
  };
}

function sseData(obj) {
  return `data: ${JSON.stringify(obj)}`;
}
function sseToken(text) {
  return sseData({ choices: [{ delta: { content: text } }] });
}
const sseDone = 'data: [DONE]';

// ---------------------------------------------------------------------------
// Test cases (spec §6.4)
// ---------------------------------------------------------------------------

describe('SSE consumer: _reset handling', () => {
  it('_reset clears fullResponse and state.currentResponse', () => {
    const state = makeState();
    const broadcasts = [];
    const broadcastState = () => broadcasts.push({ ...state });

    const lines = [
      sseToken('hello '),
      sseToken('world'),
      sseData({ _reset: true, next_model: 'modelB', reason: 'transient' }),
      sseDone,
    ];

    const { fullResponse } = processSseLines(lines, state, broadcastState);

    assert.equal(fullResponse, '', 'fullResponse must be reset to empty string');
    assert.equal(state.currentResponse, '', 'state.currentResponse must be empty after _reset');
    assert.equal(state.responseHadFallback, true, 'responseHadFallback must be true after _reset');
  });

  it('_reset triggers a _broadcastState() call', () => {
    const state = makeState();
    const broadcasts = [];
    const broadcastState = () => broadcasts.push({ ...state });

    const lines = [
      sseToken('first'),
      sseData({ _reset: true, next_model: 'modelB', reason: 'transient' }),
      sseDone,
    ];

    processSseLines(lines, state, broadcastState);

    // Broadcasts: 1 for token, 1 for _reset
    assert.ok(broadcasts.length >= 2, `Expected at least 2 broadcasts, got ${broadcasts.length}`);
    // The _reset broadcast must have empty currentResponse
    const resetBroadcast = broadcasts.find(b => b.responseHadFallback === true);
    assert.ok(resetBroadcast, '_broadcastState should be called with responseHadFallback=true');
    assert.equal(resetBroadcast.currentResponse, '');
  });
});

describe('SSE consumer: _final_model handling', () => {
  it('_final_model sets state.responseModel', () => {
    const state = makeState();
    const broadcasts = [];
    const broadcastState = () => broadcasts.push({ ...state });

    const lines = [
      sseToken('some response'),
      sseData({ _final_model: 'gemini-2.5-flash' }),
      sseDone,
    ];

    processSseLines(lines, state, broadcastState);

    assert.equal(state.responseModel, 'gemini-2.5-flash');
  });

  it('_final_model triggers _broadcastState()', () => {
    const state = makeState();
    const broadcasts = [];
    const broadcastState = () => broadcasts.push({ ...state });

    const lines = [
      sseData({ _final_model: 'gemini-2.5-flash-lite' }),
      sseDone,
    ];

    processSseLines(lines, state, broadcastState);

    assert.ok(broadcasts.length >= 1, 'At least one broadcast expected');
    assert.equal(broadcasts[broadcasts.length - 1].responseModel, 'gemini-2.5-flash-lite');
  });
});

describe('SSE consumer: token after _reset isolation', () => {
  it('token received after _reset appears in fullResponse alone, not concatenated with pre-reset content', () => {
    const state = makeState();
    const broadcasts = [];
    const broadcastState = () => broadcasts.push({ ...state });

    const lines = [
      sseToken('pre-reset content '),
      sseData({ _reset: true, next_model: 'modelB', reason: 'transient' }),
      sseToken('post-reset token'),
      sseData({ _final_model: 'modelB' }),
      sseDone,
    ];

    const { fullResponse } = processSseLines(lines, state, broadcastState);

    assert.equal(fullResponse, 'post-reset token',
      'fullResponse must only contain tokens received after _reset');
    assert.ok(!fullResponse.includes('pre-reset'),
      'pre-reset content must not appear in final fullResponse');
    assert.equal(state.responseModel, 'modelB');
    assert.equal(state.responseHadFallback, true);
  });

  it('multiple tokens after _reset accumulate correctly', () => {
    const state = makeState();
    const broadcasts = [];
    const broadcastState = () => broadcasts.push({ ...state });

    const lines = [
      sseToken('old '),
      sseToken('content '),
      sseData({ _reset: true, next_model: 'modelB', reason: 'transient' }),
      sseToken('new '),
      sseToken('content'),
      sseDone,
    ];

    const { fullResponse } = processSseLines(lines, state, broadcastState);

    assert.equal(fullResponse, 'new content');
    assert.equal(state.currentResponse, 'new content');
  });
});

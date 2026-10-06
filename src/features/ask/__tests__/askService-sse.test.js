/**
 * askService-sse.test.js
 *
 * Tests for the Ask SSE stream state (askStreamState.applyAskSseEvent), the
 * reducer askService._processStream applies to every `data:` payload:
 * _reset / _final_model sentinels, token accumulation, and the loading state
 * that keeps "Thinking..." visible until the first token.
 *
 * Test runner: node:test (Node 18+ built-in)
 * Run: node --test src/features/ask/__tests__/askService-sse.test.js
 *
 * askStreamState.js has no Electron dependency, so the real reducer is tested
 * directly; only the line splitting / [DONE] handling of _processStream is
 * replayed here.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { initialAskStreamState, applyAskSseEvent } = require('../askStreamState');

// ---------------------------------------------------------------------------
// Replays _processStream's loop: parse `data:` lines, stop at [DONE], apply
// the reducer, and record a broadcast whenever the state changes.
// ---------------------------------------------------------------------------
function run(sseLines) {
  let state = initialAskStreamState();
  const broadcasts = [];
  for (const line of sseLines) {
    if (!line.startsWith('data: ')) continue;
    const data = line.substring(6);
    if (data === '[DONE]') break;
    let json;
    try { json = JSON.parse(data); } catch { continue; }
    const next = applyAskSseEvent(state, json);
    if (next === state) continue;
    state = next;
    broadcasts.push(state);
  }
  return { state, broadcasts };
}

function sseData(obj) {
  return `data: ${JSON.stringify(obj)}`;
}
function sseToken(text) {
  return sseData({ choices: [{ delta: { content: text } }] });
}
const sseDone = 'data: [DONE]';

// ---------------------------------------------------------------------------
// Sentinels (spec §6.4 of the failover design)
// ---------------------------------------------------------------------------

describe('SSE consumer: _reset handling', () => {
  it('_reset clears the accumulated response and marks the fallback', () => {
    const { state } = run([
      sseToken('hello '),
      sseToken('world'),
      sseData({ _reset: true, next_model: 'modelB', reason: 'transient' }),
      sseDone,
    ]);

    assert.equal(state.fullResponse, '', 'fullResponse must be reset to empty string');
    assert.equal(state.responseHadFallback, true, 'responseHadFallback must be true after _reset');
  });

  it('_reset is broadcast with an empty response', () => {
    const { broadcasts } = run([
      sseToken('first'),
      sseData({ _reset: true, next_model: 'modelB', reason: 'transient' }),
      sseDone,
    ]);

    // Broadcasts: 1 for token, 1 for _reset
    assert.equal(broadcasts.length, 2);
    const resetBroadcast = broadcasts.find(b => b.responseHadFallback === true);
    assert.ok(resetBroadcast, 'a broadcast with responseHadFallback=true is expected');
    assert.equal(resetBroadcast.fullResponse, '');
  });
});

describe('SSE consumer: _final_model handling', () => {
  it('_final_model sets responseModel', () => {
    const { state } = run([
      sseToken('some response'),
      sseData({ _final_model: 'gemini-2.5-flash' }),
      sseDone,
    ]);

    assert.equal(state.responseModel, 'gemini-2.5-flash');
  });

  it('_final_model is broadcast', () => {
    const { broadcasts } = run([
      sseData({ _final_model: 'gemini-2.5-flash-lite' }),
      sseDone,
    ]);

    assert.ok(broadcasts.length >= 1, 'At least one broadcast expected');
    assert.equal(broadcasts[broadcasts.length - 1].responseModel, 'gemini-2.5-flash-lite');
  });
});

describe('SSE consumer: token after _reset isolation', () => {
  it('token received after _reset appears alone, not concatenated with pre-reset content', () => {
    const { state } = run([
      sseToken('pre-reset content '),
      sseData({ _reset: true, next_model: 'modelB', reason: 'transient' }),
      sseToken('post-reset token'),
      sseData({ _final_model: 'modelB' }),
      sseDone,
    ]);

    assert.equal(state.fullResponse, 'post-reset token',
      'fullResponse must only contain tokens received after _reset');
    assert.equal(state.responseModel, 'modelB');
    assert.equal(state.responseHadFallback, true);
  });

  it('multiple tokens after _reset accumulate correctly', () => {
    const { state } = run([
      sseToken('old '),
      sseToken('content '),
      sseData({ _reset: true, next_model: 'modelB', reason: 'transient' }),
      sseToken('new '),
      sseToken('content'),
      sseDone,
    ]);

    assert.equal(state.fullResponse, 'new content');
  });
});

// ---------------------------------------------------------------------------
// Loading state: "Thinking..." until the first token, model shown on failover
// ---------------------------------------------------------------------------

describe('SSE consumer: loading until the first token', () => {
  it('starts loading, not streaming', () => {
    const state = initialAskStreamState();
    assert.equal(state.isLoading, true);
    assert.equal(state.isStreaming, false);
    assert.equal(state.retryingWith, null);
  });

  it('stays loading while only sentinels arrive', () => {
    const { state } = run([
      sseData({ _reset: true, next_model: 'modelB', reason: 'timeout' }),
    ]);

    assert.equal(state.isLoading, true);
    assert.equal(state.isStreaming, false);
  });

  it('the first token switches from loading to streaming', () => {
    const { state, broadcasts } = run([sseToken('hi')]);

    assert.equal(state.isLoading, false);
    assert.equal(state.isStreaming, true);
    assert.equal(broadcasts.length, 1);
  });

  it('_reset shows the next model and goes back to loading; its first token clears it', () => {
    const { broadcasts } = run([
      sseToken('partial'),
      sseData({ _reset: true, next_model: 'gemini-3.1-flash-lite', reason: 'timeout' }),
      sseToken('answer'),
      sseDone,
    ]);

    const [, afterReset, afterToken] = broadcasts;
    assert.equal(afterReset.isLoading, true, 'back to "Thinking..." while the next model starts');
    assert.equal(afterReset.isStreaming, false);
    assert.equal(afterReset.retryingWith, 'gemini-3.1-flash-lite');
    assert.equal(afterToken.isLoading, false);
    assert.equal(afterToken.retryingWith, null);
    assert.equal(afterToken.fullResponse, 'answer');
  });

  it('empty deltas and unknown payloads do not change the state (no broadcast)', () => {
    const start = initialAskStreamState();
    assert.equal(applyAskSseEvent(start, { choices: [{ delta: { content: '' } }] }), start);
    assert.equal(applyAskSseEvent(start, { something: 'else' }), start);
    assert.equal(applyAskSseEvent(start, null), start);
  });
});

/**
 * geminiModelRotator.test.js
 *
 * Test runner: node:test (Node 18+ built-in)
 * Choice: No Jest/Vitest installed in package.json devDependencies.
 *         node:test is available in Node 18+ (Electron 30 ships Node 20+)
 *         and requires zero additional dependencies.
 * Run: node --test src/features/common/ai/providers/__tests__/geminiModelRotator.test.js
 */

'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const rotator = require('../geminiModelRotator');
const {
  pickModel,
  markFailed,
  markSucceeded,
  classifyError,
  parseRetryAfter,
  parseModelList,
  resetHealth,
} = rotator;

// ---------------------------------------------------------------------------
// Reset health state before every test to prevent cross-test leakage
// ---------------------------------------------------------------------------
beforeEach(() => {
  resetHealth();
});

// ---------------------------------------------------------------------------
// pickModel
// ---------------------------------------------------------------------------
describe('pickModel', () => {
  it('throws on empty list', () => {
    assert.throws(() => pickModel([]), /empty model list/i);
  });

  it('returns first model when all healthy', () => {
    const result = pickModel(['a', 'b', 'c']);
    assert.equal(result, 'a');
  });

  it('skips marked-failed model and returns next', () => {
    markFailed('a', 60_000);
    const result = pickModel(['a', 'b', 'c']);
    assert.equal(result, 'b');
  });

  it('returns soonest-recovering model when all cooling down', () => {
    const now = Date.now();
    // a cools down last, b cools down first
    markFailed('a', 120_000);
    markFailed('b', 10_000);
    markFailed('c', 60_000);
    const result = pickModel(['a', 'b', 'c']);
    assert.equal(result, 'b');
  });
});

// ---------------------------------------------------------------------------
// classifyError
// ---------------------------------------------------------------------------
describe('classifyError', () => {
  it('classifies SDK 429 as transient', () => {
    assert.equal(classifyError({ status: 429 }), 'transient');
  });

  it('classifies SDK 400 as fatal-request', () => {
    assert.equal(classifyError({ status: 400 }), 'fatal-request');
  });

  it('classifies raw Response-like 503 as transient', () => {
    assert.equal(classifyError({ status: 503 }), 'transient');
  });

  it('classifies network TypeError (fetch failed) as transient', () => {
    assert.equal(classifyError({ name: 'TypeError', message: 'fetch failed' }), 'transient');
  });

  it('classifies AbortError as transient', () => {
    assert.equal(classifyError({ name: 'AbortError', message: 'aborted' }), 'transient');
  });

  it('classifies RESOURCE_EXHAUSTED errorDetails reason as transient', () => {
    const err = {
      errorDetails: [
        { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'RESOURCE_EXHAUSTED' },
      ],
    };
    assert.equal(classifyError(err), 'transient');
  });

  it('classifies INVALID_ARGUMENT errorDetails reason as fatal-request', () => {
    const err = {
      errorDetails: [
        { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'INVALID_ARGUMENT' },
      ],
    };
    assert.equal(classifyError(err), 'fatal-request');
  });

  it('classifies PERMISSION_DENIED as fatal-auth', () => {
    const err = {
      errorDetails: [
        { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'PERMISSION_DENIED' },
      ],
    };
    assert.equal(classifyError(err), 'fatal-auth');
  });

  it('classifies 401 as fatal-auth', () => {
    assert.equal(classifyError({ status: 401 }), 'fatal-auth');
  });

  it('defaults unknown errors to transient (fail-open)', () => {
    assert.equal(classifyError({ message: 'some unknown error' }), 'transient');
    assert.equal(classifyError(null), 'transient');
    assert.equal(classifyError(undefined), 'transient');
  });
});

// ---------------------------------------------------------------------------
// parseRetryAfter
// ---------------------------------------------------------------------------
describe('parseRetryAfter', () => {
  it('reads RetryInfo retryDelay "37s" -> 37000ms', () => {
    const err = {
      errorDetails: [
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '37s' },
      ],
    };
    assert.equal(parseRetryAfter(err), 37_000);
  });

  it('reads numeric Retry-After header "45" -> 45000ms', () => {
    const err = { retryAfter: '45' };
    assert.equal(parseRetryAfter(err), 45_000);
  });

  it('reads HTTP-date Retry-After header', () => {
    const futureDate = new Date(Date.now() + 30_000).toUTCString();
    const err = { retryAfter: futureDate };
    const result = parseRetryAfter(err);
    // Should be between 25s and 35s, clamped to [5s, 300s]
    assert.ok(result >= 25_000 && result <= 35_000, `Expected ~30000 but got ${result}`);
  });

  it('returns DEFAULT_COOLDOWN_MS=60000 when nothing present', () => {
    assert.equal(parseRetryAfter({}), 60_000);
    assert.equal(parseRetryAfter(null), 60_000);
  });

  it('clamps low value: 1000 -> 5000', () => {
    const err = { retryAfter: '1' }; // 1 second = 1000ms -> clamp to 5000
    assert.equal(parseRetryAfter(err), 5_000);
  });

  it('clamps high value: 999999ms -> 300000', () => {
    const err = { retryAfter: '999' }; // 999 seconds = 999000ms -> clamp to 300000
    assert.equal(parseRetryAfter(err), 300_000);
  });
});

// ---------------------------------------------------------------------------
// parseModelList
// ---------------------------------------------------------------------------
describe('parseModelList', () => {
  it('"a,b,c" -> ["a","b","c"]', () => {
    assert.deepEqual(parseModelList('a,b,c'), ['a', 'b', 'c']);
  });

  it('" a , , b " -> ["a","b"] (trims and drops empties)', () => {
    assert.deepEqual(parseModelList(' a , , b '), ['a', 'b']);
  });

  it('"" -> []', () => {
    assert.deepEqual(parseModelList(''), []);
  });

  it('null -> []', () => {
    assert.deepEqual(parseModelList(null), []);
  });

  it('undefined -> []', () => {
    assert.deepEqual(parseModelList(undefined), []);
  });
});

// ---------------------------------------------------------------------------
// markSucceeded clears entry
// ---------------------------------------------------------------------------
describe('markSucceeded', () => {
  it('clears cooldown entry so pickModel returns the model immediately', () => {
    markFailed('a', 60_000);
    // At this point 'a' is cooling down
    assert.equal(pickModel(['a', 'b']), 'b');

    markSucceeded('a');
    // After marking succeeded, 'a' is healthy again and first in list
    assert.equal(pickModel(['a', 'b']), 'a');
  });

  it('is a no-op when called for a never-failed model', () => {
    assert.doesNotThrow(() => markSucceeded('never-failed'));
    assert.equal(pickModel(['never-failed']), 'never-failed');
  });
});

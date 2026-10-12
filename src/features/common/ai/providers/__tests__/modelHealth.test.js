/**
 * modelHealth.test.js
 *
 * The cooldown registry shared by the Gemini and Anthropic providers.
 * geminiModelRotator re-exports it, so its own tests keep covering Gemini.
 * Run: node --test src/features/common/ai/providers/__tests__/modelHealth.test.js
 */

'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const health = require('../modelHealth');
const rotator = require('../geminiModelRotator');
const {
  parseModelList,
  pickModel,
  markFailed,
  markSucceeded,
  resetHealth,
  DEFAULT_COOLDOWN_MS,
  MIN_COOLDOWN_MS,
  MAX_COOLDOWN_MS,
} = health;

beforeEach(() => {
  resetHealth();
});

describe('parseModelList', () => {
  it('splits, trims and drops empties', () => {
    assert.deepEqual(parseModelList(' claude-haiku-5-5 , ,claude-sonnet-5-5 '), ['claude-haiku-5-5', 'claude-sonnet-5-5']);
  });

  it('returns [] for empty, null, undefined and non-strings', () => {
    assert.deepEqual(parseModelList(''), []);
    assert.deepEqual(parseModelList(null), []);
    assert.deepEqual(parseModelList(undefined), []);
    assert.deepEqual(parseModelList(42), []);
  });
});

describe('pickModel', () => {
  it('throws on an empty list', () => {
    assert.throws(() => pickModel([]), /empty model list/i);
    assert.throws(() => pickModel(undefined), /empty model list/i);
  });

  it('returns the first healthy model in order', () => {
    assert.equal(pickModel(['claude-haiku-5-5', 'claude-sonnet-5-5']), 'claude-haiku-5-5');
    markFailed('claude-haiku-5-5', 60_000);
    assert.equal(pickModel(['claude-haiku-5-5', 'claude-sonnet-5-5']), 'claude-sonnet-5-5');
  });

  it('tries the soonest-recovering model when all are cooling down', () => {
    markFailed('a', 120_000);
    markFailed('b', 10_000);
    markFailed('c', 60_000);
    assert.equal(pickModel(['a', 'b', 'c']), 'b');
  });

  it('keeps Gemini and Claude IDs apart', () => {
    markFailed('claude-haiku-5-5', 60_000);
    assert.equal(pickModel(['gemini-3-flash-preview']), 'gemini-3-flash-preview');
  });
});

describe('markFailed', () => {
  it('clamps the cooldown to [5 s, 5 min]', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
    markFailed('low', 1);
    markFailed('high', 10 * 60_000);
    t.mock.timers.tick(MIN_COOLDOWN_MS - 1);
    assert.equal(pickModel(['low', 'x']), 'x', 'still cooling just before 5 s');
    t.mock.timers.tick(1);
    assert.equal(pickModel(['low', 'x']), 'low', 'healthy at 5 s');
    t.mock.timers.tick(MAX_COOLDOWN_MS - MIN_COOLDOWN_MS - 1);
    assert.equal(pickModel(['high', 'x']), 'x', 'still cooling just before 5 min');
    t.mock.timers.tick(1);
    assert.equal(pickModel(['high', 'x']), 'high', 'healthy at 5 min');
  });

  it('exports the cooldown bounds', () => {
    assert.equal(DEFAULT_COOLDOWN_MS, 60_000);
    assert.equal(MIN_COOLDOWN_MS, 5_000);
    assert.equal(MAX_COOLDOWN_MS, 300_000);
  });
});

describe('markSucceeded and resetHealth', () => {
  it('markSucceeded clears the cooldown', () => {
    markFailed('a', 60_000);
    assert.equal(pickModel(['a', 'b']), 'b');
    markSucceeded('a');
    assert.equal(pickModel(['a', 'b']), 'a');
  });

  it('markSucceeded on a model that never failed is a no-op', () => {
    assert.doesNotThrow(() => markSucceeded('never-failed'));
  });

  it('resetHealth clears every entry', () => {
    markFailed('a', 60_000);
    markFailed('b', 60_000);
    resetHealth();
    assert.equal(pickModel(['a', 'b']), 'a');
  });
});

describe('geminiModelRotator', () => {
  it('re-exports the very same functions', () => {
    for (const name of ['parseModelList', 'pickModel', 'markFailed', 'markSucceeded', 'resetHealth']) {
      assert.equal(rotator[name], health[name], name);
    }
  });

  it('shares one registry with the Gemini rotator', () => {
    rotator.markFailed('a', 60_000);
    assert.equal(pickModel(['a', 'b']), 'b');
    resetHealth();
    assert.equal(rotator.pickModel(['a', 'b']), 'a');
  });

  it('keeps its Gemini-only exports', () => {
    assert.equal(typeof rotator.classifyError, 'function');
    assert.equal(typeof rotator.parseRetryAfter, 'function');
  });
});

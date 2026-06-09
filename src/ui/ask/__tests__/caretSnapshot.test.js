/**
 * caretSnapshot.test.js
 *
 * Unit tests for the pure caret save/restore helpers.
 * Run: node --test src/ui/ask/__tests__/caretSnapshot.test.js
 *
 * Pure logic, no DOM/Electron coupling — mirrors liveAnswerHistory.test.js convention.
 * Contract: specs/2026-06-08-cursor-visibility-toggle/contracts/caretSnapshot.d.ts
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildSnapshot, clampRange } = require('../caretSnapshot');

describe('buildSnapshot', () => {
    it('returns a normalized {start, end} for valid integer positions', () => {
        const snap = buildSnapshot(3, 7);
        assert.deepEqual(snap, { start: 3, end: 7 });
    });

    it('returns a normalized snapshot for start === end (collapsed caret)', () => {
        const snap = buildSnapshot(5, 5);
        assert.deepEqual(snap, { start: 5, end: 5 });
    });

    it('returns a normalized snapshot when start > end (selection drag backwards)', () => {
        const snap = buildSnapshot(10, 2);
        assert.deepEqual(snap, { start: 10, end: 2 });
    });

    it('returns null when start is NaN', () => {
        assert.equal(buildSnapshot(NaN, 5), null);
    });

    it('returns null when end is NaN', () => {
        assert.equal(buildSnapshot(3, NaN), null);
    });

    it('returns null when start is undefined', () => {
        assert.equal(buildSnapshot(undefined, 5), null);
    });

    it('returns null when end is undefined', () => {
        assert.equal(buildSnapshot(0, undefined), null);
    });

    it('returns null when both are non-finite', () => {
        assert.equal(buildSnapshot(NaN, NaN), null);
    });

    it('never throws for any input', () => {
        assert.doesNotThrow(() => buildSnapshot(null, null));
        assert.doesNotThrow(() => buildSnapshot(-Infinity, Infinity));
        assert.doesNotThrow(() => buildSnapshot('a', 'b'));
    });
});

describe('clampRange', () => {
    it('returns null when snapshot is null', () => {
        assert.equal(clampRange(null, 10), null);
    });

    it('clamps start and end independently into [0, valueLength]', () => {
        // Both in range: unchanged
        assert.deepEqual(clampRange({ start: 2, end: 5 }, 10), { start: 2, end: 5 });
    });

    it('clamps start below 0 to 0', () => {
        const result = clampRange({ start: -3, end: 5 }, 10);
        assert.equal(result.start, 0);
        assert.equal(result.end, 5);
    });

    it('clamps end above valueLength to valueLength', () => {
        const result = clampRange({ start: 2, end: 20 }, 10);
        assert.equal(result.start, 2);
        assert.equal(result.end, 10);
    });

    it('swaps start and end if inverted after clamping', () => {
        // start clamped to 8, end clamped to 3 -> inverted -> swap to {start:3, end:8}
        const result = clampRange({ start: 20, end: 3 }, 8);
        assert.equal(result.start, 3);
        assert.equal(result.end, 8);
    });

    it('returns caret-at-end when range falls entirely past valueLength', () => {
        // start=15, end=20, valueLength=10 -> both clamp to 10 -> {start:10, end:10}
        const result = clampRange({ start: 15, end: 20 }, 10);
        assert.deepEqual(result, { start: 10, end: 10 });
    });

    it('handles valueLength === 0 (empty input)', () => {
        const result = clampRange({ start: 3, end: 7 }, 0);
        assert.deepEqual(result, { start: 0, end: 0 });
    });

    it('never throws for any input', () => {
        assert.doesNotThrow(() => clampRange({ start: -Infinity, end: Infinity }, 5));
        assert.doesNotThrow(() => clampRange({ start: NaN, end: NaN }, 5));
    });
});

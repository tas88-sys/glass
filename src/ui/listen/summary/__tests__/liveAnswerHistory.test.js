/**
 * liveAnswerHistory.test.js
 *
 * Unit tests for the Live Answer in-session history reducer (newest-first).
 * Run: node --test src/ui/listen/summary/__tests__/liveAnswerHistory.test.js
 *
 * Pure logic, no Lit/DOM coupling (FR-018/C6 convention).
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { applyLiveAnswerUpdate, applyLiveAnswerStatus, MAX_ANSWERS } = require('../liveAnswerHistory');

describe('applyLiveAnswerUpdate', () => {
    it('ignores a payload with no answer text (returns the same reference)', () => {
        const answers = [{ id: '1', question: 'q', text: 'a', ts: 1 }];
        assert.equal(applyLiveAnswerUpdate(answers, { id: '1' }), answers);
        assert.equal(applyLiveAnswerUpdate(answers, null), answers);
        assert.equal(applyLiveAnswerUpdate(answers, {}), answers);
    });

    it('prepends the first answer with its question + text', () => {
        const out = applyLiveAnswerUpdate([], { id: 1, question: 'How does GC work?', answer: 'It...', ts: 100 });
        assert.equal(out.length, 1);
        assert.deepEqual(out[0], { id: '1', question: 'How does GC work?', text: 'It...', ts: 100 });
    });

    it('coalesces streaming deltas for the same id into one entry (update in place)', () => {
        let out = applyLiveAnswerUpdate([], { id: 1, question: 'Q', answer: 'A Go', ts: 100 });
        out = applyLiveAnswerUpdate(out, { id: 1, answer: 'A Go channel', ts: 101 });
        out = applyLiveAnswerUpdate(out, { id: 1, answer: 'A Go channel is...', ts: 102 });
        assert.equal(out.length, 1, 'one answer, not three');
        assert.equal(out[0].text, 'A Go channel is...');
        assert.equal(out[0].question, 'Q', 'question preserved across deltas');
    });

    it('keeps the existing ts when a delta omits ts', () => {
        let out = applyLiveAnswerUpdate([], { id: 1, answer: 'a', ts: 100 });
        out = applyLiveAnswerUpdate(out, { id: 1, answer: 'ab' });
        assert.equal(out[0].ts, 100);
    });

    it('puts a new question on top (newest-first)', () => {
        let out = applyLiveAnswerUpdate([], { id: 1, question: 'first', answer: 'A1' });
        out = applyLiveAnswerUpdate(out, { id: 2, question: 'second', answer: 'A2' });
        assert.equal(out.length, 2);
        assert.equal(out[0].id, '2', 'newest on top');
        assert.equal(out[1].id, '1');
    });

    it('caps the history and drops the oldest (tail)', () => {
        let out = [];
        for (let i = 1; i <= 5; i++) {
            out = applyLiveAnswerUpdate(out, { id: i, answer: `A${i}` }, 3);
        }
        assert.equal(out.length, 3);
        assert.deepEqual(out.map(a => a.id), ['5', '4', '3'], 'newest kept, oldest dropped');
    });

    it('treats a payload with no id as always-new (never coalesces on undefined)', () => {
        let out = applyLiveAnswerUpdate([], { answer: 'same text' });
        out = applyLiveAnswerUpdate(out, { answer: 'same text' });
        assert.equal(out.length, 2, 'two distinct entries despite identical text');
        assert.notEqual(out[0].id, out[1].id, 'fallback ids are unique');
    });

    it('normalizes numeric ids to strings (matches data-answer-id attribute lookup)', () => {
        const out = applyLiveAnswerUpdate([], { id: 42, answer: 'a' });
        assert.equal(out[0].id, '42');
        assert.equal(typeof out[0].id, 'string');
    });

    it('does not mutate the input array', () => {
        const answers = [{ id: '1', question: 'q', text: 'a', ts: 1 }];
        const snapshot = JSON.parse(JSON.stringify(answers));
        applyLiveAnswerUpdate(answers, { id: 2, answer: 'b' });
        applyLiveAnswerUpdate(answers, { id: 1, answer: 'updated' });
        assert.deepEqual(answers, snapshot, 'original array untouched');
    });

    it('exposes a sane default cap', () => {
        assert.equal(typeof MAX_ANSWERS, 'number');
        assert.ok(MAX_ANSWERS > 0);
    });
});

describe('applyLiveAnswerStatus', () => {
    it('status payloads are ignored by the history (no answer text)', () => {
        const answers = [{ id: '1', question: 'q', text: 'a', ts: 1 }];
        assert.equal(applyLiveAnswerUpdate(answers, { id: 2, status: 'retrying', model: 'm' }), answers);
        assert.equal(applyLiveAnswerUpdate(answers, { id: 2, status: 'error', error: 'x' }), answers);
    });

    it("'retrying' shows the model being tried", () => {
        assert.deepEqual(
            applyLiveAnswerStatus(null, { id: 3, status: 'retrying', model: 'gemini-3.1-flash-lite' }),
            { kind: 'retrying', id: '3', model: 'gemini-3.1-flash-lite' },
        );
        assert.deepEqual(applyLiveAnswerStatus(null, { id: 3, status: 'retrying' }), { kind: 'retrying', id: '3', model: null });
    });

    it("'error' carries the message and replaces a 'retrying' status", () => {
        const retrying = applyLiveAnswerStatus(null, { id: 3, status: 'retrying', model: 'm' });
        assert.deepEqual(
            applyLiveAnswerStatus(retrying, { id: 3, status: 'error', error: 'All Gemini models failed' }),
            { kind: 'error', id: '3', message: 'All Gemini models failed' },
        );
    });

    it("'idle' clears a 'retrying' status of the same id only", () => {
        const retrying = applyLiveAnswerStatus(null, { id: 3, status: 'retrying', model: 'm' });
        assert.equal(applyLiveAnswerStatus(retrying, { id: 3, status: 'idle' }), null);
        assert.equal(applyLiveAnswerStatus(retrying, { id: 2, status: 'idle' }), retrying, 'an older answer must not clear a newer status');
    });

    it("'idle' keeps an error on screen", () => {
        const error = applyLiveAnswerStatus(null, { id: 3, status: 'error', error: 'x' });
        assert.equal(applyLiveAnswerStatus(error, { id: 3, status: 'idle' }), error);
    });

    it('an answer delta (any id) clears the status', () => {
        const retrying = applyLiveAnswerStatus(null, { id: 3, status: 'retrying', model: 'm' });
        assert.equal(applyLiveAnswerStatus(retrying, { id: 3, answer: 'It...' }), null);
        const error = applyLiveAnswerStatus(null, { id: 3, status: 'error', error: 'x' });
        assert.equal(applyLiveAnswerStatus(error, { id: 4, answer: 'Next answer' }), null);
    });

    it('unknown payloads return the same reference', () => {
        const error = applyLiveAnswerStatus(null, { id: 3, status: 'error', error: 'x' });
        assert.equal(applyLiveAnswerStatus(error, null), error);
        assert.equal(applyLiveAnswerStatus(error, { id: 3 }), error);
        assert.equal(applyLiveAnswerStatus(null, { id: 3, answer: 'a' }), null);
    });
});

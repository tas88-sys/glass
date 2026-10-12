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

// Career context (spec 2026-10-11, FR-015): note titles used for an answer.
describe('applyLiveAnswerUpdate: sources', () => {
    it('stores sources on create', () => {
        const out = applyLiveAnswerUpdate([], { id: 1, question: 'Q', answer: 'A', ts: 1, sources: ['notes › Story', 'canonical facts'] });
        assert.deepEqual(out[0].sources, ['notes › Story', 'canonical facts']);
    });

    it('preserves sources on streaming updates of the same id', () => {
        const sources = ['notes › Story'];
        let out = applyLiveAnswerUpdate([], { id: 1, answer: 'A', sources });
        out = applyLiveAnswerUpdate(out, { id: 1, answer: 'AB', sources });
        out = applyLiveAnswerUpdate(out, { id: 1, answer: 'ABC' });
        assert.equal(out.length, 1);
        assert.deepEqual(out[0].sources, sources);
        assert.equal(out[0].text, 'ABC');
    });

    it('does not share the payload array with the entry', () => {
        const sources = ['notes › Story'];
        const out = applyLiveAnswerUpdate([], { id: 1, answer: 'A', sources });
        sources.push('mutated');
        assert.deepEqual(out[0].sources, ['notes › Story']);
    });

    it('entries without sources stay without (no key)', () => {
        let out = applyLiveAnswerUpdate([], { id: 1, answer: 'A' });
        out = applyLiveAnswerUpdate(out, { id: 1, answer: 'AB' });
        out = applyLiveAnswerUpdate(out, { id: 2, answer: 'B', sources: [] });
        out = applyLiveAnswerUpdate(out, { id: 3, answer: 'C', sources: 'not-an-array' });
        for (const a of out) assert.ok(!('sources' in a), `entry ${a.id}`);
    });

    it('sources of one answer never land on another id', () => {
        let out = applyLiveAnswerUpdate([], { id: 1, answer: 'A', sources: ['notes › Story'] });
        out = applyLiveAnswerUpdate(out, { id: 2, answer: 'B' });
        assert.ok(!('sources' in out[0]));
        assert.deepEqual(out[1].sources, ['notes › Story']);
    });
});

// Career context (spec 2026-10-11, FR-021): numbers and names the notes do not have.
describe('applyLiveAnswerUpdate: unverified', () => {
    it('stores unverified from the last payload of a streamed answer', () => {
        let out = applyLiveAnswerUpdate([], { id: 1, answer: 'A', sources: ['notes › Story'] });
        out = applyLiveAnswerUpdate(out, { id: 1, answer: 'AB' });
        out = applyLiveAnswerUpdate(out, { id: 1, answer: 'AB', unverified: ['40%', 'Bridge'] });
        assert.equal(out.length, 1);
        assert.deepEqual(out[0].unverified, ['40%', 'Bridge']);
        assert.deepEqual(out[0].sources, ['notes › Story']);
        assert.equal(out[0].text, 'AB');
    });

    it('stores unverified on create and keeps it on later payloads', () => {
        let out = applyLiveAnswerUpdate([], { id: 1, answer: 'A', unverified: ['7'] });
        out = applyLiveAnswerUpdate(out, { id: 1, answer: 'A' });
        assert.deepEqual(out[0].unverified, ['7']);
    });

    it('does not share the payload array with the entry', () => {
        const unverified = ['40%'];
        const out = applyLiveAnswerUpdate([], { id: 1, answer: 'A', unverified });
        unverified.push('mutated');
        assert.deepEqual(out[0].unverified, ['40%']);
    });

    it('entries without it stay without (no key), and it never lands on another id', () => {
        let out = applyLiveAnswerUpdate([], { id: 1, answer: 'A', unverified: ['40%'] });
        out = applyLiveAnswerUpdate(out, { id: 2, answer: 'B', unverified: [] });
        out = applyLiveAnswerUpdate(out, { id: 3, answer: 'C', unverified: 'not-an-array' });
        assert.ok(!('unverified' in out[0]) && !('unverified' in out[1]));
        assert.deepEqual(out[2].unverified, ['40%']);
    });
});

// Live features FR-014 (spec 2026-10-12-live-features-toggle): with only Answer
// on, the copy button copies the answers as text.
const { answersToText } = require('../liveAnswerHistory');

describe('answersToText', () => {
    it('returns an empty string for no answers or a non-array', () => {
        assert.equal(answersToText([]), '');
        assert.equal(answersToText(null), '');
        assert.equal(answersToText(undefined), '');
        assert.equal(answersToText('Q1\nA1'), '');
    });

    it('writes each answer under its question, newest first, a blank line between them', () => {
        const answers = [
            { id: '2', question: 'Q2', text: 'A2', ts: 2 },
            { id: '1', question: 'Q1', text: 'A1', ts: 1 },
        ];
        assert.equal(answersToText(answers), 'Q2\nA2\n\nQ1\nA1');
    });

    it('writes an answer without a question as its text alone', () => {
        assert.equal(answersToText([{ id: '1', text: 'A' }]), 'A');
        assert.equal(answersToText([{ id: '2', question: '', text: 'B' }, { id: '1', question: 'Q1', text: 'A1' }]), 'B\n\nQ1\nA1');
    });

    it('skips an answer with no text, empty text or only whitespace', () => {
        const answers = [
            { id: '4', question: 'Q4' },
            { id: '3', question: 'Q3', text: '' },
            { id: '2', question: 'Q2', text: '  \n ' },
            { id: '1', question: 'Q1', text: 'A1' },
        ];
        assert.equal(answersToText(answers), 'Q1\nA1');
        assert.equal(answersToText([{ question: 'Q', text: '' }, { text: 'B' }]), 'B');
    });

    it('keeps the answer text as it is, bullets and line breaks included', () => {
        const text = 'Headline.\n- point one\n- point two';
        assert.equal(answersToText([{ id: '1', question: 'Q1', text }]), `Q1\n${text}`);
    });

    it('ends a single answer with no trailing blank line', () => {
        const out = answersToText([{ id: '1', question: 'Q1', text: 'A1' }]);
        assert.equal(out, 'Q1\nA1');
        assert.ok(!out.endsWith('\n'));
    });

    it('does not change its input', () => {
        const answers = [
            { id: '2', question: 'Q2', text: 'A2', ts: 2, sources: ['notes'] },
            { id: '1', question: 'Q1', text: 'A1', ts: 1 },
        ];
        const copy = JSON.parse(JSON.stringify(answers));
        answersToText(answers);
        assert.deepEqual(answers, copy);
    });
});

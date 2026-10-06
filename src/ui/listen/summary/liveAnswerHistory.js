'use strict';

/**
 * liveAnswerHistory.js
 *
 * Pure reducer for the Live Answer in-session history (newest-first). Extracted
 * from LiveAnswerView so it is directly unit-testable with node:test, with no
 * Lit/DOM coupling (mirrors the FR-018/C6 "pure helpers" convention).
 *
 * In-session only — NOT persisted (spec C8). The view clears it on session
 * reset via resetAnswer().
 */

/** Default cap on retained in-session answers (bounds DOM + memory). */
const MAX_ANSWERS = 20;

/**
 * Fold one `live-answer-update` payload into the current answers array.
 *
 *  - A payload whose `id` matches an existing entry updates that entry's text
 *    in place — streaming deltas for ONE answer coalesce into ONE entry.
 *  - A payload with a new `id` is prepended (newest on top); entries past
 *    `max` are dropped from the tail (oldest).
 *  - A payload with no `id` is always treated as a new entry (defensive: the
 *    service always sends an id, but we never coalesce blindly on undefined).
 *  - A payload with no `answer` text returns the input unchanged.
 *
 * Returns a NEW array (never mutates the input) so it can drive reactive state.
 *
 * @param {Array<{id:string,question:string,text:string,ts:number}>} answers
 * @param {{id?:(string|number), question?:string, answer?:string, ts?:number}} data
 * @param {number} [max=MAX_ANSWERS]
 * @returns {Array<{id:string,question:string,text:string,ts:number}>}
 */
function applyLiveAnswerUpdate(answers, data, max = MAX_ANSWERS) {
    if (!data || !data.answer) return answers;

    const hasId = data.id != null;
    const id = hasId
        ? String(data.id)
        : `t${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const list = answers.slice();

    const idx = hasId ? list.findIndex(a => a.id === id) : -1;
    if (idx >= 0) {
        // Streaming delta for an answer we already track — update in place.
        list[idx] = { ...list[idx], text: data.answer, ts: data.ts || list[idx].ts };
        return list;
    }

    // New question's answer — newest on top, drop the oldest past the cap.
    list.unshift({
        id,
        question: data.question || '',
        text: data.answer,
        ts: data.ts || Date.now(),
    });
    if (list.length > max) list.length = max;
    return list;
}

/**
 * Fold one `live-answer-update` payload into the lane status line (shown under
 * the "Live Answer" eyebrow, separate from the answer history):
 *
 *  - `status: 'retrying'` → "Trying <model>…" while the service fails over.
 *  - `status: 'error'`    → why the latest question got no answer; it stays
 *                           until an answer starts or another status replaces it.
 *  - `status: 'idle'`     → clears a 'retrying' status of the SAME id only (an
 *                           older answer finishing must not hide a newer status,
 *                           and an error is kept).
 *  - a payload with `answer` text (any id) → clears the status: an answer is
 *    streaming again.
 *  - anything else → the same reference (no re-render).
 *
 * @param {null|{kind:'retrying'|'error', id:string, model?:(string|null), message?:string}} status
 * @param {{id?:(string|number), status?:string, model?:string, error?:string, answer?:string}} data
 * @returns {null|{kind:'retrying'|'error', id:string, model?:(string|null), message?:string}}
 */
function applyLiveAnswerStatus(status, data) {
    if (!data) return status;
    const id = data.id != null ? String(data.id) : null;

    if (data.status === 'retrying') return { kind: 'retrying', id, model: data.model || null };
    if (data.status === 'error') return { kind: 'error', id, message: data.error || 'No answer.' };
    if (data.status === 'idle') {
        return status && status.kind === 'retrying' && status.id === id ? null : status;
    }
    if (data.answer) return status ? null : status;
    return status;
}

module.exports = { applyLiveAnswerUpdate, applyLiveAnswerStatus, MAX_ANSWERS };

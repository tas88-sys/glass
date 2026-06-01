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

module.exports = { applyLiveAnswerUpdate, MAX_ANSWERS };

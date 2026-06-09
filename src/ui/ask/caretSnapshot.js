/**
 * caretSnapshot.js
 *
 * Pure caret save/restore helpers for the Ask text input.
 * No DOM or Electron imports — runs headless under node:test.
 *
 * Contract: specs/2026-06-08-cursor-visibility-toggle/contracts/caretSnapshot.d.ts
 * Implements FR-002: preserve caret position (selection start/end) across hide→show toggle.
 *
 * Mirror of the co-located pure-helper pattern in
 * src/ui/listen/summary/liveAnswerHistory.js.
 */

'use strict';

/**
 * Build a normalized caret snapshot from raw selectionStart/selectionEnd values.
 * Returns null when either argument is not a finite number (graceful guard).
 *
 * @param {number} start - selectionStart from the input element
 * @param {number} end   - selectionEnd from the input element
 * @returns {{ start: number, end: number } | null}
 */
function buildSnapshot(start, end) {
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
        return null;
    }
    return { start, end };
}

/**
 * Clamp a snapshot's start and end independently into [0, valueLength].
 * - null in → null out.
 * - start/end clamp independently; if inverted after clamp, they are swapped.
 * - If the range falls entirely past the end, returns { start: valueLength, end: valueLength }
 *   (caret-at-end fallback). Never throws.
 *
 * @param {{ start: number, end: number } | null} snapshot
 * @param {number} valueLength - current length of the input value
 * @returns {{ start: number, end: number } | null}
 */
function clampRange(snapshot, valueLength) {
    if (snapshot === null || snapshot === undefined) {
        return null;
    }

    try {
        const len = Number.isFinite(valueLength) ? Math.max(0, valueLength) : 0;
        let s = Number.isFinite(snapshot.start) ? Math.max(0, Math.min(snapshot.start, len)) : 0;
        let e = Number.isFinite(snapshot.end)   ? Math.max(0, Math.min(snapshot.end,   len)) : 0;

        // Swap if inverted after clamping
        if (s > e) {
            [s, e] = [e, s];
        }

        return { start: s, end: e };
    } catch (_) {
        return null;
    }
}

module.exports = { buildSnapshot, clampRange };

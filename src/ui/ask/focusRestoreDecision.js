/**
 * focusRestoreDecision.js
 *
 * Pure focus-restore decision helpers for the Ask text input.
 * No DOM or Electron imports — runs headless under node:test.
 *
 * Contract: specs/2026-06-08-cursor-visibility-toggle/contracts/focusRestoreDecision.d.ts
 *
 * Encodes FR-004 no-steal guard:
 *   - A blur that coincides with document.hidden===true AND isInputFocused===true is
 *     hide-induced and PRESERVES the snapshot + focus state.
 *   - Any other blur is genuine and CLEARS the snapshot + focus state.
 *
 * This distinction is the key to preventing focus theft when the user was not
 * typing in the Ask input before the hide/show toggle.
 */

'use strict';

/**
 * Decide what to do with the caret snapshot when #textInput blurs.
 *
 * @param {boolean} documentHidden   - current value of document.hidden at blur time
 * @param {boolean} isInputFocused   - whether the input was considered focused before blur
 * @param {() => { start: number, end: number }} snapshotFactory - closure to read live caret
 * @returns {{ snapshot: { start: number, end: number } | null, isInputFocused: boolean }}
 */
function onBlur(documentHidden, isInputFocused, snapshotFactory) {
    // Hide-induced blur: document is hidden AND the input was focused
    // -> PRESERVE: capture snapshot, keep isInputFocused true
    if (documentHidden === true && isInputFocused === true) {
        return {
            snapshot: snapshotFactory(),
            isInputFocused: true,
        };
    }

    // Genuine blur (user navigated away, clicked elsewhere, etc.)
    // -> CLEAR: null snapshot, reset flag
    return {
        snapshot: null,
        isInputFocused: false,
    };
}

/**
 * The single FR-004 gate: should focus be restored on visibilitychange→visible?
 * Returns true iff a valid snapshot exists (input was focused at hide time).
 *
 * @param {{ start: number, end: number } | null | undefined} snapshot
 * @returns {boolean}
 */
function shouldRestoreOnVisible(snapshot) {
    return snapshot !== null && snapshot !== undefined;
}

module.exports = { onBlur, shouldRestoreOnVisible };

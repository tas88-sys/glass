// Contract: focusRestoreDecision.js — pure blur-guard + show-eligibility (no DOM/Electron).
// Validated with: npx tsc --noEmit specs/2026-06-08-cursor-visibility-toggle/contracts/*.d.ts
// Encodes FR-004 (no-steal) and the D2/D3 hide-induced-vs-genuine-blur distinction.

import type { CaretSnapshot } from "./caretSnapshot";

/** Result of evaluating a blur event against the focus snapshot state. */
export interface BlurDecision {
  /** The snapshot to keep: the captured range (hide-induced) or null (genuine blur). */
  snapshot: CaretSnapshot | null;
  /** The next value of the isInputFocused flag. */
  isInputFocused: boolean;
}

/**
 * Decide what to do with the caret snapshot when #textInput blurs.
 * - documentHidden === true AND isInputFocused === true -> hide-induced: PRESERVE
 *   (snapshot = snapshotFactory(), isInputFocused stays true).
 * - otherwise -> genuine blur: CLEAR (snapshot = null, isInputFocused = false).
 * snapshotFactory is a caller closure that reads the live selection at blur time,
 * keeping this module DOM-free and unit-testable with a stub.
 */
export function onBlur(
  documentHidden: boolean,
  isInputFocused: boolean,
  snapshotFactory: () => CaretSnapshot
): BlurDecision;

/**
 * The single FR-004 gate: restore focus on visibilitychange->visible
 * iff a snapshot exists. No snapshot -> false -> no focus steal.
 */
export function shouldRestoreOnVisible(snapshot: CaretSnapshot | null): boolean;

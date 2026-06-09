// Contract: caretSnapshot.js — pure caret save/restore helpers (no DOM/Electron).
// Validated with: npx tsc --noEmit specs/2026-06-08-cursor-visibility-toggle/contracts/*.d.ts
// Runtime module is plain JS (src/ui/ask/caretSnapshot.js); this .d.ts is the type contract only.

/** A normalized caret selection range within #textInput. */
export interface CaretSnapshot {
  start: number;
  end: number;
}

/**
 * Build a normalized snapshot from raw selectionStart/selectionEnd values.
 * Returns null if either value is not a finite number (FR-002 graceful guard).
 */
export function buildSnapshot(start: number, end: number): CaretSnapshot | null;

/**
 * Clamp a snapshot's start/end into [0, valueLength].
 * - null in -> null out.
 * - start/end clamp independently; if inverted after clamp, they are swapped.
 * - if the range falls entirely past the end, returns { start: valueLength, end: valueLength }
 *   (caret-at-end fallback). Never throws.
 */
export function clampRange(
  snapshot: CaretSnapshot | null,
  valueLength: number
): CaretSnapshot | null;

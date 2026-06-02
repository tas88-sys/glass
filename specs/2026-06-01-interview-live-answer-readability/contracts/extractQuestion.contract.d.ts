/**
 * Contract: extractQuestion (Improvement 2 — question-label extraction)
 *
 * The single NEW interface this spec introduces. A pure, total helper that
 * isolates the interrogative span from an interviewer turn, reusing the SAME
 * question signals as isLikelyQuestion (CLAUSE_LEAD_RE / LEAD_STRIP_RE /
 * CONTENT_CUE_RE / EMBEDDED_Q_RE at summaryService.js:38,41,44,55).
 *
 * Source of truth (truth-table): ../data-model.md §E3. FR-006/FR-007/FR-009.
 *
 * Runtime is JavaScript (summaryService.js); this .d.ts pins the shape and the
 * total/guarded contract for tsc --noEmit verification (Phase 0.3 gate).
 */

/**
 * Isolate the interrogative span carrying the question signal.
 *
 * Total function — defined for EVERY input, never throws, never returns
 * null/undefined:
 *   - clean wh-question that IS the whole sentence  -> that sentence (trimmed)        [T1]
 *   - filler-wrapped question                       -> the isolated interrogative span [T2]
 *   - bare cue / no isolatable wh-span              -> the full trimmed turn           [T3,T4]
 *   - multiple questions in one turn                -> the LAST signal-bearing clause  [T5]
 *   - empty / whitespace                            -> "" (empty string)               [T6]
 *   - null / undefined / non-string                 -> "" (empty string)               [T7]
 *   - declarative, no signal                        -> the full trimmed turn           [T8]
 *
 * @param text An interviewer turn (the raw `them:` turn string). Typed `unknown`
 *             to encode the non-string guard (FR-007): callers may pass anything.
 * @returns The isolated interrogative span, the trimmed full text on no-span,
 *          or "" for empty/non-string input. Always a string.
 */
export declare function extractQuestion(text: unknown): string;

/**
 * The injected user message element amended by Improvement 1 (FR-001/FR-003).
 * Read-only contract documentation — this spec changes only `content` (the
 * `role` stays `'user'`); the EXACT-PASSIVE directive is preserved verbatim.
 * The element shape itself is UNCHANGED; pinned here so contributors do not
 * alter the array structure (FR-005).
 */
export interface InjectedUserMessage {
  readonly role: 'user';
  /** Amended string: always-on headline+bullets reinforcement + preserved
   *  "reply EXACTLY: PASSIVE" directive. Content only — shape unchanged. */
  content: string;
}

/**
 * The live-answer-update payload — UNCHANGED by this spec. Only the *value* of
 * `question` changes (raw turn -> extractQuestion(text)); the field, type,
 * channel, and renderer are untouched (FR-008). Pinned to prevent drift.
 */
export interface LiveAnswerUpdate {
  id: number;
  /** Now carries the extracted span instead of the raw turn (value-only change). */
  question: string;
  answer: string;
  ts: number;
}

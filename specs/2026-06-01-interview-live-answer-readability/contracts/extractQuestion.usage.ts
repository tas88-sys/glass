/**
 * Contract usage check — exercises extractQuestion's typed contract so
 * `tsc --noEmit` validates real call sites, not just the declaration.
 * This file is verification-only; it is not shipped or imported at runtime.
 */
import { extractQuestion, InjectedUserMessage, LiveAnswerUpdate } from './extractQuestion.contract';

// Always returns string (T1, T8): assignable to string, usable as a string.
const clean: string = extractQuestion('how does garbage collection work in Go?');
const filler: string = extractQuestion('okay so, um, how would you design a rate limiter?'); // T2
const upper: number = clean.length + filler.length;

// Non-string / empty guards (T6, T7): unknown param accepts anything, still string out.
const fromNull: string = extractQuestion(null);
const fromUndef: string = extractQuestion(undefined);
const fromNumber: string = extractQuestion(42);
const fromEmpty: string = extractQuestion('');

// The label wiring at summaryService.js:451 — value-only change on the payload.
const update: LiveAnswerUpdate = {
  id: 1,
  question: extractQuestion('What is a closure?'), // T1 — was: the raw turn
  answer: '- headline\n- point',
  ts: Date.now(),
};

// The injected user message: role pinned to 'user', only content is amended.
const msg: InjectedUserMessage = {
  role: 'user',
  content:
    "Answer the interviewer's most recent question directly and concisely. " +
    'Format as a short headline followed by markdown bullet points when there are supporting points. ' +
    'If there is no clear question or nothing useful to answer, reply EXACTLY: PASSIVE',
};

// Touch the bindings so noUnusedLocals does not flag them.
export const _check = { upper, fromNull, fromUndef, fromNumber, fromEmpty, update, msg };

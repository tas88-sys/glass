/**
 * live-answer.contracts.d.ts
 *
 * Phase 1 contract (DESIGN ARTIFACT — not wired into the build).
 *
 * The `glass` repo is plain CommonJS JavaScript with no TypeScript toolchain.
 * This ambient declaration file documents the exact shapes that /tasks and
 * /implement MUST honor for the Interview Live Answer Lane:
 *   - the pure helpers (FR-002/FR-004/FR-010/FR-018, extracted for node:test),
 *   - the summaryService additive surface (FR-001/FR-008/FR-009/FR-011),
 *   - the live-answer-update IPC payload (FR-013),
 *   - the LiveAnswerView renderer surface (FR-014/FR-015/FR-016).
 *
 * Validate with:  npx tsc --noEmit --strict specs/2026-05-30-interview-live-answer/contracts/live-answer.contracts.d.ts
 * Expected:       Found 0 errors.  (declaration-only self-consistency check)
 *
 * LOCKED: C1–C8, D1–D4, Q1 — see spec.md. Do not re-derive.
 */

// ───────────────────────────────────────────────────────────────────────────
// Pure helpers (no I/O, no timers, no `this`) — directly unit-testable.
// ───────────────────────────────────────────────────────────────────────────

/**
 * FR-002 — recall-oriented question heuristic.
 * true when `text` ends with '?' OR opens (case-insensitive, trimmed) with one
 * of the question openers. When uncertain, favor `true` (PASSIVE suppresses).
 */
export declare function isLikelyQuestion(text: string): boolean;

/**
 * FR-010 — normalize a buffered stream prefix for suppress comparison:
 * strip markdown emphasis (* _ ` #), strip surrounding punctuation,
 * collapse + trim whitespace, uppercase.
 */
export declare function normalizePassive(text: string): string;

/** FR-010 — result of inspecting the buffered stream prefix. */
export interface PassiveDecision {
  /** true → suppress (emit nothing, hold last answer). */
  passive: boolean;
  /** When not passive, the buffered prefix text to flush/render. Empty when passive. */
  flush: string;
}

/**
 * FR-010 — decide suppress-vs-render from the buffered prefix
 * (≤ first newline or ~16 chars). passive when normalizePassive(prefix) is
 * 'PASSIVE' or matches the normalized native phrase
 * ("Not sure what you need help with right now", promptTemplates.js:388).
 */
export declare function parseAnswerOrPassive(prefix: string): PassiveDecision;

/**
 * FR-001 + FR-004 — trigger DECISION only (debounce/timer live in the
 * orchestrator). false when: speaker is not 'them'; or text is not a likely
 * question; or the normalized tail equals `lastAnsweredTail`. The orchestrator
 * separately handles abort-and-replace when `inFlight` and the tail is new.
 */
export declare function shouldTriggerAnswer(
  speaker: string,
  text: string,
  lastAnsweredTail: string | null,
  inFlight: boolean
): boolean;

// ───────────────────────────────────────────────────────────────────────────
// IPC payload (FR-013) — channel 'live-answer-update'.
// ───────────────────────────────────────────────────────────────────────────

/** Payload sent main→renderer on each non-suppressed delta. */
export interface LiveAnswerUpdatePayload {
  /** Full accumulated markdown answer text so far. */
  answer: string;
  /** Date.now() at emit time. */
  ts: number;
}

// ───────────────────────────────────────────────────────────────────────────
// Service additive surface (summaryService.js) — FR-001/FR-008/FR-009/FR-011.
// ───────────────────────────────────────────────────────────────────────────

/** Transient result of a single live-answer generation. */
export interface LiveAnswerResult {
  answer: string;
  ts: number;
}

/** Minimal model info returned by modelStateService.getCurrentModelInfo('llm'). */
export interface ModelInfo {
  provider: string;
  apiKey: string;
  model: string;
}

/**
 * The streaming-LLM seam consumed by makeLiveAnswer (factory.js:128).
 * Two-arg create (C1/FR-008); streamChat returns a fetch-style Response whose
 * body is read as an SSE stream.
 */
export interface StreamingLLM {
  streamChat(messages: ReadonlyArray<ChatMessage>): Promise<StreamResponse>;
}
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}
export interface StreamResponse {
  body: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
      cancel(reason?: unknown): Promise<void>;
    };
  };
}

/**
 * Additive methods on SummaryService. (Declared standalone here; in the impl
 * they are instance methods. resetLiveAnswer is invoked from
 * resetConversationHistory — C4/FR-011 — NOT from listenService.js, D4.)
 */
export interface LiveAnswerServiceSurface {
  /** FR-001/FR-003/FR-004 — gate + debounce; called from addConversationTurn. */
  triggerAnswerIfNeeded(speaker: string, text: string): void;

  /**
   * FR-006/FR-008/FR-009/FR-010 — thin streaming orchestrator. Resolves the
   * model (two-arg createStreamingLLM), consumes the SSE stream like
   * askService._processStream, applies streaming-aware PASSIVE before render,
   * emits LiveAnswerUpdatePayload on 'live-answer-update'. Returns the final
   * result, or null when suppressed/aborted/no-model.
   */
  makeLiveAnswer(
    conversationTexts: ReadonlyArray<string>
  ): Promise<LiveAnswerResult | null>;

  /**
   * FR-011 — clears the debounce timer, aborts the in-flight stream, clears
   * lastAnsweredTail + inFlight. Folded INTO resetConversationHistory().
   */
  resetLiveAnswer(): void;
}

// ───────────────────────────────────────────────────────────────────────────
// Renderer surface (LiveAnswerView.js) — FR-014/FR-015/FR-016.
// ───────────────────────────────────────────────────────────────────────────

/** Public surface of the <live-answer-view> Lit element. */
export interface LiveAnswerViewSurface {
  /** Reactive: full accumulated answer markdown (bound from IPC). */
  liveAnswer: string;
  /** Reactive: visibility, bound to `viewMode === 'insights'`. */
  isVisible: boolean;
  /** FR-016 — clear the rendered answer on session reset. */
  resetAnswer(): void;
}

// ───────────────────────────────────────────────────────────────────────────
// Preload additions (FR-013) — two listeners in the existing summaryView ns.
// ───────────────────────────────────────────────────────────────────────────

export interface SummaryViewPreloadAdditions {
  /** ipcRenderer.on('live-answer-update', cb) */
  onLiveAnswerUpdate(cb: (event: unknown, data: LiveAnswerUpdatePayload) => void): void;
  /** ipcRenderer.removeAllListeners('live-answer-update') */
  removeAllLiveAnswerUpdateListeners(): void;
}

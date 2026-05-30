/**
 * stt-lifecycle.contracts.ts
 *
 * TypeScript CONTRACTS for the "Improve STT Session Robustness" spec.
 *
 * The glass app is plain JS (no TS build). These interfaces are a typed
 * specification of the new/changed runtime shapes and IPC payloads, validated
 * with `tsc --noEmit` (plan-template Phase 0.3 gate). They are NOT imported by
 * runtime code; they document the contract the implementation must satisfy.
 *
 * Validate:  cd specs/2026-05-30-improve-STT-sessions/contracts && npx tsc --noEmit stt-lifecycle.contracts.ts
 */

/* ──────────────────────────────────────────────────────────────────────────
 * 1. Provider STT session wrapper (createSTT return value)
 *    Existing: sendRealtimeInput + close. NEW: readiness probe (FR-3.1).
 * ────────────────────────────────────────────────────────────────────────── */

/** WebSocket readyState numeric values (ws / browser WebSocket). */
export type WsReadyState = 0 /*CONNECTING*/ | 1 /*OPEN*/ | 2 /*CLOSING*/ | 3 /*CLOSED*/;

export interface SttSessionWrapper {
  /** Send one PCM/base64/Buffer audio chunk. Throws on a dead socket (caller guards). */
  sendRealtimeInput(payload: ArrayBuffer | Buffer | string | object): void | Promise<void>;
  /**
   * Close deliberately. MUST close with code 1000 / reason 'client'
   * (deepgram.js:72) — the reconnect filter (D2) keys on exactly this.
   */
  close(): void;
  /** FR-3.1 deep-liveness: expose socket health so isSessionActive() is honest. */
  readyState?: WsReadyState;
  /** FR-3.1 alternative form; at least one of readyState/isOpen must be present. */
  isOpen?(): boolean;
}

/** Close/Error event surfaced by the provider wrapper (deepgram.js:84-86). */
export interface SttCloseEvent {
  code: number;
  reason: string;
}

/** D2 predicate: a close is DELIBERATE (do NOT reconnect) iff this is true. */
export type IsDeliberateClose = (e: SttCloseEvent) => boolean;
// reference impl the code must match:
export const isDeliberateClose: IsDeliberateClose = (e) =>
  e.code === 1000 && e.reason === 'client';

/* ──────────────────────────────────────────────────────────────────────────
 * 2. Audio IPC payload (renderer → main) — FR-2.4 adds `generation`
 *    Channels: listen:sendMicAudio (featureBridge.js:149),
 *              listen:sendSystemAudio (:151)
 * ────────────────────────────────────────────────────────────────────────── */

export interface AudioChunkPayload {
  /** base64-encoded PCM16, mono, 24 kHz. */
  data: string;
  mimeType: string;
  /**
   * FR-2.4: active capture/session generation. ADDITIVE + OPTIONAL.
   * Absent ⇒ treated as the stale-safe default (dropped if a generation
   * guard is in force). Present ⇒ dropped when generation !== active.
   */
  generation?: number;
}

/** Unchanged IPC result shape ({success,error}); +optional `dropped` flag. */
export interface AudioSendResult {
  success: boolean;
  error?: string;
  /** FR-1.1: true when the chunk was silently dropped (inactive/stale session). */
  dropped?: boolean;
}

/** The two send handlers MUST resolve (never throw) on a null/stale session. */
export type SendAudioContent = (
  data: string,
  mimeType?: string,
  generation?: number
) => Promise<AudioSendResult>;

/* ──────────────────────────────────────────────────────────────────────────
 * 3. SttService new runtime state (FR-0.2, FR-0.3, FR-3.2, FR-4.3)
 * ────────────────────────────────────────────────────────────────────────── */

export interface DroppedChunkCounters {
  my: number;
  their: number;
}

export interface GapEpisodeState {
  active: boolean;
  count: number;
  /** generation at the moment the gap began, for the summary line. */
  fromGen: number | null;
}

export type ReconnectStatus = 'idle' | 'reconnecting' | 'reconnected' | 'exhausted';

export interface ReconnectState {
  status: ReconnectStatus;
  /** 0..6; cap 6 (FR-3.2). */
  attempt: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Guards INV-4: refuse to swap into a session that has since closed/renewed. */
  generationAtStart: number;
}

export interface SttLifecycleState {
  sessionGeneration: number;          // FR-0.2 monotonic
  droppedChunkCounters: DroppedChunkCounters; // FR-0.3
  gapEpisode: { my: GapEpisodeState; their: GapEpisodeState }; // FR-0.3
  isClosing: boolean;                 // FR-4.3 resurrection guard
  reconnect: { my: ReconnectState; their: ReconnectState };    // FR-3.2 (Phase 3)
}

/* ──────────────────────────────────────────────────────────────────────────
 * 4. Reconnect backoff (locked — Clarify Q2)
 * ────────────────────────────────────────────────────────────────────────── */

export interface ReconnectPolicy {
  baseMs: 250;
  factor: 2;
  capMs: 4000;
  jitter: 0.2;          // ±20%
  maxAttempts: 6;
  /** Deepgram per-attempt open timeout DURING reconnect (vs 10000 normal). */
  openTimeoutMs: 5000;
}

/** Compute the (pre-jitter) delay for a given attempt index (0-based). */
export type NextBackoffMs = (attempt: number, policy: ReconnectPolicy) => number;
export const nextBackoffMs: NextBackoffMs = (attempt, policy) =>
  Math.min(policy.capMs, policy.baseMs * Math.pow(policy.factor, attempt));

/** Which side a reconnect/drop concerns. */
export type SttSide = 'my' | 'their';

/* ──────────────────────────────────────────────────────────────────────────
 * 5. Instrumentation log record (FR-0.1 / FR-0.2)
 *    A single [stt-lifecycle]-tagged structured line per transition.
 * ────────────────────────────────────────────────────────────────────────── */

export type LifecycleTransition =
  | 'startCapture:begin' | 'startCapture:end'
  | 'stopCapture:begin'  | 'stopCapture:end'
  | 'initializeSttSessions:begin' | 'initializeSttSessions:end'
  | 'closeSessions:begin' | 'closeSessions:end'
  | 'renewSessions:begin' | 'renewSessions:end'
  | 'socket:open' | 'socket:close'
  | 'orphan-processor-detected'        // FR-0.4
  | 'dropped-chunks-summary';          // FR-0.3

export interface LifecycleLogRecord {
  tag: '[stt-lifecycle]';
  ts: number;                 // Date.now()
  transition: LifecycleTransition;
  generation: number;         // FR-0.2 stamped on every transition
  side?: SttSide;
  /** socket:open|close carry these (FR-0.1). */
  code?: number;
  reason?: string;
  readyState?: WsReadyState;
  /** dropped-chunks-summary carries these (FR-0.3). */
  droppedCount?: number;
  fromGen?: number | null;
}

/* ──────────────────────────────────────────────────────────────────────────
 * 6. UI status (FR-3.4) — reuses the existing `update-status` string channel.
 * ────────────────────────────────────────────────────────────────────────── */

export type ReconnectUiStatus =
  | 'Reconnecting…'
  | 'Reconnected'
  | { text: string; action: 'resume' }; // exhaustion: visible status + one-click Resume

/* compile-time sanity: every FR-touched shape is exported above. */
export type _ContractsCovered =
  | SttSessionWrapper
  | AudioChunkPayload
  | AudioSendResult
  | SttLifecycleState
  | ReconnectState
  | ReconnectPolicy
  | LifecycleLogRecord
  | ReconnectUiStatus;

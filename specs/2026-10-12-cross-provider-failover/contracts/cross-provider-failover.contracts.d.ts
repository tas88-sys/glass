/**
 * Contracts: Cross-Provider Failover (spec 2026-10-12-cross-provider-failover)
 *
 * Shapes of the modules this spec adds or changes. The implementation is
 * CommonJS JavaScript; these declarations pin names, inputs and outputs for
 * the tests and the review. Type-check:
 *   npx -p typescript@5.4.5 tsc -p specs/2026-10-12-cross-provider-failover/contracts/tsconfig.json
 */

// ---------------------------------------------------------------------------
// Glass message shapes (what the lanes pass today; unchanged)
// ---------------------------------------------------------------------------

export type GlassTextPart = { type: 'text'; text: string };
export type GlassImagePart = { type: 'image_url'; image_url: { url: string } };
export type GlassPart = string | GlassTextPart | GlassImagePart;

export interface GlassMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | GlassPart[];
}

/** generateContent(parts): strings and Gemini-style inline images. */
export type GlassGeneratePart = string | { inlineData: { mimeType: string; data: string } };

// ---------------------------------------------------------------------------
// Provider interface (what groq.js, gemini.js and anthropic.js already export; unchanged)
// ---------------------------------------------------------------------------

/** Options a provider factory function accepts. Each provider ignores the ones it does not know. */
export interface ProviderLlmOptions {
  apiKey: string;
  /** One ID or a CSV of this provider's IDs. */
  model: string;
  temperature?: number;
  maxTokens?: number;
  usePortkey?: boolean;
  portkeyVirtualKey?: string;
  /** Overrides the provider's own requestDeadlineMs(); null disables. */
  requestDeadlineMs?: number | null;
  /** Wait before the provider's second round (default 2 s Groq/Anthropic, 3 s Gemini). */
  retryRoundDelayMs?: number;
}

export interface ChatResult {
  content: string;
  raw: unknown;
  _modelUsed?: string;
}

export interface GenerateResult {
  response: { text(): string };
  raw?: unknown;
  _modelUsed?: string;
}

export interface StreamingLLM {
  /**
   * Resolves at once with a Response whose body is SSE: content deltas
   * { choices: [{ delta: { content } }] }, { _reset, next_model, reason },
   * { _final_model } and [DONE]. A failure errors the body with an Error
   * carrying userMessage. Cancelling the body aborts the in-flight request.
   */
  streamChat(messages: GlassMessage[]): Promise<Response>;
}

export interface LLM {
  chat(messages: GlassMessage[]): Promise<ChatResult>;
  generateContent(parts: GlassGeneratePart[]): Promise<GenerateResult>;
}

// ---------------------------------------------------------------------------
// SSE events the chain sends or passes through
// ---------------------------------------------------------------------------

export type ResetReason = 'transient' | 'timeout' | 'unavailable' | 'too-large' | 'retry' | 'provider';

export interface ResetEvent {
  _reset: true;
  next_model: string;
  /** 'provider' is new: the chain moved to the next provider's segment. */
  reason: ResetReason;
}

export interface FinalModelEvent {
  _final_model: string;
}

/** The error a stream errors with (providers and chain). */
export interface LlmError extends Error {
  userMessage?: string;
}

// ---------------------------------------------------------------------------
// factory.js (EDIT)
// ---------------------------------------------------------------------------

/** Providers whose IDs can be cut into segments. */
export type ChainProviderId = 'anthropic' | 'gemini' | 'groq';

/** A run of consecutive IDs of one provider. */
export interface Segment {
  /** A ChainProviderId, or the active provider when splitting does not apply. */
  provider: string;
  /** Non-empty, in list order. */
  models: string[];
}

/** Every provider named in the list → its saved key, or null. */
export type KeysMap = { [provider: string]: string | null | undefined };

/** What the three LLM call sites pass: today's fields plus keys. */
export interface FactoryLlmOptions extends ProviderLlmOptions {
  keys?: KeysMap;
}

export interface FactoryAdditions {
  /**
   * Segments of a model CSV. An ID's provider is inferProviderFromModelId(id);
   * an ID with none joins the current segment (the first segment's provider is
   * firstProvider). When firstProvider is not a ChainProviderId, one segment
   * holds the whole list. Trimmed; empties dropped; '' or null → [].
   */
  splitByProvider(modelCsv: string | null | undefined, firstProvider: string): Segment[];
  /**
   * Strips keys. One segment (or none): the provider's own createStreamingLLM
   * with today's options. Two or more: providerChain.createChainStreamingLLM.
   */
  createStreamingLLM(provider: string, opts: FactoryLlmOptions): StreamingLLM;
  /** Same routing for the non-streaming instance. */
  createLLM(provider: string, opts: FactoryLlmOptions): LLM;
}

// ---------------------------------------------------------------------------
// modelHealth.js (EDIT, additive)
// ---------------------------------------------------------------------------

export interface ModelHealthAddition {
  /** True when the model has a cooldown entry that has not ended. Reads only. */
  isCoolingDown(modelId: string): boolean;
}

// ---------------------------------------------------------------------------
// modelStateService.js (EDIT)
// ---------------------------------------------------------------------------

export interface CurrentLlmModelInfo {
  provider: string;
  /** The stored list, possibly naming several providers. */
  model: string;
  /** The active (first) provider's key, as today. */
  apiKey: string;
  /** NEW: every provider among splitByProvider(model, provider) → its key or null. */
  keys: KeysMap;
}

export interface ModelStateServiceChange {
  getCurrentModelInfo(type: 'llm'): Promise<CurrentLlmModelInfo | null>;
}

// ---------------------------------------------------------------------------
// providerChain.js (NEW)
// ---------------------------------------------------------------------------

export type SkipReason = 'no-key' | 'cooling' | 'deadline';

export type SegmentOutcome = 'ok' | 'failed' | 'cancelled' | `skipped-${SkipReason}`;

/** What the chain needs from one provider. Static table; injectable for tests. */
export interface ChainAdapter {
  id: ChainProviderId;
  createStreamingLLM(opts: ProviderLlmOptions): StreamingLLM;
  createLLM(opts: ProviderLlmOptions): LLM;
  /** The provider's own exported requestDeadlineMs() (env-aware); null = none. */
  requestDeadlineMs(): number | null;
  /** Groq: a model with modelTraits(id).vision; Gemini and Anthropic: true. */
  seesImages(models: string[]): boolean;
  /** The model the segment will try first: pickModel, after Groq's orderForImages. */
  firstModel(models: string[], input: GlassMessage[] | GlassGeneratePart[]): string;
}

export type ChainAdapters = { [P in ChainProviderId]: ChainAdapter };

export interface SegmentTimingInput {
  /** The provider's requestDeadlineMs(); null = none. */
  providerDeadlineMs: number | null;
  /** Chain deadline minus elapsed; Infinity when the chain deadline is disabled. */
  leftMs: number;
  /** A later segment exists that is not skipped for a missing key. */
  laterCanRun: boolean;
  /** Answer text has already been forwarded to the consumer. */
  answerStarted: boolean;
}

export interface SegmentTiming {
  /** Omitted when no limit applies. */
  requestDeadlineMs?: number;
  /** 0 when laterCanRun. */
  retryRoundDelayMs?: 0;
  /** Set when laterCanRun and the computed deadline is ≤ 0. */
  skip?: 'deadline';
}

export interface SkipInput {
  index: number;
  /** The plan's order (after image ordering). */
  segments: Segment[];
  keys: KeysMap;
  isCoolingDown(modelId: string): boolean;
}

export interface FailureMessageInput {
  /** Provider IDs of the segments that ran, in order. */
  ran: string[];
  /** The last segment's error. */
  last: LlmError;
  /** Set when the chain deadline ended the request. */
  deadlineMs?: number;
}

export interface ChainInput {
  /** Two or more segments, from splitByProvider. */
  segments: Segment[];
  keys: KeysMap;
  /** The caller's options without keys (temperature, maxTokens, …). */
  opts: Omit<FactoryLlmOptions, 'keys' | 'apiKey' | 'model'> & { apiKey?: string; model?: string };
  /** Defaults to the real providers (DEFAULT_ADAPTERS). */
  adapters?: ChainAdapters;
  /** For chainDeadlineMs; defaults to process.env. */
  env?: { [name: string]: string | undefined };
  /** Clock in epoch ms; defaults to Date.now (tests inject one). */
  now?: () => number;
}

export interface ProviderChain {
  CHAIN_PROVIDERS: readonly ChainProviderId[];
  /** The real providers, each required only when one of its segments runs. */
  DEFAULT_ADAPTERS: ChainAdapters;
  /** 15 000: kept for the fallback while a later segment can run. */
  FALLBACK_RESERVE_MS: number;
  /** 60 000; LLM_CHAIN_DEADLINE_MS overrides; 0 → null (disabled). */
  chainDeadlineMs(env?: { [name: string]: string | undefined }): number | null;
  /** An image_url part in any message, or an inlineData part. */
  hasImages(input: GlassMessage[] | GlassGeneratePart[]): boolean;
  /** Image-capable segments first (stable) when hasImages; otherwise unchanged. */
  orderSegments(segments: Segment[], withImages: boolean, adapters: ChainAdapters): { segments: Segment[]; reordered: boolean };
  /** 'no-key' or 'cooling' per the data-model rules, else null. */
  skipReason(input: SkipInput): Exclude<SkipReason, 'deadline'> | null;
  segmentTiming(input: SegmentTimingInput): SegmentTiming;
  /** FR-013 text. */
  failureMessage(input: FailureMessageInput): string;
  createChainStreamingLLM(input: ChainInput): StreamingLLM;
  createChainLLM(input: ChainInput): LLM;
}

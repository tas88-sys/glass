/**
 * Contracts: Groq Output Limit and Screenshots (spec 2026-10-12-groq-otpm-images)
 *
 * Shapes of what this spec changes. The implementation is CommonJS
 * JavaScript; these declarations pin names, inputs and outputs for the tests
 * and the review. Type-check:
 *   npx -p typescript@5.4.5 tsc -p specs/2026-10-12-groq-otpm-images/contracts/tsconfig.json
 */

// ---------------------------------------------------------------------------
// src/features/common/ai/providers/groqErrors.js (EDIT)
// ---------------------------------------------------------------------------

export type GroqErrorKind = 'transient' | 'unavailable' | 'too-large' | 'fatal-request' | 'fatal-auth';

export interface TooLargeNumbers {
  /** L in "Limit L, Requested R". */
  limit: number;
  /** R: Groq's own figure. For OTPM it is the expected output, not the declared cap. */
  requested: number;
  /** NEW: true when the message says "(OTPM)" (output tokens per minute). */
  output: boolean;
}

export interface GroqErrorsModule {
  /**
   * NEW rule: an HTTP 429 whose message contains "Request too large" is
   * 'too-large' (checked before 429 → 'transient'). A 413 stays 'too-large';
   * any other 429 stays 'transient'.
   */
  classify(err: unknown): GroqErrorKind;
  /** null without an adjacent "Limit L, Requested R" (a rate limit has "Used" between them). */
  tooLargeNumbers(err: unknown): TooLargeNumbers | null;
}

// ---------------------------------------------------------------------------
// src/features/common/ai/providers/groq.js (EDIT)
// ---------------------------------------------------------------------------

/** The cap for a caller that sets none (only Ask): 16,384, was 2,048. GROQ_MAX_TOKENS overrides. */
export type GroqDefaultMaxTokens = 16384;

/** Codes the provider sets on errors it creates itself. */
export type GroqProviderErrorCode =
  | 'FIRST_TEXT_TIMEOUT'
  | 'IDLE_TIMEOUT'
  | 'EMPTY_MAX_TOKENS'
  | 'STREAM_ERROR'
  /** NEW: visionOnly with an image left no model; thrown before any request. */
  | 'NO_VISION_MODEL';

export interface GroqProviderError extends Error {
  code?: GroqProviderErrorCode;
  /** For NO_VISION_MODEL: "No Groq model in the list sees images." */
  userMessage?: string;
}

export interface GroqLLMOptions {
  apiKey: string;
  /** One Groq ID or a CSV list. */
  model?: string;
  /** Else GROQ_MAX_TOKENS, else 16,384; plus the reasoning allowance on models that reason. */
  maxTokens?: number;
  temperature?: number;
  effort?: string;
  /**
   * NEW. With an image in the request, only the models that see images are
   * tried; when they fail the request fails instead of answering without the
   * image. Ignored without an image. Set by providerChain; never sent to the SDK.
   */
  visionOnly?: boolean;
  firstTextTimeoutMs?: number;
  requestDeadlineMs?: number | null;
  idleTimeoutMs?: number | null;
  retryRoundDelayMs?: number;
}

/**
 * The user message for a too-large failure:
 *   output (OTPM): `${model} — asks for up to ${requested} output tokens; this key allows ${limit} per minute.`
 *   TPM:           `${model} — request needs ${requested} tokens; this key allows ${limit} per minute. This request alone is over the limit: shorten the context or use a higher Groq tier.`
 */
export type TooLargeMessage = string;

/** NEW fields on the "[Groq Provider] attempt …" line when the error carries the numbers. */
export interface AttemptLogTooLargeFields {
  /** Rendered as `limit=L requested=R`. */
  limit: number;
  requested: number;
}

// ---------------------------------------------------------------------------
// src/features/common/ai/providerChain.js (EDIT)
// ---------------------------------------------------------------------------

export interface ChainSegment {
  provider: 'anthropic' | 'gemini' | 'groq';
  models: string[];
}

export interface ChainAdapter {
  id: string;
  /** Whether this segment's models see images (Groq: only with qwen/qwen3.8-27b). */
  seesImages(models: string[]): boolean;
}

/** planRequest: NEW field withImages. */
export interface RequestPlan {
  withImages: boolean;
  ordered: ChainSegment[];
  reordered: boolean;
  segmentKeys: Record<string, string | undefined>;
}

/** The options decideTurn passes to a segment's createStreamingLLM / createLLM. */
export interface SegmentOptions {
  apiKey: string | undefined;
  /** The segment's models, joined with commas. */
  model: string;
  requestDeadlineMs?: number;
  /**
   * NEW. true when the request has an image and a later segment whose
   * provider has a key sees images; absent otherwise.
   */
  visionOnly?: true;
  [callerOption: string]: unknown;
}

export interface ProviderChainInternals {
  /** NEW (internal): whether a segment after i, with a key, sees images. */
  laterSeesImages(input: {
    i: number;
    ordered: ChainSegment[];
    segmentKeys: Record<string, string | undefined>;
    adapters: Record<string, ChainAdapter | undefined>;
  }): boolean;
}

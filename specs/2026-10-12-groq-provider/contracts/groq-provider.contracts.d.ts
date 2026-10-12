/**
 * Contracts: Groq Provider (spec 2026-10-12-groq-provider)
 *
 * Shapes of the modules this spec adds or changes. The implementation is
 * CommonJS JavaScript; these declarations pin names, inputs and outputs for
 * the tests and the review. Type-check:
 *   npx -p typescript@5.4.5 tsc -p specs/2026-10-12-groq-provider/contracts/tsconfig.json
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
// groqErrors.js (NEW, pure)
// ---------------------------------------------------------------------------

export type GroqErrorKind = 'transient' | 'unavailable' | 'too-large' | 'fatal-request' | 'fatal-auth';

/** Codes the provider sets on errors it creates itself. */
export type ProviderErrorCode = 'FIRST_TEXT_TIMEOUT' | 'IDLE_TIMEOUT' | 'EMPTY_MAX_TOKENS' | 'STREAM_ERROR';

/** Groq's error object: { message, type, code }. */
export interface GroqErrorObject {
  message?: string;
  type?: string;
  code?: string;
}

/** The parts of an SDK or provider error the classifier reads. */
export interface ErrorLike {
  name?: string;
  message?: string;
  status?: number;
  code?: ProviderErrorCode | string;
  /**
   * HTTP errors: the whole body, { error: GroqErrorObject }.
   * Stream `{"error": …}` events: the inner GroqErrorObject.
   */
  error?: GroqErrorObject & { error?: GroqErrorObject };
  headers?: { get(name: string): string | null } | Record<string, string>;
  /** Set by the provider on the error it raises to the consumer. */
  userMessage?: string;
}

export interface GroqErrors {
  classify(err: unknown): GroqErrorKind;
  /** retry-after-ms, then retry-after (seconds or HTTP date), else 60 000; clamped to [5 000, 300 000]. */
  retryAfterMs(err: unknown): number;
  /** The server's hint unclamped, or null (decides whether a 429 joins the second round). */
  retryAfterHeaderMs(err: unknown): number | null;
  /** Server reason without SDK noise, at most 160 characters. */
  shortErrorMessage(err: unknown): string;
  /** "Limit L, Requested R" from a 413 message, or null. */
  tooLargeNumbers(err: unknown): { limit: number; requested: number } | null;
  /** Groq's error code from either body shape, for the log. */
  errorCode(err: unknown): string | null;
}

// ---------------------------------------------------------------------------
// groq.js (NEW)
// ---------------------------------------------------------------------------

export type ReasoningFamily = 'gpt-oss' | 'qwen3';
export type GptOssEffort = 'low' | 'medium' | 'high';
export type Qwen3Effort = 'none' | 'default' | 'low' | 'medium' | 'high';

export interface ModelTraits {
  reasoning: ReasoningFamily | null;
  vision: boolean;
  /** Model's maximum completion tokens, or null when unknown (no cap). */
  maxOutput: number | null;
}

export type GroqContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface GroqMessageParam {
  role: 'system' | 'user' | 'assistant';
  content: string | GroqContentPart[];
}

export interface GroqRequestParams {
  model: string;
  messages: GroqMessageParam[];
  /** Always true: every call streams, chat() and generateContent() included (research R13). */
  stream: true;
  max_completion_tokens: number;
  temperature?: number;
  reasoning_effort?: GptOssEffort | Qwen3Effort;
  /** gpt-oss only, always false. Never together with reasoning_format. */
  include_reasoning?: false;
  /** qwen3 only, when reasoning_effort is not 'none'. */
  reasoning_format?: 'hidden';
  // Never present: max_tokens, top_p, logprobs, logit_bias, top_logprobs, n,
  // stream_options, service_tier, tools, response_format, messages[].name (FR-006).
}

export interface BuildRequestInput {
  modelId: string;
  messages: GlassMessage[];
  maxTokens?: number;
  temperature?: number;
  effort?: string;
  /** Kept for symmetry with the Anthropic builder; both modes use the same default budget. Default 'stream'. */
  mode?: 'stream' | 'once';
  /** process.env by default; injectable for tests. */
  env?: Record<string, string | undefined>;
}

export interface BuiltRequest {
  params: GroqRequestParams;
  imagesSent: number;
  imagesDropped: number;
  /** The resolved reasoning_effort, or null when none is sent (for the log). */
  effort: string | null;
}

export interface ValidationResult {
  success: boolean;
  error?: string;
}

export interface GroqProviderClass {
  validateApiKey(key: string): Promise<ValidationResult>;
}

export interface CreateLLMOptions {
  apiKey: string;
  /** One Groq ID or a CSV list. Default 'openai/gpt-oss-120b'. */
  model?: string;
  maxTokens?: number;
  /** Sent when finite and within [0, 2] (FR-007). */
  temperature?: number;
  effort?: string;
  /** Wait before the second round; default 2000 (FR-019). */
  retryRoundDelayMs?: number;
  /** Overrides firstTextTimeoutMs() for every model. */
  firstTextTimeoutMs?: number;
  /** Overrides requestDeadlineMs(); null disables. */
  requestDeadlineMs?: number | null;
  /** Overrides idleTimeoutMs(); null disables. */
  idleTimeoutMs?: number | null;
}

/** Options passed to every SDK call (FR-019): the SDK never retries; the loop owns every wait. */
export interface SdkCallOptions {
  maxRetries: 0;
  timeout: 15000;
  signal: AbortSignal;
}

export type CreateStreamingLLMOptions = CreateLLMOptions;

export interface LLM {
  /** Streams internally and joins the text (D12). _modelUsed is the model that answered. */
  generateContent(parts: GlassGeneratePart[]): Promise<{ response: { text(): string }; raw: unknown; _modelUsed: string }>;
  chat(messages: GlassMessage[]): Promise<{ content: string; raw: unknown; _modelUsed: string }>;
}

export interface StreamingLLM {
  /** Resolves at once; failures arrive through the body (stream error with userMessage). */
  streamChat(messages: GlassMessage[]): Promise<Response>;
}

export interface GroqModule {
  GroqProvider: GroqProviderClass;
  createSTT(opts: unknown): Promise<{ sendRealtimeInput(data: unknown): Promise<void>; close(): Promise<void> }>;
  createLLM(opts: CreateLLMOptions): LLM;
  createStreamingLLM(opts: CreateStreamingLLMOptions): StreamingLLM;
  modelTraits(modelId: string): ModelTraits;
  buildRequest(input: BuildRequestInput): BuiltRequest;
  /** Image-capable models first when the messages carry an image; otherwise the list unchanged. */
  orderForImages(models: string[], messages: GlassMessage[] | GlassGeneratePart[]): string[];
  /** 15 000; GROQ_FIRST_TEXT_TIMEOUT_MS overrides. */
  firstTextTimeoutMs(env?: Record<string, string | undefined>): number;
  /** 45 000; GROQ_REQUEST_DEADLINE_MS overrides; 0 → null (disabled). */
  requestDeadlineMs(env?: Record<string, string | undefined>): number | null;
  /** 15 000; GROQ_IDLE_TIMEOUT_MS overrides; 0 → null (disabled). */
  idleTimeoutMs(env?: Record<string, string | undefined>): number | null;
}

// ---------------------------------------------------------------------------
// Stream protocol (unchanged; spec C1)
// ---------------------------------------------------------------------------

export type ResetReason = 'transient' | 'timeout' | 'unavailable' | 'too-large' | 'retry';

export type SseEvent =
  | { choices: [{ delta: { content: string } }] }
  | { _reset: true; next_model: string; reason: ResetReason }
  | { _final_model: string };

// ---------------------------------------------------------------------------
// factory.js (EDIT)
// ---------------------------------------------------------------------------

export interface FactoryAdditions {
  /**
   * First CSV entry: 'claude-…' → 'anthropic', 'gemini-…' → 'gemini',
   * '<vendor>/<model>' (a slash, no whitespace) → 'groq', else null.
   */
  inferProviderFromModelId(modelId: string | null | undefined): 'anthropic' | 'gemini' | 'groq' | null;
}

export const GROQ_LLM_PRESETS: ReadonlyArray<{ id: string; name: string }>;
// = [{ id: 'openai/gpt-oss-120b', name: 'GPT-OSS 120B (Groq)' },
//    { id: 'openai/gpt-oss-20b', name: 'GPT-OSS 20B (Groq)' },
//    { id: 'qwen/qwen3.8-27b', name: 'Qwen 3.8 27B, vision (Groq, preview)' }]

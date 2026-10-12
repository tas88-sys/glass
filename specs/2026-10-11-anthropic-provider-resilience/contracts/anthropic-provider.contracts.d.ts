/**
 * Contracts: Anthropic Provider Resilience (spec 2026-10-11-anthropic-provider-resilience)
 *
 * Shapes of the modules this spec adds or changes. The implementation is
 * CommonJS JavaScript; these declarations pin names, inputs and outputs for
 * the tests and the review. Type-check:
 *   npx -p typescript@5.4.5 tsc -p specs/2026-10-11-anthropic-provider-resilience/contracts/tsconfig.json
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
// modelHealth.js (NEW; geminiModelRotator.js re-exports these unchanged)
// ---------------------------------------------------------------------------

export interface ModelHealth {
  parseModelList(csv: string | null | undefined): string[];
  /** First model not cooling down; if all are, the one that recovers first. Throws on an empty list. */
  pickModel(modelList: string[]): string;
  /** Clamped to [5 s, 5 min]. */
  markFailed(modelId: string, cooldownMs: number): void;
  markSucceeded(modelId: string): void;
  /** @internal test helper */
  resetHealth(): void;
  DEFAULT_COOLDOWN_MS: 60000;
  MIN_COOLDOWN_MS: 5000;
  MAX_COOLDOWN_MS: 300000;
}

// ---------------------------------------------------------------------------
// anthropicErrors.js (NEW, pure)
// ---------------------------------------------------------------------------

export type AnthropicErrorKind = 'transient' | 'unavailable' | 'refusal' | 'fatal-request' | 'fatal-auth';

/** Codes the provider sets on errors it creates itself. */
export type ProviderErrorCode = 'FIRST_TEXT_TIMEOUT' | 'IDLE_TIMEOUT' | 'REFUSAL' | 'EMPTY_MAX_TOKENS';

/** The parts of an SDK or provider error the classifier reads. */
export interface ErrorLike {
  name?: string;
  message?: string;
  status?: number;
  code?: ProviderErrorCode | string;
  /** SDK ≥ 0.81.0: error type from the body ('overloaded_error', 'rate_limit_error', …), also on stream `error` events. */
  type?: string | null;
  /** SDK APIError body; for a stream `error` event: { type: 'error', error: { type, message } } */
  error?: { type?: string; message?: string; error?: { type?: string; message?: string } };
  headers?: { get(name: string): string | null } | Record<string, string>;
  requestID?: string | null;
  /** Set by the provider on the error it raises to the consumer. */
  userMessage?: string;
}

export interface AnthropicErrors {
  classify(err: unknown): AnthropicErrorKind;
  /** retry-after-ms, then retry-after (seconds or HTTP date), else 60 000; clamped to [5 000, 300 000]. */
  retryAfterMs(err: unknown): number;
  /** The server's hint unclamped, or null (decides whether a 429 joins the second round). */
  retryAfterHeaderMs(err: unknown): number | null;
  /** Server reason without SDK noise, at most 160 characters. */
  shortErrorMessage(err: unknown): string;
}

// ---------------------------------------------------------------------------
// anthropic.js (REWRITE)
// ---------------------------------------------------------------------------

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

export interface AnthropicMessageParam {
  role: 'user' | 'assistant';
  content: AnthropicContentBlock[];
}

export interface AnthropicRequestParams {
  model: string;
  max_tokens: number;
  messages: AnthropicMessageParam[];
  system?: string;
  /** Always true: every call streams, chat() and generateContent() included (research R13). */
  stream: true;
  output_config?: { effort: Effort };
  /** Only on the beta method, only for claude-opus-5-5 and claude-sonnet-5-5. */
  betas?: ['server-side-fallback-2026-07-01'];
  fallbacks?: 'default';
  // Never present: temperature, top_p, top_k, thinking (spec FR-005, C5).
}

export interface BuildRequestInput {
  modelId: string;
  messages: GlassMessage[];
  maxTokens?: number;
  effort?: string;
  /** Picks the default max_tokens: 16000 for streamChat, 8192 for chat/generateContent. Default 'stream'. */
  mode?: 'stream' | 'once';
  /** False once the API rejected the server-side fallback beta in this process. Default true. */
  serverFallback?: boolean;
  /** process.env by default; injectable for tests. */
  env?: Record<string, string | undefined>;
}

export interface BuiltRequest {
  /** 'beta' → client.beta.messages.create; 'messages' → client.messages.create */
  method: 'messages' | 'beta';
  params: AnthropicRequestParams;
}

export interface ValidationResult {
  success: boolean;
  error?: string;
}

export interface AnthropicProviderClass {
  validateApiKey(key: string): Promise<ValidationResult>;
}

export interface CreateLLMOptions {
  apiKey: string;
  /** One Claude ID or a CSV list. Default 'claude-opus-5-5'. */
  model?: string;
  maxTokens?: number;
  effort?: string;
  /** Accepted for interface compatibility with other providers; never sent (FR-005). */
  temperature?: number;
  /** Wait before the second round; default 2000 (FR-018). */
  retryRoundDelayMs?: number;
  /** Overrides firstTextTimeoutMs(modelId) for every model. */
  firstTextTimeoutMs?: number;
  /** Overrides requestDeadlineMs(); null disables. */
  requestDeadlineMs?: number | null;
  /** Overrides idleTimeoutMs(); null disables. */
  idleTimeoutMs?: number | null;
}

/** Options passed to every SDK call (FR-018): the SDK never retries; the loop owns every wait. */
export interface SdkCallOptions {
  maxRetries: 0;
  timeout: 15000;
  signal: AbortSignal;
}

/** Same options; streamChat defaults max_tokens to 16000. */
export type CreateStreamingLLMOptions = CreateLLMOptions;

export interface LLM {
  /** Streams internally and joins the text (D12). _modelUsed is the model that finished. */
  generateContent(parts: GlassGeneratePart[]): Promise<{ response: { text(): string }; raw: unknown; _modelUsed: string }>;
  chat(messages: GlassMessage[]): Promise<{ content: string; raw: unknown; _modelUsed: string }>;
}

export interface StreamingLLM {
  /** Resolves at once; failures arrive through the body (stream error with userMessage). */
  streamChat(messages: GlassMessage[]): Promise<Response>;
}

export interface AnthropicModule {
  AnthropicProvider: AnthropicProviderClass;
  createSTT(opts: unknown): Promise<{ sendRealtimeInput(data: unknown): Promise<void>; close(): Promise<void> }>;
  createLLM(opts: CreateLLMOptions): LLM;
  createStreamingLLM(opts: CreateStreamingLLMOptions): StreamingLLM;
  buildRequest(input: BuildRequestInput): BuiltRequest;
  acceptsEffort(modelId: string): boolean;
  /** 20 000 for the Haiku family, 45 000 otherwise; ANTHROPIC_FIRST_TEXT_TIMEOUT_MS overrides. */
  firstTextTimeoutMs(modelId: string, env?: Record<string, string | undefined>): number;
  /** 60 000; ANTHROPIC_REQUEST_DEADLINE_MS overrides; 0 → null (disabled). */
  requestDeadlineMs(env?: Record<string, string | undefined>): number | null;
  /** 30 000; ANTHROPIC_IDLE_TIMEOUT_MS overrides; 0 → null (disabled). */
  idleTimeoutMs(env?: Record<string, string | undefined>): number | null;
  /** @internal test helper: turn the server-side fallback back on. */
  resetServerFallback(): void;
}

// ---------------------------------------------------------------------------
// Stream protocol (unchanged; spec C1)
// ---------------------------------------------------------------------------

export type ResetReason = 'transient' | 'timeout' | 'unavailable' | 'refusal' | 'retry';

export type SseEvent =
  | { choices: [{ delta: { content: string } }] }
  | { _reset: true; next_model: string; reason: ResetReason }
  | { _final_model: string };

// ---------------------------------------------------------------------------
// factory.js (EDIT)
// ---------------------------------------------------------------------------

export interface FactoryAdditions {
  /** 'claude-…' → 'anthropic', 'gemini-…' → 'gemini', else null. Reads the first CSV entry. */
  inferProviderFromModelId(modelId: string | null | undefined): 'anthropic' | 'gemini' | null;
}

export const ANTHROPIC_LLM_PRESETS: ReadonlyArray<{ id: string; name: string }>;
// = [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
//    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
//    { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' }]

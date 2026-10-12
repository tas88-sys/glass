/**
 * Contracts: Model Catalog (spec 2026-10-12-model-catalog)
 *
 * Shapes of what this spec adds or changes. The implementation is CommonJS
 * JavaScript; these declarations pin names, inputs and outputs for the tests
 * and the review. Type-check:
 *   npx -p typescript@5.4.5 tsc -p specs/2026-10-12-model-catalog/contracts/tsconfig.json
 */

export type CatalogProvider = 'anthropic' | 'gemini' | 'groq';
export type OverrideField = 'vision' | 'maxOutput' | 'reasoning';
export type ValueSource = 'override' | 'api' | 'default' | 'unknown';

// ---------------------------------------------------------------------------
// Each provider's models list, normalized (groq.js, anthropic.js, gemini.js: NEW)
// ---------------------------------------------------------------------------

/** null = the API did not report it (unknown), never "false". */
export interface ModelEntry {
  id: string;
  vision: boolean | null;
  maxOutput: number | null;
  reasoning: boolean | null;
  /** Anthropic only: the capabilities.effort levels marked supported; [] none. */
  effortLevels: string[] | null;
  thinking: boolean | null;
}

export interface ProviderModelsApi {
  /** The key's whole list (Anthropic: not retired; Gemini: generateContent only; Groq: active). */
  listModels(apiKey: string): Promise<ModelEntry[]>;
  /** One ID (an alias, or one the list does not name); null on 404. */
  getModel(apiKey: string, modelId: string): Promise<ModelEntry | null>;
  normalizeModel(raw: unknown): ModelEntry;
}

// ---------------------------------------------------------------------------
// src/features/common/ai/modelCatalog.js (NEW)
// ---------------------------------------------------------------------------

export interface Capabilities {
  vision: boolean | null;
  maxOutput: number | null;
  reasoning: boolean | null;
  effortLevels: string[] | null;
  thinking: boolean | null;
  /** false once the API refused the Anthropic fallback beta for the model. */
  serverFallback: boolean | null;
  /** Output tokens per minute this key allows (learned from a Groq 429 OTPM; 24 h). */
  keyOutputLimit: number | null;
  listed: boolean | null;
  source: { vision: ValueSource; maxOutput: ValueSource; reasoning: ValueSource };
}

export interface CatalogSnapshotEntry extends Capabilities {
  provider: CatalogProvider;
  modelId: string;
  fetchedAt: number | null;
  override: { vision: boolean | null; maxOutput: number | null; reasoning: boolean | null };
}

/** The model_catalog table, as the repository reads and writes it. */
export interface CatalogDbRow {
  provider: string; model_id: string; listed: 0 | 1 | null; vision: 0 | 1 | null;
  max_output: number | null; reasoning: 0 | 1 | null; effort_levels: string | null;
  thinking: 0 | 1 | null; server_fallback: 0 | 1 | null; override_vision: 0 | 1 | null;
  override_max_output: number | null; override_reasoning: 0 | 1 | null;
  key_output_limit: number | null; key_limit_at: number | null; fetched_at: number | null; updated_at: number | null;
}

export interface CatalogStore {
  getAll(): CatalogDbRow[];
  upsert(row: CatalogDbRow): { changes: number };
}

export interface CatalogFetcher {
  list(apiKey: string): Promise<ModelEntry[]>;
  get(apiKey: string, modelId: string): Promise<ModelEntry | null>;
}

export interface ModelCatalogModule {
  readonly CATALOG_PROVIDERS: readonly CatalogProvider[];
  readonly PROVIDER_DEFAULTS: Readonly<Record<CatalogProvider, Readonly<{ vision: boolean }>>>;
  readonly REFRESH_TTL_MS: number;
  readonly KEY_LIMIT_TTL_MS: number;
  readonly ENSURE_TIMEOUT_MS: number;
  defaultFetchers(): Record<CatalogProvider, CatalogFetcher>;
  configure(o?: { store?: CatalogStore | null; fetchers?: Partial<Record<CatalogProvider, CatalogFetcher>> | null; now?: (() => number) | null }): void;
  /** Saved rows into memory; returns how many. Never throws. */
  load(): number;
  capabilities(provider: string, modelId: string): Capabilities;
  seesImages(provider: string, modelId: string): boolean;
  orderForImages(provider: string, models: string[], withImages: boolean): string[];
  providersListing(modelId: string): CatalogProvider[];
  providerOf(modelId: string, context?: string): CatalogProvider | null;
  notePrefixProvider(modelId: string, provider: string | null): void;
  isKnown(provider: string, modelId: string): boolean;
  keyOutputLimit(provider: string, modelId: string): number | null;
  snapshot(q?: { provider?: string; ids?: string[] }): CatalogSnapshotEntry[];
  /** true when a current list is held. One read at a time per provider; 24 h unless force. */
  refresh(provider: string, apiKey: string, o?: { force?: boolean }): Promise<boolean>;
  /** Waits at most timeoutMs (2 s); never throws. */
  ensureKnown(provider: string, apiKey: string, ids: string[], o?: { timeoutMs?: number }): Promise<void>;
  /** Throws on an unknown provider or field, or a bad value. null clears. */
  setOverride(provider: string, modelId: string, field: OverrideField, value: boolean | number | null): void;
  clearOverrides(provider: string, modelId: string): void;
  markServerFallback(provider: string, modelId: string, supported: boolean): void;
  recordKeyOutputLimit(provider: string, modelId: string, limit: number): void;
  clearKeyLimits(provider: string): void;
  /** @internal tests */
  seed(provider: string, entries: Array<Partial<ModelEntry> & { id: string }>): void;
  /** @internal tests */
  resetCatalog(): void;
}

// ---------------------------------------------------------------------------
// Providers (EDIT)
// ---------------------------------------------------------------------------

export interface GroqTraits {
  /** The reasoning dialect (REASONING_DIALECTS), null when none applies or the catalog says it does not reason. */
  reasoning: 'gpt-oss' | 'qwen3' | null;
  vision: boolean;
  maxOutput: number | null;
}

export interface GroqModule extends ProviderModelsApi {
  modelTraits(modelId: string): GroqTraits;
  /** The max_completion_tokens buildRequest declares, without building it. */
  declaredMaxTokens(input: { modelId: string; maxTokens?: number; effort?: string; env?: Record<string, string | undefined> }): number;
}

/** Thrown by Groq before any request when every candidate is over the learned key limit. */
export interface KeyOutputLimitError extends Error {
  code: 'KEY_OUTPUT_LIMIT';
  /** "MODEL — asks for up to R output tokens; this key allows L per minute." */
  userMessage: string;
}

/** Thrown by any provider with visionOnly and an image when none of its models sees images. */
export interface NoVisionModelError extends Error {
  code: 'NO_VISION_MODEL';
  /** "No Groq|Anthropic|Gemini model in the list sees images." */
  userMessage: string;
}

export interface AnthropicModule extends ProviderModelsApi {
  effortLevels(modelId: string): string[];
  acceptsEffort(modelId: string): boolean;
  buildRequest(input: {
    modelId: string; messages: unknown[]; maxTokens?: number; effort?: string;
    mode?: 'stream' | 'once'; serverFallback?: boolean; env?: Record<string, string | undefined>;
  }): { method: 'messages' | 'beta'; params: Record<string, unknown>; imagesDropped: number };
}

export interface GeminiModule extends ProviderModelsApi {
  /** The caller's cap, else 65,536, never over the model's outputTokenLimit. */
  maxOutputTokensFor(modelId: string, maxTokens?: number): number;
}

/** createLLM / createStreamingLLM options added on Anthropic and Gemini (Groq had it). */
export interface VisionOnlyOption {
  visionOnly?: boolean;
}

// ---------------------------------------------------------------------------
// factory.js, providerChain.js (EDIT)
// ---------------------------------------------------------------------------

export interface FactoryModule {
  /** The catalog's provider first (context decides between several), the prefix last. */
  inferProviderFromModelId(modelId: string | null | undefined, context?: string): CatalogProvider | null;
  providerFromPrefix(id: string): CatalogProvider | null;
}

export interface ChainAdapter {
  id: string;
  seesImages(models: string[]): boolean;
  firstModel(models: string[], input: unknown): string;
  /** NEW: let the catalog learn the segment's models (bounded wait). */
  ensureKnown?(models: string[], apiKey: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// modelStateService.js and IPC (EDIT)
// ---------------------------------------------------------------------------

export interface PlannedModel extends CatalogSnapshotEntry {
  providerSource: 'catalog' | 'prefix';
  hasKey: boolean;
}

export interface ModelListPlan {
  segments: Array<{ provider: string; models: string[] }>;
  models: PlannedModel[];
  missingKeys: string[];
}

export interface SelectedModels {
  llm: string | null;
  stt: string | null;
  /** NEW: the provider row each active model is saved in. */
  llmProvider: string | null;
  sttProvider: string | null;
}

export interface CatalogIpc {
  'model:get-catalog'(q?: { provider?: string; ids?: string[] }): CatalogSnapshotEntry[];
  'model:plan-model-list'(q: { list: string; fieldProvider: string }): ModelListPlan;
  'model:set-capability-override'(q: { provider: string; modelId: string; field: OverrideField; value: boolean | number | null }): { success: boolean; error?: string };
  'model:refresh-catalog'(q?: { provider?: string }): boolean;
  'model:set-selected-model'(q: { type: 'llm' | 'stt'; modelId: string; fieldProvider?: string }): boolean;
}

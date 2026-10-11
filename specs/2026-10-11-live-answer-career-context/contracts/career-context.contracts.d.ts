/**
 * Contracts: Live Answer Career Context
 * Spec: 2026-10-11-live-answer-career-context
 *
 * Type-level contract for src/features/common/career/*. The implementation is
 * plain CommonJS JavaScript; these declarations document the shapes and the
 * public surface each module must expose. Only index.js is called from outside
 * the folder (summaryService, listenService, app start).
 */

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type Route = 'personal' | 'company' | 'ambiguous' | 'general';

export interface Manifest {
    version: 1;
    include: string[];            // globs, relative, forward slashes
    exclude: string[];            // exclude wins; .git/** and node_modules/** always excluded
    core: string[];               // canonical card file(s), never chunked
    companies?: {
        root: string;
        skip?: string[];
        aliases?: Record<string, string[]>;
    };
}

export interface Chunk {
    id: string;                   // sha1(path + title + ordinal).slice(0, 12)
    path: string;
    title: string;                // "file › H2 › H3" (+ " › " + Q line for qa)
    body: string;
    companies: string[];          // [] = untagged (generic); see FR-005
    date: number;                 // epoch ms
    kind: 'qa' | 'section';
    hash: string;                 // sha1(title + "\n" + body), embedding cache key
}

export interface RouteDecision {
    route: Route;
    cue: string | null;           // rule name, never turn text
}

export interface RouterContext {
    prev?: { route: Route; ts: number; queryTerms?: string[] } | null;   // last answered personal question (FR-006, FR-008)
    entities?: string[];          // employer/project names from the CV (FR-006)
    now?: number;
}

export interface ScoredChunk {
    chunk: Chunk;
    score: number;                // fused RRF score
    bm25Rank: number | null;
    vectorRank: number | null;
    cosine: number | null;        // vector similarity, null in BM25-only mode (FR-012)
    coverage: number | null;      // distinct query terms matched ÷ query terms, null when not in BM25 results
    matchedTerms: number;         // distinct query terms matched (0 when not in BM25 results)
}

export interface Timings {
    routeMs: number;
    bm25Ms: number;
    vectorMs: number;
    vectorUsed: boolean;
    totalMs: number;
}

export interface CareerContext {
    route: Route;
    cue: string | null;
    block: string;                // '' when nothing injected
    addendum: string;             // '' when nothing injected
    sources: string[];            // titles only (FR-015)
    chunkIds: string[];
    timings: Timings;
}

// ---------------------------------------------------------------------------
// index.js — the only entry point used outside common/career
// ---------------------------------------------------------------------------

export interface CareerModule {
    /** Build or refresh the index. Async, never throws, safe to call repeatedly (FR-016). */
    warm(): Promise<void>;

    /**
     * Start the query embedding for a gated `them` turn so it is ready when the
     * debounce fires (FR-009). The module keeps only the latest prefetch, keyed by
     * normalized text. Never throws; a no-op when vectors are unavailable.
     */
    prefetch(turnText: string): void;

    /**
     * Resolve career context for the turn that fired the debounce.
     * Returns null when the feature is disabled or anything fails (FR-017, C1).
     * Awaits a pending prefetch for at most 150 ms (C3).
     */
    getCareerContext(
        turnText: string,
        history: string[],
        session: { prev: RouterContext['prev']; activeCompany: string | null },
    ): Promise<CareerContext | null>;

    /** True when a personal or company cue is present: feeds shouldTriggerAnswer (FR-007). Always false while the module is disabled (C1). Sync. */
    hasCareerCue(turnText: string): boolean;

    /** Company name (folder name or alias, longest match first) said in the turn, if any (FR-011). Pure, sync. */
    detectCompany(turnText: string): string | null;

    /** Debug-safe status for logs: never includes note text. */
    status(): { state: 'disabled' | 'warming' | 'ready-bm25' | 'ready-hybrid'; chunks: number; vectors: number };
}

// ---------------------------------------------------------------------------
// Pure modules (unit-tested with synthetic fixtures)
// ---------------------------------------------------------------------------

/** intentRouter.js */
export declare function classifyCareerIntent(text: string, ctx?: RouterContext): RouteDecision;
/** Cue phrases removed from the retrieval query (exported for retriever). */
export declare function stripCuePhrases(text: string): string;

/** chunker.js */
export declare function chunkMarkdown(
    path: string,
    markdown: string,
    opts: { mtime: number; companyOf: (path: string) => string | null },
): Chunk[];

/** textNormalize.js */
export declare function tokenize(text: string): string[];   // fold accents, lowercase, stopwords, stem

/** bm25.js */
export interface Bm25Hit {
    idx: number;
    score: number;
    matchedTerms: number;         // distinct query terms found in the chunk
    queryTerms: number;           // distinct query terms searched
}
export interface Bm25Index {
    search(queryTerms: string[], k: number): Bm25Hit[];
}
export declare function buildBm25(chunks: Chunk[]): Bm25Index;

/** vectorIndex.js */
export interface VectorHit {
    idx: number;
    score: number;                // cosine similarity (rows and query are L2-normalized)
}
export interface VectorIndex {
    search(query: Float32Array, k: number): VectorHit[];
}
export declare function buildVectorIndex(rows: Float32Array, dims: number): VectorIndex;

/** retriever.js */
export declare function fuseAndFilter(input: {
    chunks: Chunk[];
    bm25: Bm25Hit[];
    vector: VectorHit[] | null;   // null → BM25-only
    route: Route;
    activeCompany: string | null;
    k: number;                    // 3–4
    rrfK?: number;                // default 60
}): ScoredChunk[];

/**
 * FR-012 gate for the ambiguous route, applied to the top fused hit.
 * Vectors used → hit.cosine >= minCosine. BM25-only → hit.coverage >= 0.5 and
 * hit.matchedTerms >= 2. minCosine is calibrated by the eval (T027).
 */
export declare function passesAmbiguousThreshold(
    hit: ScoredChunk | undefined,
    opts: { vectorUsed: boolean; minCosine: number },
): boolean;

/** contextBuilder.js */
export declare function buildContextBlock(input: {
    core: string;                 // canonical card text ('' if none)
    hits: ScoredChunk[];
    maxChars?: number;            // default 6000; the core card is never cut (FR-013)
}): { block: string; sources: string[]; chunkIds: string[] };

export declare function buildAddendum(activeCompany: string | null): string;

/**
 * Block format (FR-013). The card is labeled so the addendum can refer to it:
 *
 *   [canonical facts]
 *   <core file text, marker lines removed>
 *
 *   [<chunk title>]
 *   <chunk body>
 *   ...
 */
export declare const BLOCK_CARD_LABEL: '[canonical facts]';

/** globMatch.js (C6) */
export declare function globToRegExp(glob: string): RegExp;

// ---------------------------------------------------------------------------
// Prompt addendum (FR-014) — exact text appended to the user message when
// context is injected. {COMPANY_CLAUSE} is '' or
// " The interviewer's company is <name>." when an active company is known.
// ---------------------------------------------------------------------------
export declare const ADDENDUM_TEMPLATE: `The interviewer is asking about the candidate's own background. Answer in first person as the candidate, using only facts from the User-provided context; the canonical facts override the other notes when they disagree. Do not invent employers, dates, metrics or projects. For "tell me about a time" questions, pick one story and give situation, action and result in a few bullets. The notes were prepared for different companies: never present a company named in them as the interviewer's company.{COMPANY_CLAUSE} Answer in the language the interviewer used.`;

// ---------------------------------------------------------------------------
// IPC payload extension (FR-015)
// ---------------------------------------------------------------------------
export interface LiveAnswerUpdate {
    id: number | string;
    question?: string;
    answer?: string;
    ts: number;
    sources?: string[];           // NEW — only when context was injected
    status?: 'retrying' | 'idle' | 'error';
    model?: string | null;
    error?: string;
}

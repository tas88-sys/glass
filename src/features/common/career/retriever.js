'use strict';

// Fusion and filtering of the lexical and semantic rankings (FR-010, FR-011,
// FR-012). Pure: takes ranked hit lists, returns the top-k scored chunks.
// Three rankings: BM25, the query against each section's text, and the query
// against each section's title (interview notes are mostly "question → answer"
// sections, so matching the question to the heading finds them well).

const { slugify } = require('./textNormalize');

const RRF_K = 60;
const LIST_DEPTH = 20;   // each ranking contributes its top 20 (after filtering)
const MAX_PER_FILE = 1;  // one section per note file, so near-duplicates do not crowd the block

/** FR-011: may this chunk be used on the company route? */
function companyAllows(chunk, activeSlug) {
    const tags = chunk.companies || [];
    if (tags.length === 0) return true;                  // untagged: generic prep
    if (!activeSlug) return false;                       // unknown company: generic only (E14)
    return tags.some(t => slugify(t) === activeSlug);
}

/**
 * @param {{
 *   chunks: object[],
 *   bm25: Array<{idx:number, score:number, matchedTerms:number, queryTerms:number}>,
 *   vector: Array<{idx:number, score:number}>|null,
 *   title?: Array<{idx:number, score:number}>|null,
 *   route: string,
 *   activeCompany: string|null,
 *   k: number,
 *   rrfK?: number,
 *   maxPerFile?: number,
 * }} input
 */
function fuseAndFilter({ chunks, bm25, vector, title = null, route, activeCompany, k, rrfK = RRF_K, maxPerFile = MAX_PER_FILE }) {
    if (!Array.isArray(chunks) || chunks.length === 0 || !(k > 0)) return [];
    const activeSlug = activeCompany ? slugify(activeCompany) : '';
    const eligible = idx => {
        const c = chunks[idx];
        if (!c) return false;
        return route !== 'company' || companyAllows(c, activeSlug);
    };

    const entries = new Map();   // idx → ScoredChunk
    const entry = idx => {
        let e = entries.get(idx);
        if (!e) {
            e = { chunk: chunks[idx], score: 0, bm25Rank: null, vectorRank: null, titleRank: null, cosine: null, coverage: null, matchedTerms: 0 };
            entries.set(idx, e);
        }
        return e;
    };

    const lexical = (bm25 || []).filter(h => eligible(h.idx)).slice(0, LIST_DEPTH);
    lexical.forEach((h, i) => {
        const e = entry(h.idx);
        e.bm25Rank = i + 1;
        e.score += 1 / (rrfK + i + 1);
        e.matchedTerms = h.matchedTerms || 0;
        e.coverage = h.queryTerms > 0 ? (h.matchedTerms || 0) / h.queryTerms : 0;
    });

    if (Array.isArray(vector)) {
        const semantic = vector.filter(h => eligible(h.idx)).slice(0, LIST_DEPTH);
        semantic.forEach((h, i) => {
            const e = entry(h.idx);
            e.vectorRank = i + 1;
            e.score += 1 / (rrfK + i + 1);
            e.cosine = h.score;
        });
    }

    if (Array.isArray(title)) {
        const titled = title.filter(h => eligible(h.idx)).slice(0, LIST_DEPTH);
        titled.forEach((h, i) => {
            const e = entry(h.idx);
            e.titleRank = i + 1;
            e.score += 1 / (rrfK + i + 1);
        });
    }

    const perFile = new Map();
    return [...entries.values()]
        .sort((a, b) =>
            b.score - a.score ||
            (b.chunk.date || 0) - (a.chunk.date || 0) ||                 // newer note wins a tie (E25)
            (a.bm25Rank ?? Infinity) - (b.bm25Rank ?? Infinity) ||
            (a.vectorRank ?? Infinity) - (b.vectorRank ?? Infinity))
        .filter(e => {
            if (!(maxPerFile > 0)) return true;
            const n = perFile.get(e.chunk.path) || 0;
            perFile.set(e.chunk.path, n + 1);
            return n < maxPerFile;
        })
        .slice(0, k);
}

/**
 * FR-012: does this hit justify injecting context on the ambiguous route? The
 * caller injects when any hit it would send passes.
 * Vectors used → cosine >= minCosine. BM25-only → coverage >= 0.5 and >= 2 terms.
 */
function passesAmbiguousThreshold(hit, { vectorUsed, minCosine }) {
    if (!hit) return false;
    if (vectorUsed) return typeof hit.cosine === 'number' && hit.cosine >= minCosine;
    return typeof hit.coverage === 'number' && hit.coverage >= 0.5 && hit.matchedTerms >= 2;
}

module.exports = { fuseAndFilter, passesAmbiguousThreshold, companyAllows, RRF_K, LIST_DEPTH, MAX_PER_FILE };

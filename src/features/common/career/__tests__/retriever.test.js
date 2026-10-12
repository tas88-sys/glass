/**
 * retriever.test.js — T016, T029 (FR-010, FR-011, FR-012, FR-013, FR-014; E13, E14, E23, E24, E33)
 *
 * Run: node --test src/features/common/career/__tests__/retriever.test.js
 *
 * Fixtures are invented text only (spec C5).
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { fuseAndFilter, passesAmbiguousThreshold, RRF_K, LIST_DEPTH, MAX_PER_FILE } = require('../retriever');
const { buildVectorIndex } = require('../vectorIndex');
const {
    buildContextBlock, buildAddendum, BLOCK_CARD_LABEL, ADDENDUM_TEMPLATE, CARD_SOURCE, MAX_BLOCK_CHARS,
} = require('../contextBuilder');

const mk = (i, extra = {}) => ({
    id: `id${i}`, path: `notes/n${i}.md`, title: `n${i} › Section ${i}`, body: `Body of chunk ${i}.`,
    companies: [], date: 0, kind: 'section', hash: `h${i}`, ...extra,
});
const bm = (idx, score = 1, matchedTerms = 1, queryTerms = 2) => ({ idx, score, matchedTerms, queryTerms });
const vec = (idx, score) => ({ idx, score });

describe('fuseAndFilter: reciprocal rank fusion (FR-010)', () => {
    it('uses k = 60 by default and sums 1/(k + rank) over both lists', () => {
        assert.equal(RRF_K, 60);
        const chunks = [mk(0), mk(1)];
        const out = fuseAndFilter({
            chunks, route: 'personal', activeCompany: null, k: 4,
            bm25: [bm(0), bm(1)],                    // A rank 1, B rank 2
            vector: [vec(1, 0.9), vec(0, 0.5)],      // B rank 1, A rank 2 → tie on score
        });
        assert.equal(out.length, 2);
        const expected = 1 / 61 + 1 / 62;
        for (const h of out) assert.ok(Math.abs(h.score - expected) < 1e-12);
    });

    it('a chunk ranked well in both lists beats one ranked first in only one', () => {
        const chunks = [mk(0), mk(1), mk(2)];
        const out = fuseAndFilter({
            chunks, route: 'personal', activeCompany: null, k: 3,
            bm25: [bm(0), bm(1)],
            vector: [vec(2, 0.95), vec(1, 0.9)],
        });
        assert.equal(out[0].chunk.id, 'id1');
        assert.equal(out[0].bm25Rank, 2);
        assert.equal(out[0].vectorRank, 2);
    });

    it('breaks score ties toward the newer date (E25)', () => {
        const chunks = [mk(0, { date: 100 }), mk(1, { date: 200 })];
        const out = fuseAndFilter({
            chunks, route: 'personal', activeCompany: null, k: 2,
            bm25: [bm(0), bm(1)],
            vector: [vec(1, 0.9), vec(0, 0.5)],
        });
        assert.deepEqual(out.map(h => h.chunk.id), ['id1', 'id0']);
    });

    it('BM25-only when vector is null: keeps BM25 order, vector fields null', () => {
        const chunks = [mk(0), mk(1), mk(2)];
        const out = fuseAndFilter({
            chunks, route: 'personal', activeCompany: null, k: 3, vector: null,
            bm25: [bm(2, 5, 2, 2), bm(0, 3, 1, 2), bm(1, 1, 1, 4)],
        });
        assert.deepEqual(out.map(h => h.chunk.id), ['id2', 'id0', 'id1']);
        assert.deepEqual(out.map(h => h.bm25Rank), [1, 2, 3]);
        assert.ok(out.every(h => h.vectorRank === null && h.cosine === null));
    });

    it('carries cosine, coverage and matchedTerms on each hit', () => {
        const chunks = [mk(0), mk(1)];
        const out = fuseAndFilter({
            chunks, route: 'personal', activeCompany: null, k: 2,
            bm25: [bm(0, 2, 3, 4)],
            vector: [vec(1, 0.88), vec(0, 0.81)],
        });
        const a = out.find(h => h.chunk.id === 'id0');
        const b = out.find(h => h.chunk.id === 'id1');
        assert.equal(a.cosine, 0.81);
        assert.equal(a.coverage, 0.75);
        assert.equal(a.matchedTerms, 3);
        assert.equal(b.cosine, 0.88);
        assert.equal(b.coverage, null);
        assert.equal(b.matchedTerms, 0);
    });

    it('limits the output to k', () => {
        const chunks = Array.from({ length: 6 }, (_, i) => mk(i));
        const out = fuseAndFilter({ chunks, route: 'personal', activeCompany: null, k: 3, vector: null, bm25: chunks.map((_, i) => bm(i)) });
        assert.equal(out.length, 3);
    });

    it(`fuses only the top ${20} of each list (after filtering)`, () => {
        assert.equal(LIST_DEPTH, 20);
        const chunks = Array.from({ length: 30 }, (_, i) => mk(i));
        const out = fuseAndFilter({ chunks, route: 'personal', activeCompany: null, k: 30, vector: null, bm25: chunks.map((_, i) => bm(i)) });
        assert.equal(out.length, 20);
    });

    it('the title ranking is a third list: its rank adds 1/(k + rank) like the others', () => {
        const chunks = [mk(0), mk(1), mk(2)];
        const out = fuseAndFilter({
            chunks, route: 'personal', activeCompany: null, k: 3,
            bm25: [bm(0), bm(1)],
            vector: [vec(0, 0.9), vec(1, 0.8)],
            title: [vec(1, 0.95), vec(2, 0.7)],
        });
        assert.equal(out[0].chunk.id, 'id1', 'second in two lists and first in titles beats first in two lists');
        assert.equal(out[0].titleRank, 1);
        assert.ok(Math.abs(out[0].score - (1 / 62 + 1 / 62 + 1 / 61)) < 1e-12);
        const c = out.find(h => h.chunk.id === 'id2');
        assert.equal(c.titleRank, 2);
        assert.equal(c.bm25Rank, null);
        assert.equal(c.cosine, null, 'cosine comes from the text ranking only');
    });

    it('title: null (or absent) leaves the two-list fusion unchanged', () => {
        const chunks = [mk(0), mk(1)];
        const base = { chunks, route: 'personal', activeCompany: null, k: 2, bm25: [bm(0), bm(1)], vector: [vec(1, 0.9)] };
        assert.deepEqual(fuseAndFilter({ ...base, title: null }), fuseAndFilter(base));
        assert.ok(fuseAndFilter(base).every(h => h.titleRank === null));
    });

    it('returns [] for empty inputs and ignores out-of-range indexes', () => {
        assert.deepEqual(fuseAndFilter({ chunks: [], route: 'personal', activeCompany: null, k: 3, bm25: [], vector: null }), []);
        const out = fuseAndFilter({ chunks: [mk(0)], route: 'personal', activeCompany: null, k: 3, bm25: [bm(5), bm(0)], vector: [vec(9, 0.9)] });
        assert.deepEqual(out.map(h => h.chunk.id), ['id0']);
    });
});

describe('fuseAndFilter: one section per file (FR-010)', () => {
    const same = (i, extra = {}) => mk(i, { path: 'notes/bank.md', title: `bank › Q${i}`, ...extra });

    it('keeps only the best-ranked section of each file by default', () => {
        assert.equal(MAX_PER_FILE, 1);
        const chunks = [same(0), same(1), mk(2), same(3)];
        const out = fuseAndFilter({ chunks, route: 'personal', activeCompany: null, k: 4, vector: null, bm25: [bm(0), bm(1), bm(2), bm(3)] });
        assert.deepEqual(out.map(h => h.chunk.id), ['id0', 'id2']);
    });

    it('the cap applies before k, so other files fill the freed places', () => {
        const chunks = [same(0), same(1), mk(2), mk(3)];
        const out = fuseAndFilter({ chunks, route: 'personal', activeCompany: null, k: 3, vector: null, bm25: [bm(0), bm(1), bm(2), bm(3)] });
        assert.deepEqual(out.map(h => h.chunk.id), ['id0', 'id2', 'id3']);
    });

    it('maxPerFile raises or (with 0) removes the cap', () => {
        const chunks = [same(0), same(1), same(2)];
        const args = { chunks, route: 'personal', activeCompany: null, k: 3, vector: null, bm25: [bm(0), bm(1), bm(2)] };
        assert.equal(fuseAndFilter({ ...args, maxPerFile: 2 }).length, 2);
        assert.equal(fuseAndFilter({ ...args, maxPerFile: 0 }).length, 3);
    });

    it('the company filter runs first: a dropped chunk does not use up its file', () => {
        const chunks = [same(0, { companies: ['Orbit Pay'] }), same(1, { companies: [] })];
        const out = fuseAndFilter({ chunks, route: 'company', activeCompany: 'Bridge', k: 2, vector: null, bm25: [bm(0), bm(1)] });
        assert.deepEqual(out.map(h => h.chunk.id), ['id1']);
    });
});

describe('fuseAndFilter: company scope (FR-011; E13, E14)', () => {
    const chunks = [
        mk(0, { companies: ['Orbit Pay'] }),           // another company
        mk(1, { companies: ['Bridge'] }),              // the active company
        mk(2, { companies: [] }),                      // untagged (generic)
        mk(3, { companies: ['Bridge', 'Orbit Pay'] }), // folder shared by both
        mk(4, { companies: ['Lumen Works'] }),
    ];
    const bm25 = [bm(0), bm(1), bm(2), bm(3), bm(4)];

    it('drops chunks tagged with another company, keeps the active company and untagged ones (E13)', () => {
        const out = fuseAndFilter({ chunks, bm25, vector: null, route: 'company', activeCompany: 'Bridge', k: 10 });
        assert.deepEqual(out.map(h => h.chunk.id), ['id1', 'id2', 'id3']);
        assert.deepEqual(out.map(h => h.bm25Rank), [1, 2, 3], 'ranks are recomputed after filtering');
    });

    it('matches the active company case- and accent-insensitively', () => {
        const out = fuseAndFilter({ chunks, bm25, vector: null, route: 'company', activeCompany: 'orbit-pay', k: 10 });
        assert.deepEqual(out.map(h => h.chunk.id), ['id0', 'id2', 'id3']);
    });

    it('uses only untagged chunks when no company is known (E14)', () => {
        const out = fuseAndFilter({ chunks, bm25, vector: null, route: 'company', activeCompany: null, k: 10 });
        assert.deepEqual(out.map(h => h.chunk.id), ['id2']);
    });

    it('other routes ignore company tags', () => {
        for (const route of ['personal', 'ambiguous']) {
            const out = fuseAndFilter({ chunks, bm25, vector: null, route, activeCompany: 'Bridge', k: 10 });
            assert.equal(out.length, 5, route);
        }
    });
});

describe('passesAmbiguousThreshold (FR-012)', () => {
    const hit = extra => ({ chunk: mk(0), score: 0.03, bm25Rank: 1, vectorRank: 1, cosine: null, coverage: null, matchedTerms: 0, ...extra });

    it('with vectors: top-hit cosine against minCosine', () => {
        assert.equal(passesAmbiguousThreshold(hit({ cosine: 0.86 }), { vectorUsed: true, minCosine: 0.85 }), true);
        assert.equal(passesAmbiguousThreshold(hit({ cosine: 0.85 }), { vectorUsed: true, minCosine: 0.85 }), true);
        assert.equal(passesAmbiguousThreshold(hit({ cosine: 0.84 }), { vectorUsed: true, minCosine: 0.85 }), false);
        assert.equal(passesAmbiguousThreshold(hit({ cosine: null, coverage: 1, matchedTerms: 5 }), { vectorUsed: true, minCosine: 0.85 }), false);
    });

    it('BM25-only: coverage >= 0.5 and at least 2 matched terms', () => {
        const opts = { vectorUsed: false, minCosine: 0.85 };
        assert.equal(passesAmbiguousThreshold(hit({ coverage: 0.5, matchedTerms: 2 }), opts), true);
        assert.equal(passesAmbiguousThreshold(hit({ coverage: 1, matchedTerms: 1 }), opts), false);
        assert.equal(passesAmbiguousThreshold(hit({ coverage: 0.4, matchedTerms: 4 }), opts), false);
        assert.equal(passesAmbiguousThreshold(hit({ coverage: null, matchedTerms: 0, cosine: 0.99 }), opts), false);
    });

    it('no hit → false', () => {
        assert.equal(passesAmbiguousThreshold(undefined, { vectorUsed: true, minCosine: 0.5 }), false);
        assert.equal(passesAmbiguousThreshold(undefined, { vectorUsed: false, minCosine: 0.5 }), false);
    });
});

describe('buildVectorIndex', () => {
    const norm = v => { const n = Math.hypot(...v); return v.map(x => x / n); };
    const rows = new Float32Array([...norm([1, 0, 0]), ...norm([0, 1, 0]), ...norm([1, 1, 0])]);

    it('returns cosine scores, best first', () => {
        const idx = buildVectorIndex(rows, 3);
        const hits = idx.search(new Float32Array(norm([1, 0.2, 0])), 3);
        assert.deepEqual(hits.map(h => h.idx), [0, 2, 1]);
        assert.ok(Math.abs(hits[0].score - norm([1, 0.2, 0])[0]) < 1e-6);
    });

    it('limits to k and orders ties by index', () => {
        const idx = buildVectorIndex(new Float32Array([1, 0, 1, 0, 0, 1]), 2);
        assert.deepEqual(idx.search(new Float32Array([1, 0]), 1).map(h => h.idx), [0]);
        assert.deepEqual(idx.search(new Float32Array([1, 0]), 3).map(h => h.idx), [0, 1, 2]);
    });

    it('returns [] on a dimension mismatch, an empty index or k <= 0', () => {
        const idx = buildVectorIndex(rows, 3);
        assert.deepEqual(idx.search(new Float32Array([1, 0]), 3), []);
        assert.deepEqual(idx.search(new Float32Array([1, 0, 0]), 0), []);
        assert.deepEqual(buildVectorIndex(new Float32Array(0), 3).search(new Float32Array([1, 0, 0]), 3), []);
    });
});

describe('buildContextBlock (FR-013)', () => {
    const scored = (chunk, i) => ({ chunk, score: 1 / (60 + i + 1), bm25Rank: i + 1, vectorRank: null, cosine: null, coverage: 1, matchedTerms: 2 });
    const CORE = '# Card\n- Fact one.\n- Fact two.';

    it('puts the labeled card first, then each chunk under its title', () => {
        const hits = [mk(1), mk(2)].map(scored);
        const { block, sources, chunkIds, cardOverCap } = buildContextBlock({ core: CORE, hits });
        assert.equal(BLOCK_CARD_LABEL, '[canonical facts]');
        assert.equal(block, `[canonical facts]\n${CORE}\n\n[n1 › Section 1]\nBody of chunk 1.\n\n[n2 › Section 2]\nBody of chunk 2.`);
        assert.deepEqual(sources, ['n1 › Section 1', 'n2 › Section 2', CARD_SOURCE]);
        assert.equal(CARD_SOURCE, 'canonical facts');
        assert.deepEqual(chunkIds, ['id1', 'id2']);
        assert.equal(cardOverCap, false);
    });

    it('without a card: chunks only, no card source', () => {
        const { block, sources } = buildContextBlock({ core: '', hits: [scored(mk(1), 0)] });
        assert.equal(block, '[n1 › Section 1]\nBody of chunk 1.');
        assert.deepEqual(sources, ['n1 › Section 1']);
    });

    it('card only when there are no hits; empty when there is nothing', () => {
        assert.equal(buildContextBlock({ core: CORE, hits: [] }).block, `[canonical facts]\n${CORE}`);
        assert.deepEqual(buildContextBlock({ core: '', hits: [] }), { block: '', sources: [], chunkIds: [], cardOverCap: false });
    });

    it('merges pieces of the same note section under one header (dedupe by path + title)', () => {
        const a = mk(1, { id: 'p1', body: 'Part one.' });
        const b = mk(1, { id: 'p2', body: 'Part two.' });
        const { block, sources, chunkIds } = buildContextBlock({ core: '', hits: [a, b].map(scored) });
        assert.equal(block, '[n1 › Section 1]\nPart one.\n\nPart two.');
        assert.deepEqual(sources, ['n1 › Section 1']);
        assert.deepEqual(chunkIds, ['p1', 'p2']);
    });

    it('keeps two chunks with the same title from different files (E24)', () => {
        const a = mk(1, { title: 'bank › Conflict' });
        const b = mk(2, { title: 'bank › Conflict' });
        const { block, chunkIds } = buildContextBlock({ core: '', hits: [a, b].map(scored) });
        assert.equal(chunkIds.length, 2);
        assert.equal(block.split('[bank › Conflict]').length - 1, 2);
    });

    it(`caps the block at ${9000} chars: the card stays whole, lowest-ranked chunks drop first, then a paragraph cut (E23)`, () => {
        assert.equal(MAX_BLOCK_CHARS, 9000);
        const core = 'C'.repeat(6000);
        const p = n => `${String(n).repeat(1)}`.padEnd(500, 'x');
        const body = [p(1), p(2)].join('\n\n');                  // 1,002 chars
        const hits = [1, 2, 3, 4].map(i => scored(mk(i, { body }), i - 1));
        const { block, chunkIds } = buildContextBlock({ core, hits });
        assert.ok(block.length <= 9000, `block is ${block.length}`);
        assert.ok(block.startsWith(`[canonical facts]\n${core}\n\n`), 'card whole and first');
        assert.deepEqual(chunkIds, ['id1', 'id2', 'id3'], 'chunk 4 dropped; chunk 3 cut');
        const last = block.slice(block.lastIndexOf('[n3 › Section 3]'));
        assert.equal(last, `[n3 › Section 3]\n${p(1)}`, 'cut at a paragraph boundary');
    });

    it('respects a custom maxChars', () => {
        const hits = [scored(mk(1, { body: 'a'.repeat(100) }), 0), scored(mk(2, { body: 'b'.repeat(100) }), 1)];
        const { chunkIds, block } = buildContextBlock({ core: '', hits, maxChars: 150 });
        assert.deepEqual(chunkIds, ['id1']);
        assert.ok(block.length <= 150);
    });

    it('a card over the cap is injected whole, without chunks (E33)', () => {
        const core = 'C'.repeat(10000);
        const { block, chunkIds, sources, cardOverCap } = buildContextBlock({ core, hits: [scored(mk(1), 0)] });
        assert.equal(block, `[canonical facts]\n${core}`);
        assert.deepEqual(chunkIds, []);
        assert.deepEqual(sources, [CARD_SOURCE]);
        assert.equal(cardOverCap, true);
    });

    it('neutralizes the prompt placeholder if a note contains it', () => {
        const { block } = buildContextBlock({ core: '', hits: [scored(mk(1, { body: 'see {{CONVERSATION_HISTORY}} here' }), 0)] });
        assert.ok(!block.includes('{{CONVERSATION_HISTORY}}'));
    });
});

describe('buildAddendum (FR-014)', () => {
    it('without a company: the template with an empty clause', () => {
        assert.equal(buildAddendum(null), ADDENDUM_TEMPLATE.replace('{COMPANY_CLAUSE}', ''));
        assert.match(buildAddendum(null), /interviewer's company\. Answer in the language/);
    });

    it('with a company: names it once', () => {
        const a = buildAddendum('Bridge');
        assert.equal(a, ADDENDUM_TEMPLATE.replace('{COMPANY_CLAUSE}', " The interviewer's company is Bridge."));
    });

    it('matches the contract text', () => {
        assert.equal(ADDENDUM_TEMPLATE,
            "The interviewer is asking about the candidate's own background. Answer in first person as the candidate, using only facts from the User-provided context; the canonical facts override the other notes when they disagree. Do not invent employers, dates, metrics or projects. For \"tell me about a time\" questions, pick one story and give situation, action and result in a few bullets. The notes were prepared for different companies: never present a company named in them as the interviewer's company.{COMPANY_CLAUSE} Answer in the language the interviewer used.");
    });
});

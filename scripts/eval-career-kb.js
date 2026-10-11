#!/usr/bin/env node
'use strict';

// Career context eval (spec 2026-10-11, FR-019, T027).
//
//   node scripts/eval-career-kb.js [--kb <dir>] [--bm25-only] [--json] [--cache-dir <dir>] [--min-cosine <x>]
//
// Reads the KB at --kb or CAREER_KB_PATH (also read from .env) and its
// glass-eval/questions.jsonl, with the vectors the app already built (the
// default --cache-dir is the app's own; see career-cache-dir.js). It
// runs every item through the career module with the item's own source file
// left out (leave-source-out), and reports:
//   - the router confusion matrix (full set and holdout);
//   - recall@3 on the fused ranking and injected recall on the block, for
//     personal items with at least one retrievable non-card gold note;
//   - routing-only scoring for items whose gold is only the card;
//   - company leaks: company-route answers drawing on another company's notes;
//   - p50/p95 per stage, with the query embedding prefetched (answer path)
//     and the query embedding time on its own.
// Success criteria (SC-001..SC-004) are judged on the full set; the holdout
// only flags overfitting (more than 10 points below the tuning split).
//
// Output is ids, counts and timings only: never question text, note titles or
// paths, so it can be pasted into a PR of this public repo (spec C5).

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const { createCareerModule } = require('../src/features/common/career');
const { createEmbedder } = require('../src/features/common/career/embedder');
const { createKbService } = require('../src/features/common/career/kbService');
const { companyAllows } = require('../src/features/common/career/retriever');
const { slugify } = require('../src/features/common/career/textNormalize');
const { appCacheDir } = require('./career-cache-dir');

const ROUTES = ['personal', 'company', 'ambiguous', 'general'];
const TARGETS = {
    personalRouted: 0.95,       // SC-001
    generalAsPersonal: 0.10,    // SC-001
    injectedRecall: 0.85,       // SC-002
    leaks: 0,                   // SC-003
    answerPathP95Ms: 20,        // SC-004
    bm25P95Ms: 5,               // SC-004
    queryEmbeddingP95Ms: 800,   // SC-004
    overfitGapPts: 10,          // FR-019
};

function parseArgs(argv) {
    const a = { kb: process.env.CAREER_KB_PATH || '', bm25Only: false, json: false, cacheDir: appCacheDir(), minCosine: undefined };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--kb') a.kb = argv[++i];
        else if (k === '--bm25-only') a.bm25Only = true;
        else if (k === '--json') a.json = true;
        else if (k === '--cache-dir') a.cacheDir = argv[++i];
        else if (k === '--min-cosine') a.minCosine = Number(argv[++i]);
        else throw new Error(`unknown argument: ${k}`);
    }
    if (!a.kb) throw new Error('set CAREER_KB_PATH or pass --kb <dir>');
    return a;
}

const pct = (xs, p) => {
    if (!xs.length) return null;
    const s = xs.slice().sort((x, y) => x - y);
    return Math.round(s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] * 10) / 10;
};
const rate = (n, d) => (d ? Math.round((n / d) * 1000) / 1000 : null);
const pts = x => (x == null ? '-' : `${(x * 100).toFixed(1)}%`);

function readItems(kb) {
    const file = path.join(kb, 'glass-eval', 'questions.jsonl');
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.trim()).map((l, i) => {
        try {
            return JSON.parse(l);
        } catch {
            throw new Error(`questions.jsonl line ${i + 1} is not valid JSON`);
        }
    });
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const kb = path.resolve(args.kb);
    const items = readItems(kb);

    // The card paths come from the manifest the module also reads.
    const snap = await createKbService({ root: kb }).refresh();
    if (!snap) throw new Error('KB folder missing or unreadable');
    let core = [];
    try {
        core = JSON.parse(fs.readFileSync(path.join(kb, 'glass-kb.json'), 'utf8')).core || [];
    } catch {
        core = [];
    }
    const isCore = p => core.includes(p);
    const chunkById = new Map(snap.chunks.map(c => [c.id, c]));

    const embedder = args.bm25Only ? null : createEmbedder({ cacheDir: () => args.cacheDir });
    const mod = createCareerModule({
        env: { CAREER_KB_PATH: kb },
        embedder,
        debug: false,
        minCosine: args.minCosine,
    });
    await mod.warm();
    if (embedder) {
        const t0 = performance.now();
        await embedder.sync(snap.chunks);
        if (!embedder.isReadyFor(snap.chunks)) throw new Error('embeddings unavailable; run with --bm25-only');
        process.stderr.write(`[eval] vectors ready in ${Math.round(performance.now() - t0)} ms (${embedder.vectorCount()} rows)\n`);
    }
    const mode = embedder ? 'hybrid' : 'bm25-only';

    const matrix = split => Object.fromEntries(ROUTES.map(r => [r, Object.fromEntries(ROUTES.map(x => [x, 0]))]));
    const confusion = { all: matrix(), holdout: matrix(), tuning: matrix() };
    const recall = { all: { n: 0, top3: 0, injected: 0 }, holdout: { n: 0, top3: 0, injected: 0 }, tuning: { n: 0, top3: 0, injected: 0 } };
    const cardOnly = { n: 0, injectedCard: 0 };
    const misses = { routing: [], recall: [] };
    let leaks = 0;
    let otherCompanyOnOtherRoutes = 0;
    const t = { route: [], bm25: [], answerPath: [], queryEmbedding: [] };

    for (const q of items) {
        const split = q.holdout ? 'holdout' : 'tuning';
        const excludePaths = q.source ? [q.source] : [];
        if (embedder) {
            const t0 = performance.now();
            mod.prefetch(q.text);
            await embedder.query(q.text, 60_000);               // the debounce window absorbs this
            t.queryEmbedding.push(performance.now() - t0);
        }
        const trace = {};
        const ctx = await mod.getCareerContext(q.text, { prev: null, activeCompany: q.company || null }, { excludePaths, trace });
        if (!ctx) throw new Error(`no context for ${q.id}`);
        t.route.push(ctx.timings.routeMs);
        if (ctx.route !== 'general') {
            t.bm25.push(ctx.timings.bm25Ms);
            t.answerPath.push(ctx.timings.totalMs);
        }

        for (const s of ['all', split]) confusion[s][q.route][ctx.route]++;
        if (ctx.route !== q.route) misses.routing.push(`${q.id}:${q.route}->${ctx.route}`);

        const injected = ctx.chunkIds.map(id => chunkById.get(id)).filter(Boolean);
        const fused = (trace.hits || []).slice(0, 3);
        const gold = (q.gold || []).filter(g => g && g.path && !isCore(g.path) && g.path !== q.source);
        const hit = list => list.some(c => gold.some(g => c.path === g.path && c.title.includes(g.anchor || '')));

        if (q.route === 'personal') {
            if (gold.length) {
                const top3 = hit(fused);
                const inj = hit(injected);
                for (const s of ['all', split]) {
                    recall[s].n++;
                    if (top3) recall[s].top3++;
                    if (inj) recall[s].injected++;
                }
                if (!inj) misses.recall.push(q.id);
            } else {
                cardOnly.n++;
                if (ctx.block) cardOnly.injectedCard++;
            }
        }

        // SC-003: a company-route answer must not use another company's notes.
        const active = trace.activeCompany ? slugify(trace.activeCompany) : '';
        const foreign = injected.filter(c => !companyAllows(c, active)).length;
        if (ctx.route === 'company') leaks += foreign;
        else otherCompanyOnOtherRoutes += foreign;
    }
    if (embedder) embedder.close();

    const routed = (m, from, to) => m[from][to];
    const total = (m, from) => ROUTES.reduce((s, r) => s + m[from][r], 0);
    const personalRouted = s => rate(routed(confusion[s], 'personal', 'personal'), total(confusion[s], 'personal'));
    const generalAsPersonal = s => rate(routed(confusion[s], 'general', 'personal'), total(confusion[s], 'general'));
    const recallOf = (s, k) => rate(recall[s][k], recall[s].n);

    const gap = (a, b) => (a == null || b == null ? 0 : Math.round((a - b) * 1000) / 10);
    const overfit = {
        personalRoutedGapPts: gap(personalRouted('tuning'), personalRouted('holdout')),
        injectedRecallGapPts: gap(recallOf('tuning', 'injected'), recallOf('holdout', 'injected')),
    };
    overfit.flag = overfit.personalRoutedGapPts > TARGETS.overfitGapPts || overfit.injectedRecallGapPts > TARGETS.overfitGapPts;

    const latency = {
        routeMs: { p50: pct(t.route, 0.5), p95: pct(t.route, 0.95) },
        bm25Ms: { p50: pct(t.bm25, 0.5), p95: pct(t.bm25, 0.95) },
        answerPathMs: { p50: pct(t.answerPath, 0.5), p95: pct(t.answerPath, 0.95) },
        queryEmbeddingMs: embedder ? { p50: pct(t.queryEmbedding, 0.5), p95: pct(t.queryEmbedding, 0.95) } : null,
    };

    const checks = {
        'SC-001 personal routed personal': personalRouted('all') >= TARGETS.personalRouted,
        'SC-001 general routed personal': generalAsPersonal('all') <= TARGETS.generalAsPersonal,
        [`SC-002 ${mode} injected recall`]: recallOf('all', 'injected') >= TARGETS.injectedRecall,
        'SC-003 company leaks': leaks === TARGETS.leaks,
        'SC-004 answer path p95': latency.answerPathMs.p95 == null || latency.answerPathMs.p95 <= TARGETS.answerPathP95Ms,
        'SC-004 BM25 p95': latency.bm25Ms.p95 == null || latency.bm25Ms.p95 <= TARGETS.bm25P95Ms,
        'SC-004 query embedding p95': !embedder || latency.queryEmbeddingMs.p95 <= TARGETS.queryEmbeddingP95Ms,
        'FR-019 no overfit flag': !overfit.flag,
    };
    const pass = Object.values(checks).every(Boolean);

    const report = {
        pass,
        mode,
        items: items.length,
        holdout: items.filter(q => q.holdout).length,
        router: {
            personalRouted: { all: personalRouted('all'), tuning: personalRouted('tuning'), holdout: personalRouted('holdout') },
            generalAsPersonal: { all: generalAsPersonal('all'), tuning: generalAsPersonal('tuning'), holdout: generalAsPersonal('holdout') },
            confusion,
        },
        recall: {
            items: recall.all.n,
            recallAt3: { all: recallOf('all', 'top3'), tuning: recallOf('tuning', 'top3'), holdout: recallOf('holdout', 'top3') },
            injected: { all: recallOf('all', 'injected'), tuning: recallOf('tuning', 'injected'), holdout: recallOf('holdout', 'injected') },
        },
        cardOnly: { items: cardOnly.n, cardInjected: rate(cardOnly.injectedCard, cardOnly.n) },
        leaks,
        otherCompanyChunksOnOtherRoutes: otherCompanyOnOtherRoutes,
        latency,
        overfit,
        checks,
        misses,
    };

    if (args.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
        const lines = [];
        lines.push(`Career context eval (${mode}), ${report.items} items, ${report.holdout} holdout`);
        lines.push('');
        lines.push('Router confusion (expected → routed), full set:');
        lines.push(`  ${''.padEnd(10)}${ROUTES.map(r => r.padStart(10)).join('')}`);
        for (const r of ROUTES) lines.push(`  ${r.padEnd(10)}${ROUTES.map(x => String(confusion.all[r][x]).padStart(10)).join('')}`);
        lines.push(`  personal → personal: ${pts(report.router.personalRouted.all)} (tuning ${pts(report.router.personalRouted.tuning)}, holdout ${pts(report.router.personalRouted.holdout)})`);
        lines.push(`  general → personal:  ${pts(report.router.generalAsPersonal.all)}`);
        lines.push('');
        lines.push(`Recall, ${recall.all.n} personal items with a retrievable note (leave-source-out):`);
        lines.push(`  recall@3:        ${pts(report.recall.recallAt3.all)} (tuning ${pts(report.recall.recallAt3.tuning)}, holdout ${pts(report.recall.recallAt3.holdout)})`);
        lines.push(`  injected recall: ${pts(report.recall.injected.all)} (tuning ${pts(report.recall.injected.tuning)}, holdout ${pts(report.recall.injected.holdout)})`);
        lines.push(`  card-only items: ${cardOnly.n}, card injected ${pts(report.cardOnly.cardInjected)}`);
        lines.push('');
        lines.push(`Company leaks (company route): ${leaks}; other-company chunks on other routes: ${otherCompanyOnOtherRoutes}`);
        lines.push('');
        lines.push(`Latency p50/p95 ms: route ${latency.routeMs.p50}/${latency.routeMs.p95}, BM25 ${latency.bm25Ms.p50}/${latency.bm25Ms.p95}, answer path ${latency.answerPathMs.p50}/${latency.answerPathMs.p95}` +
            (embedder ? `, query embedding ${latency.queryEmbeddingMs.p50}/${latency.queryEmbeddingMs.p95}` : ''));
        lines.push(`Overfit gap (tuning − holdout): personal routing ${overfit.personalRoutedGapPts} pts, injected recall ${overfit.injectedRecallGapPts} pts${overfit.flag ? '  ← OVERFIT' : ''}`);
        lines.push('');
        for (const [k, ok] of Object.entries(checks)) lines.push(`  ${ok ? 'PASS' : 'FAIL'}  ${k}`);
        lines.push('');
        lines.push(`Routing misses: ${misses.routing.join(' ') || '-'}`);
        lines.push(`Recall misses:  ${misses.recall.join(' ') || '-'}`);
        lines.push(pass ? 'RESULT: PASS' : 'RESULT: FAIL');
        process.stdout.write(`${lines.join('\n')}\n`);
    }
    process.exitCode = pass ? 0 : 1;
}

main().catch(err => {
    process.stderr.write(`eval failed: ${err.message}\n`);
    process.exitCode = 2;
});

#!/usr/bin/env node
'use strict';

// Replays a recorded interview through the live answer's gate and the career
// router, as the app runs them (spec 2026-10-13-career-router-jev, R19).
//
//   node scripts/replay-career-session.js --session <file> [--kb <dir>] [--router regex|jev] [--list] [--json]
//
// --session: a JSONL file, one segment per line, in the order heard:
//   { i, speaker: 'them'|'me', t, text, ask?, route? }
//   t      seconds from the start of the session
//   ask    them segments only: 'y' an answer should appear; 'n' it should not
//          (an acknowledgment, a filler, the interviewer telling something);
//          'e' either (a fragment the next segment completes, a confirmation)
//   route  the expected route for 'y' and 'e' segments
// Relative paths resolve against the KB. The files live with the KB, never in
// this public repo (spec C5).
//
// For each them segment, in order, the app's own decisions: the backchannel and
// question gates (questionGate.js), classifyTurn and Jev's asks for a
// statement-form segment while Jev is on (hasCareerCue otherwise), the de-dup
// tail, the debounce's drop on a low asks (wantsAnswer), and for an armed
// segment getCareerContext with the follow-up state (prev) the live service keeps.
// The route waits at most 1,050 ms from the gate: the 800 ms debounce plus the
// resolve budget. Not replayed: the debounce merging segments under 800 ms
// apart (timestamps are whole seconds), and the LLM, which is never called.
//
// Reports armed 'n' segments (LLM calls an answer should not have cost),
// unarmed 'y' segments (missed answers), routes on armed 'y'/'e' segments
// against the label, sources, fallbacks, follow-ups and the Jev call p50/p95.
// Output is ids and counts only; --list adds one line per them segment with
// its id and decisions, never its text.

const fs = require('node:fs');
const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const { createCareerModule } = require('../src/features/common/career');
const { readConfig } = require('../src/features/common/career/jevRouter');
const { isLikelyQuestion, isBackchannel, normalizeTail, shouldTriggerAnswer } = require('../src/features/listen/summary/questionGate');

const ROUTES = ['personal', 'company', 'ambiguous', 'general'];
const ROUTE_WAIT_MS = 800 + 250;

function parseArgs(argv) {
    const cfg = readConfig(process.env);
    const a = { kb: process.env.CAREER_KB_PATH || '', router: cfg.wanted === 'jev' && cfg.apiKey ? 'jev' : 'regex', list: false, json: false };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--kb') a.kb = argv[++i];
        else if (k === '--session') a.session = argv[++i];
        else if (k === '--router') a.router = argv[++i];
        else if (k === '--list') a.list = true;
        else if (k === '--json') a.json = true;
        else throw new Error(`unknown argument: ${k}`);
    }
    if (!a.kb) throw new Error('set CAREER_KB_PATH or pass --kb <dir>');
    if (!a.session) throw new Error('pass --session <file>');
    if (a.router !== 'regex' && a.router !== 'jev') throw new Error('--router takes regex or jev');
    if (a.router === 'jev' && !cfg.apiKey) throw new Error('--router jev needs TYPESAFE_API_KEY (in .env)');
    return a;
}

function readSession(kb, file) {
    const full = path.resolve(kb, file);
    return fs.readFileSync(full, 'utf8').split(/\r?\n/).filter(l => l.trim()).map((l, n) => {
        let s;
        try {
            s = JSON.parse(l);
        } catch {
            throw new Error(`${path.basename(full)} line ${n + 1} is not valid JSON`);
        }
        if (typeof s.text !== 'string' || !Number.isFinite(s.t)) throw new Error(`${path.basename(full)} line ${n + 1}: text and t are required`);
        return s;
    });
}

const pct = (xs, p) => {
    if (!xs.length) return null;
    const s = xs.slice().sort((x, y) => x - y);
    return Math.round(s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] * 10) / 10;
};
const inc = (o, k) => {
    o[k] = (o[k] || 0) + 1;
};

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const kb = path.resolve(args.kb);
    const segments = readSession(kb, args.session);
    const them = segments.filter(s => String(s.speaker).toLowerCase() === 'them');

    const env = { CAREER_KB_PATH: kb, CAREER_ROUTER: args.router };
    if (args.router === 'jev') {
        for (const k of Object.keys(process.env)) if (k === 'TYPESAFE_API_KEY' || k.startsWith('CAREER_ROUTER_')) env[k] = process.env[k];
        env.CAREER_ROUTER = 'jev';
        process.stderr.write(`[replay] router jev: up to ${them.length * 2} segments and the manifest's names go to TypeSafe\n`);
    }
    const mod = createCareerModule({ env, embedder: null, debug: false });
    await mod.warm();

    let prev = null;            // { route, queryTerms, anchorText, t }: the live service's careerPrev
    let lastTail = null;
    let activeCompany = null;
    let lastThem = null;        // { text, t }: the live service's lastThemTurn
    let before = null;          // the segment before the current one
    const session = t => {
        const ss = {
            prev: prev ? { route: prev.route, queryTerms: prev.queryTerms, anchorText: prev.anchorText, ts: Date.now() - (t - prev.t) * 1000 } : null,
            activeCompany,
        };
        if (before) ss.before = { text: before.text, ts: Date.now() - (t - before.t) * 1000 };
        return ss;
    };

    const r = {
        router: args.router,
        segments: segments.length,
        them: them.length,
        labels: { y: 0, e: 0, n: 0, none: 0 },
        armed: { total: 0, y: 0, e: 0, n: 0, none: 0, byQuestionGate: 0, byRouterGate: 0 },
        backchannel: 0,
        dropped: { total: 0, y: 0, e: 0, n: 0, none: 0, ids: [] },
        missed: [],
        wasted: [],
        routes: Object.fromEntries(ROUTES.map(x => [x, Object.fromEntries(ROUTES.map(y => [y, 0]))])),
        routeErrors: [],
        sources: {},
        fallbacks: {},
        gateFallbacks: {},
        followUps: 0,
        jevMs: { p50: null, p95: null },
    };
    const jevMs = [];
    const lines = [];

    for (const s of them) {
        const label = s.ask === 'y' || s.ask === 'e' || s.ask === 'n' ? s.ask : 'none';
        inc(r.labels, label);
        if (!activeCompany) activeCompany = mod.detectCompany(s.text) || null;
        before = lastThem;
        if (!isBackchannel(s.text)) lastThem = { text: s.text, t: s.t };

        // The gate, as SummaryService.triggerAnswerIfNeeded runs it.
        let armed = false;
        let gate = 'question';
        const policy = mod.askPolicy();
        if (isBackchannel(s.text)) {
            gate = 'backchannel';
            r.backchannel++;
        } else if (!isLikelyQuestion(s.text) && mod.gateUsesJev()) {
            gate = 'router';
            const d = await mod.classifyTurn(s.text, session(s.t));
            if (d && d.fallback) inc(r.gateFallbacks, d.fallback);
            const asksOk = !d || typeof d.asks !== 'number' || !policy || d.asks >= policy.min;
            const cue = !!d && (d.route === 'personal' || d.route === 'company') && asksOk;
            armed = shouldTriggerAnswer('them', s.text, lastTail, false, () => cue);
        } else {
            armed = shouldTriggerAnswer('them', s.text, lastTail, false, t => mod.hasCareerCue(t));
        }
        // The debounce's drop (R19): Jev says the turn wants no answer. Live, the
        // call starts when the turn is armed and the debounce gives it 800 ms;
        // classifyTurn's wait (700 ms) stands in for that here.
        if (armed && gate === 'question' && mod.gateUsesJev()) await mod.classifyTurn(s.text, session(s.t));
        if (armed && mod.gateUsesJev() && !(await mod.wantsAnswer(s.text, session(s.t)))) {
            armed = false;
            gate += '+dropped';
            r.dropped.total++;
            inc(r.dropped, label);
            r.dropped.ids.push(s.i);
        }

        let line = `${s.i ?? '-'} ask=${label} gate=${gate} armed=${armed ? 'yes' : 'no'}`;
        if (args.list && gate !== 'backchannel' && mod.gateUsesJev()) {
            const d = await mod.classifyTurn(s.text, session(s.t));       // the call the gate made, from the cache
            if (d && typeof d.asks === 'number') line += ` asks=${d.asks.toFixed(2)}`;
            if (d) line += ` jev=${d.cue}`;
        }
        if (armed) {
            r.armed.total++;
            inc(r.armed, label);
            r.armed[gate === 'router' ? 'byRouterGate' : 'byQuestionGate']++;
            if (label === 'n') r.wasted.push(s.i);
            lastTail = normalizeTail(s.text);
            const ctx = await mod.getCareerContext(s.text, session(s.t), { routeBudgetMs: ROUTE_WAIT_MS });
            const route = ctx ? ctx.route : 'general';
            const src = ctx ? (ctx.routeFallback ? `regex(${ctx.routeFallback})` : ctx.routeSource) : '-';
            inc(r.sources, src);
            if (ctx && ctx.routeFallback) inc(r.fallbacks, ctx.routeFallback);
            if (ctx && ctx.jevMs != null) jevMs.push(ctx.jevMs);
            if (ctx && ctx.cue === 'follow-up') r.followUps++;
            if ((label === 'y' || label === 'e') && ROUTES.includes(s.route)) {
                r.routes[s.route][route]++;
                if (s.route !== route) r.routeErrors.push(`${s.i}:${s.route}->${route}`);
            }
            prev = ctx && (route === 'personal' || route === 'company')
                ? { route, queryTerms: ctx.queryTerms || [], anchorText: ctx.anchorText || '', t: s.t }
                : null;
            line += ` route=${route} cue=${ctx && ctx.cue ? ctx.cue : '-'} src=${src}`;
        } else if (label === 'y') {
            r.missed.push(s.i);
        }
        if (s.route && (label === 'y' || label === 'e')) line += ` expected=${s.route}`;
        lines.push(line);
    }
    r.jevMs = { p50: pct(jevMs, 0.5), p95: pct(jevMs, 0.95) };
    r.router = mod.routerStats ? { asked: args.router, ...mod.routerStats() } : args.router;

    if (args.json) {
        process.stdout.write(`${JSON.stringify(args.list ? { ...r, lines } : r, null, 2)}\n`);
        return;
    }
    const out = [];
    out.push(`replay: ${r.segments} segments, ${r.them} them; labels y=${r.labels.y} e=${r.labels.e} n=${r.labels.n} unlabeled=${r.labels.none}; router ${args.router}`);
    out.push(`armed ${r.armed.total} (question gate ${r.armed.byQuestionGate}, router gate ${r.armed.byRouterGate}): y=${r.armed.y}/${r.labels.y} e=${r.armed.e}/${r.labels.e} n=${r.armed.n}/${r.labels.n}`);
    out.push(`backchannel (no Jev call): ${r.backchannel}; dropped by asks ${r.dropped.total} (y=${r.dropped.y} e=${r.dropped.e} n=${r.dropped.n}): ${r.dropped.ids.join(',') || '-'}`);
    out.push(`missed y (${r.missed.length}): ${r.missed.join(',') || '-'}`);
    out.push(`wasted n (${r.wasted.length}): ${r.wasted.join(',') || '-'}`);
    out.push('routes on armed y/e (rows expected, cols got):');
    out.push(`  ${''.padEnd(10)}${ROUTES.map(x => x.padStart(10)).join('')}`);
    for (const e of ROUTES) out.push(`  ${e.padEnd(10)}${ROUTES.map(g => String(r.routes[e][g]).padStart(10)).join('')}`);
    out.push(`route errors (${r.routeErrors.length}): ${r.routeErrors.join(' ') || '-'}`);
    out.push(`sources: ${JSON.stringify(r.sources)}  follow-ups: ${r.followUps}`);
    out.push(`fallbacks (answer): ${JSON.stringify(r.fallbacks)}  (gate): ${JSON.stringify(r.gateFallbacks)}`);
    out.push(`jev call p50 ${r.jevMs.p50 ?? '-'} ms, p95 ${r.jevMs.p95 ?? '-'} ms`);
    if (args.list) out.push('', ...lines);
    process.stdout.write(`${out.join('\n')}\n`);
}

main().catch(err => {
    process.stderr.write(`[replay] ${err && err.message ? err.message : err}\n`);
    process.exit(1);
});

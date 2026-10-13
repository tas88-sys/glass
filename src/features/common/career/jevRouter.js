'use strict';

// Career intent router backed by Jev (spec 2026-10-13-career-router-jev).
// Jev decides the route of each interviewer turn; the regex router
// (intentRouter.js, frozen) decides only when Jev cannot: no key or
// CAREER_ROUTER=regex, a network error, 429/529, a timeout, an open circuit,
// or an answer below the confidence floor.
//
// Every decision has the same shape:
//   { route, cue, source: 'jev'|'regex', fallback: null|reason, confidence, jevMs }
// A regex decision keeps the regex cue unchanged ('follow-up' still carries
// the previous question's terms). A Jev decision's cue is 'jev:<route>@<conf>',
// or 'follow-up'.
//
// What goes to TypeSafe: the turn, the previous question and its route, the
// interviewer's company and the manifest's names (owner decision, R18). What
// goes to the log: kinds, statuses and counts only, never text or names (C2).

const { performance } = require('node:perf_hooks');

const { classifyCareerIntent, FOLLOW_UP_WINDOW_MS } = require('./intentRouter');
const client = require('./jevClient');

const DEFAULTS = {
    minConfidence: 0.5,       // below it the regex decides (CAREER_ROUTER_JEV_MIN_CONF)
    gateTimeoutMs: 700,       // the question gate's wait for a statement-form turn
    resolveBudgetMs: 250,     // the answer path's wait once the debounce fires
    requestTimeoutMs: 1500,   // the call itself; past both waits above, so a slow answer still lands in the cache
};
const FOLLOW_UP_MIN = 0.5;
const CACHE_SIZE = 64;
const BREAKER_FAILURES = 3;
const BREAKER_COOL_MS = 60 * 1000;
// Failures that count toward the circuit. auth and validation turn Jev off
// until the app restarts; aborted is ours.
const COUNTED = new Set(['timeout', 'rate', 'overload', 'http', 'net', 'bad-body']);

function bounded(raw, def, min, max) {
    if (raw === undefined || raw === null || String(raw).trim() === '') return def;
    const n = Number(raw);
    return Number.isFinite(n) && n >= min && n <= max ? n : def;
}

/**
 * The router's settings, from env. CAREER_ROUTER: 'jev' (default) or 'regex';
 * anything else is read as 'regex', so a typo never sends turns out.
 * @param {Record<string, string|undefined>} env
 */
function readConfig(env) {
    const e = env || {};
    const apiKey = typeof e.TYPESAFE_API_KEY === 'string' ? e.TYPESAFE_API_KEY.trim() : '';
    const raw = String(e.CAREER_ROUTER || '').trim().toLowerCase();
    const wanted = raw === '' || raw === 'jev' ? 'jev' : 'regex';
    const model = typeof e.CAREER_ROUTER_JEV_MODEL === 'string' && e.CAREER_ROUTER_JEV_MODEL.trim()
        ? e.CAREER_ROUTER_JEV_MODEL.trim()
        : client.DEFAULT_MODEL;
    return {
        apiKey,
        wanted,
        unknownMode: raw !== '' && raw !== 'jev' && raw !== 'regex',
        model,
        minConfidence: bounded(e.CAREER_ROUTER_JEV_MIN_CONF, DEFAULTS.minConfidence, 0, 1),
        gateTimeoutMs: bounded(e.CAREER_ROUTER_GATE_TIMEOUT_MS, DEFAULTS.gateTimeoutMs, 0, 10000),
        resolveBudgetMs: bounded(e.CAREER_ROUTER_RESOLVE_BUDGET_MS, DEFAULTS.resolveBudgetMs, 0, 10000),
    };
}

const ms = x => Math.round(x * 10) / 10;

/**
 * @param {{
 *   env?: Record<string, string|undefined>,
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 *   log?: (line: string) => void,
 *   endpoint?: string,
 *   requestTimeoutMs?: number,
 * }} [options]
 */
function createJevRouter(options = {}) {
    const env = options.env || process.env;
    const now = typeof options.now === 'function' ? options.now : Date.now;
    const log = typeof options.log === 'function' ? options.log : () => {};
    const requestTimeoutMs = Number.isFinite(options.requestTimeoutMs) ? options.requestTimeoutMs : DEFAULTS.requestTimeoutMs;

    const cache = new Map();          // request key → entry, oldest first
    let failures = 0;
    let openUntil = 0;
    let probing = false;
    let disabled = null;              // 'auth' | 'validation' once Jev refused us
    const noted = new Set();
    const counts = { calls: 0, ok: 0, failed: {}, fallbacks: {} };

    function once(key, line) {
        if (noted.has(key)) return;
        noted.add(key);
        log(line);
    }

    // env is read on each use: the app loads .env before the first turn, after this module exists.
    function config() {
        const cfg = readConfig(env);
        if (cfg.unknownMode) once('mode', '[career] router: unknown CAREER_ROUTER value; using the regex router');
        else if (cfg.wanted === 'jev' && !cfg.apiKey) once('key', '[career] router: no TYPESAFE_API_KEY; using the regex router');
        return cfg;
    }

    const active = cfg => cfg.wanted === 'jev' && !!cfg.apiKey && !disabled;
    const circuitOpen = () => openUntil > 0 && now() < openUntil;

    function eligiblePrev(ctx) {
        const p = ctx && ctx.prev;
        if (!p || (p.route !== 'personal' && p.route !== 'company') || !Number.isFinite(p.ts)) return null;
        const t = Number.isFinite(ctx.now) ? ctx.now : now();
        return t - p.ts <= FOLLOW_UP_WINDOW_MS ? p : null;
    }

    function requestContext(ctx) {
        const p = eligiblePrev(ctx);
        return {
            previousQuestion: p && typeof p.anchorText === 'string' ? p.anchorText : null,
            previousRoute: p ? p.route : null,
            interviewerCompany: ctx.activeCompany || null,
            entities: ctx.entities,
            companies: ctx.companies,
        };
    }

    function succeeded() {
        failures = 0;
        if (openUntil) log('[career] router: Jev back; circuit closed');
        openUntil = 0;
    }

    function failed(err) {
        const kind = (err && err.kind) || 'net';
        counts.failed[kind] = (counts.failed[kind] || 0) + 1;
        if (kind === 'auth' || kind === 'validation') {
            disabled = kind;
            const field = err && err.field ? ` field=${err.field}` : '';
            once(`off:${kind}`, `[career] router: Jev ${kind} error (${(err && err.status) || '-'}${field}); regex router until restart`);
            return kind;
        }
        if (!COUNTED.has(kind)) return kind;
        failures++;
        if (failures >= BREAKER_FAILURES) {
            openUntil = now() + BREAKER_COOL_MS;
            log(`[career] router: ${failures} Jev failures in a row (last: ${kind}); regex only for ${BREAKER_COOL_MS / 1000}s`);
        }
        return kind;
    }

    /** Starts (or reuses) the call for this turn; null when Jev is not to be called. */
    function start(text, ctx, cfg) {
        if (!active(cfg)) return null;
        if (circuitOpen()) return null;
        const body = client.buildRequest(text, requestContext(ctx), cfg.model);
        const key = JSON.stringify([cfg.model, body.state, !!body.questions.follow_up]);
        const hit = cache.get(key);
        if (hit) {
            cache.delete(key);
            cache.set(key, hit);
            return hit;
        }
        // After the cool-down one call probes; the others keep using the regex.
        const halfOpen = openUntil > 0;
        if (halfOpen && probing) return null;
        if (halfOpen) probing = true;

        counts.calls++;
        const t0 = performance.now();
        const entry = { settled: null, ms: null, promise: null };
        entry.promise = client.post({
            apiKey: cfg.apiKey,
            body,
            timeoutMs: requestTimeoutMs,
            fetchImpl: options.fetchImpl,
            endpoint: options.endpoint,
        })
            .then(json => {
                const answer = client.parseResponse(json);
                if (!answer) throw new client.JevError('bad-body');
                return answer;
            })
            .then(
                answer => {
                    counts.ok++;
                    succeeded();
                    entry.settled = { ok: true, answer };
                },
                err => {
                    entry.settled = { ok: false, kind: failed(err) };
                },
            )
            .then(() => {
                entry.ms = ms(performance.now() - t0);
                if (halfOpen) probing = false;
                return entry.settled;
            });
        cache.set(key, entry);
        while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
        return entry;
    }

    function wait(entry, budgetMs) {
        if (entry.settled) return Promise.resolve(entry.settled);
        if (!(budgetMs > 0)) return Promise.resolve(null);
        // No cap (the prefetch): the request timeout bounds it. setTimeout would read Infinity as 1 ms.
        if (budgetMs === Infinity) return entry.promise;
        let timer = null;
        const timeout = new Promise(resolve => {
            timer = setTimeout(() => resolve(null), budgetMs);
        });
        return Promise.race([entry.promise, timeout]).finally(() => clearTimeout(timer));
    }

    function regexDecision(text, ctx, fallback, extra = {}) {
        if (fallback) counts.fallbacks[fallback] = (counts.fallbacks[fallback] || 0) + 1;
        const d = classifyCareerIntent(text, ctx);
        return { route: d.route, cue: d.cue, source: 'regex', fallback, confidence: null, jevMs: null, ...extra };
    }

    /**
     * The route for one turn. Waits for Jev at most budgetMs (default: the
     * resolve budget), then decides by regex. Never rejects.
     * @param {string} text
     * @param {{ prev?: object|null, entities?: string[], companies?: string[], activeCompany?: string|null, now?: number }} ctx
     * @param {{ budgetMs?: number }} [opts]
     */
    async function decide(text, ctx = {}, opts = {}) {
        const c = ctx || {};
        try {
            const cfg = config();
            if (typeof text !== 'string' || !text.trim() || !active(cfg)) return regexDecision(text, c, null);
            const entry = start(text, c, cfg);
            if (!entry) return regexDecision(text, c, 'circuit');
            const budget = Number.isFinite(opts.budgetMs) || opts.budgetMs === Infinity ? opts.budgetMs : cfg.resolveBudgetMs;
            const settled = await wait(entry, budget);
            if (!settled) return regexDecision(text, c, 'budget');
            if (!settled.ok) return regexDecision(text, c, settled.kind, { jevMs: entry.ms });
            const a = settled.answer;
            const p = eligiblePrev(c);
            if (p && a.followUp !== null && a.followUp >= FOLLOW_UP_MIN && a.route !== 'company') {
                return { route: p.route, cue: 'follow-up', source: 'jev', fallback: null, confidence: a.followUp, jevMs: entry.ms };
            }
            if (a.confidence < cfg.minConfidence) {
                return regexDecision(text, c, 'low', { confidence: a.confidence, jevMs: entry.ms });
            }
            return {
                route: a.route,
                cue: `jev:${a.route}@${a.confidence.toFixed(2)}`,
                source: 'jev',
                fallback: null,
                confidence: a.confidence,
                jevMs: entry.ms,
            };
        } catch {
            return regexDecision(text, c, 'error');
        }
    }

    /** Starts the call for a turn now, so decide() later finds it ready. */
    function prefetch(text, ctx = {}) {
        try {
            const cfg = config();
            if (typeof text === 'string' && text.trim()) start(text, ctx || {}, cfg);
        } catch {
            /* total: decide() falls back by itself */
        }
    }

    /** Whether the question gate should wait for Jev on a statement-form turn. */
    function gateUsesJev() {
        try {
            return active(config()) && !circuitOpen();
        } catch {
            return false;
        }
    }

    function gateTimeoutMs() {
        return config().gateTimeoutMs;
    }

    function stats() {
        const cfg = readConfig(env);
        const state = cfg.wanted !== 'jev' ? 'off'
            : !cfg.apiKey ? 'no-key'
                : disabled ? `disabled:${disabled}`
                    : circuitOpen() ? 'open'
                        : 'on';
        return {
            state,
            model: cfg.model,
            calls: counts.calls,
            ok: counts.ok,
            failed: { ...counts.failed },
            fallbacks: { ...counts.fallbacks },
        };
    }

    return { decide, prefetch, gateUsesJev, gateTimeoutMs, stats };
}

module.exports = {
    createJevRouter,
    readConfig,
    DEFAULTS,
    FOLLOW_UP_MIN,
    CACHE_SIZE,
    BREAKER_FAILURES,
    BREAKER_COOL_MS,
};

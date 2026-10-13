'use strict';

// Career context: the only module used from outside common/career
// (summaryService, listenService, app start, the eval script).
//
// Every public function is total (plan Phase 0.6): errors are caught here and
// the caller gets "no context", so Live Answer behaves as today (FR-017, C1).
// Nothing heavy loads at require time: no Electron, no model runtime (C4).
// Debug lines go through careerDebug under LIVE_ANSWER_DEBUG and carry route,
// cue, chunk ids, scores and timings only, never note or turn text (C2).

const nodePath = require('node:path');
const { performance } = require('node:perf_hooks');

const { createKbService } = require('./kbService');
const { classifyCareerIntent, stripCuePhrases, hasCareerCue: routerHasCareerCue } = require('./intentRouter');
const { tokenize, normalizeForMatch, slugify } = require('./textNormalize');
const { fuseAndFilter, passesAmbiguousThreshold } = require('./retriever');
const { buildContextBlock, buildAddendum } = require('./contextBuilder');
const { findUnsupported } = require('./answerCheck');

const TOP_K = 6;                   // sections fused into the block, one per file (FR-010)
const CANDIDATES = 60;             // per ranking, before company scope and leave-source-out
const PREFETCH_TIMEOUT_MS = 150;   // C3
// FR-012 ambiguous gate with vectors: each model profile carries its own
// (embedder.js, research R5); this is the fallback for an embedder without one.
// Provisional until the eval set labels which ambiguous questions should inject.
const DEFAULT_MIN_COSINE = 0.35;
const MAX_QUERY_TERMS = 40;
const MAX_ANCHOR_CHARS = 600;      // the end of the previous question, joined to a follow-up's vector query

// FR-011 company-context phrases, as [before, after] around the company name,
// in normalizeForMatch space. Data: extend through the eval.
const COMPANY_CONTEXT = [
    ['here at', ''],
    ['at', 'we'],
    ['join', ''],
    ['joining', ''],
    ['welcome to', ''],
    ['heard of', ''],
    ['heard about', ''],
    ['aqui na', ''],
    ['aqui no', ''],
    ['na', 'a gente'],
    ['no', 'a gente'],
    ['entrar na', ''],
    ['entrar no', ''],
    ['conhece a', ''],
    ['conhece o', ''],
];

const ms = x => Math.round(x * 10) / 10;

// A follow-up ("and what was the outcome?") has few words of its own: its keyword
// query carries the previous question's terms, and its vector query carries the
// previous question's text (FR-006, E41). prev.anchorText is that question, kept
// across a chain of follow-ups; its end is kept, where the question usually is.
function vectorQueryText(turnText, decision, prev) {
    const anchor = decision.cue === 'follow-up' && prev && typeof prev.anchorText === 'string' ? prev.anchorText.trim() : '';
    return anchor ? `${anchor.slice(-MAX_ANCHOR_CHARS)}\n${turnText}` : turnText;
}

// The STT spells an unfamiliar name by its sound ("Orbit Pay" heard as
// "Orbit Pai"). After the exact pass, a name of FUZZY_MIN_LEN+ letters also
// matches the words right after a company-context phrase when they are one
// edit away (two from FUZZY_TWO_EDITS_LEN letters) and start with the same
// letter. Shorter names stay exact: one edit from "Bridge" is "Bridget".
const FUZZY_MIN_LEN = 7;
const FUZZY_TWO_EDITS_LEN = 11;

/** Levenshtein distance, or max + 1 once it is known to exceed max. */
function editDistance(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        let rowMin = i;
        for (let j = 1; j <= b.length; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            if (cur[j] < rowMin) rowMin = cur[j];
        }
        if (rowMin > max) return max + 1;
        prev = cur;
    }
    return prev[b.length];
}

function compileCompanyDetector(names) {
    const entries = [];
    for (const name of names || []) {
        const words = normalizeForMatch(name).split(' ').filter(Boolean);
        if (!words.length) continue;
        const pat = words.join(' ?');                  // "orbitpay" matches "Orbit Pay"
        const res = COMPANY_CONTEXT.map(([before, after]) => new RegExp(`\\b${before} ${pat}${after ? ` ${after}` : ''}\\b`));
        const slug = words.join('');
        entries.push({ name, len: slug.length, slug, words: words.length, res });
    }
    entries.sort((a, b) => b.len - a.len);             // longest first (E31)
    const fuzzy = entries.filter(e => e.len >= FUZZY_MIN_LEN);
    const contexts = COMPANY_CONTEXT.map(([before, after]) => [before.split(' '), after ? after.split(' ') : []]);

    function fuzzyMatch(tokens) {
        let best = null;
        for (const [before, after] of contexts) {
            for (let i = 0; i + before.length < tokens.length; i++) {
                if (!before.every((w, k) => tokens[i + k] === w)) continue;
                const start = i + before.length;
                for (const e of fuzzy) {
                    const max = e.len >= FUZZY_TWO_EDITS_LEN ? 2 : 1;
                    // The name's words, or one more or fewer (the STT splits and joins words).
                    for (let n = Math.max(1, e.words - 1); n <= e.words + 1 && start + n <= tokens.length; n++) {
                        if (!after.every((w, k) => tokens[start + n + k] === w)) continue;
                        const span = tokens.slice(start, start + n).join('');
                        if (span[0] !== e.slug[0]) continue;
                        const d = editDistance(span, e.slug, max);
                        if (d <= max && (!best || d < best.d)) best = { name: e.name, d };
                    }
                }
            }
        }
        return best ? best.name : null;
    }

    return text => {
        const s = normalizeForMatch(text);
        if (!s) return null;
        for (const e of entries) if (e.res.some(re => re.test(s))) return e.name;
        return fuzzy.length ? fuzzyMatch(s.split(' ')) : null;
    };
}

/**
 * @param {{
 *   env?: Record<string, string|undefined>,
 *   log?: (line: string) => void,
 *   debug?: boolean,
 *   embedder?: object|null|'auto',
 *   minCosine?: number,
 *   prefetchTimeoutMs?: number,
 * }} [options]
 */
function createCareerModule(options = {}) {
    const env = options.env || process.env;
    const sink = options.log || (line => console.log(line));
    const minCosineFor = emb =>
        Number.isFinite(options.minCosine) ? options.minCosine
            : emb && Number.isFinite(emb.minCosine) ? emb.minCosine
                : DEFAULT_MIN_COSINE;
    const prefetchTimeoutMs = Number.isFinite(options.prefetchTimeoutMs) ? options.prefetchTimeoutMs : PREFETCH_TIMEOUT_MS;

    const debugOn = () =>
        options.debug !== undefined ? !!options.debug : env.LIVE_ANSWER_DEBUG === '1' || env.LIVE_ANSWER_DEBUG === 'true';
    function careerDebug(line) {
        if (debugOn()) sink(line);
    }

    let state = 'disabled';
    let kb = null;
    let snap = null;
    let detector = { key: null, detect: () => null };
    let warming = null;
    let disabledReason = null;
    let embedder = null;
    let embedderResolved = false;

    // The real embedder is created on first use and only when asked for
    // ('auto'): tests and the plain-Node load path never touch the model runtime.
    function getEmbedder() {
        if (!embedderResolved) {
            embedderResolved = true;
            const vectorsOff = /^(?:0|off|false|no)$/i.test(String(env.CAREER_KB_VECTORS || '').trim());
            if (options.embedder === 'auto' && vectorsOff) {
                careerDebug('[career] vectors off (CAREER_KB_VECTORS); BM25 only');
                embedder = null;
            } else if (options.embedder === 'auto') {
                try {
                    const { createEmbedder } = require('./embedder');
                    embedder = createEmbedder({ env, log: careerDebug });
                } catch (err) {
                    careerDebug(`[career] vectors unavailable (${(err && err.code) || (err && err.name) || 'error'})`);
                    embedder = null;
                }
            } else {
                embedder = options.embedder || null;
            }
        }
        return embedder;
    }

    const isReady = () => (state === 'ready-bm25' || state === 'ready-hybrid') && !!snap;

    function disable(reason) {
        snap = null;
        kb = null;
        state = 'disabled';
        if (disabledReason !== reason) {
            disabledReason = reason;
            careerDebug(`[career] disabled: ${reason}`);
        }
    }

    function vectorState() {
        const emb = getEmbedder();
        if (!emb || !snap) return { ready: false, vectors: 0 };
        try {
            return { ready: !!emb.isReadyFor(snap.chunks), vectors: emb.vectorCount() };
        } catch {
            return { ready: false, vectors: 0 };
        }
    }

    async function doWarm() {
        const raw = typeof env.CAREER_KB_PATH === 'string' ? env.CAREER_KB_PATH.trim() : '';
        if (!raw) return disable('CAREER_KB_PATH not set');
        const root = nodePath.resolve(raw);
        if (!kb || kb.root !== root) {
            kb = createKbService({ root, log: careerDebug });
            snap = null;
        }
        if (state === 'disabled') state = 'warming';
        const t0 = performance.now();
        const next = await kb.refresh();
        if (!next) return disable('KB folder missing or unreadable');
        snap = next;
        disabledReason = null;
        const key = snap.companyNames.join('\n');
        if (detector.key !== key) detector = { key, detect: compileCompanyDetector(snap.companyNames) };
        state = vectorState().ready ? 'ready-hybrid' : 'ready-bm25';
        careerDebug(`[career] ${state} files=${snap.files} chunks=${snap.chunks.length} card=${snap.core ? 'yes' : 'no'} refresh=${ms(performance.now() - t0)}ms`);
        // First-use costs off the answer path: every cue regex and the name
        // patterns compile on their first run (~20 ms once).
        classifyCareerIntent('warm up', { entities: snap.entities, companies: snap.companyNames });
        stripCuePhrases('warm up');

        // FR-016: the embedding pass runs in the background, never on the answer path.
        const emb = getEmbedder();
        if (emb) {
            const forSnap = snap;
            Promise.resolve()
                .then(() => emb.sync(forSnap.chunks))
                .then(() => {
                    if (snap === forSnap && isReady() && vectorState().ready) {
                        state = 'ready-hybrid';
                        emb.indexFor(forSnap.chunks);       // build the search rows now, not on the first answer
                        careerDebug(`[career] ready-hybrid vectors=${emb.vectorCount()}`);
                    }
                })
                .catch(err => careerDebug(`[career] embedding pass failed (${(err && err.name) || 'error'}); BM25 only`));
        }
    }

    function warm() {
        if (!warming) {
            warming = doWarm()
                .catch(err => careerDebug(`[career] warm failed (${(err && err.name) || 'error'})`))
                .finally(() => {
                    warming = null;
                });
        }
        return warming;
    }

    /**
     * Start the query embedding for a gated turn (FR-009). With the session, a
     * follow-up prefetches the same text its vector query will use.
     * @param {string} turnText
     * @param {{ prev?: object|null }} [session]
     */
    function prefetch(turnText, session) {
        try {
            if (!isReady() || typeof turnText !== 'string' || !turnText.trim()) return;
            const emb = getEmbedder();
            if (!emb) return;
            const prev = (session && session.prev) || null;
            const decision = prev
                ? classifyCareerIntent(turnText, { prev, entities: snap.entities, companies: snap.companyNames, now: Date.now() })
                : null;
            emb.prefetch(decision ? vectorQueryText(turnText, decision, prev) : turnText);
        } catch {
            /* total: a failed prefetch only means BM25 for that answer */
        }
    }

    function configuredCompany(s) {
        const raw = typeof env.CAREER_KB_COMPANY === 'string' ? env.CAREER_KB_COMPANY.trim() : '';
        if (!raw) return null;
        const slug = slugify(raw);
        return s.companyNames.find(n => slugify(n) === slug) || raw;
    }

    function logDecision(result, hits, vectorNote, extra) {
        if (!debugOn()) return;
        const t = result.timings;
        if (result.route === 'general') {
            careerDebug(`[career] route=general total=${t.totalMs}ms`);
            return;
        }
        const top = hits[0];
        const parts = [
            `[career] route=${result.route}`,
            `cue=${result.cue || '-'}`,
            `chunks=${result.chunkIds.length ? result.chunkIds.join(',') : '-'}`,
            `scores=${hits.length ? hits.map(h => h.score.toFixed(4)).join(',') : '-'}`,
            `top=${top ? `cos:${top.cosine == null ? '-' : top.cosine.toFixed(3)}/cov:${top.coverage == null ? '-' : top.coverage.toFixed(2)}` : '-'}`,
            `bm25=${t.bm25Ms}ms`,
            `vector=${vectorNote}`,
            `total=${t.totalMs}ms`,
        ];
        if (extra) parts.push(extra);
        careerDebug(parts.join(' '));
    }

    async function resolve(s, turnText, session, opts) {
        const t0 = performance.now();
        const prev = session.prev || null;
        const activeCompany = configuredCompany(s) || session.activeCompany || null;
        const decision = classifyCareerIntent(turnText, {
            prev,
            entities: s.entities,
            companies: s.companyNames,
            now: Date.now(),
        });
        const timings = { routeMs: ms(performance.now() - t0), bm25Ms: 0, vectorMs: 0, vectorUsed: false, totalMs: 0 };
        const result = {
            route: decision.route,
            cue: decision.cue,
            block: '',
            addendum: '',
            sources: [],
            chunkIds: [],
            queryTerms: [],
            anchorText: '',
            timings,
        };
        const done = (hits, vectorNote, extra) => {
            timings.totalMs = ms(performance.now() - t0);
            logDecision(result, hits, vectorNote, extra);
            return result;
        };
        if (decision.route === 'general') return done([], 'off');

        // FR-008 query: the turn minus framing, the extracted question boosted,
        // the previous question's terms carried on a follow-up. On the company
        // route the active company's name joins the query (FR-011): "why do you
        // want to join us" has no content words of its own.
        const own = tokenize(stripCuePhrases(turnText));
        const question = typeof session.question === 'string' ? session.question.trim() : '';
        const boost = question && question !== turnText.trim() ? tokenize(stripCuePhrases(question)) : [];
        const carried = decision.cue === 'follow-up' && prev && Array.isArray(prev.queryTerms)
            ? prev.queryTerms.filter(x => typeof x === 'string')
            : [];
        const companyTerms = decision.route === 'company' && activeCompany ? tokenize(activeCompany) : [];
        const terms = own.concat(boost, carried, companyTerms);
        result.queryTerms = [...new Set(terms)].slice(0, MAX_QUERY_TERMS);
        const vectorText = vectorQueryText(turnText, decision, prev);
        result.anchorText = vectorText === turnText ? turnText : prev.anchorText;

        const excluded = new Set(Array.isArray(opts.excludePaths) ? opts.excludePaths : []);
        const keep = h => excluded.size === 0 || !excluded.has(s.chunks[h.idx] && s.chunks[h.idx].path);

        const tb = performance.now();
        const lexical = s.bm25.search(terms, CANDIDATES).filter(keep);
        timings.bm25Ms = ms(performance.now() - tb);

        let semantic = null;
        let titled = null;
        let vectorNote = 'off';
        const emb = opts.bm25Only ? null : getEmbedder();
        if (emb) {
            const vindex = emb.indexFor(s.chunks);
            if (!vindex) {
                vectorNote = 'unavailable';
            } else {
                const tv = performance.now();
                const query = await emb.query(vectorText, prefetchTimeoutMs);
                timings.vectorMs = ms(performance.now() - tv);
                if (query) {
                    semantic = vindex.search(query, CANDIDATES).filter(keep);
                    if (vindex.searchTitles) titled = vindex.searchTitles(query, CANDIDATES).filter(keep);
                    timings.vectorUsed = true;
                    vectorNote = `used(${timings.vectorMs}ms wait)`;
                } else {
                    vectorNote = 'timeout';
                }
            }
        }

        const hits = fuseAndFilter({
            chunks: s.chunks,
            bm25: lexical,
            vector: semantic,
            title: titled,
            route: decision.route,
            activeCompany,
            k: TOP_K,
        });
        if (opts.trace && typeof opts.trace === 'object') {
            // trace.k lists more of the ranking than the block uses (scripts/ask-career-kb.js).
            const listed = Number.isInteger(opts.trace.k) && opts.trace.k > TOP_K
                ? fuseAndFilter({
                    chunks: s.chunks,
                    bm25: lexical,
                    vector: semantic,
                    title: titled,
                    route: decision.route,
                    activeCompany,
                    k: opts.trace.k,
                })
                : hits;
            opts.trace.hits = listed.map(h => ({
                id: h.chunk.id,
                path: h.chunk.path,
                title: h.chunk.title,
                score: h.score,
                bm25Rank: h.bm25Rank,
                vectorRank: h.vectorRank,
                titleRank: h.titleRank,
                cosine: h.cosine,
            }));
            opts.trace.activeCompany = activeCompany;
        }

        // FR-012: any section about to be sent may clear the gate. The first one can reach the
        // top on its keyword and title ranks alone, and then it has no cosine (E43).
        const gate = { vectorUsed: timings.vectorUsed, minCosine: minCosineFor(emb) };
        if (decision.route === 'ambiguous' && !hits.some(h => passesAmbiguousThreshold(h, gate))) {
            return done(hits, vectorNote, 'inject=no(below-threshold)');
        }

        const built = buildContextBlock({ core: s.core, hits });
        if (built.cardOverCap) careerDebug('[career] warning: canonical card exceeds the block cap; injected without notes');
        if (!built.block) return done(hits, vectorNote, 'inject=no(empty)');

        result.block = built.block;
        result.addendum = buildAddendum(activeCompany);
        result.sources = built.sources;
        result.chunkIds = built.chunkIds;
        return done(hits, vectorNote);
    }

    /**
     * @param {string} turnText
     * @param {{ prev?: { route: string, ts: number, queryTerms?: string[], anchorText?: string }|null, activeCompany?: string|null, question?: string }} [session]
     * @param {{ excludePaths?: string[], bm25Only?: boolean, trace?: { k?: number } }} [opts]  eval and ask scripts only
     */
    async function getCareerContext(turnText, session, opts) {
        if (!isReady() || typeof turnText !== 'string' || !turnText.trim()) return null;
        try {
            return await resolve(snap, turnText, session || {}, opts || {});
        } catch (err) {
            careerDebug(`[career] context failed (${(err && err.name) || 'error'})`);
            return null;
        }
    }

    function hasCareerCue(turnText) {
        try {
            return isReady() && routerHasCareerCue(turnText, snap.entities, snap.companyNames);
        } catch {
            return false;
        }
    }

    function detectCompany(turnText) {
        try {
            return isReady() && typeof turnText === 'string' ? detector.detect(turnText) : null;
        } catch {
            return null;
        }
    }

    /**
     * FR-021: the numbers and known names in a finished answer that appear
     * nowhere in what the model was given. Never throws; [] when the answer had
     * no career block.
     * @param {string} answer
     * @param {{ block?: string, addendum?: string }|null} context  from getCareerContext
     * @param {string} [conversation]  the question and transcript the model saw
     */
    function checkAnswer(answer, context, conversation) {
        try {
            if (!snap || !context || !context.block) return [];
            const given = [context.block, context.addendum, conversation].filter(x => typeof x === 'string').join('\n');
            const found = findUnsupported(answer, given, snap.entities.concat(snap.companyNames));
            careerDebug(`[career] check unverified=${found.length}`);
            return found;
        } catch (err) {
            careerDebug(`[career] check failed (${(err && err.name) || 'error'})`);
            return [];
        }
    }

    /**
     * Names the speech-to-text should favor (sttKeyterms.js): the company names
     * first (the interviewer's company is the one the STT most often misspells),
     * then the manifest's entities. [] until the notes are loaded; never throws.
     * @returns {string[]}
     */
    function keyterms() {
        try {
            return isReady() ? [...snap.companyNames, ...snap.entities].filter(n => typeof n === 'string') : [];
        } catch {
            return [];
        }
    }

    function status() {
        const v = snap ? vectorState() : { ready: false, vectors: 0 };
        // Hybrid only while vectors can actually be used (a crashed worker drops back, E21).
        const live = isReady() ? (v.ready ? 'ready-hybrid' : 'ready-bm25') : state;
        return { state: live, chunks: snap ? snap.chunks.length : 0, vectors: v.vectors };
    }

    return { warm, prefetch, getCareerContext, hasCareerCue, detectCompany, checkAnswer, keyterms, status };
}

const career = createCareerModule({ embedder: 'auto' });

module.exports = career;
module.exports.createCareerModule = createCareerModule;

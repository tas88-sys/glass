#!/usr/bin/env node
'use strict';

// Live eval of Live Answer and Ask: a simulated interview with real audio,
// real STT, real LLMs and the app's own services (docs/LIVE_INSIGHTS_AND_ASK.md §4.9).
//
//   npm run eval:live -- [options]
//
// Run it through npm (launch.js starts it with the Node inside Electron, which
// loads better-sqlite3 to read the app's settings read-only).
//
// Phases (--only A,B,...; default A,B,C,D,E,G; --stress adds F):
//   A  interview: invented questions in pt-BR and en-US, said by TTS into the
//      STT sessions; the question gate, the speaker gate, answers, follow-ups
//   B  career routes: questions sampled from CAREER_KB_PATH/glass-eval/questions.jsonl
//      per route (personal, company, ambiguous, general); route, notes injected
//   C  Ask with a screenshot (default mode): facts only the image has
//   D  Ask code mode with a hard problem in the screenshot; the code is run
//      against hidden tests; then once more in the saved code language
//   E  Ask system design mode with a hard prompt in the screenshot
//   F  stress: a burst of questions (abort and replace), a long session (the
//      30-turn prompt cap, the Insights lane), and Answer turned off
//   G  each model: every model of the list alone (the other phases only reach
//      the first one that answers), plus --endpoint-models: one Live Answer
//      turn, one Ask in text, the screenshot Ask when the catalog says the
//      model sees images, and --kb-per-model career questions per route with
//      the notes (router, BM25 and the in-memory vectors), as in phase B. A provider out of reach (rate limit, quota, 503) is a
//      warn, not a fail
//
// Options:
//   --text               skip TTS and STT: the transcript goes in directly (faster, cheaper)
//   --fast               with --text, do not wait the time each turn takes to say
//   --only A,C           phases to run
//   --stress             add phase F
//   --repeat N           run phase A N times and aggregate latency (default 1)
//   --kb-sample N        questions per route in phase B (default 3)
//   --kb-per-model N     career questions per route that each model answers in phase G,
//                        with the notes and vectors (default 1; 0 for none)
//   --seed N             sampling seed (default 7)
//   --judge              score answers with an LLM judge (Gemini; --judge-model to pick)
//   --rejudge <dir>      only score the answers of a finished run again (its report folder)
//   --llm-models <csv>   model list instead of the app's (--llm-provider for its first provider)
//   --endpoint-models <csv>  more models for phase G, all on the OpenAI-compatible
//                        endpoint (also LIVE_EVAL_ENDPOINT_MODELS), e.g. each member
//                        of an OmniRoute combo, to test the providers behind it one by one
//   --stt-provider <p>   STT provider instead of the app's (deepgram or gemini)
//   --code-language <l>  language of the second code run (default: the app's setting)
//   --kb <dir>           career notes (default CAREER_KB_PATH)
//   --bm25-only          career retrieval without vectors
//   --block-providers <csv>  never call these services, to save their quota (also
//                        LIVE_EVAL_BLOCK_PROVIDERS): groq, gemini, deepgram, anthropic,
//                        openai, typesafe. Requests to their hosts fail before leaving
//                        the machine and are counted. Their models leave the LLM list;
//                        a blocked STT or Gemini TTS means --text; a blocked Gemini
//                        means no --judge. With no model left, a local stub answers:
//                        the gate, the career router (Jev), retrieval and the answer
//                        lane still run, checks on the answer's words become info,
//                        and the Ask phases (C, D, E) are skipped
//   --out <dir>          report folder (default %LOCALAPPDATA%\glass-live-eval\<time>)
//   --verbose            echo the app's own log lines (always in app.log)
//
// Exit code 1 when any check marked fail did not pass. The console shows ids,
// routes and numbers for the career questions, never their text; report.md
// (outside the repo) has every question, transcript and answer.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

const harness = require('./harness');
harness.installLlmTap();   // before anything loads summaryService

const { loadConfig, describe } = require('./config');
const { createTts } = require('./tts');
const { renderScreenshot } = require('./images');
const { runAsk } = require('./ask');
const { createJudge } = require('./judge');
const checks = require('./checks');
const codeProblem = require('./fixtures/code-problem');
const { buildGo } = require('./goBuild');
const { consoleLine, writeReports, statusOf } = require('./report');
const offline = require('./offline');

const FIX = path.join(__dirname, 'fixtures');
const PHASE_NAMES = {
    A: 'A · Interview (generic questions)',
    B: 'B · Career routes (your notes)',
    C: 'C · Ask with a screenshot',
    D: 'D · Ask code with a screenshot',
    E: 'E · Ask system design with a screenshot',
    F: 'F · Stress',
    G: 'G · Each model alone',
};
const FIRST_TOKEN_BUDGET_MS = 6000;   // from the final transcript to the first token (warn)
const MAX_ANSWER_WORDS = 120;        // a Live Answer the candidate can still read while speaking (warn, item 11)
const WER_LIMIT = 0.25;               // warn

function parseArgs(argv) {
    const a = { text: false, only: null, stress: false, repeat: 1, kbSample: 3, kbPerModel: 1, seed: 7, judge: false, judgeModel: undefined, verbose: false };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        const v = () => argv[++i];
        if (k === '--text') a.text = true;
        else if (k === '--fast') a.fast = true;
        else if (k === '--only') a.only = v().toUpperCase().split(',').map(s => s.trim()).filter(Boolean);
        else if (k === '--stress') a.stress = true;
        else if (k === '--repeat') a.repeat = Math.max(1, Number(v()) || 1);
        else if (k === '--kb-sample') a.kbSample = Math.max(0, Number(v()) || 0);
        else if (k === '--kb-per-model') a.kbPerModel = Math.max(0, Number(v()) || 0);
        else if (k === '--seed') a.seed = Number(v()) || 7;
        else if (k === '--judge') a.judge = true;
        else if (k === '--judge-model') a.judgeModel = v();
        else if (k === '--rejudge') a.rejudge = v();
        else if (k === '--llm-models') a.llmModels = v();
        else if (k === '--llm-provider') a.llmProvider = v();
        else if (k === '--endpoint-models') a.endpointModels = v();
        else if (k === '--stt-provider') a.sttProvider = v();
        else if (k === '--code-language') a.codeLanguage = v();
        else if (k === '--kb') a.kb = v();
        else if (k === '--bm25-only') a.bm25Only = true;
        else if (k === '--out') a.out = v();
        else if (k === '--tts-cache') a.ttsCache = v();
        else if (k === '--no-app-data') a.noAppData = true;
        else if (k === '--block-providers') a.blockProviders = v();
        else if (k === '--verbose') a.verbose = true;
        else if (k === '--help' || k === '-h') a.help = true;
        else throw new Error(`unknown argument: ${k}`);
    }
    a.blocked = offline.parseBlocked(a.blockProviders != null ? a.blockProviders : process.env.LIVE_EVAL_BLOCK_PROVIDERS);
    const endpointModels = a.endpointModels != null ? a.endpointModels : process.env.LIVE_EVAL_ENDPOINT_MODELS;
    a.endpointModels = String(endpointModels || '').split(',').map(s => s.trim()).filter(Boolean);
    const phases = a.only || ['A', 'B', 'C', 'D', 'E', 'G'];
    if (a.stress && !phases.includes('F')) phases.push('F');
    a.phases = phases;
    return a;
}

function localDir(...p) {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), '.cache');
    return path.join(base, 'glass-live-eval', ...p);
}

// ---------------------------------------------------------------------------
// Output: our lines to stdout and run.log; the app's console to app.log
// ---------------------------------------------------------------------------

function setupOutput(outDir, verbose) {
    fs.mkdirSync(outDir, { recursive: true });
    const runLog = fs.createWriteStream(path.join(outDir, 'run.log'));
    const appLog = fs.createWriteStream(path.join(outDir, 'app.log'));
    const fmt = args => args.map(x => (typeof x === 'string' ? x : x instanceof Error ? x.stack : JSON.stringify(x))).join(' ');
    for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
        console[level] = (...args) => {
            const line = `${new Date().toISOString()} ${fmt(args)}\n`;
            appLog.write(line);
            if (verbose) process.stderr.write(`  · ${fmt(args)}\n`);
        };
    }
    const out = line => {
        process.stdout.write(`${line}\n`);
        runLog.write(`${line}\n`);
    };
    return { out, close: () => Promise.all([new Promise(r => runLog.end(r)), new Promise(r => appLog.end(r))]) };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 2 ** 32;
    };
}

function shuffle(xs, rand) {
    const a = xs.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

const check = (name, ok, level = 'fail', detail = '') => ({ name, ok: !!ok, level, detail: detail || '' });
// A check on what the answer says: with the stub LLM (--block-providers) it is info only.
const answerCheck = (ctx, name, ok, level = 'fail', detail = '') => (ctx.stubLlm
    ? check(name, ok, 'info', `not judged: stub LLM${detail ? ` (${detail})` : ''}`)
    : check(name, ok, level, detail));
const langTag = lang => (/^pt/i.test(lang) ? 'pt' : 'en');

/** Read the career eval set and sample n per route, alternating languages. */
function sampleKb(kbPath, n, seed) {
    const file = path.join(kbPath, 'glass-eval', 'questions.jsonl');
    const items = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l));
    const rand = rng(seed);
    const picked = [];
    for (const route of ['personal', 'company', 'ambiguous', 'general']) {
        const pool = shuffle(items.filter(q => q.route === route), rand);
        const byLang = { pt: pool.filter(q => langTag(q.lang || '') === 'pt'), en: pool.filter(q => langTag(q.lang || '') === 'en') };
        let turn = rand() < 0.5 ? 'pt' : 'en';
        for (let i = 0; i < n; i++) {
            const q = byLang[turn].shift() || byLang[turn === 'pt' ? 'en' : 'pt'].shift();
            if (!q) break;
            picked.push(q);
            turn = turn === 'pt' ? 'en' : 'pt';
        }
    }
    return picked;
}

function firstShown(ex) {
    return ex.answers.find(a => a.text) || null;
}

function liveMetrics(ex, a, extra = {}) {
    const ref = ex.sttFinalAt || ex.turn.audioEndAt;
    return {
        status: a ? a.status : 'none',
        answers: ex.answers.length,
        startMs: a && a.startedAt ? a.startedAt - ref : null,
        firstTokenMs: a && a.firstTokenAt ? a.firstTokenAt - ref : null,
        totalMs: a && a.endAt ? a.endAt - ref : null,
        audioToFinalMs: ex.turn.audioSeconds && ex.sttFinalAt ? ex.sttFinalAt - ex.turn.audioEndAt : null,
        audioSeconds: ex.turn.audioSeconds ? Math.round(ex.turn.audioSeconds * 10) / 10 : null,
        model: a?.call?.finalModel || null,
        resets: a?.call?.resets?.length || 0,
        promptTurns: a?.call?.promptTurns ?? null,
        chars: a ? a.text.length : 0,
        ...extra,
    };
}

/** Words read aloud and a closing paragraph (future-work item 11); add(name, ok, level, detail). */
function lengthChecks(item, text, add) {
    const words = checks.answerWords(text);
    item.metrics.words = words;
    add(`at most ${MAX_ANSWER_WORDS} words`, words <= MAX_ANSWER_WORDS, 'warn', `${words} words`);
    add('no closing paragraph', !checks.endsWithClosingParagraph(text), 'warn', 'bullets, then a paragraph');
}

function sttChecks(item, ex, said, audio) {
    if (!audio) return;
    const ref = Array.isArray(said) ? said.join(' ') : said;
    if (!ex.transcript) {
        item.checks.push(check('STT heard the turn', false, 'fail', 'no final transcript within 15 s'));
        return;
    }
    const w = checks.wer(ref, ex.transcript);
    item.metrics.wer = w;
    item.checks.push(check(`STT word error ≤ ${WER_LIMIT}`, w <= WER_LIMIT, 'warn', `wer=${w}`));
}

// ---------------------------------------------------------------------------
// Phase A
// ---------------------------------------------------------------------------

function evalLiveTurn(t, ex, { phase, audio, privateItem = false, ctx = {} }) {
    const expect = t.expect || { answer: 'any' };
    const shown = ex.answers.filter(a => a.text);
    const errors = ex.answers.filter(a => a.status === 'error');
    const a = shown[shown.length - 1] || ex.answers[ex.answers.length - 1] || null;
    const item = {
        phase,
        id: t.id,
        private: privateItem,
        kind: 'live',
        lang: t.lang,
        question: privateItem ? undefined : t.text,
        transcript: privateItem ? undefined : ex.transcript,
        extracted: a?.question || '',
        answer: a?.text || '',
        checks: [],
        metrics: liveMetrics(ex, a),
    };
    if (expect.answer === 'yes') {
        item.checks.push(check('answer shown', shown.length >= 1, 'fail', shown.length ? '' : `statuses: ${ex.answers.map(x => x.status).join(',') || 'gate did not fire'}`));
        item.checks.push(check('one answer for the turn', shown.length <= 1, 'warn', `${shown.length} answers`));
        if (expect.mentionsAny && a?.text) {
            const m = checks.mentions(a.text, expect.mentionsAny);
            item.checks.push(answerCheck(ctx, 'names a key term', m.found.length > 0, 'fail', m.found.length ? `found ${m.found.join(', ')}` : `none of ${expect.mentionsAny.join(', ')}`));
        }
        if (a?.text) {
            const shape = checks.answerShape(a.text);
            item.metrics.headlineWords = shape.headlineWords;
            item.metrics.bullets = shape.bullets;
            item.checks.push(answerCheck(ctx, 'short headline first (≤ 20 words)', shape.headlineWords <= 20, 'warn', `${shape.headlineWords} words`));
            lengthChecks(item, a.text, (...r) => item.checks.push(answerCheck(ctx, ...r)));
            if (expect.lang) {
                const got = checks.detectLang(a.text);
                item.checks.push(answerCheck(ctx, `answer in ${expect.lang}`, got === expect.lang || got === 'unknown', 'warn', `detected ${got}`));
            }
        }
        if (item.metrics.firstTokenMs != null) {
            item.checks.push(check(`first token ≤ ${FIRST_TOKEN_BUDGET_MS / 1000}s after the turn`, item.metrics.firstTokenMs <= FIRST_TOKEN_BUDGET_MS, 'warn', `${item.metrics.firstTokenMs} ms`));
        }
        if (item.metrics.resets) item.checks.push(check('answered without fallback', false, 'warn', `${item.metrics.resets} fallback(s), answered by ${item.metrics.model}`));
    } else if (expect.answer === 'no') {
        // Past the gate, only the model can stay quiet (PASSIVE); the stub never does.
        const nothingShown = ex.answers.length ? answerCheck : (c, ...rest) => check(...rest);
        item.checks.push(nothingShown(ctx, 'nothing shown', shown.length === 0, 'fail', shown.length ? `${shown.length} answer(s) shown` : ''));
        item.checks.push(check('gate kept the LLM out', ex.answers.length === 0, 'warn', ex.answers.length ? `LLM called, model said ${ex.answers.map(x => x.status).join(',')}` : ''));
    }
    item.checks.push(check('no error', errors.length === 0, 'fail', errors.map(e => e.error).join('; ')));
    sttChecks(item, ex, t.text, audio);
    return item;
}

async function phaseA(ctx, session, phaseDef) {
    const items = [];
    for (const t of phaseDef.turns) {
        const ex = await session.exchange({ speaker: t.speaker, text: t.text, lang: phaseDef.lang, pauseMs: t.pauseMs });
        const item = evalLiveTurn({ ...t, lang: phaseDef.lang }, ex, { phase: 'A', audio: ctx.audio, ctx });
        item.history = session.history().slice(-8).join('\n');
        items.push(item);
        ctx.emit(item);
    }
    return items;
}

// ---------------------------------------------------------------------------
// Phase B
// ---------------------------------------------------------------------------

async function phaseB(ctx, session, questions, lang) {
    const items = [];
    const mod = ctx.career?.mod;
    for (const q of questions) {
        // A company question needs the interviewer's company, named the way an interviewer would.
        if (q.route === 'company' && q.company) {
            session.summary.activeCompany = null;
            const intro = lang === 'pt-BR' ? `Aqui na ${q.company} a gente valoriza muito autonomia.` : `Here at ${q.company} we care a lot about ownership.`;
            const ix = await session.exchange({ speaker: 'them', text: intro, lang });
            const detected = session.summary.activeCompany;
            const it = { phase: 'B', id: `${q.id}:intro`, private: true, kind: 'live', checks: [], metrics: { status: ix.answers.map(a => a.status).join(',') || 'none' }, question: intro, transcript: ix.transcript, answer: firstShown(ix)?.text || '' };
            it.checks.push(check('company detected from the turn', !!detected && detected.toLowerCase() === q.company.toLowerCase(), 'fail', detected ? '' : 'not detected'));
            it.checks.push(check('statement not answered', !firstShown(ix), 'warn', 'the intro got an answer'));
            sttChecks(it, ix, intro, ctx.audio);
            items.push(it);
            ctx.emit(it);
        }

        const ex = await session.exchange({ speaker: 'them', text: q.text, lang });
        const shown = ex.answers.filter(a => a.text);
        const a = shown[shown.length - 1] || ex.answers[ex.answers.length - 1] || null;
        const decision = a?.career || null;
        let scriptRoute = null;
        try {
            scriptRoute = (await mod.getCareerContext(q.text, { prev: null, activeCompany: q.company || null }))?.route || null;
        } catch {
            /* reported as null */
        }
        const item = {
            phase: 'B',
            id: q.id,
            private: true,
            kind: 'live-career',
            lang,
            question: q.text,
            transcript: ex.transcript,
            extracted: a?.question || '',
            answer: a?.text || '',
            checks: [],
            metrics: liveMetrics(ex, a, {
                expectedRoute: q.route,
                route: decision?.route || null,
                routeFromScript: scriptRoute,
                cue: decision?.cue || null,
                injected: decision ? decision.hasBlock : null,
                chunks: decision?.chunks ?? null,
                sources: a?.sources?.length || 0,
                unverified: a?.unverified?.length || 0,
                careerMs: decision?.totalMs ?? null,
                vectorUsed: decision?.vectorUsed ?? null,
                routeSource: decision?.routeSource ?? null,
                routeFallback: decision?.routeFallback ?? null,
                jevMs: decision?.jevMs ?? null,
                routeWaitMs: decision?.routeWaitMs ?? null,
            }),
            notes: ex.career.find(d => d._block)?._block || '',
        };
        item.checks.push(check('answer shown', shown.length >= 1, 'fail', shown.length ? '' : `statuses: ${ex.answers.map(x => x.status).join(',') || 'gate did not fire'}`));
        // A label the router misses on the script text itself is a router gap, which
        // scripts/eval-career-kb.js measures: here it warns. The live path fails only
        // when the audio and STT turn a route the router gets right into another one.
        const routerGap = !!scriptRoute && scriptRoute !== q.route;
        const routeLevel = routerGap ? 'warn' : 'fail';
        const routeNote = routerGap ? `; the script text routes ${scriptRoute} too (router gap, see eval-career-kb)` : scriptRoute && scriptRoute !== decision?.route ? `, script text routes ${scriptRoute}` : '';
        item.checks.push(check(`routed ${q.route}`, decision?.route === q.route, routeLevel, `got ${decision?.route || 'none'}${routeNote}`));
        if (q.route === 'personal' || q.route === 'company') {
            item.checks.push(check('notes injected', decision?.hasBlock === true, routeLevel, decision ? `${decision.chunks} sections` : ''));
            item.checks.push(check('sources on the panel', item.metrics.sources > 0, 'warn'));
        }
        if (q.route === 'general') item.checks.push(check('no notes injected', decision ? !decision.hasBlock : true, 'fail'));
        // Router R-SC-005: the Jev call starts at the gate, so the answer should
        // barely wait for it once the debounce fires.
        if (decision && decision.jevMs != null) {
            item.checks.push(check('route ready at the debounce', decision.routeWaitMs <= 50, 'warn', `waited ${decision.routeWaitMs} ms, src=${decision.routeFallback ? `regex(${decision.routeFallback})` : decision.routeSource}`));
        }
        item.checks.push(check('no unverified names or numbers', item.metrics.unverified === 0, 'warn', `${item.metrics.unverified} marked`));
        if (a?.text) {
            const got = checks.detectLang(a.text);
            item.checks.push(answerCheck(ctx, `answer in ${langTag(lang)}`, got === langTag(lang) || got === 'unknown', 'warn', `detected ${got}`));
            lengthChecks(item, a.text, (...r) => item.checks.push(answerCheck(ctx, ...r)));
        }
        if (item.metrics.firstTokenMs != null) item.checks.push(check(`first token ≤ ${FIRST_TOKEN_BUDGET_MS / 1000}s after the turn`, item.metrics.firstTokenMs <= FIRST_TOKEN_BUDGET_MS, 'warn', `${item.metrics.firstTokenMs} ms`));
        item.checks.push(check('no error', !ex.answers.some(x => x.status === 'error'), 'fail', ex.answers.filter(x => x.status === 'error').map(x => x.error).join('; ')));
        sttChecks(item, ex, q.text, ctx.audio);
        item.history = session.history().slice(-8).join('\n');
        items.push(item);
        ctx.emit(item);
        // The candidate answers before the next question, as in an interview, so the
        // transcript is not a stack of unanswered questions (live eval q038, q084).
        await session.say({ speaker: 'me', text: checks.candidateReply(a?.text, lang), lang });
    }
    return items;
}

// ---------------------------------------------------------------------------
// Phases C, D, E (Ask)
// ---------------------------------------------------------------------------

function modelSeesImages(ctx, model) {
    if (!model) return null;
    const provider = ctx.models.catalog.providerOf(model) || ctx.models.factory.inferProviderFromModelId(model);
    return provider ? ctx.models.catalog.seesImages(provider, model) : null;
}

function askItem(phase, id, kind, r, prompt) {
    const call = r.calls[r.calls.length - 1] || {};
    return {
        phase,
        id,
        kind,
        question: prompt,
        answer: r.text,
        checks: [],
        metrics: {
            mode: r.mode,
            model: r.responseModel || call.finalModel || null,
            firstTokenMs: r.firstTokenAt ? r.firstTokenAt - r.startedAt : null,
            totalMs: r.endAt - r.startedAt,
            resets: (call.resets || []).length,
            fallbackModels: (call.resets || []).map(x => x.next).filter(Boolean),
            imageSent: !!call.hasImage,
            textOnlyRetry: r.textOnlyRetry,
            chars: r.text.length,
        },
    };
}

function imageChecks(ctx, item, r) {
    item.checks.push(check('no error', !r.error, 'fail', r.error || ''));
    item.checks.push(check('screenshot sent with the request', item.metrics.imageSent && !r.textOnlyRetry, 'fail', r.textOnlyRetry ? `text-only retry after: ${r.firstError}` : ''));
    const sees = modelSeesImages(ctx, item.metrics.model);
    item.checks.push(check('answered by a model that sees images', sees === true, 'fail', `${item.metrics.model || 'no model'}: ${sees}`));
    if (item.metrics.resets) item.checks.push(check('answered without fallback', false, 'warn', `${item.metrics.resets} fallback(s): ${item.metrics.fallbackModels.join(' → ')}`));
}

async function phaseC(ctx, history) {
    const image = await renderScreenshot(path.join(FIX, 'ask-image.svg'), path.join(ctx.outDir, 'ask-image.jpg'));
    const prompt = 'Qual pedido falhou nessa tela, quanto tempo ele levou e qual foi o código de erro?';
    const r = await runAsk({ tag: 'C', mode: 'default', userPrompt: prompt, history, image, llmInfo: ctx.models.llmInfo });
    const item = askItem('C', 'ask-image', 'ask-image', r, prompt);
    imageChecks(ctx, item, r);
    for (const [name, term] of [['order id from the image', '58213'], ['latency from the image', '/4[.,\\s]?870/'], ['error code from the image', '/issuer[_ ]timeout/']]) {
        const m = checks.mentions(r.text, [term]);
        item.checks.push(check(name, m.found.length > 0, 'fail'));
    }
    item.imageBase64 = image.base64;
    ctx.emit(item);
    return [item];
}

async function phaseD(ctx, history) {
    const image = await renderScreenshot(path.join(FIX, 'code-problem.svg'), path.join(ctx.outDir, 'code-problem.jpg'));
    const prompt = 'Resolva esse problema.';
    const items = [];
    const runs = [{ id: 'code-javascript', language: 'javascript', execute: true }];
    const saved = (ctx.args.codeLanguage ?? ctx.cfg.settings.preferredCodeLanguage ?? '').trim();
    if (saved && !/^(?:js|javascript)$/i.test(saved)) runs.push({ id: `code-${saved.toLowerCase()}`, language: saved, execute: false });
    for (const run of runs) {
        const r = await runAsk({ tag: `D:${run.id}`, mode: 'code', userPrompt: prompt, history, preferredCodeLanguage: run.language, image, llmInfo: ctx.models.llmInfo });
        const item = askItem('D', run.id, 'code', r, `${prompt} (language: ${run.language})`);
        imageChecks(ctx, item, r);
        const sec = checks.sectionsInOrder(r.text, checks.CODE_SECTIONS);
        item.checks.push(check('five sections in order', sec.ok, 'fail', [sec.missing.length ? `missing ${sec.missing.join(', ')}` : '', sec.outOfOrder.length ? `out of order ${sec.outOfOrder.join(', ')}` : ''].filter(Boolean).join('; ')));
        const blocks = checks.codeBlocks(r.text);
        const want = run.execute ? ['js', 'javascript'] : [run.language.toLowerCase(), run.language.toLowerCase() === 'go' ? 'golang' : run.language.toLowerCase()];
        const block = blocks.find(b => want.includes(b.lang)) || null;
        item.checks.push(check(`a ${run.language} code block`, !!block, 'fail', `blocks: ${blocks.map(b => b.lang || '?').join(',') || 'none'}`));
        const complexity = checks.mentions(r.text, ['/o\\(\\s*m\\s*[·*x×]?\\s*n\\s*[·*x×]?\\s*log/', '/o\\(\\s*(?:mn|nm|m\\s*\\*\\s*n)\\s*log/', '/o\\(\\s*n\\s*log\\s*n\\s*\\)/']);
        item.checks.push(check('states O(m·n·log(m·n)) time', complexity.found.length > 0, 'warn'));
        if (run.execute && block) {
            const tests = codeProblem.tests();
            const res = checks.runJsSolution(block.code, codeProblem.FN_NAME, tests, { timeoutMs: 4000 });
            item.metrics.tests = `${res.passed}/${res.total}`;
            item.metrics.testsMs = res.ms;
            // A function under another name (LeetCode's, say) still fails, but its tests tell a wrong
            // name from a wrong algorithm.
            let renamed = '';
            const other = /no function named/.test(res.error || '') && (block.code.match(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/) || [])[1];
            if (other) {
                const alt = checks.runJsSolution(block.code, other, tests, { timeoutMs: 4000 });
                item.metrics.testsUnderOwnName = `${alt.passed}/${alt.total}`;
                renamed = `named ${other}, not ${codeProblem.FN_NAME} as on the screen; under its own name it passes ${alt.passed}/${alt.total}`;
            }
            item.checks.push(check('code passes the hidden tests', res.loaded && res.passed === res.total, 'fail', renamed || res.error || res.failures.slice(0, 3).map(f => `${f.name}: ${f.error || `want ${f.expected}, got ${JSON.stringify(f.got)}`}`).join('; ')));
            item.testResult = res;
        }
        if (/^(?:go|golang)$/i.test(run.language) && block) {
            const built = buildGo(block.code);
            item.metrics.goBuild = built.available ? (built.ok ? 'ok' : 'failed') : 'no go';
            item.checks.push(built.available
                ? check('the Go code compiles', built.ok, 'fail', built.error)
                : check('the Go code compiles', false, 'info', 'not built: Go is not installed'));
        }
        item.imageBase64 = image.base64;
        items.push(item);
        ctx.emit(item);
    }
    return items;
}

async function phaseE(ctx, history) {
    const image = await renderScreenshot(path.join(FIX, 'system-design.svg'), path.join(ctx.outDir, 'system-design.jpg'));
    const prompt = 'Design this.';
    const r = await runAsk({ tag: 'E', mode: 'system_design', userPrompt: prompt, history, image, llmInfo: ctx.models.llmInfo });
    const item = askItem('E', 'system-design', 'system-design', r, prompt);
    imageChecks(ctx, item, r);
    const sec = checks.systemDesignSections(r.text);
    item.checks.push(check('sections 0 to 11 in order', sec.ok, 'fail', [sec.missing.length ? `missing ${sec.missing.join(', ')}` : '', sec.ordered ? '' : 'out of order'].filter(Boolean).join('; ')));
    const numbers = checks.concreteNumbers(r.text);
    item.metrics.concreteNumbers = numbers;
    item.checks.push(check('at least 8 concrete numbers with units', numbers >= 8, 'fail', `${numbers}`));
    const reqs = [
        ['429 / Retry-After', ['/retry-after/', '429']],
        ['per-region failure', ['/region(?:al)? (?:failure|outage|loss)/', '/(?:lose|losing|lost) (?:a |one )?region/', '/fail[- ]?open/']],
        ['p99 under 5 ms', ['/5\\s?ms/']],
        ['global quota ±5%', ['/±\\s?5\\s?%/', '/5\\s?%/']],
        ['quota changes in 10 s', ['/10\\s?s(?:ec|econds)?\\b/']],
        ['an algorithm', ['token bucket', 'sliding window', 'gcra', 'leaky bucket']],
        ['scale from the image', ['/2\\s?m(?:illion)?\\b/', '/2,000,000/', '/50\\s?m(?:illion)?\\b/']],
    ];
    const hit = reqs.filter(([, terms]) => checks.mentions(r.text, terms).found.length);
    item.metrics.requirementsCovered = `${hit.length}/${reqs.length}`;
    item.checks.push(check('covers the requirements in the image (≥ 5 of 7)', hit.length >= 5, 'fail', `missing: ${reqs.filter(x => !hit.includes(x)).map(x => x[0]).join(', ') || 'none'}`));
    item.imageBase64 = image.base64;
    ctx.emit(item);
    return [item];
}

// ---------------------------------------------------------------------------
// Phase F (stress)
// ---------------------------------------------------------------------------

async function phaseF(ctx, fixtures) {
    const items = [];
    const { burst, filler } = fixtures;

    // F1: a burst of questions; each new one replaces the answer in flight. Text
    // mode: the turns must land closer together than speech and the STT debounce allow.
    {
        const s = harness.createSession({ cfg: ctx.cfg, career: ctx.career, tts: null, audio: false, log: ctx.out, liveFeatures: 'answer', textPace: false });
        const gap = burst.gapMs;
        const t0 = Date.now();
        for (const q of burst.questions) {
            await s.say({ speaker: 'them', text: q, lang: burst.lang });
            await new Promise(r => setTimeout(r, gap));
        }
        await new Promise(r => setTimeout(r, 1500));
        await s.waitIdle({ timeoutMs: 90_000 });
        const answers = [...s.answers.values()].sort((a, b) => a.id - b.id);
        const last = answers[answers.length - 1];
        // Interleaving: once answer k+1 has shown text, answer k must not update.
        const firstText = new Map();
        for (const e of s.events) if (e.channel === 'live-answer-update' && e.data?.answer && !firstText.has(e.data.id)) firstText.set(e.data.id, e.at);
        let interleaved = 0;
        for (const e of s.events) {
            if (e.channel !== 'live-answer-update' || !e.data?.answer) continue;
            for (const [id, at] of firstText) if (id > e.data.id && at < e.at) interleaved++;
        }
        const item = {
            phase: 'F',
            id: 'burst',
            kind: 'live',
            question: burst.questions,
            answer: last?.text || '',
            checks: [],
            metrics: { questions: burst.questions.length, answers: answers.length, statuses: answers.map(a => a.status).join(','), lastModel: last?.call?.finalModel || null, totalMs: Date.now() - t0, interleaved },
        };
        item.checks.push(check('last question answered', last && last.status === 'answer' && !!last.text, 'fail', last ? last.status : 'no answer'));
        if (last?.text) {
            const m = checks.mentions(last.text, burst.lastMentionsAny);
            item.checks.push(answerCheck(ctx, 'the answer is to the last question', m.found.length > 0, 'fail', m.found.length ? '' : 'quicksort complexity not named'));
        }
        item.checks.push(check('no error in the burst', !answers.some(a => a.status === 'error'), 'fail', answers.filter(a => a.status === 'error').map(a => a.error).join('; ')));
        item.checks.push(check('no update from a replaced answer', interleaved === 0, 'fail', `${interleaved} late updates`));
        await s.stop();
        items.push(item);
        ctx.emit(item);
    }

    // F2: a long session in text mode with both lanes: the 30-turn prompt cap and Insights every 5 turns.
    {
        const s = harness.createSession({ cfg: ctx.cfg, career: ctx.career, tts: null, audio: false, log: ctx.out, liveFeatures: 'both', textPace: false });
        const insightsBefore = harness.calls.filter(c => c.lane === 'insights').length;
        let n = 0;
        for (let i = 0; i < 32; i++) {
            const speaker = i % 2 ? 'me' : 'them';
            const text = filler[speaker][Math.floor(i / 2) % filler[speaker].length];
            await s.say({ speaker, text: `${text} (${++n})`, lang: 'en-US' });
            await new Promise(r => setTimeout(r, 150));
        }
        const ex = await s.exchange({ speaker: 'them', text: 'So, how would you migrate those batch jobs to streaming?', lang: 'en-US' });
        await new Promise(r => setTimeout(r, 3000));   // let the last Insights calls end
        const a = firstShown(ex);
        const insightsCalls = harness.calls.filter(c => c.lane === 'insights').length - insightsBefore;
        const summaries = s.events.filter(e => e.channel === 'summary-update').length;
        const item = {
            phase: 'F',
            id: 'long-session',
            kind: 'live',
            question: 'So, how would you migrate those batch jobs to streaming?',
            answer: a?.text || '',
            checks: [],
            metrics: { turns: s.history().length, promptTurns: a?.call?.promptTurns ?? null, insightsCalls, summaryUpdates: summaries, model: a?.call?.finalModel || null },
        };
        item.checks.push(check('answer after 32 turns', !!a, 'fail'));
        item.checks.push(check('prompt carries the last 30 turns', item.metrics.promptTurns === 30, 'fail', `${item.metrics.promptTurns}`));
        item.checks.push(check('Insights ran every 5 turns', insightsCalls === Math.floor(33 / 5), 'fail', `${insightsCalls} calls for 33 turns`));
        item.checks.push(check('Insights reached the panel', summaries >= Math.floor(33 / 5) - 1, 'warn', `${summaries} updates`));
        await s.stop();
        items.push(item);
        ctx.emit(item);
    }

    // F3: Answer off (Insights only): a question makes no answer-lane call.
    {
        const s = harness.createSession({ cfg: ctx.cfg, career: ctx.career, tts: null, audio: false, log: ctx.out, liveFeatures: 'insights', textPace: false });
        const before = harness.calls.filter(c => c.lane === 'answer').length;
        await s.exchange({ speaker: 'them', text: 'What is eventual consistency?', lang: 'en-US' });
        const after = harness.calls.filter(c => c.lane === 'answer').length;
        const item = { phase: 'F', id: 'answer-off', kind: 'live', checks: [], metrics: { answerCalls: after - before } };
        item.checks.push(check('no Live Answer call with Answer off', after === before, 'fail', `${after - before} calls`));
        await s.stop();
        items.push(item);
        ctx.emit(item);
    }
    return items;
}

// ---------------------------------------------------------------------------
// Phase G (each model alone)
// ---------------------------------------------------------------------------

const MODEL_LIVE_TURN = { id: 'live', speaker: 'them', lang: 'en-US', text: 'How would you make a payment endpoint safe to retry?', mentionsAny: ['idempot', '/dedup/', 'key', 'token'] };
const MODEL_ASK_PROMPT = { text: 'Explique em duas frases o que é backpressure em sistemas de streaming.', mentionsAny: ['backpressure', '/press[aã]o/', 'consumidor', 'produtor', 'buffer'] };
// The provider said no for now (rate limit, quota, overload; OmniRoute's own cooldown after
// them): the model is out of reach, the app is not broken.
const OUT_OF_REACH = /\b(?:429|503)\b|rate.?limit|quota|too many requests|resource.?exhausted|per (?:minute|day)|high demand|overloaded|unavailable|cooling down/i;

/** Each model of the list as its own one-model list, then the endpoint's extra models. */
function modelTargets(ctx) {
    const { provider, model } = ctx.cfg.llm;
    const targets = ctx.models.factory.splitByProvider(model, provider).flatMap(seg => seg.models.map(m => ({ provider: seg.provider, model: m })));
    for (const m of ctx.args.endpointModels) {
        if (!targets.some(t => t.provider === 'openai-compatible' && t.model === m)) targets.push({ provider: 'openai-compatible', model: m, extra: true });
    }
    return targets;
}

/** How long a per-minute rate limit asks to wait ("try again in 7.5s", "1m2s"), capped at 65 s; null when it is not one. */
function rateLimitWaitMs(error) {
    if (!error || !/per minute|\bTPM\b|\bRPM\b|rate.?limit|\b429\b/i.test(error) || /per day|\bTPD\b|\bRPD\b/i.test(error)) return null;
    const m = error.match(/try again in\s+(?:(\d+)m)?\s*([\d.]+)\s*s/i);
    const ms = m ? (Number(m[1] || 0) * 60 + Number(m[2])) * 1000 + 500 : 20_000;
    return Math.min(65_000, Math.max(1_000, Math.round(ms)));
}

/** An error check: a provider out of reach is a warn, anything else a fail. */
function errorCheck(name, error) {
    const away = !!error && OUT_OF_REACH.test(error);
    return check(name, !error, away ? 'warn' : 'fail', error ? `${away ? 'out of reach: ' : ''}${error}` : '');
}

async function phaseG(ctx) {
    const items = [];
    const saved = ctx.cfg.llm;
    const image = await renderScreenshot(path.join(FIX, 'ask-image.svg'), path.join(ctx.outDir, 'ask-image.jpg'));
    // The same career questions for every model, so their answers compare.
    const kbQuestions = ctx.career && ctx.cfg.kbPath && ctx.args.kbPerModel > 0 ? sampleKb(ctx.cfg.kbPath, ctx.args.kbPerModel, ctx.args.seed + 1) : [];
    if (ctx.args.kbPerModel > 0 && !kbQuestions.length) ctx.out('G: no career questions (CAREER_KB_PATH not set or the module did not load)');
    for (const target of modelTargets(ctx)) {
        const key = ctx.cfg.keys[target.provider];
        const label = `${target.provider}:${target.model}`;
        if (!key) {
            const item = { phase: 'G', id: label, kind: 'model', checks: [check('a key for the provider', false, 'fail', `no ${target.provider} key`)], metrics: { provider: target.provider } };
            items.push(item);
            ctx.emit(item);
            continue;
        }
        // The app's own path with this model as the whole list: llmInfo reads cfg.llm on each call.
        ctx.cfg.llm = { provider: target.provider, model: target.model };
        const pinned = () => ({ provider: target.provider, model: target.model, apiKey: key, keys: { [target.provider]: key } });
        try {
            const s = harness.createSession({ cfg: ctx.cfg, career: null, tts: null, audio: false, log: ctx.out, liveFeatures: 'answer', textPace: false });
            const ex = await s.exchange({ speaker: 'them', text: MODEL_LIVE_TURN.text, lang: MODEL_LIVE_TURN.lang });
            await s.stop();
            const shown = ex.answers.filter(a => a.text);
            const a = shown[shown.length - 1] || ex.answers[ex.answers.length - 1] || null;
            const error = ex.answers.filter(x => x.status === 'error').map(x => x.error).join('; ') || (a?.call?.error ?? '');
            const live = {
                phase: 'G',
                id: `${label} · live`,
                kind: 'live',
                question: MODEL_LIVE_TURN.text,
                answer: a?.text || '',
                checks: [],
                metrics: { ...liveMetrics(ex, a), provider: target.provider, listModel: target.model, extra: !!target.extra },
            };
            live.checks.push(errorCheck('no error', error));
            if (!error) live.checks.push(check('answer shown', shown.length >= 1, 'fail', shown.length ? '' : `statuses: ${ex.answers.map(x => x.status).join(',') || 'gate did not fire'}`));
            if (a?.text) {
                const m = checks.mentions(a.text, MODEL_LIVE_TURN.mentionsAny);
                live.checks.push(check('names a key term', m.found.length > 0, 'fail', m.found.length ? `found ${m.found.join(', ')}` : `none of ${MODEL_LIVE_TURN.mentionsAny.join(', ')}`));
                const shape = checks.answerShape(a.text);
                live.checks.push(check('short headline first (≤ 20 words)', shape.headlineWords <= 20, 'warn', `${shape.headlineWords} words`));
                lengthChecks(live, a.text, (...r) => live.checks.push(check(...r)));
                const got = checks.detectLang(a.text);
                live.checks.push(check('answer in en', got === 'en' || got === 'unknown', 'warn', `detected ${got}`));
            }
            if (live.metrics.firstTokenMs != null) live.checks.push(check(`first token ≤ ${FIRST_TOKEN_BUDGET_MS / 1000}s after the turn`, live.metrics.firstTokenMs <= FIRST_TOKEN_BUDGET_MS, 'warn', `${live.metrics.firstTokenMs} ms`));
            items.push(live);
            ctx.emit(live);

            const r = await runAsk({ tag: `G:${label}`, mode: 'default', userPrompt: MODEL_ASK_PROMPT.text, history: [], image: null, llmInfo: pinned });
            const ask = askItem('G', `${label} · ask`, 'ask', r, MODEL_ASK_PROMPT.text);
            Object.assign(ask.metrics, { provider: target.provider, listModel: target.model, extra: !!target.extra });
            ask.checks.push(errorCheck('no error', r.error));
            if (!r.error) ask.checks.push(check('answer not empty', r.text.trim().length > 0, 'fail'));
            if (r.text) {
                const m = checks.mentions(r.text, MODEL_ASK_PROMPT.mentionsAny);
                ask.checks.push(check('names a key term', m.found.length > 0, 'fail', m.found.length ? `found ${m.found.join(', ')}` : `none of ${MODEL_ASK_PROMPT.mentionsAny.join(', ')}`));
                const got = checks.detectLang(r.text);
                ask.checks.push(check('answer in pt', got === 'pt' || got === 'unknown', 'warn', `detected ${got}`));
            }
            items.push(ask);
            ctx.emit(ask);

            for (const q of kbQuestions) {
                const it = await modelCareerItem(ctx, q, label, target);
                items.push(it);
                ctx.emit(it);
            }

            if (ctx.models.catalog.seesImages(target.provider, target.model) === true) {
                const prompt = 'Qual pedido falhou nessa tela, quanto tempo ele levou e qual foi o código de erro?';
                const ri = await runAsk({ tag: `G:${label}:image`, mode: 'default', userPrompt: prompt, history: [], image, llmInfo: pinned });
                const it = askItem('G', `${label} · image`, 'ask-image', ri, prompt);
                Object.assign(it.metrics, { provider: target.provider, listModel: target.model, extra: !!target.extra });
                it.checks.push(errorCheck('no error', ri.error));
                if (!ri.error) {
                    it.checks.push(check('screenshot sent with the request', it.metrics.imageSent && !ri.textOnlyRetry, 'fail', ri.textOnlyRetry ? `text-only retry after: ${ri.firstError}` : ''));
                    for (const [name, term] of [['order id from the image', '58213'], ['latency from the image', '/4[.,\\s]?870/'], ['error code from the image', '/issuer[_ ]timeout/']]) {
                        it.checks.push(check(name, checks.mentions(ri.text, [term]).found.length > 0, 'fail'));
                    }
                }
                it.imageBase64 = image.base64;
                items.push(it);
                ctx.emit(it);
            }
        } finally {
            ctx.cfg.llm = saved;
        }
    }
    return items;
}

/**
 * One career question to the model that cfg.llm pins, in a fresh session with
 * the career module (Jev, BM25, vectors): the route, the notes injected and the
 * answer, kept private as in phase B. A company question gets its company set
 * directly, as the "here at <company>" turn of phase B would.
 */
async function modelCareerItem(ctx, q, label, target) {
    const lang = langTag(q.lang || '') === 'pt' ? 'pt-BR' : 'en-US';
    let ex;
    let error = '';
    let waitedMs = 0;
    // A prompt with notes is ~5k tokens: a free key's tokens-per-minute limit
    // stops the next question. Wait what the provider asks (up to a minute), twice.
    for (let attempt = 0; attempt < 3; attempt++) {
        const s = harness.createSession({ cfg: ctx.cfg, career: ctx.career, tts: null, audio: false, log: ctx.out, liveFeatures: 'answer', textPace: false });
        if (q.route === 'company' && q.company) s.summary.activeCompany = q.company;
        ex = await s.exchange({ speaker: 'them', text: q.text, lang });
        await s.stop();
        error = ex.answers.filter(x => x.status === 'error').map(x => x.error).join('; ');
        const wait = rateLimitWaitMs(error);
        if (wait == null || attempt === 2) break;
        ctx.out(`  ${label} · kb:${q.id}: rate limited, waiting ${Math.round(wait / 1000)} s`);
        waitedMs += wait;
        await new Promise(r => setTimeout(r, wait));
    }
    const shown = ex.answers.filter(a => a.text);
    const a = shown[shown.length - 1] || ex.answers[ex.answers.length - 1] || null;
    const decision = a?.career || null;
    const item = {
        phase: 'G',
        id: `${label} · kb:${q.id}`,
        private: true,
        kind: 'live-career',
        lang,
        question: q.text,
        answer: a?.text || '',
        checks: [],
        metrics: liveMetrics(ex, a, {
            provider: target.provider,
            listModel: target.model,
            extra: !!target.extra,
            kbId: q.id,
            expectedRoute: q.route,
            route: decision?.route || null,
            injected: decision ? decision.hasBlock : null,
            chunks: decision?.chunks ?? null,
            sources: a?.sources?.length || 0,
            unverified: a?.unverified?.length || 0,
            vectorUsed: decision?.vectorUsed ?? null,
            routeSource: decision?.routeSource ?? null,
            rateLimitWaitMs: waitedMs,
        }),
        notes: ex.career.find(d => d._block)?._block || '',
    };
    item.checks.push(errorCheck('no error', error));
    if (!error) item.checks.push(check('answer shown', shown.length >= 1, 'fail', shown.length ? '' : `statuses: ${ex.answers.map(x => x.status).join(',') || 'gate did not fire'}`));
    // The route is the router's (Jev), the same for every model: info here, phase B judges it.
    item.checks.push(check(`routed ${q.route}`, decision?.route === q.route, 'info', `got ${decision?.route || 'none'}`));
    if (decision?.hasBlock) item.checks.push(check('no unverified names or numbers', item.metrics.unverified === 0, 'warn', `${item.metrics.unverified} marked`));
    if (a?.text) {
        const got = checks.detectLang(a.text);
        item.checks.push(check(`answer in ${langTag(lang)}`, got === langTag(lang) || got === 'unknown', 'warn', `detected ${got}`));
    }
    return item;
}

/** Per model of phase G: what each lane got (ok, warn, fail) and its first token. */
function modelSummary(items) {
    const rows = {};
    for (const i of items.filter(x => x.phase === 'G' && x.metrics?.listModel)) {
        const key = `${i.metrics.provider}:${i.metrics.listModel}`;
        const lane = i.id.slice(i.id.lastIndexOf('·') + 2);
        rows[key] = rows[key] || {};
        rows[key][lane] = `${statusOf(i)}${i.metrics.firstTokenMs != null ? ` ${i.metrics.firstTokenMs}ms` : ''}`;
    }
    return rows;
}

/**
 * The OpenAI-compatible endpoint answers its models list. A local OmniRoute
 * takes a minute or two to answer after it starts; without this wait its models
 * fail the run as if the provider were down.
 */
async function waitForEndpoint(credential, out, timeoutMs = 150_000) {
    const [baseUrl, apiKey] = String(credential).split('\n');
    const url = `${baseUrl.replace(/\/+$/, '')}/models`;
    const started = Date.now();
    let last = '';
    while (Date.now() - started < timeoutMs) {
        try {
            const res = await fetch(url, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, signal: AbortSignal.timeout(10_000) });
            if (res.ok) {
                out(`[endpoint] OpenAI-compatible models list answered in ${Math.round((Date.now() - started) / 1000)} s`);
                return true;
            }
            last = `HTTP ${res.status}`;
            if (res.status === 401 || res.status === 403) break;
        } catch (err) {
            last = err.name === 'TimeoutError' ? 'timeout' : err.cause?.code || err.message;
        }
        await new Promise(r => setTimeout(r, 5000));
    }
    out(`[endpoint] OpenAI-compatible endpoint not answering (${last}); its models will fail`);
    return false;
}

// ---------------------------------------------------------------------------
// Judge and aggregates
// ---------------------------------------------------------------------------

async function judgeItems(ctx, items) {
    const judge = createJudge({ apiKey: ctx.cfg.keys.gemini, model: ctx.args.judgeModel, log: ctx.out });
    if (!judge) {
        ctx.out('[judge] no Gemini key; skipped');
        return;
    }
    ctx.out(`[judge] scoring with ${judge.model}`);
    for (const it of items) {
        if (!it.answer || !['live', 'live-career', 'ask', 'ask-image', 'code', 'system-design'].includes(it.kind) || it.phase === 'F') continue;
        it.judge = await judge.score({
            kind: it.kind,
            question: Array.isArray(it.question) ? it.question.join(' ') : it.question || it.extracted || '',
            answer: it.answer,
            transcript: it.history,
            notes: it.kind === 'live-career' ? it.notes : undefined,
            extra: it.testResult ? `hidden tests passed ${it.testResult.passed}/${it.testResult.total}${it.testResult.error ? ` (${it.testResult.error})` : ''}` : undefined,
            imageBase64: it.imageBase64,
        });
        ctx.out(`  judge ${it.phase} ${it.id}: ${it.judge.error ? `error ${it.judge.error}` : `${it.judge.score}/5`}`);
    }
}

function aggregate(items) {
    const live = items.filter(i => (i.phase === 'A' || i.phase === 'B') && i.metrics && i.metrics.status === 'answer');
    const q = (xs, p) => checks.quantile(xs, p);
    const pick = k => live.map(i => i.metrics[k]).filter(Number.isFinite);
    const models = {};
    for (const i of items) if (i.metrics?.model) models[i.metrics.model] = (models[i.metrics.model] || 0) + 1;
    const wers = items.map(i => i.metrics?.wer).filter(Number.isFinite);
    const b = items.filter(i => i.phase === 'B' && i.kind === 'live-career');
    const routeOk = b.filter(i => i.metrics.route === i.metrics.expectedRoute).length;
    const bPick = k => b.map(i => i.metrics[k]).filter(Number.isFinite);
    const routeSources = {};
    for (const i of b) {
        const src = i.metrics.routeFallback ? `regex(${i.metrics.routeFallback})` : i.metrics.routeSource;
        if (src) routeSources[src] = (routeSources[src] || 0) + 1;
    }
    return {
        liveAnswers: live.length,
        firstTokenMs: { p50: q(pick('firstTokenMs'), 0.5), p95: q(pick('firstTokenMs'), 0.95) },
        totalMs: { p50: q(pick('totalMs'), 0.5), p95: q(pick('totalMs'), 0.95) },
        audioToFinalMs: { p50: q(pick('audioToFinalMs'), 0.5), p95: q(pick('audioToFinalMs'), 0.95) },
        werMean: wers.length ? Math.round((wers.reduce((s, x) => s + x, 0) / wers.length) * 1000) / 1000 : null,
        words: { p50: q(pick('words'), 0.5), max: q(pick('words'), 1), over: pick('words').filter(w => w > MAX_ANSWER_WORDS).length },
        fallbacks: items.reduce((s, i) => s + (i.metrics?.resets || 0), 0),
        answeredBy: models,
        careerRoutes: b.length ? `${routeOk}/${b.length}` : null,
        routeSources,
        routeWaitMs: { p50: q(bPick('routeWaitMs'), 0.5), p95: q(bPick('routeWaitMs'), 0.95) },
        jevMs: { p50: q(bPick('jevMs'), 0.5), p95: q(bPick('jevMs'), 0.95) },
        judgeMean: (() => {
            const s = items.map(i => i.judge?.score).filter(Number.isFinite);
            return s.length ? Math.round((s.reduce((a, x) => a + x, 0) / s.length) * 100) / 100 : null;
        })(),
    };
}

/** --rejudge <dir>: score a finished run's answers again and rewrite its reports. */
async function rejudge(args) {
    const dir = path.resolve(args.rejudge);
    const run = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'));
    const cfg = loadConfig(args);
    const images = { C: 'ask-image.jpg', D: 'code-problem.jpg', E: 'system-design.jpg' };
    for (const it of run.items) {
        // Phase G sends the screenshot only on its image items.
        const name = it.phase === 'G' ? (it.kind === 'ask-image' ? 'ask-image.jpg' : null) : images[it.phase];
        const file = name && path.join(dir, name);
        if (file && fs.existsSync(file)) it.imageBase64 = fs.readFileSync(file).toString('base64');
        delete it.judge;
    }
    const out = line => process.stdout.write(`${line}\n`);
    await judgeItems({ cfg, args: { ...args, judge: true }, out }, run.items);
    run.items = run.items.map(({ imageBase64, ...rest }) => rest);
    run.aggregates = aggregate(run.items);
    const counts = writeReports(dir, run);
    out(`Judge mean: ${run.aggregates.judgeMean} · ${counts.PASS} pass · ${counts.WARN} warn · ${counts.FAIL} fail`);
    out(`Report: ${path.join(dir, 'report.md')}`);
    return 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        const lines = fs.readFileSync(__filename, 'utf8').split(/\r?\n/).slice(3);
        const end = lines.findIndex(l => !l.startsWith('//'));
        process.stdout.write(lines.slice(0, end).map(l => l.replace(/^\/\/ ?/, '')).join('\n') + '\n');
        return 0;
    }
    if (args.rejudge) return rejudge(args);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outDir = args.out || localDir(stamp);
    const { out, close } = setupOutput(outDir, args.verbose);
    const startedAt = Date.now();
    // --block-providers: the guard goes in before anything can reach the network.
    const blocked = args.blocked;
    const guard = offline.installNetGuard(blocked);
    const blockNotes = [];

    const cfg = loadConfig(args);
    cfg.blocked = blocked;
    let audio = !args.text;
    if (audio && blocked.includes(cfg.stt.provider)) {
        audio = false;
        blockNotes.push(`STT ${cfg.stt.provider} is blocked: text mode`);
    } else if (audio && blocked.includes('gemini')) {
        audio = false;
        blockNotes.push('Gemini TTS is blocked: text mode');
    }
    let stubLlm = false;
    if (blocked.length && cfg.llm.provider && cfg.llm.model) {
        const { splitByProvider } = require('../../src/features/common/ai/factory');
        const kept = offline.filterLlmList(cfg.llm.model, cfg.llm.provider, blocked, splitByProvider);
        if (kept) {
            if (kept.dropped.length) blockNotes.push(`LLM list without ${kept.dropped.join(',')}`);
            cfg.llm = { provider: kept.provider, model: kept.model };
        } else {
            stubLlm = true;
            blockNotes.push('every LLM in the list is blocked: a local stub answers (checks on the answer text are info only)');
        }
    } else if (blocked.length) {
        stubLlm = true;
        blockNotes.push('no LLM list: a local stub answers');
    }
    harness.useStubLlm(stubLlm);
    if (stubLlm) {
        const skipped = args.phases.filter(p => ['C', 'D', 'E', 'G'].includes(p));
        if (skipped.length) {
            args.phases = args.phases.filter(p => !skipped.includes(p));
            blockNotes.push(`phases ${skipped.join(',')} skipped: they need a real model`);
        }
    }
    if (args.judge && blocked.includes('gemini')) {
        args.judge = false;
        blockNotes.push('--judge off: the judge is Gemini');
    }

    out(`Live eval · ${audio ? 'audio' : 'text'} mode · phases ${args.phases.join(',')}`);
    const configLines = describe(cfg);
    if (blocked.length) configLines.push(`blocked: ${blocked.join(',')}${blockNotes.length ? ` (${blockNotes.join('; ')})` : ''}`);
    if (stubLlm) configLines[configLines.findIndex(l => l.startsWith('LLM:'))] = `LLM: ${offline.STUB_PROVIDER} (--block-providers)`;
    if (args.phases.includes('G') && args.endpointModels.length) configLines.push(`phase G also: ${args.endpointModels.join(',')} (openai-compatible)`);
    configLines.forEach(l => out(`  ${l}`));
    out(`  report: ${outDir}`);
    if (!stubLlm && (!cfg.llm.provider || !cfg.llm.model)) throw new Error('no LLM list: configure one in the app or pass --llm-models');
    if (audio && (!cfg.stt.provider || !cfg.stt.apiKey)) throw new Error('no STT provider with a key: configure one in the app, or run with --text');

    // An endpoint still warming up would fail its catalog refresh and its models.
    const usesEndpoint = !stubLlm && !!cfg.keys['openai-compatible'];
    if (usesEndpoint) await waitForEndpoint(cfg.keys['openai-compatible'], out);
    const models = await harness.setupModels(cfg, out);
    const needCareer = ['A', 'B', 'F', 'G'].some(p => args.phases.includes(p));
    let career = null;
    if (needCareer && cfg.kbPath) {
        try {
            career = await harness.setupCareer(cfg, { bm25Only: args.bm25Only, log: out });
        } catch (err) {
            out(`[career] not loaded: ${err.message}`);
        }
    }
    const tts = audio ? createTts({ geminiKey: cfg.keys.gemini, cacheDir: args.ttsCache || localDir('tts-cache'), log: out }) : null;
    const fixtures = JSON.parse(fs.readFileSync(path.join(FIX, 'interview.json'), 'utf8'));

    const items = [];
    const ctx = {
        args,
        cfg,
        models,
        career,
        tts,
        audio,
        stubLlm,
        outDir,
        out,
        emit: item => out(consoleLine(item)),
    };

    let history = [];
    const wantsInterview = args.phases.includes('A') || args.phases.includes('B');
    if (wantsInterview) {
        const kbQuestions = args.phases.includes('B')
            ? career && cfg.kbPath && args.kbSample > 0 ? sampleKb(cfg.kbPath, args.kbSample, args.seed) : null
            : [];
        if (args.phases.includes('B') && !kbQuestions) out('B skipped: no career notes (CAREER_KB_PATH) or the module did not load');
        const byLang = { 'pt-BR': (kbQuestions || []).filter(q => langTag(q.lang || '') === 'pt'), 'en-US': (kbQuestions || []).filter(q => langTag(q.lang || '') === 'en') };

        for (let rep = 0; rep < args.repeat; rep++) {
            if (args.repeat > 1) out(`— repetition ${rep + 1}/${args.repeat}`);
            const session = harness.createSession({ cfg, career, tts, audio, log: out, liveFeatures: 'answer', textPace: !args.fast });
            let started = false;
            for (const phaseDef of fixtures.phases) {
                out(`— ${phaseDef.lang}`);
                if (!started) {
                    await session.start(phaseDef.lang);
                    started = true;
                } else {
                    await session.switchLanguage(phaseDef.lang);
                }
                if (args.phases.includes('A')) items.push(...(await phaseA(ctx, session, phaseDef)));
                if (rep === 0 && kbQuestions && byLang[phaseDef.lang].length) items.push(...(await phaseB(ctx, session, byLang[phaseDef.lang], phaseDef.lang)));
            }
            history = session.history();
            await session.stop();
        }
    }

    if (args.phases.includes('C')) {
        out('— Ask with a screenshot');
        items.push(...(await phaseC(ctx, history)));
    }
    if (args.phases.includes('D')) {
        out('— Ask code');
        items.push(...(await phaseD(ctx, history)));
    }
    if (args.phases.includes('E')) {
        out('— Ask system design');
        items.push(...(await phaseE(ctx, history)));
    }
    if (args.phases.includes('G')) {
        out('— Each model alone');
        items.push(...(await phaseG(ctx)));
    }
    if (args.phases.includes('F')) {
        out('— Stress');
        items.push(...(await phaseF(ctx, fixtures)));
    }

    if (args.judge) await judgeItems(ctx, items);
    if (career?.embedder) career.embedder.close();

    const aggregates = aggregate(items);
    if (args.phases.includes('G')) aggregates.eachModel = modelSummary(items);
    if (blocked.length) {
        // Requests the guard stopped: each one is a path that would have spent quota.
        aggregates.blockedRequests = { ...guard.attempts };
        aggregates.stubLlm = stubLlm;
    }
    const run = {
        startedAt: new Date(startedAt).toISOString(),
        elapsedMs: Date.now() - startedAt,
        mode: audio ? 'audio' : 'text',
        phases: args.phases,
        config: configLines,
        phaseNames: PHASE_NAMES,
        aggregates,
        items: items.map(({ imageBase64, ...rest }) => rest),
    };
    const counts = writeReports(outDir, run);
    out('');
    out(`Aggregates: ${JSON.stringify(aggregates)}`);
    if (blocked.length) {
        const tried = Object.entries(guard.attempts).filter(([, n]) => n > 0);
        out(tried.length
            ? `Blocked requests (stopped before leaving the machine): ${tried.map(([p, n]) => `${p}=${n}`).join(' ')}`
            : `Blocked providers: ${blocked.join(',')} — no request to them was attempted`);
    }
    out(`${counts.PASS} pass · ${counts.WARN} warn · ${counts.FAIL} fail in ${Math.round(run.elapsedMs / 1000)} s`);
    out(`Report: ${path.join(outDir, 'report.md')}`);
    await close();
    return items.some(i => statusOf(i) === 'FAIL') ? 1 : 0;
}

main().then(
    code => process.exit(code),
    err => {
        process.stderr.write(`live eval failed: ${err.stack || err.message}\n`);
        process.exit(2);
    }
);

'use strict';

// The Listen pipeline of the app, minus its windows and DB: the real
// SttService and SummaryService, wired as listenService.js wires them
// (onTranscriptionComplete → summaryService.addConversationTurn), the real
// provider chain (factory.createStreamingLLM), the model catalog read from the
// providers' APIs, and the career module over the notes the app reads.
//
// Only observation is added:
//   - sendToRenderer of both services records each payload with its time;
//   - factory.createStreamingLLM / createLLM are wrapped before
//     summaryService loads (it destructures them at require time). The
//     wrapper passes the SSE bytes through unchanged and notes _reset,
//     _final_model, the first token and the end, keyed to the answer that
//     made the call (AsyncLocalStorage);
//   - summary.career is the real module behind a recorder of each decision
//     (route, block, sources).
// modelStateService.getCurrentModelInfo returns what config.js read, in the
// shape the app builds (keys per provider of the list, _keysForModelList).

const { AsyncLocalStorage } = require('node:async_hooks');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'src');
const req = p => require(path.join(SRC, p));

const als = new AsyncLocalStorage();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// LLM tap (installed once, before summaryService loads)
// ---------------------------------------------------------------------------

const calls = [];
let tapInstalled = false;

function tapStream(response, call) {
    const body = response?.body;
    if (!body || typeof body.getReader !== 'function') return response;
    const decoder = new TextDecoder();
    let carry = '';
    const scan = text => {
        carry += text;
        const lines = carry.split('\n');
        carry = lines.pop();
        for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (data === '[DONE]') {
                call.done = true;
                continue;
            }
            let j;
            try {
                j = JSON.parse(data);
            } catch {
                continue;
            }
            if (j._reset) call.resets.push({ at: Date.now(), next: j.next_model || null, reason: j.reason || null });
            else if (j._final_model) call.finalModel = j._final_model;
            else if (j.choices?.[0]?.delta?.content && !call.firstTokenAt) call.firstTokenAt = Date.now();
        }
    };
    const reader = body.getReader();
    const tapped = new ReadableStream({
        async pull(controller) {
            try {
                const { done, value } = await reader.read();
                if (done) {
                    call.endAt = Date.now();
                    controller.close();
                    return;
                }
                scan(decoder.decode(value, { stream: true }));
                controller.enqueue(value);
            } catch (err) {
                call.endAt = Date.now();
                call.error = err.message;
                controller.error(err);
            }
        },
        cancel(reason) {
            call.endAt = call.endAt || Date.now();
            call.cancelled = true;
            return reader.cancel(reason);
        },
    });
    return { ...response, body: tapped };
}

function installLlmTap() {
    if (tapInstalled) return;
    tapInstalled = true;
    const factory = req('features/common/ai/factory');
    const origStreaming = factory.createStreamingLLM;
    const origLlm = factory.createLLM;
    factory.createStreamingLLM = (provider, opts) => {
        const llm = origStreaming(provider, opts);
        return {
            ...llm,
            streamChat: async (messages, ...rest) => {
                const ctx = als.getStore() || {};
                const hasImage = messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image_url'));
                const system = messages.find(m => m.role === 'system');
                const call = {
                    // transcript lines the prompt carries (summaryService keeps the last 30)
                    promptTurns: typeof system?.content === 'string' ? (system.content.match(/^(?:me|them): /gm) || []).length : null,
                    lane: ctx.lane || (opts?.maxTokens === 900 ? 'answer' : 'ask'),
                    answerId: ctx.answerId ?? null,
                    tag: ctx.tag || null,
                    provider,
                    list: opts?.model || null,
                    hasImage,
                    startedAt: Date.now(),
                    firstTokenAt: null,
                    endAt: null,
                    finalModel: null,
                    resets: [],
                    error: null,
                };
                calls.push(call);
                try {
                    return tapStream(await llm.streamChat(messages, ...rest), call);
                } catch (err) {
                    call.error = err.userMessage || err.message;
                    call.endAt = Date.now();
                    throw err;
                }
            },
        };
    };
    factory.createLLM = (provider, opts) => {
        const llm = origLlm(provider, opts);
        return {
            ...llm,
            chat: async (...a) => {
                const call = { lane: 'insights', provider, list: opts?.model || null, startedAt: Date.now(), endAt: null, error: null, resets: [], finalModel: null };
                calls.push(call);
                try {
                    const r = await llm.chat(...a);
                    call.endAt = Date.now();
                    call.finalModel = r?.model || null;
                    return r;
                } catch (err) {
                    call.error = err.message;
                    call.endAt = Date.now();
                    throw err;
                }
            },
        };
    };
}

// ---------------------------------------------------------------------------
// Model info and catalog, as the app builds them
// ---------------------------------------------------------------------------

function memoryStore(rows) {
    const saved = new Map((rows || []).map(r => [`${r.provider}\0${r.model_id}`, r]));
    return {
        getAll: () => [...saved.values()],
        upsert: row => saved.set(`${row.provider}\0${row.model_id}`, row),
    };
}

async function setupModels(cfg, log) {
    const catalog = req('features/common/ai/modelCatalog');
    const factory = req('features/common/ai/factory');
    const modelStateService = req('features/common/services/modelStateService');

    catalog.configure({ store: memoryStore(cfg.catalogRows), fetchers: catalog.defaultFetchers ? catalog.defaultFetchers() : undefined });
    if (typeof catalog.load === 'function') catalog.load();
    const refreshed = {};
    for (const p of catalog.CATALOG_PROVIDERS) {
        if (!cfg.keys[p]) continue;
        refreshed[p] = await catalog.refresh(p, cfg.keys[p], { force: true }).catch(() => false);
    }
    log(`[models] catalog refreshed: ${Object.entries(refreshed).map(([p, ok]) => `${p}=${ok ? 'ok' : 'failed'}`).join(' ') || 'none'}`);

    const llmInfo = () => {
        const { provider, model } = cfg.llm;
        if (!provider || !model) return null;
        const keys = {};
        for (const seg of factory.splitByProvider(model, provider)) {
            if (!(seg.provider in keys)) keys[seg.provider] = cfg.keys[seg.provider] || null;
        }
        return { provider, model, apiKey: cfg.keys[provider] || null, keys };
    };
    modelStateService.getCurrentModelInfo = async type => (type === 'llm' ? llmInfo() : cfg.stt.provider ? { ...cfg.stt } : null);
    return { catalog, factory, llmInfo };
}

// ---------------------------------------------------------------------------
// Career module over the app's notes and vector cache
// ---------------------------------------------------------------------------

async function setupCareer(cfg, { bm25Only, log }) {
    if (!cfg.kbPath) return null;
    const { createCareerModule } = req('features/common/career');
    const { createEmbedder } = req('features/common/career/embedder');
    const { appCacheDir } = require('../career-cache-dir');
    const embedder = bm25Only ? null : createEmbedder({ cacheDir: () => appCacheDir() });
    const mod = createCareerModule({
        env: { ...process.env, CAREER_KB_PATH: cfg.kbPath, LIVE_ANSWER_DEBUG: '' },
        embedder,
        debug: false,
    });
    await mod.warm();
    if (embedder) {
        // The app syncs in the background; the eval waits, so every turn sees vectors.
        const kb = req('features/common/career/kbService').createKbService({ root: cfg.kbPath });
        const snap = await kb.refresh();
        if (snap) {
            const t0 = Date.now();
            await embedder.sync(snap.chunks);
            log(`[career] vectors ready=${embedder.isReadyFor(snap.chunks)} rows=${embedder.vectorCount()} in ${Date.now() - t0}ms`);
        }
    }
    const st = mod.status();
    log(`[career] state=${st.state} chunks=${st.chunks} vectors=${st.vectors}`);
    return { mod, embedder };
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/**
 * @param {object} o
 * @param {object} o.cfg - config.js
 * @param {object|null} o.career - setupCareer() result
 * @param {object|null} o.tts - tts.js (audio mode)
 * @param {boolean} o.audio
 * @param {(line: string) => void} o.log
 * @param {'both'|'answer'|'insights'} [o.liveFeatures] - which Listen lanes run
 * @param {boolean} [o.textPace=true] - text mode: wait as long as saying the turn would take
 */
function createSession({ cfg, career, tts, audio, log, liveFeatures = 'answer', feederSpeed = 1, textPace = true }) {
    installLlmTap();
    const SummaryService = req('features/listen/summary/summaryService');
    const SttService = req('features/listen/stt/sttService');
    const { createFeeder } = require('./audioFeeder');

    const events = [];
    const careerDecisions = [];
    const answers = new Map();
    const turns = [];
    const sttFinals = [];
    const t0 = Date.now();

    const summary = new SummaryService();
    summary.sendToRenderer = (channel, data) => {
        events.push({ at: Date.now(), channel, data });
        if (channel === 'live-answer-update' && data && data.id != null) {
            const a = answers.get(data.id) || newAnswer(data.id);
            if (data.question && !a.question) a.question = data.question;
            if (data.answer != null) {
                if (!a.firstTokenAt) a.firstTokenAt = Date.now();
                a.text = data.answer;
                a.lastUpdateAt = Date.now();
            }
            if (data.sources) a.sources = data.sources;
            if (data.unverified) a.unverified = data.unverified;
            if (data.status === 'retrying') a.retrying.push(data.model || null);
            if (data.status === 'error') {
                a.status = 'error';
                a.error = data.error;
            }
        }
    };
    summary.setLiveFeatures(liveFeatures);

    function newAnswer(id) {
        const a = { id, question: '', text: '', status: 'pending', error: null, sources: [], unverified: [], retrying: [], startedAt: null, firstTokenAt: null, endAt: null, career: null };
        answers.set(id, a);
        return a;
    }

    // Answer lane: one context per answer, so the LLM tap and the career recorder know which answer they serve.
    const origMake = summary.makeLiveAnswer.bind(summary);
    summary.makeLiveAnswer = (conv, signal, meta = {}) => als.run({ lane: 'answer', answerId: meta.id }, async () => {
        const a = answers.get(meta.id) || newAnswer(meta.id);
        a.startedAt = Date.now();
        a.question = a.question || meta.question || '';
        a.career = meta.career ? summarizeCareer(meta.career) : null;
        try {
            const r = await origMake(conv, signal, meta);
            a.endAt = Date.now();
            if (signal?.aborted) a.status = 'aborted';
            else if (r) a.status = 'answer';
            else if (a.status !== 'error') a.status = a.text ? 'answer' : 'passive-or-empty';
            return r;
        } catch (err) {
            a.endAt = Date.now();
            a.status = signal?.aborted ? 'aborted' : 'error';
            a.error = a.error || err.userMessage || err.message;
            throw err;
        }
    });

    function summarizeCareer(c) {
        return {
            route: c.route,
            cue: c.cue || null,
            hasBlock: !!c.block,
            blockChars: (c.block || '').length,
            chunks: (c.chunkIds || []).length,
            sources: (c.sources || []).length,
            totalMs: c.timings?.totalMs ?? null,
            vectorUsed: !!c.timings?.vectorUsed,
            // Router (spec 2026-10-13): who decided, and how long the answer waited for the route.
            routeSource: c.routeSource || null,
            routeFallback: c.routeFallback || null,
            jevMs: c.jevMs ?? null,
            routeWaitMs: c.timings?.routeMs ?? null,
        };
    }

    if (career) {
        const mod = career.mod;
        summary.career = {
            ...mod,
            getCareerContext: async (text, session, opts) => {
                const r = await mod.getCareerContext(text, session, opts);
                careerDecisions.push({ at: Date.now(), activeCompany: session?.activeCompany || null, ...(r ? summarizeCareer(r) : { route: null }), _block: r?.block || '' });
                return r;
            },
            detectCompany: text => mod.detectCompany(text),
        };
    } else {
        // No notes: the disabled singleton behaves as the app without CAREER_KB_PATH.
        summary.career = { warm() {}, prefetch() {}, getCareerContext: async () => null, hasCareerCue: () => false, detectCompany: () => null, checkAnswer: () => [], status: () => ({ state: 'disabled' }) };
    }

    const stt = audio ? new SttService() : null;
    // The STT favors the notes' names, as in the app (sttKeyterms.js).
    if (stt && career) stt.career = career.mod;
    let feeder = null;
    const onTurn = (speaker, text) => {
        sttFinals.push({ at: Date.now(), speaker, text });
        summary.addConversationTurn(speaker, text);
    };
    if (stt) {
        stt.sendToRenderer = (channel, data) => {
            if (channel === 'stt-update') events.push({ at: Date.now(), channel, data: { speaker: data.speaker, isFinal: data.isFinal, chars: (data.text || '').length } });
        };
        stt.setCallbacks({ onTranscriptionComplete: onTurn, onStatusUpdate: () => {} });
    }

    async function start(language) {
        if (!stt) return;
        await stt.initializeSttSessions(language);
        feeder = createFeeder({
            sendThem: (b64, mime) => stt.sendSystemAudioContent(b64, mime),
            sendMe: (b64, mime) => stt.sendMicAudioContent(b64, mime),
            log,
            speed: feederSpeed,
        });
        feeder.start();
        await sleep(1500);   // a moment of room noise before the first turn
    }

    async function switchLanguage(language) {
        if (!stt) return;
        feeder?.stop();
        await stt.closeSessions();
        await start(language);
    }

    async function stop() {
        feeder?.stop();
        if (stt) await stt.closeSessions().catch(() => {});
        summary.resetLiveAnswer();
    }

    /** Wait until the STT, the debounce and the answer lane have all settled. */
    async function waitIdle({ quietMs = 700, timeoutMs = 90_000 } = {}) {
        const end = Date.now() + timeoutMs;
        let quietSince = null;
        while (Date.now() < end) {
            const busy = !!summary.answerDebounceTimer || summary.inFlight
                || (stt && (stt.theirCompletionTimer || stt.myCompletionTimer || stt.theirCurrentUtterance || stt.myCurrentUtterance));
            if (busy) quietSince = null;
            else if (quietSince == null) quietSince = Date.now();
            else if (Date.now() - quietSince >= quietMs) return true;
            await sleep(100);
        }
        return false;
    }

    /**
     * One spoken turn. Audio mode: TTS → feeder → the provider's transcript →
     * the app's own turn completion. Text mode: the final transcript directly.
     * @param {{ speaker: 'them'|'me', text: string|string[], lang: string, pauseMs?: number }} turn
     *   text as an array is said in parts, pauseMs apart.
     */
    async function say(turn) {
        const parts = Array.isArray(turn.text) ? turn.text : [turn.text];
        const speaker = turn.speaker === 'me' ? 'Me' : 'Them';
        const rec = { speaker: turn.speaker, lang: turn.lang, saidAt: Date.now(), audioEndAt: null, audioSeconds: 0, tts: [], sttFinalsFrom: sttFinals.length };
        if (!stt) {
            for (let i = 0; i < parts.length; i++) {
                if (i) await sleep(turn.pauseMs || 0);
                // The time it takes to say the part (~3.5 words/s), so turns arrive as often as in a call.
                if (textPace) await sleep(Math.min(8000, parts[i].split(/\s+/).length * 285));
                onTurn(speaker, parts[i]);
            }
            rec.audioEndAt = Date.now();
        } else {
            for (let i = 0; i < parts.length; i++) {
                const clip = await tts.speak(parts[i], turn.speaker, turn.lang);
                rec.tts.push(clip.engine);
                rec.audioSeconds += clip.seconds;
                if (i) await sleep(turn.pauseMs || 0);
                rec.audioEndAt = await feeder.play(turn.speaker, clip.pcm);
            }
            // The provider's final result, then the app's 2 s turn debounce.
            const deadline = Date.now() + 15_000;
            while (Date.now() < deadline && !sttFinals.slice(rec.sttFinalsFrom).some(f => f.speaker === speaker)) await sleep(100);
        }
        turns.push(rec);
        return rec;
    }

    /** say() then wait for the answer lane to settle; returns the turn and what it produced. */
    async function exchange(turn, opts = {}) {
        const answersBefore = new Set(answers.keys());
        const callsBefore = calls.length;
        const decisionsBefore = careerDecisions.length;
        const rec = await say(turn);
        await sleep(opts.settleMs ?? 1200);   // 800 ms answer debounce + margin
        await waitIdle({ timeoutMs: opts.timeoutMs ?? 90_000 });
        const finals = sttFinals.slice(rec.sttFinalsFrom);
        const newAnswers = [...answers.values()].filter(a => !answersBefore.has(a.id));
        const myCalls = calls.slice(callsBefore);
        return {
            turn: rec,
            transcript: finals.filter(f => f.speaker.toLowerCase() === turn.speaker).map(f => f.text).join(' '),
            sttFinalAt: finals.length ? finals[finals.length - 1].at : null,
            answers: newAnswers.map(a => ({ ...a, call: myCalls.find(c => c.answerId === a.id) || null })),
            career: careerDecisions.slice(decisionsBefore),
            calls: myCalls,
        };
    }

    return {
        summary,
        stt,
        events,
        answers,
        calls,
        careerDecisions,
        start,
        stop,
        switchLanguage,
        say,
        exchange,
        waitIdle,
        history: () => summary.getConversationHistory().slice(),
        elapsed: () => Date.now() - t0,
    };
}

/** Run fn with the LLM tap attributing its calls to an Ask tag. */
function inAskContext(tag, fn) {
    return als.run({ lane: 'ask', tag }, fn);
}

module.exports = { installLlmTap, setupModels, setupCareer, createSession, inAskContext, calls };

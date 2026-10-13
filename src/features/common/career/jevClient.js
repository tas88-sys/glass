'use strict';

// HTTP client for the Jev decision model (TypeSafe AI), used by jevRouter.js
// (spec 2026-10-13-career-router-jev). Pure request building and response
// parsing plus one POST with a hard timeout: no retries (the live path has no
// time for them), no SDK, native fetch.
//
// API (docs.typesafe.ai/api, checked 2026-10-13): POST /v1/systemone with
// { model, state, questions }. A `choice` question answers in
// answers.<id>.{choice, probabilities, confidence}; a `noul` question in
// answers.<id>.noul (0..1). Errors: 401, 422 (names the field), 429, 529.
//
// Errors carry a kind and an HTTP status only, never the request or the
// response body: the turn text and the manifest's names stay out of logs (C2).

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_MODEL = 'jev-1.13.0';   // a fixed version: an alias (jev-latest) changes answers without notice

const ROUTES = ['personal', 'company', 'ambiguous', 'general'];

const MAX_TURN_CHARS = 2000;
const MAX_PREV_CHARS = 600;
const MAX_NAMES = 60;
const MAX_NAME_CHARS = 60;

// Instructions and criteria are in English, the model's primary language; the
// examples pair an English and a Brazilian Portuguese phrasing so both read as
// the same intent. Changing any text here changes the routes: rerun
// scripts/eval-career-kb.js --router jev before and after.
const ROUTE_INSTRUCTIONS =
    'Classify `turn`, the interviewer\'s latest words in a job interview, by what the candidate should draw on to answer. ' +
    'The turn may be in English or Brazilian Portuguese and may contain speech-to-text errors. ' +
    '`previous_question` is the last question the candidate answered, for context. ' +
    '`candidate_names` are the candidate\'s own past employers and projects; `note_companies` are companies the candidate prepared for; ' +
    '`interviewer_company` is the company running this interview, when known.';

const ROUTE_CRITERIA = {
    personal:
        'About the candidate\'s own background: past experience, something they did, their career, strengths and weaknesses, ' +
        'motivations, why they are leaving, salary, availability, or one of `candidate_names`. ' +
        'E.g. "Tell me about a time you disagreed with a teammate" / "Me conta de uma vez que você discordou do seu time".',
    company:
        'About the interviewer\'s company or this role: why the candidate wants to join, what they know about the company, ' +
        'the job opening, or a company from `note_companies` named as the one interviewing. ' +
        'E.g. "Why do you want to join us?" / "Por que você quer trabalhar com a gente?"',
    ambiguous:
        'A hypothetical, habitual or opinion question to the candidate, where their experience may help but is not asked for directly. ' +
        'E.g. "How would you handle a production outage?" / "Como você lida com prazos apertados?"',
    general:
        'Anything else: a technical or factual question that is not about the candidate, small talk, or a statement. ' +
        'E.g. "What is the difference between a process and a thread?" / "Qual a diferença entre processo e thread?"',
};

const FOLLOW_UP_INSTRUCTIONS =
    'Is `turn` a short follow-up asking for more about `previous_question` (the outcome, what happened next, what was learned), ' +
    'rather than a new question? The turn may be in English or Brazilian Portuguese.';

class JevError extends Error {
    /**
     * @param {'timeout'|'aborted'|'auth'|'validation'|'rate'|'overload'|'http'|'net'|'bad-body'} kind
     * @param {number|null} [status]
     * @param {string|null} [field]  the field a 422 names (a key path, never a value)
     */
    constructor(kind, status = null, field = null) {
        super(`jev ${kind}${status ? ` ${status}` : ''}`);
        this.name = 'JevError';
        this.kind = kind;
        this.status = status;
        this.field = field;
    }
}

const clip = (s, n) => (s.length > n ? s.slice(0, n) : s);
const tail = (s, n) => (s.length > n ? s.slice(-n) : s);

function names(list) {
    const out = [];
    const seen = new Set();
    for (const n of Array.isArray(list) ? list : []) {
        if (typeof n !== 'string') continue;
        const v = clip(n.trim(), MAX_NAME_CHARS);
        const k = v.toLowerCase();
        if (!v || seen.has(k)) continue;
        seen.add(k);
        out.push(v);
        if (out.length >= MAX_NAMES) break;
    }
    return out;
}

/**
 * The request body for one turn.
 * @param {string} text
 * @param {{ previousQuestion?: string|null, previousRoute?: string|null, interviewerCompany?: string|null,
 *           entities?: string[], companies?: string[] }} [ctx]
 * @param {string} [model]
 */
function buildRequest(text, ctx = {}, model = DEFAULT_MODEL) {
    const c = ctx || {};
    const state = { turn: clip(String(text).trim(), MAX_TURN_CHARS) };
    const prevQ = typeof c.previousQuestion === 'string' ? c.previousQuestion.trim() : '';
    if (prevQ) {
        state.previous_question = tail(prevQ, MAX_PREV_CHARS);
        if (typeof c.previousRoute === 'string' && c.previousRoute) state.previous_route = c.previousRoute;
    }
    const company = typeof c.interviewerCompany === 'string' ? clip(c.interviewerCompany.trim(), MAX_NAME_CHARS) : '';
    if (company) state.interviewer_company = company;
    const candidate = names(c.entities);
    if (candidate.length) state.candidate_names = candidate;
    const prepared = names(c.companies);
    if (prepared.length) state.note_companies = prepared;

    const questions = {
        route: { type: 'choice', instructions: ROUTE_INSTRUCTIONS, criteria: { ...ROUTE_CRITERIA } },
    };
    if (prevQ) questions.follow_up = { type: 'noul', instructions: FOLLOW_UP_INSTRUCTIONS };
    return { model, state, questions };
}

const unit = x => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1;

/**
 * The answers we use, or null when the body is not what the API documents.
 * @param {unknown} json
 * @returns {{ route: string, confidence: number, probabilities: Record<string, number>, followUp: number|null, model: string|null }|null}
 */
function parseResponse(json) {
    if (!json || typeof json !== 'object') return null;
    const answers = json.answers;
    if (!answers || typeof answers !== 'object') return null;
    const r = answers.route;
    if (!r || typeof r !== 'object' || !ROUTES.includes(r.choice) || !unit(r.confidence)) return null;
    const probabilities = {};
    if (r.probabilities && typeof r.probabilities === 'object') {
        for (const k of ROUTES) if (unit(r.probabilities[k])) probabilities[k] = r.probabilities[k];
    }
    const f = answers.follow_up;
    const followUp = f && typeof f === 'object' && unit(f.noul) ? f.noul : null;
    return {
        route: r.choice,
        confidence: r.confidence,
        probabilities,
        followUp,
        model: typeof json.model === 'string' ? json.model : null,
    };
}

// A 422 body names the offending field; keep it only if it looks like a key path.
function fieldOf(body) {
    const pick = v => (typeof v === 'string' && /^[\w.[\]-]{1,64}$/.test(v) ? v : null);
    if (!body || typeof body !== 'object') return null;
    const detail = Array.isArray(body.detail) ? body.detail[0] : null;
    return pick(body.field)
        || pick(body.error && body.error.field)
        || (detail && Array.isArray(detail.loc) ? pick(detail.loc.join('.')) : null)
        || pick(body.param);
}

function kindOf(status) {
    if (status === 401 || status === 403) return 'auth';
    if (status === 422 || status === 400) return 'validation';
    if (status === 429) return 'rate';
    if (status === 529 || status === 503) return 'overload';
    return 'http';
}

/**
 * One POST, bounded by timeoutMs and by the caller's signal. Resolves to the
 * parsed JSON body; rejects with a JevError.
 * @param {{ apiKey: string, body: object, timeoutMs: number, signal?: AbortSignal,
 *           fetchImpl?: typeof fetch, endpoint?: string }} args
 */
async function post({ apiKey, body, timeoutMs, signal, fetchImpl, endpoint }) {
    const doFetch = fetchImpl || globalThis.fetch;
    if (typeof doFetch !== 'function') throw new JevError('net');
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);
    const onAbort = () => controller.abort();
    if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener('abort', onAbort, { once: true });
    }
    // The timeout holds even if a fetch (or a body read) ignores the signal.
    const stopped = new Promise((_, reject) => {
        if (controller.signal.aborted) reject(new Error('aborted'));
        else controller.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    stopped.catch(() => {});
    try {
        let res;
        try {
            res = await Promise.race([
                doFetch(endpoint || ENDPOINT, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                    signal: controller.signal,
                }),
                stopped,
            ]);
        } catch {
            throw new JevError(timedOut ? 'timeout' : controller.signal.aborted ? 'aborted' : 'net');
        }
        let json = null;
        try {
            json = await Promise.race([res.json(), stopped]);
        } catch {
            if (timedOut) throw new JevError('timeout');
            if (controller.signal.aborted) throw new JevError('aborted');
            json = null;
        }
        if (!res.ok) throw new JevError(kindOf(res.status), res.status, res.status === 422 ? fieldOf(json) : null);
        if (json === null) throw new JevError('bad-body', res.status);
        return json;
    } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
    }
}

module.exports = {
    ENDPOINT,
    DEFAULT_MODEL,
    ROUTES,
    MAX_NAMES,
    MAX_NAME_CHARS,
    MAX_TURN_CHARS,
    MAX_PREV_CHARS,
    JevError,
    buildRequest,
    parseResponse,
    post,
};

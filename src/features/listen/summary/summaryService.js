const { BrowserWindow } = require('electron');
const { getSystemPrompt } = require('../../common/prompts/promptBuilder.js');
const { createLLM, createStreamingLLM } = require('../../common/ai/factory');
const sessionRepository = require('../../common/repositories/session');
const summaryRepository = require('./repositories');
const { liveAnswerRepository } = require('./repositories/liveAnswers');
const modelStateService = require('../../common/services/modelStateService');
const careerContext = require('../../common/career');
const { DEFAULT_LIVE_FEATURES, normalizeLiveFeatures, answerEnabled, insightsEnabled } = require('../liveFeatures');

// Verbose live-answer trace logging — gated behind LIVE_ANSWER_DEBUG=1 so it
// stays out of normal runs but can be re-enabled for diagnosis. NEVER logs the
// answer body (safety invariant) — only gate decisions, counts, and provider.
const LIVE_ANSWER_DEBUG = process.env.LIVE_ANSWER_DEBUG === '1' || process.env.LIVE_ANSWER_DEBUG === 'true';
function laDebug(...args) {
    if (LIVE_ANSWER_DEBUG) console.log(...args);
}

// The question gate (isLikelyQuestion, FR-002; shouldTriggerAnswer, FR-001/FR-004) lives in questionGate.js.
const {
    isLikelyQuestion,
    peelLead,
    leadsQuestion,
    hasContentCue,
    EMBEDDED_Q_RE,
    normalizeTail,
    shouldTriggerAnswer,
    isBackchannel,
    endsWithConfirmationCheck,
} = require('./questionGate');
// The question's language, named in the live answer prompt.
const { answerLanguageRule } = require('./questionLanguage');

// Added to the live answer instruction when the turn ends only checking that the
// candidate is following (spec 2026-10-16-confirmation-check-answer). A real
// session got a three-bullet recap for "…, está bem?", and "you can reach me any
// time" offered back in the interviewer's voice.
const CONFIRMATION_CHECK_RULE =
    'That turn ends by only checking that the candidate is following ("está bem?", "ok?", "certo?"). ' +
    'If the rest of it tells the candidate something (about the interviewer, the company, the role, the process or the next steps) ' +
    'rather than asking about their experience or knowledge, reply with ONE short sentence the candidate would say back, ' +
    'such as "Perfeito, ficou claro." or "Combinado, obrigado.": no bullets, no summary of what was said. ' +
    'Speak as the candidate: never offer back what the interviewer offered. Otherwise answer as above.';

// ---------------------------------------------------------------------------
// Pure helper: extractQuestion (FR-006/FR-007/FR-009/FR-012)
// Given a raw transcription turn, extract the most-specific interrogative
// span. Reuses the four module-scope signal regexes and the clause-split /
// discourse-marker-peel shape from isLikelyQuestion.
//
// Algorithm:
//   guard: non-string → ''; trim; empty → ''
//   split into clauses on sentence-boundary punctuation
//   for each clause: peel discourse markers (LEAD_STRIP_RE), then test signals
//   track the LAST signal-bearing clause (prefer '?'-ending, else CLAUSE_LEAD_RE/
//   CONTENT_CUE_RE/EMBEDDED_Q_RE)
//   return that peeled clause (discourse markers stripped), else full trimmed text
//
// Total / pure: never throws, never returns null/undefined. Non-empty input
// always yields non-empty output (falls back to the full trimmed turn).
// ---------------------------------------------------------------------------
/**
 * A sentence from its last comma part that leads a question to its end, peeled:
 * commas drop the framing ("Como arquiteta, ou mesmo antes disso, como que você
 * faz…") and keep a list inside the question ("retries, timeouts, and idempotency").
 */
function askingSpan(sentence) {
    const parts = sentence.split(',');
    for (let i = parts.length - 1; i > 0; i--) {
        const rest = peelLead(parts.slice(i).join(','));
        if (rest && leadsQuestion(rest)) return rest;
    }
    return peelLead(sentence);
}

function extractQuestion(text) {
    if (typeof text !== 'string') return '';
    const trimmed = text.trim();
    if (trimmed.length === 0) return '';

    // Split on sentence-boundary punctuation AND em-dash (—) to isolate
    // interrogative spans from filler prefixes like "the thing I wanted to ask is —".
    // Not on commas: "with Go concurrency (goroutines, channels, context) in
    // production?" would surface as "context) in production?" (live eval q084).
    const clauses = trimmed.split(/[.!?;\n—]+/);
    let lastClause = null;      // peeled interrogative span (discourse markers stripped)
    let lastHasQ = false;       // did the original segment end with '?'
    let hasStrongSignal = false; // true when signal is '?' or CLAUSE_LEAD_RE (not cue-only)

    for (let i = 0; i < clauses.length; i++) {
        const rawClause = clauses[i].trim();
        if (rawClause.length === 0) continue;

        // Determine if the '?' follows this clause in the original text.
        // We check if the character immediately after this clause segment is '?'.
        const segEnd = trimmed.indexOf(rawClause) + rawClause.length;
        const nextChar = trimmed[segEnd] || '';
        const hasQuestionMark = nextChar === '?';

        // Peel leading discourse markers and comma framing
        const c = askingSpan(rawClause);

        if (c.length === 0) continue;

        const hasClauseLead = leadsQuestion(c);
        const hasCue = hasContentCue(c);
        const hasEmbedded = EMBEDDED_Q_RE.test(c);

        // Strong signal: explicit '?' or CLAUSE_LEAD_RE (wh-word / auxiliary leading
        // an interrogative clause). These reliably identify extractable spans.
        // Weak signal: CONTENT_CUE_RE / EMBEDDED_Q_RE — still a question signal but
        // insufficient to extract a sub-span; the full turn is the best label.
        const isStrong = hasQuestionMark || hasClauseLead || hasEmbedded;
        const isWeak = hasCue;
        const isSignal = isStrong || isWeak;

        if (isSignal) {
            lastClause = c;
            lastHasQ = hasQuestionMark;
            if (isStrong) hasStrongSignal = true;
        }
    }

    if (lastClause !== null && hasStrongSignal) {
        // Strong signal: return the narrowest interrogative span with leading
        // discourse markers peeled (LEAD_STRIP_RE) — so "And where are you based"
        // surfaces as "where are you based", dropping filler from the Q: label (G2).
        // Append '?' if the original turn had one after this clause.
        return lastHasQ ? lastClause + '?' : lastClause;
    }

    // Fallback: full trimmed text (T3 cue-only, T4, T8 declarative, no strong signal)
    return trimmed;
}

// ---------------------------------------------------------------------------
// Pure helper: normalizePassive (FR-010)
// Strip markdown emphasis (* _ ` #), strip surrounding punctuation,
// collapse + trim whitespace, uppercase.
// ---------------------------------------------------------------------------
function normalizePassive(text) {
    if (typeof text !== 'string') return '';
    let s = text;
    // Strip markdown emphasis chars: * _ ` #
    s = s.replace(/[*_`#]/g, '');
    // Strip surrounding punctuation (. , ! ? ;)
    s = s.replace(/^[\s.,!?;]+|[\s.,!?;]+$/g, '');
    // Collapse internal whitespace + trim
    s = s.replace(/\s+/g, ' ').trim();
    // Uppercase
    return s.toUpperCase();
}

// The normalized form of the native passive phrase (promptTemplates.js:388).
const NATIVE_PASSIVE_NORMALIZED = normalizePassive(
    'Not sure what you need help with right now'
);

// ---------------------------------------------------------------------------
// Pure helper: parseAnswerOrPassive (FR-010)
// Given the buffered stream prefix (up to first \n or ~16 chars), decide
// suppress (passive) vs render (flush the prefix).
// ---------------------------------------------------------------------------
function parseAnswerOrPassive(prefix) {
    if (typeof prefix !== 'string' || prefix.length === 0) {
        return { passive: false, flush: '' };
    }
    const norm = normalizePassive(prefix);
    // Suppress on the literal PASSIVE token, the full native phrase, OR a
    // sufficiently-long PREFIX of the native phrase — the streaming buffer
    // decides at ~16 chars, before the full 42-char native phrase has arrived
    // (FR-010 / EDGE_CASES.md:40). The >=16 guard keeps short real answers
    // ("No.", "Yes.") from accidentally matching an early slice of the phrase.
    if (
        norm === 'PASSIVE' ||
        norm === NATIVE_PASSIVE_NORMALIZED ||
        (norm.length >= 16 && NATIVE_PASSIVE_NORMALIZED.startsWith(norm))
    ) {
        return { passive: true, flush: '' };
    }
    return { passive: false, flush: prefix };
}

// ---------------------------------------------------------------------------
// Pure helper: parseLiveAnswerSseLine (FR-009)
// Extracted SSE line parser — mirrors askService._processStream sentinel
// handling WITHOUT importing askService (FR-017 — CLOSED set).
// Returns:
//   { done: true }                — on "[DONE]"
//   { reset: true, nextModel, reason } — on _reset sentinel (model being tried next)
//   { finalModel: string }        — on _final_model sentinel
//   { delta: string }             — on normal content token
//   null                          — blank line or non-data line
// ---------------------------------------------------------------------------
function parseLiveAnswerSseLine(line) {
    if (typeof line !== 'string' || !line.startsWith('data: ')) return null;
    const data = line.substring(6);
    if (data === '[DONE]') return { done: true };

    let json;
    try {
        json = JSON.parse(data);
    } catch {
        return null;
    }

    if (json._reset) return { reset: true, nextModel: json.next_model || null, reason: json.reason || null };
    if (json._final_model) return { finalModel: json._final_model };

    const delta = json.choices?.[0]?.delta?.content || '';
    if (delta) return { delta };
    return null;
}

class SummaryService {
    constructor() {
        this.previousAnalysisResult = null;
        this.analysisHistory = [];
        this.conversationHistory = [];
        this.currentSessionId = null;

        // Callbacks
        this.onAnalysisComplete = null;
        this.onStatusUpdate = null;

        // Answer-lane state (FR-011/FR-012 — in-memory only, C8)
        this.lastAnsweredTail = null;
        this.answerDebounceTimer = null;
        this.inFlightController = null;
        this.inFlight = false;
        this.hadFallback = false;
        this.lastAnswerTs = 0;
        // Monotonic id per answer — stable across one answer's stream, new per
        // question. Lets the renderer coalesce streaming deltas into one history
        // entry vs. pushing a new one (in-session answer history).
        this.answerSeq = 0;
        // Bumped when an answer is armed, paused or reset: a gate decision that
        // arrives after a bump is stale (career router gate, spec 2026-10-13).
        this.answerEpoch = 0;

        // Career context (spec 2026-10-11): the module (replaceable in tests),
        // the last answered personal/company question for follow-ups, and the
        // interviewer's company once named in the session. Reset per session.
        this.career = careerContext;
        this.careerPrev = null;
        this.activeCompany = null;
        // The interviewer's last segment ({ text, ts }): the router reads it as
        // the start of a question the STT split (R19).
        this.lastThemTurn = null;

        // Which live lanes run (spec 2026-10-12-live-features-toggle): 'both',
        // 'answer' or 'insights'. Set by listenService at session start and
        // when the user changes it in Settings.
        this.liveFeatures = DEFAULT_LIVE_FEATURES;

        // Where each answer is kept for later review (spec 2026-10-13-live-answer-history):
        // the app DB, resolved on first use; replaceable in tests.
        this.liveAnswers = null;
    }

    setCallbacks({ onAnalysisComplete, onStatusUpdate }) {
        this.onAnalysisComplete = onAnalysisComplete;
        this.onStatusUpdate = onStatusUpdate;
    }

    setSessionId(sessionId) {
        this.currentSessionId = sessionId;
    }

    /**
     * Live features FR-005/FR-006: a lane that is off makes no LLM call from
     * the next turn on. Turning Answer off also stops the question pending or
     * streaming now (D5). Logs the mode name only.
     */
    setLiveFeatures(mode) {
        const wasAnswering = answerEnabled(this.liveFeatures);
        this.liveFeatures = normalizeLiveFeatures(mode);
        console.log(`[Live] features=${this.liveFeatures}`);
        if (wasAnswering && !answerEnabled(this.liveFeatures)) {
            this.pauseLiveAnswer();
        }
    }

    sendToRenderer(channel, data) {
        const { windowPool } = require('../../../window/windowManager');
        const listenWindow = windowPool?.get('listen');
        
        if (listenWindow && !listenWindow.isDestroyed()) {
            listenWindow.webContents.send(channel, data);
        }
    }

    /**
     * FR-006/FR-008/FR-009/FR-010 — thin streaming orchestrator.
     * Resolves the model, consumes the SSE stream (two-arg createStreamingLLM),
     * applies the streaming-aware PASSIVE prefix-buffer before render,
     * emits live-answer-update on each non-suppressed delta.
     *
     * @param {string[]} conversationTexts
     * @param {AbortSignal} [signal] — from the in-flight AbortController
     * @returns {Promise<{answer:string,ts:number}|null>}
     */
    async makeLiveAnswer(conversationTexts, signal, meta = {}) {
        if (!conversationTexts || conversationTexts.length === 0) return null;

        // id is constant for this answer's whole stream; question is the
        // triggering them: turn. Both ride on every live-answer-update so the
        // renderer can build an in-session history (newest-first).
        const answerId = meta.id != null ? meta.id : Date.now();
        const question = meta.question || '';
        // The caller's history record (spec 2026-10-13-live-answer-history): filled
        // here with the model, the first token and how the answer ended.
        const rec = meta.record || null;
        // Career context (career FR-014): used only when it carries a block. With
        // no block (feature off, general route, nothing found) the messages are
        // byte-identical to today's (career SC-005). Its note titles ride on
        // this answer's payloads as `sources` (career FR-015).
        const career = meta.career && meta.career.block ? meta.career : null;
        const extra = career && Array.isArray(career.sources) && career.sources.length ? { sources: career.sources } : {};

        const recent = this.formatConversationForPrompt(conversationTexts, 30);
        const basePrompt = getSystemPrompt('pickle_glass_analysis', career?.block || '', false);
        const systemPrompt = basePrompt.replace('{{CONVERSATION_HISTORY}}', recent);

        // The turn that asked, quoted: with several unanswered questions in the
        // transcript and more in the notes' titles, models sometimes answered an
        // earlier one (live eval q038, q084).
        const asked = String((rec && rec.turn) || question || '').trim();
        // Not on the candidate's own work: "então você liderou a migração, certo?" asks.
        const route = meta.career && meta.career.route;
        const check = endsWithConfirmationCheck(asked) && route !== 'personal' && route !== 'ambiguous';
        if (check) laDebug('[live-answer] turn ends with a confirmation check — one-line rule added');
        const messages = [
            { role: 'system', content: systemPrompt },
            {
                role: 'user',
                content:
                    (asked ? `The interviewer's most recent question, their last turn in the transcript: "${asked}"` + '\n\n' : '') +
                    'Answer the interviewer\'s most recent question directly and concisely. ' +
                    'Start with a short headline answer (one sentence). ' +
                    'When there are supporting points, format them as a markdown bullet list ' +
                    '(each point on its own line beginning with "- "). ' +
                    'Do not fabricate bullets for a trivial one-line answer. ' +
                    answerLanguageRule(asked) +
                    'keeping technical terms as they are commonly said. ' +
                    'If there is no clear question or nothing useful to answer, reply EXACTLY: PASSIVE' +
                    (check ? `\n\n${CONFIRMATION_CHECK_RULE}` : '') +
                    (career && career.addendum ? `\n\n${career.addendum}` : ''),
            },
        ];

        // Model resolution (C1/FR-008)
        const modelInfo = await modelStateService.getCurrentModelInfo('llm');
        if (!modelInfo || !modelInfo.apiKey) {
            throw new Error('AI model or API key is not configured.');
        }
        // [diagnostic] confirms model resolved — provider/model only, never the apiKey or answer
        laDebug(`[live-answer] makeLiveAnswer streaming via ${modelInfo.provider}/${modelInfo.model}`);
        if (rec) rec.model = String(modelInfo.model || '').split(',')[0].trim() || null;

        // TWO-ARG createStreamingLLM (C1/FR-008 — NOT createLLM single-arg)
        const llm = createStreamingLLM(modelInfo.provider, {
            apiKey: modelInfo.apiKey,
            model: modelInfo.model,
            keys: modelInfo.keys,
            temperature: 0.7,
            maxTokens: 900,
            usePortkey: modelInfo.provider === 'openai-glass',
            portkeyVirtualKey: modelInfo.provider === 'openai-glass' ? modelInfo.apiKey : undefined,
        });

        const response = await llm.streamChat(messages);
        const reader = response.body.getReader();
        // Cancel right away on abort (a newer question replaced this one) instead of
        // waiting for the next chunk; for Gemini this also aborts the HTTP request.
        signal?.addEventListener('abort', () => reader.cancel().catch(() => {}), { once: true });
        const decoder = new TextDecoder();

        let fullResponse = '';
        let hadFallback = false;
        let finalModel = null;
        // A "Trying <model>…" status was shown for this answer; cleared when it ends.
        let sentRetrying = false;

        // Streaming-aware PASSIVE prefix-buffer (C2/FR-010)
        let prefixBuffer = '';
        let prefixDecided = false;
        let passiveSuppressed = false;

        try {
            while (true) {
                if (signal && signal.aborted) break;
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split('\n');

                for (const line of lines) {
                    if (signal && signal.aborted) break;
                    const parsed = parseLiveAnswerSseLine(line);
                    if (!parsed) continue;

                    if (parsed.done) {
                        // Stream complete
                        this.lastAnswerTs = Date.now();
                        break;
                    }
                    if (parsed.reset) {
                        // _reset sentinel: discard + mark fallback, and tell the panel
                        // which model is being tried (status only, never answer text)
                        fullResponse = '';
                        hadFallback = true;
                        prefixBuffer = '';
                        prefixDecided = false;
                        passiveSuppressed = false;
                        this.sendToRenderer('live-answer-update', {
                            id: answerId,
                            question,
                            status: 'retrying',
                            model: parsed.nextModel,
                            ts: Date.now(),
                        });
                        sentRetrying = true;
                        continue;
                    }
                    if (parsed.finalModel) {
                        finalModel = parsed.finalModel;
                        if (rec) rec.model = finalModel;
                        continue;
                    }
                    if (parsed.delta) {
                        if (!prefixDecided) {
                            // Accumulate prefix buffer until first \n or ~16 chars
                            prefixBuffer += parsed.delta;
                            const hasNewline = prefixBuffer.includes('\n');
                            if (hasNewline || prefixBuffer.length >= 16) {
                                prefixDecided = true;
                                const decision = parseAnswerOrPassive(prefixBuffer);
                                if (decision.passive) {
                                    laDebug('[live-answer] prefix → PASSIVE — suppressing, holding last answer');
                                    passiveSuppressed = true;
                                    // Suppress — emit nothing, hold last answer
                                    break;
                                } else {
                                    laDebug('[live-answer] prefix → ANSWER — flushing first token to renderer');
                                    // Flush the buffered prefix as first emit
                                    fullResponse += decision.flush;
                                    if (rec && rec.firstTokenAt == null) rec.firstTokenAt = Date.now();
                                    this.sendToRenderer('live-answer-update', {
                                        id: answerId,
                                        question,
                                        answer: fullResponse,
                                        ts: Date.now(),
                                        ...extra,
                                    });
                                }
                            }
                            // still accumulating prefix
                        } else {
                            // Normal streaming after prefix committed
                            fullResponse += parsed.delta;
                            this.sendToRenderer('live-answer-update', {
                                id: answerId,
                                question,
                                answer: fullResponse,
                                ts: Date.now(),
                                ...extra,
                            });
                        }
                    }
                }
            }
        } finally {
            reader.cancel().catch(() => {});
            // Clear "Trying <model>…" whatever happened next (answer, PASSIVE,
            // replaced by a newer question, or an error the caller reports).
            if (sentRetrying) this.sendToRenderer('live-answer-update', { id: answerId, status: 'idle', ts: Date.now() });
        }

        // Stream ended before the prefix-buffer reached its decision threshold
        // (answer shorter than ~16 chars with no newline) — decide + flush now
        // so terse answers ("42", "Yes, it is.") are not silently dropped.
        if (!prefixDecided && prefixBuffer && !(signal && signal.aborted)) {
            const decision = parseAnswerOrPassive(prefixBuffer);
            if (decision.passive) {
                passiveSuppressed = true;
            } else if (decision.flush) {
                fullResponse += decision.flush;
                if (rec && rec.firstTokenAt == null) rec.firstTokenAt = Date.now();
                this.sendToRenderer('live-answer-update', { id: answerId, question, answer: fullResponse, ts: Date.now(), ...extra });
            }
        }

        if (rec) {
            rec.answer = fullResponse;
            rec.status = signal && signal.aborted ? 'replaced' : passiveSuppressed ? 'passive' : fullResponse ? 'answer' : 'empty';
        }
        if (passiveSuppressed) return null;
        if (!fullResponse) {
            laDebug('[live-answer] stream ended with no answer content');
            if (!(signal && signal.aborted)) {
                this.sendToRenderer('live-answer-update', {
                    id: answerId,
                    question,
                    status: 'error',
                    error: 'The model returned an empty response.',
                    ts: Date.now(),
                });
            }
            return null;
        }

        // [diagnostic] char count only — never the answer body
        const streamedChars = fullResponse.length;
        laDebug(`[live-answer] answer stream complete — ${streamedChars} chars emitted to renderer`);
        this.hadFallback = hadFallback;
        const ts = Date.now();

        // Live check (career FR-021): numbers and known names the answer states
        // but nothing the model was given contains ride on one last payload as
        // `unverified`, and the panel marks them.
        if (career && !(signal && signal.aborted) && this.career && typeof this.career.checkAnswer === 'function') {
            let unverified = [];
            try {
                unverified = this.career.checkAnswer(fullResponse, career, `${question}\n${recent}`) || [];
            } catch {
                /* the check never blocks an answer */
            }
            if (unverified.length) {
                if (rec) rec.unverified = unverified;
                this.sendToRenderer('live-answer-update', { id: answerId, question, answer: fullResponse, ts, ...extra, unverified });
            }
        }
        return { answer: fullResponse, ts };
    }

    /**
     * FR-001/FR-003/FR-004/FR-005/FR-012 — gate + debounce for live answer.
     * Called from addConversationTurn beside triggerAnalysisIfNeeded (additive).
     *
     * Gates (in order):
     * 1. Speaker gate: only 'them' triggers (FR-001)
     * 2. Question heuristic: shouldTriggerAnswer (FR-002/FR-004). A them turn
     *    with no question form asks the career router (Jev) when it is on, and
     *    is armed when the answer comes back personal or company
     * 3. 800ms debounce: re-set on each new 'them:' turn so multi-segment
     *    questions coalesce into a single trigger (FR-003)
     * 4. De-dup + abort-or-suppress in the debounce callback (FR-004)
     */
    triggerAnswerIfNeeded(speaker, text) {
        // Live features FR-007: Answer off → no company detection, prefetch or call.
        if (!answerEnabled(this.liveFeatures)) return;
        const fromThem = typeof speaker === 'string' && speaker.toLowerCase() === 'them';
        // Career FR-011: the interviewer's company is the first one named in a
        // them turn (CAREER_KB_COMPANY, when set, wins inside the module).
        if (fromThem && !this.activeCompany) {
            try {
                const company = this.career.detectCompany(text);
                if (company) {
                    this.activeCompany = company;
                    laDebug('[live-answer] active company detected from the conversation');
                }
            } catch {
                /* the career module is optional */
            }
        }

        // R19: the interviewer's segment before this one goes to the router with
        // it (the router keeps it only when recent). A backchannel does not
        // replace it: it begins no question.
        let before = null;
        if (fromThem) {
            before = this.lastThemTurn;
            if (!isBackchannel(text)) this.lastThemTurn = { text, ts: Date.now() };
        }

        // R19: an acknowledgment or filler ("Aham.", "Hã?") wants no answer and
        // costs no Jev call (shouldTriggerAnswer rejects it on the regex path too).
        if (fromThem && isBackchannel(text)) {
            laDebug(`[live-answer] trigger gate: speaker=${speaker} backchannel → willTrigger=false`);
            return;
        }

        // Career FR-007 with Jev (spec 2026-10-13): a them turn with no question
        // form ("your biggest weakness") waits for the Jev route instead of the
        // regex cue. Questions keep the synchronous path below.
        if (fromThem && !isLikelyQuestion(text) && this.careerGateUsesJev()) {
            this.gateWithCareerRouter(text, before);
            return;
        }

        const willTrigger = shouldTriggerAnswer(speaker, text, this.lastAnsweredTail, this.inFlight, t => this.career.hasCareerCue(t));
        // [diagnostic] trigger-gate trace — decision metadata only, never answer text
        laDebug(`[live-answer] trigger gate: speaker=${speaker} likelyQuestion=${isLikelyQuestion(text)} inFlight=${this.inFlight} → willTrigger=${willTrigger}`);
        if (!willTrigger) return;
        this.armAnswer(text, before);
    }

    /**
     * The career module's session for a turn: the follow-up state, the
     * interviewer's company, and the interviewer's segment before this turn
     * when there is one (R19).
     */
    careerSession(before) {
        const session = { prev: this.careerPrev, activeCompany: this.activeCompany };
        if (before) session.before = before;
        return session;
    }

    careerGateUsesJev() {
        try {
            return typeof this.career.gateUsesJev === 'function' && this.career.gateUsesJev() === true;
        } catch {
            return false;
        }
    }

    /** The router's asks thresholds ({ min, veto }), or null (R19). */
    careerAskPolicy() {
        try {
            const p = typeof this.career.askPolicy === 'function' ? this.career.askPolicy() : null;
            return p && Number.isFinite(p.min) && Number.isFinite(p.veto) ? p : null;
        } catch {
            return null;
        }
    }

    /** R19: false only when Jev answered that the turn wants no answer. */
    async careerWantsAnswer(text, before) {
        try {
            if (typeof this.career.wantsAnswer !== 'function') return true;
            return (await this.career.wantsAnswer(text, this.careerSession(before))) !== false;
        } catch {
            return true;
        }
    }

    /**
     * The gate for a statement-form them turn when the career router uses Jev.
     * Arms the answer when the route is personal or company and Jev's asks is
     * at or above the policy's min (R19: "Mas aí no caso," reads as a
     * follow-up but asks nothing), unless a newer question was armed (or the
     * session reset or paused) while Jev answered. The career module falls
     * back to the regex by itself on a timeout or error; a regex decision has
     * no asks and arms on its route alone.
     */
    gateWithCareerRouter(text, before) {
        const epoch = this.answerEpoch;
        let pending;
        try {
            pending = Promise.resolve(this.career.classifyTurn(text, this.careerSession(before)));
        } catch {
            return;
        }
        pending
            .then(decision => {
                if (epoch !== this.answerEpoch || !answerEnabled(this.liveFeatures)) {
                    laDebug('[live-answer] trigger gate (router): superseded — dropped');
                    return;
                }
                const policy = this.careerAskPolicy();
                const asks = decision && typeof decision.asks === 'number' ? decision.asks : null;
                const asksOk = asks === null || !policy || asks >= policy.min;
                const cue = !!decision && (decision.route === 'personal' || decision.route === 'company') && asksOk;
                const willTrigger = shouldTriggerAnswer('them', text, this.lastAnsweredTail, this.inFlight, () => cue);
                const src = decision ? (decision.fallback ? `regex(${decision.fallback})` : decision.source) : '-';
                const asksNote = asks === null ? '' : ` asks=${asks.toFixed(2)}`;
                laDebug(`[live-answer] trigger gate (router): route=${decision ? decision.route : '-'} src=${src}${asksNote} inFlight=${this.inFlight} → willTrigger=${willTrigger}`);
                if (willTrigger) this.armAnswer(text, before);
            })
            .catch(() => {
                /* the career module is optional */
            });
    }

    /** Prefetch and (re)arm the 800 ms debounce for an accepted turn (FR-003). */
    armAnswer(text, before = null) {
        this.answerEpoch++;
        const epoch = this.answerEpoch;

        // Career FR-009: start the route call and the query embedding now so
        // they are ready when the debounce fires (no-ops while the module is disabled).
        try {
            this.career.prefetch(text, this.careerSession(before));
        } catch {
            /* the career module is optional */
        }

        // (Re)set debounce timer — coalesces multi-segment questions
        if (this.answerDebounceTimer) {
            clearTimeout(this.answerDebounceTimer);
            this.answerDebounceTimer = null;
        }

        laDebug('[live-answer] trigger accepted — debounce armed (800ms)');
        this.answerDebounceTimer = setTimeout(async () => {
            this.answerDebounceTimer = null;

            // FR-012 race guard: bail if session was reset before timer fired
            if (this.conversationHistory.length === 0) {
                laDebug('[live-answer] debounce fired but conversationHistory empty — bail (FR-012)');
                return;
            }
            laDebug('[live-answer] debounce fired — starting answer generation');

            const currentTail = normalizeTail(text);

            // De-dup: same normalized tail already answered
            if (this.lastAnsweredTail !== null && currentTail === this.lastAnsweredTail) return;

            // R19: with Jev on, a turn Jev says wants no answer (an
            // acknowledgment ending in "?", a monologue with a rhetorical
            // question) is dropped here, before it costs an LLM call or
            // replaces the answer on screen. The wait is the route call the
            // context reuses, at most the resolve budget.
            if (this.careerGateUsesJev()) {
                const wanted = await this.careerWantsAnswer(text, before);
                if (epoch !== this.answerEpoch) {
                    laDebug('[live-answer] debounce: superseded while Jev answered — dropped');
                    return;
                }
                if (!wanted) {
                    laDebug('[live-answer] debounce: Jev says no answer wanted — dropped');
                    return;
                }
            }

            // Abort-and-replace: new question while in-flight
            if (this.inFlight && this.inFlightController) {
                this.inFlightController.abort();
                this.inFlightController = null;
                this.inFlight = false;
            }

            // Record tail at debounce-fire time (same-question-in-flight suppression)
            this.lastAnsweredTail = currentTail;
            this.inFlight = true;
            const controller = new AbortController();
            this.inFlightController = controller;
            const signal = controller.signal;

            // New id per accepted answer — the renderer keys its history on this.
            const answerId = ++this.answerSeq;
            const question = extractQuestion(text);
            // What the history keeps of this answer (spec 2026-10-13-live-answer-history).
            const record = { sessionId: this.currentSessionId, askedAt: Date.now(), turn: text, question, status: null };

            try {
                // Career context is resolved after the controller exists, so a newer
                // question or a session reset can cancel this answer meanwhile (career E22).
                const career = await this.resolveCareerContext(text, question, before);
                if (career) {
                    record.route = career.route || null;
                    record.routeSource = career.routeFallback ? `regex(${career.routeFallback})` : career.routeSource || null;
                    record.cue = career.cue || null;
                    record.sources = Array.isArray(career.sources) ? career.sources : [];
                }
                if (signal.aborted) return;
                // Follow-ups stick only to the last answered personal/company question (career FR-006, E17).
                this.careerPrev = career && (career.route === 'personal' || career.route === 'company')
                    ? { route: career.route, queryTerms: career.queryTerms || [], anchorText: career.anchorText || '', ts: Date.now() }
                    : null;
                await this.makeLiveAnswer(this.conversationHistory, signal, { id: answerId, question, career, record });
            } catch (err) {
                if (signal.aborted) {
                    // Expected control flow on abort-and-replace — swallow (FR-009)
                    return;
                }
                record.status = 'error';
                record.error = err.userMessage || err.message || 'Unknown error';
                // Non-abort stream error: log trigger info (NEVER log answer text)
                console.error('[live-answer] stream error (trigger retained):', err.message);
                // Retain last rendered answer; show why this question got none
                // (Gemini errors carry a short userMessage, e.g. "All Gemini models failed …").
                this.sendToRenderer('live-answer-update', {
                    id: answerId,
                    question,
                    status: 'error',
                    error: err.userMessage || err.message || 'Unknown error',
                    ts: Date.now(),
                });
            } finally {
                // A newer question may own the lane by now (abort-and-replace);
                // only clear the state this answer set.
                if (this.inFlightController === controller) {
                    this.inFlight = false;
                    this.inFlightController = null;
                }
                if (!record.status || signal.aborted) record.status = 'replaced';
                if (record.firstTokenAt != null) record.firstTokenMs = record.firstTokenAt - record.askedAt;
                record.totalMs = Date.now() - record.askedAt;
                this.saveLiveAnswer(record);
            }
        }, 800);
    }

    /**
     * Keeps one answer in the local history (spec 2026-10-13-live-answer-history).
     * Never throws and never logs the text: a failed write costs the row, not the answer.
     */
    saveLiveAnswer(record) {
        if (!record || !record.sessionId) return;
        try {
            if (!this.liveAnswers) this.liveAnswers = liveAnswerRepository();
            this.liveAnswers.save(record);
        } catch (err) {
            console.error('[live-answer] history row not saved:', err && err.message ? err.message : err);
        }
    }

    /**
     * Career context for the turn that fired the debounce (career FR-014).
     * The module is total and returns null while disabled; the guard keeps any
     * failure from blocking the answer (career FR-017).
     */
    async resolveCareerContext(text, question, before = null) {
        try {
            return await this.career.getCareerContext(text, { ...this.careerSession(before), question });
        } catch {
            return null;
        }
    }

    addConversationTurn(speaker, text) {
        const conversationText = `${speaker.toLowerCase()}: ${text.trim()}`;
        this.conversationHistory.push(conversationText);
        console.log(`💬 Added conversation text: ${conversationText}`);
        console.log(`📈 Total conversation history: ${this.conversationHistory.length} texts`);

        // Trigger analysis if needed
        this.triggerAnalysisIfNeeded();
        // Trigger live answer if needed (additive — beside triggerAnalysisIfNeeded)
        this.triggerAnswerIfNeeded(speaker, text);
    }

    getConversationHistory() {
        return this.conversationHistory;
    }

    /**
     * Live features D5 — Answer turned off mid-session: clears the debounce
     * timer and aborts the in-flight stream (the abort-and-replace path), so
     * no more answer text is sent. Unlike resetLiveAnswer it keeps the session
     * memory (last answered question, career follow-up, company), so turning
     * Answer back on later in the call carries on from there.
     */
    pauseLiveAnswer() {
        if (this.answerDebounceTimer) {
            clearTimeout(this.answerDebounceTimer);
            this.answerDebounceTimer = null;
        }
        if (this.inFlightController) {
            this.inFlightController.abort();
            this.inFlightController = null;
        }
        this.inFlight = false;
        this.answerEpoch++;
    }

    /**
     * FR-011 — clears the debounce timer, aborts the in-flight stream, and
     * resets all answer-lane state. MUST be called before resetConversationHistory
     * clears the history (C4/D4).
     */
    resetLiveAnswer() {
        // Clear debounce timer
        if (this.answerDebounceTimer) {
            clearTimeout(this.answerDebounceTimer);
            this.answerDebounceTimer = null;
        }
        // Abort in-flight stream
        if (this.inFlightController) {
            this.inFlightController.abort();
            this.inFlightController = null;
        }
        // Clear state
        this.lastAnsweredTail = null;
        this.inFlight = false;
        this.hadFallback = false;
        this.lastAnswerTs = 0;
        this.careerPrev = null;
        this.activeCompany = null;
        this.lastThemTurn = null;
        this.answerEpoch++;
        console.log('[live-answer] resetLiveAnswer — debounce cleared, in-flight aborted');
    }

    resetConversationHistory() {
        // Reset answer lane BEFORE clearing history (FR-011, C4/D4)
        this.resetLiveAnswer();
        this.conversationHistory = [];
        this.previousAnalysisResult = null;
        this.analysisHistory = [];
        console.log('🔄 Conversation history and analysis state reset');
    }

    /**
     * Converts conversation history into text to include in the prompt.
     * @param {Array<string>} conversationTexts - Array of conversation texts ["me: ~~~", "them: ~~~", ...]
     * @param {number} maxTurns - Maximum number of recent turns to include
     * @returns {string} - Formatted conversation string for the prompt
     */
    formatConversationForPrompt(conversationTexts, maxTurns = 30) {
        if (conversationTexts.length === 0) return '';
        return conversationTexts.slice(-maxTurns).join('\n');
    }

    async makeOutlineAndRequests(conversationTexts, maxTurns = 30) {
        console.log(`🔍 makeOutlineAndRequests called - conversationTexts: ${conversationTexts.length}`);

        if (conversationTexts.length === 0) {
            console.log('⚠️ No conversation texts available for analysis');
            return null;
        }

        const recentConversation = this.formatConversationForPrompt(conversationTexts, maxTurns);

        // 이전 분석 결과를 프롬프트에 포함
        let contextualPrompt = '';
        if (this.previousAnalysisResult) {
            contextualPrompt = `
Previous Analysis Context:
- Main Topic: ${this.previousAnalysisResult.topic.header}
- Key Points: ${this.previousAnalysisResult.summary.slice(0, 3).join(', ')}
- Last Actions: ${this.previousAnalysisResult.actions.slice(0, 2).join(', ')}

Please build upon this context while analyzing the new conversation segments.
`;
        }

        const basePrompt = getSystemPrompt('pickle_glass_analysis', '', false);
        const systemPrompt = basePrompt.replace('{{CONVERSATION_HISTORY}}', recentConversation);

        try {
            if (this.currentSessionId) {
                await sessionRepository.touch(this.currentSessionId);
            }

            const modelInfo = await modelStateService.getCurrentModelInfo('llm');
            if (!modelInfo || !modelInfo.apiKey) {
                throw new Error('AI model or API key is not configured.');
            }
            console.log(`🤖 Sending analysis request to ${modelInfo.provider} using model ${modelInfo.model}`);
            
            const messages = [
                {
                    role: 'system',
                    content: systemPrompt,
                },
                {
                    role: 'user',
                    content: `${contextualPrompt}

Analyze the conversation and provide a structured summary. Format your response as follows:

**Summary Overview**
- Main discussion point with context

**Key Topic: [Topic Name]**
- First key insight
- Second key insight
- Third key insight

**Extended Explanation**
Provide 2-3 sentences explaining the context and implications.

**Suggested Questions**
1. First follow-up question?
2. Second follow-up question?
3. Third follow-up question?

Keep all points concise and build upon previous analysis if provided.`,
                },
            ];

            console.log('🤖 Sending analysis request to AI...');

            const llm = createLLM(modelInfo.provider, {
                apiKey: modelInfo.apiKey,
                model: modelInfo.model,
                keys: modelInfo.keys,
                temperature: 0.7,
                maxTokens: 1024,
                usePortkey: modelInfo.provider === 'openai-glass',
                portkeyVirtualKey: modelInfo.provider === 'openai-glass' ? modelInfo.apiKey : undefined,
            });

            const completion = await llm.chat(messages);

            const responseText = completion.content;
            console.log(`✅ Analysis response received: ${responseText}`);
            const structuredData = this.parseResponseText(responseText, this.previousAnalysisResult);

            if (this.currentSessionId) {
                try {
                    summaryRepository.saveSummary({
                        sessionId: this.currentSessionId,
                        text: responseText,
                        tldr: structuredData.summary.join('\n'),
                        bullet_json: JSON.stringify(structuredData.topic.bullets),
                        action_json: JSON.stringify(structuredData.actions),
                        model: modelInfo.model
                    });
                } catch (err) {
                    console.error('[DB] Failed to save summary:', err);
                }
            }

            // 분석 결과 저장
            this.previousAnalysisResult = structuredData;
            this.analysisHistory.push({
                timestamp: Date.now(),
                data: structuredData,
                conversationLength: conversationTexts.length,
            });

            if (this.analysisHistory.length > 10) {
                this.analysisHistory.shift();
            }

            return structuredData;
        } catch (error) {
            console.error('❌ Error during analysis generation:', error.message);
            return this.previousAnalysisResult; // 에러 시 이전 결과 반환
        }
    }

    parseResponseText(responseText, previousResult) {
        const structuredData = {
            summary: [],
            topic: { header: '', bullets: [] },
            actions: [],
            followUps: ['✉️ Draft a follow-up email', '✅ Generate action items', '📝 Show summary'],
        };

        // 이전 결과가 있으면 기본값으로 사용
        if (previousResult) {
            structuredData.topic.header = previousResult.topic.header;
            structuredData.summary = [...previousResult.summary];
        }

        try {
            const lines = responseText.split('\n');
            let currentSection = '';
            let isCapturingTopic = false;
            let topicName = '';

            for (const line of lines) {
                const trimmedLine = line.trim();

                // 섹션 헤더 감지
                if (trimmedLine.startsWith('**Summary Overview**')) {
                    currentSection = 'summary-overview';
                    continue;
                } else if (trimmedLine.startsWith('**Key Topic:')) {
                    currentSection = 'topic';
                    isCapturingTopic = true;
                    topicName = trimmedLine.match(/\*\*Key Topic: (.+?)\*\*/)?.[1] || '';
                    if (topicName) {
                        structuredData.topic.header = topicName + ':';
                    }
                    continue;
                } else if (trimmedLine.startsWith('**Extended Explanation**')) {
                    currentSection = 'explanation';
                    continue;
                } else if (trimmedLine.startsWith('**Suggested Questions**')) {
                    currentSection = 'questions';
                    continue;
                }

                // 컨텐츠 파싱
                if (trimmedLine.startsWith('-') && currentSection === 'summary-overview') {
                    const summaryPoint = trimmedLine.substring(1).trim();
                    if (summaryPoint && !structuredData.summary.includes(summaryPoint)) {
                        // 기존 summary 업데이트 (최대 5개 유지)
                        structuredData.summary.unshift(summaryPoint);
                        if (structuredData.summary.length > 5) {
                            structuredData.summary.pop();
                        }
                    }
                } else if (trimmedLine.startsWith('-') && currentSection === 'topic') {
                    const bullet = trimmedLine.substring(1).trim();
                    if (bullet && structuredData.topic.bullets.length < 3) {
                        structuredData.topic.bullets.push(bullet);
                    }
                } else if (currentSection === 'explanation' && trimmedLine) {
                    // explanation을 topic bullets에 추가 (문장 단위로)
                    const sentences = trimmedLine
                        .split(/\.\s+/)
                        .filter(s => s.trim().length > 0)
                        .map(s => s.trim() + (s.endsWith('.') ? '' : '.'));

                    sentences.forEach(sentence => {
                        if (structuredData.topic.bullets.length < 3 && !structuredData.topic.bullets.includes(sentence)) {
                            structuredData.topic.bullets.push(sentence);
                        }
                    });
                } else if (trimmedLine.match(/^\d+\./) && currentSection === 'questions') {
                    const question = trimmedLine.replace(/^\d+\.\s*/, '').trim();
                    if (question && question.includes('?')) {
                        structuredData.actions.push(`❓ ${question}`);
                    }
                }
            }

            // 기본 액션 추가
            const defaultActions = ['✨ What should I say next?', '💬 Suggest follow-up questions'];
            defaultActions.forEach(action => {
                if (!structuredData.actions.includes(action)) {
                    structuredData.actions.push(action);
                }
            });

            // 액션 개수 제한
            structuredData.actions = structuredData.actions.slice(0, 5);

            // 유효성 검증 및 이전 데이터 병합
            if (structuredData.summary.length === 0 && previousResult) {
                structuredData.summary = previousResult.summary;
            }
            if (structuredData.topic.bullets.length === 0 && previousResult) {
                structuredData.topic.bullets = previousResult.topic.bullets;
            }
        } catch (error) {
            console.error('❌ Error parsing response text:', error);
            // 에러 시 이전 결과 반환
            return (
                previousResult || {
                    summary: [],
                    topic: { header: 'Analysis in progress', bullets: [] },
                    actions: ['✨ What should I say next?', '💬 Suggest follow-up questions'],
                    followUps: ['✉️ Draft a follow-up email', '✅ Generate action items', '📝 Show summary'],
                }
            );
        }

        console.log('📊 Final structured data:', JSON.stringify(structuredData, null, 2));
        return structuredData;
    }

    /**
     * Triggers analysis when conversation history reaches 5 texts.
     */
    async triggerAnalysisIfNeeded() {
        // Live features FR-008: Insights off → no analysis call and no summary saved (D10).
        if (!insightsEnabled(this.liveFeatures)) return;
        if (this.conversationHistory.length >= 5 && this.conversationHistory.length % 5 === 0) {
            console.log(`Triggering analysis - ${this.conversationHistory.length} conversation texts accumulated`);

            const data = await this.makeOutlineAndRequests(this.conversationHistory);
            if (data) {
                console.log('Sending structured data to renderer');
                this.sendToRenderer('summary-update', data);
                
                // Notify callback
                if (this.onAnalysisComplete) {
                    this.onAnalysisComplete(data);
                }
            } else {
                console.log('No analysis data returned');
            }
        }
    }

    getCurrentAnalysisData() {
        return {
            previousResult: this.previousAnalysisResult,
            history: this.analysisHistory,
            conversationLength: this.conversationHistory.length,
        };
    }
}

module.exports = SummaryService;

// Export pure helpers for unit testing (FR-018/C6).
module.exports.isLikelyQuestion = isLikelyQuestion;
module.exports.normalizePassive = normalizePassive;
module.exports.parseAnswerOrPassive = parseAnswerOrPassive;
module.exports.shouldTriggerAnswer = shouldTriggerAnswer;
module.exports.normalizeTail = normalizeTail;
module.exports.parseLiveAnswerSseLine = parseLiveAnswerSseLine;
module.exports.extractQuestion = extractQuestion;
module.exports.CONFIRMATION_CHECK_RULE = CONFIRMATION_CHECK_RULE;

const { BrowserWindow } = require('electron');
const { getSystemPrompt } = require('../../common/prompts/promptBuilder.js');
const { createLLM, createStreamingLLM } = require('../../common/ai/factory');
const sessionRepository = require('../../common/repositories/session');
const summaryRepository = require('./repositories');
const modelStateService = require('../../common/services/modelStateService');

// Verbose live-answer trace logging — gated behind LIVE_ANSWER_DEBUG=1 so it
// stays out of normal runs but can be re-enabled for diagnosis. NEVER logs the
// answer body (safety invariant) — only gate decisions, counts, and provider.
const LIVE_ANSWER_DEBUG = process.env.LIVE_ANSWER_DEBUG === '1' || process.env.LIVE_ANSWER_DEBUG === 'true';
function laDebug(...args) {
    if (LIVE_ANSWER_DEBUG) console.log(...args);
}

// ---------------------------------------------------------------------------
// Pure helper: isLikelyQuestion (FR-002)
// Recall-oriented: true when text ends with '?' OR starts with a question
// opener (case-insensitive). When uncertain, favor true — PASSIVE suppresses.
// ---------------------------------------------------------------------------
// Balanced, quota-aware question gate (FR-002).
//
// Triggers when the turn carries a real question SIGNAL, and skips the
// interviewer's declarative monologue so we don't spend LLM calls (and the
// daily quota) on talk that isn't a question. Catches ~every real question;
// the only by-design gap is a cue-less statement-form prompt ("your biggest
// weakness"). PASSIVE still suppresses any false trigger.
//
// A turn triggers when ANY of these holds:
//   1. a '?' appears anywhere (STT usually punctuates questions)
//   2. an imperative/interview cue appears (design, compare, give me, ...)
//   3. an embedded/indirect question appears ("...the question is what...")
//   4. a wh-word or yes/no auxiliary LEADS any clause (after peeling leading
//      discourse markers, so "okay so how does X" counts)
// Otherwise it is treated as declarative monologue and skipped.

// wh-words + yes/no auxiliaries/modals that lead an interrogative clause.
const CLAUSE_LEAD_RE =
    /^(?:what|how|why|when|where|which|who|whom|whose|whether|is|are|am|was|were|do|does|did|can|could|would|will|should|shall|may|might|have|has|had|must)\b/i;
// Discourse markers / fillers that can precede the real clause start.
const LEAD_STRIP_RE =
    /^(?:so|and|but|now|well|okay|ok|alright|right|um|uh|er|like|you know|i mean|then|yeah|no|oh|hmm)\b[\s,]*/i;
// Imperative / interview cues — a strong question signal anywhere in the turn.
const CONTENT_CUE_RE = new RegExp(
    '\\b(?:tell me|tell us|walk me|walk us|walk through|give me|give us|show me|' +
    'show us|describe|explain|compare|contrast|define|design|implement|write|' +
    'build|create|solve|optimi[sz]e|refactor|debug|consider|suppose|imagine|' +
    'assume|elaborate|outline|discuss|go over|step through|reason about|' +
    'think about|talk about|what about|how about|what if|let\'s say|lets say|' +
    'name (?:a|an|some|the)|list (?:a|an|some|the|out)|your thoughts|any thoughts|' +
    'your take|thoughts on|difference between|pros and cons|trade-?offs)\\b',
    'i'
);
// Indirect / embedded question: a copula or asking-verb followed by a wh-word.
const EMBEDDED_Q_RE =
    /\b(?:is|are|was|were|wonder|wondering|curious|know|asking|ask|want(?:ed)? to know|looking at|question is)\s+(?:what|how|why|when|where|which|who|whether|if)\b/i;

function isLikelyQuestion(text) {
    if (typeof text !== 'string') return false;
    const trimmed = text.trim();
    if (trimmed.length === 0) return false;

    if (trimmed.includes('?')) return true;            // 1. explicit question mark
    if (CONTENT_CUE_RE.test(trimmed)) return true;     // 2. imperative/interview cue
    if (EMBEDDED_Q_RE.test(trimmed)) return true;      // 3. embedded/indirect question

    // 4. wh-word / auxiliary leading any clause (peel leading discourse markers
    //    so "okay so how does X work" still counts).
    for (const clause of trimmed.split(/[.!?;,\n]+/)) {
        let c = clause.trim();
        let prev;
        do { prev = c; c = c.replace(LEAD_STRIP_RE, '').trim(); } while (c !== prev);
        if (CLAUSE_LEAD_RE.test(c)) return true;
    }

    // 5. No question signal — declarative monologue; skip to save quota (PASSIVE
    //    would have suppressed it anyway). Cue-less statement-form prompts are
    //    the known by-design gap (FR-002 / EDGE_CASES).
    return false;
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
// Pure helper: shouldTriggerAnswer (FR-001 + FR-004)
// Decision-only: does not manage debounce or abort — orchestrator does that.
// Returns false when:
//   - speaker is not 'them' (case-insensitive mic gate)
//   - text is not a likely question
//   - normalized tail equals lastAnsweredTail (de-dup same question)
// Returns true otherwise (including when inFlight with new tail — the caller
// is responsible for aborting the in-flight request).
// ---------------------------------------------------------------------------
function normalizeTail(text) {
    if (!text) return '';
    return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

function shouldTriggerAnswer(speaker, text, lastAnsweredTail, inFlight) {
    // Speaker gate
    if (typeof speaker !== 'string' || speaker.toLowerCase() !== 'them') return false;
    // Question heuristic
    if (!isLikelyQuestion(text)) return false;
    // De-dup: same normalized tail as last answered
    const tail = normalizeTail(text);
    if (lastAnsweredTail !== null && lastAnsweredTail !== undefined && tail === lastAnsweredTail) return false;
    return true;
}

// ---------------------------------------------------------------------------
// Pure helper: parseLiveAnswerSseLine (FR-009)
// Extracted SSE line parser — mirrors askService._processStream sentinel
// handling WITHOUT importing askService (FR-017 — CLOSED set).
// Returns:
//   { done: true }                — on "[DONE]"
//   { reset: true }               — on _reset sentinel
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

    if (json._reset) return { reset: true };
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
    }

    setCallbacks({ onAnalysisComplete, onStatusUpdate }) {
        this.onAnalysisComplete = onAnalysisComplete;
        this.onStatusUpdate = onStatusUpdate;
    }

    setSessionId(sessionId) {
        this.currentSessionId = sessionId;
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

        const recent = this.formatConversationForPrompt(conversationTexts, 30);
        const basePrompt = getSystemPrompt('pickle_glass_analysis', '', false);
        const systemPrompt = basePrompt.replace('{{CONVERSATION_HISTORY}}', recent);

        const messages = [
            { role: 'system', content: systemPrompt },
            {
                role: 'user',
                content:
                    'Answer the interviewer\'s most recent question directly and concisely. ' +
                    'If there is no clear question or nothing useful to answer, reply EXACTLY: PASSIVE',
            },
        ];

        // Model resolution (C1/FR-008)
        const modelInfo = await modelStateService.getCurrentModelInfo('llm');
        if (!modelInfo || !modelInfo.apiKey) {
            throw new Error('AI model or API key is not configured.');
        }
        // [diagnostic] confirms model resolved — provider/model only, never the apiKey or answer
        laDebug(`[live-answer] makeLiveAnswer streaming via ${modelInfo.provider}/${modelInfo.model}`);

        // TWO-ARG createStreamingLLM (C1/FR-008 — NOT createLLM single-arg)
        const llm = createStreamingLLM(modelInfo.provider, {
            apiKey: modelInfo.apiKey,
            model: modelInfo.model,
            temperature: 0.7,
            maxTokens: 900,
            usePortkey: modelInfo.provider === 'openai-glass',
            portkeyVirtualKey: modelInfo.provider === 'openai-glass' ? modelInfo.apiKey : undefined,
        });

        const response = await llm.streamChat(messages);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        let fullResponse = '';
        let hadFallback = false;
        let finalModel = null;

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
                        // _reset sentinel: discard + mark fallback
                        fullResponse = '';
                        hadFallback = true;
                        prefixBuffer = '';
                        prefixDecided = false;
                        passiveSuppressed = false;
                        continue;
                    }
                    if (parsed.finalModel) {
                        finalModel = parsed.finalModel;
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
                                    this.sendToRenderer('live-answer-update', {
                                        id: answerId,
                                        question,
                                        answer: fullResponse,
                                        ts: Date.now(),
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
                            });
                        }
                    }
                }
            }
        } finally {
            reader.cancel().catch(() => {});
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
                this.sendToRenderer('live-answer-update', { id: answerId, question, answer: fullResponse, ts: Date.now() });
            }
        }

        if (passiveSuppressed) return null;
        if (!fullResponse) {
            laDebug('[live-answer] stream ended with no answer content');
            return null;
        }

        // [diagnostic] char count only — never the answer body
        const streamedChars = fullResponse.length;
        laDebug(`[live-answer] answer stream complete — ${streamedChars} chars emitted to renderer`);
        this.hadFallback = hadFallback;
        const ts = Date.now();
        return { answer: fullResponse, ts };
    }

    /**
     * FR-001/FR-003/FR-004/FR-005/FR-012 — gate + debounce for live answer.
     * Called from addConversationTurn beside triggerAnalysisIfNeeded (additive).
     *
     * Gates (in order):
     * 1. Speaker gate: only 'them' triggers (FR-001)
     * 2. Question heuristic: shouldTriggerAnswer (FR-002/FR-004)
     * 3. 800ms debounce: re-set on each new 'them:' turn so multi-segment
     *    questions coalesce into a single trigger (FR-003)
     * 4. De-dup + abort-or-suppress in the debounce callback (FR-004)
     */
    triggerAnswerIfNeeded(speaker, text) {
        const willTrigger = shouldTriggerAnswer(speaker, text, this.lastAnsweredTail, this.inFlight);
        // [diagnostic] trigger-gate trace — decision metadata only, never answer text
        laDebug(`[live-answer] trigger gate: speaker=${speaker} likelyQuestion=${isLikelyQuestion(text)} inFlight=${this.inFlight} → willTrigger=${willTrigger}`);
        if (!willTrigger) return;

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

            // Abort-and-replace: new question while in-flight
            if (this.inFlight && this.inFlightController) {
                this.inFlightController.abort();
                this.inFlightController = null;
                this.inFlight = false;
            }

            // Record tail at debounce-fire time (same-question-in-flight suppression)
            this.lastAnsweredTail = currentTail;
            this.inFlight = true;
            this.inFlightController = new AbortController();
            const signal = this.inFlightController.signal;

            // New id per accepted answer — the renderer keys its history on this.
            const answerId = ++this.answerSeq;

            try {
                await this.makeLiveAnswer(this.conversationHistory, signal, { id: answerId, question: text });
            } catch (err) {
                if (signal.aborted) {
                    // Expected control flow on abort-and-replace — swallow (FR-009)
                    return;
                }
                // Non-abort stream error: log trigger info (NEVER log answer text)
                console.error('[live-answer] stream error (trigger retained):', err.message);
                // Retain last rendered answer — no emit
            } finally {
                this.inFlight = false;
                this.inFlightController = null;
            }
        }, 800);
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
const { BrowserWindow } = require('electron');
const { createStreamingLLM } = require('../common/ai/factory');
// Lazy require helper to avoid circular dependency issues
const getWindowManager = () => require('../../window/windowManager');
const internalBridge = require('../../bridge/internalBridge');

const getWindowPool = () => {
    try {
        return getWindowManager().windowPool;
    } catch {
        return null;
    }
};

const sessionRepository = require('../common/repositories/session');
const askRepository = require('./repositories');
const { buildAskMessages, formatConversationForAsk, askUserText } = require('./askPrompt');
const liveDesignState = require('./liveDesign');
const { resolveLiveRequest, classifyKitAnswer } = liveDesignState;
const { askAnswerLanguage } = require('./askLanguage');
const { normalizeLiveFeatures, answerEnabled } = require('../listen/liveFeatures');
const settingsService = require('../settings/settingsService');
const path = require('node:path');
const fs = require('node:fs');
const os = require('os');
const util = require('util');
const execFile = util.promisify(require('child_process').execFile);
const { desktopCapturer } = require('electron');
const modelStateService = require('../common/services/modelStateService');
const { initialAskStreamState, applyAskSseEvent } = require('./askStreamState');

// Try to load sharp, but don't fail if it's not available
let sharp;
try {
    sharp = require('sharp');
    console.log('[AskService] Sharp module loaded successfully');
} catch (error) {
    console.warn('[AskService] Sharp module not available:', error.message);
    console.warn('[AskService] Screenshot functionality will work with reduced image processing capabilities');
    sharp = null;
}
let lastScreenshot = null;

// System Design · Live v1 (future-work 18.11).
const SD_LIVE = 'system_design_live';
/** Two empty sends within this window count as one (rule 3). */
const SD_DEDUP_MS = 300;
/** Ask hides at the end of a 250 ms fade (windowManager.js); a key in that time does nothing (rule 3). */
const ASK_CLOSING_MS = 400;
const NOTICE_KIT_BUSY = 'A kit is still being written. Close Ask to cancel it.';
const NOTICE_LIVE_ANSWER_OFF = 'Live Answer is off (Live panels: Insights only): the interviewer\'s questions won\'t be answered.';

/**
 * The Listen transcript ("me: …" / "them: …"), for System Design · Live. Read
 * lazily: listenService never requires askService, so there is no cycle.
 * @returns {string[]}
 */
function listenTranscript() {
    try {
        const turns = require('../listen/listenService').getConversationHistory();
        return Array.isArray(turns) ? turns.slice() : [];
    } catch (err) {
        console.warn('[AskService] Listen transcript unavailable:', err.message);
        return [];
    }
}

async function captureScreenshot(options = {}) {
    if (process.platform === 'darwin') {
        try {
            const tempPath = path.join(os.tmpdir(), `screenshot-${Date.now()}.jpg`);

            await execFile('screencapture', ['-x', '-t', 'jpg', tempPath]);

            const imageBuffer = await fs.promises.readFile(tempPath);
            await fs.promises.unlink(tempPath);

            if (sharp) {
                try {
                    // Try using sharp for optimal image processing
                    const resizedBuffer = await sharp(imageBuffer)
                        .resize({ height: 384 })
                        .jpeg({ quality: 80 })
                        .toBuffer();

                    const base64 = resizedBuffer.toString('base64');
                    const metadata = await sharp(resizedBuffer).metadata();

                    lastScreenshot = {
                        base64,
                        width: metadata.width,
                        height: metadata.height,
                        timestamp: Date.now(),
                    };

                    return { success: true, base64, width: metadata.width, height: metadata.height };
                } catch (sharpError) {
                    console.warn('Sharp module failed, falling back to basic image processing:', sharpError.message);
                }
            }
            
            // Fallback: Return the original image without resizing
            console.log('[AskService] Using fallback image processing (no resize/compression)');
            const base64 = imageBuffer.toString('base64');
            
            lastScreenshot = {
                base64,
                width: null, // We don't have metadata without sharp
                height: null,
                timestamp: Date.now(),
            };

            return { success: true, base64, width: null, height: null };
        } catch (error) {
            console.error('Failed to capture screenshot:', error);
            return { success: false, error: error.message };
        }
    }

    try {
        const sources = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: {
                width: 1920,
                height: 1080,
            },
        });

        if (sources.length === 0) {
            throw new Error('No screen sources available');
        }
        const source = sources[0];
        const buffer = source.thumbnail.toJPEG(70);
        const base64 = buffer.toString('base64');
        const size = source.thumbnail.getSize();

        return {
            success: true,
            base64,
            width: size.width,
            height: size.height,
        };
    } catch (error) {
        console.error('Failed to capture screenshot using desktopCapturer:', error);
        return {
            success: false,
            error: error.message,
        };
    }
}

/**
 * @class
 * @description
 */
class AskService {
    constructor() {
        this.abortController = null;
        this.state = {
            isVisible: false,
            isLoading: false,
            isStreaming: false,
            currentQuestion: '',
            currentResponse: '',
            retryingWith: null,
            errorMessage: '',
            showTextInput: true,
            notice: '',
        };
        // System Design · Live (18.11): the mode and the stored kit, shared with
        // the answer lane; replaceable in tests.
        this.liveDesign = liveDesignState;
        // The request holding rule 4's check while it works out what it asks for
        // (a token), the kit request being written (its token), the time of the
        // last send in the mode (rule 3's de-dup) and the end of a closing fade.
        this._sdLock = null;
        this._kitInFlight = null;
        this._lastSdSendAt = 0;
        this._askClosingUntil = 0;
        console.log('[AskService] Service instance created.');
    }

    /** One line in Ask under the answer (18.11): a hint, a refusal, a warning. */
    _showNotice(text) {
        this.state.notice = text;
        this._broadcastState();
    }

    /**
     * Ask was closed or hidden (18.11 rule 3): a key during the closing fade
     * does nothing, and in System Design · Live the box is cleared.
     */
    _markAskClosing() {
        this._askClosingUntil = Date.now() + ASK_CLOSING_MS;
        if (this.liveDesign.isSdLive()) this._clearAskInput();
    }

    _clearAskInput() {
        const askWindow = getWindowPool()?.get('ask');
        if (askWindow && !askWindow.isDestroyed()) askWindow.webContents.send('ask:clearInput');
    }

    /** 18.11 rule 3: entering System Design · Live clears text typed in another mode. */
    onEnterSdLive() {
        this._clearAskInput();
    }

    _broadcastState() {
        const askWindow = getWindowPool()?.get('ask');
        if (askWindow && !askWindow.isDestroyed()) {
            askWindow.webContents.send('ask:stateUpdate', this.state);
        }
    }

    async toggleAskButton(inputScreenOnly = false) {
        const askWindow = getWindowPool()?.get('ask');
        const sdLive = this.liveDesign.isSdLive();
        // A fixed line per key in System Design · Live, read by npm run practice:sd-live.
        const keyLog = (what) => { if (sdLive) console.log(`[SD Live] key: ${inputScreenOnly ? 'Ctrl+Enter' : 'Ask button'} → ${what}`); };

        // 18.11 rule 3: Ask still shows during its closing fade; a key then does
        // nothing, so Esc followed at once by Ctrl+Enter never sends.
        if (sdLive && askWindow && askWindow.isVisible() && Date.now() < this._askClosingUntil) {
            keyLog('ignored, Ask is closing');
            return;
        }

        let shouldSendScreenOnly = false;
        if (inputScreenOnly && this.state.showTextInput && askWindow && askWindow.isVisible()) {
            // 18.11 rule 3: in System Design · Live the second press sends what is
            // in the box, through the Ask window, as Enter does.
            if (sdLive) {
                keyLog('send the box');
                if (!askWindow.isDestroyed()) askWindow.webContents.send('ask:sendFromBox');
                return;
            }
            shouldSendScreenOnly = true;
            await this.sendMessage('', []);
            return;
        }

        const hasContent = this.state.isLoading || this.state.isStreaming || (this.state.currentResponse && this.state.currentResponse.length > 0) || !!this.state.errorMessage;

        if (askWindow && askWindow.isVisible() && hasContent) {
            this.state.showTextInput = !this.state.showTextInput;
            keyLog(this.state.showTextInput ? 'show the box over the answer' : 'hide the box');
            this._broadcastState();
        } else {
            if (askWindow && askWindow.isVisible()) {
                keyLog('hide Ask');
                internalBridge.emit('window:requestVisibility', { name: 'ask', visible: false });
                this.state.isVisible = false;
                this._markAskClosing();
            } else {
                keyLog('show Ask');
                console.log('[AskService] Showing hidden Ask window');
                internalBridge.emit('window:requestVisibility', { name: 'ask', visible: true });
                this.state.isVisible = true;
                this._askClosingUntil = 0;
            }
            if (this.state.isVisible) {
                this.state.showTextInput = true;
                this._broadcastState();
            }
        }
    }

    async closeAskWindow () {
            if (this.abortController) {
                this.abortController.abort('Window closed by user');
                this.abortController = null;
            }
            // 18.11 rule 4: closing cancels a kit being written; nothing is stored,
            // and the next request may start at once.
            if (this.liveDesign.isSdLive()) {
                console.log(`[SD Live] close Ask${this._kitInFlight ? ' — the kit being written is cancelled' : ''}`);
            }
            this._kitInFlight = null;

            this.state = {
                isVisible      : false,
                isLoading      : false,
                isStreaming    : false,
                currentQuestion: '',
                currentResponse: '',
                retryingWith   : null,
                errorMessage   : '',
                showTextInput  : true,
                notice         : '',
            };
            this._broadcastState();

            internalBridge.emit('window:requestVisibility', { name: 'ask', visible: false });
            this._markAskClosing();

            return { success: true };
        }
    

    /**
     * 
     * @param {string[]} conversationTexts
     * @returns {string}
     * @private
     */
    _formatConversationForPrompt(conversationTexts) {
        return formatConversationForAsk(conversationTexts);
    }

    /**
     * 
     * @param {string} userPrompt
     * @returns {Promise<{success: boolean, response?: string, error?: string}>}
     */
    async sendMessage(userPrompt, conversationHistoryRaw=[]) {
        // 18.11 rule 10: the mode, read once from memory for the whole request.
        const askMode = this.liveDesign.getAskMode();
        if (askMode === SD_LIVE) return this._sendLiveDesign(userPrompt, conversationHistoryRaw);
        return this._send(userPrompt, conversationHistoryRaw, { askMode });
    }

    /**
     * An Ask send in System Design · Live (future-work 18.11). Before any wait:
     * rule 3's de-dup and rule 4's check. Then the stored kit decides what the
     * send asks for (rules 1 and 2). A hint or a refusal writes nothing to the DB
     * and leaves the answer on screen.
     * @param {string} typed - the box's text
     * @param {string[]} [conversationHistoryRaw] - a transcript the caller passes, else Listen's
     */
    async _sendLiveDesign(typed, conversationHistoryRaw = []) {
        const empty = !String(typed || '').trim();
        const now = Date.now();
        if (empty && now - this._lastSdSendAt < SD_DEDUP_MS) {
            console.log('[SD Live] ask: a second empty send within 300 ms — dropped');
            return { success: false, deduped: true };
        }
        this._lastSdSendAt = now;
        if (this._kitInFlight) {
            console.log('[SD Live] ask: refused — a kit is still being written');
            this._showNotice(NOTICE_KIT_BUSY);
            return { success: false, refused: true };
        }
        if (this._sdLock) {
            console.log('[SD Live] ask: refused — another send is starting');
            return { success: false, refused: true };
        }

        const token = {};
        this._sdLock = token;
        let resolved;
        let sessionId;
        try {
            sessionId = await sessionRepository.getOrCreateActive('ask');
            const kit = this.liveDesign.getKit(sessionId);
            resolved = resolveLiveRequest(typed, kit ? kit.kind : null);
            if (resolved.hint) {
                console.log('[SD Live] ask: hint only — the design kit is done');
                this._showNotice(resolved.hint);
                return { success: false, hint: true };
            }
            if (resolved.kitRequest) this._kitInFlight = token;
        } catch (error) {
            return this._failRequest(error);
        } finally {
            if (this._sdLock === token) this._sdLock = null;
        }

        console.log(`[SD Live] ask: send '${String(typed || '').trim().slice(0, 30)}' → '${resolved.send.slice(0, 30)}' (kit request: ${resolved.kitRequest || 'no'})`);
        try {
            return await this._send(resolved.send, conversationHistoryRaw, { askMode: SD_LIVE, sessionId, kitRequest: resolved.kitRequest });
        } finally {
            if (this._kitInFlight === token) this._kitInFlight = null;
        }
    }

    /** The error state and line every failed request shows. */
    _failRequest(error) {
        console.error('[AskService] Error during message processing:', error);
        this.state = {
            ...this.state,
            isLoading: false,
            isStreaming: false,
            retryingWith: null,
            errorMessage: error.userMessage || error.message || 'Unknown error occurred',
            showTextInput: true,
        };
        this._broadcastState();

        const askWin = getWindowPool()?.get('ask');
        if (askWin && !askWin.isDestroyed()) {
            const streamError = error.message || 'Unknown error occurred';
            askWin.webContents.send('ask-response-stream-error', { error: streamError });
        }

        return { success: false, error: error.message };
    }

    /**
     * @param {string} userPrompt - what is sent (in System Design · Live, the resolved request)
     * @param {string[]} conversationHistoryRaw
     * @param {{ askMode: string, sessionId?: number|string, kitRequest?: 'opening'|'design'|null }} o
     */
    async _send(userPrompt, conversationHistoryRaw, { askMode: requestMode, sessionId: knownSessionId = null, kitRequest = null }) {
        const sdLive = requestMode === SD_LIVE;
        internalBridge.emit('window:requestVisibility', { name: 'ask', visible: true });
        this.state = {
            ...this.state,
            isLoading: true,
            isStreaming: false,
            currentQuestion: userPrompt,
            currentResponse: '',
            responseModel: null,
            responseHadFallback: false,
            retryingWith: null,
            errorMessage: '',
            showTextInput: false,
            notice: '',
        };
        this._broadcastState();

        if (this.abortController) {
            this.abortController.abort('New request received.');
        }
        this.abortController = new AbortController();
        const { signal } = this.abortController;


        let sessionId;

        try {
            console.log(`[AskService] 🤖 Processing message: ${userPrompt.substring(0, 50)}...`);

            sessionId = knownSessionId != null ? knownSessionId : await sessionRepository.getOrCreateActive('ask');
            await askRepository.addAiMessage({ sessionId, role: 'user', content: userPrompt.trim() });
            console.log(`[AskService] DB: Saved user prompt to session ${sessionId}`);
            
            const modelInfo = await modelStateService.getCurrentModelInfo('llm');
            if (!modelInfo || !modelInfo.apiKey) {
                throw new Error('AI model or API key not configured.');
            }
            console.log(`[AskService] Using model: ${modelInfo.model} for provider: ${modelInfo.provider}`);

            const screenshotResult = await captureScreenshot({ quality: 'medium' });
            const screenshotBase64 = screenshotResult.success ? screenshotResult.base64 : null;

            // The code language from settings. The mode was read once from memory
            // when the request started (18.11 rule 10), so the checks and the
            // prompt never see two modes.
            const currentSettings = await settingsService.getSettings();

            // System Design · Live also sees the Listen transcript and the kit
            // stored in this session; every other mode gets the prompt it got
            // before. Every mode answers in the interview's language, the STT
            // language setting (rule 11, askLanguage.js).
            let historyRaw = conversationHistoryRaw;
            let previousAnswer = null;
            const { language: answerLanguage, source: languageSource } = askAnswerLanguage({ sttLanguage: currentSettings.sttLanguage });
            console.log(`[AskService] answer language: ${answerLanguage} (${languageSource})`);
            if (sdLive) {
                if (!historyRaw || historyRaw.length === 0) historyRaw = listenTranscript();
                const kit = this.liveDesign.getKit(sessionId);
                if (kit) previousAnswer = { question: kit.question, answer: kit.answer };
                // 18.11: without Live Answer the interviewer's questions get no probe.
                if (kitRequest && !answerEnabled(normalizeLiveFeatures(currentSettings.liveFeatures)) && this.abortController?.signal === signal) {
                    this._showNotice(NOTICE_LIVE_ANSWER_OFF);
                }
            }
            const conversationHistory = this._formatConversationForPrompt(historyRaw);

            // Prompt and messages: askPrompt.js (the live eval builds the same ones).
            const { askMode, profile, systemPrompt, messages } = buildAskMessages({
                askMode: requestMode,
                userPrompt,
                conversationHistory,
                preferredCodeLanguage: currentSettings.preferredCodeLanguage,
                screenshotBase64,
                previousAnswer,
                answerLanguage,
            });
            console.log(`[AskService] askMode='${askMode}', profile='${profile}'`);

            const streamingLLM = createStreamingLLM(modelInfo.provider, {
                apiKey: modelInfo.apiKey,
                model: modelInfo.model,
                keys: modelInfo.keys,
                temperature: 0.7,
                usePortkey: modelInfo.provider === 'openai-glass',
                portkeyVirtualKey: modelInfo.provider === 'openai-glass' ? modelInfo.apiKey : undefined,
            });

            try {
                const response = await streamingLLM.streamChat(messages);
                // 18.11: a request replaced or closed while the model was called
                // stops here, instead of streaming out of sight into the DB.
                if (sdLive && signal.aborted) {
                    response.body?.getReader?.().cancel().catch(() => {});
                    return { success: false, aborted: true };
                }
                const askWin = getWindowPool()?.get('ask');

                if (!askWin || askWin.isDestroyed()) {
                    console.error("[AskService] Ask window is not available to send stream to.");
                    response.body.getReader().cancel();
                    return { success: false, error: 'Ask window is not available.' };
                }

                const reader = response.body.getReader();
                signal.addEventListener('abort', () => {
                    console.log(`[AskService] Aborting stream reader. Reason: ${signal.reason}`);
                    reader.cancel(signal.reason).catch(() => { /* 이미 취소된 경우의 오류는 무시 */ });
                });

                await this._processStream(reader, askWin, sessionId, signal, { askMode, userPrompt, kitRequest });
                return { success: true };

            } catch (multimodalError) {
                // 멀티모달 요청이 실패했고 스크린샷이 포함되어 있다면 텍스트만으로 재시도
                if (screenshotBase64 && this._isMultimodalError(multimodalError)) {
                    console.log(`[AskService] Multimodal request failed, retrying with text-only: ${multimodalError.message}`);
                    
                    // 텍스트만으로 메시지 재구성
                    const textOnlyMessages = [
                        { role: 'system', content: systemPrompt },
                        {
                            role: 'user',
                            content: askUserText(userPrompt, answerLanguage, askMode)
                        }
                    ];

                    const fallbackResponse = await streamingLLM.streamChat(textOnlyMessages);
                    if (sdLive && signal.aborted) {
                        fallbackResponse.body?.getReader?.().cancel().catch(() => {});
                        return { success: false, aborted: true };
                    }
                    const askWin = getWindowPool()?.get('ask');

                    if (!askWin || askWin.isDestroyed()) {
                        console.error("[AskService] Ask window is not available for fallback response.");
                        fallbackResponse.body.getReader().cancel();
                        return { success: false, error: 'Ask window is not available.' };
                    }

                    const fallbackReader = fallbackResponse.body.getReader();
                    signal.addEventListener('abort', () => {
                        console.log(`[AskService] Aborting fallback stream reader. Reason: ${signal.reason}`);
                        fallbackReader.cancel(signal.reason).catch(() => {});
                    });

                    await this._processStream(fallbackReader, askWin, sessionId, signal, { askMode, userPrompt, kitRequest });
                    return { success: true };
                } else {
                    // 다른 종류의 에러이거나 스크린샷이 없었다면 그대로 throw
                    throw multimodalError;
                }
            }

        } catch (error) {
            return this._failRequest(error);
        }
    }

    /**
     * 
     * @param {ReadableStreamDefaultReader} reader
     * @param {BrowserWindow} askWin
     * @param {number} sessionId 
     * @param {AbortSignal} signal
     * @param {{ askMode?: string, userPrompt?: string, kitRequest?: 'opening'|'design'|null }} [meta] - a complete System Design · Live kit is kept for the next question
     * @returns {Promise<void>}
     * @private
     */
    async _processStream(reader, askWin, sessionId, signal, meta = {}) {
        const decoder = new TextDecoder();
        // isLoading stays true until the first token (see askStreamState.js), so the
        // window keeps showing "Thinking..." while models fail over or think.
        let stream = initialAskStreamState();
        let failed = false;
        // A newer request (or closing the window) replaces this.abortController;
        // from then on this stream must not touch the shared state.
        const ownsState = () => this.abortController?.signal === signal;

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value);
                const lines = chunk.split('\n').filter(line => line.trim() !== '');

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.substring(6);
                        if (data === '[DONE]') {
                            return;
                        }
                        let json;
                        try {
                            json = JSON.parse(data);
                        } catch {
                            continue;
                        }
                        const next = applyAskSseEvent(stream, json);
                        if (next === stream) continue;
                        stream = next;
                        if (!ownsState()) continue;
                        this.state.currentResponse = stream.fullResponse;
                        this.state.isLoading = stream.isLoading;
                        this.state.isStreaming = stream.isStreaming;
                        this.state.responseModel = stream.responseModel;
                        this.state.responseHadFallback = stream.responseHadFallback;
                        this.state.retryingWith = stream.retryingWith;
                        this._broadcastState();
                    }
                }
            }
        } catch (streamError) {
            if (signal.aborted) {
                console.log(`[AskService] Stream reading was intentionally cancelled. Reason: ${signal.reason}`);
            } else {
                failed = true;
                console.error('[AskService] Error while processing stream:', streamError);
                if (ownsState()) {
                    this.state.errorMessage = streamError.userMessage || streamError.message || 'Unknown error occurred';
                }
                if (askWin && !askWin.isDestroyed()) {
                    askWin.webContents.send('ask-response-stream-error', { error: streamError.message });
                }
            }
        } finally {
            const fullResponse = stream.fullResponse;
            // Only a complete kit (opening, design or full) is kept: a deep dive or a
            // probe answer must not replace the design the next question builds on.
            // Its type: the headings, else the kit the request asked for (18.11 rule 5).
            if (meta.askMode === SD_LIVE && !failed && !signal.aborted) {
                const kind = classifyKitAnswer(fullResponse, meta.kitRequest || null);
                if (kind) this.liveDesign.storeKit({ sessionId, kind, question: meta.userPrompt, answer: fullResponse });
                console.log(kind ? `[SD Live] ask: ${kind} kit stored` : '[SD Live] ask: answer done, not a kit — nothing stored');
            } else if (meta.askMode === SD_LIVE) {
                console.log(`[SD Live] ask: ${signal.aborted ? 'cancelled' : 'failed'} — nothing stored`);
            }
            if (ownsState()) {
                this.state.isLoading = false;
                this.state.isStreaming = false;
                this.state.retryingWith = null;
                this.state.currentResponse = fullResponse;
                if (!fullResponse && !failed && !signal.aborted) {
                    this.state.errorMessage = 'The model returned an empty response.';
                }
                this._broadcastState();
            }
            if (fullResponse) {
                 try {
                    await askRepository.addAiMessage({ sessionId, role: 'assistant', content: fullResponse });
                    console.log(`[AskService] DB: Saved partial or full assistant response to session ${sessionId} after stream ended.`);
                } catch(dbError) {
                    console.error("[AskService] DB: Failed to save assistant response after stream ended:", dbError);
                }
            }
        }
    }

    /**
     * 멀티모달 관련 에러인지 판단
     * @private
     */
    _isMultimodalError(error) {
        const errorMessage = error.message?.toLowerCase() || '';
        return (
            errorMessage.includes('vision') ||
            errorMessage.includes('image') ||
            errorMessage.includes('multimodal') ||
            errorMessage.includes('unsupported') ||
            errorMessage.includes('image_url') ||
            errorMessage.includes('400') ||  // Bad Request often for unsupported features
            errorMessage.includes('invalid') ||
            errorMessage.includes('not supported')
        );
    }

}

const askService = new AskService();

module.exports = askService;
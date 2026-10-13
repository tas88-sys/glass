'use strict';

// One Ask request as askService.sendMessage makes it, minus the window, the DB
// and the screen capture: the messages from askPrompt.buildAskMessages, the
// real provider chain with the options askService passes, the stream read the
// way askService._processStream reads it (per chunk, applyAskSseEvent), and
// askService's text-only retry when a request with a screenshot fails with
// what it takes for a multimodal error. The image is the fixture's JPEG,
// entering where the screenshot would.

const path = require('node:path');
const { inAskContext } = require('./harness');

const SRC = path.join(__dirname, '..', '..', 'src');
const req = p => require(path.join(SRC, p));

// askService._isMultimodalError, copied: the eval reports when it fires.
function isMultimodalError(error) {
    const m = error?.message?.toLowerCase() || '';
    return m.includes('vision') || m.includes('image') || m.includes('multimodal') || m.includes('unsupported')
        || m.includes('image_url') || m.includes('400') || m.includes('invalid') || m.includes('not supported');
}

async function readLikeAskService(response) {
    const { initialAskStreamState, applyAskSseEvent } = req('features/ask/askStreamState');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let stream = initialAskStreamState();
    let firstTokenAt = null;
    let error = null;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value);
            const lines = chunk.split('\n').filter(line => line.trim() !== '');
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.substring(6);
                if (data === '[DONE]') return { stream, firstTokenAt, error };
                let json;
                try {
                    json = JSON.parse(data);
                } catch {
                    continue;
                }
                const next = applyAskSseEvent(stream, json);
                if (next === stream) continue;
                if (!firstTokenAt && next.fullResponse) firstTokenAt = Date.now();
                stream = next;
            }
        }
    } catch (err) {
        error = err.userMessage || err.message;
    }
    return { stream, firstTokenAt, error };
}

/**
 * @param {object} o
 * @param {string} o.tag - report id
 * @param {string} o.mode - askMode
 * @param {string} o.userPrompt
 * @param {string[]} o.history - Listen transcript lines ("them: …")
 * @param {string} [o.preferredCodeLanguage]
 * @param {{ base64: string }|null} o.image
 * @param {() => object} o.llmInfo - harness.setupModels().llmInfo
 */
async function runAsk({ tag, mode, userPrompt, history, preferredCodeLanguage, image, llmInfo }) {
    const { buildAskMessages, formatConversationForAsk } = req('features/ask/askPrompt');
    const factory = req('features/common/ai/factory');
    const harness = require('./harness');

    const built = buildAskMessages({
        askMode: mode,
        userPrompt,
        conversationHistory: formatConversationForAsk(history),
        preferredCodeLanguage,
        screenshotBase64: image ? image.base64 : null,
    });
    const info = llmInfo();
    if (!info || !info.apiKey) throw new Error('no LLM configured');

    const startedAt = Date.now();
    const callsBefore = harness.calls.length;
    const llm = factory.createStreamingLLM(info.provider, {
        apiKey: info.apiKey,
        model: info.model,
        keys: info.keys,
        temperature: 0.7,
        usePortkey: info.provider === 'openai-glass',
        portkeyVirtualKey: info.provider === 'openai-glass' ? info.apiKey : undefined,
    });

    const out = { tag, mode: built.askMode, profile: built.profile, withImage: !!image, startedAt, firstTokenAt: null, endAt: null, text: '', responseModel: null, hadFallback: false, error: null, textOnlyRetry: false, calls: [] };
    await inAskContext(tag, async () => {
        let response;
        try {
            response = await llm.streamChat(built.messages);
        } catch (err) {
            if (image && isMultimodalError(err)) {
                // askService retries without the screenshot: the answer is then blind.
                out.textOnlyRetry = true;
                out.firstError = err.userMessage || err.message;
                const textOnly = [{ role: 'system', content: built.systemPrompt }, { role: 'user', content: `User Request: ${userPrompt.trim()}` }];
                try {
                    response = await llm.streamChat(textOnly);
                } catch (err2) {
                    out.error = err2.userMessage || err2.message;
                    return;
                }
            } else {
                out.error = err.userMessage || err.message;
                return;
            }
        }
        const r = await readLikeAskService(response);
        out.text = r.stream.fullResponse;
        out.responseModel = r.stream.responseModel;
        out.hadFallback = r.stream.responseHadFallback;
        out.firstTokenAt = r.firstTokenAt;
        if (r.error) out.error = r.error;
    });
    out.endAt = Date.now();
    out.calls = harness.calls.slice(callsBefore).map(c => ({ provider: c.provider, hasImage: c.hasImage, finalModel: c.finalModel, resets: c.resets, error: c.error }));
    return out;
}

module.exports = { runAsk, isMultimodalError };

const { ipcMain, BrowserWindow } = require('electron');
const { createStreamingLLM } = require('../../common/ai/factory');
const { getStoredApiKey, getStoredProvider, getCurrentModelInfo, windowPool, captureScreenshot } = require('../../electron/windowManager');
const authService = require('../../common/services/authService');
const sessionRepository = require('../../common/repositories/session');
const askRepository = require('./repositories');
const { getSystemPrompt } = require('../../common/prompts/promptBuilder');

function formatConversationForPrompt(conversationTexts) {
    if (!conversationTexts || conversationTexts.length === 0) return 'No conversation history available.';
    return conversationTexts.slice(-30).join('\n');
}

// Access conversation history via the global listenService instance created in index.js
function getConversationHistory() {
    const listenService = global.listenService;
    return listenService ? listenService.getConversationHistory() : [];
}

async function sendMessage(userPrompt) {
    if (!userPrompt || userPrompt.trim().length === 0) {
        console.warn('[AskService] Cannot process empty message');
        return { success: false, error: 'Empty message' };
    }
    
    const askWindow = windowPool.get('ask');
    if (askWindow && !askWindow.isDestroyed()) {
        askWindow.webContents.send('hide-text-input');
    }

    try {
        console.log(`[AskService] 🤖 Processing message: ${userPrompt.substring(0, 50)}...`);

        const modelInfo = await getCurrentModelInfo(null, { type: 'llm' });
        if (!modelInfo || !modelInfo.apiKey) {
            throw new Error('AI model or API key not configured.');
        }
        console.log(`[AskService] Using model: ${modelInfo.model} for provider: ${modelInfo.provider}`);

        const screenshotResult = await captureScreenshot({ quality: 'medium' });
        const screenshotBase64 = screenshotResult.success ? screenshotResult.base64 : null;

        const conversationHistoryRaw = getConversationHistory();
        const conversationHistory = formatConversationForPrompt(conversationHistoryRaw);

        const systemPrompt = getSystemPrompt('pickle_glass_analysis', conversationHistory, false);


        const messages = [
            { role: 'system', content: systemPrompt },
            {
                role: 'user',
                content: [
                    { type: 'text', text: `User Request: ${userPrompt.trim()}` },
                ],
            },
        ];

        if (screenshotBase64) {
            messages[1].content.push({
                type: 'image_url',
                image_url: { url: `data:image/jpeg;base64,${screenshotBase64}` },
            });
        }
        
        const streamingLLM = createStreamingLLM(modelInfo.provider, {
            apiKey: modelInfo.apiKey,
            model: modelInfo.model,
            temperature: 0.7,
            maxTokens: 2048,
            usePortkey: modelInfo.provider === 'openai-glass',
            portkeyVirtualKey: modelInfo.provider === 'openai-glass' ? modelInfo.apiKey : undefined,
        });

        const response = await streamingLLM.streamChat(messages);

        // --- Stream Processing ---
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullResponse = '';

        const askWin = windowPool.get('ask');
        if (!askWin || askWin.isDestroyed()) {
            console.error("[AskService] Ask window is not available to send stream to.");
            reader.cancel();
            return;
        }

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value);
            const lines = chunk.split('\n').filter(line => line.trim() !== '');

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.substring(6);
                    if (data === '[DONE]') {
                        askWin.webContents.send('ask-response-stream-end');
                        
                        // Save to DB
                        try {
                            // The repository adapter will now handle the UID internally.
                            const sessionId = await sessionRepository.getOrCreateActive('ask');
                            await askRepository.addAiMessage({ sessionId, role: 'user', content: userPrompt.trim() });
                            await askRepository.addAiMessage({ sessionId, role: 'assistant', content: fullResponse });
                            console.log(`[AskService] DB: Saved ask/answer pair to session ${sessionId}`);
                        } catch(dbError) {
                            console.error("[AskService] DB: Failed to save ask/answer pair:", dbError);
                        }
                        
                        return { success: true, response: fullResponse };
                    }
                    try {
                        const json = JSON.parse(data);
                        const token = json.choices[0]?.delta?.content || '';
                        if (token) {
                            fullResponse += token;
                            askWin.webContents.send('ask-response-chunk', { token });
                        }
                    } catch (error) {
                        // Ignore parsing errors for now
                    }
                }
            }
        }
    } catch (error) {
        console.error('[AskService] Error processing message:', error);
        return { success: false, error: error.message };
    }
}

function initialize() {
    ipcMain.handle('ask:sendMessage', async (event, userPrompt) => {
        return sendMessage(userPrompt);
    });
    console.log('[AskService] Initialized and ready.');
}

module.exports = {
    initialize,
};
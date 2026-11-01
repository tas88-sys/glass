/**
 * askService.systemDesignLive.test.js
 *
 * The real askService.sendMessage in System Design · Live (future-work item 16)
 * and in the other modes. Electron, the window, settings, the repositories, the
 * model info, the LLM stream and Listen are replaced through require.cache
 * before askService loads; askPrompt, askStreamState and _processStream are the
 * app's own. The LLM records the system prompt it gets and streams a scripted
 * answer.
 *
 * Run: node --test src/features/ask/__tests__/askService.systemDesignLive.test.js
 */

'use strict';

const { describe, it, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Stubs, installed before askService is required
// ---------------------------------------------------------------------------

function stub(request, exports) {
    const file = require.resolve(request);
    require.cache[file] = { id: file, filename: file, loaded: true, exports };
}

const world = {
    askMode: 'system_design_live',
    sessionId: 'session-1',
    transcript: ['them: Design a URL shortener.', 'me: How many new links a day?', 'them: About 100 million, global.'],
    transcriptReads: 0,
    reply: '',
    prompts: [],
};

const fakeWindow = { isDestroyed: () => false, isVisible: () => true, webContents: { send: () => {} } };

stub('electron', {
    BrowserWindow: function BrowserWindow() {},
    desktopCapturer: { getSources: async () => [] },   // no screen: the Ask goes without a screenshot
});
stub('../../../window/windowManager', { windowPool: new Map([['ask', fakeWindow]]) });
stub('../../common/repositories/session', { getOrCreateActive: async () => world.sessionId });
stub('../repositories', { addAiMessage: async () => ({ id: 'm' }) });
stub('../../settings/settingsService', { getSettings: async () => ({ askMode: world.askMode, preferredCodeLanguage: 'go' }) });
stub('../../common/services/modelStateService', { getCurrentModelInfo: async () => ({ provider: 'groq', model: 'test-model', apiKey: 'test-key', keys: {} }) });
stub('../../listen/listenService', { getConversationHistory: () => { world.transcriptReads++; return world.transcript; } });
stub('../../common/ai/factory', {
    createStreamingLLM: () => ({
        streamChat: async (messages) => {
            world.prompts.push(messages[0].content);
            const text = world.reply;
            const encoder = new TextEncoder();
            return {
                body: new ReadableStream({
                    start(controller) {
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`));
                        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                        controller.close();
                    },
                }),
            };
        },
    }),
});

let askService;
let buildAskMessages;
let formatConversationForAsk;
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

before(() => {
    // The macOS path shells out to screencapture; the stubbed desktopCapturer path is the one under test.
    Object.defineProperty(process, 'platform', { value: 'win32' });
    for (const level of ['log', 'warn', 'error']) mock.method(console, level, () => {});
    askService = require('../askService');
    ({ buildAskMessages, formatConversationForAsk } = require('../askPrompt'));
});

after(() => {
    Object.defineProperty(process, 'platform', realPlatform);
    mock.restoreAll();
});

beforeEach(() => {
    world.askMode = 'system_design_live';
    world.sessionId = 'session-1';
    world.transcriptReads = 0;
    world.prompts = [];
    askService.lastLiveDesign = null;
});

async function ask(text, reply) {
    world.reply = reply;
    const result = await askService.sendMessage(text);
    assert.equal(result.success, true, `sendMessage failed: ${result.error}`);
    return world.prompts[world.prompts.length - 1];
}

const OPENING = '## Frame\n> We are building a URL shortener. Is that right?\n## Scope\n- **In:** users can shorten a link';
const DEEP_DIVE = '## Deep dive: cache\n- **Problem:** 1M redirects/s';
const PROBE = '> Redirects keep working from the cache.\n- replicas\nTrade-off: memory';

describe('askService in System Design · Live', () => {
    it('sends the Listen transcript and keeps the kit it answered', async () => {
        const prompt = await ask('Design a URL shortener.', OPENING);
        assert.equal(world.transcriptReads, 1);
        assert.match(prompt, /Transcript:\nthem: Design a URL shortener\.\nme: How many new links a day\?\nthem: About 100 million, global\./);
        assert.doesNotMatch(prompt, /Previous answer \(your last answer/);
        assert.deepEqual(askService.lastLiveDesign, { sessionId: 'session-1', question: 'Design a URL shortener.', answer: OPENING });
    });

    it('builds the next answer on that kit, and a deep dive or a probe does not replace it', async () => {
        await ask('Design a URL shortener.', OPENING);

        const deepDivePrompt = await ask('deep dive cache', DEEP_DIVE);
        assert.match(deepDivePrompt, /Previous answer \(your last answer in this mode, in this interview\):\nRequest: Design a URL shortener\.\n## Frame/);
        assert.equal(askService.lastLiveDesign.answer, OPENING, 'the deep dive replaced the kit');

        const probePrompt = await ask('what if the cache goes down?', PROBE);
        assert.match(probePrompt, /Request: Design a URL shortener\.\n## Frame/);
        assert.equal(askService.lastLiveDesign.answer, OPENING, 'the probe replaced the kit');
    });

    it('drops the previous kit when the session changes', async () => {
        await ask('Design a URL shortener.', OPENING);
        world.sessionId = 'session-2';
        const prompt = await ask('design', '## Requirements used\n- 100M links a day (confirmed)\n## Deep dives\n- hot links');
        assert.doesNotMatch(prompt, /Previous answer \(your last answer/);
        assert.equal(askService.lastLiveDesign.sessionId, 'session-2');
    });

    it('uses a transcript the caller passes instead of reading Listen', async () => {
        world.reply = OPENING;
        await askService.sendMessage('Design a chat app.', ['them: one region only']);
        assert.equal(world.transcriptReads, 0);
        assert.match(world.prompts[0], /Transcript:\nthem: one region only/);
    });
});

describe('askService in the other modes', () => {
    for (const mode of ['default', 'code', 'debug', 'system_design']) {
        it(`${mode}: no transcript, no previous answer, the same prompt as before`, async () => {
            askService.lastLiveDesign = { sessionId: 'session-1', question: 'Design a URL shortener.', answer: OPENING };
            world.askMode = mode;
            const prompt = await ask('Design a URL shortener.', '## 1. Clarifying Questions\n- ?');
            assert.equal(world.transcriptReads, 0, 'Listen was read');
            const expected = buildAskMessages({ askMode: mode, userPrompt: 'Design a URL shortener.', conversationHistory: formatConversationForAsk([]), preferredCodeLanguage: 'go', screenshotBase64: null });
            assert.equal(prompt, expected.systemPrompt);
            assert.equal(askService.lastLiveDesign.answer, OPENING, `${mode} replaced the System Design · Live kit`);
        });
    }
});

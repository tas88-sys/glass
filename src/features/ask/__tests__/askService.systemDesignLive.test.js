/**
 * askService.systemDesignLive.test.js
 *
 * The real askService in System Design · Live (future-work items 16 and 18.11)
 * and in the other modes. Electron, the window, settings, the repositories, the
 * model info, the LLM stream and Listen are replaced through require.cache
 * before askService loads; askPrompt, askStreamState, liveDesign and
 * _processStream are the app's own. The LLM records what it gets and streams a
 * scripted answer, held open when a test needs a kit "being written".
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

function deferred() {
    let resolve;
    const p = new Promise(r => { resolve = r; });
    return { p, resolve };
}

const world = {
    sessionId: 'session-1',
    transcript: ['them: Design a URL shortener.', 'me: How many new links a day?', 'them: About 100 million, global.'],
    transcriptReads: 0,
    reply: '',
    calls: [],          // the messages of each LLM call
    db: [],             // what askRepository saved
    modelOk: true,
    liveFeatures: 'answer',
    holdCall: null,     // streamChat waits for it before it returns
    holdStream: null,   // the stream stays open until it resolves
    visible: true,
};

const sent = [];
const fakeWindow = {
    isDestroyed: () => false,
    isVisible: () => world.visible,
    webContents: { send: (channel, data) => sent.push({ channel, data }) },
};
const windowPool = new Map([['ask', fakeWindow]]);

stub('electron', {
    BrowserWindow: function BrowserWindow() {},
    desktopCapturer: { getSources: async () => [] },   // no screen: the Ask goes without a screenshot
});
stub('../../../window/windowManager', { windowPool });
stub('../../common/repositories/session', { getOrCreateActive: async () => world.sessionId });
stub('../repositories', { addAiMessage: async m => { world.db.push(m); return { id: 'm' }; } });
stub('../../settings/settingsService', { getSettings: async () => ({ askMode: 'not-read-here', preferredCodeLanguage: 'go', liveFeatures: world.liveFeatures }) });
stub('../../common/services/modelStateService', {
    getCurrentModelInfo: async () => (world.modelOk ? { provider: 'groq', model: 'test-model', apiKey: 'test-key', keys: {} } : null),
});
stub('../../listen/listenService', { getConversationHistory: () => { world.transcriptReads++; return world.transcript; } });
stub('../../common/ai/factory', {
    createStreamingLLM: () => ({
        streamChat: async (messages) => {
            world.calls.push(messages);
            if (world.holdCall) await world.holdCall.p;
            const text = world.reply;
            const hold = world.holdStream;
            const encoder = new TextEncoder();
            return {
                body: new ReadableStream({
                    async start(controller) {
                        try {
                            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`));
                            if (hold) await hold.p;
                            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                            controller.close();
                        } catch {
                            /* canceled by the reader */
                        }
                    },
                }),
            };
        },
    }),
});

let askService;
let buildAskMessages;
let formatConversationForAsk;
let createLiveDesign;
let HINT_DESIGN_DONE;
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

before(() => {
    // The macOS path shells out to screencapture; the stubbed desktopCapturer path is the one under test.
    Object.defineProperty(process, 'platform', { value: 'win32' });
    for (const level of ['log', 'warn', 'error']) mock.method(console, level, () => {});
    askService = require('../askService');
    ({ buildAskMessages, formatConversationForAsk } = require('../askPrompt'));
    ({ createLiveDesign, HINT_DESIGN_DONE } = require('../liveDesign'));
});

after(() => {
    Object.defineProperty(process, 'platform', realPlatform);
    mock.restoreAll();
});

function setMode(mode) {
    askService.liveDesign.setAskMode(mode);
}

beforeEach(() => {
    world.sessionId = 'session-1';
    world.transcript = ['them: Design a URL shortener.', 'me: How many new links a day?', 'them: About 100 million, global.'];
    world.transcriptReads = 0;
    world.calls = [];
    world.db = [];
    world.modelOk = true;
    world.liveFeatures = 'answer';
    world.holdCall = null;
    world.holdStream = null;
    world.visible = true;
    windowPool.set('ask', fakeWindow);
    sent.length = 0;
    askService.liveDesign = createLiveDesign();
    setMode('system_design_live');
    askService.abortController = null;
    askService._sdLock = null;
    askService._kitInFlight = null;
    askService._lastSdSendAt = 0;
    askService._askClosingUntil = 0;
    askService.state = { ...askService.state, currentResponse: '', errorMessage: '', notice: '', isLoading: false, isStreaming: false, showTextInput: true };
});

const systemOf = call => call[0].content;
const userOf = call => call[1].content[0]?.text ?? call[1].content;
const lastCall = () => world.calls[world.calls.length - 1];

/** One send, past rule 3's de-dup window, that must succeed. */
async function ask(text, reply) {
    askService._lastSdSendAt = 0;
    world.reply = reply;
    const result = await askService.sendMessage(text);
    assert.equal(result.success, true, `sendMessage failed: ${JSON.stringify(result)}`);
    return lastCall();
}

const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
};

const words = n => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
const OPENING = '## Frame\n> We are building a URL shortener. Is that right?\n## Scope\n- **In:** users can shorten a link';
const DESIGN = '## Requirements used\n- 100M links a day (confirmed)\n## Design\n- **Decisions:** base62 IDs; reads from Redis.\n## Deep dives\n- **Pick:** cache hot links.';
const DEEP_DIVE = '## Deep dive: cache\n- **Problem:** 1M redirects/s';
const PROBE = '> Redirects keep working from the cache.\n- replicas\nTrade-off: memory';

describe('askService in System Design · Live: transcript and the stored kit', () => {
    it('sends the Listen transcript and keeps the kit it answered', async () => {
        const call = await ask('Design a URL shortener.', OPENING);
        assert.equal(world.transcriptReads, 1);
        assert.match(systemOf(call), /Transcript:\nthem: Design a URL shortener\.\nme: How many new links a day\?\nthem: About 100 million, global\./);
        assert.doesNotMatch(systemOf(call), /Previous answer \(your last answer/);
        const kit = askService.liveDesign.getKit('session-1');
        assert.equal(kit.kind, 'opening');
        assert.equal(kit.question, 'opening: Design a URL shortener.', 'rule 2: other text with no kit asks for its opening kit');
        assert.equal(kit.answer, OPENING);
    });

    it('builds the next answer on that kit, and a deep dive or a probe does not replace it', async () => {
        await ask('Design a URL shortener.', OPENING);

        const deepDive = await ask('deep dive cache', DEEP_DIVE);
        assert.match(systemOf(deepDive), /Previous answer \(your last answer in this mode, in this interview\):\nRequest: opening: Design a URL shortener\.\n## Frame/);
        assert.equal(userOf(deepDive).split('\n')[0], 'User Request: deep dive cache', 'other text with a kit goes as typed');
        assert.equal(askService.liveDesign.getKit('session-1').answer, OPENING, 'the deep dive replaced the kit');

        const probe = await ask('what if the cache goes down?', PROBE);
        assert.match(systemOf(probe), /Request: opening: Design a URL shortener\.\n## Frame/);
        assert.equal(askService.liveDesign.getKit('session-1').answer, OPENING, 'the probe replaced the kit');
    });

    it('drops the previous kit when the session changes', async () => {
        await ask('Design a URL shortener.', OPENING);
        world.sessionId = 'session-2';
        const call = await ask('design', DESIGN);
        assert.doesNotMatch(systemOf(call), /Previous answer \(your last answer/);
        assert.equal(askService.liveDesign.getKit('session-2').kind, 'design');
        assert.equal(askService.liveDesign.getKit('session-1'), null);
    });

    it('uses a transcript the caller passes instead of reading Listen', async () => {
        world.reply = OPENING;
        await askService.sendMessage('Design a chat app.', ['them: one region only']);
        assert.equal(world.transcriptReads, 0);
        assert.match(systemOf(world.calls[0]), /Transcript:\nthem: one region only/);
    });

    it('saves the resolved request to the DB, as sent', async () => {
        await ask('', OPENING);
        assert.deepEqual(world.db[0], { sessionId: 'session-1', role: 'user', content: 'opening' });
    });
});

describe('18.11 rule 1: an empty send', () => {
    it('opening → design → hint, with no request and the kit left on screen', async () => {
        const first = await ask('', OPENING);
        assert.equal(userOf(first).split('\n')[0], 'User Request: opening');
        assert.equal(askService.liveDesign.getKit('session-1').kind, 'opening');

        const second = await ask('   ', DESIGN);
        assert.equal(userOf(second).split('\n')[0], 'User Request: design');
        assert.equal(askService.liveDesign.getKit('session-1').kind, 'design');
        assert.equal(askService.state.currentResponse, DESIGN);

        askService._lastSdSendAt = 0;
        const calls = world.calls.length;
        const dbRows = world.db.length;
        const result = await askService.sendMessage('');
        assert.deepEqual(result, { success: false, hint: true });
        assert.equal(world.calls.length, calls, 'no LLM call');
        assert.equal(world.db.length, dbRows, 'nothing written to the DB');
        assert.equal(askService.state.notice, HINT_DESIGN_DONE);
        assert.equal(askService.state.currentResponse, DESIGN, 'the design kit stays on screen');
    });

    it('a design request answered with an opening kit is stored as one, and the next empty send asks for design again', async () => {
        await ask('', OPENING);
        await ask('', OPENING);
        assert.equal(askService.liveDesign.getKit('session-1').kind, 'opening');
        const third = await ask('', DESIGN);
        assert.equal(userOf(third).split('\n')[0], 'User Request: design');
    });

    it('a kit request with other headings is stored by the kit it asked for (rule 5)', async () => {
        await ask('', `**Frame**\n${words(130)}`);
        assert.equal(askService.liveDesign.getKit('session-1').kind, 'opening');
    });

    it('"No problem yet" is not stored, and the next empty send asks for the opening kit again', async () => {
        await ask('', "No problem yet. Type the system to design (e.g. 'design a URL shortener'), or 'design' once the requirements are agreed.");
        assert.equal(askService.liveDesign.getKit('session-1'), null);
        const again = await ask('', OPENING);
        assert.equal(userOf(again).split('\n')[0], 'User Request: opening');
    });
});

describe('18.11 rule 2: typed text', () => {
    it('fixed words are sent as fixed requests, kit or no kit', async () => {
        assert.equal(userOf(await ask('Design.', DESIGN)).split('\n')[0], 'User Request: design');
        assert.equal(userOf(await ask('opening: uber', OPENING)).split('\n')[0], 'User Request: opening: uber');
        assert.equal(askService.liveDesign.getKit('session-1').kind, 'opening', 'a new problem replaces the design kit');
        assert.equal(userOf(await ask('FULL', `${OPENING}\n${DESIGN}`)).split('\n')[0], 'User Request: full');
        assert.equal(askService.liveDesign.getKit('session-1').kind, 'design');
    });
});

describe('18.11 rules 3 and 4: keys, races and the kit being written', () => {
    it('two sends in the same moment start one request; the second is refused', async () => {
        world.reply = OPENING;
        world.holdStream = deferred();
        const a = askService.sendMessage('twitter');
        const b = askService.sendMessage('uber');
        assert.deepEqual(await b, { success: false, refused: true });
        await settle();
        assert.equal(world.calls.length, 1);
        world.holdStream.resolve();
        assert.equal((await a).success, true);
        assert.equal(askService.liveDesign.getKit('session-1').question, 'opening: twitter');
    });

    it('while a kit is written, an empty or typed request is refused with the notice, and the kit is stored', async () => {
        world.reply = OPENING;
        world.holdStream = deferred();
        const kit = askService.sendMessage('');
        await settle();
        askService._lastSdSendAt = 0;
        assert.deepEqual(await askService.sendMessage(''), { success: false, refused: true });
        assert.equal(askService.state.notice, 'A kit is still being written. Close Ask to cancel it.');
        assert.deepEqual(await askService.sendMessage('deep dive cache'), { success: false, refused: true });
        assert.equal(world.calls.length, 1);
        world.holdStream.resolve();
        assert.equal((await kit).success, true);
        assert.equal(askService.liveDesign.getKit('session-1').kind, 'opening');
        askService._lastSdSendAt = 0;
        world.reply = DESIGN;
        assert.equal((await askService.sendMessage('')).success, true, 'the flag is clear once the kit is done');
    });

    it('a request that is not a kit is replaced by a new one, as today', async () => {
        await ask('design', DESIGN);
        world.reply = DEEP_DIVE;
        world.holdStream = deferred();
        const dive = askService.sendMessage('deep dive cache');
        await settle();
        world.holdStream = null;
        const probe = await ask('what if redis goes down?', PROBE);
        assert.equal(userOf(probe).split('\n')[0], 'User Request: what if redis goes down?');
        await dive;
    });

    it('closing Ask cancels the kit being written: nothing is stored and the next request starts', async () => {
        world.reply = OPENING;
        world.holdStream = deferred();
        const kit = askService.sendMessage('');
        await settle();
        await askService.closeAskWindow();
        await kit;
        assert.equal(askService.liveDesign.getKit('session-1'), null);
        askService._lastSdSendAt = 0;
        world.holdStream = null;
        assert.equal((await askService.sendMessage('')).success, true);
        assert.equal(askService.liveDesign.getKit('session-1').kind, 'opening', 'the same step again');
    });

    it('closing while the model is called: the request stops, writes no answer, and clears the flag', async () => {
        world.reply = OPENING;
        world.holdCall = deferred();
        const kit = askService.sendMessage('');
        await settle();
        await askService.closeAskWindow();
        world.holdCall.resolve();
        assert.deepEqual(await kit, { success: false, aborted: true });
        assert.equal(world.db.filter(r => r.role === 'assistant').length, 0, 'no answer saved out of sight');
        assert.equal(askService.liveDesign.getKit('session-1'), null);
        assert.equal(askService._kitInFlight, null);
    });

    it('the flag clears when the model is not configured, and when the window is gone', async () => {
        world.modelOk = false;
        const failed = await askService.sendMessage('');
        assert.equal(failed.success, false);
        assert.equal(askService._kitInFlight, null);
        world.modelOk = true;
        windowPool.delete('ask');
        askService._lastSdSendAt = 0;
        const noWindow = await askService.sendMessage('');
        assert.equal(noWindow.success, false);
        assert.equal(askService._kitInFlight, null);
        windowPool.set('ask', fakeWindow);
        await ask('', OPENING);
    });

    it('a switch to Default while a kit is written: the Default request cancels it, nothing is stored, the flag clears', async () => {
        world.reply = OPENING;
        world.holdStream = deferred();
        const kit = askService.sendMessage('');
        await settle();
        setMode('default');
        world.holdStream = null;
        world.reply = 'An answer.';
        assert.equal((await askService.sendMessage('What is a process?')).success, true);
        await kit;
        assert.equal(askService.liveDesign.getKit('session-1'), null);
        assert.equal(askService._kitInFlight, null);
    });

    it('two empty sends within 300 ms count as one', async () => {
        world.reply = OPENING;
        const first = await askService.sendMessage('twitter');
        assert.equal(first.success, true);
        assert.deepEqual(await askService.sendMessage(''), { success: false, deduped: true });
        assert.equal(world.calls.length, 1);
    });

    it('the second Ctrl+Enter asks the Ask window to send its box, and sends nothing itself', async () => {
        askService.state.showTextInput = true;
        await askService.toggleAskButton(true);
        assert.deepEqual(sent.map(s => s.channel).filter(c => c !== 'ask:stateUpdate'), ['ask:sendFromBox']);
        assert.equal(world.calls.length, 0);
    });

    it('a key during the closing fade does nothing', async () => {
        await askService.closeAskWindow();
        sent.length = 0;
        world.visible = true;   // the fade still shows the window
        await askService.toggleAskButton(true);
        await askService.toggleAskButton(false);
        assert.deepEqual(sent, []);
        assert.equal(world.calls.length, 0);
    });

    it('closing Ask, or hiding it with the header button, clears the box', async () => {
        await askService.closeAskWindow();
        assert.ok(sent.some(s => s.channel === 'ask:clearInput'));
        sent.length = 0;
        askService._askClosingUntil = 0;
        askService.state.currentResponse = '';
        askService.state.isLoading = false;
        await askService.toggleAskButton(false);   // visible, nothing on it: hides Ask
        assert.ok(sent.some(s => s.channel === 'ask:clearInput'));
    });

    it('entering the mode clears the box', () => {
        askService.onEnterSdLive();
        assert.ok(sent.some(s => s.channel === 'ask:clearInput'));
    });
});

describe('18.11: language and Live Answer off', () => {
    it('names the interview\'s language from the interviewer\'s turns, also for a fixed word', async () => {
        world.transcript = ['them: Vamos projetar um encurtador de URL.', 'me: Quantos links por dia?', 'them: Cerca de 100 milhões, no Brasil.'];
        const call = await ask('design', DESIGN);
        assert.match(userOf(call), /^User Request: design\n\nThe interview is in Portuguese: write the whole answer in Portuguese/);
    });

    it('with Live Answer off, a kit request shows the warning and still runs', async () => {
        world.liveFeatures = 'insights';
        await ask('', OPENING);
        assert.match(askService.state.notice, /Live Answer is off/);
        assert.equal(askService.liveDesign.getKit('session-1').kind, 'opening');
    });
});

describe('askService in the other modes', () => {
    for (const mode of ['default', 'code', 'debug', 'system_design']) {
        it(`${mode}: no transcript, no previous answer, the same prompt as before, the kit kept`, async () => {
            askService.liveDesign.storeKit({ sessionId: 'session-1', kind: 'opening', question: 'opening', answer: OPENING });
            setMode(mode);
            const call = await ask('Design a URL shortener.', '## 1. Clarifying Questions\n- ?');
            assert.equal(world.transcriptReads, 0, 'Listen was read');
            const expected = buildAskMessages({ askMode: mode, userPrompt: 'Design a URL shortener.', conversationHistory: formatConversationForAsk([]), preferredCodeLanguage: 'go', screenshotBase64: null });
            assert.deepEqual(call, expected.messages);
            assert.equal(askService.liveDesign.getKit('session-1').answer, OPENING, `${mode} replaced the System Design · Live kit`);
            assert.equal(askService.state.notice, '');
        });

        it(`${mode}: the second Ctrl+Enter sends an empty request, as before`, async () => {
            setMode(mode);
            world.reply = 'An answer.';
            await askService.toggleAskButton(true);
            assert.equal(world.calls.length, 1);
            assert.equal(userOf(lastCall()), 'User Request: ');
            assert.ok(!sent.some(s => s.channel === 'ask:sendFromBox'));
        });

        it(`${mode}: two quick sends both go, the second replacing the first, as before`, async () => {
            setMode(mode);
            world.reply = 'An answer.';
            world.holdStream = deferred();
            const first = askService.sendMessage('a');
            await settle();
            world.holdStream = null;
            assert.equal((await askService.sendMessage('')).success, true);
            await first;
            assert.equal(world.calls.length, 2);
        });
    }
});

/**
 * capture.js
 *
 * What the app sends to the model outside System Design · Live, captured so a
 * change for that mode (future-work item 18.11, rule 8) can be checked byte for
 * byte against the messages from before it:
 *   - every profile's system prompt (with and without the search section);
 *   - the Ask messages in the modes default, code, debug and system_design;
 *   - the Live Answer lane's messages, and its stream options, for a fixed
 *     sequence of interviewer turns, driven through addConversationTurn with
 *     the career module disabled.
 *
 * Write the snapshot (only before a change that must keep it):
 *   node src/features/common/prompts/__tests__/golden/capture.js --write
 * golden.test.js compares against it. Invented text only.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', '..', '..', '..');
const GOLDEN = path.join(__dirname, 'golden.json');

// The fixed inputs. The turns cover the lane's prompt branches: an English and a
// Portuguese question, a confirmation check, a reported frame, a held set-up,
// and two system design lines (the `design` and `assume` cues).
const TURNS = [
    ['them', 'Tell me about a time you disagreed with a teammate.'],
    ['me', 'Sure, at my last project we had a disagreement about the release plan.'],
    ['them', 'Como você lida com prazos apertados?'],
    ['them', 'Então o processo tem três etapas e a próxima é com o time técnico, está bem?'],
    ['them', 'In the next round they will ask, like, why this class? How would you change it?'],
    ['them', 'Imagine that we have an endpoint that receives a CSV file.'],
    ['them', 'How would you validate it?'],
    ['them', 'Design a URL shortener.'],
    ['them', 'Assume about 10 million daily active users, all in the US.'],
];

const ASK_INPUT = {
    userPrompt: 'What is the difference between a process and a thread?',
    conversationHistory: 'them: Tell me about your last project.\nme: I built a billing service.',
    preferredCodeLanguage: 'go',
    screenshotBase64: 'AAAA',
};

function profiles() {
    const { profilePrompts } = require(path.join(SRC, 'features/common/prompts/promptTemplates.js'));
    const { getSystemPrompt } = require(path.join(SRC, 'features/common/prompts/promptBuilder.js'));
    const out = {};
    for (const name of Object.keys(profilePrompts).sort()) {
        out[name] = {
            noSearch: getSystemPrompt(name, 'CONTEXT-BLOCK', false),
            search: getSystemPrompt(name, 'CONTEXT-BLOCK', true),
        };
    }
    return out;
}

function askMessages() {
    const { buildAskMessages } = require(path.join(SRC, 'features/ask/askPrompt.js'));
    const out = {};
    for (const askMode of ['default', 'code', 'debug', 'system_design']) {
        out[askMode] = {
            withScreenshot: buildAskMessages({ askMode, ...ASK_INPUT }),
            noScreenshot: buildAskMessages({ askMode, ...ASK_INPUT, screenshotBase64: null }),
        };
    }
    return out;
}

/** Replaces the LLM factory before summaryService loads (it destructures at require time). */
function installFakeLlm(calls) {
    const factoryPath = require.resolve(path.join(SRC, 'features/common/ai/factory'));
    const encoder = new TextEncoder();
    require.cache[factoryPath] = {
        id: factoryPath,
        filename: factoryPath,
        loaded: true,
        exports: {
            createLLM: () => ({ chat: async () => ({ content: '' }), generateContent: async () => ({ response: { text: () => '' } }) }),
            createStreamingLLM: (provider, opts) => ({
                streamChat: async messages => {
                    calls.push({ messages, temperature: opts.temperature, maxTokens: opts.maxTokens });
                    const queue = [
                        `data: ${JSON.stringify({ choices: [{ delta: { content: 'A short answer.' } }] })}\n`,
                        'data: [DONE]\n',
                    ].map(l => encoder.encode(l));
                    return {
                        body: {
                            getReader: () => ({
                                read: async () => (queue.length ? { done: false, value: queue.shift() } : { done: true, value: undefined }),
                                cancel: async () => {},
                            }),
                        },
                    };
                },
            }),
        },
    };
    const modelStateService = require(path.join(SRC, 'features/common/services/modelStateService'));
    modelStateService.getCurrentModelInfo = async () => ({ provider: 'gemini', model: 'test-model', apiKey: 'test-key' });
}

const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
};

/**
 * The lane's messages for TURNS. The 800 ms debounce runs at once: setTimeout
 * is replaced while the turns are fed, and each armed callback is awaited.
 * @param {(svc: object) => void} [prepare] - called on the service before the turns
 */
async function laneMessages(prepare) {
    delete process.env.CAREER_KB_PATH;
    const calls = [];
    installFakeLlm(calls);
    const SummaryService = require(path.join(SRC, 'features/listen/summary/summaryService'));
    const svc = new SummaryService();
    svc.setLiveFeatures('answer');
    svc.sendToRenderer = () => {};
    svc.liveAnswers = { save: () => {} };
    svc.setSessionId('golden-session');
    if (prepare) prepare(svc);

    const realSetTimeout = global.setTimeout;
    const realClearTimeout = global.clearTimeout;
    const pending = new Map();
    let nextId = 1;
    global.setTimeout = (fn, ms, ...args) => {
        if (ms !== 800) return realSetTimeout(fn, ms, ...args);
        const id = { fake: nextId++ };
        pending.set(id, () => fn(...args));
        return id;
    };
    global.clearTimeout = id => {
        if (id && id.fake) pending.delete(id);
        else realClearTimeout(id);
    };
    const log = console.log;
    console.log = () => {};
    try {
        for (const [speaker, text] of TURNS) {
            svc.addConversationTurn(speaker, text);
            await settle();
            const fns = [...pending.values()];
            pending.clear();
            for (const fn of fns) await fn();
            await settle();
        }
    } finally {
        global.setTimeout = realSetTimeout;
        global.clearTimeout = realClearTimeout;
        console.log = log;
    }
    return calls;
}

async function capture() {
    return { profiles: profiles(), ask: askMessages(), lane: await laneMessages() };
}

module.exports = { capture, laneMessages, profiles, askMessages, TURNS, GOLDEN };

if (require.main === module) {
    (async () => {
        const snap = await capture();
        if (process.argv.includes('--write')) {
            fs.writeFileSync(GOLDEN, `${JSON.stringify(snap, null, 1)}\n`);
            console.error(`written ${GOLDEN}: ${Object.keys(snap.profiles).length} profiles, ${snap.lane.length} lane calls`);
        } else {
            console.error(`${Object.keys(snap.profiles).length} profiles, ${snap.lane.length} lane calls (pass --write to save)`);
        }
        process.exit(0);
    })();
}

/**
 * liveAnswerSdLive.test.js
 *
 * The Live Answer lane in System Design · Live v1 (future-work item 18.11):
 *   rule 6  — no design kit in the session: no LLM call, nothing sent to the window;
 *   rule 7  — with one: a PROBE answer from the kit's excerpt, no career step;
 *   rule 10 — a mode change drops the turns waiting for an answer;
 *   rule 8  — back in Default, today's messages.
 * The LLM is a scripted stream and the career module a recorder, both replaced
 * before summaryService loads. The 800 ms debounce runs when the test flushes
 * it. Invented text only.
 *
 * Run: node --test src/features/listen/summary/__tests__/liveAnswerSdLive.test.js
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

delete process.env.CAREER_KB_PATH;

// --- Scripted LLM ------------------------------------------------------------
const llmCalls = [];
let reply = 'At this scale Redis holds the timelines.\n- reason\nTrade-off: memory.';
const factoryPath = require.resolve('../../../common/ai/factory');
require.cache[factoryPath] = {
    id: factoryPath,
    filename: factoryPath,
    loaded: true,
    exports: {
        createLLM: () => { throw new Error('createLLM is not used by the answer lane'); },
        createStreamingLLM: (provider, opts) => ({
            streamChat: async messages => {
                llmCalls.push({ messages, opts });
                const encoder = new TextEncoder();
                const queue = [`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n`, 'data: [DONE]\n'].map(l => encoder.encode(l));
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
const modelStateService = require('../../../common/services/modelStateService');
modelStateService.getCurrentModelInfo = async () => ({ provider: 'gemini', model: 'test-model', apiKey: 'test-key' });

const SummaryService = require('../summaryService');
const { createLiveDesign } = require('../../../ask/liveDesign');
const { PROBE_RULE } = require('../liveProbePrompt');
const { getSystemPrompt } = require('../../../common/prompts/promptBuilder.js');

const DESIGN_KIT = [
    '## Requirements used',
    '- Scale: 10M daily users, US only (confirmed)',
    '## Design',
    '- **Storage:**',
    '| Entity | Store | Key | Why |',
    '| Timeline | Redis | user_id | fast reads |',
    '- **Decisions:** push fan-out; timelines in Redis, last 800 IDs.',
    '## Deep dives',
    '- **Pick:** hybrid fan-out.',
].join('\n');
const OPENING_KIT = '## Frame\n> We are building a home timeline. Is that right?';

// --- Career recorder -----------------------------------------------------------
let careerCalls = [];
let jevOn = false;
let classifyResolve = null;
function careerStub() {
    const rec = name => (...args) => { careerCalls.push(name); return undefined; };
    return {
        detectCompany: (...a) => { careerCalls.push('detectCompany'); return 'Uber'; },
        prefetch: rec('prefetch'),
        gateUsesJev: () => jevOn,
        classifyTurn: () => { careerCalls.push('classifyTurn'); return new Promise(r => { classifyResolve = r; }); },
        wantsAnswer: async () => { careerCalls.push('wantsAnswer'); return true; },
        getCareerContext: async () => { careerCalls.push('getCareerContext'); return null; },
        hasCareerCue: () => { careerCalls.push('hasCareerCue'); return false; },
        askPolicy: () => null,
        checkAnswer: () => [],
    };
}

// --- Debounce under the test's control -----------------------------------------
const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;
const pending = new Map();
let nextId = 1;
function fakeTimers() {
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
}
function realTimers() {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
    pending.clear();
}
const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
};
async function flush() {
    await settle();
    const fns = [...pending.values()];
    pending.clear();
    for (const fn of fns) await fn();
    await settle();
}

let svc;
let sent;
let saved;
let state;
function makeService({ mode = 'system_design_live', kit = null } = {}) {
    state = createLiveDesign();
    const s = new SummaryService();
    s.liveDesign = state;
    s.career = careerStub();
    s.setLiveFeatures('answer');
    s.setSessionId('s1');
    sent = [];
    saved = [];
    s.sendToRenderer = (channel, data) => sent.push({ channel, data });
    s.liveAnswers = { save: r => saved.push({ ...r }) };
    s.setAskMode(mode);
    if (kit) state.storeKit({ sessionId: 's1', ...kit });
    return s;
}
async function say(speaker, text) {
    svc.addConversationTurn(speaker, text);
    await flush();
}

const quiet = console.log;
beforeEach(() => {
    llmCalls.length = 0;
    careerCalls = [];
    jevOn = false;
    classifyResolve = null;
    console.log = () => {};
    fakeTimers();
});
afterEach(() => {
    realTimers();
    console.log = quiet;
});

describe('rule 6: no design kit in this Listen session → silent', () => {
    for (const [label, kit] of [['no kit', null], ['an opening kit', { kind: 'opening', question: 'opening', answer: OPENING_KIT }]]) {
        it(`${label}: no LLM call, nothing sent, no career step`, async () => {
            svc = makeService({ kit });
            await say('them', 'Design a Twitter-like home timeline.');
            await say('them', 'Assume about 10 million daily active users, all in the US.');
            await say('them', 'How would you handle hot keys?');
            assert.equal(llmCalls.length, 0);
            assert.deepEqual(sent, []);
            assert.deepEqual(careerCalls, []);
            assert.equal(svc.activeCompany, null, 'a design problem never becomes the interviewer\'s company');
        });
    }
    it('a design kit of another session counts as none', async () => {
        svc = makeService();
        state.storeKit({ sessionId: 'other', kind: 'design', question: 'design', answer: DESIGN_KIT });
        await say('them', 'What if Redis goes down?');
        assert.equal(llmCalls.length, 0);
        assert.deepEqual(sent, []);
    });
});

describe('rule 7: with a design kit, a PROBE answer', () => {
    it('one call per question: the probe profile, the transcript, the kit excerpt; no career step', async () => {
        svc = makeService({ kit: { kind: 'design', question: 'design', answer: DESIGN_KIT } });
        await say('them', 'What if the timeline cache cluster goes down?');
        assert.equal(llmCalls.length, 1);
        const [system, user] = llmCalls[0].messages;
        assert.equal(system.role, 'system');
        assert.ok(system.content.startsWith(getSystemPrompt('pickle_glass_system_design_probe', '', false).split('User-provided context')[0]));
        assert.match(system.content, /Transcript:\nthem: What if the timeline cache cluster goes down\?/);
        assert.match(system.content, /\*\*Decisions:\*\* push fan-out; timelines in Redis/);
        assert.match(system.content, /\| Timeline \| Redis \| user_id \| fast reads \|/);
        assert.doesNotMatch(system.content, /## Deep dives/, 'the excerpt, not the kit');
        assert.ok(user.content.startsWith('The interviewer\'s most recent question, their last turn in the transcript: "What if the timeline cache cluster goes down?"\n\n' + PROBE_RULE));
        assert.match(user.content, /The question was asked in English/);
        assert.doesNotMatch(user.content, /about 60 words/, 'no LENGTH_RULE');
        assert.deepEqual(careerCalls, [], 'no company detection, Jev, prefetch, cue or context');
        assert.equal(saved.length, 1);
        assert.equal(saved[0].route, 'sd-probe');
        const shown = sent.filter(s => s.channel === 'live-answer-update' && s.data.answer);
        assert.ok(shown.length > 0, 'the answer reaches the window');
    });
    it('the candidate\'s own speech never triggers', async () => {
        svc = makeService({ kit: { kind: 'design', question: 'design', answer: DESIGN_KIT } });
        await say('me', 'What if Redis goes down?');
        assert.equal(llmCalls.length, 0);
    });
    it('a Portuguese question gets the Portuguese language rule', async () => {
        svc = makeService({ kit: { kind: 'design', question: 'design', answer: DESIGN_KIT } });
        await say('them', 'Como você lidaria com uma chave muito acessada?');
        assert.equal(llmCalls.length, 1);
        assert.match(llmCalls[0].messages[1].content, /The question was asked in Portuguese/);
    });
    it('a kit stored without the expected parts gives the cut kit as the excerpt', async () => {
        const bare = Array.from({ length: 150 }, (_, i) => `word${i}`).join(' ');
        svc = makeService({ kit: { kind: 'design', question: 'design', answer: bare } });
        await say('them', 'Why not SQL?');
        assert.equal(llmCalls.length, 1);
        assert.match(llmCalls[0].messages[0].content, /word0 word1/);
    });
    it('the kit changing to an opening kit during the debounce: no call', async () => {
        svc = makeService({ kit: { kind: 'design', question: 'design', answer: DESIGN_KIT } });
        svc.addConversationTurn('them', 'What if Redis goes down?');
        state.storeKit({ sessionId: 's1', kind: 'opening', question: 'opening: uber', answer: OPENING_KIT });
        await flush();
        assert.equal(llmCalls.length, 0);
    });
    it('a probe clears the career follow-up state', async () => {
        svc = makeService({ kit: { kind: 'design', question: 'design', answer: DESIGN_KIT } });
        svc.careerPrev = { route: 'personal', queryTerms: ['x'], anchorText: 'x', ts: Date.now() };
        await say('them', 'What if Redis goes down?');
        assert.equal(svc.careerPrev, null);
    });
});

describe('rule 10: a mode change drops the turns waiting for an answer', () => {
    it('a switch during the debounce drops the turn', async () => {
        svc = makeService({ mode: 'default' });
        svc.addConversationTurn('them', 'Tell me about a time you disagreed with a teammate?');
        svc.setAskMode('system_design_live');
        await flush();
        assert.equal(llmCalls.length, 0);
        svc.setAskMode('default');
        state.storeKit({ sessionId: 's1', kind: 'design', question: 'design', answer: DESIGN_KIT });
        svc.setAskMode('system_design_live');
        svc.addConversationTurn('them', 'What if Redis goes down?');
        svc.setAskMode('default');
        await flush();
        assert.equal(llmCalls.length, 0);
    });
    it('a switch while Jev decides on a Default turn drops it', async () => {
        svc = makeService({ mode: 'default' });
        jevOn = true;
        svc.addConversationTurn('them', 'Your biggest weakness');
        await settle();
        assert.ok(classifyResolve, 'the turn went to Jev');
        svc.setAskMode('system_design_live');
        classifyResolve({ route: 'personal', source: 'jev' });
        await flush();
        assert.equal(llmCalls.length, 0);
    });
    it('a switch inside the same side (default → code) keeps the waiting turn', async () => {
        svc = makeService({ mode: 'default' });
        svc.addConversationTurn('them', 'How do you handle deadlines?');
        svc.setAskMode('code');
        await flush();
        assert.equal(llmCalls.length, 1);
    });
    it('held set-ups do not cross the switch', async () => {
        svc = makeService({ mode: 'default' });
        svc.addConversationTurn('them', 'Imagine that we have an endpoint that receives a CSV file.');
        await flush();
        assert.equal(svc.heldSetup.length, 1);
        svc.setAskMode('system_design_live');
        assert.deepEqual(svc.heldSetup, []);
    });
});

describe('rule 8: back in Default, today\'s lane', () => {
    it('the interviewer\'s last segment is still kept in SD Live, and Default answers as before', async () => {
        svc = makeService({ kit: { kind: 'design', question: 'design', answer: DESIGN_KIT } });
        await say('them', 'Design Uber.');
        assert.equal(svc.lastThemTurn.text, 'Design Uber.');
        assert.equal(svc.activeCompany, null);
        llmCalls.length = 0;
        svc.setAskMode('default');
        await say('them', 'Tell me about a time you disagreed with a teammate.');
        assert.equal(llmCalls.length, 1);
        const [system, user] = llmCalls[0].messages;
        const recent = svc.conversationHistory.slice(-30).join('\n');
        assert.equal(system.content, getSystemPrompt('pickle_glass_analysis', '', false).replace('{{CONVERSATION_HISTORY}}', recent));
        assert.match(user.content, /about 60 words in all/);
        assert.ok(careerCalls.includes('detectCompany'), 'the career steps run again in Default');
        assert.equal(llmCalls[0].opts.temperature, 0.7);
        assert.equal(llmCalls[0].opts.maxTokens, 900);
    });
    it('Live Answer off: nothing in SD Live either', async () => {
        svc = makeService({ kit: { kind: 'design', question: 'design', answer: DESIGN_KIT } });
        svc.setLiveFeatures('insights');
        await say('them', 'What if Redis goes down?');
        assert.equal(llmCalls.length, 0);
    });
});

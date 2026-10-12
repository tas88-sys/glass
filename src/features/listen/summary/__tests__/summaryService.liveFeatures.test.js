/**
 * summaryService.liveFeatures.test.js — T012 (spec 2026-10-12-live-features-toggle;
 * FR-005..FR-009, D4, D5, D10, D11; E18, E24, E44)
 *
 * Run: node --test src/features/listen/summary/__tests__/summaryService.liveFeatures.test.js
 *
 * The lane gates on a real SummaryService. The LLM is mocked through
 * require.cache before summaryService loads: a scripted stream for the answer
 * lane and a counting chat() for the analysis lane. The session and summary
 * repositories are replaced on their module objects with counters, so a test
 * with a session id proves whether a summary is saved.
 */

'use strict';

const { describe, it, before, after, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');

delete process.env.CAREER_KB_PATH;   // the real career singleton stays disabled

// --- Mocked LLM --------------------------------------------------------------
let turnNo = 0;                       // the turn being driven, read by chat()
const streamCalls = [];
const chatTurns = [];
let streamScript = () => ['Headline answer here.\n', '- point one\n'];
let holdStream = false;               // the stream stays open after its script
let chatImpl = async () => ({ content: SUMMARY });

const SUMMARY = [
    '**Summary Overview**',
    '- The candidate explained Go internals',
    '',
    '**Key Topic: Go runtime**',
    '- Garbage collection',
    '- Channels',
    '',
    '**Extended Explanation**',
    'The talk covered the collector and channels.',
    '',
    '**Suggested Questions**',
    '1. How are goroutines scheduled?',
].join('\n');

function sseResponse(lines, held) {
    const encoder = new TextEncoder();
    const queue = lines.map(l => encoder.encode(`${l}\n`));
    let release = null;
    return {
        body: {
            getReader() {
                return {
                    read: async () => {
                        if (queue.length) return { done: false, value: queue.shift() };
                        if (!held) return { done: true, value: undefined };
                        return new Promise(resolve => { release = () => resolve({ done: true, value: undefined }); });
                    },
                    cancel: async () => { if (release) release(); },
                };
            },
        },
    };
}
const delta = text => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`;

const factoryPath = require.resolve('../../../common/ai/factory');
require.cache[factoryPath] = {
    id: factoryPath,
    filename: factoryPath,
    loaded: true,
    exports: {
        createLLM: () => ({
            chat: async messages => {
                chatTurns.push(turnNo);
                return chatImpl(messages);
            },
        }),
        createStreamingLLM: () => ({
            streamChat: async messages => {
                streamCalls.push(messages);
                const lines = streamScript().map(x => (x.startsWith('data: ') ? x : delta(x)));
                return sseResponse(holdStream ? lines : [...lines, 'data: [DONE]'], holdStream);
            },
        }),
    },
};
const modelStateService = require('../../../common/services/modelStateService');
modelStateService.getCurrentModelInfo = async () => ({ provider: 'gemini', model: 'test-model', apiKey: 'test-key' });

const sessionRepository = require('../../../common/repositories/session');
const summaryRepository = require('../repositories');
const SummaryService = require('../summaryService');

// --- Repository counters -------------------------------------------------------
const saves = [];
let touches = 0;
const realTouch = sessionRepository.touch;
const realSaveSummary = summaryRepository.saveSummary;
before(() => {
    sessionRepository.touch = async () => { touches++; };
    summaryRepository.saveSummary = summary => { saves.push(summary.sessionId); };
});
after(() => {
    sessionRepository.touch = realTouch;
    summaryRepository.saveSummary = realSaveSummary;
});

// --- Helpers -------------------------------------------------------------------
// Ten turns, two interviewer questions (turns 3 and 9); the analysis runs at 5 and 10.
const TURNS = [
    ['Them', 'Thanks for joining today.'],
    ['Me', 'Happy to be here.'],
    ['Them', 'How does garbage collection work in Go?'],
    ['Me', 'It uses a concurrent mark and sweep collector.'],
    ['Them', 'Okay, that makes sense.'],
    ['Me', 'Great.'],
    ['Them', 'We run everything on Kubernetes here.'],
    ['Me', 'I have run it for years.'],
    ['Them', 'What is a channel used for in Go?'],
    ['Me', 'Passing values between goroutines.'],
];

function stubCareer() {
    const calls = { detectCompany: 0, prefetch: 0, getCareerContext: 0 };
    return {
        calls,
        hasCareerCue: () => false,
        detectCompany: () => { calls.detectCompany++; return null; },
        prefetch: () => { calls.prefetch++; },
        getCareerContext: async () => { calls.getCareerContext++; return null; },
    };
}

function service(sessionId = 'session-1') {
    const s = new SummaryService();
    const emitted = [];
    s.sendToRenderer = (channel, data) => emitted.push({ channel, data });
    s.career = stubCareer();
    s.setSessionId(sessionId);
    return { s, emitted };
}

const flush = () => new Promise(r => setImmediate(r));
async function settle(n = 10) {
    for (let i = 0; i < n; i++) await flush();
}

/** Adds turns from..to (1-based, inclusive), firing each debounce and letting every lane finish. */
async function drive(s, from = 1, to = TURNS.length) {
    for (let i = from; i <= to; i++) {
        turnNo = i;
        const [speaker, text] = TURNS[i - 1];
        s.addConversationTurn(speaker, text);
        mock.timers.tick(800);
        await settle();
    }
}

const sends = (emitted, channel) => emitted.filter(e => e.channel === channel);
const withoutTs = emitted => emitted.map(({ channel, data }) => {
    const { ts, ...rest } = data;
    return { channel, data: rest };
});

// The service logs every turn and the parsed analysis; keep the runner's output
// to the results. The [Live] test reads these calls.
let log;
beforeEach(() => {
    log = mock.method(console, 'log', () => {});
});

afterEach(() => {
    turnNo = 0;
    streamCalls.length = 0;
    chatTurns.length = 0;
    saves.length = 0;
    touches = 0;
    streamScript = () => ['Headline answer here.\n', '- point one\n'];
    holdStream = false;
    chatImpl = async () => ({ content: SUMMARY });
    mock.timers.reset();
    mock.restoreAll();
});

// --- Mode and log ----------------------------------------------------------------
describe('setLiveFeatures', () => {
    it('a new service runs both lanes', () => {
        const { s } = service();
        assert.equal(s.liveFeatures, 'both');
    });

    it('stores the normalized mode; an invalid value reads as both', () => {
        const { s } = service();
        s.setLiveFeatures('answer');
        assert.equal(s.liveFeatures, 'answer');
        s.setLiveFeatures('insights');
        assert.equal(s.liveFeatures, 'insights');
        s.setLiveFeatures('ANSWER');
        assert.equal(s.liveFeatures, 'both');
        s.setLiveFeatures(undefined);
        assert.equal(s.liveFeatures, 'both');
    });

    it('logs [Live] features=<mode> once per call, with nothing else in the line', () => {
        const { s } = service();
        s.setLiveFeatures('answer');
        s.setLiveFeatures({ prompt: 'secret question text' });
        const lines = log.mock.calls.map(c => c.arguments.join(' ')).filter(l => l.includes('[Live]'));
        assert.deepEqual(lines, ['[Live] features=answer', '[Live] features=both']);
    });

    it('pauses the answer lane only when Answer goes from on to off', () => {
        const { s } = service();
        const pause = mock.method(s, 'pauseLiveAnswer');
        s.setLiveFeatures('both');
        s.setLiveFeatures('answer');
        assert.equal(pause.mock.callCount(), 0, 'Answer stayed on');
        s.setLiveFeatures('insights');
        assert.equal(pause.mock.callCount(), 1, 'Answer went off');
        s.setLiveFeatures('insights');
        assert.equal(pause.mock.callCount(), 1, 'same mode again');
        s.setLiveFeatures('both');
        assert.equal(pause.mock.callCount(), 1, 'Answer back on');
    });
});

// --- A scripted session per mode ---------------------------------------------------
describe('a ten-turn session per mode', () => {
    it('both: two answers, analyses at turns 5 and 10, two saves; sends equal a service never set', async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        const untouched = service();
        await drive(untouched.s);
        const baseline = withoutTs(untouched.emitted);
        const baselineStreams = streamCalls.length;
        const baselineChats = chatTurns.slice();
        streamCalls.length = 0;
        chatTurns.length = 0;
        saves.length = 0;

        const { s, emitted } = service();
        s.setLiveFeatures('both');
        await drive(s);

        assert.equal(baselineStreams, 2);
        assert.deepEqual(baselineChats, [5, 10]);
        assert.equal(streamCalls.length, 2);
        assert.deepEqual(chatTurns, [5, 10]);
        assert.deepEqual(saves, ['session-1', 'session-1']);
        assert.equal(sends(emitted, 'summary-update').length, 2);
        assert.equal(sends(emitted, 'live-answer-update').length > 0, true);
        assert.deepEqual(withoutTs(emitted), baseline);
        assert.equal(s.conversationHistory.length, 10);
    });

    it('answer: two answers, no analysis call, no summary sent, nothing saved', async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        const { s, emitted } = service();
        s.setLiveFeatures('answer');
        await drive(s);

        assert.equal(streamCalls.length, 2);
        assert.deepEqual(chatTurns, []);
        assert.equal(sends(emitted, 'summary-update').length, 0);
        assert.deepEqual(saves, []);
        assert.equal(touches, 0, 'the session is not touched by an analysis');
        assert.deepEqual(
            [...new Set(sends(emitted, 'live-answer-update').map(e => e.data.question))],
            ['How does garbage collection work in Go?', 'What is a channel used for in Go?'],
        );
        assert.equal(s.conversationHistory.length, 10);
    });

    it('insights: no stream, no answer sends, the career module untouched; analyses at turns 5 and 10', async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        const { s, emitted } = service();
        s.setLiveFeatures('insights');
        await drive(s);

        assert.equal(streamCalls.length, 0);
        assert.equal(sends(emitted, 'live-answer-update').length, 0);
        assert.deepEqual(s.career.calls, { detectCompany: 0, prefetch: 0, getCareerContext: 0 });
        assert.equal(s.answerDebounceTimer, null);
        assert.deepEqual(chatTurns, [5, 10]);
        assert.equal(sends(emitted, 'summary-update').length, 2);
        assert.deepEqual(saves, ['session-1', 'session-1']);
        assert.equal(s.conversationHistory.length, 10);
    });
});

// --- Answer turned off mid-question ---------------------------------------------------
describe('Answer turned off while a question is pending or streaming', () => {
    it('a pending debounce is cleared: the timer firing starts nothing', async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        const { s } = service();
        s.conversationHistory = ['them: hello'];
        s.addConversationTurn('Them', 'How does garbage collection work in Go?');
        assert.notEqual(s.answerDebounceTimer, null);

        s.setLiveFeatures('insights');
        assert.equal(s.answerDebounceTimer, null);
        mock.timers.tick(800);
        await settle();
        assert.equal(streamCalls.length, 0);
        assert.equal(s.inFlight, false);
    });

    it('a streaming answer is aborted and sends no more text', async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        holdStream = true;
        const { s, emitted } = service();
        s.conversationHistory = ['them: hello'];
        s.addConversationTurn('Them', 'How does garbage collection work in Go?');
        mock.timers.tick(800);
        await settle();
        assert.equal(streamCalls.length, 1);
        assert.equal(s.inFlight, true);
        const controller = s.inFlightController;
        assert.ok(sends(emitted, 'live-answer-update').some(e => e.data.answer), 'text streamed before the pause');

        const before = emitted.length;
        s.setLiveFeatures('insights');
        await settle();
        assert.equal(controller.signal.aborted, true);
        assert.equal(s.inFlight, false);
        assert.equal(s.inFlightController, null);
        assert.deepEqual(emitted.slice(before), [], 'no answer, unverified, error or status after the pause');
    });

    it('after a "Trying …" status, the only send after the pause is the idle status', async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        holdStream = true;
        streamScript = () => [
            'data: {"_reset":true,"next_model":"backup-model"}',
            'Headline answer here.\n',
        ];
        const { s, emitted } = service();
        s.conversationHistory = ['them: hello'];
        s.addConversationTurn('Them', 'How does garbage collection work in Go?');
        mock.timers.tick(800);
        await settle();
        assert.ok(sends(emitted, 'live-answer-update').some(e => e.data.status === 'retrying'));

        const before = emitted.length;
        s.setLiveFeatures('insights');
        await settle();
        const after = emitted.slice(before);
        assert.equal(after.length, 1);
        assert.equal(after[0].channel, 'live-answer-update');
        assert.equal(after[0].data.status, 'idle');
        assert.equal(after[0].data.answer, undefined);
        assert.equal(after[0].data.error, undefined);
        assert.equal(after[0].data.unverified, undefined);
        assert.equal(s.inFlight, false);
    });

    it('pauseLiveAnswer keeps the session state that resetLiveAnswer clears', () => {
        const fill = s => {
            s.lastAnsweredTail = 'how does garbage collection work in go';
            s.careerPrev = { route: 'personal', queryTerms: ['x'], ts: 1 };
            s.activeCompany = 'Harbor';
            s.inFlight = true;
            s.inFlightController = new AbortController();
        };
        const { s } = service();
        fill(s);
        const controller = s.inFlightController;
        s.pauseLiveAnswer();
        assert.equal(controller.signal.aborted, true);
        assert.equal(s.inFlight, false);
        assert.equal(s.inFlightController, null);
        assert.equal(s.lastAnsweredTail, 'how does garbage collection work in go');
        assert.deepEqual(s.careerPrev, { route: 'personal', queryTerms: ['x'], ts: 1 });
        assert.equal(s.activeCompany, 'Harbor');

        fill(s);
        s.resetLiveAnswer();
        assert.equal(s.lastAnsweredTail, null);
        assert.equal(s.careerPrev, null);
        assert.equal(s.activeCompany, null);
    });

    it('Answer turned back on: the next question answers', async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        const { s } = service();
        s.setLiveFeatures('answer');
        await drive(s, 1, 3);
        assert.equal(streamCalls.length, 1);
        s.setLiveFeatures('insights');
        await drive(s, 4, 8);
        assert.equal(streamCalls.length, 1);
        s.setLiveFeatures('answer');
        await drive(s, 9, 9);
        assert.equal(streamCalls.length, 2);
    });
});

// --- Insights turned off and on ------------------------------------------------------------
describe('Insights turned off and on', () => {
    it('off through turn 7, on at turn 8: the next analysis is at turn 10, not at once', async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        const { s, emitted } = service();
        s.setLiveFeatures('answer');
        await drive(s, 1, 7);
        assert.deepEqual(chatTurns, []);
        s.setLiveFeatures('both');
        await settle();
        assert.deepEqual(chatTurns, [], 'turning Insights on starts no analysis');
        await drive(s, 8, 10);
        assert.deepEqual(chatTurns, [10]);
        assert.equal(sends(emitted, 'summary-update').length, 1);
        assert.deepEqual(saves, ['session-1']);
    });

    it('an analysis waiting on its chat() when Insights goes off still finishes, sends and saves', async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        let release;
        chatImpl = () => new Promise(resolve => { release = () => resolve({ content: SUMMARY }); });
        const { s, emitted } = service();
        await drive(s, 1, 5);
        assert.deepEqual(chatTurns, [5]);
        assert.equal(sends(emitted, 'summary-update').length, 0);

        s.setLiveFeatures('answer');
        release();
        await settle();
        assert.equal(sends(emitted, 'summary-update').length, 1);
        assert.deepEqual(saves, ['session-1']);
    });
});

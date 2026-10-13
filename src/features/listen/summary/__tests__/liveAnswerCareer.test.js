/**
 * liveAnswerCareer.test.js — T020, T031 (FR-007, FR-014, FR-015, FR-021, SC-005; E22, E27, E28, E34; C1)
 *
 * Run: node --test src/features/listen/summary/__tests__/liveAnswerCareer.test.js
 *
 * Wiring of the career module into the Live Answer lane. The LLM is a mocked
 * stream (createStreamingLLM replaced through require.cache before
 * summaryService loads); the career module is the real, disabled singleton or
 * a stub. Fixtures are invented text only (spec C5).
 */

'use strict';

const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');

delete process.env.CAREER_KB_PATH;   // the real singleton must stay disabled here

// --- Mocked LLM stream -------------------------------------------------------
const llmCalls = [];
let streamScript = () => ['Headline answer here.\n', '- point one\n'];

function sseResponse(lines) {
    const encoder = new TextEncoder();
    const queue = lines.map(l => encoder.encode(`${l}\n`));
    return {
        body: {
            getReader() {
                return {
                    read: async () => (queue.length ? { done: false, value: queue.shift() } : { done: true, value: undefined }),
                    cancel: async () => {},
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
        createLLM: () => { throw new Error('createLLM is not used by the answer lane'); },
        createStreamingLLM: () => ({
            streamChat: async messages => {
                llmCalls.push(messages);
                const script = streamScript();
                const lines = script.map(x => (x.startsWith('data: ') ? x : delta(x)));
                return sseResponse([...lines, 'data: [DONE]']);
            },
        }),
    },
};
const modelStateService = require('../../../common/services/modelStateService');
modelStateService.getCurrentModelInfo = async () => ({ provider: 'gemini', model: 'test-model', apiKey: 'test-key' });

const SummaryService = require('../summaryService');
const { shouldTriggerAnswer, extractQuestion } = SummaryService;
const { getSystemPrompt } = require('../../../common/prompts/promptBuilder.js');
const realCareer = require('../../../common/career');

// Today's user instruction, copied verbatim from makeLiveAnswer (with the
// language line the live eval asked for). SC-005 compares against it byte for byte.
const TODAY_USER =
    'Answer the interviewer\'s most recent question directly and concisely. ' +
    'Start with a short headline answer (one sentence). ' +
    'When there are supporting points, format them as a markdown bullet list ' +
    '(each point on its own line beginning with "- "). ' +
    'Do not fabricate bullets for a trivial one-line answer. ' +
    'Write the answer in the language of that question (Portuguese if it was asked in Portuguese), ' +
    'keeping technical terms as they are commonly said. ' +
    'If there is no clear question or nothing useful to answer, reply EXACTLY: PASSIVE';

const HISTORY = ['me: hello there', 'them: Tell me about a time you disagreed with a teammate.'];
const todaysMessages = history => [
    { role: 'system', content: getSystemPrompt('pickle_glass_analysis', '', false).replace('{{CONVERSATION_HISTORY}}', history.slice(-30).join('\n')) },
    { role: 'user', content: TODAY_USER },
];

const PERSONAL = {
    route: 'personal',
    cue: 'behavioral:tell-me-about-a-time',
    block: '[canonical facts]\n- Invented fact.\n\n[stories › Disagreement]\nInvented story body.',
    addendum: 'Invented addendum for the test.',
    sources: ['stories › Disagreement', 'canonical facts'],
    chunkIds: ['aaaaaaaaaaaa'],
    queryTerms: ['disagre', 'teammat'],
    anchorText: 'Tell me about a time you disagreed?',
    timings: { routeMs: 0, bm25Ms: 0, vectorMs: 0, vectorUsed: false, totalMs: 0 },
};
const GENERAL = { ...PERSONAL, route: 'general', cue: null, block: '', addendum: '', sources: [], chunkIds: [], queryTerms: [], anchorText: '' };

function service() {
    const s = new SummaryService();
    const emitted = [];
    s.sendToRenderer = (channel, data) => emitted.push({ channel, data });
    return { s, emitted };
}

function stubCareer(overrides = {}) {
    const calls = { prefetch: [], prefetchSessions: [], getCareerContext: [], detectCompany: [] };
    const stub = {
        calls,
        hasCareerCue: () => false,
        detectCompany: text => { calls.detectCompany.push(text); return null; },
        prefetch: (text, session) => { calls.prefetch.push(text); calls.prefetchSessions.push(session); },
        getCareerContext: async (text, session) => { calls.getCareerContext.push({ text, session }); return null; },
        ...overrides,
    };
    return stub;
}

const flush = () => new Promise(r => setImmediate(r));

afterEach(() => {
    llmCalls.length = 0;
    streamScript = () => ['Headline answer here.\n', '- point one\n'];
    mock.timers.reset();
});

describe('SC-005: prompt is byte-identical when nothing is injected', () => {
    it('FIRST: career disabled → the messages sent to streamChat are today\'s, byte for byte', async () => {
        const { s } = service();
        assert.equal(realCareer.status().state, 'disabled');
        await s.makeLiveAnswer(HISTORY, new AbortController().signal, { id: 1, question: 'q', career: null });
        assert.equal(llmCalls.length, 1);
        assert.deepEqual(llmCalls[0], todaysMessages(HISTORY));
    });

    it('no career meta at all (older callers) → identical too', async () => {
        const { s } = service();
        await s.makeLiveAnswer(HISTORY, undefined, { id: 1, question: 'q' });
        assert.deepEqual(llmCalls[0], todaysMessages(HISTORY));
    });

    it('general route (empty block) → identical', async () => {
        const { s } = service();
        await s.makeLiveAnswer(HISTORY, undefined, { id: 1, question: 'q', career: GENERAL });
        assert.deepEqual(llmCalls[0], todaysMessages(HISTORY));
    });

    it('the full debounce path with the real disabled module → identical', async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        const { s } = service();
        const q = 'Tell me about a time you disagreed with a teammate.';
        s.conversationHistory = HISTORY.slice();
        s.triggerAnswerIfNeeded('Them', q);
        mock.timers.tick(800);
        for (let i = 0; i < 5; i++) await flush();
        assert.equal(llmCalls.length, 1);
        assert.deepEqual(llmCalls[0], todaysMessages(HISTORY));
    });
});

describe('FR-014: personal context goes into customPrompt plus the addendum', () => {
    it('system prompt carries the block in the User-provided context slot; user message ends with the addendum', async () => {
        const { s } = service();
        await s.makeLiveAnswer(HISTORY, undefined, { id: 1, question: 'q', career: PERSONAL });
        const [system, user] = llmCalls[0];
        const expectedSystem = getSystemPrompt('pickle_glass_analysis', PERSONAL.block, false)
            .replace('{{CONVERSATION_HISTORY}}', HISTORY.join('\n'));
        assert.equal(system.content, expectedSystem);
        assert.ok(system.content.includes(`User-provided context\n-----\n${PERSONAL.block}\n-----`));
        assert.equal(user.content, `${TODAY_USER}\n\n${PERSONAL.addendum}`);
    });
});

describe('FR-015: sources ride on the answer payloads of that id only (E22)', () => {
    it('every answer payload of the injected answer has sources; status payloads and other ids do not', async () => {
        const { s, emitted } = service();
        streamScript = () => [
            'data: {"_reset":true,"next_model":"m2"}',
            'Headline answer here.\n',
            '- point one\n',
            '- point two\n',
        ];
        await s.makeLiveAnswer(HISTORY, undefined, { id: 7, question: 'q', career: PERSONAL });
        streamScript = () => ['Second answer headline.\n'];
        await s.makeLiveAnswer(HISTORY, undefined, { id: 8, question: 'q2', career: null });

        const updates = emitted.filter(e => e.channel === 'live-answer-update').map(e => e.data);
        const answers7 = updates.filter(u => u.id === 7 && u.answer);
        const status7 = updates.filter(u => u.id === 7 && u.status);
        const answers8 = updates.filter(u => u.id === 8 && u.answer);
        assert.ok(answers7.length >= 2);
        for (const u of answers7) assert.deepEqual(u.sources, PERSONAL.sources);
        assert.deepEqual(status7.map(u => u.status), ['retrying', 'idle']);
        for (const u of status7) assert.ok(!('sources' in u), 'status payloads unchanged');
        assert.ok(answers8.length >= 1);
        for (const u of answers8) assert.ok(!('sources' in u), 'no sources leak to the next id');
    });

    it('a general-route answer carries no sources', async () => {
        const { s, emitted } = service();
        await s.makeLiveAnswer(HISTORY, undefined, { id: 3, question: 'q', career: GENERAL });
        for (const e of emitted) assert.ok(!('sources' in e.data));
    });
});

describe('FR-021: unverified numbers and names ride on one last payload', () => {
    const answersOf = (emitted, id) => emitted.filter(e => e.channel === 'live-answer-update' && e.data.id === id && e.data.answer).map(e => e.data);

    it('the last payload of an injected answer carries what the check found', async () => {
        const { s, emitted } = service();
        const calls = [];
        s.career = stubCareer({ checkAnswer: (...args) => { calls.push(args); return ['40%']; } });
        await s.makeLiveAnswer(HISTORY, undefined, { id: 4, question: 'q', career: PERSONAL });
        const updates = answersOf(emitted, 4);
        const last = updates[updates.length - 1];
        assert.deepEqual(last.unverified, ['40%']);
        assert.equal(last.answer, 'Headline answer here.\n- point one\n');
        assert.deepEqual(last.sources, PERSONAL.sources);
        for (const u of updates.slice(0, -1)) assert.ok(!('unverified' in u), 'streaming payloads unchanged');
        assert.equal(calls.length, 1);
        const [answer, ctx, conversation] = calls[0];
        assert.equal(answer, last.answer);
        assert.equal(ctx, PERSONAL);
        assert.ok(conversation.includes('q') && conversation.includes(HISTORY[1]), 'question and transcript count as given');
    });

    it('nothing found → no extra payload', async () => {
        const { s, emitted } = service();
        s.career = stubCareer({ checkAnswer: () => [] });
        await s.makeLiveAnswer(HISTORY, undefined, { id: 5, question: 'q', career: PERSONAL });
        for (const u of answersOf(emitted, 5)) assert.ok(!('unverified' in u));
    });

    it('a general-route answer is not checked', async () => {
        const { s, emitted } = service();
        let called = false;
        s.career = stubCareer({ checkAnswer: () => { called = true; return ['40%']; } });
        await s.makeLiveAnswer(HISTORY, undefined, { id: 6, question: 'q', career: GENERAL });
        assert.equal(called, false);
        for (const e of emitted) assert.ok(!('unverified' in e.data));
    });

    it('a throwing check never blocks the answer', async () => {
        const { s, emitted } = service();
        s.career = stubCareer({ checkAnswer: () => { throw new Error('boom'); } });
        const out = await s.makeLiveAnswer(HISTORY, undefined, { id: 9, question: 'q', career: PERSONAL });
        assert.equal(out.answer, 'Headline answer here.\n- point one\n');
        for (const u of answersOf(emitted, 9)) assert.ok(!('unverified' in u));
    });
});

describe('FR-007: question gate widened by career cues', () => {
    it('accepts a statement-form career prompt from them (E27) and still rejects me (E28)', () => {
        const cue = () => true;
        assert.equal(shouldTriggerAnswer('Them', 'your biggest weakness', null, false, cue), true);
        assert.equal(shouldTriggerAnswer('them', 'your biggest weakness', null, false, cue), true);
        assert.equal(shouldTriggerAnswer('Me', 'your biggest weakness', null, false, cue), false);
        assert.equal(shouldTriggerAnswer('Them', 'your biggest weakness', 'your biggest weakness', false, cue), false, 'de-dup still applies');
    });

    it('without a cue the gate is unchanged', () => {
        assert.equal(shouldTriggerAnswer('Them', 'your biggest weakness', null, false), false);
        assert.equal(shouldTriggerAnswer('Them', 'your biggest weakness', null, false, () => false), false);
        assert.equal(shouldTriggerAnswer('Them', 'how does GC work?', null, false, () => false), true);
    });

    it('a throwing cue function never breaks the gate', () => {
        assert.equal(shouldTriggerAnswer('Them', 'your biggest weakness', null, false, () => { throw new Error('x'); }), false);
    });

    it('feature disabled → "your biggest weakness" does not trigger (E34, C1)', () => {
        const { s } = service();
        assert.equal(s.career, realCareer);
        s.conversationHistory = ['them: your biggest weakness'];
        s.triggerAnswerIfNeeded('Them', 'your biggest weakness');
        assert.equal(s.answerDebounceTimer, null);
    });

    it('feature enabled → the service consults the module and arms the debounce', () => {
        const { s } = service();
        s.career = stubCareer({ hasCareerCue: () => true });
        s.triggerAnswerIfNeeded('Them', 'your biggest weakness');
        assert.notEqual(s.answerDebounceTimer, null);
        clearTimeout(s.answerDebounceTimer);
    });
});

describe('triggerAnswerIfNeeded and the debounce callback', () => {
    it('prefetches on accepted turns only, and passes the session to getCareerContext', async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        const { s } = service();
        const stub = stubCareer();
        s.career = stub;
        const q = 'Okay, so, tell me about a time you disagreed with a teammate?';
        s.conversationHistory = [`them: ${q}`];
        s.triggerAnswerIfNeeded('Me', 'my own words?');
        s.triggerAnswerIfNeeded('Them', 'just a statement');
        s.triggerAnswerIfNeeded('Them', q);
        assert.deepEqual(stub.calls.prefetch, [q]);
        assert.deepEqual(stub.calls.prefetchSessions, [{ prev: null }]);
        mock.timers.tick(800);
        for (let i = 0; i < 5; i++) await flush();
        assert.equal(stub.calls.getCareerContext.length, 1);
        const { text, session } = stub.calls.getCareerContext[0];
        assert.equal(text, q);
        assert.deepEqual(session, { prev: null, activeCompany: null, question: extractQuestion(q) });
    });

    it('detects the active company from them turns only, once (FR-011, E15)', () => {
        const { s } = service();
        s.career = stubCareer({ detectCompany: text => (/bridge/i.test(text) ? 'Bridge' : /orbit/i.test(text) ? 'Orbit Pay' : null) });
        s.triggerAnswerIfNeeded('Me', 'here at Orbit we');
        assert.equal(s.activeCompany, null);
        s.triggerAnswerIfNeeded('Them', 'Here at Bridge we ship weekly.');
        assert.equal(s.activeCompany, 'Bridge');
        s.triggerAnswerIfNeeded('Them', 'here at Orbit we');
        assert.equal(s.activeCompany, 'Bridge', 'first company spoken wins');
    });

    it('passes the resolved context to makeLiveAnswer and records the personal question for follow-ups', async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        const { s } = service();
        s.career = stubCareer({ getCareerContext: async () => PERSONAL });
        let meta = null;
        s.makeLiveAnswer = async (texts, signal, m) => { meta = m; return null; };
        s.conversationHistory = ['them: Tell me about a time you disagreed?'];
        s.triggerAnswerIfNeeded('Them', 'Tell me about a time you disagreed?');
        mock.timers.tick(800);
        for (let i = 0; i < 5; i++) await flush();
        assert.equal(meta.career, PERSONAL);
        assert.equal(s.careerPrev.route, 'personal');
        assert.deepEqual(s.careerPrev.queryTerms, PERSONAL.queryTerms);
        assert.equal(s.careerPrev.anchorText, PERSONAL.anchorText);
        assert.equal(typeof s.careerPrev.ts, 'number');
    });

    it('prefetches a follow-up with the follow-up state (E41)', () => {
        mock.timers.enable({ apis: ['setTimeout'] });   // the debounce never fires here
        const { s } = service();
        const stub = stubCareer();
        s.career = stub;
        const prev = { route: 'personal', queryTerms: ['disagre'], anchorText: PERSONAL.anchorText, ts: Date.now() };
        s.careerPrev = prev;
        s.conversationHistory = ['them: And what was the outcome?'];
        s.triggerAnswerIfNeeded('Them', 'And what was the outcome?');
        assert.deepEqual(stub.calls.prefetch, ['And what was the outcome?']);
        assert.equal(stub.calls.prefetchSessions[0].prev, prev);
    });

    it('a general answer clears the follow-up state (E17)', async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        const { s } = service();
        s.career = stubCareer({ getCareerContext: async () => GENERAL });
        s.makeLiveAnswer = async () => null;
        s.careerPrev = { route: 'personal', queryTerms: ['x'], ts: Date.now() };
        s.conversationHistory = ['them: what is a mutex?'];
        s.triggerAnswerIfNeeded('Them', 'what is a mutex?');
        mock.timers.tick(800);
        for (let i = 0; i < 5; i++) await flush();
        assert.equal(s.careerPrev, null);
    });

    it('a newer question aborting this one while its context resolves → no LLM call for the aborted one (E22)', async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        const { s } = service();
        const pending = [];
        s.career = stubCareer({
            getCareerContext: (text) => new Promise(resolve => pending.push({ text, resolve })),
        });
        s.conversationHistory = ['them: first question about the harbor?'];
        s.triggerAnswerIfNeeded('Them', 'first question about the harbor?');
        mock.timers.tick(800);
        await flush();
        assert.equal(pending.length, 1);
        const firstController = s.inFlightController;

        s.conversationHistory.push('them: second question about the lighthouse?');
        s.triggerAnswerIfNeeded('Them', 'second question about the lighthouse?');
        mock.timers.tick(800);
        await flush();
        assert.equal(pending.length, 2);
        assert.equal(firstController.signal.aborted, true);
        const secondController = s.inFlightController;

        pending[0].resolve(PERSONAL);                // the aborted question's context arrives late
        for (let i = 0; i < 5; i++) await flush();
        assert.equal(llmCalls.length, 0, 'aborted question never reaches the LLM');
        assert.equal(s.inFlightController, secondController, 'the stale callback does not clear the newer request');
        assert.equal(s.inFlight, true);

        pending[1].resolve(GENERAL);
        for (let i = 0; i < 10; i++) await flush();
        assert.equal(llmCalls.length, 1);
        assert.deepEqual(llmCalls[0], todaysMessages(s.conversationHistory));
        assert.equal(s.inFlight, false);
    });

    it('a throwing career module never blocks the answer (FR-017)', async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        const { s } = service();
        s.career = stubCareer({ getCareerContext: async () => { throw new Error('boom'); } });
        s.conversationHistory = HISTORY.slice();
        s.triggerAnswerIfNeeded('Them', 'Tell me about a time you disagreed with a teammate?');
        mock.timers.tick(800);
        for (let i = 0; i < 10; i++) await flush();
        assert.equal(llmCalls.length, 1);
        assert.deepEqual(llmCalls[0], todaysMessages(HISTORY));
    });
});

describe('resetLiveAnswer clears career session state', () => {
    it('clears careerPrev and activeCompany', () => {
        const { s } = service();
        s.careerPrev = { route: 'personal', queryTerms: ['x'], ts: 1 };
        s.activeCompany = 'Bridge';
        s.resetLiveAnswer();
        assert.equal(s.careerPrev, null);
        assert.equal(s.activeCompany, null);
    });
});

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
const llmOpts = [];         // createStreamingLLM's options, one per answer
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
        createStreamingLLM: (provider, opts) => {
            llmOpts.push(opts);
            return {
                streamChat: async messages => {
                    llmCalls.push(messages);
                    const script = streamScript();
                    const lines = script.map(x => (x.startsWith('data: ') ? x : delta(x)));
                    return sseResponse([...lines, 'data: [DONE]']);
                },
            };
        },
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
    'Answer the interviewer\'s most recent question directly and briefly: the candidate reads it aloud while speaking. ' +
    'Start with a short headline answer (one sentence). ' +
    'When there are supporting points, add at most 3 as a markdown bullet list ' +
    '(each point on its own line beginning with "- "), each about 15 words: about 60 words in all. ' +
    'No closing summary, no extra headed sections, no restating the question. ' +
    'Do not fabricate bullets for a trivial one-line answer. ' +
    'Write the answer in the language that question was asked in (English for English, Portuguese for Portuguese), even when earlier turns or notes are in another language, ' +
    'keeping technical terms as they are commonly said. ' +
    'If there is no clear question or nothing useful to answer, reply EXACTLY: PASSIVE';
// The same instruction for an English turn (the debounce path's): it names the language.
const TODAY_USER_EN = TODAY_USER.replace(
    'Write the answer in the language that question was asked in (English for English, Portuguese for Portuguese), even when earlier turns or notes are in another language, ',
    'The question was asked in English: write the whole answer in English, even when earlier turns or notes are in Portuguese, ',
);

const HISTORY = ['me: hello there', 'them: Tell me about a time you disagreed with a teammate.'];
// The asking turn, quoted ahead of the instruction ('q' in the direct calls below).
const askedLine = turn => `The interviewer's most recent question, their last turn in the transcript: "${turn}"\n\n`;
const todaysMessages = (history, user = TODAY_USER, turn = 'q') => [
    { role: 'system', content: getSystemPrompt('pickle_glass_analysis', '', false).replace('{{CONVERSATION_HISTORY}}', history.slice(-30).join('\n')) },
    { role: 'user', content: askedLine(turn) + user },
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
    llmOpts.length = 0;
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
        assert.deepEqual(llmCalls[0], todaysMessages(HISTORY, TODAY_USER_EN, q));
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
        assert.equal(user.content, `${askedLine('q')}${TODAY_USER}\n\n${PERSONAL.addendum}`);
    });
});

describe('item 10: a lower temperature when notes are injected', () => {
    it('personal, ambiguous or company with a block → 0.3', async () => {
        const { s } = service();
        for (const route of ['personal', 'ambiguous', 'company']) {
            await s.makeLiveAnswer(HISTORY, undefined, { id: 1, question: 'q', career: { ...PERSONAL, route } });
        }
        assert.deepEqual(llmOpts.map(o => o.temperature), [0.3, 0.3, 0.3]);
    });

    it('general, a career route with no block, or no career → 0.7, as today', async () => {
        const { s } = service();
        await s.makeLiveAnswer(HISTORY, undefined, { id: 1, question: 'q', career: GENERAL });
        await s.makeLiveAnswer(HISTORY, undefined, { id: 2, question: 'q', career: { ...PERSONAL, block: '' } });
        await s.makeLiveAnswer(HISTORY, undefined, { id: 3, question: 'q', career: null });
        assert.deepEqual(llmOpts.map(o => o.temperature), [0.7, 0.7, 0.7]);
    });
});

describe('item 11: a length budget on every route', () => {
    it('general and personal both ask for at most 3 bullets, about 60 words, no closing summary; the cap stays 900', async () => {
        const { s } = service();
        await s.makeLiveAnswer(HISTORY, undefined, { id: 1, question: 'q', career: GENERAL });
        await s.makeLiveAnswer(HISTORY, undefined, { id: 2, question: 'q', career: PERSONAL });
        for (const call of llmCalls) {
            const user = call.find(m => m.role === 'user').content;
            assert.match(user, /at most 3 as a markdown bullet list/);
            assert.match(user, /about 60 words in all/);
            assert.match(user, /No closing summary/);
        }
        assert.deepEqual(llmOpts.map(o => o.maxTokens), [900, 900]);
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

describe('FR-007 with the Jev router (spec 2026-10-13-career-router-jev)', () => {
    // A career stub whose router uses Jev: classifyTurn answers when the test says so.
    function jevStub(overrides = {}) {
        const pending = [];
        const stub = stubCareer({
            gateUsesJev: () => true,
            hasCareerCue: () => { throw new Error('the regex gate is not used for statements while Jev is on'); },
            classifyTurn: (text, session) => new Promise(resolve => pending.push({ text, session, resolve })),
            ...overrides,
        });
        stub.pending = pending;
        return stub;
    }
    const personal = { route: 'personal', cue: 'jev:personal@0.90', source: 'jev', fallback: null };

    it('a question keeps the synchronous gate: armed at once, Jev not asked', () => {
        const { s } = service();
        const stub = jevStub();
        s.career = stub;
        s.triggerAnswerIfNeeded('Them', 'How does garbage collection work?');
        assert.notEqual(s.answerDebounceTimer, null);
        assert.equal(stub.pending.length, 0);
        assert.deepEqual(stub.calls.prefetch, ['How does garbage collection work?']);
        clearTimeout(s.answerDebounceTimer);
    });

    it('a statement-form career prompt is armed once Jev says personal, with the session it was asked with', async () => {
        const { s } = service();
        const stub = jevStub();
        s.career = stub;
        s.activeCompany = 'Bridge';
        s.triggerAnswerIfNeeded('Them', 'your biggest weakness');
        assert.equal(s.answerDebounceTimer, null, 'not armed before Jev answers');
        assert.equal(stub.pending.length, 1);
        assert.deepEqual(stub.pending[0].session, { prev: null, activeCompany: 'Bridge' });
        stub.pending[0].resolve(personal);
        await flush();
        assert.notEqual(s.answerDebounceTimer, null);
        assert.deepEqual(stub.calls.prefetch, ['your biggest weakness']);
        clearTimeout(s.answerDebounceTimer);
    });

    it('company arms too; general, ambiguous or null do not', async () => {
        for (const [decision, armed] of [
            [{ route: 'company', source: 'jev', fallback: null }, true],
            [{ route: 'general', source: 'jev', fallback: null }, false],
            [{ route: 'ambiguous', source: 'jev', fallback: null }, false],
            [null, false],
        ]) {
            const { s } = service();
            const stub = jevStub();
            s.career = stub;
            s.triggerAnswerIfNeeded('Them', 'a statement');
            stub.pending[0].resolve(decision);
            await flush();
            assert.equal(s.answerDebounceTimer !== null, armed, JSON.stringify(decision));
            if (s.answerDebounceTimer) clearTimeout(s.answerDebounceTimer);
        }
    });

    it('a regex fallback decision arms the same way', async () => {
        const { s } = service();
        const stub = jevStub();
        s.career = stub;
        s.triggerAnswerIfNeeded('Them', 'your biggest weakness');
        stub.pending[0].resolve({ route: 'personal', cue: 'background:your-trait', source: 'regex', fallback: 'timeout' });
        await flush();
        assert.notEqual(s.answerDebounceTimer, null);
        clearTimeout(s.answerDebounceTimer);
    });

    it('a newer question armed while Jev answered → the older statement is dropped', async () => {
        const { s } = service();
        const stub = jevStub();
        s.career = stub;
        s.triggerAnswerIfNeeded('Them', 'your biggest weakness');
        s.triggerAnswerIfNeeded('Them', 'What is a mutex?');
        const timer = s.answerDebounceTimer;
        stub.pending[0].resolve(personal);
        await flush();
        assert.equal(s.answerDebounceTimer, timer, 'the newer question keeps its timer');
        assert.deepEqual(stub.calls.prefetch, ['What is a mutex?']);
        clearTimeout(s.answerDebounceTimer);
    });

    it('a non-career statement after a career one does not cancel it', async () => {
        const { s } = service();
        const stub = jevStub();
        s.career = stub;
        s.triggerAnswerIfNeeded('Them', 'your biggest weakness');
        s.triggerAnswerIfNeeded('Them', 'take your time');
        stub.pending[1].resolve({ route: 'general', source: 'jev', fallback: null });
        stub.pending[0].resolve(personal);
        await flush();
        assert.notEqual(s.answerDebounceTimer, null);
        assert.deepEqual(stub.calls.prefetch, ['your biggest weakness']);
        clearTimeout(s.answerDebounceTimer);
    });

    it('a reset, a pause or Answer turned off while Jev answers → nothing is armed', async () => {
        for (const act of [s => s.resetLiveAnswer(), s => s.pauseLiveAnswer(), s => s.setLiveFeatures('insights')]) {
            const { s } = service();
            const stub = jevStub();
            s.career = stub;
            s.triggerAnswerIfNeeded('Them', 'your biggest weakness');
            act(s);
            stub.pending[0].resolve(personal);
            await flush();
            assert.equal(s.answerDebounceTimer, null);
        }
    });

    it('de-dup still applies to a statement Jev accepts', async () => {
        const { s } = service();
        const stub = jevStub();
        s.career = stub;
        s.lastAnsweredTail = 'your biggest weakness';
        s.triggerAnswerIfNeeded('Them', 'your biggest weakness');
        stub.pending[0].resolve(personal);
        await flush();
        assert.equal(s.answerDebounceTimer, null);
    });

    it('me turns never ask Jev; a rejecting or throwing classifyTurn never breaks the gate', async () => {
        const { s } = service();
        const stub = jevStub();
        s.career = stub;
        s.triggerAnswerIfNeeded('Me', 'my biggest weakness');
        assert.equal(stub.pending.length, 0);
        s.career = jevStub({ classifyTurn: async () => { throw new Error('boom'); } });
        s.triggerAnswerIfNeeded('Them', 'your biggest weakness');
        await flush();
        assert.equal(s.answerDebounceTimer, null);
        s.career = jevStub({ classifyTurn: () => { throw new Error('sync boom'); } });
        s.triggerAnswerIfNeeded('Them', 'your biggest weakness');
        assert.equal(s.answerDebounceTimer, null);
    });

    it('gateUsesJev false (no key, open circuit) → today\'s synchronous regex gate', () => {
        const { s } = service();
        s.career = stubCareer({ gateUsesJev: () => false, hasCareerCue: () => true, classifyTurn: () => { throw new Error('not called'); } });
        s.triggerAnswerIfNeeded('Them', 'your biggest weakness');
        assert.notEqual(s.answerDebounceTimer, null);
        clearTimeout(s.answerDebounceTimer);
    });

    it('the full path: Jev gate, debounce, then the context and the answer', async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        const { s } = service();
        const stub = jevStub({ getCareerContext: async (text, session) => { stub.calls.getCareerContext.push({ text, session }); return PERSONAL; } });
        s.career = stub;
        let meta = null;
        s.makeLiveAnswer = async (texts, signal, m) => { meta = m; return null; };
        s.conversationHistory = ['them: your biggest weakness'];
        s.triggerAnswerIfNeeded('Them', 'your biggest weakness');
        stub.pending[0].resolve(personal);
        await flush();
        mock.timers.tick(800);
        for (let i = 0; i < 5; i++) await flush();
        assert.equal(stub.calls.getCareerContext.length, 1);
        assert.equal(meta.career, PERSONAL);
        assert.equal(s.careerPrev.route, 'personal');
    });
});

describe('triggerAnswerIfNeeded and the debounce callback', () => {
    it('prefetches on accepted turns only, and passes the session (with the interviewer segment before, R19) to getCareerContext', async () => {
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
        const before = stub.calls.prefetchSessions[0].before;
        assert.equal(before.text, 'just a statement', 'the them segment before, never a me turn');
        assert.equal(typeof before.ts, 'number');
        assert.deepEqual(stub.calls.prefetchSessions, [{ prev: null, activeCompany: null, before }]);
        mock.timers.tick(800);
        for (let i = 0; i < 5; i++) await flush();
        assert.equal(stub.calls.getCareerContext.length, 1);
        const { text, session } = stub.calls.getCareerContext[0];
        assert.equal(text, q);
        assert.deepEqual(session, { prev: null, activeCompany: null, before, question: extractQuestion(q) });
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
        assert.deepEqual(llmCalls[0], todaysMessages(s.conversationHistory, TODAY_USER_EN, 'second question about the lighthouse?'));
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
        assert.deepEqual(llmCalls[0], todaysMessages(HISTORY, TODAY_USER_EN, 'Tell me about a time you disagreed with a teammate?'));
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

describe('R19: backchannels, Jev\'s asks and the interviewer segment before', () => {
    const POLICY = { min: 0.3, veto: 0.2 };
    function jevStub(overrides = {}) {
        const pending = [];
        const calls = { wantsAnswer: [] };
        const stub = stubCareer({
            gateUsesJev: () => true,
            askPolicy: () => POLICY,
            hasCareerCue: () => false,
            classifyTurn: (text, session) => new Promise(resolve => pending.push({ text, session, resolve })),
            wantsAnswer: async (text, session) => { calls.wantsAnswer.push({ text, session }); return true; },
            ...overrides,
        });
        stub.pending = pending;
        stub.wantCalls = calls.wantsAnswer;
        return stub;
    }

    it('a them backchannel arms nothing and asks Jev nothing', () => {
        const { s } = service();
        const stub = jevStub();
        s.career = stub;
        for (const t of ['Aham.', 'Hã?', 'Pá. E aí?', '1']) s.triggerAnswerIfNeeded('Them', t);
        assert.equal(s.answerDebounceTimer, null);
        assert.equal(stub.pending.length, 0);
        assert.deepEqual(stub.calls.prefetch, []);
    });

    it('a statement arms on Jev\'s route only when its asks reaches the policy min; a regex decision (no asks) arms on its route', async () => {
        for (const [decision, armed] of [
            [{ route: 'personal', cue: 'follow-up', source: 'jev', fallback: null, asks: 0.29 }, false],
            [{ route: 'personal', cue: 'follow-up', source: 'jev', fallback: null, asks: 0.3 }, true],
            [{ route: 'company', cue: 'jev:company@0.9', source: 'jev', fallback: null, asks: 0.8 }, true],
            [{ route: 'general', cue: 'jev:general@0.9', source: 'jev', fallback: null, asks: 0.95 }, false],
            [{ route: 'personal', cue: 'background:your-trait', source: 'regex', fallback: 'timeout', asks: null }, true],
        ]) {
            const { s } = service();
            const stub = jevStub();
            s.career = stub;
            s.triggerAnswerIfNeeded('Them', 'então era você que liderava, sem gerente no meio');
            stub.pending[0].resolve(decision);
            await flush();
            assert.equal(s.answerDebounceTimer !== null, armed, JSON.stringify(decision));
            if (s.answerDebounceTimer) clearTimeout(s.answerDebounceTimer);
        }
    });

    it('the debounce drops a turn Jev says wants no answer: no context, no LLM call, the answer on screen keeps streaming', async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        const { s } = service();
        const stub = jevStub({ wantsAnswer: async () => false });
        s.career = stub;
        const onScreen = new AbortController();
        s.inFlight = true;
        s.inFlightController = onScreen;
        s.conversationHistory = ['them: e aqui a gente faz deploy toda semana, sabe?'];
        s.triggerAnswerIfNeeded('Them', 'e aqui a gente faz deploy toda semana, sabe?');
        mock.timers.tick(800);
        for (let i = 0; i < 5; i++) await flush();
        assert.equal(stub.calls.getCareerContext.length, 0);
        assert.equal(llmCalls.length, 0);
        assert.equal(onScreen.signal.aborted, false, 'the previous answer is not replaced');
        assert.equal(s.lastAnsweredTail, null, 'not recorded as answered');
    });

    it('a wanted turn goes on as before, with the same session the gate used', async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        const { s } = service();
        const stub = jevStub();
        s.career = stub;
        s.makeLiveAnswer = async () => null;
        s.conversationHistory = ['them: Quantos serviços eram?'];
        s.triggerAnswerIfNeeded('Them', 'Quantos serviços eram?');
        mock.timers.tick(800);
        for (let i = 0; i < 5; i++) await flush();
        assert.equal(stub.wantCalls.length, 1);
        assert.equal(stub.calls.getCareerContext.length, 1);
        assert.deepEqual(stub.wantCalls[0].session, stub.calls.prefetchSessions[0]);
    });

    it('a newer turn armed while Jev answers the drop check → the older one is dropped', async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        const { s } = service();
        const waits = [];
        const stub = jevStub({ wantsAnswer: () => new Promise(resolve => waits.push(resolve)) });
        s.career = stub;
        s.makeLiveAnswer = async () => null;
        s.conversationHistory = ['them: first question about the harbor?'];
        s.triggerAnswerIfNeeded('Them', 'first question about the harbor?');
        mock.timers.tick(800);
        await flush();
        assert.equal(waits.length, 1);
        s.triggerAnswerIfNeeded('Them', 'second question about the lighthouse?');
        waits[0](true);
        for (let i = 0; i < 5; i++) await flush();
        assert.equal(stub.calls.getCareerContext.length, 0, 'the stale callback stops');
        clearTimeout(s.answerDebounceTimer);
    });

    it('Jev off: the debounce does not wait on wantsAnswer', async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        const { s } = service();
        const stub = jevStub({ gateUsesJev: () => false, wantsAnswer: async () => { throw new Error('not called'); } });
        s.career = stub;
        s.makeLiveAnswer = async () => null;
        s.conversationHistory = ['them: What is a mutex?'];
        s.triggerAnswerIfNeeded('Them', 'What is a mutex?');
        mock.timers.tick(800);
        for (let i = 0; i < 5; i++) await flush();
        assert.equal(stub.calls.getCareerContext.length, 1);
    });

    it('the interviewer segment before rides along; a backchannel does not replace it; reset clears it', () => {
        const { s } = service();
        const stub = stubCareer();
        s.career = stub;
        s.triggerAnswerIfNeeded('Them', 'e aí, quando vocês migraram para o Kubernetes,');
        s.triggerAnswerIfNeeded('Them', 'Aham.');
        s.triggerAnswerIfNeeded('Me', 'Foram quatro');
        s.triggerAnswerIfNeeded('Them', 'ficaram quantos pods no fim?');
        assert.equal(stub.calls.prefetchSessions.at(-1).before.text, 'e aí, quando vocês migraram para o Kubernetes,');
        clearTimeout(s.answerDebounceTimer);
        s.resetLiveAnswer();
        assert.equal(s.lastThemTurn, null);
    });
});

// Spec 2026-10-16-confirmation-check-answer: a turn that ends only checking the
// candidate is following adds one rule to the instruction; every other turn's
// messages stay byte for byte.
describe('confirmation check rule', () => {
    const { confirmationCheckRule } = SummaryService;
    const CHECK_TURN = 'Depois vem a etapa técnica e a conversa com o gestor, está bem?';
    const CHECK_TURN_EN = 'Next week you talk with the hiring manager, and then we send you the feedback, okay?';
    const CONFIRMATION_CHECK_RULE = confirmationCheckRule(CHECK_TURN);
    const userOf = calls => calls.at(-1)[1].content;

    afterEach(() => { llmCalls.length = 0; });

    it('general route, or career off: the rule follows the PASSIVE line', async () => {
        for (const career of [GENERAL, null]) {
            const { s } = service();
            await s.makeLiveAnswer(HISTORY, undefined, { id: 1, question: CHECK_TURN, career });
            const user = userOf(llmCalls);
            assert.ok(user.endsWith(`reply EXACTLY: PASSIVE\n\n${CONFIRMATION_CHECK_RULE}`), String(career && career.route));
        }
    });

    it('the record\'s whole turn decides, as in the app', async () => {
        const { s } = service();
        const record = { turn: CHECK_TURN, status: null };
        await s.makeLiveAnswer(HISTORY, undefined, { id: 1, question: 'Depois vem a etapa técnica?', career: null, record });
        assert.ok(userOf(llmCalls).includes(CONFIRMATION_CHECK_RULE));
    });

    it('personal or ambiguous route: no rule ("então você liderou a migração, certo?" asks)', async () => {
        for (const route of ['personal', 'ambiguous']) {
            const { s } = service();
            await s.makeLiveAnswer(HISTORY, undefined, { id: 1, question: 'Então você liderou a migração, certo?', career: { ...PERSONAL, route } });
            assert.ok(!userOf(llmCalls).includes(CONFIRMATION_CHECK_RULE), route);
        }
    });

    it('a turn without the check: today\'s messages, byte for byte', async () => {
        const { s } = service();
        await s.makeLiveAnswer(HISTORY, undefined, { id: 1, question: 'q', career: null });
        assert.deepEqual(llmCalls.at(-1), todaysMessages(HISTORY));
    });

    it('the rule asks for one sentence in the candidate\'s voice', () => {
        for (const turn of [CHECK_TURN, CHECK_TURN_EN, 'Okay?']) {
            assert.match(confirmationCheckRule(turn), /ONE short sentence the candidate would say back/);
            assert.match(confirmationCheckRule(turn), /never offer back what the interviewer offered/);
        }
    });

    // FR-004: the tags and examples follow the turn's language.
    it('a Portuguese turn: the 2026-10-16 text, byte for byte', () => {
        assert.equal(
            CONFIRMATION_CHECK_RULE,
            'That turn ends by only checking that the candidate is following ("está bem?", "ok?", "certo?"). ' +
            'If the rest of it tells the candidate something (about the interviewer, the company, the role, the process or the next steps) ' +
            'rather than asking about their experience or knowledge, reply with ONE short sentence the candidate would say back, ' +
            'such as "Perfeito, ficou claro." or "Combinado, obrigado.": no bullets, no summary of what was said. ' +
            'Speak as the candidate: never offer back what the interviewer offered. Otherwise answer as above.'
        );
    });

    it('an English turn: English tags and examples, no Portuguese one to copy', async () => {
        const { s } = service();
        await s.makeLiveAnswer(HISTORY, undefined, { id: 1, question: CHECK_TURN_EN, career: GENERAL });
        const user = userOf(llmCalls);
        assert.ok(user.endsWith(`reply EXACTLY: PASSIVE\n\n${confirmationCheckRule(CHECK_TURN_EN)}`));
        assert.match(user, /"Perfect, that's clear\."/);
        assert.match(user, /would say back in English,/);
        assert.doesNotMatch(user, /Perfeito|Combinado|está bem/);
    });

    it('a turn of unknown language: one example of each, in the interviewer\'s language', () => {
        const rule = confirmationCheckRule('Okay?');
        assert.match(rule, /"Perfect, that's clear\." or "Perfeito, ficou claro\."/);
        assert.match(rule, /in the language the interviewer is speaking/);
    });
});

// Future-work item 9: a scenario set up over turns gets one answer, after its
// question, and that answer quotes the scenario; a turn quoting questions
// someone else will ask gets a rule. Invented text (spec C5).
describe('item 9: a scenario held for its question, and reported questions', () => {
    const SETUP_1 = 'Tudo bem? Perfeito. Eu queria colocar um cenário, vamos imaginar que a gente tem um endpoint que recebe um CSV grande.';
    const SETUP_2 = 'Imagina que o pod tem pouca memória e o arquivo é maior que ela.';
    const QUESTION = 'Como você processaria esse arquivo sem derrubar o pod?';

    it('set-up turns arm nothing and cost no career call; the question is answered once, quoting them', async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        const { s } = service();
        const stub = stubCareer();
        s.career = stub;
        const metas = [];
        s.makeLiveAnswer = async (texts, signal, m) => { metas.push(m); return null; };
        s.conversationHistory = [`them: ${SETUP_1}`];
        s.triggerAnswerIfNeeded('Them', SETUP_1);
        s.conversationHistory.push(`them: ${SETUP_2}`);
        s.triggerAnswerIfNeeded('Them', SETUP_2);
        mock.timers.tick(800);
        for (let i = 0; i < 5; i++) await flush();
        assert.equal(metas.length, 0, 'no answer while the scenario is set up');
        assert.deepEqual(stub.calls.prefetch, []);
        assert.equal(s.heldSetup.length, 2);

        s.conversationHistory.push(`them: ${QUESTION}`);
        s.triggerAnswerIfNeeded('Them', QUESTION);
        mock.timers.tick(800);
        for (let i = 0; i < 5; i++) await flush();
        assert.equal(metas.length, 1);
        assert.equal(metas[0].record.turn, `${SETUP_1} ${SETUP_2} ${QUESTION}`);
        assert.equal(metas[0].question, extractQuestion(QUESTION));
        assert.deepEqual(s.heldSetup, []);
    });

    it('a set-up held too long ago is not quoted; resetLiveAnswer drops the hold', async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        const { s } = service();
        s.career = stubCareer();
        let meta = null;
        s.makeLiveAnswer = async (texts, signal, m) => { meta = m; return null; };
        s.heldSetup = [{ text: SETUP_1, ts: Date.now() - 10 * 60_000 }];
        s.conversationHistory = [`them: ${QUESTION}`];
        s.triggerAnswerIfNeeded('Them', QUESTION);
        mock.timers.tick(800);
        for (let i = 0; i < 5; i++) await flush();
        assert.equal(meta.record.turn, QUESTION);

        s.triggerAnswerIfNeeded('Them', SETUP_1);
        assert.equal(s.heldSetup.length, 1);
        s.resetLiveAnswer();
        assert.deepEqual(s.heldSetup, []);
    });

    it('a turn quoting someone else\'s questions next to one for the candidate gets the reported rule', async () => {
        const { s } = service();
        const turn = 'They will ask about your Kafka work later. But first, how do you handle retries?';
        await s.makeLiveAnswer(HISTORY, undefined, { id: 1, question: extractQuestion(turn), career: GENERAL, record: { turn } });
        const user = llmCalls.at(-1)[1].content;
        assert.ok(user.endsWith('reply EXACTLY: PASSIVE\n\nPart of that turn quotes questions someone else will ask later, as examples. ' +
            'Answer only what the interviewer asks the candidate now; if that is nothing, reply EXACTLY: PASSIVE'), user);
    });

    it('a turn with no reported speech: no rule (SC-005 keeps the rest byte-identical)', async () => {
        const { s } = service();
        await s.makeLiveAnswer(HISTORY, undefined, { id: 1, question: 'q', career: GENERAL, record: { turn: 'How do you handle retries?' } });
        assert.doesNotMatch(llmCalls.at(-1)[1].content, /someone else will ask/);
    });
});

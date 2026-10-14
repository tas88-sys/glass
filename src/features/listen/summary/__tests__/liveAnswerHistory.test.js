/**
 * liveAnswerHistory.test.js — spec 2026-10-13-live-answer-history (FR-001..FR-005)
 *
 * Run: node --test src/features/listen/summary/__tests__/liveAnswerHistory.test.js
 *
 * The repository runs on node:sqlite in memory, with the app's own schema (the
 * app's better-sqlite3 is built for Electron). The Listen lane's wiring uses a
 * mocked LLM stream (createStreamingLLM replaced through require.cache before
 * summaryService loads) and a recording repository. Fixtures are invented.
 */

'use strict';

const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

delete process.env.CAREER_KB_PATH;   // the real career singleton stays disabled here

const { createLiveAnswerRepository, MAX_TEXT_CHARS } = require('../repositories/liveAnswers');
const SCHEMA = require('../../../common/config/schema');

function memoryDb() {
    const db = new DatabaseSync(':memory:');
    const cols = SCHEMA.live_answers.columns.map(c => `"${c.name}" ${c.type}`).join(', ');
    db.exec(`CREATE TABLE live_answers (${cols})`);
    return db;
}

const ROW = {
    sessionId: 's1',
    askedAt: 1000,
    turn: 'So, tell me about a migration you led?',
    question: 'tell me about a migration you led?',
    answer: 'Headline.\n- point',
    status: 'answer',
    model: 'test-model',
    route: 'personal',
    routeSource: 'jev',
    cue: 'jev:personal@0.91',
    sources: ['stories › Migration', 'canonical facts'],
    unverified: ['42%'],
    firstTokenMs: 640,
    totalMs: 1900,
};

describe('liveAnswers repository', () => {
    it('keeps every field, lists by session in the order asked', () => {
        const db = memoryDb();
        const repo = createLiveAnswerRepository({ getDb: () => db, now: () => 5000 });
        assert.ok(repo.save({ ...ROW, askedAt: 2000, question: 'second?' }).id);
        assert.ok(repo.save(ROW).id);
        repo.save({ ...ROW, sessionId: 'other' });

        const rows = repo.getBySessionId('s1');
        assert.equal(rows.length, 2);
        assert.deepEqual(rows.map(r => r.question), [ROW.question, 'second?']);
        const r = rows[0];
        assert.equal(r.turn, ROW.turn);
        assert.equal(r.answer, ROW.answer);
        assert.equal(r.status, 'answer');
        assert.equal(r.model, 'test-model');
        assert.equal(r.route, 'personal');
        assert.equal(r.route_source, 'jev');
        assert.equal(r.cue, 'jev:personal@0.91');
        assert.deepEqual(JSON.parse(r.sources_json), ROW.sources);
        assert.deepEqual(JSON.parse(r.unverified_json), ['42%']);
        assert.equal(r.first_token_ms, 640);
        assert.equal(r.total_ms, 1900);
        assert.equal(r.asked_at_ms, 1000);
        assert.equal(r.created_at, 5);
    });

    it('writes nothing when off, while signed in, or without a session', () => {
        const db = memoryDb();
        const off = createLiveAnswerRepository({ getDb: () => db, env: { LIVE_ANSWER_HISTORY: '0' } });
        const signedIn = createLiveAnswerRepository({ getDb: () => db, isLocal: () => false });
        const on = createLiveAnswerRepository({ getDb: () => db, env: {} });
        assert.equal(off.save(ROW), null);
        assert.equal(signedIn.save(ROW), null);
        assert.equal(on.save({ ...ROW, sessionId: null }), null);
        assert.equal(on.save(null), null);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM live_answers').get().n, 0);
        assert.equal(off.enabled(), false);
        assert.equal(on.enabled(), true);
    });

    it('stores an unknown status as error, empty lists as null, and clips long text', () => {
        const db = memoryDb();
        const repo = createLiveAnswerRepository({ getDb: () => db });
        repo.save({ ...ROW, status: 'weird', sources: [], unverified: undefined, answer: 'x'.repeat(MAX_TEXT_CHARS + 50), firstTokenMs: undefined });
        const [r] = repo.getBySessionId('s1');
        assert.equal(r.status, 'error');
        assert.equal(r.sources_json, null);
        assert.equal(r.unverified_json, null);
        assert.equal(r.answer.length, MAX_TEXT_CHARS);
        assert.equal(r.first_token_ms, null);
    });
});

// --- The Listen lane ---------------------------------------------------------

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
            streamChat: async () => {
                const script = streamScript();
                if (script instanceof Error) throw script;
                return sseResponse([...script.map(x => (x.startsWith('data: ') ? x : delta(x))), 'data: [DONE]']);
            },
        }),
    },
};
const modelStateService = require('../../../common/services/modelStateService');
modelStateService.getCurrentModelInfo = async () => ({ provider: 'groq', model: 'model-a,model-b', apiKey: 'test-key' });

const SummaryService = require('../summaryService');

const CAREER = {
    route: 'personal',
    cue: 'jev:personal@0.91',
    routeSource: 'jev',
    routeFallback: null,
    block: '[stories › Migration]\nInvented story body.',
    addendum: '',
    sources: ['stories › Migration'],
    chunkIds: ['aaaaaaaaaaaa'],
    queryTerms: ['migrat'],
    anchorText: 'tell me about a migration you led?',
    timings: { routeMs: 0, bm25Ms: 0, vectorMs: 0, vectorUsed: false, totalMs: 0 },
};

function lane({ career = CAREER, sessionId = 's1', repo } = {}) {
    const s = new SummaryService();
    s.sendToRenderer = () => {};
    s.career = {
        hasCareerCue: () => false,
        detectCompany: () => null,
        prefetch: () => {},
        getCareerContext: async () => career,
        checkAnswer: () => [],
    };
    s.setSessionId(sessionId);
    const saved = [];
    s.liveAnswers = repo || { save: r => saved.push({ ...r }) };
    return { s, saved };
}

const flush = async () => {
    for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
};
const QUESTION = 'So, tell me about a migration you led?';

async function ask(s, text = QUESTION) {
    s.conversationHistory.push(`them: ${text}`);
    s.triggerAnswerIfNeeded('Them', text);
    mock.timers.tick(800);
    await flush();
}

describe('Listen lane keeps each answer', () => {
    afterEach(() => {
        streamScript = () => ['Headline answer here.\n', '- point one\n'];
        mock.timers.reset();
    });

    it('an answer: the turn, the text, the model that answered, the route and its notes, the times', async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        streamScript = () => [`data: ${JSON.stringify({ _final_model: 'model-b' })}`, 'Headline answer here.\n', '- point one\n'];
        const { s, saved } = lane();
        await ask(s);
        assert.equal(saved.length, 1);
        const r = saved[0];
        assert.equal(r.sessionId, 's1');
        assert.equal(r.turn, QUESTION);
        assert.equal(r.question, 'tell me about a migration you led?');
        assert.equal(r.answer, 'Headline answer here.\n- point one\n');
        assert.equal(r.status, 'answer');
        assert.equal(r.model, 'model-b');
        assert.equal(r.route, 'personal');
        assert.equal(r.routeSource, 'jev');
        assert.equal(r.cue, 'jev:personal@0.91');
        assert.deepEqual(r.sources, ['stories › Migration']);
        assert.ok(Number.isFinite(r.firstTokenMs) && r.firstTokenMs >= 0);
        assert.ok(Number.isFinite(r.totalMs) && r.totalMs >= r.firstTokenMs);
    });

    it('the first model of the list when the stream names none; the regex fallback as its source', async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        const { s, saved } = lane({ career: { ...CAREER, routeSource: 'regex', routeFallback: 'timeout' } });
        await ask(s);
        assert.equal(saved[0].model, 'model-a');
        assert.equal(saved[0].routeSource, 'regex(timeout)');
    });

    it('PASSIVE is kept as passive, with no text', async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        streamScript = () => ['PASSIVE'];
        const { s, saved } = lane();
        await ask(s);
        assert.equal(saved.length, 1);
        assert.equal(saved[0].status, 'passive');
        assert.equal(saved[0].answer, '');
    });

    it('a failed call is kept as error, with the message', async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        streamScript = () => Object.assign(new Error('rate limited'), { userMessage: 'All Groq models failed (3 attempts).' });
        const { s, saved } = lane();
        const originalError = console.error;
        console.error = () => {};
        try {
            await ask(s);
        } finally {
            console.error = originalError;
        }
        assert.equal(saved.length, 1);
        assert.equal(saved[0].status, 'error');
        assert.equal(saved[0].error, 'All Groq models failed (3 attempts).');
        assert.equal(saved[0].answer, undefined);
    });

    it('an answer a newer question cut off is kept as replaced', async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        const { s, saved } = lane();
        let release;
        s.career.getCareerContext = () => new Promise(r => { release = () => r(CAREER); });
        await ask(s);
        s.inFlightController.abort();
        release();
        await flush();
        assert.equal(saved.length, 1);
        assert.equal(saved[0].status, 'replaced');
    });

    it('no session, no row; a repository that throws costs the row, never the answer', async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        const none = lane({ sessionId: null });
        await ask(none.s);
        assert.equal(none.saved.length, 0);

        const errors = [];
        const originalError = console.error;
        console.error = (...a) => errors.push(a.join(' '));
        try {
            const broken = lane({ repo: { save: () => { throw new Error('disk full'); } } });
            const answers = [];
            broken.s.sendToRenderer = (ch, d) => { if (ch === 'live-answer-update' && d.answer) answers.push(d.answer); };
            await ask(broken.s);
            assert.ok(answers.length > 0, 'the answer still reached the panel');
            assert.equal(broken.s.inFlight, false);
        } finally {
            console.error = originalError;
        }
        assert.ok(errors.some(e => e.includes('history row not saved') && e.includes('disk full')));
        assert.ok(!errors.some(e => e.includes('Headline answer')), 'the answer text is never logged');
    });
});

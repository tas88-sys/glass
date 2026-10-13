/**
 * jevClient.test.js — spec 2026-10-13-career-router-jev (FR-002, FR-004, FR-010, FR-011)
 *
 * Run: node --test src/features/common/career/__tests__/jevClient.test.js
 *
 * The request and response shapes follow docs.typesafe.ai/api (checked
 * 2026-10-13). fetch is a fake; nothing leaves the machine. Fixtures are
 * invented text only (spec C5).
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
    ENDPOINT,
    DEFAULT_MODEL,
    ROUTES,
    MAX_NAMES,
    MAX_NAME_CHARS,
    MAX_TURN_CHARS,
    MAX_PREV_CHARS,
    JevError,
    buildRequest,
    parseResponse,
    post,
    validateKey,
} = require('../jevClient');

const answer = (route = 'personal', confidence = 0.9, extra = {}) => ({
    model: 'jev-1.13.0',
    answers: {
        route: { type: 'choice', choice: route, probabilities: { [route]: confidence }, confidence },
        ...extra,
    },
    usage: { input_tokens: 400, output_tokens: 20 },
});

function fakeFetch(handler) {
    const calls = [];
    const fn = async (url, init) => {
        calls.push({ url, init, body: JSON.parse(init.body) });
        return handler(url, init);
    };
    fn.calls = calls;
    return fn;
}
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

describe('buildRequest (FR-002, FR-011)', () => {
    it('one choice question with the four routes, a fixed model, the turn in state', () => {
        const body = buildRequest('  Tell me about a time you led a migration.  ');
        assert.equal(body.model, DEFAULT_MODEL);
        assert.match(body.model, /^jev-\d+\.\d+\.\d+$/, 'a version, never an alias');
        assert.deepEqual(body.state, { turn: 'Tell me about a time you led a migration.' });
        assert.deepEqual(Object.keys(body.questions), ['route']);
        const q = body.questions.route;
        assert.equal(q.type, 'choice');
        assert.equal(typeof q.instructions, 'string');
        assert.deepEqual(Object.keys(q.criteria), ROUTES);
        for (const r of ROUTES) assert.equal(typeof q.criteria[r], 'string');
    });

    it('is bilingual: the instructions say so and every criterion has an English and a Portuguese example', () => {
        const q = buildRequest('x').questions.route;
        assert.match(q.instructions, /English or Brazilian Portuguese/);
        assert.match(q.instructions, /speech-to-text errors/);
        for (const r of ROUTES) assert.match(q.criteria[r], /E\.g\. "[^"]+" \/ "[^"]+"/, r);
    });

    it('asks the follow-up question only with a previous question, and keeps its end', () => {
        const long = `${'filler words '.repeat(100)}What was your role in the harbor migration?`;
        const body = buildRequest('And then?', { previousQuestion: long, previousRoute: 'personal' });
        assert.equal(body.questions.follow_up.type, 'noul');
        assert.match(body.questions.follow_up.instructions, /English or Brazilian Portuguese/);
        assert.equal(body.state.previous_route, 'personal');
        assert.equal(body.state.previous_question.length, MAX_PREV_CHARS);
        assert.ok(body.state.previous_question.endsWith('harbor migration?'));
        assert.ok(!('follow_up' in buildRequest('And then?', { previousRoute: 'personal' }).questions));
        assert.ok(!('previous_route' in buildRequest('And then?', { previousRoute: 'personal' }).state));
    });

    it('sends the names: deduplicated, trimmed, capped in count and length', () => {
        const many = Array.from({ length: MAX_NAMES + 10 }, (_, i) => `Project ${i}`);
        const body = buildRequest('x', {
            entities: ['Harbor Lights', ' harbor lights ', '', null, 'Q'.repeat(200), ...many],
            companies: ['Bridge', 'Lumen Works'],
            interviewerCompany: '  Bridge ',
        });
        assert.equal(body.state.candidate_names[0], 'Harbor Lights');
        assert.equal(body.state.candidate_names[1].length, MAX_NAME_CHARS);
        assert.equal(body.state.candidate_names.length, MAX_NAMES);
        assert.deepEqual(body.state.note_companies, ['Bridge', 'Lumen Works']);
        assert.equal(body.state.interviewer_company, 'Bridge');
    });

    it('leaves empty context out and caps a long turn', () => {
        const body = buildRequest('y'.repeat(MAX_TURN_CHARS + 50), { entities: [], companies: [], interviewerCompany: '' });
        assert.deepEqual(Object.keys(body.state), ['turn']);
        assert.equal(body.state.turn.length, MAX_TURN_CHARS);
    });

    it('takes another model id', () => {
        assert.equal(buildRequest('x', {}, 'jev-1.14.0').model, 'jev-1.14.0');
    });
});

describe('parseResponse (FR-003)', () => {
    it('reads the documented answer shape', () => {
        const out = parseResponse(answer('company', 0.81, { follow_up: { type: 'noul', noul: 0.12 } }));
        assert.deepEqual(out, { route: 'company', confidence: 0.81, probabilities: { company: 0.81 }, followUp: 0.12, model: 'jev-1.13.0' });
    });

    it('no follow-up answer → followUp null', () => {
        assert.equal(parseResponse(answer()).followUp, null);
    });

    it('null for anything off the documented shape', () => {
        for (const bad of [
            null,
            'text',
            {},
            { answers: null },
            { answers: {} },
            { answers: { route: { choice: 'other', confidence: 0.9 } } },
            { answers: { route: { choice: 'personal' } } },
            { answers: { route: { choice: 'personal', confidence: 1.5 } } },
            { results: { route: { selection: 'personal' } } },
        ]) {
            assert.equal(parseResponse(bad), null, JSON.stringify(bad));
        }
    });

    it('drops a malformed follow-up or probability instead of failing', () => {
        const out = parseResponse(answer('general', 0.7, { follow_up: { noul: 'yes' } }));
        assert.equal(out.followUp, null);
        const odd = answer('general', 0.7);
        odd.answers.route.probabilities = { general: 0.7, bogus: 0.3, personal: 'x' };
        assert.deepEqual(parseResponse(odd).probabilities, { general: 0.7 });
    });
});

describe('post (FR-004, FR-010)', () => {
    it('POSTs JSON with the bearer key to the documented endpoint', async () => {
        const f = fakeFetch(() => json(200, answer()));
        const body = buildRequest('hello');
        const out = await post({ apiKey: 'k-123', body, timeoutMs: 1000, fetchImpl: f });
        assert.deepEqual(out, answer());
        assert.equal(f.calls[0].url, ENDPOINT);
        assert.equal(f.calls[0].init.method, 'POST');
        assert.equal(f.calls[0].init.headers.Authorization, 'Bearer k-123');
        assert.equal(f.calls[0].init.headers['Content-Type'], 'application/json');
        assert.deepEqual(f.calls[0].body, body);
    });

    const kinds = [
        [401, 'auth'],
        [403, 'auth'],
        [422, 'validation'],
        [429, 'rate'],
        [529, 'overload'],
        [503, 'overload'],
        [500, 'http'],
    ];
    for (const [status, kind] of kinds) {
        it(`HTTP ${status} → JevError ${kind}`, async () => {
            const f = fakeFetch(() => json(status, { error: 'nope' }));
            await assert.rejects(post({ apiKey: 'k', body: {}, timeoutMs: 1000, fetchImpl: f }), err => {
                assert.ok(err instanceof JevError);
                assert.equal(err.kind, kind);
                assert.equal(err.status, status);
                return true;
            });
        });
    }

    it('a 422 keeps the field name only when it looks like a key path', async () => {
        const named = fakeFetch(() => json(422, { detail: [{ loc: ['questions', 'route', 'criteria'], msg: 'bad' }] }));
        await assert.rejects(post({ apiKey: 'k', body: {}, timeoutMs: 1000, fetchImpl: named }), err => err.field === 'questions.route.criteria');
        const prose = fakeFetch(() => json(422, { field: 'turn text: Tell me about Harbor Lights' }));
        await assert.rejects(post({ apiKey: 'k', body: {}, timeoutMs: 1000, fetchImpl: prose }), err => err.field === null);
    });

    it('a network failure → net; a body that is not JSON → bad-body', async () => {
        await assert.rejects(
            post({ apiKey: 'k', body: {}, timeoutMs: 1000, fetchImpl: async () => { throw new TypeError('fetch failed'); } }),
            err => err.kind === 'net',
        );
        await assert.rejects(
            post({ apiKey: 'k', body: {}, timeoutMs: 1000, fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('x'); } }) }),
            err => err.kind === 'bad-body',
        );
    });

    it('a slow answer → timeout, and the request is aborted', async () => {
        let signal = null;
        const slow = (url, init) => new Promise((resolve, reject) => {
            signal = init.signal;
            init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
        await assert.rejects(post({ apiKey: 'k', body: {}, timeoutMs: 20, fetchImpl: slow }), err => err.kind === 'timeout');
        assert.equal(signal.aborted, true);
    });

    it('the caller\'s signal aborts the request → aborted', async () => {
        const c = new AbortController();
        const slow = (url, init) => new Promise((resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
        const p = post({ apiKey: 'k', body: {}, timeoutMs: 5000, fetchImpl: slow, signal: c.signal });
        c.abort();
        await assert.rejects(p, err => err.kind === 'aborted');
    });

    it('error messages carry the kind and status only, never the request', async () => {
        const f = fakeFetch(() => json(429, {}));
        await assert.rejects(post({ apiKey: 'secret-key', body: buildRequest('Tell me about Harbor Lights', { entities: ['Harbor Lights'] }), timeoutMs: 1000, fetchImpl: f }), err => {
            assert.equal(err.message, 'jev rate 429');
            return true;
        });
    });
});

describe('validateKey (Settings)', () => {
    it('one minimal call with the key; 200 → saved', async () => {
        const f = fakeFetch(() => json(200, { model: 'jev-1.13.0', answers: { ok: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 20, output_tokens: 1 } }));
        assert.deepEqual(await validateKey({ apiKey: ' k-1 ', fetchImpl: f }), { success: true });
        assert.equal(f.calls[0].init.headers.Authorization, 'Bearer k-1');
        assert.deepEqual(Object.keys(f.calls[0].body.questions), ['ok']);
        assert.equal(f.calls[0].body.questions.ok.type, 'noul');
        assert.ok(JSON.stringify(f.calls[0].body).length < 200, 'a few tokens, not the route criteria');
    });

    it('401/403 → rejected with the status', async () => {
        for (const s of [401, 403]) {
            const r = await validateKey({ apiKey: 'bad', fetchImpl: fakeFetch(() => json(s, {})) });
            assert.equal(r.success, false);
            assert.match(r.error, new RegExp(String(s)));
        }
    });

    it('a failure that says nothing about the key → saved unverified', async () => {
        assert.deepEqual(await validateKey({ apiKey: 'k', fetchImpl: fakeFetch(() => json(529, {})) }), { success: true, unverified: 'overload' });
        assert.deepEqual(await validateKey({ apiKey: 'k', fetchImpl: async () => { throw new TypeError('fetch failed'); } }), { success: true, unverified: 'net' });
    });

    it('an empty key → refused without a call', async () => {
        const f = fakeFetch(() => json(200, {}));
        assert.equal((await validateKey({ apiKey: '  ', fetchImpl: f })).success, false);
        assert.equal(f.calls.length, 0);
    });
});

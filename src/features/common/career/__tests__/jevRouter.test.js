/**
 * jevRouter.test.js — spec 2026-10-13-career-router-jev (FR-001, FR-003 to FR-006, FR-009, FR-010)
 *
 * Run: node --test src/features/common/career/__tests__/jevRouter.test.js
 *
 * fetch is a fake and the clock is injected; nothing leaves the machine.
 * Fixtures are invented text only (spec C5): the names below are made up.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createJevRouter, readConfig, DEFAULTS, BREAKER_FAILURES, BREAKER_COOL_MS, CACHE_SIZE } = require('../jevRouter');
const { classifyCareerIntent, FOLLOW_UP_WINDOW_MS } = require('../intentRouter');

const KEY = { TYPESAFE_API_KEY: 'test-key' };
const ENTITIES = ['Harbor Lights', 'Quillsoft'];
const COMPANIES = ['Bridge', 'Lumen Works'];
const T0 = 1_000_000;

const body = (route, confidence = 0.9, followUp) => ({
    model: 'jev-1.13.0',
    answers: {
        route: { type: 'choice', choice: route, probabilities: { [route]: confidence }, confidence },
        ...(followUp === undefined ? {} : { follow_up: { type: 'noul', noul: followUp } }),
    },
    usage: { input_tokens: 400, output_tokens: 20 },
});
const ok = b => ({ ok: true, status: 200, json: async () => b });
const status = s => ({ ok: false, status: s, json: async () => ({}) });

/** A fake fetch answering from a queue (or a function), recording the request bodies. */
function fakeFetch(reply) {
    const bodies = [];
    const fn = async (url, init) => {
        bodies.push(JSON.parse(init.body));
        const r = typeof reply === 'function' ? reply(bodies.length) : reply;
        if (r instanceof Error) throw r;
        return r;
    };
    fn.bodies = bodies;
    return fn;
}

function router(reply, { env = KEY, clock } = {}) {
    const lines = [];
    const fetchImpl = fakeFetch(reply);
    const time = clock || { t: T0 };
    const r = createJevRouter({ env, fetchImpl, now: () => time.t, log: l => lines.push(l), requestTimeoutMs: 200 });
    return { r, fetchImpl, lines, time };
}

const ctx = (extra = {}) => ({ entities: ENTITIES, companies: COMPANIES, activeCompany: null, now: T0, ...extra });
const prevPersonal = (extra = {}) => ({ route: 'personal', ts: T0 - 1000, queryTerms: ['migrat'], anchorText: 'Tell me about a migration you led?', ...extra });

describe('readConfig (FR-009)', () => {
    it('defaults: Jev wanted, fixed model, documented budgets', () => {
        const c = readConfig({});
        assert.equal(c.wanted, 'jev');
        assert.equal(c.apiKey, '');
        assert.equal(c.model, 'jev-1.13.0');
        assert.equal(c.minConfidence, DEFAULTS.minConfidence);
        assert.equal(c.gateTimeoutMs, DEFAULTS.gateTimeoutMs);
        assert.equal(c.resolveBudgetMs, DEFAULTS.resolveBudgetMs);
    });

    it('reads every variable and rejects out-of-range numbers', () => {
        const c = readConfig({
            TYPESAFE_API_KEY: ' k ',
            CAREER_ROUTER: 'JEV',
            CAREER_ROUTER_JEV_MODEL: 'jev-1.14.0',
            CAREER_ROUTER_JEV_MIN_CONF: '0.65',
            CAREER_ROUTER_GATE_TIMEOUT_MS: '500',
            CAREER_ROUTER_RESOLVE_BUDGET_MS: 'soon',
        });
        assert.deepEqual(
            [c.apiKey, c.wanted, c.model, c.minConfidence, c.gateTimeoutMs, c.resolveBudgetMs],
            ['k', 'jev', 'jev-1.14.0', 0.65, 500, DEFAULTS.resolveBudgetMs],
        );
        assert.equal(readConfig({ CAREER_ROUTER_JEV_MIN_CONF: '2' }).minConfidence, DEFAULTS.minConfidence);
    });

    it('regex is the kill switch, and a typo reads as regex (never sends by mistake)', () => {
        assert.equal(readConfig({ CAREER_ROUTER: 'regex' }).wanted, 'regex');
        const typo = readConfig({ CAREER_ROUTER: 'rgex' });
        assert.equal(typo.wanted, 'regex');
        assert.equal(typo.unknownMode, true);
    });
});

describe('Jev off: the regex router, unchanged (FR-001, SC-006)', () => {
    const turns = [
        'Tell me about a time you disagreed with a teammate.',
        'Por que você quer trabalhar com a gente?',
        'How would you design a rate limiter?',
        'What is a mutex?',
    ];
    for (const env of [{}, { ...KEY, CAREER_ROUTER: 'regex' }, { ...KEY, CAREER_ROUTER: 'typo' }]) {
        it(`env ${JSON.stringify(Object.keys(env))} → regex decisions, no call`, async () => {
            const { r, fetchImpl } = router(ok(body('general')), { env });
            for (const t of turns) {
                const d = await r.decide(t, ctx());
                const want = classifyCareerIntent(t, ctx());
                assert.deepEqual({ route: d.route, cue: d.cue }, want);
                assert.equal(d.source, 'regex');
                assert.equal(d.fallback, null);
            }
            assert.equal(fetchImpl.bodies.length, 0);
            assert.equal(r.gateUsesJev(), false);
        });
    }

    it('says once why it uses the regex', async () => {
        const { r, lines } = router(ok(body('general')), { env: {} });
        await r.decide('a', ctx());
        await r.decide('b', ctx());
        assert.deepEqual(lines, ['[career] router: no TYPESAFE_API_KEY; using the regex router']);
    });
});

describe('Jev on: mapping (FR-003)', () => {
    it('a confident answer decides the route, with a jev cue and the call time', async () => {
        const { r, fetchImpl } = router(ok(body('personal', 0.91)));
        const d = await r.decide('Me fala do seu maior aprendizado', ctx({ activeCompany: 'Bridge' }));
        assert.equal(d.route, 'personal');
        assert.equal(d.cue, 'jev:personal@0.91');
        assert.equal(d.source, 'jev');
        assert.equal(d.fallback, null);
        assert.equal(d.confidence, 0.91);
        assert.equal(typeof d.jevMs, 'number');
        const sent = fetchImpl.bodies[0];
        assert.equal(sent.state.turn, 'Me fala do seu maior aprendizado');
        assert.deepEqual(sent.state.candidate_names, ENTITIES);
        assert.deepEqual(sent.state.note_companies, COMPANIES);
        assert.equal(sent.state.interviewer_company, 'Bridge');
        assert.ok(!('follow_up' in sent.questions), 'no previous question → no follow-up question');
    });

    it('Jev overrides the regex both ways', async () => {
        const toGeneral = router(ok(body('general', 0.8))).r;
        assert.equal((await toGeneral.decide('Tell me about a time you disagreed with a teammate.', ctx())).route, 'general');
        const toPersonal = router(ok(body('personal', 0.8))).r;
        assert.equal((await toPersonal.decide('What is a mutex?', ctx())).route, 'personal');
    });

    it('below the confidence floor the regex decides, tagged low', async () => {
        const { r } = router(ok(body('general', 0.41)));
        const t = 'Tell me about a time you disagreed with a teammate.';
        const d = await r.decide(t, ctx());
        assert.deepEqual({ route: d.route, cue: d.cue }, classifyCareerIntent(t, ctx()));
        assert.equal(d.source, 'regex');
        assert.equal(d.fallback, 'low');
        assert.equal(d.confidence, 0.41);
    });

    it('the floor comes from CAREER_ROUTER_JEV_MIN_CONF', async () => {
        const { r } = router(ok(body('general', 0.6)), { env: { ...KEY, CAREER_ROUTER_JEV_MIN_CONF: '0.7' } });
        assert.equal((await r.decide('What is a mutex?', ctx())).fallback, 'low');
    });

    it('a follow-up inside the window keeps the previous route with the follow-up cue (queryTerms carry)', async () => {
        const { r, fetchImpl } = router(ok(body('general', 0.6, 0.83)));
        const prev = prevPersonal();
        const d = await r.decide('E aí, como terminou?', ctx({ prev }));
        assert.deepEqual([d.route, d.cue, d.source, d.confidence], ['personal', 'follow-up', 'jev', 0.83]);
        const sent = fetchImpl.bodies[0];
        assert.equal(sent.state.previous_question, prev.anchorText);
        assert.equal(sent.state.previous_route, 'personal');
        assert.equal(sent.questions.follow_up.type, 'noul');
    });

    it('a company answer is never turned into a follow-up', async () => {
        const { r } = router(ok(body('company', 0.9, 0.95)));
        const d = await r.decide('And why us?', ctx({ prev: prevPersonal() }));
        assert.equal(d.route, 'company');
        assert.equal(d.cue, 'jev:company@0.90');
    });

    it('a low follow-up score → the route answer decides', async () => {
        const { r } = router(ok(body('ambiguous', 0.7, 0.2)));
        const d = await r.decide('How would you scale it now?', ctx({ prev: prevPersonal() }));
        assert.equal(d.route, 'ambiguous');
    });

    it('outside the window, or after a general answer, no previous question is sent', async () => {
        const { r, fetchImpl } = router(ok(body('general', 0.9)));
        await r.decide('And then?', ctx({ prev: prevPersonal({ ts: T0 - FOLLOW_UP_WINDOW_MS - 1 }) }));
        await r.decide('And then??', ctx({ prev: prevPersonal({ route: 'general' }) }));
        for (const b of fetchImpl.bodies) {
            assert.ok(!('previous_question' in b.state));
            assert.ok(!('follow_up' in b.questions));
        }
    });
});

describe('Jev on: fallbacks (FR-004)', () => {
    const t = 'Tell me about a time you disagreed with a teammate.';
    const regex = classifyCareerIntent(t, ctx());
    const cases = [
        ['429', status(429), 'rate'],
        ['529', status(529), 'overload'],
        ['500', status(500), 'http'],
        ['network', new TypeError('fetch failed'), 'net'],
        ['malformed body', ok({ results: {} }), 'bad-body'],
        ['401', status(401), 'auth'],
        ['422', status(422), 'validation'],
    ];
    for (const [name, reply, kind] of cases) {
        it(`${name} → the regex decides, tagged ${kind}`, async () => {
            const { r } = router(reply);
            const d = await r.decide(t, ctx());
            assert.deepEqual({ route: d.route, cue: d.cue }, regex);
            assert.equal(d.source, 'regex');
            assert.equal(d.fallback, kind);
        });
    }

    it('a call slower than the budget → the regex decides, tagged budget; the late answer is cached', async () => {
        let release;
        const gate = new Promise(res => { release = res; });
        const { r, fetchImpl } = router(async () => { await gate; return ok(body('general', 0.9)); });
        const d = await r.decide(t, ctx(), { budgetMs: 10 });
        assert.equal(d.fallback, 'budget');
        assert.equal(d.route, regex.route);
        release();
        await new Promise(res => setTimeout(res, 5));
        const again = await r.decide(t, ctx(), { budgetMs: 10 });
        assert.equal(again.source, 'jev');
        assert.equal(again.route, 'general');
        assert.equal(fetchImpl.bodies.length, 1);
    });

    it('a call past the request timeout → timeout', async () => {
        const { r } = router((n) => new Promise(() => {}));
        const d = await r.decide(t, ctx(), { budgetMs: 1000 });
        assert.equal(d.fallback, 'timeout');
    });

    it('an Infinity budget waits for the call itself (the prefetch), not 1 ms', async () => {
        const { r } = router(async () => {
            await new Promise(res => setTimeout(res, 30));
            return ok(body('general', 0.9));
        });
        const d = await r.decide(t, ctx(), { budgetMs: Infinity });
        assert.equal(d.source, 'jev');
        assert.deepEqual(r.stats().fallbacks, {});
    });

    it('a budget of 0 never waits', async () => {
        const { r } = router(ok(body('general')));
        assert.equal((await r.decide(t, ctx(), { budgetMs: 0 })).fallback, 'budget');
    });

    it('never rejects, even on odd input', async () => {
        const { r } = router(ok(body('general')));
        for (const x of [null, undefined, 42, '', '   ']) {
            const d = await r.decide(x, ctx());
            assert.equal(d.route, 'general');
            assert.equal(d.source, 'regex');
        }
        assert.equal((await r.decide('x', null)).source, 'jev');
    });
});

describe('circuit breaker and disable (FR-005)', () => {
    it(`${BREAKER_FAILURES} failures in a row open the circuit for ${BREAKER_COOL_MS / 1000}s; one probe then closes it`, async () => {
        let healthy = false;
        const { r, fetchImpl, time, lines } = router(() => (healthy ? ok(body('general', 0.9)) : status(529)));
        for (let i = 0; i < BREAKER_FAILURES; i++) assert.equal((await r.decide(`q${i}`, ctx())).fallback, 'overload');
        assert.equal(r.stats().state, 'open');
        assert.equal(r.gateUsesJev(), false, 'the gate stops waiting while open');
        assert.equal((await r.decide('q-open', ctx())).fallback, 'circuit');
        assert.equal(fetchImpl.bodies.length, BREAKER_FAILURES, 'no call while open');

        time.t += BREAKER_COOL_MS + 1;
        healthy = true;
        assert.equal(r.gateUsesJev(), true);
        const probe = await r.decide('q-probe', ctx());
        assert.equal(probe.source, 'jev');
        assert.equal(r.stats().state, 'on');
        assert.ok(lines.some(l => /circuit closed/.test(l)));
    });

    it('a failed probe opens the circuit again', async () => {
        const { r, time } = router(status(529));
        for (let i = 0; i < BREAKER_FAILURES; i++) await r.decide(`q${i}`, ctx());
        time.t += BREAKER_COOL_MS + 1;
        assert.equal((await r.decide('probe', ctx())).fallback, 'overload');
        assert.equal(r.stats().state, 'open');
    });

    it('only one probe runs at a time', async () => {
        let n = 0;
        let release;
        const hold = new Promise(res => { release = res; });
        const { r, time } = router(async () => {
            n++;
            if (n <= BREAKER_FAILURES) return status(529);
            await hold;
            return ok(body('general', 0.9));
        });
        for (let i = 0; i < BREAKER_FAILURES; i++) await r.decide(`q${i}`, ctx());
        time.t += BREAKER_COOL_MS + 1;
        const probe = r.decide('probe', ctx(), { budgetMs: 1000 });
        assert.equal((await r.decide('other', ctx())).fallback, 'circuit');
        release();
        assert.equal((await probe).source, 'jev');
    });

    it('a success resets the failure count', async () => {
        const replies = [status(529), status(529), ok(body('general')), status(529), status(529)];
        const { r } = router(n => replies[n - 1]);
        for (let i = 0; i < replies.length; i++) await r.decide(`q${i}`, ctx());
        assert.equal(r.stats().state, 'on');
    });

    it('401 turns Jev off until restart and logs once, with no text', async () => {
        const { r, fetchImpl, lines } = router(status(401));
        await r.decide('Tell me about Harbor Lights', ctx());
        await r.decide('Tell me about Quillsoft', ctx());
        assert.equal(fetchImpl.bodies.length, 1);
        assert.equal(r.stats().state, 'disabled:auth');
        assert.equal(r.gateUsesJev(), false);
        const off = lines.filter(l => /auth error/.test(l));
        assert.equal(off.length, 1);
    });
});

describe('cache and reuse (FR-006)', () => {
    it('prefetch, the gate and resolve share one call for the same turn and context', async () => {
        const { r, fetchImpl } = router(ok(body('personal', 0.9)));
        const c = ctx({ activeCompany: 'Bridge' });
        r.prefetch('your biggest weakness', c);
        await r.decide('your biggest weakness', c, { budgetMs: 700 });
        await r.decide('your biggest weakness', { ...c, now: T0 + 900 });
        assert.equal(fetchImpl.bodies.length, 1);
    });

    it('a different context is a different call', async () => {
        const { r, fetchImpl } = router(ok(body('personal', 0.9)));
        await r.decide('same words', ctx());
        await r.decide('same words', ctx({ activeCompany: 'Bridge' }));
        await r.decide('same words', ctx({ prev: prevPersonal() }));
        assert.equal(fetchImpl.bodies.length, 3);
    });

    it(`keeps the last ${CACHE_SIZE} turns`, async () => {
        const { r, fetchImpl } = router(ok(body('general', 0.9)));
        await r.decide('turn 0', ctx());
        for (let i = 1; i <= CACHE_SIZE; i++) await r.decide(`turn ${i}`, ctx());
        await r.decide('turn 0', ctx());
        assert.equal(fetchImpl.bodies.length, CACHE_SIZE + 2, 'the oldest was evicted');
    });

    it('prefetch is a no-op with Jev off', () => {
        const { r, fetchImpl } = router(ok(body('general')), { env: {} });
        r.prefetch('your biggest weakness', ctx());
        assert.equal(fetchImpl.bodies.length, 0);
    });
});

describe('logs and stats carry no text (FR-010, C2)', () => {
    it('every log line and the stats are free of the turn and the names', async () => {
        const replies = [status(529), status(529), status(529)];
        const { r, lines, time } = router(n => replies[n - 1] || status(422));
        const turns = ['Tell me about Harbor Lights at Quillsoft', 'Why Bridge?', 'Lumen Works?'];
        for (const t of turns) await r.decide(t, ctx({ activeCompany: 'Bridge' }));
        time.t += BREAKER_COOL_MS + 1;
        await r.decide('Tell me more about Harbor Lights', ctx());
        const all = lines.join('\n') + JSON.stringify(r.stats());
        for (const secret of ['Harbor', 'Quillsoft', 'Bridge', 'Lumen', 'test-key']) assert.ok(!all.includes(secret), secret);
        assert.ok(lines.length >= 2);
    });

    it('stats count calls, failures and fallbacks', async () => {
        const { r } = router(n => (n === 1 ? ok(body('general', 0.9)) : status(429)));
        await r.decide('a', ctx());
        await r.decide('b', ctx());
        const s = r.stats();
        assert.equal(s.calls, 2);
        assert.equal(s.ok, 1);
        assert.deepEqual(s.failed, { rate: 1 });
        assert.deepEqual(s.fallbacks, { rate: 1 });
        assert.equal(s.model, 'jev-1.13.0');
    });
});

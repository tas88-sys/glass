/**
 * intentRouter.test.js — T014 (FR-006, FR-007; E16, E17)
 *
 * Run: node --test src/features/common/career/__tests__/intentRouter.test.js
 *
 * Fixtures are invented text only (spec C5): the employer and company names
 * below are made up.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { classifyCareerIntent, stripCuePhrases, hasCareerCue, FOLLOW_UP_WINDOW_MS } = require('../intentRouter');

const ENTITIES = ['Harbor Lights', 'Quillsoft', 'Northwind Labs'];
const COMPANIES = ['Bridge', 'Lumen Works', 'Orbit Pay'];
const ctx = (extra = {}) => ({ entities: ENTITIES, companies: COMPANIES, ...extra });
const route = (text, extra) => classifyCareerIntent(text, ctx(extra)).route;

function table(name, expected, cases) {
    describe(name, () => {
        for (const text of cases) {
            it(`${expected}: ${JSON.stringify(text)}`, () => {
                const d = classifyCareerIntent(text, ctx());
                assert.equal(d.route, expected, `cue=${d.cue}`);
            });
        }
    });
}

table('personal (English)', 'personal', [
    'Tell me about a time you disagreed with a teammate.',
    'Tell me a bit about yourself.',
    'Describe a time when you had to deliver bad news.',
    'Give me an example of a time you missed a deadline.',
    'Tell me about a project you are proud of.',
    "What's your biggest weakness?",
    'your biggest weakness',
    'What are your main responsibilities?',
    'What have you been doing lately?',
    'Have you ever led a migration?',
    'Have you worked with message queues?',
    'Did you use feature flags there?',
    'How did you handle the outage?',
    'What did you learn from that project?',
    'Do you have experience mentoring junior developers?',
    'Do you have hands-on experience with stream processing in production?',
    'How many years of experience do you have with distributed systems?',
    'Why are you leaving your current job?',
    'Where are you based?',
    'Walk me through your resume.',
    'What was your role in the rewrite?',
    'In your last role, what did the on-call rotation look like?',
    'What are you good at?',
]);

table('personal (Portuguese)', 'personal', [
    'Me conta sobre uma vez em que você discordou do time.',
    'Fale sobre uma experiência em que você entrou em um projeto com problemas.',
    'Conte sobre uma situação em que percebeu que não ia cumprir o prazo.',
    'Fala um pouco de você.',
    'Se apresenta pra gente?',
    'Você já trabalhou com filas?',
    'Já trabalhou com arquitetura orientada a eventos?',
    'Já usou ferramentas de observabilidade?',
    'Como você lidou com isso?',
    'O que você construiu do zero?',
    'Você trouxe ali a questão da velocidade, teve algum impacto?',
    'Você mora em qual cidade?',
    'Com quais serviços de nuvem você trabalha?',
    'Qual ferramenta vocês utilizam e há quanto tempo?',
    'Possui experiência com aplicativos móveis?',
    'Quais foram os últimos feedbacks que você recebeu?',
    'Qual é a sua trajetória até aqui?',
    'O que faz sentido pro teu momento?',
    'Qual a sua pretensão salarial?',
    'Por que está considerando mudar de emprego?',
    'Qual o motivo pra você querer mudar?',
    'Quanto tempo precisaria para começar após receber uma oferta?',
    'Já aconteceu de identificar cedo um problema e agir antes?',
    'O que é uma boa conduta profissional? Dê um exemplo.',
    'Tem algum tema que não abordamos em que você mandaria bem?',
]);

table('personal (employer/project names from the CV)', 'personal', [
    'Ainda trabalha na Harbor Lights?',
    'How big was the team at Quillsoft?',
    'Why is there an overlap between Quillsoft and Northwind Labs?',
    'harborlights was a startup, right?',
]);

table('company', 'company', [
    'Why do you want to join Bridge?',
    'Why do you want to work here?',
    'Why us?',
    'Why are you interested in this role with us?',
    'Why are you interested in working with us?',
    'What do you know about our company?',
    'What do you know about us?',
    'Por que você quer trabalhar aqui na Bridge?',
    'O que você sabe sobre a gente?',
    'E você já conhece a Lumen Works? Já teve algum contato com a gente?',
    'Você se vê nessa vaga?',
    'O que você acha da forma como a empresa se posiciona sobre diversidade?',
]);

table('ambiguous (hypothetical, habitual, opinion)', 'ambiguous', [
    'How would you approach a legacy system with no tests?',
    'How would you design a rate limiter?',
    'What would you do if a release broke production?',
    'Imagine you are leading a team of five.',
    'How do you ensure the reliability of a system?',
    'How do you adapt to changing priorities?',
    'How do you stay technically up to date?',
    "What's your approach to code reviews?",
    'Como você faria a migração de um monolito?',
    'Se presenciasse um colega sofrendo discriminação, como agiria?',
    'Como você explica ideias técnicas para um público não técnico?',
    'Dois membros do time estão em conflito. Como você resolve?',
    'Explique como você implementaria concorrência com filas e workers.',
]);

table('general (no second-person background cue)', 'general', [
    "What's the difference between a mutex and a channel?",
    'What is a goroutine?',
    'How do you stop a goroutine externally?',
    'Explain eventual consistency.',
    'Existe classe nessa linguagem?',
    'Como funciona o tratamento de erros?',
    'Qual a diferença entre buffered e unbuffered?',
    'gRPC ou REST: quando usar cada um?',
    'Quais são os tipos de JOIN?',
    'Give me an example of a race condition.',
    'Do you know what a goroutine is?',
    'Okay, great, thanks.',
    'Pode compartilhar a tela com a gente?',
    'O servidor de testes foi liberado?',
    '',
]);

describe('cue names', () => {
    it('returns a rule name, never the turn text', () => {
        const text = 'Tell me about a time you disagreed with a teammate.';
        const d = classifyCareerIntent(text, ctx());
        assert.equal(typeof d.cue, 'string');
        assert.match(d.cue, /^[a-z]+(?::[a-z0-9-]+)?$/);
        assert.ok(!text.toLowerCase().includes(d.cue.split(':')[1] || '###'), 'cue is not a copy of the text');
    });

    it('general has a null cue', () => {
        assert.deepEqual(classifyCareerIntent('What is a goroutine?', ctx()), { route: 'general', cue: null });
    });

    it('an employer name fires the entity cue', () => {
        assert.equal(classifyCareerIntent('How big was the team at Quillsoft?', ctx()).cue, 'entity');
    });

    it('never throws on bad input', () => {
        assert.deepEqual(classifyCareerIntent(null), { route: 'general', cue: null });
        assert.deepEqual(classifyCareerIntent(42, { entities: [null, 7, ''] }), { route: 'general', cue: null });
        assert.equal(classifyCareerIntent('Tell me about yourself', undefined).route, 'personal');
    });

    it('a name that is not an employer is not an entity cue', () => {
        assert.equal(route('How big was the team at Quillsoft?', { entities: [] }), 'general');
    });
});

describe('follow-ups (FR-006; E16, E17)', () => {
    const now = 1_000_000_000;
    const prev = (route, ago) => ({ route, ts: now - ago, queryTerms: ['migrat'] });

    it('a short follow-up within 5 minutes of a personal answer stays personal (E16)', () => {
        for (const text of ['And what was the outcome?', 'How did that go?', 'And then?', 'E aí?', 'Qual foi o resultado?', 'What did you learn?']) {
            const d = classifyCareerIntent(text, ctx({ prev: prev('personal', 60_000), now }));
            assert.deepEqual(d, { route: 'personal', cue: 'follow-up' }, text);
        }
    });

    it('keeps the company route on a follow-up to a company answer', () => {
        const d = classifyCareerIntent('And then?', ctx({ prev: prev('company', 1000), now }));
        assert.deepEqual(d, { route: 'company', cue: 'follow-up' });
    });

    it('no stickiness after 5 minutes (E17)', () => {
        const d = classifyCareerIntent('And then?', ctx({ prev: prev('personal', FOLLOW_UP_WINDOW_MS + 1), now }));
        assert.equal(d.route, 'general');
    });

    it('no stickiness without a previous personal answer (E17)', () => {
        assert.equal(route('And then?', { prev: null, now }), 'general');
        assert.equal(route('And then?', { prev: prev('general', 1000), now }), 'general');
        assert.equal(route('And then?', { prev: prev('ambiguous', 1000), now }), 'general');
    });

    it('a long turn is not a follow-up even with a marker', () => {
        const text = 'And then we can move on to the next part of the interview about distributed caching strategies';
        assert.equal(route(text, { prev: prev('personal', 1000), now }), 'general');
    });

    it('a short turn without a marker is not a follow-up', () => {
        assert.equal(route('What is a mutex?', { prev: prev('personal', 1000), now }), 'general');
    });
});

describe('stripCuePhrases', () => {
    it('removes framing phrases and keeps the content words', () => {
        const s = stripCuePhrases('Tell me about a time you disagreed with a teammate.');
        assert.ok(!/\btell\b|\btime\b/.test(s), s);
        assert.match(s, /disagreed/);
        assert.match(s, /teammate/);
    });

    it('keeps the subject of a trait question', () => {
        assert.match(stripCuePhrases("What's your biggest weakness?"), /weakness/);
    });

    it('works in Portuguese', () => {
        const s = stripCuePhrases('Me conta sobre uma vez em que você liderou uma migração.');
        assert.ok(!/\bconta\b|\bvez\b/.test(s), s);
        assert.match(s, /liderou/);
        assert.match(s, /migracao/);
    });

    it('removes the wrapper of company questions (the company name supplies the query)', () => {
        assert.equal(stripCuePhrases('Why do you want to join us?'), 'us');
        assert.equal(stripCuePhrases('Why are you interested in working with us?'), 'working with us');
        assert.equal(stripCuePhrases('Por que você quer trabalhar aqui?'), '');
    });

    it('returns "" for non-strings', () => {
        assert.equal(stripCuePhrases(null), '');
    });
});

describe('hasCareerCue (FR-007)', () => {
    it('true for personal and company cues, including statement form', () => {
        assert.equal(hasCareerCue('your biggest weakness', ENTITIES, COMPANIES), true);
        assert.equal(hasCareerCue('why us', ENTITIES, COMPANIES), true);
        assert.equal(hasCareerCue('the team at Quillsoft', ENTITIES, COMPANIES), true);
    });

    it('false for ambiguous and general turns', () => {
        assert.equal(hasCareerCue('how would you design a cache', ENTITIES, COMPANIES), false);
        assert.equal(hasCareerCue('a mutex is a lock', ENTITIES, COMPANIES), false);
    });

    it('ignores follow-up stickiness (no session context)', () => {
        assert.equal(hasCareerCue('and then', ENTITIES, COMPANIES), false);
    });
});

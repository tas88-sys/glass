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
    'Tell me about your team.',
    'What are you working on these days?',
    'What kind of projects do you usually take?',
    'Any experience with stream processing?',
    'Current salary?',
    'What was your biggest project?',
    "What's your biggest project so far?",
    'your biggest project',
    'What were your main tasks there?',
    'Which was your favorite project?',
    'What has been your hardest bug to fix?',
]);

table('personal (English twins of the Portuguese present-tense and job cues)', 'personal', [
    'Do you work remotely today?',
    'Do you currently lead a team?',
    'Which cloud services do you work with?',
    'Do you speak English at work?',
    'Are you interviewing with other companies?',
    'Are you in other hiring processes?',
    'Which tool do you use, and for how long?',
    'What was the latest feedback from your peers?',
    'How many people report to you?',
    'How big is the team you work with?',
    'What would make you move to a new challenge?',
    "What's the reason you want to leave?",
    'How soon could you start after getting an offer?',
    "Is there a topic we haven't covered where you'd do well?",
    'Do you have an example of a scope change you handled?',
    'Can you share an example of having to adapt on a project?',
    'Have you set up linting for Go projects?',
    'How much faster do you deliver with AI?',
    "What's your workflow with AI agents?",
    'Tell me about a launch that went well.',
]);

table('personal (Portuguese, implied subject and habits)', 'personal', [
    'Trabalha remoto hoje?',
    'Conhece filas de mensagens?',
    'Atualmente lidera algum time?',
    'E hoje, usa containers no dia a dia?',
    'O que você faz hoje no projeto?',
    'No que você trabalha atualmente?',
    'Como é o seu dia a dia?',
    'Você usa testes automatizados?',
    'Você é de Curitiba?',
    'Legal. Você é da área de dados?',
    'Na empresa anterior, você liderava o time?',
    'Como engenheiro, você tomava as decisões de arquitetura?',
    'Você fazia plantão?',
    'Você era o único backend?',
    'Está participando de outros processos?',
    'Atualmente está buscando vagas remotas?',
    'Você está conversando com outras empresas?',
    'Precisou lidar com um cliente difícil?',
    'Teve que migrar algum sistema legado?',
    'Tem algum exemplo de mudança de escopo que precisou fazer num projeto?',
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
    'Conte sobre um lançamento que deu certo.',
    'Fale sobre uma entrega que atrasou.',
    'Compartilhe, de forma rápida e objetiva, um dos seus desafios mais técnicos: a complexidade, sua atuação, suas contribuições e os resultados.',
    'Me dê exemplos de cases de sucesso, cases de falha, impactos.',
    'Qual foi a sua atuação nesse projeto?',
    'Quais foram suas principais contribuições?',
    'Me dê exemplos concretos.',
    'Tem alguma história de fracasso pra compartilhar?',
    'Any success stories from last year?',
]);

table('personal (employer/project names from the CV)', 'personal', [
    'Ainda trabalha na Harbor Lights?',
    'How big was the team at Quillsoft?',
    'Why is there an overlap between Quillsoft and Northwind Labs?',
    'harborlights was a startup, right?',
]);

table('personal (the candidate\'s own tools and setup, future-work item 13)', 'personal', [
    'Can you explain your AI setup to the panel?',
    'You can bring your own setup, like your club md and the skills you usually use.',
    'Is your setup the same at home and at work?',
    'Do you keep a CLAUDE.md in every repo?',
    'Which commands are in your coding agent?',
    'Me conta do seu setup de trabalho.',
    'Quais são suas ferramentas favoritas?',
    'Como você usa IA pra escrever testes?',
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
    'Do you ensure the reliability of a system,',   // the STT dropped "How" (live eval)
    'How do you adapt to changing priorities?',
    'How do you stay technically up to date?',
    "What's your approach to code reviews?",
    'Como você faria a migração de um monolito?',
    'Se presenciasse um colega sofrendo discriminação, como agiria?',
    'Como você explica ideias técnicas para um público não técnico?',
    'Dois membros do time estão em conflito. Como você resolve?',
    'A base herdada é grande e sem testes. Como você gerencia isso?',
    'Como você faria se tivesse o dobro do time?',
    'O que você faria com um prazo menor?',
    'Explique como você implementaria concorrência com filas e workers.',
    'How do you raise the bar for the engineers around you?',
    'Which AI tool do you use?',
    "What's a closure? Give an example.",
    'Your team needs to process a million events per second.',
    'How would you work with a legacy codebase?',
    'Tell me about a migration from a monolith to microservices.',
    'Fale sobre um algoritmo de ordenação.',
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
    'Usa-se mutex quando há estado compartilhado?',
    'Tell me about the CAP theorem.',
    'What are the trade-offs of microservices?',
    'Current state of the art in caching?',
    'Está funcionando o áudio?',
    'Está me ouvindo bem?',
    'Você sabia que a linguagem tem generics?',
    'Tem algum exemplo de uso de channel?',
    'Qual foi o bug que causou o incidente?',
    'Usou-se cache nessa arquitetura?',
    'O servidor de testes foi liberado?',
    'What was the root cause of the outage?',
    'What was the biggest project in the history of the language?',
    'Which was the first version with generics?',
    'How long does it take for a pod to become ready?',
    'What happens if you close a channel twice?',
    'What would make your solution more scalable?',
    "What's the reason for using a buffered channel here?",
    'Are you able to see my screen?',
    'Give an example of a deadlock.',
    'Have you set the timeout on the context?',
    'Do you test this function with a table?',
    "What's your stack trace showing?",
    'Tell me about the actor model.',
    'Quais os desafios do Kafka e seus impactos na latência?',
    'Quais casos de falha um circuit breaker cobre?',
    'Dê exemplos de race condition.',
    'Microsserviços e suas vantagens: quando usar?',
    // The setup on screen, not the candidate's (future-work item 13).
    'In your setup, the cache is created before the client, right?',
    'Your setup function opens two connections.',
    'Why does your setup script need sudo?',
    'What goes into a CLAUDE.md file?',
    'No seu setup aqui o banco sobe antes da API?',
    'O setup do projeto roda as migrations?',
    // The code on the screen, with an experience verb (future-work item 5).
    'Have you handled the nil case in this function?',
    'Have you added an index on that column yet?',
    'Did you close the connection in this error path?',
    'Give me an example of when you would hit the rate limit with this loop.',
    'Give me an example of when you\'d overflow the queue.',
    'Você já tratou a lista vazia nessa função?',
    'Você criou o índice nessa coluna?',
    'Você usa esse lock pra quê?',
    'Imagine this other example where you are building a client for an external API with request limits. What approach do you follow?',
    'Conte sobre a estrutura de dados que você escolheu nesse código.',
    // The words of the English topic cues, about a system or a process (future-work item 5).
    'What is driving the memory up on this pod?',
    'What made the deploy start failing yesterday?',
    'When could the worker join the cluster again after a restart?',
    'Is there anything in the handler we did not cover with tests?',
    'What was it like before the cache was added?',
    'How comfortable is the broker with ten thousand partitions?',
    'What is the ideal batch size for this consumer?',
    'So what\'s your next step?',
    '',
]);

// The same verbs about the candidate, no code on the screen: still personal.
table('personal (experience verbs without code on the screen, future-work item 5)', 'personal', [
    'Have you handled the nil case in production incidents?',
    'Have you built monitoring from scratch at a previous job?',
    'Give me an example of when you disagreed with a teammate.',
    'Você já tratou erro de fila em produção?',
    'Você criou algum monitoramento do zero num emprego anterior?',
    'Me dá um exemplo de quando você usou cache.',
]);

// English questions about the candidate that no cue matched (future-work item 5).
table('personal (English topics: job search, start date, what was left out, comfort, next role)', 'personal', [
    'What has been driving you to look around lately?',
    'Is the money making you want to switch?',
    'How is your job search going so far?',
    'When would you be ready to start?',
    'How much notice do you have to give?',
    'What compensation are you aiming for?',
    'Is there anything about yourself we should hear before we finish?',
    'Anything you never had the chance to mention?',
    'Is there something we did not ask you about?',
    'What was it like working with a fully distributed team?',
    'How was your experience at the agency?',
    'How familiar are you with Terraform?',
    'Are you confident writing Rust in production?',
    'What is your dream job, honestly?',
    'What do you want from your next role?',
    'What did you like about the team at your previous company?',
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

    it('removes experience framing so the subject carries the query', () => {
        assert.equal(stripCuePhrases('Você já trabalhou com alguém desempenhando abaixo do esperado?'), 'alguem desempenhando abaixo do esperado');
        assert.equal(stripCuePhrases('Já trabalhou com filas?'), 'filas');
        assert.equal(stripCuePhrases('Have you ever worked with message queues?'), 'message queues');
        assert.equal(stripCuePhrases('Do you have hands-on experience with stream processing?'), 'stream processing');
        assert.equal(stripCuePhrases('Possui experiência com aplicativos móveis?'), 'aplicativos moveis');
        assert.equal(stripCuePhrases('Como lidou? Quais ações tomou?'), '');
    });

    it('removes plural example requests and "de forma rápida e objetiva"', () => {
        assert.equal(stripCuePhrases('Me dê exemplos de cases de sucesso'), 'cases de sucesso');
        assert.equal(stripCuePhrases('Compartilhe, de forma rápida e objetiva, um desafio técnico'), 'um desafio tecnico');
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

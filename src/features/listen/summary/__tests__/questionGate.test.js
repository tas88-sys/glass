/**
 * questionGate.test.js — the live answer's backchannel gate (spec 2026-10-13-career-router-jev, R19),
 * its set-up and reported-question rules (future-work item 9)
 * and its confirmation-check tail (spec 2026-10-16-confirmation-check-answer)
 *
 * Run: node --test src/features/listen/summary/__tests__/questionGate.test.js
 *
 * The phrasings are the shapes a real session armed answers on (invented text,
 * spec C5): acknowledgments, fillers and "pardon?" in English and Portuguese.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
    isBackchannel,
    shouldTriggerAnswer,
    BACKCHANNEL_MAX_WORDS,
    endsWithConfirmationCheck,
    isSetupOnly,
    isReportedOnly,
    hasReportedFrame,
    questionCandidates,
    isCheckOrHandover,
} = require('../questionGate');
const SummaryService = require('../summaryService');

describe('isBackchannel (R19)', () => {
    it('acknowledgments, fillers and "pardon?" in both languages', () => {
        for (const t of [
            'Aham.', 'Hã?', 'Hum?', 'Hum.', 'É.', 'Pá.', 'Sim.', 'Tá. Entendi.', 'Ah entendi entendi.', 'Ah sim sim, falou falou. Beleza.',
            'Show de bola. Beleza.', 'Nossa. Aham.', 'Maneiro, maneiro.', 'Pá. E aí?', 'Exatamente, exatamente.', 'Boa.', 'Oi?',
            '1', '1.', 'Faz sentido.',
            'Got it.', 'Okay, cool.', 'Mhmm.', 'Uh-huh.', 'Sorry?', 'Right, right.', 'Makes sense.', 'Interesting.', 'Yeah, sure.',
        ]) {
            assert.equal(isBackchannel(t), true, t);
        }
    });

    it('real questions, however short, are not backchannels', () => {
        for (const t of [
            'Isso é quando?', 'O que é isso?', 'E você?', 'Quantos?', 'Por quê?', 'Como assim?', 'Já conhece?',
            'And you?', 'What is it?', 'Why?', 'How many?', 'Can you hear me?', 'Got it, and then what happened?',
        ]) {
            assert.equal(isBackchannel(t), false, t);
        }
    });

    it(`more than ${BACKCHANNEL_MAX_WORDS} words is never a backchannel; empty or non-string neither`, () => {
        assert.equal(isBackchannel('sim '.repeat(BACKCHANNEL_MAX_WORDS).trim()), true);
        assert.equal(isBackchannel('sim '.repeat(BACKCHANNEL_MAX_WORDS + 1).trim()), false);
        for (const t of ['', '   ', '?!', null, undefined, 42]) assert.equal(isBackchannel(t), false, String(t));
    });

    it('shouldTriggerAnswer rejects a backchannel even when it ends in "?" (the regex path too)', () => {
        assert.equal(shouldTriggerAnswer('Them', 'Hã?', null, false), false);
        assert.equal(shouldTriggerAnswer('Them', 'Pá. E aí?', null, false, () => true), false);
        assert.equal(shouldTriggerAnswer('Them', 'Isso é quando?', null, false), true);
    });

    it('summaryService re-exports the same gate', () => {
        assert.equal(SummaryService.shouldTriggerAnswer, shouldTriggerAnswer);
    });
});

// Spec 2026-10-16-confirmation-check-answer: invented turns of the shape a real
// session answered with a recap, or in the interviewer's voice.
describe('endsWithConfirmationCheck', () => {
    it('a turn that ends only checking the candidate is following', () => {
        for (const t of [
            'Depois vem a etapa técnica e a conversa com o gestor, está bem?',
            'Se precisar falar comigo é só mandar mensagem, está bem?',
            'A gente usa Go e Kafka no time, tá?',
            'Eu te mando o convite amanhã, tá bom?',
            'O processo tem três etapas. Certo?',
            'Vou verificar a agenda do time, combinado?',
            'A vaga é remota, ok?',
            'Fica para terça às dez, pode ser?',
            'E o gestor aprofunda os desafios, está, Ana?',
            'E o gestor aprofunda os desafios, está Ana?',
            'Esse é o pacote, né?',
            'We will send the take-home next week, okay?',
            'The team is mostly backend, right?',
            'Tá?',
        ]) {
            assert.equal(endsWithConfirmationCheck(t), true, t);
        }
    });

    it('a real question, or a tag word that is not a check, is not one', () => {
        for (const t of [
            'Alguma dúvida sobre os benefícios?',
            'Qual é o caminho certo?',
            'Você trabalhou com Kafka?',
            'Qual linguagem você usa, Java?',
            'Você está pronto?',
            'Depois vem a etapa técnica, está bem.',
            'What is the right way to shard this?',
            '', null, undefined, 42,
        ]) {
            assert.equal(endsWithConfirmationCheck(t), false, String(t));
        }
    });
});

// Future-work item 9: a turn that only sets up a scenario, and a turn that only
// quotes questions someone else will ask. Invented text of the shapes two real
// sessions answered (spec C5).
describe('isSetupOnly (item 9)', () => {
    it('a scenario announced, with nothing asked yet', () => {
        for (const t of [
            'Tudo bem? Perfeito. Mudando de assunto, eu queria colocar um cenário para a gente pensar, vamos imaginar que a gente tem um endpoint que recebe um arquivo CSV grande.',
            'Eu queria colocar 1 cenário, vamos imaginar que um serviço recebe muitos pedidos por segundo.',
            'Alright. Let\'s say, for example, that you are handed a new system.',
            'Imagine that a user uploads a file bigger than the memory of the pod. Okay?',
        ]) {
            assert.equal(isSetupOnly(t), true, t);
            assert.equal(shouldTriggerAnswer('Them', t, null, false), false, t);
        }
    });

    it('a scenario with its question, or with a task, is not one', () => {
        for (const t of [
            'Vamos imaginar que a gente tem um endpoint que recebe um CSV grande. Como você processaria esse arquivo?',
            'Vamos supor que o pod tem pouca memória, como você faria?',
            'Imagine that you have a CSV endpoint. How would you design it?',
            'Imagine that you are designing a URL shortener for a large audience.',
            'So let\'s say one specific member, but maybe you have an example where there are many people to mentor.',
            'What is a mutex?',
            '', null, 42,
        ]) {
            assert.equal(isSetupOnly(t), false, String(t));
        }
    });
});

describe('isReportedOnly (item 9)', () => {
    it('every question sits inside reported or future speech, in English and in Portuguese', () => {
        for (const t of [
            'Explain your reasoning as you go. And they probably are going to ask additional questions, like maybe they will say, ' +
                'I saw you created a class for this, could you explain why? How would you change this, what would you do? So you can show you know the code.',
            'So those are the things they check. Questions about, oh, I see you are using this client with this config, why? ' +
                'Or architecture questions, like how will you approach this, or things like that.',
            'You can bring your own setup. The only thing they might require is an explanation. They want to see how you use it to build things.',
            'Depois eles vão perguntar coisas como: por que você criou essa classe? O que você mudaria aqui?',
            'Eles podem te perguntar, tipo, por que esse cliente HTTP com essa configuração?',
        ]) {
            assert.equal(isReportedOnly(t), true, t);
            assert.equal(shouldTriggerAnswer('Them', t, null, false), false, t);
        }
    });

    it('a question put to the candidate now is not reported', () => {
        for (const t of [
            'They will ask about your Kafka work later. But first, how do you handle retries?',
            'The hiring manager will ask about your last project. Can you tell me a bit about it now?',
            'Eles vão perguntar sobre isso depois. Mas antes, como você lida com retries?',
            'How would you change this class?',
            'They use Go and Kafka on the team.',
            '', null, 42,
        ]) {
            assert.equal(isReportedOnly(t), false, String(t));
        }
        assert.equal(shouldTriggerAnswer('Them', 'They will ask about your Kafka work later. But first, how do you handle retries?', null, false), true);
    });

    it('hasReportedFrame finds the frame, whatever else the turn asks', () => {
        assert.equal(hasReportedFrame('They will ask about your Kafka work later. But first, how do you handle retries?'), true);
        assert.equal(hasReportedFrame('Eles vão perguntar sobre isso depois.'), true);
        assert.equal(hasReportedFrame('How do you handle retries?'), false);
    });
});

describe('questionCandidates and isCheckOrHandover (item 9)', () => {
    it('checks, tags and hand-overs are flagged; real questions are not', () => {
        for (const t of ['Tudo bem?', 'Beleza?', 'Okay?', 'pode falar', 'Fique à vontade.', 'go ahead', 'o padrão é outro não é?', 'meu time é Rust, sabe?']) {
            assert.equal(isCheckOrHandover(t), true, t);
        }
        for (const t of ['Qual banco vocês usavam?', 'What would you do?', 'Você pode explicar?', 'Isso funciona ou não?']) {
            assert.equal(isCheckOrHandover(t), false, t);
        }
    });

    it('ranks the clauses by tier', () => {
        const c = questionCandidates('Tudo bem? Me fala do projeto. Como você fez o deploy');
        assert.deepEqual(c.map(x => [x.tier, x.check]), [[1, true], [3, false], [2, false]]);
    });
});

/**
 * questionGate.test.js — the live answer's backchannel gate (spec 2026-10-13-career-router-jev, R19)
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

const { isBackchannel, shouldTriggerAnswer, BACKCHANNEL_MAX_WORDS, endsWithConfirmationCheck } = require('../questionGate');
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

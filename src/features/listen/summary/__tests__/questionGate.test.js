/**
 * questionGate.test.js — the live answer's backchannel gate (spec 2026-10-13-career-router-jev, R19)
 *
 * Run: node --test src/features/listen/summary/__tests__/questionGate.test.js
 *
 * The phrasings are the shapes a real session armed answers on (invented text,
 * spec C5): acknowledgments, fillers and "pardon?" in English and Portuguese.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { isBackchannel, shouldTriggerAnswer, BACKCHANNEL_MAX_WORDS } = require('../questionGate');
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

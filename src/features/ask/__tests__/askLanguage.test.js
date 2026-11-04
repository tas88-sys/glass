/**
 * askLanguage.test.js
 *
 * The language an Ask answer is written in, in every Ask mode (future-work
 * 18.11, rule 11): the interviewer's turns, then the typed text, then the
 * speech-to-text language while Listen runs. Invented text only.
 *
 * Run: node --test src/features/ask/__tests__/askLanguage.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { askAnswerLanguage, interviewLanguage, LANGUAGE_TURNS } = require('../askLanguage');
const liveDesign = require('../liveDesign');

const PT_TURNS = ['them: Como você projetaria o feed?', 'me: ok', 'them: Qual seria o gargalo aqui?'];
const EN_TURNS = ['them: How would you design the feed?', 'me: ok', 'them: What is the bottleneck here?'];

describe('askAnswerLanguage', () => {
    it('the interviewer\'s turns decide first, over the typed text and the STT language', () => {
        assert.deepEqual(askAnswerLanguage({ turns: PT_TURNS, typed: 'How do I fix this error in the loop?', sttLanguage: 'en-US', listening: true }), { language: 'pt', source: 'turns' });
        assert.deepEqual(askAnswerLanguage({ turns: EN_TURNS, typed: 'Resolva esse problema para mim, por favor.', sttLanguage: 'pt-BR', listening: true }), { language: 'en', source: 'turns' });
    });

    it('then the typed text, when its language is clear', () => {
        assert.deepEqual(askAnswerLanguage({ turns: [], typed: 'como você projetaria o twitter', sttLanguage: 'en-US', listening: true }), { language: 'pt', source: 'typed' });
        assert.deepEqual(askAnswerLanguage({ turns: [], typed: 'what is the bottleneck here?', listening: false }), { language: 'en', source: 'typed' });
    });

    it('then the STT language, while Listen runs: a fixed word after a turn too short to tell', () => {
        // "Vamos desenhar o Twitter." has one word of the Portuguese list: not clear.
        const turns = ['them: Vamos desenhar o Twitter.'];
        assert.equal(interviewLanguage(turns, 'opening'), null);
        assert.deepEqual(askAnswerLanguage({ turns, typed: 'opening', sttLanguage: 'pt-BR', listening: true }), { language: 'pt', source: 'stt' });
        assert.deepEqual(askAnswerLanguage({ turns, typed: 'opening', sttLanguage: 'en-US', listening: true }), { language: 'en', source: 'stt' });
        assert.deepEqual(askAnswerLanguage({ turns: [], typed: '', sttLanguage: 'en', listening: true }), { language: 'en', source: 'stt' });
        assert.deepEqual(askAnswerLanguage({ turns: [], typed: '', sttLanguage: undefined, listening: true }), { language: 'pt', source: 'stt' }, 'pt-BR is the STT default');
    });

    it('without Listen, the STT language never decides: null, and each mode answers as before', () => {
        assert.deepEqual(askAnswerLanguage({ turns: [], typed: '', sttLanguage: 'pt-BR', listening: false }), { language: null, source: null });
        assert.deepEqual(askAnswerLanguage({ turns: ['them: ok'], typed: 'design', sttLanguage: 'en-US' }), { language: null, source: null });
        assert.deepEqual(askAnswerLanguage(), { language: null, source: null });
    });

    it('the candidate\'s turns do not count, and only the last interviewer turns do', () => {
        assert.deepEqual(askAnswerLanguage({ turns: ['me: Como você está? Tudo bem com o seu time?'], typed: '' }), { language: null, source: null });
        const pt = Array.from({ length: 10 }, () => 'them: Como você lida com isso no seu time?');
        const en = Array.from({ length: LANGUAGE_TURNS }, () => 'them: How would you scale the write path?');
        assert.equal(askAnswerLanguage({ turns: [...pt, ...en] }).language, 'en');
    });

    it('liveDesign re-exports the same interviewLanguage', () => {
        assert.equal(liveDesign.interviewLanguage, interviewLanguage);
        assert.equal(liveDesign.LANGUAGE_TURNS, LANGUAGE_TURNS);
    });
});

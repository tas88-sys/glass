'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { questionLanguage, answerLanguageRule } = require('../questionLanguage');

describe('questionLanguage', () => {
    it('reads Portuguese questions, with or without accents', () => {
        assert.equal(questionLanguage('O que você acha da forma como a empresa se posiciona em relação a diversidade e inclusão?'), 'pt');
        assert.equal(questionLanguage('Qual a diferença entre struct e class em C#?'), 'pt');
        assert.equal(questionLanguage('Por que voce quer trabalhar aqui na Acme?'), 'pt');
        assert.equal(questionLanguage('Me explica como funciona o Kafka'), 'pt');
    });

    it('reads English questions, speech-to-text repeats included', () => {
        assert.equal(questionLanguage('Why do you want to join us?'), 'en');
        assert.equal(questionLanguage('What is a goroutine?'), 'en');
        assert.equal(questionLanguage('Alright. So, and how did you how do you manage estimations?'), 'en');
    });

    it('is null when the turn is too short or mixed to tell', () => {
        assert.equal(questionLanguage(''), null);
        assert.equal(questionLanguage('Kafka?'), null);
        assert.equal(questionLanguage('Why Acme?'), null);
        assert.equal(questionLanguage(undefined), null);
    });

    it('counts words both languages use for neither', () => {
        assert.equal(questionLanguage('a me do no as so'), null);
    });
});

describe('answerLanguageRule', () => {
    it('names the language when it is clear, and the other one as the notes\' language', () => {
        assert.equal(
            answerLanguageRule('Qual a diferença entre struct e class em C#?'),
            'The question was asked in Portuguese: write the whole answer in Portuguese, even when earlier turns or notes are in English, ',
        );
        assert.equal(
            answerLanguageRule('Why do you want to join us?'),
            'The question was asked in English: write the whole answer in English, even when earlier turns or notes are in Portuguese, ',
        );
    });

    it('keeps the general rule when the language is not clear', () => {
        assert.equal(
            answerLanguageRule('q'),
            'Write the answer in the language that question was asked in (English for English, Portuguese for Portuguese), even when earlier turns or notes are in another language, ',
        );
    });
});

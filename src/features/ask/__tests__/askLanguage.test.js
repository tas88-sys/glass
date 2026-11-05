/**
 * askLanguage.test.js
 *
 * The language an Ask answer is written in, in every Ask mode (future-work
 * 18.11, rule 11): the speech-to-text language, Listen on or off.
 *
 * Run: node --test src/features/ask/__tests__/askLanguage.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { askAnswerLanguage } = require('../askLanguage');

describe('askAnswerLanguage', () => {
    it('is the STT language', () => {
        assert.deepEqual(askAnswerLanguage({ sttLanguage: 'pt-BR' }), { language: 'pt', source: 'stt' });
        assert.deepEqual(askAnswerLanguage({ sttLanguage: 'en-US' }), { language: 'en', source: 'stt' });
        assert.deepEqual(askAnswerLanguage({ sttLanguage: 'en' }), { language: 'en', source: 'stt' });
    });

    it('anything else reads as pt-BR, the setting\'s default', () => {
        assert.deepEqual(askAnswerLanguage({ sttLanguage: undefined }), { language: 'pt', source: 'stt' });
        assert.deepEqual(askAnswerLanguage({ sttLanguage: 'fr-FR' }), { language: 'pt', source: 'stt' });
        assert.deepEqual(askAnswerLanguage(), { language: 'pt', source: 'stt' });
    });
});

/**
 * sttLanguage.test.js
 *
 * Unit tests for the speech-to-text language rule: Portuguese (Brazil) or
 * English (US), and the code each provider expects.
 * Run: node --test src/features/listen/__tests__/sttLanguage.test.js
 *
 * Pure logic, no Electron/Lit/DOM coupling.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
    STT_LANGUAGES,
    DEFAULT_STT_LANGUAGE,
    normalizeSttLanguage,
    nextSttLanguage,
    sttLanguageLabel,
    toProviderLanguage,
} = require(path.join(__dirname, '..', 'sttLanguage.js'));

describe('sttLanguage', () => {
    it('offers pt-BR and en-US, with pt-BR as the default', () => {
        assert.deepEqual([...STT_LANGUAGES], ['pt-BR', 'en-US']);
        assert.equal(DEFAULT_STT_LANGUAGE, 'pt-BR');
    });

    it('keeps the two valid languages as they are', () => {
        assert.equal(normalizeSttLanguage('pt-BR'), 'pt-BR');
        assert.equal(normalizeSttLanguage('en-US'), 'en-US');
    });

    it('reads a bare pt or en as the regional tag', () => {
        assert.equal(normalizeSttLanguage('pt'), 'pt-BR');
        assert.equal(normalizeSttLanguage('en'), 'en-US');
    });

    it('reads anything else as pt-BR', () => {
        for (const value of [undefined, null, '', 'fr', 'multi', 42, {}]) {
            assert.equal(normalizeSttLanguage(value), 'pt-BR');
        }
    });

    it('toggles between the two languages', () => {
        assert.equal(nextSttLanguage('pt-BR'), 'en-US');
        assert.equal(nextSttLanguage('en-US'), 'pt-BR');
        assert.equal(nextSttLanguage('garbage'), 'en-US');
    });

    it('labels each language', () => {
        assert.equal(sttLanguageLabel('pt-BR'), 'Português (Brasil)');
        assert.equal(sttLanguageLabel('en-US'), 'English (US)');
        assert.equal(sttLanguageLabel(undefined), 'Português (Brasil)');
    });

    it('gives Deepgram and Gemini the full tag', () => {
        assert.equal(toProviderLanguage('deepgram', 'pt-BR'), 'pt-BR');
        assert.equal(toProviderLanguage('deepgram', 'en-US'), 'en-US');
        assert.equal(toProviderLanguage('gemini', 'pt-BR'), 'pt-BR');
    });

    it('gives OpenAI the two-letter code', () => {
        assert.equal(toProviderLanguage('openai', 'pt-BR'), 'pt');
        assert.equal(toProviderLanguage('openai-glass', 'en-US'), 'en');
    });

    it('falls back to pt-BR for an unknown value', () => {
        assert.equal(toProviderLanguage('deepgram', undefined), 'pt-BR');
        assert.equal(toProviderLanguage('openai', 'xx'), 'pt');
    });
});

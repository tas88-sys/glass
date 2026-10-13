'use strict';

/**
 * sttLanguage.js
 *
 * The language the speech-to-text sessions listen for: Brazilian Portuguese or
 * US English. One stored value per user, `sttLanguage` in the settings store.
 * It applies to both sessions (Me and Them).
 *
 * Pure and self-contained (no dependencies, no side effects) so the main
 * process, the renderer bundle and node:test all load the same file.
 * Any value other than the two languages reads as 'pt-BR'.
 */

const STT_LANGUAGES = Object.freeze(['pt-BR', 'en-US']);
const DEFAULT_STT_LANGUAGE = 'pt-BR';

const ALIASES = { pt: 'pt-BR', en: 'en-US' };
const NEXT = { 'pt-BR': 'en-US', 'en-US': 'pt-BR' };
const LABELS = { 'pt-BR': 'Português (Brasil)', 'en-US': 'English (US)' };

/**
 * @param {unknown} value
 * @returns {'pt-BR'|'en-US'} the value when it is one of the two (or a bare
 *   'pt' / 'en'), else 'pt-BR'
 */
function normalizeSttLanguage(value) {
    if (STT_LANGUAGES.includes(value)) return value;
    return ALIASES[value] || DEFAULT_STT_LANGUAGE;
}

/** @param {unknown} value @returns {'pt-BR'|'en-US'} the other language (the Settings button toggle) */
function nextSttLanguage(value) {
    return NEXT[normalizeSttLanguage(value)];
}

/** @param {unknown} value @returns {string} the Settings button label */
function sttLanguageLabel(value) {
    return LABELS[normalizeSttLanguage(value)];
}

/**
 * The language code each provider expects. Deepgram and Gemini take the full
 * tag; OpenAI takes ISO-639-1. Other providers get the full tag (Whisper runs
 * on 'auto' and ignores it).
 * @param {string} provider
 * @param {unknown} value
 * @returns {string}
 */
function toProviderLanguage(provider, value) {
    const tag = normalizeSttLanguage(value);
    if (provider === 'openai' || provider === 'openai-glass') return tag.split('-')[0];
    return tag;
}

module.exports = {
    STT_LANGUAGES,
    DEFAULT_STT_LANGUAGE,
    normalizeSttLanguage,
    nextSttLanguage,
    sttLanguageLabel,
    toProviderLanguage,
};

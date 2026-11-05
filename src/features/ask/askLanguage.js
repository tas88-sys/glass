/**
 * askLanguage.js
 *
 * The language an Ask answer is written in, in every Ask mode: the
 * interview's language (future-work 18.11, rule 11). Pure: no Electron, no
 * settings or DB reads; askService passes what it read, and the live eval
 * (scripts/live-eval) decides the same way.
 *
 * It is the speech-to-text language (`sttLanguage`, pt-BR or en-US), the one
 * the candidate sets for the interview so Listen transcribes it, whether Listen
 * runs or not. The user's choice (2026-11-04), after `twitter` typed in
 * System Design · Live with Listen off and the setting in Portuguese got an
 * English kit: the interviewer's turns and the typed text decided first then,
 * and neither named a language.
 */

'use strict';

const { normalizeSttLanguage } = require('../listen/sttLanguage');

/**
 * The language an Ask answer is written in, and what decided it.
 * @param {object} [o]
 * @param {unknown} [o.sttLanguage] - the saved `sttLanguage` setting; anything
 *   else reads as pt-BR, the setting's default
 * @returns {{ language: 'pt'|'en', source: 'stt' }}
 */
function askAnswerLanguage({ sttLanguage } = {}) {
    return { language: normalizeSttLanguage(sttLanguage) === 'en-US' ? 'en' : 'pt', source: 'stt' };
}

module.exports = { askAnswerLanguage };

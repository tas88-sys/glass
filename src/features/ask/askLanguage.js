/**
 * askLanguage.js
 *
 * The language an Ask answer is written in, in every Ask mode: the
 * interview's language (future-work 18.11, rule 11). Pure: no Electron, no
 * settings or DB reads; askService passes what it read, and the live eval
 * (scripts/live-eval) decides the same way.
 *
 * In this order:
 * 1. the interviewer's last LANGUAGE_TURNS turns ("them: …"), so a behavioral
 *    part in another language does not decide;
 * 2. the typed text, when its language is clear (the fixed words `design`,
 *    `opening`… carry none);
 * 3. the speech-to-text language, only while a Listen session runs: it is the
 *    language the interview is heard in;
 * 4. else null, and each mode answers as it did before.
 */

'use strict';

const { questionLanguage } = require('../listen/summary/questionLanguage');
const { normalizeSttLanguage } = require('../listen/sttLanguage');

/** The interviewer turns that decide the language (rule 11). */
const LANGUAGE_TURNS = 6;

/**
 * The interview's language from the interviewer's last turns, then the typed
 * text; null when neither is clear.
 * @param {string[]} turns - ["me: …", "them: …"]
 * @param {string} [typed]
 * @returns {'pt'|'en'|null}
 */
function interviewLanguage(turns, typed = '') {
    const them = (Array.isArray(turns) ? turns : [])
        .filter(t => /^them:/i.test(String(t)))
        .slice(-LANGUAGE_TURNS)
        .map(t => String(t).replace(/^them:\s*/i, ''));
    return questionLanguage(them.join(' ')) || questionLanguage(typed);
}

/**
 * The language an Ask answer is written in, and what decided it.
 * @param {object} o
 * @param {string[]} [o.turns] - the Listen transcript, ["me: …", "them: …"]
 * @param {string} [o.typed] - the typed text
 * @param {unknown} [o.sttLanguage] - the saved `sttLanguage` setting
 * @param {boolean} [o.listening] - whether a Listen session is running
 * @returns {{ language: 'pt'|'en'|null, source: 'turns'|'typed'|'stt'|null }}
 */
function askAnswerLanguage({ turns = [], typed = '', sttLanguage, listening = false } = {}) {
    const fromTurns = interviewLanguage(turns, '');
    if (fromTurns) return { language: fromTurns, source: 'turns' };
    const fromTyped = questionLanguage(typed);
    if (fromTyped) return { language: fromTyped, source: 'typed' };
    if (listening) return { language: normalizeSttLanguage(sttLanguage) === 'en-US' ? 'en' : 'pt', source: 'stt' };
    return { language: null, source: null };
}

module.exports = { LANGUAGE_TURNS, interviewLanguage, askAnswerLanguage };

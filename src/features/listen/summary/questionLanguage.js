'use strict';

// The language of the interviewer's question, pure (no Electron): the live
// answer names it in the prompt, so English notes do not pull a Portuguese
// question's answer into English (live eval, phase G with notes).
//
// Counts common words found in only one of the two languages; a word with a
// Portuguese accent (ã, ç, é...) counts as Portuguese. Words both languages
// use ("a", "me", "do", "no", "as", "so") count for neither. Short or mixed
// turns read as unknown, and the prompt then keeps its general language rule.

const EN = new Set([
    'what', 'why', 'how', 'who', 'where', 'when', 'which', 'does', 'did', 'you', 'your', 'have', 'has',
    'had', 'would', 'could', 'should', 'can', 'tell', 'about', 'is', 'are', 'was', 'were', 'the', 'to',
    'of', 'and', 'in', 'with', 'for', 'that', 'this', 'it', 'us', 'we', 'there', 'any', 'time', 'an',
    'explain', 'describe', 'walk', 'through', 'between', 'difference', 'give', 'example',
]);
const PT = new Set([
    'que', 'qual', 'quais', 'como', 'por', 'porque', 'voce', 'voces', 'seu', 'sua', 'tem', 'faz', 'fala',
    'fale', 'conta', 'conte', 'explica', 'explique', 'descreva', 'sobre', 'de', 'da', 'dos', 'das', 'em',
    'um', 'uma', 'para', 'pra', 'com', 'nao', 'o', 'os', 'na', 'e', 'ja', 'isso', 'esse', 'essa', 'aqui',
    'gente', 'entre', 'diferenca', 'mais', 'quando', 'onde', 'foi', 'era', 'ser', 'pelo', 'pela',
]);
const ACCENT_RE = /[ãõçáéíóúâêôà]/;

/** 'pt' | 'en' | null: the language of a question, or null when it is not clear. */
function questionLanguage(text) {
    const words = String(text || '').toLowerCase().match(/[a-zà-ÿ]+/g) || [];
    let pt = 0;
    let en = 0;
    for (const w of words) {
        const folded = w.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        if (ACCENT_RE.test(w) || PT.has(folded)) pt++;
        else if (EN.has(w)) en++;
    }
    if (pt >= 2 && pt >= en * 2) return 'pt';
    if (en >= 2 && en >= pt * 2) return 'en';
    return null;
}

const NAMES = { pt: 'Portuguese', en: 'English' };
const OTHER = { pt: 'English', en: 'Portuguese' };

/**
 * The live answer's language sentence: names the question's language when it
 * is clear, else the general rule.
 * @param {string} question
 */
function answerLanguageRule(question) {
    const lang = questionLanguage(question);
    if (!lang) {
        return 'Write the answer in the language that question was asked in (English for English, Portuguese for Portuguese), even when earlier turns or notes are in another language, ';
    }
    return `The question was asked in ${NAMES[lang]}: write the whole answer in ${NAMES[lang]}, even when earlier turns or notes are in ${OTHER[lang]}, `;
}

module.exports = { questionLanguage, answerLanguageRule };

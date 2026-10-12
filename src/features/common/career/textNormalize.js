'use strict';

// Text normalization shared by the BM25 index, the intent router and company
// matching (FR-005, FR-008). Pure: no fs, no Electron.

// The last line holds Portuguese "had to" (precisou, tive): like English
// "had", it carries no topic, and as a keyword it ranked unrelated notes first.
const STOPWORDS = new Set(`
a about above after again against all also am an and any are as at be because been before being below between
both but by can could did do does doing done down during each either else even ever every few for from further
get gets got had has have having he her here hers herself him himself his how however i if in into is it its
itself just let lets me might mine more most much must my myself no nor not now of off on once only or other
others our ours ourselves out over own per please quite rather really same she should since so some such than
that the their theirs them themselves then there these they this those through thus to too under until up upon
us very via was we well were what whatever when where whether which while who whom whose why will with within
without would yes yet you your yours yourselves
um uh er ah oh hmm okay ok yeah like kind sort actually basically maybe gonna wanna
ao aos aquela aquelas aquele aqueles aquilo as ate com como contra da das de dela delas dele deles depois do
dos e ela elas ele eles em entao entre era eram essa essas esse esses esta estao estas estava estavam este estes
estou eu foi foram ha isso isto ja la lhe lhes mais mas me mesmo meu meus minha minhas muito na nao nas nem no
nos nossa nossas nosso nossos num numa o os ou para pela pelas pelo pelos por porque pra pro qual quais quando
que quem se sem ser seu seus si sim so sobre sua suas tambem te tem tenho ter teu teus tu tua tuas um uma umas
uns voce voces vc vcs ne tipo assim entao
precisou precisei precisava precisavam precisaram precisamos tive teve tivemos tiveram tinha tinham
`.split(/\s+/).filter(Boolean));

function foldAccents(text) {
    return String(text).normalize('NFD').replace(/\p{M}+/gu, '');
}

/** FR-005 slug: accents folded, lowercase, alphanumerics only. */
function slugify(text) {
    return foldAccents(text).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Words separated by single spaces: accents folded, lowercase, English
 * contractions expanded, punctuation removed. The router and company
 * detection match their phrase tables in this space.
 */
function normalizeForMatch(text) {
    if (text == null) return '';
    let s = foldAccents(text).toLowerCase().replace(/[‘’`´]/g, "'");
    s = s
        .replace(/\bcan't\b/g, 'can not')
        .replace(/\bwon't\b/g, 'will not')
        .replace(/n't\b/g, ' not')
        .replace(/'re\b/g, ' are')
        .replace(/'ve\b/g, ' have')
        .replace(/'ll\b/g, ' will')
        .replace(/'m\b/g, ' am')
        .replace(/'d\b/g, ' would')
        .replace(/'s\b/g, ' is');
    return s.replace(/[^a-z0-9]+/g, ' ').trim();
}

// Light EN+PT stemmer: a Portuguese verb form ends there; otherwise one plural
// rule, one derivational/verb rule, then a final vowel. Applied to both the
// index and the query, so it only needs to be consistent, not linguistically
// exact.
const PLURAL = [['coes', 'cao', 3], ['soes', 'sao', 3], ['ies', 'y', 3], ['oes', 'ao', 3], ['aes', 'ao', 3], ['es', '', 4], ['s', '', 3]];
const SUFFIX = [['amento', ''], ['imento', ''], ['mente', ''], ['ation', 'at'], ['edly', ''], ['ing', ''], ['ed', ''], ['ly', ''], ['er', ''], ['ar', ''], ['ir', '']];
const MIN_STEM = 4;
// Portuguese past tense, imperfect, gerund and participle endings, each with
// the shortest stem it may leave. They cut to the infinitive's stem, so
// "discordei", "discordou" and "discordando" meet "discordar".
const PT_VERB = [['aram', 4], ['eram', 4], ['iram', 4], ['avam', 4], ['amos', 4], ['emos', 4], ['imos', 4],
    ['ando', 4], ['endo', 4], ['indo', 4], ['ados', 4], ['adas', 4], ['idos', 4], ['idas', 4],
    ['ava', 4], ['ado', 4], ['ada', 4], ['ido', 4], ['ida', 4], ['ei', 4], ['ou', 4], ['eu', 4], ['iu', 4], ['i', 5]];

function stem(token) {
    let t = token;
    if (t.length < 4 || /\d/.test(t)) return t;
    for (const [suf, min] of PT_VERB) {
        if (t.endsWith(suf) && t.length - suf.length >= min) return t.slice(0, -suf.length);
    }
    for (const [suf, rep, min] of PLURAL) {
        if (!t.endsWith(suf)) continue;
        if (suf === 's' && /(?:ss|us)$/.test(t)) break;
        const base = t.slice(0, -suf.length) + rep;
        if (base.length >= min) {
            t = base;
            break;
        }
    }
    for (const [suf, rep] of SUFFIX) {
        if (!t.endsWith(suf)) continue;
        const base = t.slice(0, -suf.length) + rep;
        if (base.length >= MIN_STEM) {
            t = base;
            break;
        }
    }
    if (/[aeo]$/.test(t) && t.length - 1 >= MIN_STEM) t = t.slice(0, -1);
    return t;
}

/**
 * Index/query terms: fold accents, lowercase, split on non-alphanumerics, drop
 * stopwords and one-letter tokens (numbers stay), stem.
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
    if (text == null) return [];
    // The Portuguese filler "aí" would fold into "ai" and match AI notes.
    const words = foldAccents(String(text).replace(/(?<![\p{L}\p{N}])aí(?![\p{L}\p{N}])/giu, ' ')).toLowerCase().split(/[^a-z0-9]+/);
    const out = [];
    for (const w of words) {
        if (!w || STOPWORDS.has(w)) continue;
        if (w.length < 2 && !/\d/.test(w)) continue;
        out.push(stem(w));
    }
    return out;
}

module.exports = { tokenize, foldAccents, slugify, normalizeForMatch, stem, STOPWORDS };

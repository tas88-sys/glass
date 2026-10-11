'use strict';

// Live check of a career answer (FR-021). Pure.
//
// Lists what an answer states that appears nowhere in the text the model was
// given (the career block, the addendum, the question and the conversation):
//
// - every number, compared by value, so "1,000", "1.000", "1000" and "1k"
//   match, and "3,5" matches "3.5". Years and percentages are numbers too.
//   Numbers glued to a letter ("EC2", "K8s", "OAuth2") and list markers are
//   not claims and are skipped;
// - every known employer, project or company name (manifest entities and
//   company aliases), matched with the casing the manifest gives it so the
//   ordinary word "bridge" never counts as the company "Bridge".
//
// Numbers written as words and names outside the known list are not checked.

const { foldAccents } = require('./textNormalize');

const NUMBER_RE = /(?<![\p{L}\p{N}_.,])\d+(?:[.,]\d+)*/gu;
const SUFFIX_RE = /^\s?(k|mil|thousand|mm|mi|m|million|milh(?:ão|ões|ao|oes)|bi|b|billion|bilh(?:ão|ões|ao|oes))(?!\p{L})/iu;
const MULTIPLIERS = { k: 1e3, mil: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, mi: 1e6, million: 1e6, b: 1e9, bi: 1e9, billion: 1e9 };
const LIST_MARKER_RE = /^(\s*)\d+[.)](?=\s)/gm;

function multiplierOf(suffix) {
    if (!suffix) return 0;
    const s = foldAccents(suffix).toLowerCase();
    if (s.startsWith('milh')) return 1e6;
    if (s.startsWith('bilh')) return 1e9;
    return MULTIPLIERS[s] || 0;
}

/** "1,000" → 1000, "3,5" → 3.5, "4.2.0" → null (not a quantity). */
function valueOf(num) {
    if (/^\d{1,3}(?:[.,]\d{3})+$/.test(num)) return Number(num.replace(/[.,]/g, ''));
    const parts = num.split(/[.,]/);
    if (parts.length === 1) return Number(num);
    if (parts.length === 2) return Number(`${parts[0]}.${parts[1]}`);
    return null;
}

const keyOf = v => String(Math.round(v * 1000) / 1000);

/** Every number in `text` with its comparison keys and how it was written. */
function numbersIn(text) {
    const out = [];
    const src = text.replace(LIST_MARKER_RE, (m, lead) => lead + ' '.repeat(m.length - lead.length));
    for (const m of src.matchAll(NUMBER_RE)) {
        const rest = src.slice(m.index + m[0].length);
        const suffix = rest.match(SUFFIX_RE);
        const value = valueOf(m[0]);
        const keys = value == null ? [m[0].replace(/[.,]/g, '')] : [keyOf(value)];
        const mult = multiplierOf(suffix && suffix[1]);
        if (value != null && mult) keys.push(keyOf(value * mult));
        let end = m.index + m[0].length + (suffix ? suffix[0].length : 0);
        if (src[end] === '%') end++;
        out.push({ at: m.index, label: text.slice(m.index, end).replace(/\s+/g, ' '), keys });
    }
    return out;
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (name, flags) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(name)}(?![\\p{L}\\p{N}])`, flags);

/**
 * @param {string} answer
 * @param {string} given   everything the model was given for this answer
 * @param {string[]} [names]  known employer, project and company names
 * @returns {string[]} unsupported numbers and names, as written, in answer order, once each
 */
function findUnsupported(answer, given, names = []) {
    if (typeof answer !== 'string' || !answer) return [];
    const source = typeof given === 'string' ? given : '';
    const found = [];

    const known = new Set();
    for (const n of numbersIn(source)) for (const k of n.keys) known.add(k);
    for (const n of numbersIn(answer)) {
        if (!n.keys.some(k => known.has(k))) found.push(n);
    }

    // Longest names first; a shorter one inside a longer match ("Lumen" in
    // "Lumen Works") is the same mention.
    const foldedAnswer = foldAccents(answer);
    const foldedSource = foldAccents(source);
    const list = [...new Set((Array.isArray(names) ? names : []).filter(n => typeof n === 'string' && n.trim()).map(n => n.trim()))]
        .sort((a, b) => b.length - a.length);
    const covered = [];
    const inside = m => covered.some(([s, e]) => m.index >= s && m.index + m[0].length <= e);
    for (const name of list) {
        const folded = foldAccents(name);
        const hits = [...foldedAnswer.matchAll(wordRe(folded, 'gu'))].filter(m => !inside(m));
        for (const m of hits) covered.push([m.index, m.index + m[0].length]);
        if (hits.length && !wordRe(folded, 'iu').test(foldedSource)) found.push({ at: hits[0].index, label: name });
    }

    found.sort((a, b) => a.at - b.at);
    return [...new Set(found.map(f => f.label))];
}

module.exports = { findUnsupported };

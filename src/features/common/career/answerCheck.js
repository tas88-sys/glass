'use strict';

// Live check of a career answer (FR-021). Pure.
//
// Lists what an answer states that appears nowhere in the text the model was
// given (the career block, the addendum, the question and the conversation):
//
// - every number, compared by value, so "1,000", "1.000", "1000" and "1k"
//   match, and "3,5" matches "3.5". Years and percentages are numbers too.
//   Numbers glued to a letter ("EC2", "K8s", "OAuth2") and list markers are
//   not claims and are skipped. So are two kinds of technical constant
//   (future-work item 14): an HTTP status next to an HTTP word ("avoids 429
//   errors", "HTTP 500") and a number inside an example ("e.g., > 300
//   lines", "por exemplo, 1/1.000"), and again where the answer repeats
//   it. A percentage ("50 %" too), money or a duration is a claim wherever
//   it stands and is never skipped. The cost: "cut 500 errors a day" is not
//   checked;
// - a result number (a percentage, money, a duration or a multiplier like
//   "3x") found only in the notes, when no note line holding it also holds
//   what it measures (a content word within 5 words of it in the answer) and
//   the known name the answer line gives it (future-work item 10b). Listed
//   as "40% (other result)": the notes give it to another result or
//   employer. A number the question or the transcript holds is the
//   interviewer's and passes on presence; a bare number ("5 workers") is
//   checked on presence only;
// - every known employer, project or company name (manifest entities and
//   company aliases), matched with the casing the manifest gives it so the
//   ordinary word "bridge" never counts as the company "Bridge";
// - a technology the notes list as never used, named in a sentence in the
//   first person or with a known name and without a negation or "instead
//   of". Listed as "Tidewire (never used)".
//
// Numbers written as words and names outside the known list are not checked.

const { foldAccents, STOPWORDS } = require('./textNormalize');

const NUMBER_RE = /(?<![\p{L}\p{N}_.,])\d+(?:[.,]\d+)*/gu;
const SUFFIX_RE = /^\s?(k|mil|thousand|mm|mi|m|million|milh(?:ão|ões|ao|oes)|bi|b|billion|bilh(?:ão|ões|ao|oes))(?!\p{L})/iu;
const MULTIPLIERS = { k: 1e3, mil: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, mi: 1e6, million: 1e6, b: 1e9, bi: 1e9, billion: 1e9 };
const LIST_MARKER_RE = /^(\s*)\d+[.)](?=\s)/gm;

// What follows or precedes a number and makes it a claim (its kind).
const PERCENT_RE = /^[^\S\n]?%/;
const CURRENCY_BEFORE_RE = /(?:R\$|US\$|\$|€|£)[^\S\n]?$/;
const CURRENCY_AFTER_RE = /^[^\S\n]?(?:dollars?|reais|usd|brl|eur|euros?)(?!\p{L})/iu;
const DURATION_RE = /^[^\S\n]?(?:ms|milliseconds?|milissegundos?|s|secs?|seconds?|segundos?|min|mins|minutes?|minutos?|h|hrs?|hours?|horas?|days?|dias?|weeks?|semanas?|months?|meses|m[eê]s|years?|anos?)(?!\p{L})/iu;
const TIMES_RE = /^[^\S\n]?(?:x|×|times|vezes)(?![\p{L}\p{N}])/iu;
const RANGE_RE = /^[^\S\n]?(?:[-–‑]|to|a|até|ate)[^\S\n]?\d+(?:[.,]\d+)*/u;

// What marks a bare number as a constant.
const HTTP_WORD_RE = /^(?:errors?|erros?|status|https?|responses?|respostas?|codes?|codigos?)$/i;
const EXAMPLE_RE = /(?<!\p{L})(?:e\.[^\S\n]?g\.|eg(?!\p{L})|for example|for instance|such as|por exemplo|ex\.|ex:|exemplo:)/giu;
const EXAMPLE_WINDOW = 6;

const wordsOf = s => foldAccents(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/**
 * 'percent' | 'money' | 'duration' | 'times' | 'bare', from the text around
 * src[start, end). The start of a range takes the kind of its end ("15‑20 %",
 * "3 to 5x").
 */
function kindOf(src, start, end) {
    const after = src.slice(end);
    const range = after.match(RANGE_RE);
    const tails = range ? [after, after.slice(range[0].length)] : [after];
    if (tails.some(t => PERCENT_RE.test(t))) return 'percent';
    if (CURRENCY_BEFORE_RE.test(src.slice(Math.max(0, start - 4), start)) || tails.some(t => CURRENCY_AFTER_RE.test(t))) return 'money';
    if (tails.some(t => DURATION_RE.test(t))) return 'duration';
    if (tails.some(t => TIMES_RE.test(t))) return 'times';
    return 'bare';
}

/** A bare number that is a technical constant, not a claim: an HTTP status or a number inside an example. */
function isConstant(src, n) {
    if (n.kind !== 'bare') return false;
    if (n.status) {
        const near = wordsOf(src.slice(Math.max(0, n.at - 40), n.at)).slice(-2)
            .concat(wordsOf(src.slice(n.end, n.end + 40)).slice(0, 2));
        if (near.some(w => HTTP_WORD_RE.test(w))) return true;
    }
    const before = src.slice(Math.max(0, n.at - 120), n.at);
    const marks = [...before.matchAll(EXAMPLE_RE)];
    if (!marks.length) return false;
    const last = marks[marks.length - 1];
    const gap = before.slice(last.index + last[0].length);
    return !/[.!?;\n)]/.test(gap) && wordsOf(gap).length <= EXAMPLE_WINDOW;
}

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

/** Every number in `text` with its comparison keys, how it was written, where it ends and its kind. */
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
        const kind = kindOf(src, m.index, end);
        const pct = src.slice(end).match(PERCENT_RE);
        if (pct) end += pct[0].length;
        const status = /^\d{3}$/.test(m[0]) && value >= 100 && value < 600 && !mult;
        out.push({ at: m.index, end, label: text.slice(m.index, end).replace(/\s+/g, ' '), keys, kind, status });
    }
    return out;
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (name, flags) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(name)}(?![\\p{L}\\p{N}])`, flags);

// Neighborhood check (future-work item 10b). The kinds a result is stated in;
// a bare number ("5 workers") is a parameter more often than a result.
const RESULT_KINDS = new Set(['percent', 'money', 'duration', 'times']);
const NEIGHBORHOOD = 5;
// Words that say which way a number moved, or only that it did, not what it
// measures: "redução" on both sides would hide a cost cut told as a time cut.
const DIRECTION_WORDS = new Set(`
got get gets came come comes went made make makes brought reached achieved hit saw ended
ficou ficaram chegou chegamos levou levamos trouxe saiu alcancei alcancamos consegui conseguimos tivemos
cut cuts cutting corte cortes cortou cortei cortamos drop drops dropped queda quedas caiu cairam fell lower higher
maior menor maiores menores fast faster fastest rapido rapida rapidos rapidas slow slower lento lenta half metade
double doubled dobro dobrou gain gains ganho ganhos boost boosted result results resultado resultados times vezes
percent cento ponto pontos points approximately aproximadamente cerca around roughly total less fewer more
`.split(/\s+/).filter(Boolean));
const DIRECTION_RE = /^(?:reduc|reduz|reduce|diminu|decreas|aument|increas|rais|melhor|improv|acelera|acceler|economi|sav)/;
// What the notes and the answer measure, across English and Portuguese, where
// the first five letters differ ("custo" / "cost"). Checked in order.
const MEASURES = [
    [/^(?:cust|cost)/, 'cost'], [/^(?:temp|time)/, 'time'], [/^err/, 'error'], [/^(?:usuari|user)/, 'user'],
    [/^(?:receit|revenu)/, 'revenue'], [/^(?:vend|sale)/, 'sales'], [/^(?:entreg|deliver)/, 'delivery'],
    [/^(?:hora|hour)/, 'hour'], [/^(?:falh|fail)/, 'failure'], [/^(?:chamad|call)/, 'call'],
    [/^(?:consult|quer)/, 'query'], [/^(?:pedid|order)/, 'order'], [/^(?:cliente|client|custom)/, 'client'],
    [/^(?:pagament|payment)/, 'payment'], [/^(?:cobranc|billing)/, 'billing'], [/^(?:armazen|storage)/, 'storage'],
    [/^(?:mensag|messag)/, 'message'], [/^(?:requisic|request)/, 'request'], [/^(?:implant|deploy)/, 'deploy'],
    [/^(?:disponib|availab|uptime)/, 'uptime'], [/^(?:cobertur|coverag)/, 'coverage'], [/^test/, 'test'],
    [/^(?:tarefa|task)/, 'task'], [/^(?:dado|data$)/, 'data'],
];

/**
 * The folded content words of a text: no stopwords, numbers, short words,
 * direction words or words of a known name (`skip`).
 */
function contentWords(text, skip) {
    const out = [];
    for (const raw of wordsOf(text)) {
        const w = raw.toLowerCase();
        if (w.length < 3 || /^\d/.test(w) || STOPWORDS.has(w) || DIRECTION_WORDS.has(w) || DIRECTION_RE.test(w) || skip.has(w)) continue;
        const m = MEASURES.find(([re]) => re.test(w));
        out.push(m ? m[1] : w.slice(0, 5));
    }
    return out;
}

/** The notes' lines, each with its numbers' keys and the section title and heading above it. */
function noteLines(notes) {
    const out = [];
    let section = '';
    let heading = '';
    for (const line of notes.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        if (/^\[.+\]$/.test(t)) {
            section = t;
            heading = '';
            continue;
        }
        if (/^#{1,6}\s/.test(t)) heading = t;
        const keys = new Set();
        for (const n of numbersIn(line)) for (const k of n.keys) keys.add(k);
        out.push({ text: line, context: `${section}\n${heading}\n${line}`, keys });
    }
    return out;
}

/** The known names in `text`, matched with the manifest casing like the name check. */
function namesIn(text, names) {
    const folded = foldAccents(text);
    return names.filter(name => wordRe(foldAccents(name), 'u').test(folded));
}

/**
 * Whether a note line holds this number together with what it measures in
 * the answer and the known name the answer line gives it.
 */
function fitsNotes(answer, n, lines, names) {
    const lineStart = answer.lastIndexOf('\n', n.at - 1) + 1;
    const nl = answer.indexOf('\n', n.end);
    const lineEnd = nl === -1 ? answer.length : nl;
    const skip = new Set(names.flatMap(name => wordsOf(name).map(w => w.toLowerCase())));
    const words = contentWords(answer.slice(lineStart, n.at), skip).slice(-NEIGHBORHOOD)
        .concat(contentWords(answer.slice(n.end, lineEnd), skip).slice(0, NEIGHBORHOOD));
    const named = namesIn(answer.slice(lineStart, lineEnd), names);
    return lines.some(l => {
        if (!n.keys.some(k => l.keys.has(k))) return false;
        if (named.length) {
            const context = foldAccents(l.context);
            if (!named.some(name => wordRe(foldAccents(name), 'iu').test(context))) return false;
        }
        if (!words.length) return true;
        const there = new Set(contentWords(l.text, skip));
        return words.some(w => there.has(w));
    });
}

// "Never used" technologies (future-work item 10b).
const FIRST_PERSON_RE = /(?<!\p{L})(?:i|i'm|i've|i'd|my|we|we've|our|eu|meu|minha|meus|minhas|nosso|nossa|nossos|nossas|usei|utilizei|implementei|escolhi|adotei|construi|desenvolvi|criei|migrei|trabalhei|apliquei|liderei)(?!\p{L})/iu;
const NEGATION_RE = /(?<!\p{L})(?:not|never|without|nao|nunca|sem|nem)(?!\p{L})|n['’]t(?!\p{L})/iu;
const INSTEAD_RE = /(?<!\p{L})(?:instead of|rather than|em vez de|ao inves de|no lugar de)(?!\p{L})/iu;

/** The stretch of `text` around match `m` up to the nearest of `stops` on each side. */
function around(text, m, stops) {
    const start = Math.max(...stops.map(c => text.lastIndexOf(c, m.index - 1))) + 1;
    const ends = stops.map(c => text.indexOf(c, m.index + m[0].length)).filter(i => i !== -1);
    return { start, text: text.slice(start, ends.length ? Math.min(...ends) : text.length) };
}

/** The not-used names the answer claims: in the first person or with a known name, not negated. */
function claimedNotUsed(answer, notUsed, names) {
    const found = [];
    const folded = foldAccents(answer);
    const list = [...new Set((Array.isArray(notUsed) ? notUsed : []).filter(n => typeof n === 'string' && n.trim()).map(n => n.trim()))];
    for (const name of list) {
        for (const m of folded.matchAll(wordRe(foldAccents(name), 'giu'))) {
            // The negation counts in the clause ("never used X; used Y"), the
            // claim anywhere in the sentence ("at Lumen I moved…; each one read X").
            const clause = around(folded, m, ['.', '!', '?', ';', '\n']);
            const sentence = around(folded, m, ['.', '!', '?', '\n']);
            if (NEGATION_RE.test(clause.text) || INSTEAD_RE.test(folded.slice(clause.start, m.index))) continue;
            if (!FIRST_PERSON_RE.test(sentence.text) && !namesIn(sentence.text, names).length) continue;
            found.push({ at: m.index, label: `${name} (never used)` });
            break;
        }
    }
    return found;
}

/**
 * @param {string} answer
 * @param {string} given   everything the model was given for this answer
 * @param {string[]} [names]  known employer, project and company names
 * @param {{ notes?: string, notUsed?: string[] }} [opts]  notes: the notes
 *   block inside `given`, for the neighborhood check; notUsed: technologies
 *   the notes list as never used
 * @returns {string[]} unsupported numbers and names, as written, in answer order, once each
 */
function findUnsupported(answer, given, names = [], opts = {}) {
    if (typeof answer !== 'string' || !answer) return [];
    const source = typeof given === 'string' ? given : '';
    const notes = opts && typeof opts.notes === 'string' ? opts.notes : '';
    const list = [...new Set((Array.isArray(names) ? names : []).filter(n => typeof n === 'string' && n.trim()).map(n => n.trim()))]
        .sort((a, b) => b.length - a.length);
    const found = [];

    const known = new Set();
    for (const n of numbersIn(source)) for (const k of n.keys) known.add(k);
    // What the question, the transcript and the addendum hold passes on
    // presence: the interviewer said it.
    const outside = new Set();
    if (notes) for (const n of numbersIn(source.replace(notes, ''))) for (const k of n.keys) outside.add(k);
    const lines = notes ? noteLines(notes) : [];
    // A constant stays one when the answer repeats it ("e.g., 1/1.000 …
    // dividing by 1.000").
    const inAnswer = numbersIn(answer);
    const constants = new Set();
    for (const n of inAnswer) if (isConstant(answer, n)) for (const k of n.keys) constants.add(k);
    for (const n of inAnswer) {
        const constant = n.kind === 'bare' && n.keys.some(k => constants.has(k));
        if (constant) continue;
        if (!n.keys.some(k => known.has(k))) found.push(n);
        else if (notes && RESULT_KINDS.has(n.kind) && !n.keys.some(k => outside.has(k)) && !fitsNotes(answer, n, lines, list)) {
            found.push({ at: n.at, label: `${n.label} (other result)` });
        }
    }

    // Longest names first; a shorter one inside a longer match ("Lumen" in
    // "Lumen Works") is the same mention.
    const foldedAnswer = foldAccents(answer);
    const foldedSource = foldAccents(source);
    const covered = [];
    const inside = m => covered.some(([s, e]) => m.index >= s && m.index + m[0].length <= e);
    for (const name of list) {
        const folded = foldAccents(name);
        const hits = [...foldedAnswer.matchAll(wordRe(folded, 'gu'))].filter(m => !inside(m));
        for (const m of hits) covered.push([m.index, m.index + m[0].length]);
        if (hits.length && !wordRe(folded, 'iu').test(foldedSource)) found.push({ at: hits[0].index, label: name });
    }
    found.push(...claimedNotUsed(answer, opts && opts.notUsed, list));

    found.sort((a, b) => a.at - b.at);
    return [...new Set(found.map(f => f.label))];
}

module.exports = { findUnsupported };

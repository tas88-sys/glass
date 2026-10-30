'use strict';

// Deterministic checks of the live eval. Pure functions, no I/O (the code
// runner uses node:vm with a timeout), unit-tested in __tests__/checks.test.js.

const vm = require('node:vm');

const stripAccents = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

// STT writes numbers as digits (smart_format); the script says them as words.
const NUMBER_WORDS = {
    zero: '0', um: '1', uma: '1', one: '1', dois: '2', duas: '2', two: '2', tres: '3', three: '3', quatro: '4', four: '4',
    cinco: '5', five: '5', seis: '6', six: '6', sete: '7', seven: '7', oito: '8', eight: '8', nove: '9', nine: '9', dez: '10', ten: '10',
};

/** Lowercase words without accents or punctuation, numbers as digits. */
function words(text) {
    return stripAccents(String(text || '').toLowerCase())
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .map(w => NUMBER_WORDS[w] || w);
}

/** Word error rate of hyp against ref (Levenshtein over words / ref length). */
function wer(ref, hyp) {
    const r = words(ref);
    const h = words(hyp);
    if (!r.length) return h.length ? 1 : 0;
    let prev = Array.from({ length: h.length + 1 }, (_, j) => j);
    for (let i = 1; i <= r.length; i++) {
        const cur = [i];
        for (let j = 1; j <= h.length; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
        }
        prev = cur;
    }
    return Math.round((prev[h.length] / r.length) * 1000) / 1000;
}

const PT = new Set(['de', 'que', 'nao', 'para', 'com', 'uma', 'os', 'as', 'no', 'na', 'se', 'por', 'mais', 'dos', 'das', 'como', 'mas', 'ao', 'ele', 'isso', 'voce', 'sua', 'seu', 'ou', 'quando', 'muito', 'nos', 'ja', 'tambem', 'so', 'pelo', 'pela', 'ate', 'entre', 'depois', 'sem', 'mesmo', 'cada', 'em', 'um', 'e', 'o', 'a', 'do', 'da']);
const EN = new Set(['the', 'of', 'and', 'to', 'in', 'is', 'that', 'for', 'it', 'with', 'as', 'on', 'be', 'at', 'by', 'this', 'are', 'or', 'an', 'from', 'which', 'you', 'your', 'we', 'can', 'will', 'not', 'but', 'if', 'each', 'when', 'use', 'into', 'than', 'then', 'so', 'a']);

/** 'pt' | 'en' | 'unknown', by stopword counts (code and markdown ignored). */
function detectLang(text) {
    const prose = String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
    let pt = 0;
    let en = 0;
    for (const w of words(prose)) {
        if (PT.has(w)) pt++;
        if (EN.has(w)) en++;
    }
    if (pt + en < 4) return 'unknown';
    if (pt >= en * 1.5) return 'pt';
    if (en >= pt * 1.5) return 'en';
    return 'unknown';
}

/** First non-empty line and the markdown bullets of a Live Answer. */
function answerShape(text) {
    const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
    const headline = (lines[0] || '').replace(/[*_#`]/g, '').trim();
    const bullets = lines.filter(l => /^[-*•]\s+/.test(l)).length;
    return { headline, headlineWords: headline.split(/\s+/).filter(Boolean).length, bullets, lines: lines.length, chars: String(text || '').length };
}

/** Words a candidate would read aloud: markdown marks and code blocks left out (future-work item 11). */
function answerWords(text) {
    const prose = String(text || '')
        .replace(/```[\s\S]*?(```|$)/g, ' ')
        .replace(/^\s*(?:[-*•]|\d+\.)\s+/gm, '')
        .replace(/[*_#`>|]/g, ' ');
    return prose.split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w)).length;
}

/** An answer with bullets whose last line is not one: a closing summary paragraph (item 11). */
function endsWithClosingParagraph(text) {
    const lines = String(text || '').replace(/```[\s\S]*?(```|$)/g, '').split('\n').map(l => l.trim()).filter(Boolean);
    const isBullet = l => /^(?:[-*•]|\d+\.)\s+/.test(l);
    return lines.some(isBullet) && !isBullet(lines[lines.length - 1]);
}

/**
 * Terms found in text, accent- and case-insensitive. A term is a plain
 * substring or, when it starts with '/', a regex ("/4[.,]?870/").
 * @returns {{ found: string[], missing: string[] }}
 */
function mentions(text, terms) {
    const hay = stripAccents(plainMath(String(text || '')).toLowerCase());
    const found = [];
    const missing = [];
    for (const t of terms || []) {
        const ok = t.startsWith('/')
            ? new RegExp(t.slice(1, t.lastIndexOf('/')), t.slice(t.lastIndexOf('/') + 1) || 'i').test(hay)
            : hay.includes(stripAccents(t.toLowerCase()));
        (ok ? found : missing).push(t);
    }
    return { found, missing };
}

/** LaTeX the models put in complexity lines, as plain text: \cdot → ·, \times → ×, \log → log, no $ or braces. */
function plainMath(s) {
    return s
        .replace(/\\cdot/g, '·')
        .replace(/\\times/g, '×')
        .replace(/\\(?:log|lg)\b/g, 'log')
        .replace(/\\[,;! ]/g, ' ')
        .replace(/[${}]/g, '');
}

/** Headings in order: each name must appear as a markdown heading after the previous one. */
function sectionsInOrder(text, names) {
    const s = String(text || '');
    let from = 0;
    const missing = [];
    const outOfOrder = [];
    for (const name of names) {
        const re = new RegExp(`^#{1,4}\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'mi');
        const all = re.exec(s);
        if (!all) {
            missing.push(name);
            continue;
        }
        const rest = re.exec(s.slice(from));
        if (!rest) outOfOrder.push(name);
        else from += rest.index + rest[0].length;
    }
    return { ok: !missing.length && !outOfOrder.length, missing, outOfOrder };
}

const CODE_SECTIONS = ['Clarifying Questions', 'Reasoning / Think-Out-Loud', 'Solution', 'Time Complexity', 'Space Complexity'];

/** System design: "## 0." … "## 11." present and in order. */
function systemDesignSections(text) {
    const s = String(text || '');
    const at = [];
    for (let i = 0; i < 12; i++) {
        const m = new RegExp(`^#{1,4}\\s*(?:section\\s*)?${i}\\.`, 'mi').exec(s);
        at.push(m ? m.index : -1);
    }
    const missing = at.map((x, i) => (x < 0 ? i : null)).filter(x => x != null);
    const present = at.filter(x => x >= 0);
    const ordered = present.every((x, i) => i === 0 || x > present[i - 1]);
    return { ok: !missing.length && ordered, missing, ordered };
}

/** Concrete numbers with units (QPS, ms, GB, replicas, ...). */
function concreteNumbers(text) {
    const re = /\b\d[\d.,]*\s*(?:k|m|b|million|billion|mil|milh(?:oes|ões)|bilh(?:oes|ões))?\s*(?:qps|rps|req(?:uests)?\/s|ms|s\b|gb|tb|mb|kb|%|dau|mau|replicas?|nodes?|shards?|regions?|keys?|rpm)/gi;
    return (String(text || '').match(re) || []).length;
}

/** Fenced code blocks: [{ lang, code }]. */
function codeBlocks(text) {
    const out = [];
    const re = /```([\w+#.-]*)[^\n]*\n([\s\S]*?)```/g;
    let m;
    while ((m = re.exec(String(text || '')))) out.push({ lang: (m[1] || '').toLowerCase(), code: m[2] });
    return out;
}

/**
 * Run a JavaScript solution against tests in a fresh vm context.
 * @param {string} code
 * @param {string} fnName
 * @param {{ input: any[], expected: any, name?: string }[]} tests
 * @param {{ timeoutMs?: number }} [o]
 * @returns {{ loaded: boolean, error: string|null, passed: number, total: number, failures: object[], ms: number }}
 */
function runJsSolution(code, fnName, tests, { timeoutMs = 4000 } = {}) {
    const res = { loaded: false, error: null, passed: 0, total: tests.length, failures: [], ms: 0 };
    const module = { exports: {} };
    const ctx = vm.createContext({ module, exports: module.exports, console: { log() {}, error() {}, warn() {} } });
    const t0 = Date.now();
    try {
        const probe = `\n;(typeof ${fnName} === 'function' ? ${fnName}`
            + ` : typeof module.exports === 'function' ? module.exports`
            + ` : typeof module.exports.${fnName} === 'function' ? module.exports.${fnName}`
            + ` : typeof Solution === 'function' && typeof Solution.prototype.${fnName} === 'function' ? (...a) => new Solution().${fnName}(...a)`
            + ` : null)`;
        ctx.__fn = vm.runInContext(code + probe, ctx, { timeout: timeoutMs });
        if (typeof ctx.__fn !== 'function') throw new Error(`no function named ${fnName}`);
        res.loaded = true;
    } catch (err) {
        res.error = `load: ${err.message}`;
        return res;
    }
    for (const t of tests) {
        ctx.__args = JSON.parse(JSON.stringify(t.input));
        try {
            const got = vm.runInContext('__fn(...__args)', ctx, { timeout: timeoutMs });
            if (JSON.stringify(got) === JSON.stringify(t.expected)) res.passed++;
            else res.failures.push({ name: t.name, expected: t.expected, got });
        } catch (err) {
            res.failures.push({ name: t.name, error: /timed out/i.test(err.message) ? `timeout ${timeoutMs}ms` : err.message });
        }
    }
    res.ms = Date.now() - t0;
    return res;
}

/** p-quantile of numbers (nearest rank), or null. */
function quantile(xs, p) {
    const s = xs.filter(x => Number.isFinite(x)).sort((a, b) => a - b);
    if (!s.length) return null;
    return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
}

const FALLBACK_REPLY = {
    pt: 'Boa pergunta. Eu começaria pelo contexto e pelo resultado que a gente quer.',
    en: "Good question. I'd start from the context and the outcome we want.",
};

/**
 * What the candidate says back in phase B before the next question: the
 * answer's headline, as read off the panel, without markdown or a
 * "Headline:" label, at most maxWords words; a short line when nothing showed.
 */
function candidateReply(answer, lang, maxWords = 25) {
    const first = String(answer || '').split('\n').map(l => l.trim()).find(Boolean) || '';
    const plain = first
        .replace(/^[-*•]\s+/, '')
        .replace(/[*_#`]/g, '')
        .replace(/^(?:short\s+)?headline(?:\s+answer)?\s*:\s*/i, '')
        .trim();
    if (!plain || /^passive$/i.test(plain)) return FALLBACK_REPLY[/^pt/i.test(lang || '') ? 'pt' : 'en'];
    const ws = plain.split(/\s+/);
    return ws.length > maxWords ? `${ws.slice(0, maxWords).join(' ')}.` : plain;
}

module.exports = {
    candidateReply,
    words,
    wer,
    detectLang,
    answerShape,
    answerWords,
    endsWithClosingParagraph,
    mentions,
    plainMath,
    sectionsInOrder,
    systemDesignSections,
    concreteNumbers,
    codeBlocks,
    runJsSolution,
    quantile,
    CODE_SECTIONS,
};

'use strict';

// Markdown → retrievable chunks (FR-003, FR-004, FR-005). Pure: no fs.
//
// - Headings build a breadcrumb title "file › H2 › H3". The first H1, when it
//   comes before any other heading, is the document title and is skipped (the
//   file label stands in for it).
// - Each "**Q: …**" line (also "**Q1. …**", "**Q:** …") starts a Q-block that
//   runs to the next Q line or heading; its question joins the title.
// - Bodies longer than MAX_CHARS are split on paragraphs, then sentences, then
//   words; every piece repeats the title.
// - A title or Q line carrying an unfinished marker drops the chunk; a marker
//   line inside a body is removed.

const crypto = require('node:crypto');

const MAX_CHARS = 1200;
const MIN_CHARS = 300;
const MARKER_RE = /\[PREENCHER|\u26A0\uFE0F?\s*CONFIRMAR/i;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const Q_LINE_RE = /^\*\*Q(?:\d+[a-z]?)?(?:\s*\([^)]*\))?\s*[.:]\s*(?:\*\*\s*)?(.*?)\s*$/;
const FENCE_RE = /^\s*(?:```|~~~)/;
const RULE_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const SEP = ' › ';

const sha1 = s => crypto.createHash('sha1').update(s).digest('hex');

function fileLabel(path) {
    const base = String(path).split('/').pop() || '';
    return base.replace(/\.[^.]+$/, '');
}

/** Epoch ms from a YYYY-MM(-DD) in the file name, else null. */
function dateFromName(path) {
    const m = fileLabel(path).match(/(?:^|\D)(\d{4})-(\d{2})(?:-(\d{2}))?(?!\d)/);
    if (!m) return null;
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = m[3] ? Number(m[3]) : 1;
    if (year < 1990 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
    return Date.UTC(year, month - 1, day);
}

function stripFrontmatter(text) {
    if (!text.startsWith('---\n')) return text;
    const end = text.indexOf('\n---', 4);
    if (end < 0) return text;
    const after = text.indexOf('\n', end + 4);
    return after < 0 ? '' : text.slice(after + 1);
}

/** Heading text without emphasis markers or a trailing "{#anchor}". */
function cleanInline(s) {
    return s.replace(/\s*\{#[^}]*\}\s*$/, '').replace(/\*\*|__/g, '').replace(/\s+/g, ' ').trim();
}

/** "**Q: question?** inline answer" → { question, rest } or null. */
function parseQLine(line) {
    const m = line.match(Q_LINE_RE);
    if (!m) return null;
    let question = m[1];
    let rest = '';
    const close = question.indexOf('**');
    if (close >= 0) {
        rest = question.slice(close + 2).trim();
        question = question.slice(0, close);
    }
    question = cleanInline(question);
    if (!question) return null;
    return { question, rest };
}

function cleanBody(lines) {
    const kept = lines.filter(l => !MARKER_RE.test(l));
    while (kept.length && (RULE_RE.test(kept[0]) || !kept[0].trim())) kept.shift();
    while (kept.length && (RULE_RE.test(kept[kept.length - 1]) || !kept[kept.length - 1].trim())) kept.pop();
    return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Split text into pieces of at most `max` chars, packing `units` joined by `sep`. */
function pack(units, sep, max) {
    const pieces = [];
    let cur = '';
    for (const u of units) {
        if (!cur) cur = u;
        else if (cur.length + sep.length + u.length <= max) cur += sep + u;
        else {
            pieces.push(cur);
            cur = u;
        }
    }
    if (cur) pieces.push(cur);
    // Fold a short tail back into the previous piece when it still fits.
    if (pieces.length > 1) {
        const last = pieces[pieces.length - 1];
        const prev = pieces[pieces.length - 2];
        if (last.length < MIN_CHARS && prev.length + sep.length + last.length <= max) {
            pieces.splice(-2, 2, prev + sep + last);
        }
    }
    return pieces;
}

function splitWords(text, max) {
    const out = [];
    let rest = text;
    while (rest.length > max) {
        let cut = rest.lastIndexOf(' ', max);
        if (cut <= 0) cut = max;
        out.push(rest.slice(0, cut).trimEnd());
        rest = rest.slice(cut).trimStart();
    }
    if (rest) out.push(rest);
    return out;
}

// Split levels, coarsest first: paragraphs, lines, sentences; words last.
const LEVELS = [
    { re: /\n{2,}/, sep: '\n\n', trim: true },
    { re: /\n/, sep: '\n', trim: false },          // keep list indentation
    { re: /(?<=[.!?])\s+/, sep: ' ', trim: true },  // "3.5" has no space, so it stays whole
];

function splitText(text, max = MAX_CHARS, level = 0) {
    if (text.length <= max) return [text];
    if (level >= LEVELS.length) return splitWords(text, max);
    const { re, sep, trim } = LEVELS[level];
    const parts = text.split(re).map(p => (trim ? p.trim() : p.trimEnd())).filter(p => p.trim());
    if (parts.length <= 1) return splitText(text, max, level + 1);
    const units = [];
    for (const p of parts) units.push(...splitText(p, max, level + 1));
    return pack(units, sep, max);
}

/**
 * @param {string} path  relative to the KB root, forward slashes
 * @param {string} markdown
 * @param {{ mtime?: number, companiesOf?: (path: string) => string[] }} [opts]
 * @returns {import('../../../../specs/2026-10-11-live-answer-career-context/contracts/career-context.contracts').Chunk[]}
 */
function chunkMarkdown(path, markdown, opts = {}) {
    if (typeof markdown !== 'string' || !markdown) return [];
    const text = stripFrontmatter(markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'));
    const label = fileLabel(path);

    let companies = [];
    try {
        const c = typeof opts.companiesOf === 'function' ? opts.companiesOf(path) : [];
        if (Array.isArray(c)) companies = c.filter(x => typeof x === 'string' && x);
    } catch {
        companies = [];
    }
    const date = dateFromName(path) ?? (Number.isFinite(opts.mtime) ? opts.mtime : 0);

    // 1. Blocks: { crumbs, question, lines }
    const blocks = [];
    let stack = [];
    let seenHeading = false;
    let inFence = false;
    let cur = { crumbs: [], question: null, lines: [] };
    for (const line of text.split('\n')) {
        if (FENCE_RE.test(line)) {
            inFence = !inFence;
            cur.lines.push(line);
            continue;
        }
        if (!inFence) {
            const h = line.match(HEADING_RE);
            if (h) {
                const level = h[1].length;
                const title = cleanInline(h[2]);
                blocks.push(cur);
                if (level === 1 && !seenHeading) {
                    stack = [];                         // document title, not a breadcrumb level
                } else {
                    stack = stack.filter(s => s.level < level);
                    stack.push({ level, title });
                }
                seenHeading = true;
                cur = { crumbs: stack.map(s => s.title), question: null, lines: [] };
                continue;
            }
            const q = parseQLine(line);
            if (q) {
                blocks.push(cur);
                cur = { crumbs: stack.map(s => s.title), question: q.question, lines: q.rest ? [q.rest] : [] };
                continue;
            }
        }
        cur.lines.push(line);
    }
    blocks.push(cur);

    // 2. Chunks
    const chunks = [];
    const ordinals = new Map();
    for (const b of blocks) {
        const title = [label, ...b.crumbs, ...(b.question ? [b.question] : [])].join(SEP);
        if (MARKER_RE.test(title)) continue;
        const body = cleanBody(b.lines);
        if (!body) continue;
        for (const piece of splitText(body)) {
            const ordinal = ordinals.get(title) || 0;
            ordinals.set(title, ordinal + 1);
            chunks.push({
                id: sha1(`${path}\n${title}\n${ordinal}`).slice(0, 12),
                path,
                title,
                body: piece,
                companies: companies.slice(),
                date,
                kind: b.question ? 'qa' : 'section',
                hash: sha1(`${title}\n${piece}`),
            });
        }
    }
    return chunks;
}

module.exports = { chunkMarkdown, dateFromName, MARKER_RE, MAX_CHARS, MIN_CHARS, TITLE_SEP: SEP };

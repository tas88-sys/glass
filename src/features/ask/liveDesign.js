/**
 * liveDesign.js
 *
 * System Design · Live state shared by Ask and the Live Answer lane
 * (future-work items 18.1 and 18.11), and the fixed rules that decide what a
 * request asks for. Pure: no Electron, no settings or DB reads.
 *
 * - The Ask mode, kept in memory so the lane reads it on every turn without a
 *   settings read. featureBridge sets it at start, on a saved change, at each
 *   Listen session and on a user change (18.11 rule 10).
 * - The last kit of a session: { sessionId, kind: 'opening'|'design', question,
 *   answer, excerpt }. One slot, the latest (rule 5).
 * - resolveLiveRequest: what an Ask send asks for (rules 1 and 2).
 * - classifyKitAnswer: the type a finished answer is stored as (rule 5).
 * - kitExcerpt: the part of a design kit a probe gets (rule 7).
 * The interview's language (rule 11) is askLanguage.js, for every Ask mode.
 */

'use strict';

const { normalizeAskMode, cutAtLine } = require('./askPrompt');

const SD_LIVE = 'system_design_live';

/** The fixed words and the kit each one asks for (rule 2). */
const KIT_REQUEST_OF = Object.freeze({ opening: 'opening', design: 'design', next: 'design', full: 'design' });

/** With no heading recognized, a kit request is stored only from this many words (rule 5). */
const KIT_MIN_WORDS = 120;

/** How much of a design kit a probe gets when the kit has none of the expected parts (rule 7). */
const EXCERPT_MAX_CHARS = 2500;

const HINT_DESIGN_DONE = 'Design kit done. Type `design` to update it after a change.';

const DESIGN_HEADING_RE = /^#{1,4}\s*Requirements used\s*$/im;
const OPENING_HEADING_RE = /^#{1,4}\s*Frame\s*$/im;
const ANY_HEADING_RE = /^#{1,4}\s+\S/;

/**
 * A fixed word: the whole text, or the word and a colon (rule 2). Case is
 * ignored, and so are spaces at either end, a space before the colon and a
 * final period after a bare word. "design:" with nothing after it is "design".
 * @param {string} text
 * @returns {{ word: 'opening'|'design'|'next'|'full', arg: string }|null}
 */
function parseFixedWord(text) {
    const s = String(text == null ? '' : text).trim();
    const withColon = /^(opening|design|next|full)\s*:([\s\S]*)$/i.exec(s);
    if (withColon) return { word: withColon[1].toLowerCase(), arg: withColon[2].trim() };
    const bare = /^(opening|design|next|full)\s*\.?$/i.exec(s);
    if (bare) return { word: bare[1].toLowerCase(), arg: '' };
    return null;
}

/**
 * What an Ask send in System Design · Live asks for (rules 1 and 2).
 * @param {string} text - the box's text
 * @param {'opening'|'design'|null} kitKind - the kit stored for this session
 * @returns {{ send: string, kitRequest: 'opening'|'design'|null } | { hint: string }}
 */
function resolveLiveRequest(text, kitKind) {
    const typed = String(text == null ? '' : text).trim();
    if (!typed) {
        if (!kitKind) return { send: 'opening', kitRequest: 'opening' };
        if (kitKind === 'opening') return { send: 'design', kitRequest: 'design' };
        return { hint: HINT_DESIGN_DONE };
    }
    const fixed = parseFixedWord(typed);
    if (fixed) {
        return { send: fixed.arg ? `${fixed.word}: ${fixed.arg}` : fixed.word, kitRequest: KIT_REQUEST_OF[fixed.word] };
    }
    if (!kitKind) return { send: `opening: ${typed}`, kitRequest: 'opening' };
    return { send: typed, kitRequest: null };
}

function wordCount(text) {
    return (String(text || '').match(/\S+/g) || []).filter(w => /[\p{L}\p{N}]/u.test(w)).length;
}

/**
 * The type a finished System Design · Live answer is stored as, or null (rule 5).
 * The headings decide when they are recognized; with none, a kit request of at
 * least KIT_MIN_WORDS words is stored as the kit it asked for.
 * @param {string} answer
 * @param {'opening'|'design'|null} kitRequest
 * @returns {'opening'|'design'|null}
 */
function classifyKitAnswer(answer, kitRequest) {
    const text = String(answer || '');
    if (DESIGN_HEADING_RE.test(text)) return 'design';
    if (OPENING_HEADING_RE.test(text)) return 'opening';
    if ((kitRequest === 'opening' || kitRequest === 'design') && wordCount(text) >= KIT_MIN_WORDS) return kitRequest;
    return null;
}

/**
 * The part of a design kit a probe gets (rule 7): Requirements used, the
 * Decisions line, the Storage table and the deep dives' Pick lines. With none
 * of the first two, the kit cut at a line break.
 * @param {string} answer
 * @returns {string}
 */
function kitExcerpt(answer) {
    const text = String(answer || '');
    const lines = text.split(/\r?\n/);
    const parts = [];

    const reqAt = lines.findIndex(l => DESIGN_HEADING_RE.test(l));
    if (reqAt >= 0) {
        let end = lines.findIndex((l, i) => i > reqAt && ANY_HEADING_RE.test(l));
        if (end < 0) end = lines.length;
        parts.push(lines.slice(reqAt, end).join('\n').trim());
    }

    const decisions = lines.find(l => /\*\*Decisions:?\*\*/i.test(l));
    if (decisions) parts.push(decisions.trim());

    if (reqAt < 0 && !decisions) return cutAtLine(text, EXCERPT_MAX_CHARS);

    const storageAt = lines.findIndex(l => /\*\*Storage:?\*\*/i.test(l));
    if (storageAt >= 0) {
        const table = [];
        for (let i = storageAt + 1; i < lines.length; i++) {
            const l = lines[i].trim();
            if (l.startsWith('|')) table.push(l);
            else if (table.length || l) break;
        }
        if (table.length) parts.push(`Storage:\n${table.join('\n')}`);
    }

    const picks = lines.filter(l => /\*\*Pick:?\*\*/i.test(l)).map(l => l.trim());
    if (picks.length) parts.push(`Deep dives:\n${picks.join('\n')}`);

    return cutAtLine(parts.join('\n\n'), EXCERPT_MAX_CHARS);
}

/** The state: one per app. Tests and the eval harness make their own. */
function createLiveDesign() {
    let askMode = 'default';
    let kit = null;
    return {
        setAskMode(mode) {
            askMode = normalizeAskMode(mode);
            return askMode;
        },
        getAskMode: () => askMode,
        isSdLive: () => askMode === SD_LIVE,
        /** The kit stored for this session, or null. */
        getKit(sessionId) {
            return kit && kit.sessionId === sessionId ? kit : null;
        },
        storeKit({ sessionId, kind, question, answer }) {
            kit = { sessionId, kind, question: String(question || '').trim(), answer, excerpt: kind === 'design' ? kitExcerpt(answer) : null };
            return kit;
        },
        reset() {
            askMode = 'default';
            kit = null;
        },
    };
}

const liveDesign = createLiveDesign();

module.exports = liveDesign;
module.exports.createLiveDesign = createLiveDesign;
module.exports.parseFixedWord = parseFixedWord;
module.exports.resolveLiveRequest = resolveLiveRequest;
module.exports.classifyKitAnswer = classifyKitAnswer;
module.exports.kitExcerpt = kitExcerpt;
module.exports.wordCount = wordCount;
module.exports.SD_LIVE = SD_LIVE;
module.exports.KIT_MIN_WORDS = KIT_MIN_WORDS;
module.exports.EXCERPT_MAX_CHARS = EXCERPT_MAX_CHARS;
module.exports.HINT_DESIGN_DONE = HINT_DESIGN_DONE;

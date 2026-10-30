'use strict';

// Context block and prompt addendum (FR-013, FR-014). Pure.
//
// Block format (contracts):
//   [canonical facts]
//   <core text>
//
//   [<chunk title>]
//   <chunk body>
//
// The card is never cut. Chunks fill what is left of MAX_BLOCK_CHARS in rank
// order; the first one that does not fit whole is cut at a paragraph
// boundary and the rest are dropped.

const MAX_BLOCK_CHARS = 9000;
const BLOCK_CARD_LABEL = '[canonical facts]';
const CARD_SOURCE = 'canonical facts';
const SECTION_SEP = '\n\n';

const ADDENDUM_TEMPLATE =
    "The interviewer is asking about the candidate's own background. Answer in first person as the candidate, " +
    'using only facts from the User-provided context; the canonical facts override the other notes when they disagree. ' +
    'Do not invent employers, dates, metrics, technologies or projects. Every number must come from the notes with the same ' +
    'result, project and employer it has there; never move a number to another result, project or employer, and never ' +
    'estimate one: when the notes give no number for that result, state the result without a number. Say a technology or ' +
    'technique was used at an employer only when the notes say it was used there, not when they mention it as an idea or a ' +
    'general answer. For "tell me about a time" questions, pick one story and give ' +
    'situation, action and result in a few bullets. The notes were prepared for different companies: never present a ' +
    "company named in them as the interviewer's company.{COMPANY_CLAUSE}{NOT_USED_CLAUSE} Answer in the language the interviewer used.";

// The system prompt later substitutes this placeholder once; a note must not
// carry it (promptTemplates' outputInstructions comes after customPrompt).
const neutralize = s => s.replace(/\{\{CONVERSATION_HISTORY\}\}/g, 'CONVERSATION_HISTORY');

/**
 * @param {{ core: string, hits: Array<{chunk: object}>, maxChars?: number }} input
 * @returns {{ block: string, sources: string[], chunkIds: string[], cardOverCap: boolean }}
 */
function buildContextBlock({ core, hits, maxChars = MAX_BLOCK_CHARS }) {
    const card = typeof core === 'string' ? neutralize(core.trim()) : '';
    const cardSection = card ? `${BLOCK_CARD_LABEL}\n${card}` : '';

    // Group hits by path + title (pieces of one section share a header), in rank order.
    const groups = [];
    const byKey = new Map();
    for (const h of hits || []) {
        const c = h && h.chunk;
        if (!c) continue;
        const key = `${c.path}\n${c.title}`;
        let g = byKey.get(key);
        if (!g) {
            g = { title: c.title, ids: [], bodies: [] };
            byKey.set(key, g);
            groups.push(g);
        }
        if (g.ids.includes(c.id)) continue;
        g.ids.push(c.id);
        g.bodies.push(neutralize(String(c.body || '')));
    }

    const sections = cardSection ? [cardSection] : [];
    const sources = [];
    const chunkIds = [];
    const cardOverCap = cardSection.length > maxChars;
    let used = cardSection.length;

    if (!cardOverCap) {
        for (const g of groups) {
            const header = `[${g.title}]\n`;
            const sep = sections.length ? SECTION_SEP.length : 0;
            const body = g.bodies.join('\n\n');
            if (used + sep + header.length + body.length <= maxChars) {
                sections.push(header + body);
                used += sep + header.length + body.length;
                sources.push(g.title);
                chunkIds.push(...g.ids);
                continue;
            }
            // Cut at a paragraph boundary, keeping only whole leading paragraphs.
            const room = maxChars - used - sep - header.length;
            let kept = '';
            for (const p of body.split(/\n{2,}/)) {
                const next = kept ? `${kept}\n\n${p}` : p;
                if (next.length > room) break;
                kept = next;
            }
            if (kept) {
                sections.push(header + kept);
                sources.push(g.title);
                // Only the pieces whose text made it in.
                let seen = 0;
                for (let i = 0; i < g.bodies.length && seen < kept.length; i++) {
                    chunkIds.push(g.ids[i]);
                    seen += g.bodies[i].length + 2;
                }
            }
            break;
        }
    }

    if (cardSection) sources.push(CARD_SOURCE);
    return { block: sections.join(SECTION_SEP), sources, chunkIds, cardOverCap };
}

// R21 (spec 2026-10-13-career-router-jev): the interviewer opened the floor to the
// candidate's questions, so the answer is questions to ask, not an answer.
const INVITE_ADDENDUM =
    ' Here the interviewer is inviting the candidate\'s questions: instead of answering, suggest two or three short questions ' +
    'for the candidate to ask, taken from the notes when they have some for this company, in the language the interviewer used.';

// Future-work item 10: answers claimed technologies the notes list as never used.
const MAX_NOT_USED = 30;

function notUsedClause(names) {
    const seen = new Set();
    const list = [];
    for (const n of Array.isArray(names) ? names : []) {
        const name = typeof n === 'string' ? n.trim() : '';
        if (!name || seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());
        list.push(name);
        if (list.length === MAX_NOT_USED) break;
    }
    if (!list.length) return '';
    return ` The candidate has never used: ${list.join(', ')}. Never claim experience with them; if asked, say so and name the closest one the notes give.`;
}

/** FR-014 addendum; names the interviewer's company when it is known, and the manifest's notUsed (not on an invitation). */
function buildAddendum(activeCompany, opts = {}) {
    const clause = activeCompany ? ` The interviewer's company is ${activeCompany}.` : '';
    return ADDENDUM_TEMPLATE
        .replace('{COMPANY_CLAUSE}', clause)
        .replace('{NOT_USED_CLAUSE}', opts.invite ? '' : notUsedClause(opts.notUsed)) + (opts.invite ? INVITE_ADDENDUM : '');
}

module.exports = { buildContextBlock, buildAddendum, ADDENDUM_TEMPLATE, INVITE_ADDENDUM, BLOCK_CARD_LABEL, CARD_SOURCE, MAX_BLOCK_CHARS };

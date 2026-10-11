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

const MAX_BLOCK_CHARS = 6000;
const BLOCK_CARD_LABEL = '[canonical facts]';
const CARD_SOURCE = 'canonical facts';
const SECTION_SEP = '\n\n';

const ADDENDUM_TEMPLATE =
    "The interviewer is asking about the candidate's own background. Answer in first person as the candidate, " +
    'using only facts from the User-provided context; the canonical facts override the other notes when they disagree. ' +
    'Do not invent employers, dates, metrics or projects. For "tell me about a time" questions, pick one story and give ' +
    'situation, action and result in a few bullets. The notes were prepared for different companies: never present a ' +
    "company named in them as the interviewer's company.{COMPANY_CLAUSE} Answer in the language the interviewer used.";

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

/** FR-014 addendum; names the interviewer's company when it is known. */
function buildAddendum(activeCompany) {
    const clause = activeCompany ? ` The interviewer's company is ${activeCompany}.` : '';
    return ADDENDUM_TEMPLATE.replace('{COMPANY_CLAUSE}', clause);
}

module.exports = { buildContextBlock, buildAddendum, ADDENDUM_TEMPLATE, BLOCK_CARD_LABEL, CARD_SOURCE, MAX_BLOCK_CHARS };

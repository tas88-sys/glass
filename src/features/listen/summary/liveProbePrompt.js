'use strict';

// The Live Answer lane's messages in System Design · Live, once a design kit
// exists (future-work items 18.1 and 18.11, rule 7): the probe profile, the
// transcript and the kit's excerpt, and the PROBE shape instead of the lane's
// LENGTH_RULE. No career context. Pure (no Electron): summaryService and the
// live eval build the same messages.

const { getSystemPrompt } = require('../../common/prompts/promptBuilder.js');
const { answerLanguageRule } = require('./questionLanguage');

const PROBE_PROFILE = 'pickle_glass_system_design_probe';

const PROBE_RULE =
    'Answer it in the PROBE shape, at most 90 words: the direct answer said aloud first, then one or two reasons, then the trade-off line. ' +
    'Keep the design kit\'s decisions and numbers unless the interviewer changed them. ';

/**
 * @param {object} o
 * @param {string} o.recent - the transcript as the lane formats it (last 30 turns)
 * @param {string} o.asked - the interviewer's turn being answered
 * @param {string} o.excerpt - liveDesign.kitExcerpt of the stored design kit
 * @returns {{ role: string, content: string }[]}
 */
function buildLiveProbeMessages({ recent, asked, excerpt }) {
    const context = `Transcript:\n${recent || 'No conversation history available.'}\n\nDesign kit (the candidate's design, excerpt):\n${excerpt || '(none)'}`;
    const turn = String(asked || '').trim();
    return [
        { role: 'system', content: getSystemPrompt(PROBE_PROFILE, context, false) },
        {
            role: 'user',
            content:
                (turn ? `The interviewer's most recent question, their last turn in the transcript: "${turn}"\n\n` : '') +
                PROBE_RULE +
                answerLanguageRule(turn) +
                'keeping technical terms as they are commonly said. ' +
                'If there is no clear question or nothing useful to answer, reply EXACTLY: PASSIVE',
        },
    ];
}

module.exports = { buildLiveProbeMessages, PROBE_PROFILE, PROBE_RULE };

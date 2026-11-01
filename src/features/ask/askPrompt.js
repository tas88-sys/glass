/**
 * askPrompt.js
 *
 * The Ask request's messages: the system prompt of the chosen mode and the
 * user turn, with the screenshot when there is one. Pure (no Electron, no
 * settings or DB reads): askService.sendMessage passes what it read, and the
 * live eval (scripts/live-eval) builds the same messages the app sends.
 */

'use strict';

const { getSystemPrompt } = require('../common/prompts/promptBuilder');

const VALID_MODES = Object.freeze(['default', 'code', 'debug', 'system_design', 'system_design_live']);

const PROFILE_BY_MODE = Object.freeze({
    default: 'pickle_glass_analysis',
    code: 'pickle_glass_code',
    debug: 'pickle_glass_debug',
    system_design: 'pickle_glass_system_design',
    system_design_live: 'pickle_glass_system_design_live',
});

/** How much of the previous System Design · Live answer goes back into the prompt. */
const PREVIOUS_ANSWER_MAX_CHARS = 6000;

/** @param {unknown} rawMode @returns {'default'|'code'|'debug'|'system_design'|'system_design_live'} */
function normalizeAskMode(rawMode) {
    return VALID_MODES.includes(rawMode) ? rawMode : 'default'; // defensive coerce
}

/** The text cut to max characters at a line break, marked as cut. */
function cutAtLine(text, max) {
    const s = String(text || '');
    if (s.length <= max) return s;
    const at = s.lastIndexOf('\n', max);
    return `${s.slice(0, at > max / 2 ? at : max).trimEnd()}\n[… cut]`;
}

/**
 * Whether a System Design · Live answer is one of the two kits (opening or
 * design, or both in "full"). Only a kit is kept as the previous answer: a deep
 * dive or a probe must not replace the design the next question builds on.
 * @param {string} text
 * @returns {boolean}
 */
function isLiveDesignKit(text) {
    return /^#{1,4}\s*(?:Frame|Requirements used)\s*$/mi.test(String(text || ''));
}

/**
 * The context block of System Design · Live: the transcript, then the previous
 * answer in this mode when there is one.
 * @param {string} conversationHistory - formatConversationForAsk output
 * @param {{ question?: string, answer?: string }|null} [previousAnswer]
 * @returns {string}
 */
function liveDesignContext(conversationHistory, previousAnswer) {
    const parts = [`Transcript:\n${conversationHistory}`];
    if (previousAnswer && previousAnswer.answer) {
        const asked = String(previousAnswer.question || '').trim() || '(screenshot only)';
        parts.push(`Previous answer (your last answer in this mode, in this interview):\nRequest: ${asked}\n${cutAtLine(previousAnswer.answer, PREVIOUS_ANSWER_MAX_CHARS)}`);
    }
    return parts.join('\n\n');
}

/**
 * The Listen transcript as the Ask prompt shows it: the last 30 turns.
 * @param {string[]} conversationTexts - ["me: …", "them: …", …]
 * @returns {string}
 */
function formatConversationForAsk(conversationTexts) {
    if (!conversationTexts || conversationTexts.length === 0) {
        return 'No conversation history available.';
    }
    return conversationTexts.slice(-30).join('\n');
}

/**
 * @param {object} o
 * @param {string} o.askMode - from settings; anything else reads as 'default'
 * @param {string} o.userPrompt
 * @param {string} o.conversationHistory - formatConversationForAsk output
 * @param {string} [o.preferredCodeLanguage] - used in 'code' mode only
 * @param {string|null} [o.screenshotBase64] - JPEG
 * @param {{ question?: string, answer?: string }|null} [o.previousAnswer] - used in 'system_design_live' mode only
 * @returns {{ askMode: string, profile: string, systemPrompt: string, messages: object[] }}
 */
function buildAskMessages({ askMode: rawMode, userPrompt, conversationHistory, preferredCodeLanguage, screenshotBase64, previousAnswer = null }) {
    const askMode = normalizeAskMode(rawMode);
    const profile = PROFILE_BY_MODE[askMode];

    // preferredCodeLanguage only meaningful for 'code' mode; trim + empty fallback.
    let language = '';
    if (askMode === 'code') {
        language = (preferredCodeLanguage || '').trim();
    }

    // Build prompt. For code mode, inject language via token replacement.
    let systemPrompt;
    if (askMode === 'code') {
        const base = getSystemPrompt(profile, conversationHistory, false);
        systemPrompt = base.replace('{{PREFERRED_LANGUAGE}}', language || '__INFER_FROM_SCREENSHOT__');
    } else if (askMode === 'system_design_live') {
        systemPrompt = getSystemPrompt(profile, liveDesignContext(conversationHistory, previousAnswer), false);
    } else {
        systemPrompt = getSystemPrompt(profile, conversationHistory, false);
    }

    const messages = [
        { role: 'system', content: systemPrompt },
        {
            role: 'user',
            content: [
                { type: 'text', text: `User Request: ${userPrompt.trim()}` },
            ],
        },
    ];

    if (screenshotBase64) {
        messages[1].content.push({
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${screenshotBase64}` },
        });
    }

    return { askMode, profile, systemPrompt, messages };
}

module.exports = { VALID_MODES, PROFILE_BY_MODE, PREVIOUS_ANSWER_MAX_CHARS, normalizeAskMode, isLiveDesignKit, formatConversationForAsk, buildAskMessages };

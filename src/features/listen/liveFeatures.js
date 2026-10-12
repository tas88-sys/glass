'use strict';

/**
 * liveFeatures.js
 *
 * Which Listen lanes run: Live Answer, Live Insights or both (spec
 * 2026-10-12-live-features-toggle, FR-001). One stored value per user,
 * `liveFeatures` in the settings store; a lane that is off makes no LLM call.
 *
 * Pure and self-contained (no dependencies, no side effects) so the main
 * process, the renderer bundle and node:test all load the same file.
 * Any value other than the three modes reads as 'both', which is today's
 * behaviour.
 */

const LIVE_FEATURES = Object.freeze(['both', 'answer', 'insights']);
const DEFAULT_LIVE_FEATURES = 'both';

/** both -> answer -> insights -> both (the Settings button cycle). */
const NEXT = { both: 'answer', answer: 'insights', insights: 'both' };

const LABELS = { both: 'Answer + Insights', answer: 'Answer only', insights: 'Insights only' };

/**
 * @param {unknown} value
 * @returns {'both'|'answer'|'insights'} the value when it is one of the three, else 'both'
 */
function normalizeLiveFeatures(value) {
    return LIVE_FEATURES.includes(value) ? value : DEFAULT_LIVE_FEATURES;
}

/** @param {unknown} mode @returns {boolean} whether Live Answer runs */
function answerEnabled(mode) {
    return normalizeLiveFeatures(mode) !== 'insights';
}

/** @param {unknown} mode @returns {boolean} whether Live Insights runs */
function insightsEnabled(mode) {
    return normalizeLiveFeatures(mode) !== 'answer';
}

/** @param {unknown} mode @returns {'both'|'answer'|'insights'} */
function nextLiveFeatures(mode) {
    return NEXT[normalizeLiveFeatures(mode)];
}

/**
 * The state the IPC returns and pushes to the Listen window.
 * @param {unknown} mode
 * @returns {{mode:'both'|'answer'|'insights', answer:boolean, insights:boolean}}
 */
function liveFeaturesState(mode) {
    const normalized = normalizeLiveFeatures(mode);
    return { mode: normalized, answer: answerEnabled(normalized), insights: insightsEnabled(normalized) };
}

/** @param {unknown} mode @returns {string} the Settings button label */
function liveFeaturesLabel(mode) {
    return LABELS[normalizeLiveFeatures(mode)];
}

/**
 * Listen window texts. With Answer only, the window names the answer; with
 * Insights on, it keeps today's labels. A new object each call.
 * @param {unknown} mode
 * @returns {{title:string, showButton:string, copyHover:string}}
 */
function viewLabels(mode) {
    if (normalizeLiveFeatures(mode) === 'answer') {
        return { title: 'Live answer', showButton: 'Show Answer', copyHover: 'Copy Glass Answer' };
    }
    return { title: 'Live insights', showButton: 'Show Insights', copyHover: 'Copy Glass Analysis' };
}

module.exports = {
    LIVE_FEATURES,
    DEFAULT_LIVE_FEATURES,
    normalizeLiveFeatures,
    answerEnabled,
    insightsEnabled,
    nextLiveFeatures,
    liveFeaturesState,
    liveFeaturesLabel,
    viewLabels,
};

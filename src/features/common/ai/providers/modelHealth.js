/**
 * modelHealth.js
 *
 * In-memory health registry for model failover, shared by the Gemini and
 * Anthropic providers. Keyed by model ID: gemini-… and claude-… never collide.
 * Singleton module — one Electron process, one shared rate-limit budget.
 *
 * Exports: parseModelList, pickModel, markFailed, markSucceeded, resetHealth,
 *          DEFAULT_COOLDOWN_MS, MIN_COOLDOWN_MS, MAX_COOLDOWN_MS
 */

'use strict';

// Map<modelId, { cooldownUntil: number /* epoch ms */ }>
const health = new Map();

const DEFAULT_COOLDOWN_MS = 60_000;   // 60 s
const MIN_COOLDOWN_MS     =  5_000;   //  5 s
const MAX_COOLDOWN_MS     = 300_000;  // 5 min

// ---------------------------------------------------------------------------
// parseModelList
// ---------------------------------------------------------------------------
/**
 * Split a comma-separated model CSV into a trimmed, non-empty list.
 * @param {string|null|undefined} csv
 * @returns {string[]}
 */
function parseModelList(csv) {
  if (csv == null) return [];
  if (typeof csv !== 'string') return [];
  return csv.split(',').map(s => s.trim()).filter(s => s.length > 0);
}

// ---------------------------------------------------------------------------
// pickModel
// ---------------------------------------------------------------------------
/**
 * Return the best model to use from the list.
 *  - First healthy model in declared order.
 *  - If all are cooling down, return the soonest-to-recover (try-anyway).
 * @param {string[]} modelList
 * @returns {string}
 */
function pickModel(modelList) {
  if (!modelList || modelList.length === 0) {
    throw new Error('pickModel: empty model list');
  }
  const now = Date.now();
  for (const id of modelList) {
    const entry = health.get(id);
    if (!entry || entry.cooldownUntil <= now) return id;
  }
  // All cooling down — pick soonest-recovering and try anyway
  return modelList
    .map(id => ({ id, until: health.get(id)?.cooldownUntil ?? 0 }))
    .sort((a, b) => a.until - b.until)[0].id;
}

// ---------------------------------------------------------------------------
// markFailed / markSucceeded
// ---------------------------------------------------------------------------
/**
 * Record a transient failure; place model in cooldown.
 * @param {string} modelId
 * @param {number} cooldownMs - duration in ms (will be clamped)
 */
function markFailed(modelId, cooldownMs) {
  const clamped = Math.min(MAX_COOLDOWN_MS, Math.max(MIN_COOLDOWN_MS, cooldownMs));
  health.set(modelId, { cooldownUntil: Date.now() + clamped });
}

/**
 * Record a successful response; clear cooldown entry entirely.
 * @param {string} modelId
 */
function markSucceeded(modelId) {
  health.delete(modelId);
}

// ---------------------------------------------------------------------------
// resetHealth  (@internal — test helper)
// ---------------------------------------------------------------------------
/**
 * Clear all cooldown state. For use in test beforeEach only.
 * @internal
 */
function resetHealth() {
  health.clear();
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  parseModelList,
  pickModel,
  markFailed,
  markSucceeded,
  resetHealth,
  DEFAULT_COOLDOWN_MS,
  MIN_COOLDOWN_MS,
  MAX_COOLDOWN_MS,
};

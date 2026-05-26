/**
 * geminiModelRotator.js
 *
 * In-memory health registry for Gemini model failover.
 * Singleton module — one Electron process, one shared rate-limit budget.
 *
 * Exports: pickModel, markFailed, markSucceeded, classifyError,
 *          parseRetryAfter, parseModelList, resetHealth
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
// classifyError
// ---------------------------------------------------------------------------
/**
 * Classify an error into one of three tiers:
 *   'transient'     – cool down current model, try next
 *   'fatal-request' – bad payload/model name; surface immediately
 *   'fatal-auth'    – API key issue; surface immediately
 *
 * Inspection order: explicit status code → errorDetails ErrorInfo reason
 * → message-text heuristics. Unknown defaults to 'transient' (fail-open).
 *
 * @param {unknown} err
 * @returns {'transient'|'fatal-request'|'fatal-auth'}
 */
function classifyError(err) {
  if (!err || typeof err !== 'object') return 'transient';

  // Tier (a): explicit HTTP status code
  const status = err.status ?? err.statusCode ?? err.httpStatus;
  if (typeof status === 'number') {
    if ([408, 429, 500, 502, 503, 504].includes(status)) return 'transient';
    if (status === 400) return 'fatal-request';
    if (status === 401 || status === 403) return 'fatal-auth';
  }

  // Tier (b): errorDetails[] ErrorInfo reason field
  const errorDetails = err.errorDetails ?? err.details;
  if (Array.isArray(errorDetails)) {
    const errorInfo = errorDetails.find(d =>
      typeof d === 'object' && d !== null &&
      typeof d['@type'] === 'string' && d['@type'].includes('ErrorInfo')
    );
    if (errorInfo && errorInfo.reason) {
      const reason = errorInfo.reason;
      if (['RESOURCE_EXHAUSTED', 'UNAVAILABLE', 'DEADLINE_EXCEEDED'].includes(reason)) return 'transient';
      if (reason === 'INVALID_ARGUMENT') return 'fatal-request';
      if (['PERMISSION_DENIED', 'API_KEY_INVALID'].includes(reason)) return 'fatal-auth';
    }
  }

  // Tier (c): message-text heuristics
  const msg = typeof err.message === 'string' ? err.message.toLowerCase() : '';
  const name = typeof err.name === 'string' ? err.name : '';
  if (name === 'AbortError') return 'transient';
  if (name === 'TypeError' && msg.includes('fetch failed')) return 'transient';
  if (name === 'TypeError' && msg.includes('network')) return 'transient';
  if (msg.includes('network') || msg.includes('econnrefused') || msg.includes('etimedout')) return 'transient';

  // Fail-open: unknown errors treated as transient so the loop continues
  return 'transient';
}

// ---------------------------------------------------------------------------
// parseRetryAfter
// ---------------------------------------------------------------------------
/**
 * Determine cooldown duration from error metadata.
 *
 * Inspection order:
 *   1. errorDetails[].@type containing 'RetryInfo' with retryDelay 'Ns'
 *   2. HTTP Retry-After header (numeric seconds or HTTP-date)
 *   3. Default DEFAULT_COOLDOWN_MS
 *
 * Result is clamped to [MIN_COOLDOWN_MS, MAX_COOLDOWN_MS].
 *
 * @param {unknown} err
 * @returns {number} cooldown in milliseconds
 */
function parseRetryAfter(err) {
  let ms = DEFAULT_COOLDOWN_MS;

  if (err && typeof err === 'object') {
    // 1. errorDetails RetryInfo
    const errorDetails = err.errorDetails ?? err.details;
    if (Array.isArray(errorDetails)) {
      const retryInfo = errorDetails.find(d =>
        typeof d === 'object' && d !== null &&
        typeof d['@type'] === 'string' && d['@type'].includes('RetryInfo') &&
        d.retryDelay
      );
      if (retryInfo) {
        const match = String(retryInfo.retryDelay).match(/^(\d+(?:\.\d+)?)s$/);
        if (match) {
          ms = Math.round(parseFloat(match[1]) * 1000);
        }
      }
    }

    // 2. HTTP Retry-After header
    if (ms === DEFAULT_COOLDOWN_MS) {
      const retryAfterHeader =
        err.retryAfter ??
        err['retry-after'] ??
        err.headers?.get?.('retry-after') ??
        err.headers?.['retry-after'];

      if (retryAfterHeader != null) {
        const numeric = Number(retryAfterHeader);
        if (!isNaN(numeric) && isFinite(numeric)) {
          ms = numeric * 1000;
        } else {
          const parsed = Date.parse(retryAfterHeader);
          if (!isNaN(parsed)) {
            ms = Math.max(0, parsed - Date.now());
          }
        }
      }
    }
  }

  return Math.min(MAX_COOLDOWN_MS, Math.max(MIN_COOLDOWN_MS, ms));
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
  pickModel,
  markFailed,
  markSucceeded,
  classifyError,
  parseRetryAfter,
  parseModelList,
  resetHealth,
};

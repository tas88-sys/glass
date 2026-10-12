/**
 * geminiModelRotator.js
 *
 * Gemini model failover: error classification and retry-after parsing, plus
 * the shared cooldown registry from modelHealth.js, re-exported unchanged.
 *
 * Exports: pickModel, markFailed, markSucceeded, classifyError,
 *          parseRetryAfter, parseModelList, resetHealth
 */

'use strict';

// The cooldown registry (parseModelList, pickModel, markFailed, markSucceeded,
// resetHealth) lives in modelHealth.js, shared with the Anthropic provider.
const health = require('./modelHealth');
const { DEFAULT_COOLDOWN_MS, MIN_COOLDOWN_MS, MAX_COOLDOWN_MS } = health;

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
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  pickModel: health.pickModel,
  markFailed: health.markFailed,
  markSucceeded: health.markSucceeded,
  classifyError,
  parseRetryAfter,
  parseModelList: health.parseModelList,
  resetHealth: health.resetHealth,
};

/**
 * anthropicErrors.js
 *
 * Error classification for the Anthropic provider's failover loop. Pure: reads
 * the SDK error shapes (status, type, body, headers) and the codes the
 * provider sets on errors it creates itself.
 *
 * Exports: classify, retryAfterMs, retryAfterHeaderMs, shortErrorMessage
 */

'use strict';

const { DEFAULT_COOLDOWN_MS, MIN_COOLDOWN_MS, MAX_COOLDOWN_MS } = require('./modelHealth');

const TRANSIENT_STATUSES = [408, 409, 429, 500, 502, 503, 504, 529];
const FATAL_REQUEST_STATUSES = [400, 413, 422];
const FATAL_AUTH_STATUSES = [401, 402, 403];
const TRANSIENT_TYPES = ['overloaded_error', 'api_error', 'rate_limit_error', 'timeout_error'];

/**
 * The API error type: err.type (SDK ≥ 0.81, also set on stream `error`
 * events), else the type in the body ({ type: 'error', error: { type } }).
 * @param {object} err
 * @returns {string|undefined}
 */
function errorType(err) {
  return err.type || err.error?.error?.type || undefined;
}

/**
 * Classify an error:
 *   'transient'     – cool the model down, try the next one
 *   'unavailable'   – the model is retired or not enabled for this key (404)
 *   'refusal'       – the model declined (stop_reason refusal); no cooldown
 *   'fatal-request' – wrong for every model (bad payload); surface at once
 *   'fatal-auth'    – key, permission or billing; surface at once
 *
 * Inspection order: provider code → HTTP status → error type → fail-open
 * (connection errors and anything unknown are transient, as in Gemini).
 *
 * @param {unknown} err
 * @returns {'transient'|'unavailable'|'refusal'|'fatal-request'|'fatal-auth'}
 */
function classify(err) {
  if (!err || typeof err !== 'object') return 'transient';

  if (err.code === 'REFUSAL') return 'refusal';
  if (['FIRST_TEXT_TIMEOUT', 'IDLE_TIMEOUT', 'EMPTY_MAX_TOKENS'].includes(err.code)) return 'transient';

  const status = err.status;
  if (typeof status === 'number') {
    if (TRANSIENT_STATUSES.includes(status)) return 'transient';
    if (status === 404) return 'unavailable';
    if (FATAL_REQUEST_STATUSES.includes(status)) return 'fatal-request';
    if (FATAL_AUTH_STATUSES.includes(status)) return 'fatal-auth';
  }

  const type = errorType(err);
  if (TRANSIENT_TYPES.includes(type)) return 'transient';
  if (type === 'invalid_request_error') return 'fatal-request';

  return 'transient';
}

function header(err, name) {
  const headers = err?.headers;
  if (!headers) return null;
  const value = typeof headers.get === 'function' ? headers.get(name) : headers[name];
  return value == null ? null : String(value);
}

/**
 * The server's own retry hint, unclamped: retry-after-ms, then retry-after
 * (seconds or HTTP date). Null when there is none or it cannot be read.
 * @param {unknown} err
 * @returns {number|null} milliseconds
 */
function retryAfterHeaderMs(err) {
  const rawMs = header(err, 'retry-after-ms');
  if (rawMs != null && rawMs.trim() !== '') {
    const ms = Number(rawMs);
    if (Number.isFinite(ms) && ms >= 0) return ms;
  }

  const raw = header(err, 'retry-after');
  if (raw == null || raw.trim() === '') return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : null;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

/**
 * Cooldown for a transient error: the server's retry hint, else 60 s,
 * clamped to [5 s, 5 min].
 * @param {unknown} err
 * @returns {number} milliseconds
 */
function retryAfterMs(err) {
  const ms = retryAfterHeaderMs(err) ?? DEFAULT_COOLDOWN_MS;
  return Math.min(MAX_COOLDOWN_MS, Math.max(MIN_COOLDOWN_MS, ms));
}

/**
 * The server's reason without SDK noise, at most 160 characters. The SDK
 * formats HTTP errors as "529 {json body}"; the message inside is kept.
 * @param {unknown} err
 * @returns {string}
 */
function shortErrorMessage(err) {
  let msg = err?.error?.error?.message;
  if (typeof msg !== 'string' || msg === '') {
    msg = String(err?.message ?? err);
    const envelope = /^\d{3} (\{.*\})$/s.exec(msg);
    if (envelope) {
      try {
        const body = JSON.parse(envelope[1]);
        const inner = body?.error?.message ?? body?.message;
        if (typeof inner === 'string' && inner !== '') msg = inner;
      } catch {
        /* not JSON: keep the message as it is */
      }
    }
  }
  return msg.slice(0, 160);
}

module.exports = {
  classify,
  retryAfterMs,
  retryAfterHeaderMs,
  shortErrorMessage,
};

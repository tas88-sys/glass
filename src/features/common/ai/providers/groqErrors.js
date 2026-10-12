/**
 * groqErrors.js
 *
 * Error classification for the Groq provider's failover loop. Pure: reads the
 * groq-sdk error shapes (status, body, headers) and the codes the provider
 * sets on errors it creates itself.
 *
 * groq-sdk keeps two body shapes: an HTTP error carries the whole JSON body
 * ({ error: { message, type, code } }), a mid-stream {"error": …} carries the
 * inner object. Neither sets err.type.
 *
 * Exports: classify, retryAfterMs, retryAfterHeaderMs, shortErrorMessage,
 *          tooLargeNumbers, errorCode
 */

'use strict';

const { DEFAULT_COOLDOWN_MS, MIN_COOLDOWN_MS, MAX_COOLDOWN_MS } = require('./modelHealth');

const PROVIDER_TRANSIENT_CODES = ['FIRST_TEXT_TIMEOUT', 'IDLE_TIMEOUT', 'EMPTY_MAX_TOKENS', 'STREAM_ERROR'];
const TRANSIENT_STATUSES = [408, 409, 422, 429, 498];
const FATAL_REQUEST_STATUSES = [400, 424];
const FATAL_AUTH_STATUSES = [401, 403];

/**
 * Groq's error object ({ message, type, code }) from either body shape, or null.
 * @param {object} err
 * @returns {object|null}
 */
function errorBody(err) {
  const outer = err?.error;
  if (outer?.error && typeof outer.error === 'object') return outer.error;
  if (outer && typeof outer === 'object') return outer;
  return null;
}

/**
 * Groq's error code (rate_limit_exceeded, model_not_found, …), or null.
 * @param {unknown} err
 * @returns {string|null}
 */
function errorCode(err) {
  const code = errorBody(err)?.code;
  return typeof code === 'string' && code !== '' ? code : null;
}

/**
 * Classify an error:
 *   'transient'     – cool the model down, try the next one
 *   'unavailable'   – the model is decommissioned, blocked or not found for this key
 *   'too-large'     – this request alone is over the model's per-minute token limit (413)
 *   'fatal-request' – wrong for every model (bad payload); surface at once
 *   'fatal-auth'    – key or permission; surface at once
 *
 * Inspection order: provider code → Groq model_ code → HTTP status → body
 * type → fail-open (connection errors and anything unknown are transient, as
 * in Gemini and Anthropic).
 *
 * @param {unknown} err
 * @returns {'transient'|'unavailable'|'too-large'|'fatal-request'|'fatal-auth'}
 */
function classify(err) {
  if (!err || typeof err !== 'object') return 'transient';

  if (PROVIDER_TRANSIENT_CODES.includes(err.code)) return 'transient';

  // model_not_found, model_decommissioned and the model permission codes come
  // with 400, 403 or 404; the code says what the status cannot.
  if (errorCode(err)?.startsWith('model_')) return 'unavailable';

  const status = err.status;
  if (typeof status === 'number') {
    if (status === 413) return 'too-large';
    if (status === 404) return 'unavailable';
    if (TRANSIENT_STATUSES.includes(status) || status >= 500) return 'transient';
    if (FATAL_REQUEST_STATUSES.includes(status)) return 'fatal-request';
    if (FATAL_AUTH_STATUSES.includes(status)) return 'fatal-auth';
  }

  if (errorBody(err)?.type === 'invalid_request_error') return 'fatal-request';

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
 * formats HTTP errors as "429 {json body}"; the message inside is kept.
 * @param {unknown} err
 * @returns {string}
 */
function shortErrorMessage(err) {
  let msg = err && typeof err === 'object' ? errorBody(err)?.message : undefined;
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

/**
 * "Limit L, Requested R" from a 413 "Request too large … (TPM)" message.
 * @param {unknown} err
 * @returns {{ limit: number, requested: number }|null}
 */
function tooLargeNumbers(err) {
  if (!err || typeof err !== 'object') return null;
  const text = `${errorBody(err)?.message ?? ''} ${err.message ?? ''}`;
  const m = /Limit (\d+), Requested (\d+)/.exec(text);
  return m ? { limit: Number(m[1]), requested: Number(m[2]) } : null;
}

module.exports = {
  classify,
  retryAfterMs,
  retryAfterHeaderMs,
  shortErrorMessage,
  tooLargeNumbers,
  errorCode,
};

/**
 * openaiCompatibleErrors.js
 *
 * Error classification for the OpenAI-compatible provider's failover loop.
 * Pure: reads the openai SDK error shapes (status, body, headers) and the
 * codes the provider sets on errors it creates itself.
 *
 * The endpoint is any server that speaks the OpenAI chat-completions API: a
 * provider's own (SambaNova, Mistral), an aggregator (OpenRouter) or a local
 * gateway (OmniRoute). Behind an aggregator each model may be served by a
 * different upstream, so a refusal of one model's request says little about
 * the next model's: only the key (shared by every model) ends the request.
 *
 * The body helpers are groqErrors' own: both SDKs keep the server's
 * { error: { message, type, code } } and the retry headers the same way.
 *
 * Exports: classify, retryAfterMs, retryAfterHeaderMs, shortErrorMessage, errorCode
 */

'use strict';

const { retryAfterMs, retryAfterHeaderMs, shortErrorMessage, errorCode } = require('./groqErrors');

const PROVIDER_TRANSIENT_CODES = ['FIRST_TEXT_TIMEOUT', 'IDLE_TIMEOUT', 'EMPTY_MAX_TOKENS', 'STREAM_ERROR'];
const TRANSIENT_STATUSES = [408, 409, 425, 429, 498];
const REJECTED_STATUSES = [400, 422];
const FATAL_AUTH_STATUSES = [401, 403];

/**
 * Classify an error:
 *   'transient'   – cool the model down, try the next one
 *   'unavailable' – the endpoint does not serve the model to this key (404), or
 *                   the model needs credit the account lacks (402)
 *   'too-large'   – the request is over the model's limit (413); the next request may fit
 *   'rejected'    – the model refused this request (400, 422): a parameter or
 *                   image its upstream does not take. Try the next model
 *   'fatal-auth'  – key or permission (401, 403): every model shares the key; surface at once
 *
 * Inspection order: provider code → HTTP status → fail-open (connection
 * errors and anything unknown are transient, as in the other providers).
 *
 * @param {unknown} err
 * @returns {'transient'|'unavailable'|'too-large'|'rejected'|'fatal-auth'}
 */
function classify(err) {
  if (!err || typeof err !== 'object') return 'transient';

  if (PROVIDER_TRANSIENT_CODES.includes(err.code)) return 'transient';

  const status = err.status;
  if (typeof status === 'number') {
    if (status === 404 || status === 402) return 'unavailable';
    if (status === 413) return 'too-large';
    if (FATAL_AUTH_STATUSES.includes(status)) return 'fatal-auth';
    if (REJECTED_STATUSES.includes(status)) return 'rejected';
    if (TRANSIENT_STATUSES.includes(status) || status >= 500) return 'transient';
  }

  return 'transient';
}

module.exports = {
  classify,
  retryAfterMs,
  retryAfterHeaderMs,
  shortErrorMessage,
  errorCode,
};

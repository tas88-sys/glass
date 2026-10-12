/**
 * groqErrors.test.js
 *
 * Error classification for the Groq provider, over the real groq-sdk error
 * classes and both body shapes (data-model "Error kind"): HTTP errors keep the
 * whole body ({ error: { message, type, code } }), stream errors keep the
 * inner object.
 * Run: node --test src/features/common/ai/providers/__tests__/groqErrors.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { APIError, APIConnectionError, APIConnectionTimeoutError } = require('groq-sdk');

const {
  classify,
  retryAfterMs,
  retryAfterHeaderMs,
  shortErrorMessage,
  tooLargeNumbers,
  errorCode,
} = require('../groqErrors');

const TOO_LARGE = 'Request too large for model `openai/gpt-oss-20b` in organization `org_x` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 9400, please reduce your message size and try again.';

/** An HTTP error as the SDK raises it before the stream opens. */
function httpError(status, { message = 'server said no', type = 'invalid_request_error', code, headers = {} } = {}) {
  const error = { message, type };
  if (code) error.code = code;
  return APIError.generate(status, { error }, undefined, new Headers({ 'x-request-id': 'req_1', ...headers }));
}

/** A mid-stream {"error": …} as the SDK raises it: no status, the inner object as err.error. */
function streamError(type, { message = 'Service unavailable', code } = {}) {
  const error = { message, type };
  if (code) error.code = code;
  return new APIError(undefined, error, undefined, new Headers());
}

const own = (code, message = 'x') => Object.assign(new Error(message), { code });

describe('classify', () => {
  it('reads the provider codes first', () => {
    for (const code of ['FIRST_TEXT_TIMEOUT', 'IDLE_TIMEOUT', 'EMPTY_MAX_TOKENS', 'STREAM_ERROR']) {
      assert.equal(classify(own(code)), 'transient', code);
    }
  });

  it('HTTP 413 is too-large (TPM message or plain)', () => {
    assert.equal(classify(httpError(413, { message: TOO_LARGE, type: 'tokens', code: 'rate_limit_exceeded' })), 'too-large');
    assert.equal(classify(httpError(413, { message: 'Request Entity Too Large' })), 'too-large');
  });

  it('HTTP 404 and code model_not_found are unavailable', () => {
    assert.equal(classify(httpError(404)), 'unavailable');
    assert.equal(classify(httpError(404, { code: 'model_not_found' })), 'unavailable');
  });

  it('a model_ code wins over the status', () => {
    assert.equal(classify(httpError(400, { code: 'model_decommissioned' })), 'unavailable');
    assert.equal(classify(httpError(403, { type: 'permissions_error', code: 'model_permission_blocked_project' })), 'unavailable');
    assert.equal(classify(streamError('invalid_request_error', { code: 'model_decommissioned' })), 'unavailable');
  });

  for (const status of [408, 409, 422, 429, 498, 500, 502, 503, 504]) {
    it(`HTTP ${status} is transient`, () => assert.equal(classify(httpError(status, { type: 'server_error' })), 'transient'));
  }

  it('a 429 with code rate_limit_exceeded is transient', () => {
    assert.equal(classify(httpError(429, { type: 'tokens', code: 'rate_limit_exceeded' })), 'transient');
  });

  for (const status of [400, 424]) {
    it(`HTTP ${status} is fatal-request`, () => assert.equal(classify(httpError(status)), 'fatal-request'));
  }

  for (const status of [401, 403]) {
    it(`HTTP ${status} is fatal-auth`, () => {
      assert.equal(classify(httpError(status, { type: 'invalid_api_key', code: 'invalid_api_key' })), 'fatal-auth');
    });
  }

  for (const type of ['rate_limit_exceeded', 'server_error', 'service_unavailable', 'overloaded', 'internal_error']) {
    it(`stream error ${type} is transient`, () => assert.equal(classify(streamError(type)), 'transient'));
  }

  it('stream error invalid_request_error is fatal-request', () => {
    assert.equal(classify(streamError('invalid_request_error')), 'fatal-request');
  });

  it('connection errors are transient', () => {
    assert.equal(classify(new APIConnectionError({ message: 'Connection error.' })), 'transient');
    assert.equal(classify(new APIConnectionTimeoutError()), 'transient');
  });

  it('unknown errors are transient (fail-open)', () => {
    assert.equal(classify(new Error('something odd')), 'transient');
    assert.equal(classify(httpError(402, { type: 'billing' })), 'transient');
    assert.equal(classify(null), 'transient');
    assert.equal(classify(undefined), 'transient');
    assert.equal(classify('boom'), 'transient');
  });
});

describe('errorCode', () => {
  it('reads the code from either body shape', () => {
    assert.equal(errorCode(httpError(429, { code: 'rate_limit_exceeded' })), 'rate_limit_exceeded');
    assert.equal(errorCode(streamError('server_error', { code: 'internal' })), 'internal');
  });

  it('is null when there is none', () => {
    assert.equal(errorCode(httpError(500)), null);
    assert.equal(errorCode(new APIConnectionError({})), null);
    assert.equal(errorCode(own('FIRST_TEXT_TIMEOUT')), null);
    assert.equal(errorCode(undefined), null);
  });

  it('ignores a body whose error is a string', () => {
    const err = APIError.generate(500, { error: 'boom' }, undefined, new Headers());
    assert.equal(errorCode(err), null);
    assert.equal(classify(err), 'transient');
  });
});

describe('retryAfterMs', () => {
  it('prefers retry-after-ms', () => {
    assert.equal(retryAfterMs(httpError(429, { headers: { 'retry-after-ms': '7500', 'retry-after': '40' } })), 7_500);
  });

  it('reads retry-after in seconds', () => {
    assert.equal(retryAfterMs(httpError(429, { headers: { 'retry-after': '30' } })), 30_000);
  });

  it('reads retry-after as an HTTP date', () => {
    const at = new Date(Date.now() + 30_000).toUTCString();
    const ms = retryAfterMs(httpError(429, { headers: { 'retry-after': at } }));
    assert.ok(ms >= 25_000 && ms <= 30_000, `got ${ms}`);
  });

  it('reads plain-object headers', () => {
    assert.equal(retryAfterMs({ status: 429, headers: { 'retry-after': '20' } }), 20_000);
  });

  it('defaults to 60 s', () => {
    assert.equal(retryAfterMs(httpError(503)), 60_000);
    assert.equal(retryAfterMs(streamError('server_error')), 60_000);
    assert.equal(retryAfterMs(null), 60_000);
  });

  it('clamps to [5 s, 5 min]', () => {
    assert.equal(retryAfterMs(httpError(429, { headers: { 'retry-after': '1' } })), 5_000);
    assert.equal(retryAfterMs(httpError(429, { headers: { 'retry-after': '999' } })), 300_000);
  });
});

describe('retryAfterHeaderMs', () => {
  it('returns the server value unclamped', () => {
    assert.equal(retryAfterHeaderMs(httpError(429, { headers: { 'retry-after': '1' } })), 1_000);
    assert.equal(retryAfterHeaderMs(httpError(429, { headers: { 'retry-after-ms': '1500' } })), 1_500);
    assert.equal(retryAfterHeaderMs(httpError(429, { headers: { 'retry-after': '999' } })), 999_000);
  });

  it('returns null when absent or unreadable', () => {
    assert.equal(retryAfterHeaderMs(httpError(429)), null);
    assert.equal(retryAfterHeaderMs(httpError(429, { headers: { 'retry-after': 'soon' } })), null);
    assert.equal(retryAfterHeaderMs(undefined), null);
  });
});

describe('shortErrorMessage', () => {
  it('uses the message of an HTTP body', () => {
    const err = httpError(503, { message: 'Service Unavailable', type: 'internal_server_error' });
    assert.match(err.message, /^503 \{/, 'the SDK prefixes the status and the JSON body');
    assert.equal(shortErrorMessage(err), 'Service Unavailable');
  });

  it('uses the message of a stream error', () => {
    assert.equal(shortErrorMessage(streamError('server_error', { message: 'Overloaded' })), 'Overloaded');
  });

  it('strips an envelope from a message when the body is gone', () => {
    assert.equal(shortErrorMessage({ message: '429 {"error":{"message":"Rate limit reached"}}' }), 'Rate limit reached');
    assert.equal(shortErrorMessage({ message: '500 {not json' }), '500 {not json');
  });

  it('keeps a message that is not an envelope', () => {
    assert.equal(shortErrorMessage(new APIConnectionError({ message: 'Connection error.' })), 'Connection error.');
    assert.equal(shortErrorMessage(own('FIRST_TEXT_TIMEOUT', 'no text after 15s')), 'no text after 15s');
  });

  it('caps at 160 characters', () => {
    assert.equal(shortErrorMessage(httpError(500, { message: 'x'.repeat(500) })).length, 160);
  });

  it('handles non-errors', () => {
    assert.equal(shortErrorMessage('plain'), 'plain');
    assert.equal(shortErrorMessage(undefined), 'undefined');
  });
});

describe('tooLargeNumbers', () => {
  it('reads Limit and Requested from a 413', () => {
    assert.deepEqual(tooLargeNumbers(httpError(413, { message: TOO_LARGE, type: 'tokens', code: 'rate_limit_exceeded' })), { limit: 8000, requested: 9400 });
  });

  it('reads them from a bare message', () => {
    assert.deepEqual(tooLargeNumbers({ message: '413 … (TPM): Limit 6000, Requested 6294, please …' }), { limit: 6000, requested: 6294 });
  });

  it('is null without them', () => {
    assert.equal(tooLargeNumbers(httpError(413, { message: 'Request Entity Too Large' })), null);
    assert.equal(tooLargeNumbers(null), null);
  });
});

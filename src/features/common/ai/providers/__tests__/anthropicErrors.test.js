/**
 * anthropicErrors.test.js
 *
 * Error classification for the Anthropic provider, over the real SDK error
 * classes (data-model "Error kind").
 * Run: node --test src/features/common/ai/providers/__tests__/anthropicErrors.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { APIError, APIConnectionError, APIConnectionTimeoutError } = require('@anthropic-ai/sdk');

const { classify, retryAfterMs, retryAfterHeaderMs, shortErrorMessage } = require('../anthropicErrors');

const TYPE_BY_STATUS = {
  400: 'invalid_request_error', 401: 'authentication_error', 402: 'billing_error', 403: 'permission_error',
  404: 'not_found_error', 408: 'timeout_error', 409: 'conflict_error', 413: 'request_too_large',
  422: 'invalid_request_error', 429: 'rate_limit_error', 500: 'api_error', 502: 'api_error',
  503: 'api_error', 504: 'timeout_error', 529: 'overloaded_error',
};

/** An HTTP error as the SDK raises it before the stream opens. */
function httpError(status, { message = 'server said no', headers = {} } = {}) {
  const body = { type: 'error', error: { type: TYPE_BY_STATUS[status] || 'api_error', message } };
  return APIError.generate(status, body, undefined, new Headers({ 'request-id': 'req_1', ...headers }));
}

/** A stream `error` event as the SDK raises it mid-stream: no status, type from the body. */
function streamError(type, message = 'Overloaded') {
  return new APIError(undefined, { type: 'error', error: { type, message } }, undefined, new Headers(), type);
}

const own = (code, message = 'x') => Object.assign(new Error(message), { code });

describe('classify', () => {
  it('reads the provider codes first', () => {
    assert.equal(classify(own('FIRST_TEXT_TIMEOUT')), 'transient');
    assert.equal(classify(own('IDLE_TIMEOUT')), 'transient');
    assert.equal(classify(own('EMPTY_MAX_TOKENS')), 'transient');
    assert.equal(classify(own('REFUSAL')), 'refusal');
  });

  for (const status of [408, 409, 429, 500, 502, 503, 504, 529]) {
    it(`HTTP ${status} is transient`, () => assert.equal(classify(httpError(status)), 'transient'));
  }

  it('HTTP 404 is unavailable', () => assert.equal(classify(httpError(404)), 'unavailable'));

  for (const status of [400, 413, 422]) {
    it(`HTTP ${status} is fatal-request`, () => assert.equal(classify(httpError(status)), 'fatal-request'));
  }

  for (const status of [401, 402, 403]) {
    it(`HTTP ${status} is fatal-auth`, () => assert.equal(classify(httpError(status)), 'fatal-auth'));
  }

  for (const type of ['overloaded_error', 'api_error', 'rate_limit_error', 'timeout_error']) {
    it(`stream error event ${type} is transient`, () => assert.equal(classify(streamError(type)), 'transient'));
  }

  it('stream error event invalid_request_error is fatal-request', () => {
    assert.equal(classify(streamError('invalid_request_error')), 'fatal-request');
  });

  it('reads the type from the body when err.type is missing', () => {
    const err = streamError('invalid_request_error');
    err.type = null;
    assert.equal(classify(err), 'fatal-request');
  });

  it('connection errors are transient', () => {
    assert.equal(classify(new APIConnectionError({ message: 'Connection error.' })), 'transient');
    assert.equal(classify(new APIConnectionTimeoutError()), 'transient');
  });

  it('unknown errors are transient (fail-open)', () => {
    assert.equal(classify(new Error('something odd')), 'transient');
    assert.equal(classify(null), 'transient');
    assert.equal(classify(undefined), 'transient');
    assert.equal(classify('boom'), 'transient');
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
    assert.equal(retryAfterMs(httpError(529)), 60_000);
    assert.equal(retryAfterMs(streamError('overloaded_error')), 60_000);
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
  it('uses the server message of a stream error event', () => {
    assert.equal(shortErrorMessage(streamError('overloaded_error', 'Overloaded')), 'Overloaded');
  });

  it('drops the status and JSON envelope of an HTTP error', () => {
    const err = httpError(529, { message: 'Overloaded' });
    assert.match(err.message, /^529 \{/);
    assert.equal(shortErrorMessage(err), 'Overloaded');
  });

  it('keeps a message that is not an envelope', () => {
    assert.equal(shortErrorMessage(new APIConnectionError({ message: 'Connection error.' })), 'Connection error.');
    assert.equal(shortErrorMessage(own('FIRST_TEXT_TIMEOUT', 'no text after 20s')), 'no text after 20s');
    assert.equal(shortErrorMessage({ message: '529 {not json' }), '529 {not json');
  });

  it('caps at 160 characters', () => {
    assert.equal(shortErrorMessage(streamError('api_error', 'x'.repeat(500))).length, 160);
  });

  it('handles non-errors', () => {
    assert.equal(shortErrorMessage('plain'), 'plain');
    assert.equal(shortErrorMessage(undefined), 'undefined');
  });
});

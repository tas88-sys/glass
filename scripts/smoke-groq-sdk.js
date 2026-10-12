'use strict';

// Loads groq-sdk and streams canned responses through a custom fetch, without
// network or key. npm test runs a newer Node than the app, so run this with
// the Node inside Electron (spec 2026-10-12-groq-provider, T005):
//
//   node -e "require('child_process').execFileSync(require('electron'),['scripts/smoke-groq-sdk.js'],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:'inherit'})"
//
// It checks what the provider relies on: a streamed answer with its headers, a
// 429 raised once with maxRetries 0, a 413 raised as a plain APIError, a
// mid-stream {"error"} raised with its type, an abort that ends the iteration
// without throwing, the iteration still open after [DONE] while the server
// keeps the connection, and models.list for key validation.

const assert = require('node:assert/strict');
const Groq = require('groq-sdk');
const { APIError, RateLimitError } = require('groq-sdk');
const { VERSION } = require('groq-sdk/version');

const enc = new TextEncoder();
const data = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const DONE = 'data: [DONE]\n\n';

const chunk = (delta, extra = {}) => ({
    id: 'chatcmpl-smoke', object: 'chat.completion.chunk', created: 1, model: 'openai/gpt-oss-20b',
    choices: [{ index: 0, delta, finish_reason: null }], ...extra,
});
const FIRST = data(chunk({ role: 'assistant', content: '' }, { x_groq: { id: 'req_smoke' } }));
const TEXT = data(chunk({ content: 'Hello' }));
const LAST = data({
    ...chunk({}),
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    x_groq: { id: 'req_smoke', usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14, queue_time: 0.01 } },
});
const ANSWER = [FIRST, TEXT, LAST, DONE];

function sseResponse(chunks, { hang = false, signal } = {}) {
    const body = new ReadableStream({
        start(controller) {
            for (const c of chunks) controller.enqueue(enc.encode(c));
            if (!hang) return controller.close();
            // Stays open until the request is aborted, as a server that keeps the connection would.
            signal.addEventListener('abort', () => controller.error(new DOMException('This operation was aborted', 'AbortError')), { once: true });
        },
    });
    return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_smoke', 'x-ratelimit-remaining-tokens': '7986' },
    });
}

const jsonResponse = (status, body, headers = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function client(respond) {
    const calls = [];
    const fetch = async (url, init) => {
        calls.push({ url: String(url), method: init.method, headers: new Headers(init.headers), body: init.body ? JSON.parse(init.body) : null });
        return respond(init);
    };
    return { calls, groq: new Groq({ apiKey: 'gsk_smoke', fetch }) };
}

const opts = (signal = new AbortController().signal) => ({ maxRetries: 0, timeout: 15000, signal });
const params = { model: 'openai/gpt-oss-20b', messages: [{ role: 'user', content: 'hi' }], stream: true, max_completion_tokens: 1924 };

async function streamsAnAnswer() {
    const { calls, groq } = client(() => sseResponse(ANSWER));
    const { data: stream, response } = await groq.chat.completions.create(params, opts()).withResponse();
    let text = '';
    let finish = null;
    let usage = null;
    let firstId = null;
    for await (const c of stream) {
        if (firstId == null) firstId = c.x_groq?.id ?? null;
        text += c.choices[0]?.delta?.content || '';
        if (c.choices[0]?.finish_reason) finish = c.choices[0].finish_reason;
        if (c.x_groq?.usage) usage = c.x_groq.usage;
    }
    assert.equal(text, 'Hello');
    assert.equal(finish, 'stop');
    assert.equal(usage.prompt_tokens, 12);
    assert.equal(firstId, 'req_smoke');
    assert.equal(response.headers.get('x-request-id'), 'req_smoke');
    assert.equal(response.headers.get('x-ratelimit-remaining-tokens'), '7986');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST');
    assert.match(calls[0].url, /\/openai\/v1\/chat\/completions$/);
    assert.equal(calls[0].headers.get('authorization'), 'Bearer gsk_smoke');
    assert.equal(calls[0].body.stream, true);
    assert.equal(calls[0].body.max_completion_tokens, 1924);
}

async function raises429Once() {
    const { calls, groq } = client(() => jsonResponse(429,
        { error: { message: 'Rate limit reached for model `openai/gpt-oss-20b` on tokens per minute (TPM)', type: 'tokens', code: 'rate_limit_exceeded' } },
        { 'retry-after': '3' }));
    const err = await groq.chat.completions.create(params, opts()).then(() => null, (e) => e);
    assert.ok(err instanceof RateLimitError, `expected RateLimitError, got ${err && err.constructor.name}`);
    assert.equal(err.status, 429);
    assert.equal(err.error.error.code, 'rate_limit_exceeded', 'HTTP errors keep the whole body');
    assert.equal(err.headers.get('retry-after'), '3');
    assert.equal(calls.length, 1, 'maxRetries 0 must not retry');
}

async function raises413AsPlainAPIError() {
    const { groq } = client(() => jsonResponse(413, {
        error: { message: 'Request too large for model `openai/gpt-oss-20b` on tokens per minute (TPM): Limit 8000, Requested 9400', type: 'tokens', code: 'rate_limit_exceeded' },
    }));
    const err = await groq.chat.completions.create(params, opts()).then(() => null, (e) => e);
    assert.ok(err instanceof APIError, `expected APIError, got ${err && err.constructor.name}`);
    assert.equal(err.constructor, APIError, '413 has no subclass');
    assert.equal(err.status, 413);
    assert.match(err.error.error.message, /Limit 8000, Requested 9400/);
}

async function raisesStreamError() {
    const { groq } = client(() => sseResponse([FIRST, TEXT, data({ error: { message: 'Service unavailable', type: 'server_error' } })]));
    const stream = await groq.chat.completions.create(params, opts());
    let text = '';
    const err = await (async () => {
        for await (const c of stream) text += c.choices[0]?.delta?.content || '';
    })().then(() => null, (e) => e);
    assert.equal(text, 'Hello');
    assert.ok(err instanceof APIError, `expected APIError, got ${err && err.constructor.name}`);
    assert.equal(err.status, undefined);
    assert.equal(err.error.type, 'server_error', 'stream errors keep the inner object');
    assert.equal(err.error.message, 'Service unavailable');
}

async function abortEndsQuietly() {
    const ac = new AbortController();
    const { groq } = client((init) => sseResponse([FIRST, TEXT], { hang: true, signal: init.signal }));
    const stream = await groq.chat.completions.create(params, opts(ac.signal));
    let text = '';
    for await (const c of stream) {
        text += c.choices[0]?.delta?.content || '';
        if (text) ac.abort();
    }
    assert.equal(text, 'Hello', 'the loop ends without throwing after the abort');
}

async function keepsReadingAfterDone() {
    // research R4: the SDK skips everything after [DONE] but returns only when
    // the connection closes, so the provider stops at finish_reason itself.
    const ac = new AbortController();
    const { groq } = client((init) => sseResponse(ANSWER, { hang: true, signal: init.signal }));
    const stream = await groq.chat.completions.create(params, opts(ac.signal));
    let ended = false;
    const loop = (async () => { for await (const _ of stream); ended = true; })(); // eslint-disable-line no-unused-vars
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(ended, false, 'still iterating 300 ms after [DONE]');
    ac.abort();
    await loop;
    assert.equal(ended, true, 'ends once the connection is aborted');
}

async function listsModels() {
    const { calls, groq } = client(() => jsonResponse(200, {
        object: 'list', data: [{ id: 'openai/gpt-oss-120b', object: 'model', created: 1, owned_by: 'OpenAI', active: true, context_window: 131072 }],
    }));
    const page = await groq.models.list(opts());
    assert.equal(page.data[0].id, 'openai/gpt-oss-120b');
    assert.equal(calls[0].method, 'GET');
    assert.match(calls[0].url, /\/openai\/v1\/models$/);
}

(async () => {
    const checks = { streamsAnAnswer, raises429Once, raises413AsPlainAPIError, raisesStreamError, abortEndsQuietly, keepsReadingAfterDone, listsModels };
    let failed = 0;
    for (const [name, fn] of Object.entries(checks)) {
        try {
            await fn();
            console.log(`ok   ${name}`);
        } catch (err) {
            failed++;
            console.log(`FAIL ${name}: ${err && err.message}`);
        }
    }
    const electron = process.versions.electron ? ` (electron ${process.versions.electron})` : '';
    console.log(`node ${process.version}${electron}, groq-sdk ${VERSION}: ${failed ? `${failed} failed` : 'all checks passed'}`);
    process.exit(failed ? 1 : 0);
})();

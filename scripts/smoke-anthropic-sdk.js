'use strict';

// Loads @anthropic-ai/sdk and streams canned responses through a custom fetch,
// without network or key. npm test runs a newer Node than the app, so run this
// with the Node inside Electron (spec 2026-10-11-anthropic-provider-resilience,
// T005):
//
//   node -e "require('child_process').execFileSync(require('electron'),['scripts/smoke-anthropic-sdk.js'],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:'inherit'})"
//
// It checks what the provider relies on: a streamed answer, a 529 raised once
// with maxRetries 0, a stream `error` event raised with its type, an abort that
// ends the iteration without throwing, the beta header for server-side
// fallbacks, and models.list for key validation.

const assert = require('node:assert/strict');
const { Anthropic, APIError, InternalServerError } = require('@anthropic-ai/sdk');
const { VERSION } = require('@anthropic-ai/sdk/version');

const enc = new TextEncoder();
const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const MESSAGE_START = sse('message_start', {
    type: 'message_start',
    message: {
        id: 'msg_smoke', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [],
        stop_reason: null, usage: { input_tokens: 12, output_tokens: 1 },
    },
});
const BLOCK_START = sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
const DELTA = sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } });
const ANSWER = [
    MESSAGE_START,
    sse('ping', { type: 'ping' }),
    BLOCK_START,
    DELTA,
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
    sse('message_stop', { type: 'message_stop' }),
];
const OVERLOADED = { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } };

function sseResponse(chunks, { hang = false, signal } = {}) {
    const body = new ReadableStream({
        start(controller) {
            for (const c of chunks) controller.enqueue(enc.encode(c));
            if (!hang) return controller.close();
            // Stays open until the request is aborted, as a stalled server would.
            signal.addEventListener('abort', () => controller.error(new DOMException('This operation was aborted', 'AbortError')), { once: true });
        },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_smoke' } });
}

function client(respond) {
    const calls = [];
    const fetch = async (url, init) => {
        calls.push({ url: String(url), method: init.method, headers: new Headers(init.headers), body: init.body ? JSON.parse(init.body) : null });
        return respond(init);
    };
    return { calls, anthropic: new Anthropic({ apiKey: 'sk-ant-smoke', fetch }) };
}

const opts = () => ({ maxRetries: 0, timeout: 15000, signal: new AbortController().signal });
const params = { model: 'claude-haiku-5-5', max_tokens: 4096, messages: [{ role: 'user', content: 'hi' }], stream: true };

async function streamsAnAnswer() {
    const { calls, anthropic } = client(() => sseResponse(ANSWER));
    const stream = await anthropic.messages.create(params, opts());
    const types = [];
    let text = '';
    let stop = null;
    for await (const ev of stream) {
        types.push(ev.type);
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') text += ev.delta.text;
        if (ev.type === 'message_delta') stop = ev.delta.stop_reason;
    }
    assert.equal(text, 'Hello');
    assert.equal(stop, 'end_turn');
    assert.deepEqual(types, ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST');
    assert.match(calls[0].url, /\/v1\/messages$/);
    assert.equal(calls[0].headers.get('x-api-key'), 'sk-ant-smoke');
    assert.equal(calls[0].body.stream, true);
}

async function raises529Once() {
    const { calls, anthropic } = client(() => new Response(JSON.stringify(OVERLOADED), {
        status: 529, headers: { 'content-type': 'application/json', 'request-id': 'req_529' },
    }));
    const err = await anthropic.messages.create(params, opts()).then(() => null, (e) => e);
    assert.ok(err instanceof InternalServerError, `expected InternalServerError, got ${err && err.constructor.name}`);
    assert.equal(err.status, 529);
    assert.equal(err.type, 'overloaded_error');
    assert.equal(err.requestID, 'req_529');
    assert.equal(calls.length, 1, 'maxRetries 0 must not retry');
}

async function raisesStreamErrorEvent() {
    const { anthropic } = client(() => sseResponse([MESSAGE_START, BLOCK_START, DELTA, sse('error', OVERLOADED)]));
    const stream = await anthropic.messages.create(params, opts());
    let text = '';
    const err = await (async () => {
        for await (const ev of stream) if (ev.type === 'content_block_delta') text += ev.delta.text;
    })().then(() => null, (e) => e);
    assert.equal(text, 'Hello');
    assert.ok(err instanceof APIError, `expected APIError, got ${err && err.constructor.name}`);
    assert.equal(err.status, undefined);
    assert.equal(err.type, 'overloaded_error');
    assert.equal(err.error.error.message, 'Overloaded');
}

async function abortEndsQuietly() {
    const ac = new AbortController();
    const { anthropic } = client((init) => sseResponse([MESSAGE_START, BLOCK_START, DELTA], { hang: true, signal: init.signal }));
    const stream = await anthropic.messages.create(params, { maxRetries: 0, timeout: 15000, signal: ac.signal });
    let text = '';
    for await (const ev of stream) {
        if (ev.type === 'content_block_delta') {
            text += ev.delta.text;
            ac.abort();
        }
    }
    assert.equal(text, 'Hello', 'the loop ends without throwing after the abort');
}

async function sendsFallbackBeta() {
    const { calls, anthropic } = client(() => sseResponse(ANSWER));
    const stream = await anthropic.beta.messages.create(
        { ...params, model: 'claude-sonnet-5-5', betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' },
        opts(),
    );
    for await (const _ of stream); // eslint-disable-line no-unused-vars
    assert.match(calls[0].headers.get('anthropic-beta') || '', /server-side-fallback-2026-07-01/);
    assert.equal(calls[0].body.fallbacks, 'default');
    assert.equal('betas' in calls[0].body, false);
}

async function listsModels() {
    const { calls, anthropic } = client(() => new Response(JSON.stringify({
        data: [{ type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-01-01T00:00:00Z' }],
        has_more: true, first_id: 'claude-opus-5-5', last_id: 'claude-opus-5-5',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const page = await anthropic.models.list({ limit: 1 }, opts());
    assert.equal(page.data[0].id, 'claude-opus-5-5');
    assert.equal(calls[0].method, 'GET');
    assert.match(calls[0].url, /\/v1\/models\?limit=1$/);
}

(async () => {
    const checks = { streamsAnAnswer, raises529Once, raisesStreamErrorEvent, abortEndsQuietly, sendsFallbackBeta, listsModels };
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
    console.log(`node ${process.version}${electron}, @anthropic-ai/sdk ${VERSION}: ${failed ? `${failed} failed` : 'all checks passed'}`);
    process.exit(failed ? 1 : 0);
})();

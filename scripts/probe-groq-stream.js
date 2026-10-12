'use strict';

// One-off live probe for the Groq provider (spec 2026-10-12-groq-provider, T006).
// Streams one tiny request per model through groq-sdk and prints only the
// shape of what comes back: chunk keys, delta keys, x_groq keys,
// finish_reason, where usage arrives, timings and the rate-limit headers.
// It never prints answer or reasoning text. A few error probes print the
// status, type and code Groq returns for a missing model, a retired model and
// an image sent to a text-only model.
//
// Needs GROQ_API_KEY in the environment or in .env at the repo root. Each run
// costs a fraction of a cent.
//
//   node scripts/probe-groq-stream.js

require('dotenv').config({ quiet: true });
const { Groq } = require('groq-sdk');

const key = process.env.GROQ_API_KEY;
if (!key) {
    console.error('GROQ_API_KEY is not set (add it to .env at the repo root)');
    process.exit(2);
}

const groq = new Groq({ apiKey: key, maxRetries: 0 });
const QUESTION = [{ role: 'user', content: 'Reply with the single word: ok' }];
const options = (signal) => ({ maxRetries: 0, timeout: 15000, signal });

function pickHeaders(headers) {
    const out = {};
    for (const [k, v] of headers) {
        if (k === 'x-request-id' || k === 'retry-after' || k.startsWith('x-ratelimit')) out[k] = v;
    }
    return out;
}

async function probeStream(params) {
    const ac = new AbortController();
    const t0 = Date.now();
    const { data: stream, response } = await groq.chat.completions
        .create({ messages: QUESTION, stream: true, max_completion_tokens: 64, ...params }, options(ac.signal))
        .withResponse();
    console.log(`\n== stream ${params.model} (${JSON.stringify({ ...params, model: undefined })}) headers after ${Date.now() - t0}ms`);
    console.log('headers', JSON.stringify(pickHeaders(response.headers)));

    let n = 0;
    let firstContentAt = null;
    let finishAt = null;
    let reasoningChunks = 0;
    let keptOpen = false;
    let watchdog = null;
    try {
        for await (const chunk of stream) {
            const t = Date.now() - t0;
            const choice = chunk.choices?.[0] || {};
            const delta = choice.delta || {};
            if (delta.reasoning) reasoningChunks++;
            if (delta.content && firstContentAt == null) firstContentAt = t;
            const usage = chunk.x_groq?.usage ? 'x_groq' : chunk.usage ? 'top' : '-';
            console.log(`#${n++} t=${t}ms keys=[${Object.keys(chunk)}] choices=${(chunk.choices || []).length} delta=[${Object.keys(delta)}] x_groq=[${Object.keys(chunk.x_groq || {})}] finish=${choice.finish_reason ?? '-'} usage=${usage}`);
            if (choice.finish_reason && finishAt == null) {
                finishAt = t;
                // The SDK returns only when the connection closes (research R4).
                watchdog = setTimeout(() => { keptOpen = true; ac.abort(); }, 2000);
            }
        }
    } catch (err) {
        console.log('stream error', err?.constructor?.name, err?.status ?? '');
    } finally {
        clearTimeout(watchdog);
    }
    console.log(`summary first_content=${firstContentAt}ms finish=${finishAt}ms end=${Date.now() - t0}ms kept_open_2s_after_finish=${keptOpen} reasoning_chunks=${reasoningChunks}`);
}

async function probeError(label, params) {
    try {
        await groq.chat.completions.create({ messages: QUESTION, max_completion_tokens: 8, ...params }, options());
        console.log(`\n== ${label}: unexpected 200`);
    } catch (err) {
        const body = err?.error?.error ?? err?.error;
        console.log(`\n== ${label} model=${params.model} status=${err?.status} type=${body?.type} code=${body?.code} message=${JSON.stringify(String(body?.message || '').slice(0, 160))}`);
    }
}

(async () => {
    await probeStream({ model: 'openai/gpt-oss-20b', reasoning_effort: 'low', include_reasoning: false, temperature: 0.7 });
    await probeStream({ model: 'openai/gpt-oss-120b', reasoning_effort: 'low', include_reasoning: false, temperature: 0.7 });
    await probeStream({ model: 'qwen/qwen3.8-27b', reasoning_effort: 'none', temperature: 0.7 });
    await probeError('unknown model', { model: 'acme/nonexistent-1' });
    await probeError('retired model', { model: 'llama-3.3-70b-versatile' });
    await probeError('image to a text-only model', {
        model: 'openai/gpt-oss-20b',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'what is this?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }] }],
    });
})().catch((err) => {
    console.error('probe failed:', err?.constructor?.name, err?.status ?? '', String(err?.message || err).slice(0, 160));
    process.exit(1);
});

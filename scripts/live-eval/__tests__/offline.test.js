/**
 * offline.test.js — --block-providers: the network guard, the LLM list
 * filter and the stub LLM.
 *
 * Run: node --test scripts/live-eval/__tests__
 */

'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');

const offline = require('../offline');
const { splitByProvider } = require('../../../src/features/common/ai/factory');

describe('parseBlocked', () => {
    it('reads a csv, lowercases, deduplicates', () => {
        assert.deepEqual(offline.parseBlocked(' Groq,gemini , deepgram,groq '), ['groq', 'gemini', 'deepgram']);
        assert.deepEqual(offline.parseBlocked(''), []);
        assert.deepEqual(offline.parseBlocked(undefined), []);
    });
    it('rejects an unknown provider', () => {
        assert.throws(() => offline.parseBlocked('groq,gemni'), /unknown provider "gemni"/);
    });
});

describe('blockedProviderOf', () => {
    const blocked = ['groq', 'gemini', 'deepgram'];
    it('matches each provider\'s API host and its subdomains, with or without a port', () => {
        assert.equal(offline.blockedProviderOf('api.groq.com', blocked), 'groq');
        assert.equal(offline.blockedProviderOf('generativelanguage.googleapis.com:443', blocked), 'gemini');
        assert.equal(offline.blockedProviderOf('API.DEEPGRAM.COM', blocked), 'deepgram');
        assert.equal(offline.blockedProviderOf('eu.api.deepgram.com', blocked), 'deepgram');
    });
    it('lets the others through', () => {
        for (const h of ['api.typesafe.ai', 'huggingface.co', 'api.anthropic.com', 'evilapi.groq.com.example', '127.0.0.1']) {
            assert.equal(offline.blockedProviderOf(h, blocked), null, h);
        }
    });
});

describe('installNetGuard', () => {
    const server = http.createServer((req, res) => res.end('ok'));
    const ready = new Promise(r => server.listen(0, '127.0.0.1', r));
    after(() => server.close());

    it('fetch to a blocked host rejects without a request; other hosts pass', async () => {
        await ready;
        const guard = offline.installNetGuard(['groq', 'gemini']);
        try {
            await assert.rejects(fetch('https://api.groq.com/openai/v1/models'), err => err.code === 'EBLOCKED' && /groq/.test(err.message));
            await assert.rejects(fetch(new URL('https://generativelanguage.googleapis.com/v1beta/models')), err => err.code === 'EBLOCKED');
            await assert.rejects(fetch(new Request('https://api.groq.com/x')), err => err.code === 'EBLOCKED');
            const res = await fetch(`http://127.0.0.1:${server.address().port}/`);
            assert.equal(await res.text(), 'ok');
            assert.deepEqual(guard.attempts, { groq: 2, gemini: 1 });
        } finally {
            guard.uninstall();
        }
    });

    it('http/https request and get to a blocked host throw (SDKs and WebSockets use them)', async () => {
        await ready;
        const guard = offline.installNetGuard(['deepgram']);
        try {
            assert.throws(() => https.request('https://api.deepgram.com/v1/listen'), err => err.code === 'EBLOCKED');
            assert.throws(() => https.request({ hostname: 'api.deepgram.com', path: '/v1/listen' }), err => err.code === 'EBLOCKED');
            assert.throws(() => https.get({ host: 'api.deepgram.com' }), err => err.code === 'EBLOCKED');
            const body = await new Promise((resolve, reject) => {
                http.get({ hostname: '127.0.0.1', port: server.address().port, path: '/' }, res => {
                    let s = '';
                    res.on('data', d => { s += d; });
                    res.on('end', () => resolve(s));
                }).on('error', reject);
            });
            assert.equal(body, 'ok');
            assert.equal(guard.attempts.deepgram, 3);
        } finally {
            guard.uninstall();
        }
    });

    it('uninstall restores the originals; an empty list patches nothing', () => {
        const before = [globalThis.fetch, http.request, https.get];
        offline.installNetGuard(['groq']).uninstall();
        assert.deepEqual([globalThis.fetch, http.request, https.get], before);
        offline.installNetGuard([]);
        assert.deepEqual([globalThis.fetch, http.request, https.get], before);
    });
});

describe('filterLlmList', () => {
    it('drops the blocked providers\' models from a mixed chain', () => {
        const out = offline.filterLlmList('openai/gpt-oss-120b,gemini-3.5-flash-lite,claude-haiku-5-5', 'groq', ['groq', 'gemini'], splitByProvider);
        assert.equal(out.provider, 'anthropic');
        assert.equal(out.model, 'claude-haiku-5-5');
        assert.deepEqual(out.dropped, ['openai/gpt-oss-120b', 'gemini-3.5-flash-lite']);
    });
    it('null when every model is blocked, or there is no list', () => {
        assert.equal(offline.filterLlmList('openai/gpt-oss-120b,qwen/qwen3.8-27b,gemini-3.5-flash-lite', 'groq', ['groq', 'gemini'], splitByProvider), null);
        assert.equal(offline.filterLlmList(null, 'groq', ['groq'], splitByProvider), null);
    });
    it('nothing blocked → the list unchanged', () => {
        const out = offline.filterLlmList('openai/gpt-oss-120b,gemini-3.5-flash-lite', 'groq', [], splitByProvider);
        assert.equal(out.model, 'openai/gpt-oss-120b,gemini-3.5-flash-lite');
        assert.equal(out.provider, 'groq');
    });
});

describe('stub LLMs', () => {
    it('the streaming stub speaks the SSE the answer lane parses', async () => {
        const { parseLiveAnswerSseLine } = require('../../../src/features/listen/summary/summaryService');
        const res = await offline.createStubStreamingLLM().streamChat([]);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let raw = '';
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            raw += decoder.decode(value, { stream: true });
        }
        let text = '';
        for (const line of raw.split('\n')) {
            const p = parseLiveAnswerSseLine(line);
            if (p && typeof p.delta === 'string') text += p.delta;
        }
        assert.equal(text, offline.STUB_ANSWER);
        assert.ok(raw.includes('"_final_model":"offline-stub"'));
        assert.ok(raw.trimEnd().endsWith('data: [DONE]'));
    });
    it('the Insights stub returns content', async () => {
        const r = await offline.createStubLLM().chat([]);
        assert.match(r.content, /Summary Overview/);
    });
});

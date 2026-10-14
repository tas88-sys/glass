'use strict';

// --block-providers groq,gemini,deepgram: run the live eval without spending
// those services' quota. Three parts:
//   - a network guard: any request to a blocked provider's API host fails
//     at once, before a byte leaves the machine (fetch, http and https, so
//     SDKs and WebSockets are covered), and is counted;
//   - the LLM list minus the blocked providers' models;
//   - when no model is left, a local stub LLM that streams a fixed answer, so
//     the gate, the career router (Jev), retrieval, the prompt and the answer
//     lane still run end to end. Checks on what the answer says are then not
//     judged.

const http = require('node:http');
const https = require('node:https');

const PROVIDER_HOSTS = {
    groq: ['api.groq.com'],
    gemini: ['generativelanguage.googleapis.com'],
    deepgram: ['api.deepgram.com'],
    anthropic: ['api.anthropic.com'],
    openai: ['api.openai.com'],
    typesafe: ['api.typesafe.ai'],
};
const STUB_PROVIDER = 'offline-stub';
const STUB_MODEL = 'offline-stub';
const STUB_ANSWER = 'Offline stub answer: no LLM was called.\n- The gate, the route and the notes ran for real.\n';
const STUB_INSIGHTS = '**Summary Overview**\n- Offline stub: no LLM was called.\n\n**Key Topic: offline**\n- stub\n';

/** The provider list from a flag or env value; throws on an unknown name. */
function parseBlocked(csv) {
    const list = String(csv || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    for (const p of list) {
        if (!PROVIDER_HOSTS[p]) throw new Error(`--block-providers: unknown provider "${p}" (known: ${Object.keys(PROVIDER_HOSTS).join(', ')})`);
    }
    return [...new Set(list)];
}

function blockedProviderOf(host, blocked) {
    const h = String(host || '').toLowerCase().replace(/:\d+$/, '');
    for (const p of blocked) {
        if (PROVIDER_HOSTS[p].some(x => h === x || h.endsWith(`.${x}`))) return p;
    }
    return null;
}

function hostOfRequestArgs(args) {
    const [a, b] = args;
    if (typeof a === 'string' || a instanceof URL) {
        try {
            return new URL(String(a)).hostname;
        } catch {
            return '';
        }
    }
    const o = a && typeof a === 'object' ? a : b && typeof b === 'object' ? b : {};
    return o.hostname || o.host || '';
}

/**
 * Patches fetch, http and https so a request to a blocked host throws.
 * @param {string[]} blocked
 * @returns {{ attempts: Record<string, number>, uninstall: () => void }}
 */
function installNetGuard(blocked) {
    const attempts = Object.fromEntries(blocked.map(p => [p, 0]));
    if (!blocked.length) return { attempts, uninstall: () => {} };
    const refuse = provider => {
        attempts[provider]++;
        const err = new Error(`blocked by --block-providers (${provider})`);
        err.code = 'EBLOCKED';
        return err;
    };

    const origFetch = globalThis.fetch;
    if (typeof origFetch === 'function') {
        globalThis.fetch = function guardedFetch(input, init) {
            let host = '';
            try {
                host = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url).hostname;
            } catch {
                host = '';
            }
            const p = blockedProviderOf(host, blocked);
            if (p) return Promise.reject(refuse(p));
            return origFetch.call(this, input, init);
        };
    }
    const patched = [];
    for (const mod of [http, https]) {
        for (const fn of ['request', 'get']) {
            const orig = mod[fn];
            mod[fn] = function guarded(...args) {
                const p = blockedProviderOf(hostOfRequestArgs(args), blocked);
                if (p) throw refuse(p);
                return orig.apply(this, args);
            };
            patched.push([mod, fn, orig]);
        }
    }
    return {
        attempts,
        uninstall: () => {
            if (typeof origFetch === 'function') globalThis.fetch = origFetch;
            for (const [mod, fn, orig] of patched) mod[fn] = orig;
        },
    };
}

/**
 * The model list without the blocked providers' models.
 * @param {string|null} models  comma-separated list
 * @param {string|null} provider  the list's first provider
 * @param {string[]} blocked
 * @param {(csv: string, first: string) => { provider: string, models: string[] }[]} splitByProvider  factory.splitByProvider
 * @returns {{ provider: string, model: string, dropped: string[] }|null}  null when nothing is left
 */
function filterLlmList(models, provider, blocked, splitByProvider) {
    if (!models || !provider) return null;
    const segments = splitByProvider(models, provider);
    const kept = segments.filter(s => !blocked.includes(s.provider));
    const dropped = segments.filter(s => blocked.includes(s.provider)).flatMap(s => s.models);
    if (!kept.length) return null;
    return { provider: kept[0].provider, model: kept.flatMap(s => s.models).join(','), dropped };
}

function sseResponse(lines) {
    const encoder = new TextEncoder();
    const queue = lines.map(l => encoder.encode(`${l}\n\n`));
    return {
        ok: true,
        status: 200,
        body: new ReadableStream({
            pull(controller) {
                if (queue.length) controller.enqueue(queue.shift());
                else controller.close();
            },
        }),
    };
}

/** A streaming LLM that answers locally, in the SSE shape the app reads. */
function createStubStreamingLLM() {
    return {
        streamChat: async () => {
            const words = STUB_ANSWER.split(/(?<= )/);
            const lines = words.map(w => `data: ${JSON.stringify({ choices: [{ delta: { content: w } }] })}`);
            return sseResponse([...lines, `data: ${JSON.stringify({ _final_model: STUB_MODEL })}`, 'data: [DONE]']);
        },
    };
}

/** The Insights lane's LLM, answered locally. */
function createStubLLM() {
    return {
        chat: async () => ({ content: STUB_INSIGHTS, model: STUB_MODEL }),
        generateContent: async () => ({ response: { text: () => STUB_INSIGHTS } }),
    };
}

module.exports = {
    PROVIDER_HOSTS,
    STUB_PROVIDER,
    STUB_MODEL,
    STUB_ANSWER,
    parseBlocked,
    blockedProviderOf,
    installNetGuard,
    filterLlmList,
    createStubStreamingLLM,
    createStubLLM,
};

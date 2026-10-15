'use strict';

// Time to first token, the same request on several OpenAI-compatible
// endpoints (spec 2026-10-14-openai-compatible-provider). Built to answer one
// question: how much does a gateway such as OmniRoute add to Live Answer's
// latency, against calling the provider directly?
//
// Each run sends one interview-sized request (a ~1.2K-token system prompt and
// a question, max_tokens 300, streamed) to every target, in an order that
// alternates between runs, and records: time to response headers, time to the
// first answer text (ttft), total time, finish reason, the model that served
// it and OmniRoute's X-OmniRoute-Decision header when there is one. It never
// prints prompt or answer text, nor a key.
//
// Targets: --target name,baseURL,model[,KEY_ENV_NAME] (repeatable). The key
// is read from the named environment variable (or .env), never from the
// command line. Without --target, two defaults are used when their variables
// are set:
//   groq-direct  https://api.groq.com/openai/v1, openai/gpt-oss-120b, GROQ_API_KEY
//   endpoint     OPENAI_COMPATIBLE_BASE_URL, OPENAI_COMPATIBLE_MODEL, OPENAI_COMPATIBLE_API_KEY
//
//   node scripts/probe-openai-compatible-ttft.js
//   node scripts/probe-openai-compatible-ttft.js --runs 10 \
//     --target groq-direct,https://api.groq.com/openai/v1,openai/gpt-oss-120b,GROQ_API_KEY \
//     --target omniroute,http://localhost:20128/v1,groq/openai/gpt-oss-120b,OMNIROUTE_API_KEY
//
// Flags: --runs N (default 8), --gap-ms N between runs (default 1500),
// --max-tokens N (default 300), --extra '<json>' merged into every request
// (e.g. '{"reasoning_effort":"low"}'), --json <file> to save the results.

require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const OpenAI = require('openai');

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
    const a = { runs: 8, gapMs: 1500, maxTokens: 300, extra: {}, targets: [], json: null };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        const v = () => {
            if (i + 1 >= argv.length) throw new Error(`${k} needs a value`);
            return argv[++i];
        };
        if (k === '--runs') a.runs = Number(v());
        else if (k === '--gap-ms') a.gapMs = Number(v());
        else if (k === '--max-tokens') a.maxTokens = Number(v());
        else if (k === '--extra') a.extra = JSON.parse(v());
        else if (k === '--json') a.json = v();
        else if (k === '--target') {
            const [name, baseURL, model, keyEnv] = v().split(',').map(s => s.trim());
            if (!name || !baseURL || !model) throw new Error('--target is name,baseURL,model[,KEY_ENV_NAME]');
            a.targets.push({ name, baseURL, model, keyEnv: keyEnv || null });
        } else if (k === '--help' || k === '-h') {
            a.help = true;
        } else {
            throw new Error(`unknown flag ${k}`);
        }
    }
    if (!Number.isInteger(a.runs) || a.runs < 1) throw new Error('--runs must be a positive integer');
    return a;
}

function defaultTargets(env) {
    const targets = [];
    if (env.GROQ_API_KEY) targets.push({ name: 'groq-direct', baseURL: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', keyEnv: 'GROQ_API_KEY' });
    if (env.OPENAI_COMPATIBLE_BASE_URL) {
        if (!env.OPENAI_COMPATIBLE_MODEL) throw new Error('OPENAI_COMPATIBLE_BASE_URL is set: set OPENAI_COMPATIBLE_MODEL too (the endpoint\'s model ID)');
        targets.push({ name: 'endpoint', baseURL: env.OPENAI_COMPATIBLE_BASE_URL, model: env.OPENAI_COMPATIBLE_MODEL, keyEnv: 'OPENAI_COMPATIBLE_API_KEY' });
    }
    return targets;
}

// ---------------------------------------------------------------------------
// The request (interview-sized, no personal data)
// ---------------------------------------------------------------------------

const GUIDANCE = [
    'You help a candidate answer questions during a live technical interview.',
    'Answer in the language of the question. Lead with the direct answer in one sentence.',
    'Then give two to four short bullets with the reasoning, a concrete example and a trade-off.',
    'Prefer plain words over jargon; define a term the first time it appears.',
    'Never invent numbers, names or experience; if something is unknown, say how you would find out.',
    'Keep the answer under 120 words unless the question asks for code or a design.',
    'For a design question, name the components, the data flow and the main bottleneck.',
    'For a behavioural question, use situation, action and result, in that order.',
    'For a coding question, state the approach and its complexity before any code.',
];
// About 1.2K tokens, the size of Live Answer's prompt without the transcript.
const SYSTEM = Array.from({ length: 6 }, (_, i) => `${i + 1}. ${GUIDANCE.join(' ')}`).join('\n');
const QUESTION = 'What is the difference between a process and a thread, and when would you pick one over the other?';

// ---------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------

function clientFor(target, env) {
    const apiKey = target.keyEnv ? env[target.keyEnv] : '';
    if (target.keyEnv && !apiKey) throw new Error(`${target.name}: ${target.keyEnv} is not set`);
    // Everything the SDK would read from the environment is set: OpenAI's key
    // and organization must never reach another server.
    return new OpenAI({ apiKey: apiKey || 'none', baseURL: target.baseURL, organization: null, project: null, maxRetries: 0, timeout: 30_000 });
}

async function runOnce(client, target, args) {
    const t0 = Date.now();
    const r = { target: target.name, ok: false, status: null, headersMs: null, ttftMs: null, totalMs: null, chunks: 0, chars: 0, finish: null, servedBy: null, route: null, error: null };
    const ac = new AbortController();
    const watchdog = setTimeout(() => ac.abort(), 60_000);
    try {
        const params = {
            model: target.model,
            messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: QUESTION }],
            stream: true,
            max_tokens: args.maxTokens,
            temperature: 0.3,
            ...args.extra,
        };
        const { data, response } = await client.chat.completions.create(params, { signal: ac.signal }).withResponse();
        r.status = response.status;
        r.headersMs = Date.now() - t0;
        r.route = response.headers.get('x-omniroute-decision');
        for await (const chunk of data) {
            if (chunk.model) r.servedBy = chunk.model;
            if (chunk.error) throw Object.assign(new Error('error chunk mid-stream'), { status: chunk.error.code ?? null });
            const choice = chunk.choices?.[0];
            const text = choice?.delta?.content;
            if (text) {
                if (r.ttftMs == null) r.ttftMs = Date.now() - t0;
                r.chunks++;
                r.chars += text.length;
            }
            if (choice?.finish_reason) {
                r.finish = choice.finish_reason;
                break; // the SDK keeps reading after [DONE] until the server closes
            }
        }
        r.totalMs = Date.now() - t0;
        r.ok = r.ttftMs != null;
        if (!r.ok) r.error = `no answer text (finish=${r.finish || '-'})`;
    } catch (err) {
        r.totalMs = Date.now() - t0;
        r.status = err?.status ?? r.status;
        const msg = err?.error?.message || err?.message || String(err);
        r.error = String(msg).slice(0, 160);
    } finally {
        clearTimeout(watchdog);
        ac.abort();
    }
    return r;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function percentile(values, p) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((x, y) => x - y);
    const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[i];
}

function summarize(results, targets) {
    return targets.map((t) => {
        const mine = results.filter(r => r.target === t.name);
        const ok = mine.filter(r => r.ok);
        const ttft = ok.map(r => r.ttftMs);
        const total = ok.map(r => r.totalMs);
        const headers = ok.map(r => r.headersMs);
        return {
            target: t.name, model: t.model, runs: mine.length, ok: ok.length,
            headersP50: percentile(headers, 50),
            ttftP50: percentile(ttft, 50), ttftP90: percentile(ttft, 90),
            ttftMin: ttft.length ? Math.min(...ttft) : null, ttftMax: ttft.length ? Math.max(...ttft) : null,
            totalP50: percentile(total, 50),
            errors: [...new Set(mine.filter(r => !r.ok).map(r => `${r.status ?? '-'} ${r.error}`))],
        };
    });
}

const ms = (n) => (n == null ? '-' : `${n}ms`);
const pad = (s, n) => String(s).padEnd(n);

function printSummary(summary) {
    console.log('\n== summary (successful runs only)');
    console.log(`${pad('target', 16)}${pad('ok', 7)}${pad('headers p50', 13)}${pad('ttft p50', 10)}${pad('ttft p90', 10)}${pad('ttft min-max', 16)}${pad('total p50', 10)}`);
    for (const s of summary) {
        console.log(`${pad(s.target, 16)}${pad(`${s.ok}/${s.runs}`, 7)}${pad(ms(s.headersP50), 13)}${pad(ms(s.ttftP50), 10)}${pad(ms(s.ttftP90), 10)}${pad(s.ttftMin == null ? '-' : `${ms(s.ttftMin)}-${ms(s.ttftMax)}`, 16)}${pad(ms(s.totalP50), 10)}`);
        for (const e of s.errors) console.log(`  error: ${e}`);
    }
    const [first, ...rest] = summary;
    if (first?.ttftP50 != null) {
        for (const s of rest) {
            if (s.ttftP50 == null) continue;
            const d = s.ttftP50 - first.ttftP50;
            console.log(`ttft p50 ${s.target} vs ${first.target}: ${d >= 0 ? '+' : ''}${d}ms`);
        }
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log(fs.readFileSync(__filename, 'utf8').split('\n').filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n'));
        return;
    }
    const targets = args.targets.length ? args.targets : defaultTargets(process.env);
    if (targets.length === 0) {
        console.error('No target: pass --target name,baseURL,model,KEY_ENV or set GROQ_API_KEY / OPENAI_COMPATIBLE_BASE_URL (see --help)');
        process.exit(2);
    }
    const clients = Object.fromEntries(targets.map(t => [t.name, clientFor(t, process.env)]));
    console.log(`targets: ${targets.map(t => `${t.name} (${new URL(t.baseURL).host}, ${t.model})`).join(' | ')}`);
    console.log(`runs=${args.runs} max_tokens=${args.maxTokens} system≈${Math.round(SYSTEM.length / 4)} tokens extra=${JSON.stringify(args.extra)}`);

    const results = [];
    for (let run = 0; run < args.runs; run++) {
        // Alternate the order, so neither target always goes first (warm connections, rate limits).
        const order = run % 2 === 0 ? targets : [...targets].reverse();
        for (const t of order) {
            const r = await runOnce(clients[t.name], t, args);
            results.push({ run: run + 1, ...r });
            const extra = [r.servedBy && r.servedBy !== t.model ? `served_by=${r.servedBy}` : '', r.route ? `route=${JSON.stringify(r.route.slice(0, 120))}` : ''].filter(Boolean).join(' ');
            console.log(`run ${run + 1} ${pad(t.name, 14)} ${r.ok ? 'ok   ' : 'FAIL '} status=${r.status ?? '-'} headers=${ms(r.headersMs)} ttft=${ms(r.ttftMs)} total=${ms(r.totalMs)} chunks=${r.chunks} chars=${r.chars} finish=${r.finish || '-'} ${extra}${r.error ? ` error=${JSON.stringify(r.error)}` : ''}`);
        }
        if (run < args.runs - 1) await new Promise(resolve => setTimeout(resolve, args.gapMs));
    }

    const summary = summarize(results, targets);
    printSummary(summary);
    if (args.json) {
        fs.writeFileSync(args.json, JSON.stringify({ at: new Date().toISOString(), args: { ...args, targets: targets.map(({ keyEnv, ...t }) => t) }, summary, results }, null, 2));
        console.log(`saved ${args.json}`);
    }
}

if (require.main === module) {
    main().catch((err) => {
        console.error(err.message || err);
        process.exit(1);
    });
}

module.exports = { parseArgs, defaultTargets, percentile, summarize };

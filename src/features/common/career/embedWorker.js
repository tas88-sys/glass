'use strict';

// Worker body for the career embedder (FR-009). Runs in an Electron
// utilityProcess (the app) or a worker_thread (plain Node: the eval script).
// The model runtime is required here only, on 'init', never in the main
// process (C4). Protocol:
//   in:  { type: 'init', modelId, dtype, pooling, threads, cacheDir }
//        { type: 'embed', id, texts }
//   out: { type: 'ready', dims } | { type: 'init-error', message }
//        { type: 'result', id, dims, data: Float32Array } | { type: 'error', id, message }

let port = null;
let unwrap = m => m;
try {
    port = require('node:worker_threads').parentPort;
} catch {
    port = null;
}
if (!port && process.parentPort) {
    port = process.parentPort;          // Electron utilityProcess: messages arrive as { data }
    unwrap = e => (e && e.data !== undefined ? e.data : e);
}

let embed = null;                       // texts → { data: Float32Array, dims: number[] }

const short = err => String((err && err.message) || err).slice(0, 200);

async function handle(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'init') {
        try {
            const { pipeline, AutoTokenizer, AutoModel, env } = require('@huggingface/transformers');
            if (msg.cacheDir) env.cacheDir = msg.cacheDir;
            const options = {
                dtype: msg.dtype,
                // The CPU arena keeps peak buffers for the process lifetime; without it the
                // worker sits ~85 MB lower for slightly slower passages (spike T024).
                session_options: {
                    intraOpNumThreads: msg.threads || 1,
                    interOpNumThreads: 1,
                    enableCpuMemArena: false,
                    enableMemPattern: false,
                    // Idle threads sleep instead of spinning after each request. Spinning
                    // burns CPU during calls and slowed the answer-path vector search
                    // (eval answer path p95 19-26 ms with it, 13-19 ms without).
                    extra: { session: { intra_op: { allow_spinning: '0' }, inter_op: { allow_spinning: '0' } } },
                },
            };
            if (msg.pooling === 'sentence_embedding') {
                // Models that export their own pooled output (CLS plus any dense head).
                const tokenizer = await AutoTokenizer.from_pretrained(msg.modelId);
                const model = await AutoModel.from_pretrained(msg.modelId, options);
                embed = async texts => {
                    const inputs = await tokenizer(texts, { padding: true, truncation: true, max_length: 512 });
                    const out = await model(inputs);
                    return out.sentence_embedding.normalize(2, -1);
                };
            } else {
                const extractor = await pipeline('feature-extraction', msg.modelId, options);
                embed = texts => extractor(texts, { pooling: 'mean', normalize: true });
            }
            const probe = await embed(['probe']);
            port.postMessage({ type: 'ready', dims: probe.dims[probe.dims.length - 1] });
        } catch (err) {
            port.postMessage({ type: 'init-error', message: short(err) });
        }
        return;
    }
    if (msg.type === 'embed') {
        try {
            if (!embed) throw new Error('not initialized');
            const out = await embed(msg.texts);
            port.postMessage({ type: 'result', id: msg.id, dims: out.dims[out.dims.length - 1], data: out.data });
        } catch (err) {
            port.postMessage({ type: 'error', id: msg.id, message: short(err) });
        }
    }
}

// Requests arrive one at a time from the host, so handling them in order is enough.
if (port) port.on('message', raw => handle(unwrap(raw)));

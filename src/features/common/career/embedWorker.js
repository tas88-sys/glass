'use strict';

// Worker body for the career embedder (FR-009). Runs in an Electron
// utilityProcess (the app) or a worker_thread (plain Node: the eval script).
// The model runtime is required here only, on 'init', never in the main
// process (C4). Protocol:
//   in:  { type: 'init', modelId, dtype, threads, cacheDir }
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

let extractor = null;

const short = err => String((err && err.message) || err).slice(0, 200);

async function handle(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'init') {
        try {
            const { pipeline, env } = require('@huggingface/transformers');
            if (msg.cacheDir) env.cacheDir = msg.cacheDir;
            extractor = await pipeline('feature-extraction', msg.modelId, {
                dtype: msg.dtype,
                // The CPU arena keeps peak buffers for the process lifetime; without it the
                // worker sits ~85 MB lower for slightly slower passages (spike T024).
                session_options: {
                    intraOpNumThreads: msg.threads || 1,
                    interOpNumThreads: 1,
                    enableCpuMemArena: false,
                    enableMemPattern: false,
                },
            });
            const probe = await extractor(['query: probe'], { pooling: 'mean', normalize: true });
            port.postMessage({ type: 'ready', dims: probe.dims[probe.dims.length - 1] });
        } catch (err) {
            port.postMessage({ type: 'init-error', message: short(err) });
        }
        return;
    }
    if (msg.type === 'embed') {
        try {
            if (!extractor) throw new Error('not initialized');
            const out = await extractor(msg.texts, { pooling: 'mean', normalize: true });
            port.postMessage({ type: 'result', id: msg.id, dims: out.dims[out.dims.length - 1], data: out.data });
        } catch (err) {
            port.postMessage({ type: 'error', id: msg.id, message: short(err) });
        }
    }
}

// Requests arrive one at a time from the host, so handling them in order is enough.
if (port) port.on('message', raw => handle(unwrap(raw)));

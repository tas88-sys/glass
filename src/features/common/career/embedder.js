'use strict';

// Semantic side of retrieval (FR-009, research R5). A multilingual embedding
// model runs in a separate worker (Electron utilityProcess in the app, a
// worker_thread under plain Node), so inference never blocks the main event
// loop and a native crash cannot take the app down. Each chunk gets two
// vectors: its text and its section title (research R5: question-to-heading
// matching finds Q&A notes well). Vectors are cached on disk by content hash
// and model id. Queries jump ahead of the corpus pass, are prefetched during
// the answer debounce and awaited for a bounded time.
//
// Total: nothing here throws to the caller. Any failure means "no vectors",
// and retrieval falls back to BM25 (FR-017).

const crypto = require('node:crypto');
const nodePath = require('node:path');
const os = require('node:os');
const fsp = require('node:fs/promises');
const { buildVectorIndex } = require('./vectorIndex');

// Per-model settings. Titles are embedded like queries: they are questions
// or topics, and the match is question to question. minCosine is the FR-012
// ambiguous-route gate on that model's cosine scale (research R5).
const MODEL_PROFILES = {
    'Snowflake/snowflake-arctic-embed-m-v2.0': {
        dtype: 'q8', pooling: 'sentence_embedding', queryPrefix: 'query: ', passagePrefix: '', minCosine: 0.35,
    },
    'Xenova/multilingual-e5-small': {
        dtype: 'q8', pooling: 'mean', queryPrefix: 'query: ', passagePrefix: 'passage: ', minCosine: 0.85,
    },
};
const DEFAULT_MODEL = 'Snowflake/snowflake-arctic-embed-m-v2.0';
const FALLBACK_PROFILE = MODEL_PROFILES['Xenova/multilingual-e5-small'];
const MAX_PASSAGE_CHARS = 1500;
const INIT_TIMEOUT_MS = 10 * 60 * 1000;   // the first run downloads the model
const PERSIST_EVERY = 64;

const normalizeKey = text => String(text).trim().replace(/\s+/g, ' ');
const modelSlug = id => String(id).replace(/[^a-zA-Z0-9]+/g, '-');
const sha1 = s => crypto.createHash('sha1').update(s).digest('hex');

/** The section part of a breadcrumb title ("file › H2 › H3" → "H2 › H3"). */
function sectionTitle(title) {
    const parts = String(title || '').split(' › ');
    return (parts.length > 1 ? parts.slice(1).join(' › ') : parts[0]).trim();
}

function defaultThreads() {
    return Math.max(1, Math.min(4, Math.floor(os.cpus().length / 4)));
}

/** userData/career-kb inside the Electron main process; no disk cache elsewhere. */
function defaultCacheDir() {
    if (process.versions.electron && process.type === 'browser') {
        const { app } = require('electron');
        return nodePath.join(app.getPath('userData'), 'career-kb');
    }
    return null;
}

/** A worker handle: { send, onMessage, onExit, kill }. */
function defaultSpawnWorker(log = () => {}) {
    const script = nodePath.join(__dirname, 'embedWorker.js');
    if (process.versions.electron && process.type === 'browser') {
        const { utilityProcess } = require('electron');
        const child = utilityProcess.fork(script, [], { serviceName: 'Glass career embedder' });
        return {
            send: msg => child.postMessage(msg),
            onMessage: cb => child.on('message', cb),
            onExit: cb => child.on('exit', cb),
            kill: () => {
                try {
                    child.kill();
                } catch {
                    /* already gone */
                }
            },
        };
    }
    const { Worker } = require('node:worker_threads');
    const worker = new Worker(script);
    worker.unref();
    worker.on('error', err => log(`[career] embed worker error (${(err && err.name) || 'error'})`));
    return {
        send: msg => worker.postMessage(msg),
        onMessage: cb => worker.on('message', cb),
        onExit: cb => worker.on('exit', cb),
        kill: () => {
            worker.terminate().catch(() => {});
        },
    };
}

/**
 * @param {{
 *   spawnWorker?: () => {send: Function, onMessage: Function, onExit: Function, kill: Function},
 *   cacheDir?: () => string|null,
 *   log?: (line: string) => void,
 *   modelId?: string,
 *   dtype?: string,
 *   pooling?: 'mean'|'sentence_embedding',
 *   threads?: number,
 *   fs?: typeof fsp,
 * }} [options]
 */
function createEmbedder(options = {}) {
    const log = options.log || (() => {});
    const spawnWorker = options.spawnWorker || (() => defaultSpawnWorker(log));
    const cacheDirFn = options.cacheDir || defaultCacheDir;
    const modelId = options.modelId || DEFAULT_MODEL;
    const profile = MODEL_PROFILES[modelId] || FALLBACK_PROFILE;
    const dtype = options.dtype || profile.dtype;
    const pooling = options.pooling || profile.pooling;
    const { queryPrefix, passagePrefix } = profile;
    const passageText = c => `${passagePrefix}${c.title}\n${c.body}`.slice(0, MAX_PASSAGE_CHARS);
    const titleText = c => `${queryPrefix}${sectionTitle(c.title)}`;
    const threads = options.threads || defaultThreads();
    const fs = options.fs || fsp;

    let state = 'idle';             // idle | starting | ready | failed
    let worker = null;
    let dims = 0;
    let startPromise = null;
    let initWaiter = null;

    const store = new Map();        // content hash or title key → Float32Array
    let storeVersion = 0;
    let cacheDims = 0;
    let cacheLoaded = false;
    let persistChain = Promise.resolve();

    let seq = 0;
    const inflight = new Map();     // request id → job
    const queues = { high: [], low: [] };
    let busy = false;
    let prefetched = null;          // { key, promise }
    let syncGen = 0;
    let indexCache = null;          // { chunks, version, index }
    const titleKeys = new WeakMap(); // chunk → title key, hashed once per chunk object
    const keyOfTitle = c => {
        let k = titleKeys.get(c);
        if (!k) titleKeys.set(c, (k = `t:${sha1(titleText(c))}`));
        return k;
    };

    function cacheDir() {
        try {
            return cacheDirFn() || null;
        } catch {
            return null;
        }
    }

    function files() {
        const dir = cacheDir();
        if (!dir) return null;
        const base = nodePath.join(dir, `vectors-${modelSlug(modelId)}`);
        return { dir, bin: `${base}.bin`, json: `${base}.json`, models: nodePath.join(dir, 'models') };
    }

    // --- worker lifecycle ----------------------------------------------------

    function settleAll() {
        for (const job of inflight.values()) job.resolve(null);
        inflight.clear();
        for (const q of [queues.high, queues.low]) for (const job of q.splice(0)) job.resolve(null);
        busy = false;
        prefetched = null;
    }

    function onMessage(w, raw) {
        if (w !== worker) return;                     // a stale worker
        const msg = raw && raw.type === undefined && raw.data ? raw.data : raw;
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'ready') {
            dims = msg.dims;
            if (cacheDims && cacheDims !== dims) {
                store.clear();
                storeVersion++;
            }
            state = 'ready';
            log(`[career] embedder ready (${modelId}, ${dims}d)`);
            if (initWaiter) initWaiter(true);
            pump();
            return;
        }
        if (msg.type === 'init-error') {
            log('[career] embedder unavailable (model load failed); BM25 only');
            stopWorker();
            if (initWaiter) initWaiter(false);
            return;
        }
        if (msg.type === 'result' || msg.type === 'error') {
            const job = inflight.get(msg.id);
            inflight.delete(msg.id);
            busy = false;
            if (job) {
                if (msg.type === 'result') {
                    const n = job.texts.length;
                    const d = msg.dims || dims;
                    const out = [];
                    for (let i = 0; i < n; i++) out.push(Float32Array.from(msg.data.slice(i * d, (i + 1) * d)));
                    job.resolve(out);
                } else {
                    job.resolve(null);
                }
            }
            pump();
        }
    }

    function onExit(w) {
        if (w !== worker) return;
        worker = null;
        if (state !== 'failed') log('[career] embed worker exited; BM25 only until the next warm');
        state = 'failed';
        settleAll();
        if (initWaiter) initWaiter(false);
    }

    function stopWorker() {
        const w = worker;
        worker = null;
        state = 'failed';
        settleAll();
        if (w) w.kill();
    }

    function start() {
        if (state === 'ready') return Promise.resolve(true);
        if (startPromise) return startPromise;
        state = 'starting';
        startPromise = new Promise(resolve => {
            let timer = null;
            initWaiter = ok => {
                initWaiter = null;
                if (timer) clearTimeout(timer);
                resolve(ok);
            };
            let w;
            try {
                w = spawnWorker();
            } catch (err) {
                log(`[career] embedder unavailable (${(err && (err.code || err.name)) || 'error'}); BM25 only`);
                state = 'failed';
                initWaiter(false);
                return;
            }
            worker = w;
            timer = setTimeout(() => {
                log('[career] embedder load timed out; BM25 only');
                stopWorker();
                if (initWaiter) initWaiter(false);
            }, INIT_TIMEOUT_MS);
            if (timer.unref) timer.unref();
            try {
                w.onMessage(m => onMessage(w, m));
                w.onExit(() => onExit(w));
                const f = files();
                w.send({ type: 'init', modelId, dtype, pooling, threads, cacheDir: f ? f.models : null });
            } catch {
                stopWorker();
                if (initWaiter) initWaiter(false);
            }
        }).finally(() => {
            startPromise = null;
        });
        return startPromise;
    }

    function pump() {
        if (busy || state !== 'ready' || !worker) return;
        const job = queues.high.shift() || queues.low.shift();
        if (!job) return;
        busy = true;
        const id = ++seq;
        inflight.set(id, job);
        try {
            worker.send({ type: 'embed', id, texts: job.texts, kind: job.kind });
        } catch {
            stopWorker();
        }
    }

    /** @returns {Promise<Float32Array[]|null>} kind (query | passage | title) is informational only. */
    function embed(texts, priority, kind) {
        if (state !== 'ready') return Promise.resolve(null);
        return new Promise(resolve => {
            queues[priority].push({ texts, kind, resolve });
            pump();
        });
    }

    // --- disk cache ------------------------------------------------------------

    async function loadCache() {
        if (cacheLoaded) return;
        cacheLoaded = true;
        const f = files();
        if (!f) return;
        try {
            const meta = JSON.parse(await fs.readFile(f.json, 'utf8'));
            if (!meta || meta.modelId !== modelId || !(meta.dims > 0) || !Array.isArray(meta.hashes)) return;
            const buf = await fs.readFile(f.bin);
            if (buf.byteLength !== meta.hashes.length * meta.dims * 4) return;
            const all = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
            meta.hashes.forEach((h, i) => store.set(h, all.slice(i * meta.dims, (i + 1) * meta.dims)));
            cacheDims = meta.dims;
            storeVersion++;
            log(`[career] vector cache loaded (${meta.hashes.length} rows)`);
        } catch {
            /* missing or corrupt cache: rebuild */
        }
    }

    function persist(keep) {
        persistChain = persistChain.then(async () => {
            const f = files();
            if (!f || store.size === 0) return;
            const hashes = [...store.keys()].filter(h => !keep || keep.has(h));
            const d = store.get(hashes[0]) ? store.get(hashes[0]).length : 0;
            if (!d) return;
            const all = new Float32Array(hashes.length * d);
            hashes.forEach((h, i) => all.set(store.get(h), i * d));
            try {
                await fs.mkdir(f.dir, { recursive: true });
                await fs.writeFile(`${f.bin}.tmp`, Buffer.from(all.buffer));
                await fs.writeFile(`${f.json}.tmp`, JSON.stringify({ modelId, dims: d, hashes }));
                await fs.rename(`${f.bin}.tmp`, f.bin);
                await fs.rename(`${f.json}.tmp`, f.json);
            } catch (err) {
                log(`[career] vector cache not saved (${(err && err.code) || 'error'})`);
            }
        });
        return persistChain;
    }

    // --- public ------------------------------------------------------------------

    /**
     * Embed the chunk texts and section titles that have no vector yet
     * (FR-016). Starts or restarts the worker. Resolves when the pass ends, is
     * superseded or the worker fails.
     */
    async function sync(chunks) {
        const gen = ++syncGen;
        const keep = new Set();
        let added = 0;
        try {
            await loadCache();
            if (!(await start())) return;
            const texts = [];           // { key, text, kind }: chunk texts first, then titles
            const titles = [];
            for (const c of chunks || []) {
                if (!c || !c.hash) continue;
                if (!keep.has(c.hash)) {
                    keep.add(c.hash);
                    if (!store.has(c.hash)) texts.push({ key: c.hash, text: passageText(c), kind: 'passage' });
                }
                const tk = keyOfTitle(c);
                if (!keep.has(tk)) {
                    keep.add(tk);
                    if (!store.has(tk)) titles.push({ key: tk, text: titleText(c), kind: 'title' });
                }
            }
            for (const job of texts.concat(titles)) {
                if (gen !== syncGen || state !== 'ready') break;
                const vecs = await embed([job.text], 'low', job.kind);
                if (!vecs) continue;
                store.set(job.key, vecs[0]);
                storeVersion++;
                added++;
                if (added % PERSIST_EVERY === 0) await persist(keep);
            }
        } catch (err) {
            log(`[career] embedding pass stopped (${(err && err.name) || 'error'})`);
        } finally {
            if (added > 0 || (gen === syncGen && keep.size && store.size > keep.size)) await persist(keep);
        }
    }

    function isReadyFor(chunks) {
        return state === 'ready' && Array.isArray(chunks) && chunks.every(c => store.has(c.hash) && store.has(keyOfTitle(c)));
    }

    /** A search over the chunks whose key has a vector, row → chunk index. */
    function searchOver(chunks, keyOf) {
        const map = [];
        for (let i = 0; i < chunks.length; i++) if (store.has(keyOf(chunks[i]))) map.push(i);
        const rows = new Float32Array(map.length * dims);
        map.forEach((ci, r) => rows.set(store.get(keyOf(chunks[ci])), r * dims));
        const vi = buildVectorIndex(rows, dims);
        return (query, k) => vi.search(query, k).map(h => ({ idx: map[h.idx], score: h.score }));
    }

    /**
     * Vector indexes over the chunks that have vectors: search() on the chunk
     * texts, searchTitles() on the section titles. Null when queries cannot be embedded.
     */
    function indexFor(chunks) {
        if (state !== 'ready' || store.size === 0 || !Array.isArray(chunks)) return null;
        if (indexCache && indexCache.chunks === chunks && indexCache.version === storeVersion) return indexCache.index;
        let size = 0;
        for (const c of chunks) if (store.has(c.hash)) size++;
        if (!size) return null;
        const index = {
            size,
            search: searchOver(chunks, c => c.hash),
            searchTitles: searchOver(chunks, keyOfTitle),
        };
        indexCache = { chunks, version: storeVersion, index };
        return index;
    }

    /** Start the query embedding for a gated turn (FR-009). Keeps the latest only. */
    function prefetch(text) {
        if (state !== 'ready' || typeof text !== 'string') return;
        const key = normalizeKey(text);
        if (!key || (prefetched && prefetched.key === key)) return;
        prefetched = { key, promise: embed([`${queryPrefix}${key}`], 'high', 'query').then(v => (v ? v[0] : null)) };
    }

    /** The query vector, or null when not ready within timeoutMs (E19). */
    async function query(text, timeoutMs) {
        if (state !== 'ready' || typeof text !== 'string') return null;
        const key = normalizeKey(text);
        if (!prefetched || prefetched.key !== key) prefetch(text);
        if (!prefetched) return null;
        let timer;
        const timeout = new Promise(resolve => {
            timer = setTimeout(() => resolve(null), timeoutMs);
        });
        try {
            return await Promise.race([prefetched.promise, timeout]);
        } finally {
            clearTimeout(timer);
        }
    }

    /** Stop the worker (eval script, app quit). */
    function close() {
        stopWorker();
        state = 'idle';
    }

    return {
        sync,
        isReadyFor,
        indexFor,
        prefetch,
        query,
        close,
        vectorCount: () => store.size,
        modelId,
        minCosine: profile.minCosine,
    };
}

module.exports = { createEmbedder, sectionTitle, MODEL_PROFILES, DEFAULT_MODEL };

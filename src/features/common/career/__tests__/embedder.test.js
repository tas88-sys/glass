/**
 * embedder.test.js — T025, T029 (FR-009, FR-016, FR-017; E11, E19, E20, E21)
 *
 * Run: node --test src/features/common/career/__tests__/embedder.test.js
 *
 * The model is never loaded: a fake worker speaks the embedder protocol and
 * returns deterministic vectors. Fixtures are invented text only (spec C5).
 */

'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createEmbedder, sectionTitle, MODEL_PROFILES, DEFAULT_MODEL } = require('../embedder');
const { createCareerModule } = require('../index');

const DIMS = 4;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Deterministic "semantic" vectors: texts about storms point one way, about
// gardens another, so a Portuguese query can meet an English note (E11).
function fakeVector(text) {
    const t = text.toLowerCase();
    const v = new Float32Array(DIMS);
    if (/storm|tempestade/.test(t)) v[0] = 1;
    if (/garden|jardim/.test(t)) v[1] = 1;
    if (/ferry|balsa/.test(t)) v[2] = 1;
    v[3] = 0.1;
    const n = Math.hypot(...v);
    return v.map(x => x / n);
}

/** A worker double: same message protocol as embedWorker.js. */
function fakeWorkerFactory(opts = {}) {
    const stats = { spawned: 0, embedCalls: 0, init: null, queryTexts: [], passageTexts: [], titleTexts: [], workers: [] };
    const bucket = { query: 'queryTexts', passage: 'passageTexts', title: 'titleTexts' };
    const spawn = () => {
        stats.spawned++;
        let onMessage = () => {};
        let onExit = () => {};
        let alive = true;
        const w = {
            send(msg) {
                if (!alive) return;
                setImmediate(async () => {
                    if (!alive) return;
                    if (msg.type === 'init') {
                        stats.init = msg;
                        if (opts.initError) onMessage({ type: 'init-error', message: 'offline' });
                        else onMessage({ type: 'ready', dims: DIMS });
                        return;
                    }
                    if (msg.type === 'embed') {
                        stats.embedCalls++;
                        stats[bucket[msg.kind]].push(...msg.texts);
                        const delay = typeof opts.delay === 'function' ? opts.delay(msg) : opts.delay || 0;
                        if (delay) await sleep(delay);
                        if (!alive) return;
                        const crashAt = msg.kind === 'passage' ? opts.crashOnPassage : msg.kind === 'title' ? opts.crashOnTitle : 0;
                        if (crashAt && stats[bucket[msg.kind]].length >= crashAt) {
                            alive = false;
                            onExit(1);
                            return;
                        }
                        const data = new Float32Array(msg.texts.length * DIMS);
                        msg.texts.forEach((t, i) => data.set(fakeVector(t), i * DIMS));
                        onMessage({ type: 'result', id: msg.id, dims: DIMS, data });
                    }
                });
            },
            onMessage(cb) { onMessage = cb; },
            onExit(cb) { onExit = cb; },
            kill() { alive = false; },
            crash() { alive = false; onExit(1); },
        };
        stats.workers.push(w);
        return w;
    };
    return { spawn, stats };
}

const chunk = (i, title, body) => ({
    id: `c${i}`, path: `notes/n${i}.md`, title, body, companies: [], date: 0, kind: 'section', hash: `hash-${i}-${title}`,
});
const CHUNKS = [
    chunk(0, 'log › Storm night', 'The storm knocked out the beacon.'),
    chunk(1, 'log › Garden', 'The keeper grew tomatoes in the garden.'),
    chunk(2, 'log › Ferry', 'The ferry ran late every winter.'),
];

const dirs = [];
async function tmpDir() {
    const d = await fsp.mkdtemp(path.join(os.tmpdir(), 'career-emb-'));
    dirs.push(d);
    return d;
}
after(async () => {
    for (const d of dirs) await fsp.rm(d, { recursive: true, force: true });
});

function embedder(worker, cacheDir, extra = {}) {
    return createEmbedder({ spawnWorker: worker.spawn, cacheDir: () => cacheDir, log: () => {}, ...extra });
}

describe('embedder: corpus pass and cache (FR-009, FR-016)', () => {
    it("embeds each chunk's text and section title once and becomes ready for those chunks", async () => {
        const w = fakeWorkerFactory();
        const e = embedder(w, await tmpDir());
        assert.equal(e.isReadyFor(CHUNKS), false);
        await e.sync(CHUNKS);
        assert.equal(e.isReadyFor(CHUNKS), true);
        assert.equal(e.vectorCount(), 6, 'three texts and three titles');
        assert.deepEqual(w.stats.passageTexts, CHUNKS.map(c => `${c.title}\n${c.body}`), 'default model: no passage prefix');
        assert.deepEqual(w.stats.titleTexts, ['query: Storm night', 'query: Garden', 'query: Ferry'], 'titles embedded like queries');
    });

    it('the default model is Arctic Embed v2.0 with its own pooled output; e5-small keeps its prefixes', async () => {
        assert.equal(DEFAULT_MODEL, 'Snowflake/snowflake-arctic-embed-m-v2.0');
        const w = fakeWorkerFactory();
        await embedder(w, await tmpDir()).sync(CHUNKS);
        assert.equal(w.stats.init.modelId, DEFAULT_MODEL);
        assert.equal(w.stats.init.pooling, 'sentence_embedding');
        assert.equal(w.stats.init.dtype, 'q8');

        const w2 = fakeWorkerFactory();
        await embedder(w2, await tmpDir(), { modelId: 'Xenova/multilingual-e5-small' }).sync(CHUNKS);
        assert.equal(w2.stats.init.pooling, 'mean');
        assert.ok(w2.stats.passageTexts.every(t => t.startsWith('passage: ')));
        assert.ok(w2.stats.titleTexts.every(t => t.startsWith('query: ')));
    });

    it('each model carries its ambiguous-route cosine gate', () => {
        const e = createEmbedder({ spawnWorker: fakeWorkerFactory().spawn, cacheDir: () => null, log: () => {} });
        assert.equal(e.minCosine, MODEL_PROFILES[DEFAULT_MODEL].minCosine);
        assert.equal(e.minCosine, 0.35);
        const e5 = createEmbedder({ spawnWorker: fakeWorkerFactory().spawn, cacheDir: () => null, log: () => {}, modelId: 'Xenova/multilingual-e5-small' });
        assert.equal(e5.minCosine, 0.85);
    });

    it('sectionTitle drops the file label from the breadcrumb', () => {
        assert.equal(sectionTitle('log › Storm night'), 'Storm night');
        assert.equal(sectionTitle('log › Storm night › Q: What did you do?'), 'Storm night › Q: What did you do?');
        assert.equal(sectionTitle('log'), 'log');
        assert.equal(sectionTitle(''), '');
    });

    it('pieces of one section share a single title vector', async () => {
        const w = fakeWorkerFactory();
        const e = embedder(w, await tmpDir());
        const pieces = [chunk(5, 'log › Storm night', 'Part one.'), chunk(6, 'log › Storm night', 'Part two.')];
        await e.sync(pieces);
        assert.equal(w.stats.passageTexts.length, 2);
        assert.equal(w.stats.titleTexts.length, 1);
        assert.equal(e.isReadyFor(pieces), true);
    });

    it('a pass that stops before the titles are done is not ready (E21)', async () => {
        const w = fakeWorkerFactory({ crashOnTitle: 1 });
        const e = embedder(w, await tmpDir());
        await e.sync(CHUNKS);
        assert.equal(w.stats.passageTexts.length, 3, 'texts go first');
        assert.equal(e.isReadyFor(CHUNKS), false);
    });

    it('a second embedder with the same model reuses the cache file (hit skips work)', async () => {
        const dir = await tmpDir();
        await embedder(fakeWorkerFactory(), dir).sync(CHUNKS);
        const w2 = fakeWorkerFactory();
        const e2 = embedder(w2, dir);
        await e2.sync(CHUNKS);
        assert.equal(w2.stats.passageTexts.length, 0);
        assert.equal(w2.stats.titleTexts.length, 0);
        assert.equal(e2.isReadyFor(CHUNKS), true);
    });

    it('only new or changed chunks are embedded on a later sync', async () => {
        const w = fakeWorkerFactory();
        const e = embedder(w, await tmpDir());
        await e.sync(CHUNKS);
        const changed = [CHUNKS[0], CHUNKS[1], { ...CHUNKS[2], body: 'The ferry ran on time.', hash: 'hash-2-new' }];
        await e.sync(changed);
        assert.equal(w.stats.passageTexts.length, 4);
        assert.equal(w.stats.titleTexts.length, 3, 'the title did not change');
        assert.equal(e.isReadyFor(changed), true);
    });

    it('a model-id change discards the cache', async () => {
        const dir = await tmpDir();
        await embedder(fakeWorkerFactory(), dir).sync(CHUNKS);
        const w2 = fakeWorkerFactory();
        await embedder(w2, dir, { modelId: 'other/model' }).sync(CHUNKS);
        assert.equal(w2.stats.passageTexts.length, 3);
    });

    it('a corrupt cache file is ignored', async () => {
        const dir = await tmpDir();
        await embedder(fakeWorkerFactory(), dir).sync(CHUNKS);
        for (const f of await fsp.readdir(dir)) if (f.endsWith('.json')) await fsp.writeFile(path.join(dir, f), '{oops');
        const w2 = fakeWorkerFactory();
        await embedder(w2, dir).sync(CHUNKS);
        assert.equal(w2.stats.passageTexts.length, 3);
    });

    it('works without a cache directory (in memory only)', async () => {
        const w = fakeWorkerFactory();
        const e = createEmbedder({ spawnWorker: w.spawn, cacheDir: () => null, log: () => {} });
        await e.sync(CHUNKS);
        assert.equal(e.isReadyFor(CHUNKS), true);
    });
});

describe('embedder: vector index', () => {
    it('maps vector rows back to chunk indexes', async () => {
        const e = embedder(fakeWorkerFactory(), await tmpDir());
        await e.sync(CHUNKS);
        const idx = e.indexFor(CHUNKS);
        const hits = idx.search(fakeVector('jardim'), 3);
        assert.equal(hits[0].idx, 1);
        assert.ok(hits[0].score > 0.9);
    });

    it('searchTitles ranks the section titles, mapped back to chunk indexes', async () => {
        const e = embedder(fakeWorkerFactory(), await tmpDir());
        await e.sync(CHUNKS);
        const hits = e.indexFor(CHUNKS).searchTitles(fakeVector('balsa'), 3);
        assert.equal(hits[0].idx, 2);
        assert.equal(hits.length, 3);
    });

    it('covers only the chunks that have vectors while a pass is incomplete', async () => {
        const e = embedder(fakeWorkerFactory(), await tmpDir());
        await e.sync(CHUNKS.slice(0, 2));
        const idx = e.indexFor(CHUNKS);
        assert.deepEqual(idx.search(fakeVector('ferry'), 5).map(h => h.idx).sort(), [0, 1]);
        assert.equal(e.isReadyFor(CHUNKS), false);
    });
});

describe('embedder: query path (FR-009; E19)', () => {
    it('a prefetch started on the gated turn is reused at debounce-fire', async () => {
        const w = fakeWorkerFactory({ delay: 20 });
        const e = embedder(w, await tmpDir());
        await e.sync(CHUNKS);
        const text = 'Tell me about the storm.';
        e.prefetch(text);
        e.prefetch(text);                                   // same text: no second request
        const v = await e.query(text, 500);
        assert.ok(v instanceof Float32Array);
        assert.equal(w.stats.queryTexts.length, 1);
        assert.equal(w.stats.queryTexts[0], `query: ${text}`);
    });

    it('matches the prefetch by normalized text', async () => {
        const w = fakeWorkerFactory();
        const e = embedder(w, await tmpDir());
        await e.sync(CHUNKS);
        e.prefetch('  Tell me   about the storm. ');
        await e.query('Tell me about the storm.', 500);
        assert.equal(w.stats.queryTexts.length, 1);
    });

    it('returns null when the embedding is not ready in time; the late result is ignored (E19)', async () => {
        const w = fakeWorkerFactory({ delay: msg => (msg.kind === 'query' ? 120 : 0) });
        const e = embedder(w, await tmpDir());
        await e.sync(CHUNKS);
        const t0 = Date.now();
        const v = await e.query('storm question', 30);
        assert.equal(v, null);
        assert.ok(Date.now() - t0 < 110, 'did not wait for the late result');
        await sleep(150);                                   // the late result arrives and is dropped quietly
    });

    it('queries jump ahead of a running corpus pass', async () => {
        const many = Array.from({ length: 30 }, (_, i) => chunk(10 + i, `bulk › Item ${i}`, `garden note ${i}`));
        const w = fakeWorkerFactory({ delay: 10 });
        const e = embedder(w, await tmpDir());
        await e.sync(CHUNKS);
        const pass = e.sync(CHUNKS.concat(many));
        await sleep(25);
        const t0 = Date.now();
        const v = await e.query('storm', 200);
        assert.ok(v, 'query answered during the pass');
        assert.ok(Date.now() - t0 < 100);
        await pass;
    });

    it('query and prefetch are no-ops before the worker is ready', async () => {
        const w = fakeWorkerFactory();
        const e = embedder(w, await tmpDir());
        e.prefetch('anything');
        assert.equal(await e.query('anything', 50), null);
        assert.equal(w.stats.spawned, 0, 'the query path never starts the model');
    });
});

describe('embedder: failures (FR-017; E20, E21)', () => {
    it('model load failure → no vectors, null queries, retried on the next sync (E20)', async () => {
        const w = fakeWorkerFactory({ initError: true });
        const e = embedder(w, await tmpDir());
        await e.sync(CHUNKS);
        assert.equal(e.isReadyFor(CHUNKS), false);
        assert.equal(e.indexFor(CHUNKS), null);
        assert.equal(await e.query('storm', 50), null);
        await e.sync(CHUNKS);
        assert.equal(w.stats.spawned, 2, 'a later warm retries the model');
    });

    it('worker crash mid-pass → BM25-only, rows kept, worker restarted on the next sync (E21)', async () => {
        const dir = await tmpDir();
        const w = fakeWorkerFactory({ crashOnPassage: 2 });
        const e = embedder(w, dir);
        await e.sync(CHUNKS);
        assert.equal(e.isReadyFor(CHUNKS), false);
        assert.equal(e.indexFor(CHUNKS), null, 'no query embeddings without a worker');
        assert.equal(await e.query('storm', 50), null);
        const kept = e.vectorCount();
        assert.equal(kept, 1, 'the row embedded before the crash is kept');

        const w2 = fakeWorkerFactory();
        const e2 = createEmbedder({ spawnWorker: w2.spawn, cacheDir: () => dir, log: () => {} });
        await e2.sync(CHUNKS);
        assert.equal(w2.stats.passageTexts.length, 2, 'persisted rows are not re-embedded');
    });

    it('a crash while a query waits resolves it to null', async () => {
        const w = fakeWorkerFactory({ delay: msg => (msg.kind === 'query' ? 50 : 0) });
        const e = embedder(w, await tmpDir());
        await e.sync(CHUNKS);
        const q = e.query('storm', 500);
        await sleep(5);
        w.stats.workers[0].crash();
        assert.equal(await q, null);
        assert.equal(e.indexFor(CHUNKS), null);
    });

    it('a spawn that throws leaves the embedder unavailable, never throwing', async () => {
        const e = createEmbedder({ spawnWorker: () => { throw new Error('no runtime'); }, cacheDir: () => null, log: () => {} });
        await e.sync(CHUNKS);
        assert.equal(e.indexFor(CHUNKS), null);
        assert.equal(await e.query('x', 10), null);
    });
});

describe('career module with an embedder (FR-009, FR-010; E11)', () => {
    async function kbDir() {
        const dir = await tmpDir();
        await fsp.mkdir(path.join(dir, 'notes'), { recursive: true });
        await fsp.writeFile(path.join(dir, 'notes/log.md'), [
            '## Storm night', '', 'The storm knocked out the beacon and I rerouted the ships by radio.', '',
            '## Garden', '', 'The keeper grew tomatoes in the garden behind the tower.',
        ].join('\n'));
        return dir;
    }

    it('reaches ready-hybrid after the pass and uses vectors for a cross-language query (E11)', async () => {
        const dir = await kbDir();
        const w = fakeWorkerFactory();
        const emb = createEmbedder({ spawnWorker: w.spawn, cacheDir: () => path.join(dir, '.cache'), log: () => {} });
        const mod = createCareerModule({ env: { CAREER_KB_PATH: dir }, embedder: emb, log: () => {}, debug: false });
        await mod.warm();
        for (let i = 0; i < 50 && mod.status().state !== 'ready-hybrid'; i++) await sleep(5);
        assert.equal(mod.status().state, 'ready-hybrid');
        assert.equal(mod.status().vectors, 4, 'two texts and two titles');

        // No shared words with the note: only the vector side can find it.
        const ctx = await mod.getCareerContext('Me conta sobre uma vez em que você enfrentou uma tempestade.', { prev: null, activeCompany: null });
        assert.equal(ctx.route, 'personal');
        assert.equal(ctx.timings.vectorUsed, true);
        assert.match(ctx.block, /\[log › Storm night\]/);
    });

    it('drops back to ready-bm25 when the worker dies after the pass (E21)', async () => {
        const dir = await kbDir();
        const w = fakeWorkerFactory();
        const emb = createEmbedder({ spawnWorker: w.spawn, cacheDir: () => null, log: () => {} });
        const mod = createCareerModule({ env: { CAREER_KB_PATH: dir }, embedder: emb, log: () => {}, debug: false });
        await mod.warm();
        for (let i = 0; i < 50 && mod.status().state !== 'ready-hybrid'; i++) await sleep(5);
        assert.equal(mod.status().state, 'ready-hybrid');
        w.stats.workers[0].crash();
        assert.equal(mod.status().state, 'ready-bm25');
        const ctx = await mod.getCareerContext('Tell me about a time you handled a storm.', { prev: null, activeCompany: null });
        assert.equal(ctx.timings.vectorUsed, false);
        await mod.warm();                                   // next warm restarts the worker
        for (let i = 0; i < 50 && mod.status().state !== 'ready-hybrid'; i++) await sleep(5);
        assert.equal(mod.status().state, 'ready-hybrid');
        assert.equal(w.stats.spawned, 2);
    });

    it('CAREER_KB_VECTORS=off keeps the app on BM25 and never creates the model worker', async () => {
        const dir = await kbDir();
        for (const value of ['off', '0', 'false', 'OFF']) {
            const lines = [];
            const mod = createCareerModule({ env: { CAREER_KB_PATH: dir, CAREER_KB_VECTORS: value }, embedder: 'auto', log: l => lines.push(l), debug: true });
            await mod.warm();
            assert.equal(mod.status().state, 'ready-bm25', value);
            assert.ok(lines.some(l => /vectors off \(CAREER_KB_VECTORS\)/.test(l)), value);
            assert.ok(!lines.some(l => /embedder/.test(l)), value);
        }
    });

    it('eval option bm25Only skips vectors', async () => {
        const dir = await kbDir();
        const emb = createEmbedder({ spawnWorker: fakeWorkerFactory().spawn, cacheDir: () => null, log: () => {} });
        const mod = createCareerModule({ env: { CAREER_KB_PATH: dir }, embedder: emb, log: () => {}, debug: false });
        await mod.warm();
        for (let i = 0; i < 50 && mod.status().state !== 'ready-hybrid'; i++) await sleep(5);
        const ctx = await mod.getCareerContext('Tell me about a time you handled a storm.', { prev: null, activeCompany: null }, { bm25Only: true });
        assert.equal(ctx.timings.vectorUsed, false);
    });

    it('stays ready-bm25 when the model cannot load (E20)', async () => {
        const dir = await kbDir();
        const emb = createEmbedder({ spawnWorker: fakeWorkerFactory({ initError: true }).spawn, cacheDir: () => null, log: () => {} });
        const mod = createCareerModule({ env: { CAREER_KB_PATH: dir }, embedder: emb, log: () => {}, debug: false });
        await mod.warm();
        await sleep(30);
        assert.equal(mod.status().state, 'ready-bm25');
        const ctx = await mod.getCareerContext('Tell me about a time you handled a storm.', { prev: null, activeCompany: null });
        assert.equal(ctx.timings.vectorUsed, false);
        assert.match(ctx.block, /Storm night/);
    });
});

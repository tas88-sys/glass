# Spike T024: Embeddings in Electron

**Spec**: `2026-10-11-live-answer-career-context`
**Date**: 2026-10-11
**Decision**: **GO**, with the conditions listed at the end.

> **Later change (T029).** The shipped model is now `Snowflake/snowflake-arctic-embed-m-v2.0`, chosen by the comparison in [research.md R5](./research.md). The worker, packaging and failure conditions below still hold. The e5-small numbers here are the spike's.

The question was whether a small multilingual embedding model can run inside Glass, packaged, fast enough for the answer path and without destabilizing the app. All numbers below come from the target machine (Windows 11, 16 logical cores) and the real KB (78 files, 2,564 chunks). Per spec C5, this document reports numbers only, never note content.

## Setup

| Item | Value |
|------|-------|
| Library | `@huggingface/transformers` **4.2.0** (pinned exact). It uses the root `sharp` 0.34.5, so there is no second copy. 4.3.x would pull `sharp` 0.35 |
| Native runtime | `onnxruntime-node` 1.24.3 (N-API, so independent of Electron's ABI) |
| Model | `Xenova/multilingual-e5-small`, int8 (`dtype: 'q8'`), 384 dims, `query:` / `passage:` prefixes |
| Electron / Node | 30.5.1 / 20.16.0 |

## Measurements

### Load and latency

| Measure | Result | Target |
|---------|--------|--------|
| Model load, cached | 1.1 s (Node 24), 1.7 s (Electron worker), 1.2 s (packaged binary) | — |
| First run | Downloads ~120 MB into the cache directory | — |
| Query embedding, warm | p50 7.8 ms, p95 14 ms (16 threads); p50 5.2 ms, p95 6.4 ms (4 threads, no other load) | ≤ 50 ms |
| Query embedding, in the eval run | p95 25 ms | ≤ 800 ms (SC-004) |
| Wait at debounce-fire, prefetched | p50 0.1 ms, max 0.5 ms | ≤ 150 ms |
| Wait at debounce-fire, cold (no prefetch) | p50 7.9 ms, max 9.7 ms | ≤ 150 ms |
| Answer path p95 (route + BM25 + vectors + fusion + packing) | 13.6 ms | ≤ 20 ms (SC-004) |

### Corpus pass

| Configuration | Time per passage | 2,564 chunks |
|---------------|------------------|--------------|
| Batch 1, 16 threads | 70 ms | 179 s |
| Batch 8 | slower (padding) | — |
| Electron utilityProcess, 4 threads (the shipped setting) | ~93 ms | 239 s |

The pass is a one-time cost: vectors are cached by content hash and model id (3.9 MB on disk). Later passes embed only changed chunks.

### Where the worker runs

| Host | Model load | Query p50 / max | Process RSS |
|------|------------|-----------------|-------------|
| `worker_threads` (inside the main process) | 1.7 s | 20 / 31 ms | 403 MB, added to the main process |
| Electron `utilityProcess` | 1.7 s | 9.5 / 29 ms | 389 MB, a separate process |

These numbers were taken while another embedding run was competing for CPU.

**Chosen: `utilityProcess`.** A native crash in the ONNX runtime cannot take down the app. The main process stays at ~115 MB, measured with the embedder running. Plain Node (the eval script) uses `worker_threads` with the same worker body.

### Memory (embedder process)

| ORT CPU arena | After load | Peak | Passage time |
|---------------|-----------|------|--------------|
| On | 466 MB | 599 MB | 144 ms |
| Off (`enableCpuMemArena: false`, `enableMemPattern: false`) | 447 MB | 515 MB | 170 ms |

**Chosen: arena off.** It saves ~85 MB for the life of the session; the passage cost is background work. In the unpackaged Electron run (arena on), the utility process reached a working set of 687 MB.

### Packaging

The test was an unsigned `electron-builder --win --x64 --dir` build with the repo's `electron-builder.yml`.

| Check | Result |
|-------|--------|
| `asarUnpack: "**/node_modules/onnxruntime-node/**/*"` | Native binding loads from `app.asar.unpacked` |
| transformers.js required from inside `app.asar` (packaged `Glass.exe`, `ELECTRON_RUN_AS_NODE=1`) | Loads; model 1.2 s, first query 25 ms |
| `utilityProcess.fork` of `embedWorker.js` from inside the packaged `app.asar` | Works; vectors arrive as `Float32Array` (structured clone keeps the type) |
| `onnxruntime-web` (130 MB of wasm, unused under Node) | Excluded by a `files` pattern; 0 entries in the asar |
| Other platforms' ONNX binaries | Excluded per platform. Windows ships `win32/x64` only (59.3 MB) |
| Size added | ~70 MB uncompressed (59.3 MB native + ~10 MB JS) on a 660 MB app, +10.6%. The NSIS installer compresses it further |

The runtime ships Apple Silicon only. On Intel Macs the embedder fails to load, and career retrieval stays BM25-only (E20).

### Retrieval quality

The eval (`scripts/eval-career-kb.js`) runs on the 100-item set, leave-source-out, with strict gold labels:

| Mode | recall@3 | Injected recall |
|------|----------|-----------------|
| BM25 only | 24% | 24% |
| Hybrid (BM25 + e5-small, RRF) | 28% | 30% |

- **Vectors alone.** On a full-corpus pass, 11 of 40 personal items had a gold note in the top 3.
- **Hybrid** adds 4–6 points over BM25. The main gain is on Portuguese questions whose answer note is in English, where BM25 shares no terms.
- **Strict gold understates both modes.** It names one or two notes per question, and the KB answers many questions in several places. For example, a prepared Q&A that answers the question verbatim counts as a miss when it is not the labeled note. See the T027 evidence in `tasks.json`.

### Cosine threshold (FR-012)

| Top-1 cosine | p10 | p50 | p90 |
|--------------|-----|-----|-----|
| Personal | 0.858 | 0.876 | 0.894 |
| Ambiguous | 0.868 | 0.885 | 0.917 |
| General | 0.857 | 0.874 | 0.901 |
| The labeled relevant note | 0.829 | 0.857 | 0.882 |

The top-1 cosine does not separate routes: technical questions also find close notes in the KB's study banks. The provisional `minCosine` is **0.85**, near where relevant notes sit. An ambiguous turn then injects when its best match is about as close as a typical relevant note. Calibrating it properly needs ambiguous items labeled "should inject / should not" (T027).

## Decision and conditions

**GO.** Every criterion in research R5 passes:
- the model loads in the packaged app;
- queries take ≤ 50 ms;
- the full pass is a one-time background cost of minutes;
- asar unpacking works;
- installer growth is about +70 MB uncompressed.

The vector layer ships with these conditions:

1. **Worker.** Electron `utilityProcess` with 4 intra-op threads at most and the CPU arena off. Under plain Node, a `worker_thread` (eval script).
2. **Laziness.** The model runtime is required only inside the worker; the main process never loads it (C4).
3. **Kill switch.** `CAREER_KB_VECTORS=off` keeps the app on BM25 and never starts the worker. This saves ~0.5 GB of RAM during calls on machines where that matters.
4. **Packaging.** Pinned `@huggingface/transformers@4.2.0`. `asarUnpack` covers `onnxruntime-node`; `files` excludes `onnxruntime-web` and other platforms' binaries.
5. **Failure.** No model (offline first run, Intel Mac, load error) or a crashed worker means BM25-only. The next warm retries.

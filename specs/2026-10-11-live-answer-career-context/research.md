# Phase 0 Research: Live Answer Career Context

**Spec**: `2026-10-11-live-answer-career-context`
**Date**: 2026-10-11

All findings come from reading in-repo source, running local checks on the target machine, and reading the user's career notes (KB). Per spec C5, this public document describes the KB's *shape* only, never its content.

---

## R1: Where does career context enter the prompt?

**Decision**: Through the existing `customPrompt` argument of `getSystemPrompt`.

**Evidence**:
- `src/features/common/prompts/promptBuilder.js` builds `intro + formatRequirements + content + "User-provided context\n-----\n" + customPrompt + "\n-----\n" + outputInstructions`.
- The `pickle_glass_analysis` profile's `content` says: "User-provided context (defer to this information over your general knowledge …) Make sure to reference context fully if it is provided".
- `makeLiveAnswer` passes `''` (`summaryService.js:326`). So does the Live Insights lane (`:666`), which stays unchanged (C7).
- The original Live Answer spec already listed this as "v2 — Personalized answers: wire the candidate's résumé/bio into the prompt's currently-empty `customPrompt` slot" (`specs/2026-05-30-interview-live-answer/spec.md`, Out of Scope).

**Consequence**: no change to `promptTemplates.js`. The only prompt change is an addendum to the user message, sent only when context is injected.

---

## R2: SQLite FTS5 or a pure-JS index?

**Decision**: Pure-JS BM25.

**Evidence** (run 2026-10-10 on the target machine):
- FTS5 is available in the bundled `better-sqlite3` under Electron (`ELECTRON_RUN_AS_NODE=1 electron -e …`): SQLite 3.53.2, `tokenize='unicode61 remove_diacritics 2'` matches an unaccented query against an accented word.
- The same module does **not** load under `npm test` (plain Node 24): `NODE_MODULE_VERSION 123 … requires NODE_MODULE_VERSION 137`. `postinstall` runs `electron-builder install-app-deps`, which builds native modules for Electron's ABI.
- The existing tests (`liveAnswer.test.js`) only cover pure helpers for this reason.

**Consequence**: An FTS5 retriever could not be unit-tested by the existing runner. The corpus is small (see R3), so a pure-JS inverted index is a few hundred lines and fast enough.

**Alternatives considered**: FTS5 with tests run via `ELECTRON_RUN_AS_NODE=1 electron --test`. Rejected because it splits the test runner and couples the core to a native module.

---

## R3: Is lexical retrieval enough for this corpus?

**Decision**: No. Hybrid lexical + semantic.

**Evidence** (KB shape):
- About 200 files, ~3 MB of text. After excluding noise (raw AI chat exports, unrelated guides, code), on the order of 2 MB, roughly 2–4k chunks.
- **Bilingual.** The Q&A banks hold English `**Q:**` lines and English spoken answers under Portuguese headings (378 Q-blocks). Many notes are in Portuguese, and some interviews are held in Portuguese.
- **Paraphrase.** Behavioral questions are asked in many wordings ("a time you clashed with a stakeholder" vs a note titled with the Portuguese for "conflict and divergent opinions"). BM25 only scores shared terms.

**Why keep BM25**: exact identifiers (vendor names, tool names such as `pprof` or `KEDA`, project names) are where embeddings blur and BM25 is precise. Reciprocal rank fusion (RRF, k = 60) merges the two rankings without score calibration.

**Rejected**: hand-maintained bilingual synonym groups as the only cross-language bridge. They were the first proposal's stopgap; a multilingual embedding model does this generally.

---

## R4: Vector database (e.g. Chroma)?

**Decision**: No vector database. Vectors live in memory, are compared by brute-force cosine and cached on disk.

**Rationale**:
- **Scale.** 2–4k vectors × 384 dims is a few MB of floats. A full cosine scan is about 1 ms in JS. ANN indexes pay off at millions of vectors.
- **Chroma specifically.**
  - It does not chunk; the markdown chunker is needed either way.
  - Its default embedding function is English-only (all-MiniLM-L6-v2).
  - From Node, the client talks to a separate Chroma server process that Glass would have to ship and supervise next to Electron.
- **Persistence.** It only needs a cache keyed by content hash and model id, so unchanged notes are never re-embedded.

---

## R5: Where does the embedding model run?

**Decision**: In-process with transformers.js (`@huggingface/transformers`), running a small multilingual model (candidate: `multilingual-e5-small`, quantized, 384 dims, ~120 MB). It runs in a worker (`worker_threads` or Electron `utilityProcess`, picked by the spike).

**Evidence / rationale**:
- **Ollama is not installed** on the target machine (`ollama` not on PATH, no `%LOCALAPPDATA%\Programs\Ollama`). Glass can install it (`ollamaService.autoInstall`), but it would be a separate service to keep running during calls.
- transformers.js runs ONNX models through `onnxruntime-node`, a native N-API module.
  - **Packaging precedent:** `electron-builder.yml` already unpacks `sharp` from asar (`asarUnpack: "**/node_modules/sharp/**/*"`), so the same treatment applies.
- **Worker:** inference is CPU-bound, so it must stay off the main process event loop, which also runs IPC and STT.
- **e5 prefixes:** e5 models expect `query:` and `passage:` prefixes.

**Spike (T024) must confirm, inside the packaged app, before T025/T026**:
- the model loads;
- per-query latency, target ≤ 50 ms;
- full-corpus indexing time;
- asar unpacking works;
- installer growth is acceptable.

The library version is pinned at that point.

**No-go path**: ship BM25-only (T010–T023 stand alone). Revisit Ollama embeddings if the user installs Ollama.

---

## R6: Intent routing

**Decision**: A deterministic cue router with four routes (`personal`, `company`, `ambiguous`, `general`) plus follow-up stickiness. It lives in its own module.

**Rationale**:
- **An LLM classifier is rejected.** It adds a full round trip (seconds) and doubles quota use on Live Answer's latency- and quota-bound path, where Gemini 503s already hurt (see `docs/GEMINI_503_PEAK_HOURS.md`).
- **Cues are explainable.** The debug log names the cue that fired, and cue tables are unit-testable.
- **Misses are bounded:**
  - `ambiguous` still retrieves and injects above a threshold;
  - the LLM still sees the whole conversation;
  - the addendum restricts first-person framing to questions about the candidate.
- **Gate widening.** `isLikelyQuestion` (`summaryService.js:58`) documents a by-design gap for cue-less statement prompts ("your biggest weakness"). Career cues close most of it (FR-007).
- **Future.** A semantic fallback for `ambiguous` (nearest prepared Q-line) can be added behind the same `{ route, cue }` contract without touching callers.

---

## R7: Company-specific notes

**Decision**: Index per-company prep folders, tag chunks with their company, and scope only company-directed questions.

**Evidence**:
- **Most company prep answers are generic.** In one company's HR prep, the Q-blocks are: introduce yourself, an end-to-end project owned, success criteria, quality practices and AI usage. All of those are reusable anywhere.
- **The company-bound parts are few:** "why us", product knowledge and job-description matching.
- **Risk:** without scoping, "why do you want to join us?" could retrieve another company's "why us" answer and put that company's name on screen.

**Mechanism**:
- The `company` route drops chunks tagged with another company. Untagged, generic chunks stay.
- Tags are sets of company names, because one folder can hold several companies' prep and one company's prep can sit in several folders. Aliases map folders to the names interviewers actually say.
- The active company comes from `CAREER_KB_COMPANY` or is detected from `them` turns.
- The addendum forbids presenting a company named in the notes as the interviewer's company.

---

## R8: Inconsistent facts across notes

**Decision**: A generated canonical-facts card, injected on personal and company routes, that overrides the other notes.

**Evidence**:
- The candidate's years of experience appear with **three different values** across at least five files, written months apart.
- Years with the primary language appear with **two values**.
- Retrieval picks whichever fragment scores best, so two answers in the same call could state different numbers.

**Mechanism**:
- Claude generates the card from the notes and lists every conflict.
- The user decides each conflict once.
- Newer files win score ties (filename dates, then mtime).
- Unfinished markers (`[PREENCHER`, `⚠️ CONFIRMAR`) are never injected.

---

## R9: Evaluation set

**Decision**: Build it from questions that real interviewers asked, as recorded in the KB. Claude labels them and the user reviews. It is stored in the KB repo (`glass-eval/questions.jsonl`), never here (C5).

**Sources available in the KB** (counts are rough upper bounds of `?` occurrences, before dedupe):
- **A recalled question list** from one behavioral round: 13 questions. The candidate's debrief also summarizes which story was used for each, which gives the gold label directly.
- **Debriefs** of a technical round (~80) and a cultural round (~20).
- **Raw transcripts** of a recruiter conversation (~60, Portuguese) and a leadership round (~7).
- **Written screening forms** from three companies (~60 combined).
- **Portuguese questions** from an AI-led screening.

After dedupe that is about 100–150 distinct questions, from which 60–100 are kept, balanced across routes and languages. General (non-personal) items come from the technical debriefs.

**Not used as retrieval queries**: the 378 prepared `**Q:**` lines, most of them in the shared study bank. They match their own chunk titles word for word, so they would inflate recall and hide whether the semantic layer adds anything. They play two other roles:
- they are the retrieval targets (gold notes);
- they may be used to test the **router**, which never reads the notes, so it gets no copy advantage from them.

Reworded or translated variants written by Claude may be added later as a separate, clearly labeled synthetic split.

**Labels per item**:
- `route`;
- `gold` notes as `{ path, anchor }`, for personal items;
- `company`, for company items;
- `lang`.

---

## R10: Latency budget

**Evidence**:
- STT closes a turn after 2 s of silence. The Live Answer debounce adds 800 ms (`triggerAnswerIfNeeded`, `:513`).
- Time to first token on Gemini Flash is typically seconds.

**Decision**:
- Start the query embedding when a gated `them` turn arrives (`prefetch`), so it completes inside the 800 ms window.
- At debounce-fire, BM25 (≤ 5 ms) runs synchronously and the prefetched vector is awaited for at most 150 ms.
- Expected added time on the answer path is ≤ 20 ms at p95.
- The extra prompt (≤ 6,000 characters, about 1.5–2k tokens) has negligible effect on time to first token for Flash-class models.

---

## R11: Runtime constraints

- **Node version:** Electron 30 runs Node 20.16 (`ELECTRON_RUN_AS_NODE=1 electron -e "process.versions.node"` prints `20.16.0`). `fs.glob` (Node 22) is unavailable, so a small glob-to-regex helper covers `*`, `**` and `?`.
- **Env loading:** `src/index.js:8` loads `.env` via dotenv, so `CAREER_KB_PATH` and `CAREER_KB_COMPANY` work like the existing `LIVE_ANSWER_DEBUG` and `GEMINI_*` variables.
- **Hooks:** the app-start hook is `app.whenReady()` (`src/index.js:172`); the session-start hook is `listenService.initializeSession` (`src/features/listen/listenService.js:157`).

---

## Summary of Decisions

| ID | Decision | Confidence |
|----|----------|-----------|
| R1 | Inject via `customPrompt`; addendum only when injected | High (source-verified) |
| R2 | Pure-JS BM25, not FTS5 | High (ABI error reproduced) |
| R3 | Hybrid lexical + semantic | High (corpus shape) |
| R4 | No vector DB; brute-force cosine + hash-keyed cache | High |
| R5 | transformers.js + small multilingual model in a worker, behind a spike | Medium (spike confirms) |
| R6 | Deterministic cue router, own module, four routes | High |
| R7 | Company folders in, company-route scoping | High |
| R8 | Generated canonical card overrides notes | High (conflicts found) |
| R9 | Eval from real interviewer questions, stored in the KB repo | High |
| R10 | Prefetch during debounce; 150 ms cap | Medium (measured in T027) |
| R11 | Node 20 constraints; dotenv; app and session hooks | High |

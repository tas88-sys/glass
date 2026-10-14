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

**Outcome (2026-10-11): GO.** See [spike-embeddings.md](./spike-embeddings.md). The worker is an Electron `utilityProcess`. Library pinned at 4.2.0. Query embedding p50 ~8 ms. First full pass ~4 min, cached afterwards. +~70 MB uncompressed in the package; ~0.5 GB RAM in the model process, so `CAREER_KB_VECTORS=off` exists.

**Update (2026-10-11, T029): model and ranking replaced.** With the widened gold labels, hybrid injected recall was 47.2% against the 85% target (SC-002). The first gold note sat in the fused top 20 for only 66% of items, so a bigger block alone could not close the gap; ranking had to improve. Candidates were scored offline on the full eval set: 53 personal items with a retrievable note, leave-source-out, each passage embedded one at a time as the app does. Every column is the same scorer; e5-small's first row reproduces the module's 47.2%.

| Injected recall | e5-small | e5-base | gte-multilingual-base | arctic-embed-m-v2.0 |
|-----------------|----------|---------|-----------------------|---------------------|
| Fusion as shipped (BM25 + text vectors, top 4, 6,000 chars) | 47.2% | 50.9% | 50.9% | 54.7% |
| Text vectors alone | 32.1% | 43.4% | 56.6% | 56.6% |
| + section-title vectors as a third ranking, one section per file | 50.9% | 54.7% | 62.3% | 60.4% |
| + top 6 within 9,000 characters | 54.7% | 66.0% | 73.6% | 75.5% |

| Cost on the target machine (q8, 4 threads, idle) | e5-small | e5-base | gte-multilingual-base | arctic-embed-m-v2.0 |
|---|---|---|---|---|
| Download | 118 MB | 279 MB | 340 MB | 311 MB |
| Process RSS after load | ~0.5 GB | ~0.67 GB | ~0.73 GB | ~0.70 GB |
| Query embedding p50 / p95 | 7 / 10 ms | 28 / 51 ms | 24 / 34 ms | 26 / 49 ms |

Why each change helps:
- **A stronger model.** Most remaining misses were Portuguese questions whose best note is in English. e5-small matches across languages poorly (text vectors alone: 32%); the two newer models reach 57%.
- **Section-title vectors.** The notes are mostly "question → answer" sections. Matching the interviewer's question against each section heading (embedded like a query) finds them better than matching against the whole body.
- **One section per file.** Answer banks have many near-duplicate sections; without a cap they fill the block with one file.
- **Top 6 within 9,000 characters.** About three notes fit after the card at 6,000 characters. The extra ~3,000 characters (~750 tokens) are negligible next to the transcript.

Rejected:
- **Cross-encoder reranking** of the top 40 (`cross-encoder/mmarco-mMiniLMv2-L12-H384-v1`, 119 MB). Recall fell to 43.4%, at ~12 s per question under load. The strong multilingual reranker (`bge-reranker-v2-m3`, 571 MB) is far too slow on CPU for the 800 ms debounce.
- **Translating Portuguese questions to English** before searching (`Xenova/opus-mt-ROMANCE-en`, 113 MB, 0.3–0.8 s per question). It adds +3.7 points on Arctic (79.2%) and nothing on gte: not worth a second model and that latency. English to Portuguese with `opus-mt-en-ROMANCE` produced French or Spanish.
- **EmbeddingGemma-300m.** 0.3 s per query and 1.6 GB RSS on this CPU; dropped before scoring.
- **Smaller knobs** (query without framing words, list weights, RRF k, deeper lists, skipping research and outreach notes): within ±2 items, which is noise here.

**Decision**: `Snowflake/snowflake-arctic-embed-m-v2.0` (Apache-2.0, 768 dims, `query: ` prefix on queries only, the model's own pooled output), section-title vectors, one section per file, top 6 within 9,000 characters. gte scored within one item of it, but Arctic indexes about 40% faster on this machine. The FR-012 gate moves to **0.35**, the same position on Arctic's gold-note cosine distribution (about the 23rd percentile) as 0.85 on e5-small. e5-small stays as a model profile, with its own gate.

**Caveats.**
- One item is ±1.9 points, and the holdout has 6 personal items, so differences under about 4 points are noise.
- The metric undercounts. A manual audit of e5-small's 28 misses found about 10 where an injected note did answer the question but was not a labeled gold note.

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

> **Update 2026-10-13:** Jev (a decision model, not a generative LLM) now routes turns, and this cue router is its frozen fallback. See R18 in [`../2026-10-13-career-router-jev/research.md`](../2026-10-13-career-router-jev/research.md).

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

**Decision**: A generated canonical-facts card, injected whenever context is injected (personal, company, and ambiguous above threshold), that overrides the other notes.

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

**Judging:** success criteria use the full set. The 20% holdout (12 personal, 2 company items) is far too small to pass or fail on, so it only flags overfitting (FR-019).

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
- The extra prompt (≤ 9,000 characters, about 2.5–3k tokens) has negligible effect on time to first token for Flash-class models.

---

## R11: Runtime constraints

- **Node version:** Electron 30 runs Node 20.16 (`ELECTRON_RUN_AS_NODE=1 electron -e "process.versions.node"` prints `20.16.0`). `fs.glob` (Node 22) is unavailable, so a small glob-to-regex helper covers `*`, `**` and `?`.
- **Env loading:** `src/index.js:8` loads `.env` via dotenv, so `CAREER_KB_PATH` and `CAREER_KB_COMPANY` work like the existing `LIVE_ANSWER_DEBUG` and `GEMINI_*` variables.
- **Hooks:** the app-start hook is `app.whenReady()` (`src/index.js:172`); the session-start hook is `listenService.initializeSession` (`src/features/listen/listenService.js:157`).

---

## R12: Chunking

**Question** (T030): are the chunk rules right for this corpus? One chunk per heading section or `**Q:` block, 300–1,200 characters, long sections split on paragraphs.

**Evidence** (after T029, hybrid, full eval set):
- Of the 303 non-card chunks injected for the 53 personal items, 11 were near-empty (under 100 characters), 14 were tables and 8 came from heading-less files.
- **Near-empty chunks** were mostly a heading's one-line intro above its subsections, such as a timing note above a prepared answer. They matched through the title and carried no story. The corpus had 46 chunks under 100 characters.
- **Tables:** 5 of the 14 were gold, all from a skills inventory with one small table per section. The other 9 came from 8 different prep and research tables. A split table lost its header row after the first piece.
- **Heading-less files:** none of the 8 was gold, and 6 were one file: an interview platform's written feedback, which lists the topics those questions ask about. Excluding that file changed no result.
- **One section filling several slots** was already fixed by one section per file (T029).

| Variant (Arctic, top 6, 9,000 chars) | Injected recall | recall@3 |
|---|---|---|
| As shipped in T029 | 73.6% | 62.3% |
| Short intros moved into their subsection, table headers repeated | 75.5% | 60.4% |
| Same, 800-character cap | 71.7% | 64.2% |
| Same, 1,600-character cap (embedding input raised to 2,000) | 69.8% | 58.5% |
| Same as the second row, plus the feedback file excluded | 75.5% | 60.4% |

Re-indexing for a new cap took 7–11 minutes: section-title vectors are reused, chunk-text vectors are not.

**Decision**:
- A body under 300 characters that is followed by its own subsection moves into that subsection. A short section with no subsection under it stays, since many are real short answers. Chunks under 100 characters: 46 → 22.
- A split table repeats its header row, and any caption line right above it, in each piece.
- The 1,200-character cap stays. Both other caps lost injected recall.
- Heading-less files and notes that only list interview topics are a content matter: a heading or a manifest `exclude` entry fixes them, and the chunker does not guess.

**Caveat**: every difference here is within two items (±3.8 points), under the noise level in R5. The two rule changes are kept because they remove chunks that cannot help an answer and keep split tables readable, not because of the score.

---

## R13: Checking retrieval by hand

**Question** (T033): how can the candidate see which notes Live Answer would use for a given question?
Nothing showed it before:
- the eval prints ids and counts only, because its output goes into PRs of this public repo (C5);
- the debug log carries chunk ids, never note text (FR-018);
- the "from:" line shows the notes only in the running app, one interview question at a time.

**Decision**: `scripts/ask-career-kb.js`, created on 2026-10-11 at the candidate's request.
- It runs a question through the same module calls as the app: route, BM25, text and title
  vectors, one section per file, the block.
- It prints the route, the ranked sections with their place in each ranking, and what is sent;
  `--block` prints the exact text.
- Questions typed or piped one per line keep the follow-up state the way `summaryService` does.
- Its output contains note titles and text, so it stays in the local terminal.
- It and the eval read `.env` and default to the app's vector cache (`userData/career-kb`), so
  neither embeds the notes again.
- The module's eval trace takes an optional `k` to list more of the ranking; the block does not change.

**Rejected**:
- Titles in the eval output: that output is shared in PRs (C5).
- Titles in the debug log: FR-018 keeps note text out of the console.

**Findings from its first use**:
- **Routing gap, fixed in T034.** "What was your biggest project?" routed `general`, so no notes,
  while "What was the biggest project you worked on?" routed `personal`. Two cue changes fix it:
  - a past-tense cue, `background:what-was-your` ("what was/were your", "what has been your");
  - "project(s)" added to `background:your-trait` ("your biggest project").

  Present "what is your …" stays out, because it is often an opinion ("your approach"), which
  the ambiguous route handles. The eval is unchanged: 0 general items routed personal, personal
  routing 96.6%.
- **Follow-up retrieval, fixed in T035.** After a disagreement question, "And what was the
  outcome?" kept the personal route (cue `follow-up`), but only its keyword query carried the
  previous question. Its vector query was the follow-up alone, so unrelated "what happened"
  sections ranked first and the block lost the first answer's story.
  - **Fix:** the vector query, and its prefetch, is the previous question (its last 600
    characters) then the follow-up. The original question stays the anchor through a chain of
    follow-ups. Detection is unchanged: the 5-minute window, at most 10 words, a marker phrase.
  - **Checked on 8 question and follow-up pairs** (English and Portuguese) against the real
    notes:

    | Measure | Before | After |
    |---|---|---|
    | The first answer's sections still sent, on average | 15% | 77% |
    | Its top section still sent | 4 of 8 | 7 of 8 |

  - **Cost:** a 600-character anchor takes about 190 ms to embed (17 ms for the follow-up
    alone), well inside the 800 ms debounce the prefetch runs in.
  - The eval has no follow-ups, so its results are unchanged.

---

## R14: The ambiguous gate checked only the first section

**Question** (T037, from a review of the eval's misses): why did an ambiguous turn send nothing
when a close note was among the sections it would send?

**Finding.** The FR-012 gate looked only at the first fused section, which failed in two ways:
- The first section reached the top on its keyword and title ranks alone. With no text-vector
  rank it had no cosine, so the gate refused.
- The first section's cosine was under the threshold while a later one's was above it. In one
  eval item the candidate's prepared answer to that exact question ranked second at 0.447,
  behind a section at 0.304.

**Decision.** The gate passes when any section about to be sent clears it (cosine with vectors,
coverage in BM25-only mode). Which sections are sent does not change, only whether they are.

**Result** (full eval):

| Measure | Before | After |
|---|---|---|
| Hybrid injected recall (53 personal items) | 75.5% | 77.4% |
| BM25-only injected recall | 45.3% | 45.3% |
| Eval turns routed ambiguous that get notes | 11 of 13 | 13 of 13 |

- Routing, recall@3 and latency are unchanged.
- The overfit check now flags. The item gained is in the tuning split; the holdout's 6 personal
  items are unchanged (4 of 6), so the gap went from 9.9 to 12 points. One holdout item is worth
  16.7 points, so this is noise: the change fixes a rule and is not fitted to an item.
- At 0.35 the gate now blocks none of the eval's ambiguous turns, since the study banks hold a
  close section for most technical questions. Calibrating it with turns labeled "should inject"
  or "should not" stays open (T027).

## R15: The same question found different notes in Portuguese and English

**Question** (T038, from a check by hand): "Tell me about a time you disagreed with a teammate"
sent six sections on the theme. Its Portuguese version sent four, with the best one third. Why?

**Finding.**
- Most notes on the theme are titled in English. The Portuguese words reached them only through
  the vectors, which are less sure across languages (cosine 0.45 against 0.62 in English).
- "precisou" ("had to") was not a stopword. It ranked first a note that shared only that word.
- The stemmer did not join Portuguese verb forms: "discordei" and "discordou" never met
  "discordar".

**Decision.**
- Notes repo: a Portuguese translation, in parentheses, beside each English question title in
  the two study banks (118 titles). The English text stays, so eval anchors still match.
- Code: Portuguese "had to" (precisou, tive and their inflections) joins the stopwords. The
  stemmer cuts Portuguese past tense, imperfect, gerund and participle endings to the infinitive
  stem, each with a minimum stem length so short words stay whole ("java", "cada"). Over the
  notes' vocabulary this joins 72 groups of words; the few loose pairs ("parte", "partida") are
  harmless at this size.

**Result** (full eval, each change alone and both):

| Measure | Before | Titles only | Code only | Both |
|---|---|---|---|---|
| Hybrid injected recall (53 personal items) | 84.9% | 84.9% | 84.9% | 86.8% |
| Portuguese items (40) | 80.0% | 80.0% | 80.0% | 82.5% |
| BM25-only injected recall | 50.9% | 50.9% | 52.8% | 54.7% |

- "Before" is today's notes. R14's 77.4% rose to 84.9% through edits in the notes repo
  (Portuguese beside English headings, "not used" lines in the skills note, a few facts).
- The code alone swaps one item for another; with both, no item is lost. Routing and latency are
  unchanged, and the overfit check no longer flags (gap 3.9 points).
- On the original question the best section moves from third to first, as in English.
- Translating the question to English as an extra query (above, under R5) was re-measured on
  today's notes: net zero (two items gained, two lost), and 0.7 s typical, 1.3 s at p95 before
  the search can start. Not adopted.

## R16: English questions about the candidate routed general

**Question** (T039, from R15): R15 compared Portuguese questions with English ones. How do the
eval's Portuguese questions do when asked in English?

**Finding.** The 40 Portuguese personal items, translated to English by hand (machine
translations were too poor to judge): 47.5% sent the right note, against 82.5% in Portuguese.
16 of the 40 routed general and got no notes. The router had Portuguese cues for present-tense and
job questions ("Trabalha remoto?", "Está participando de outros processos?", "Qual o motivo pra
você querer mudar?") and no English twins. Of 30 everyday English questions written for this
check, 23 routed general.

**Decision.** English twins of those cues: present-tense job verbs ("do you work, lead,
speak…", "the team you work with", "report to you"); "are you interviewing, open, working…";
"how long have you"; "your manager, peers, colleagues"; the reason to change jobs; the start date
after an offer; "where you'd do well" and "anything we haven't covered"; "do you have an example".
Three phrasings that also open technical prompts route ambiguous instead: "Give an example." at
the end of a turn, "your team", and "which … do you use". "How do you raise, grow, coach…" joins
the habitual verbs.

**Result.**

| Check | Before | After |
|---|---|---|
| English versions of the 40 Portuguese items: right note sent | 47.5% (19/40) | 77.5% (31/40) |
| The same 40: routed general, no notes | 16 | 3 |
| 30 everyday English questions, written while making the cues: routed personal | 6 | 30 |
| 24 more, written after the cues and not used to tune them: routed personal | 5 | 17 |
| 25 technical or meeting turns written to trip the new cues: routed personal | 0 | 0 |
| 267 study-bank question titles routed personal (all ask about the candidate) | 22 | 22, the same ones |
| Eval: personal routed personal, general routed personal, injected recall | 96.6%, 0%, 86.8% | unchanged |

- The 25 technical turns first sent 3 to personal. The three cues above moved to the ambiguous
  route or were narrowed, and the turns are now unit tests.
- The 7 held-out questions that still route general show what is left: "What's pushing you to
  look for something new?", "When could you join if we made an offer?", "Do you mentor junior
  developers?". They were not tuned on, so the 17 of 24 stays a fair figure.
- The eval asks each item in its own language, so its numbers do not move. R15's script with the
  hand translations measures this.

## R17: Questions about the main stories that routed general

**Question** (T040): once the notes repo's story file had an English line in each story, which
questions about those stories still got none of them?

**Finding.** 27 natural questions about seven stories, in English and Portuguese, written before
measuring. 22 got the story through some note (the pitch, the study banks, the prep notes). The
5 that did not all routed general: "have you set up", "do you deliver", "your workflow",
"tell me about a migration…" and "conte sobre um lançamento que deu certo".

**Decision.**
- More experience verbs after "have you" (set up, adopted, automated, maintained, integrated,
  launched, contributed, coached, hired, interviewed, taught, trained, supported, architected,
  standardized) and after "do you" (deliver, ship, mentor). Verbs common in live-coding talk
  stay out ("Have you set the timeout?", "Do you test this function?").
- "Your workflow, routine, tooling, stack" (not "stack trace").
- A request about something that happened is personal: "Tell me about a launch that went well",
  "Fale sobre uma entrega que atrasou".
- Any other "tell me about a …" or "fale sobre um …" is ambiguous: notes only when one is close.
  "Tell me about the CAP theorem" stays general.

**Result.**

| Check | Before | After |
|---|---|---|
| 27 story questions: the story in what is sent | 22 | 27 |
| 10 new questions about the candidate, written before measuring: routed personal | 3 | 10 |
| 10 new technical or live-coding turns: routed personal | 2 | 2, the same two |
| R16's held-out sets: about the candidate / technical, routed personal | 17 of 24 / 0 of 25 | 18 of 24 / 0 of 25 |
| Study-bank question titles routed personal | 22 | 23 |
| Eval: routing, general routed personal, injected recall | 96.6%, 0%, 86.8% | unchanged |

- The 27 story questions found these gaps, so their 27 is not a fair figure; the 10 written
  before measuring are.
- R16's held-out "Do you mentor junior developers?" now routes personal through a verb added
  after seeing it, so the fair figure there stays 17 of 24.
- The new study-bank title routed personal asks about the candidate's own workflow.
- The two technical turns still routed personal ("Conte sobre uma estrutura de dados que você
  conhece", "Have you created the index on that column?") come from older cues ("você conhece",
  "you created"). Live-coding talk that reuses experience verbs stays open.

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
| R12 | Keep 1,200-character chunks; merge short intros into their subsection; repeat table headers | Medium (eval within noise) |
| R13 | A local ask script to check retrieval by hand; shares the app's vector cache | High |
| R14 | The ambiguous gate passes when any section about to be sent clears it | High (eval) |
| R15 | Portuguese "had to" is a stopword; Portuguese verb forms share the infinitive stem | Medium (eval +1 item, BM25-only +3.8 pts) |
| R16 | English twins of the Portuguese present-tense and job cues; three that open technical prompts route ambiguous | High (held-out checks) |
| R17 | More experience verbs; past-event requests personal; other "tell me about a …" ambiguous | Medium (held-out checks of 10 and 10) |

---
# Context Optimization Metadata
# Purpose: Enable efficient partial reads (~200 tokens vs ~2500 for full file)
meta:
  spec_id: 2026-10-11-live-answer-career-context
  spec_name: live-answer-career-context
  status: draft          # draft | in-progress | approved | completed
  phase: tasks           # specify | clarify | plan | tasks | preflight | feature-start | implement | verify
  created: 2026-10-11
  updated: 2026-10-11    # clarify session 2026-10-11 resolved every open candidate with the user

# Quick Reference (for checkpoint resume)
summary:
  goals:
    - {id: G1, description: "When the interviewer asks about the candidate's own background (career, past projects, behavioral stories, 'why us'), Live Answer answers in first person from the candidate's own notes instead of inventing a story", priority: HIGH}
    - {id: G2, description: "Questions that are not about the candidate (definitions, general technical, design) keep today's behavior exactly: no notes injected, byte-identical prompt", priority: HIGH}
    - {id: G3, description: "Retrieval is local and in-process, adds no perceptible latency to the answer path, and never blocks or breaks Live Answer", priority: HIGH}
  constraints:
    - {id: C1, description: "KB unset, missing, not ready or erroring → Live Answer behaves exactly as today (prompt byte-identical, no new UI)", type: TECHNICAL}
    - {id: C2, description: "Never log note text. LIVE_ANSWER_DEBUG may log route, cue, chunk ids, scores and timings only (extends the existing never-log-answer-text invariant)", type: SECURITY}
    - {id: C3, description: "Lexical retrieval is synchronous and ≤ 5 ms; the semantic part is bounded by a 150 ms timeout and its query embedding is prefetched during the existing 800 ms debounce", type: TECHNICAL}
    - {id: C4, description: "The retrieval core is pure JS and runs under `npm test` (plain Node). better-sqlite3 is built for Electron's ABI and does not load there, so no SQLite/FTS5 in the core", type: TECHNICAL}
    - {id: C5, description: "No personal content enters this public repo: unit tests use synthetic fixtures; the real eval set and the canonical card live in the KB repo", type: SECURITY}
    - {id: C6, description: "Electron 30 runs Node 20.16 (no fs.glob): manifest globs use a small in-repo glob-to-regex helper, no new dependency for it", type: TECHNICAL}
    - {id: C7, description: "Live Insights and Ask are not changed by this spec; the shared module only makes later reuse possible", type: SCOPE}
  decisions:
    - {id: D1, decision: "Hybrid retrieval in-process: BM25 + multilingual embeddings, fused with reciprocal rank fusion (RRF). No vector database", rationale: "Notes are bilingual (PT/EN) and interviewers paraphrase, so BM25 alone under-recalls; a few thousand 384-d vectors are searched by brute force in ~1 ms, so a vector DB adds a server process and nothing else (research R3, R4)"}
    - {id: D2, decision: "Deterministic intent router in its own provider-agnostic module under src/features/common/career/", rationale: "Zero latency, explainable in debug logs, table-testable; reusable by Ask and by any LLM provider (research R6)"}
    - {id: D3, decision: "Inject through the existing customPrompt slot of getSystemPrompt; append a first-person addendum to the user message only when notes are injected", rationale: "promptBuilder already wraps customPrompt as 'User-provided context' and the profile already prefers it; Live Answer passes '' today (summaryService.js:326). Planned as 'v2 Personalized answers' in specs/2026-05-30-interview-live-answer/spec.md"}
    - {id: D4, decision: "KB root from CAREER_KB_PATH; optional glass-kb.json manifest at that root filters for relevance, not privacy", rationale: "User decision 2026-10-11: sensitive files are not a concern; the manifest keeps noise (raw AI chats, unrelated guides, code) out and keeps the folder layout out of Glass"}
    - {id: D5, decision: "Per-company prep folders are indexed and tagged with their company; questions about the company itself use only the active company's notes", rationale: "User decision 2026-10-11: most company prep answers are generic and reusable; only 'why us' style answers are company-bound (research R7)"}
    - {id: D6, decision: "A generated canonical-facts card in the KB repo is injected whenever context is injected (personal, company, and ambiguous above threshold) and overrides the other notes", rationale: "The notes state the same facts with different values across files; retrieval would surface them inconsistently (research R8)"}
    - {id: D7, decision: "Embedding runtime = transformers.js running a small multilingual model in a worker; adoption gated by a spike (go/no-go)", rationale: "Ollama is not installed on the target machine and would be a separate service; transformers.js runs in-process. Packaging of its native runtime is the main risk, so a spike measures it first (research R5)"}
    - {id: D8, decision: "BM25 path ships end to end first; the vector layer is added after the spike", rationale: "Value lands early, and BM25 is both the fallback and the baseline the eval compares against"}
    - {id: D9, decision: "The eval set is built from questions real interviewers asked (recalled lists, debriefs, transcripts, screening forms), not from the prepared Q-lines", rationale: "Prepared Q-lines match their own chunk titles word for word and would inflate recall (research R9)"}

# CRITICAL REQUIREMENTS - Must verify during implementation
# These survive context compaction and generate T-VERIFY tasks
critical_requirements:
  type: feature-major    # bugfix | feature-minor | feature-major | config | documentation | refactoring
  portal: app            # superadmin | admin | app | public | none
  ui_changes: minor      # none | minor | moderate | major
---

# Feature Specification: Live Answer Career Context

**Feature Branch**: `2026-10-11-live-answer-career-context`
**Created**: 2026-10-11
**Status**: Draft
**Input**: User description (`live-answer-improvements/task1/task1.md`): "Enhance the existing Live Answer feature so it can intelligently detect when a user's question relates to their personal career, work history, past projects, or professional background, and dynamically retrieve accurate context from a local knowledge base. Intent routing must distinguish personal/career queries from general ones; local-first, low latency; integrate with the existing codebase."

---

## System Context

**Systems**: Framework-internal. The Glass Electron app (main process: `summaryService`, `listenService`; renderer: `LiveAnswerView`) plus a local, read-only folder of the user's career notes (markdown) located by `CAREER_KB_PATH`.
**Databases**: None. The index lives in memory; embedding vectors are cached as a file in Electron `userData`. The existing SQLite DB is not touched.
**Integrations**: The configured LLM provider, unchanged (`createStreamingLLM`). New local dependency for embeddings (transformers.js + a model file downloaded once), subject to the spike.
**Key Architecture**: `makeLiveAnswer` (`src/features/listen/summary/summaryService.js:316`) builds its system prompt with `getSystemPrompt('pickle_glass_analysis', '', false)` (`:326`). The empty second argument is `customPrompt`, which `promptBuilder.js` wraps as "User-provided context" and which the profile's `content` section tells the model to prefer over general knowledge. Today the model knows nothing about the candidate beyond what was said in the call, so a background question ("tell me about a time you led a migration") gets an invented story. The debounce callback in `triggerAnswerIfNeeded` (`:513`) is the single place where a question becomes an answer request (`:556-559`); that is where career context is resolved and passed down.

---

## Clarifications

### Session 2026-10-11

Resolved interactively with the user while reviewing `live-answer-improvements/task1/proposal.md`.

- Q: Is keyword ranking (BM25) enough, or should a vector database such as Chroma be added? → A: Hybrid. BM25 alone under-recalls on paraphrased and PT↔EN questions, so multilingual embeddings are added in v1. No vector database: brute force over a few thousand vectors is ~1 ms, and Chroma would add a server process (its default embedder is also English-only and it does not chunk). See research R3, R4.
- Q: Should the rule-based intent check be its own module for clean code and reuse with other LLMs? → A: Yes. `intentRouter.js` under `src/features/common/career/`, provider-agnostic, called only through the module's entry point.
- Q: How should sensitive files in the KB be handled? → A: User: not a concern. The manifest stays, but as a relevance filter.
- Q: Should per-company prep folders be excluded in v1? → A: No. Include them, tag chunks with their company, and scope company-directed questions ("why us") to the active company.
- Q: Is a separate "core card" needed when the notes already contain the answers? → A: Yes, but generated from the notes, not written from scratch: its job is to settle facts that the notes state inconsistently. The user decides each conflict once.
- Q: Where do the evaluation questions come from? → A: From questions real interviewers asked, as recorded in the KB (recalled lists, debriefs, transcripts, screening forms), labeled by Claude and reviewed by the user. Stored in the KB repo, never in this repo.
- Q: Process? → A: New branch, usual spec set.

**Deferred (default chosen, not blocking)**: whether the technical Q&A banks should also feed *general* technical answers. Default: no (general route injects nothing).

---

## User Scenarios & Testing *(mandatory)*

### Primary User Story
During a live interview, the interviewer asks "Tell me about a time you disagreed with a teammate." Live Answer shows, within the usual time, a first-person answer built from one of the candidate's own prepared stories, with a muted "from: …" line naming the notes it used. When the interviewer then asks "What's the difference between a mutex and a channel?", Live Answer answers as it does today, with no notes and no "from:" line.

### Acceptance Scenarios
1. **Given** `CAREER_KB_PATH` points at the notes and the index is warm, **When** the interviewer asks a behavioral question, **Then** the answer is first person, uses facts and a story from the notes, and shows a "from:" line with the note titles.
2. **Given** the same setup, **When** the interviewer asks a definitional or general technical question, **Then** the prompt sent to the LLM is byte-identical to today's and no "from:" line appears.
3. **Given** the interviewer asks in Portuguese, **When** the matching note is in English (or the reverse), **Then** the right note is still retrieved and the answer is in the interviewer's language.
4. **Given** the active company is A, **When** the interviewer asks "why do you want to join us?", **Then** only company A's notes (plus the canonical card) are injected, and no other company's name appears in the answer.
5. **Given** the notes give different values for the same fact, **When** a question touches that fact, **Then** the answer uses the value on the canonical card.
6. **Given** `CAREER_KB_PATH` is unset, the folder is missing, the embedding model is not available, or indexing throws, **When** any question is asked, **Then** Live Answer behaves exactly as today (or BM25-only, if only the model is missing).
7. **Given** the interviewer says a statement-form prompt with a career cue ("your biggest weakness"), **When** the turn ends, **Then** Live Answer triggers (the gate no longer drops it).

### Edge Cases
- A short follow-up ("and what was the outcome?") after a personal question stays on the personal route and reuses the previous question's terms.
- An ambiguous question ("how would you approach X?") retrieves, but injects only when the top hit clears the threshold.
- The embedding for a turn is not ready within 150 ms → that answer uses BM25 only; nothing waits.
- A note line still holds an unfinished marker (`[PREENCHER`, `⚠️ CONFIRMAR`) → it is never injected.
- The KB changes between calls → the next Listen session start picks up changed files (mtime) without a restart.
- A company-directed question when no active company is known → no company-scoped notes are injected; the model answers from the transcript.
- A newer question replaces an in-flight one (existing abort-and-replace) → the career context of the aborted question is discarded with it.

## Requirements *(mandatory)*

### Functional Requirements

**Knowledge base**
- **FR-001**: The system MUST read the KB root from `CAREER_KB_PATH` (env or `.env`). If unset or missing, the feature is disabled and Live Answer behaves as today.
- **FR-002**: The system MUST honor an optional `glass-kb.json` at the KB root with `include`/`exclude` globs (exclude wins), `core` files, `entities` (employer and project names, FR-006), and `companies` settings (`root`, `skip`, `aliases`). Without it, it indexes every `.md` and `.txt` except `.git/` and `node_modules/`. `core` files are never chunked into the index, even when `include` matches them; they are only injected whole.
- **FR-003**: The chunker MUST split markdown on headings with a breadcrumb title (`file › H2 › H3`), make each `**Q:` block one chunk with the Q line in the title, keep chunks within ~300–1,200 characters (splitting long sections on paragraphs and repeating the title), and give each chunk a stable id (hash of path, title, ordinal).
- **FR-004**: Chunks whose title or Q line contains an unfinished marker (`[PREENCHER`, `⚠️ CONFIRMAR`) MUST be dropped. Marker lines inside a body, and in core files, MUST be removed. This way a draft canonical card never injects an unconfirmed fact.
- **FR-005**: Each chunk MUST carry `companies`, `date` (from a `YYYY-MM(-DD)` in the filename, else file mtime) and `kind`.
  - `companies` is a set of company names. For a folder with no aliases, it is the folder name. For a folder with aliases, it is the alias names, narrowed to the ones whose slug appears in the file name; if none appears, all alias names are kept. A slug is the name with accents folded, lowercased and non-alphanumerics removed (`Café Labs` → `cafelabs`, `A&B` → `ab`), compared against the file name normalized the same way.
  - It is empty for folders in `companies.skip` and for files outside `companies.root`.
  - Several folders may list the same name, so that one company's prep spread across folders shares one tag.

**Routing**
- **FR-006**: `intentRouter` MUST classify a turn as `personal`, `company`, `ambiguous` or `general`, return the cue that fired, cover English and Portuguese cues, treat employer/project names from the CV (manifest `entities`) as personal cues, and keep a follow-up on the previous personal or company route. A follow-up is a turn of at most 10 words that carries a follow-up marker ("what was the outcome", "how did that go", "and then", "e aí", "qual foi o resultado") and arrives within 5 minutes of the previous personal or company answer.
- **FR-007**: When the feature is enabled, `shouldTriggerAnswer` MUST also accept a `them` turn that carries a personal or company cue even without a question signal. When it is disabled, the gate MUST behave exactly as today (C1). All existing `liveAnswer.test.js` cases MUST still pass.

**Retrieval**
- **FR-008**: The lexical index MUST be BM25 over chunk title (weight 3) and body (weight 1), with accent folding, EN+PT stopwords and light stemming; query = turn minus router cue phrases, extracted-question terms boosted, previous personal question merged on follow-ups, and on the `company` route the active company's name added ("why do you want to join us" has no content words of its own).
- **FR-009**: The semantic index MUST embed chunks with a multilingual model in a worker, cache vectors keyed by content hash and model id, start the query embedding as soon as a gated `them` turn arrives (inside the 800 ms debounce), and fall back to BM25-only when the embedding is not ready within 150 ms.
- **FR-010**: Results MUST be fused by RRF (k = 60) over the BM25 top 20 and the vector top 20, ties broken toward newer `date`, returning the top 3–4 chunks.
- **FR-011**: On the `company` route, a chunk whose `companies` set is non-empty and does not contain the active company MUST NOT be used. Untagged chunks (empty set) MAY be used.
  - The active company comes from `CAREER_KB_COMPANY`, the reliable path: a company name as the manifest aliases spell it (or a folder name without aliases), compared by slug. Otherwise it is the first company name spoken in a `them` turn of the session, matched against folder names and aliases case- and accent-insensitively, with the longest match first, so a two-word name wins over its first word.
    - Detection only accepts a name inside a company-context phrase. Starting list, kept as data and extended through the eval: "here at X", "at X we", "join X", "joining X", "welcome to X", "heard of X", "aqui na/no X", "na/no X a gente", "entrar na/no X", "conhece a/o X".
    - The reason: many company names are ordinary words (for example a company called "Bridge" or "Anchor"), and a bare match would switch the active company on small talk.
  - If no active company is known, only untagged chunks are used on that route.
  - Other routes ignore company tags.
- **FR-012**: On the `ambiguous` route, context MUST be injected only when the top hit clears a threshold calibrated by the eval (FR-019).
  - The metric is the top hit's vector cosine similarity when vectors were used. In BM25-only mode, it is the top hit's coverage: at least half of the query terms and at least 2 of them matched.
  - When it clears, the injection is the same as on the `personal` route: card, chunks and addendum.

**Prompt and UI**
- **FR-013**: The context block MUST put the canonical card first, then chunks under their breadcrumb titles (format in contracts), deduplicated, capped at 6,000 characters and cut at paragraph boundaries.
  - The card is never cut: chunks fill the budget left after it, lowest-ranked dropped first.
  - If the card alone exceeds the cap, it is injected whole without chunks and a debug warning is logged.
- **FR-014**: `makeLiveAnswer` MUST pass the block as `customPrompt` and append the first-person addendum (contracts) to the user message only when a block is injected. On the `general` route, or when disabled, the messages MUST be byte-identical to today's.
- **FR-015**: `live-answer-update` payloads MUST carry `sources: string[]` (titles only) when context was injected; `applyLiveAnswerUpdate` MUST keep them on the entry; `LiveAnswerView` MUST render them as a muted "from: …" line under the question, and nothing when absent.

**Lifecycle, safety, tooling**
- **FR-016**: The index MUST warm at app start (async, off the hot path) and refresh changed files at each Listen session start; the full embedding pass MUST run at low priority and never on the answer path.
- **FR-017**: Any error in the career module MUST be caught inside it; the caller receives "no context" and Live Answer continues unchanged.
- **FR-018**: Under `LIVE_ANSWER_DEBUG`, the module MUST log route, cue, chunk ids, scores and per-stage timings, and MUST NOT log note text.
- **FR-019**: `scripts/eval-career-kb.js` MUST read the KB and its eval file and print the router confusion matrix, recall@3 for BM25-only and hybrid, a company-leak check and p50/p95 retrieval latency.
  - It MUST evaluate each item with the chunks of its `source` file removed (leave-source-out). Every real question is also stored in the note it was recorded in, so it must never be matched against itself.
  - A gold entry pointing at a core file counts as a hit when the route injects the card. Items whose gold is only the card are scored by routing, not by retrieval.
  - **Recall** is computed over personal items with at least one non-core gold note. It is reported two ways: `recall@3` on the fused ranking, and `injected recall` on the chunks that actually fit in the block after the budget. The second is the target.
  - **Latency:** the answer path is routing, BM25, fusion and packing, with the query embedding already prefetched. The query embedding is reported separately, and must finish inside the debounce window (p95 ≤ 800 ms; the spike targets ≤ 50 ms).
  - **Holdout:** success criteria are judged on the full set. The holdout items (excluded from tuning cues and thresholds) are reported separately; if their personal-route recall or injected recall is more than 10 points below the tuning split, the run is flagged as overfit. The holdout is too small to pass or fail on by itself.
- **FR-020**: Docs MUST cover `CAREER_KB_PATH`, `CAREER_KB_COMPANY`, the manifest format and the debug output.

### Success Criteria
- **SC-001**: Router: ≥ 95% of personal items routed `personal`; general items routed `personal` ≤ 10% (full eval set, no overfit flag).
- **SC-002**: Hybrid injected recall ≥ 85% (FR-019); recall@3 and the BM25-only numbers reported alongside.
- **SC-003**: Zero company-route answers drawing on another company's notes (eval set).
- **SC-004**: Answer path (FR-019 definition) ≤ 20 ms at p95; BM25 ≤ 5 ms; query embedding p95 ≤ 800 ms; general route adds nothing measurable.
- **SC-005**: With the KB disabled, the LLM messages are byte-identical to today's (automated test).

### Key Entities *(include if feature involves data)*
- **Chunk**: one retrievable unit of a note (id, path, title, body, companies, date, kind, hash).
- **Manifest**: the optional `glass-kb.json` (include, exclude, core, companies).
- **Canonical card**: the `core` file(s), injected whole whenever context is injected; never chunked.
- **Route decision**: router output (route, cue).
- **Career context**: what the debounce callback hands to `makeLiveAnswer` (block, sources, route, timings).
- **Eval question**: one labeled line of the eval file (text, language, route, gold notes, company, source, fidelity, holdout).

See `data-model.md`.

### External Dependencies & Risk Assessment *(mandatory)*

| Dependency | Type | Risk Level | Quota/Limits | Fallback Behavior |
|------------|------|------------|--------------|-------------------|
| Configured LLM provider (unchanged) | SDK/HTTP streaming | MED | ≤ 6,000 extra characters (about 1.5–2k tokens) per injected question | Existing Gemini failover; career context is optional input |
| transformers.js + multilingual embedding model (subject to spike T024) | Local library + model file (~120 MB, one download) | MED | CPU only; no network after first download | BM25-only retrieval |
| `onnxruntime-node` (transitive, native) | Native module in the packaged app | MED | Installer size; must be unpacked from asar like `sharp` (`electron-builder.yml` `asarUnpack`) | Spike is go/no-go; no-go ships BM25-only |
| Career notes folder | Local filesystem, read-only | LOW | Hundreds of files | Feature disabled |

**HIGH-RISK Dependency Checklist**: Not applicable; no new quota-limited remote API.

### Test Strategy *(mandatory)*

The retrieval core is pure and unit-tested under the Node built-in runner (`npm test`) with **synthetic** fixtures only (C5). The embedding model is never loaded in unit tests: the vector index and fusion take vectors as input, and the embedder is replaced by a fake with controllable latency. Real-corpus quality is measured by the eval script against the KB (FR-019), outside the test suite.

**Test Type Classification**:
| FR | Primary Test Type | Reason |
|----|-------------------|--------|
| FR-002, FR-003, FR-004, FR-005 | Unit | Pure chunker and manifest filter over fixture strings and a temp dir |
| FR-006 | Unit (table) | Cue tables EN/PT, entity cues, follow-ups |
| FR-007 | Unit | `shouldTriggerAnswer` truth table extended; existing cases unchanged |
| FR-008, FR-010, FR-011, FR-012 | Unit | BM25 ranking, RRF, recency tie-break, company scope, threshold |
| FR-009 | Integration (fake embedder) | Prefetch, cache hit, 150 ms timeout fallback |
| FR-013, FR-014 | Unit + Integration | Budget/dedupe; byte-identical messages when disabled (SC-005) |
| FR-015 | Unit | `applyLiveAnswerUpdate` keeps `sources` |
| FR-016, FR-017 | Integration (temp dir) | Warm, mtime refresh, error containment |
| FR-018 | Unit | Debug output contains no fixture body text |
| SC-001..SC-004 | Eval script | Real KB, outside the suite |

**Distribution Estimate**:
- Feature type: [x] Mixed (pure retrieval core + Electron wiring + small UI)
- Unit: ~70% | Integration: ~20% | Contract: 0% | E2E/Manual: ~10%
- Justification: almost all logic is pure; the Electron worker and the visual "from:" line are confirmed manually (quickstart).

**HIGH-RISK API Warning**:
- [ ] Feature calls a quota-limited HIGH-RISK API → **No.** The LLM is mocked in tests; the eval script does not call the LLM.

**Estimated Test Count**: ~45–60 test cases across 8 test files.

### Error Handling & Recovery *(mandatory if feature can fail)*

**Error Scenarios**:
| Error Scenario | Type | User Message | Recovery Action |
|----------------|------|--------------|-----------------|
| `CAREER_KB_PATH` unset or folder missing | Permanent | None | Feature disabled; Live Answer as today |
| Manifest is invalid JSON | Permanent | None (debug log) | Ignore the manifest, use defaults |
| A note fails to read or parse | Transient | None | Skip that file; index the rest |
| Model download or load fails | Permanent for the session | None | BM25-only |
| Query embedding exceeds 150 ms | Transient | None | BM25-only for that answer |
| Worker crashes | Transient | None | BM25-only; restart the worker on next warm |
| Retrieval throws | Transient | None | No context for that answer |

**Error/Rescue Registry**:
| Method/Codepath | What Can Go Wrong | Exception Class | Rescued? | Rescue Action | User Sees |
|-----------------|-------------------|-----------------|----------|---------------|-----------|
| `kbService.warm` | fs/manifest errors | Error | Y | Disable or skip file, debug log | Today's behavior |
| `embedder` (worker) | load/inference failure | Error | Y | Mark vectors unavailable | BM25-only answers |
| `getCareerContext` | any throw | Error | Y | Return `null` context | Today's behavior |
| `prefetch` | timeout | n/a (race) | Y | Ignore late result | BM25-only answer |

**Failure Modes Registry**:
| Codepath | Failure Mode | Rescued? | Test? | User Sees? | Logged? |
|----------|-------------|----------|-------|------------|---------|
| warm | disabled | Y | Y | today's behavior | debug |
| embedder | unavailable | Y | Y (fake) | BM25-only answer | debug |
| getCareerContext | throws | Y | Y | today's behavior | debug |

*No row has Rescued=N.*

**Multi-Phase Operations**: Indexing is idempotent and rebuildable; the vector cache is keyed by content hash, so a partial pass resumes by skipping cached chunks.

### UI/Design Reference *(mandatory)*

**Feature Classification**:
- [x] **Minor UI** (< 3 components, existing patterns only)

**Design Reference**:
- One muted line under the existing "Q:" label in `LiveAnswerView` (`src/ui/listen/summary/LiveAnswerView.js`, answer block render around `:406`), text only via Lit binding (never innerHTML), styled like `.answer-question` but dimmer. No other visual change.

### Permissions & Access Control *(mandatory)*

**Portal Placement**: [x] Application Portal (local Electron app).
**User Roles Affected**: [x] Local desktop user (single actor).
**Data Scoping**: [x] User-scoped. Notes are read locally; excerpts travel to the LLM provider the user configured, the same path the transcript already takes. The answer window is content-protected (existing).

### Architecture Context *(mandatory if feature has business logic)*

```
src/features/common/career/            new, provider-agnostic
  index.js           getCareerContext(turn, history) · prefetch(turn) · warm()
  intentRouter.js    pure        chunker.js       pure
  textNormalize.js   pure        bm25.js          pure
  vectorIndex.js     pure        retriever.js     pure (RRF, scope, recency)
  contextBuilder.js  pure        kbService.js     fs (manifest, walk, refresh)
  embedder.js        worker host (lazy-loads transformers.js)
  embedWorker.js     worker body
  globMatch.js       pure (C6)

summaryService.js    triggerAnswerIfNeeded: prefetch on gated turn; debounce callback
                     resolves context → makeLiveAnswer(meta.career); shouldTriggerAnswer
                     accepts career cues
listenService.js     warm() on initializeSession
index.js (app)       warm() after app.whenReady
LiveAnswerView.js    "from:" line;  liveAnswerHistory.js keeps sources
```

---

## Out of Scope / Future Work

- Settings UI (toggle, KB folder picker, active company, rebuild button, index status).
- Story rotation within a call (prefer stories not yet used).
- Reuse in Ask and Live Insights through `common/career`.
- Semantic fallback inside the router (nearest prepared Q-line).
- Technical Q&A banks feeding general technical answers (deferred, default off).

---

## Review Checklist (Gate)

- [x] No [NEEDS CLARIFICATION] markers remain (session 2026-10-11)
- [x] Requirements are testable
- [x] Test strategy defined (synthetic fixtures; eval script for real-corpus quality)
- [x] Portal placement selected
- [x] Permissions defined (single local user)
- [x] Data sensitivity classified (user decision: notes are not treated as sensitive; C5 keeps them out of this public repo)
- [x] External APIs identified (LLM unchanged; local embedding runtime behind a spike)
- [x] Error handling defined
- [x] UI complexity classified (Minor)
- [x] Deprecation decision made: nothing deprecated
- [ ] Bug evidence captured: N/A (`feature-major`)

---

## Next Steps

- T001–T003 (KB repo) need the user: manifest, canonical-card conflicts, eval-set review.
- Implementation starts at T010 (tests first). The vector layer waits on the spike, T024.

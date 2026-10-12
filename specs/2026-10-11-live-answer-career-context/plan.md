---
# Context Optimization Metadata
# Purpose: Enable efficient partial reads (~200 tokens vs ~2500 for full file)
meta:
  spec_id: 2026-10-11-live-answer-career-context
  spec_name: live-answer-career-context
  phase: plan
  updated: 2026-10-11

# Quick Reference (for checkpoint resume)
summary:
  tech_stack: [JavaScript (CommonJS, main process), Lit 2.7.4 (renderer), Electron 30 / Node 20.16, node:test]
  external_deps: ["@huggingface/transformers (pinned after spike T024)", "multilingual embedding model, ~310 MB, downloaded once"]
  test_strategy: {unit: 70, integration: 20, contract: 0, e2e_manual: 10}
  deployment: immediate  # ships with the next Glass desktop build; inert until CAREER_KB_PATH is set
---

# Implementation Plan: Live Answer Career Context

**Branch**: `2026-10-11-live-answer-career-context` | **Date**: 2026-10-11 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/2026-10-11-live-answer-career-context/spec.md`

## Execution Flow (/plan command scope)

```
1. Load spec → Fill Technical Context → Constitution Check          ✓
2. Phase 0.1: Research + Testing Strategy (MANDATORY)               ✓
3. Phase 0.2: Permissions (single local user → trivial)            ✓ (N/A documented)
4. Phase 0.3: Integration Analysis (MANDATORY)                      ✓
5. Phase 0.4: Design Pre-flight (Minor UI → skip)                   ⏭ skipped
6. Phase 0.5: Infrastructure (env vars, packaging)                  ✓
7. Phase 0.6: Error/Rescue Mapping                                  ✓
8. Phase 0.7: Implementation Timeline Risks (MANDATORY)             ✓
9. Phase 1: Design & Contracts → data-model.md, contracts/, quickstart.md  ✓
10. Plan Phase 2 approach                                           ✓
```

> SpecKit is not installed on this machine, so this set was authored by hand in the format of the previous specs. `preflight-report.md` is not generated.

## Summary

Live Answer gets the candidate's own background when the interviewer asks about it.

**Technical approach:**
- A provider-agnostic module, `src/features/common/career/`, indexes a local folder of markdown notes (`CAREER_KB_PATH`) in memory.
- A deterministic intent router decides per question whether it is about the candidate.
- Hybrid retrieval: BM25 plus multilingual embeddings, merged by RRF.
- The result goes into the existing `customPrompt` slot of `getSystemPrompt`, with a first-person addendum.
- A "from:" line in `LiveAnswerView` shows which notes were used.

Question embeddings are prefetched during the existing 800 ms debounce, so the answer path gains milliseconds, not seconds. With the feature disabled, the LLM messages are byte-identical to today's.

## Technical Context

**Language/Version**: JavaScript (CommonJS in main, ES modules bundled by esbuild in renderer); Electron 30 (Node 20.16).
**Primary Dependencies**:
- Existing: `promptBuilder`, `createStreamingLLM`, `modelStateService`, Lit.
- New: `@huggingface/transformers` (gated by the spike).
**Storage**: In-memory index. Embedding cache file in `userData/career-kb/`. No DB changes.
**Testing**: `node --test` via `npm test`, with synthetic fixtures. Eval script against the real KB. Manual quickstart.
**Target Platform**: Electron desktop (Windows primary; macOS must not break).
**Performance Goals**:
- Added answer-path time ≤ 20 ms at p95.
- BM25 ≤ 5 ms.
- BM25 index build ≤ 500 ms.
- Query embedding ≤ 50 ms (spike target).
**Constraints**: spec C1–C7.
**Scale/Scope**:
- New: about 11 modules plus about 8 test files in `common/career/`, and 1 eval script.
- Edited: `summaryService.js`, `listenService.js`, `src/index.js`, `liveAnswerHistory.js`, `LiveAnswerView.js`, `electron-builder.yml`, `package.json`, docs.
**System Context**: Framework-internal (spec System Context).
**Architecture Docs Read**:
- `docs/LIVE_INSIGHTS_AND_ASK.md` (§4 Live Answer);
- `specs/2026-05-30-interview-live-answer/spec.md` (Out of Scope: "v2 Personalized answers");
- `live-answer-improvements/live-answer.md`.

## Constitution Check
*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Assessment | Status |
|-----------|------------|--------|
| I. Test-First Development | Every pure module has a test task before its implementation task (T010/T011 …). The wiring task starts with the byte-identical-prompt test (SC-005). | PASS |
| II. Specification-Driven Development | Proposal → clarify session with the user (2026-10-11) → this plan → tasks.json. | PASS |
| III. Verification Before Completion | The eval script prints measurable SC-001..SC-004. The quickstart maps each FR to an observable result. | PASS |
| IV. Skills Before Action | AI/ML feature, see the section below. | PASS |
| V. Code Review Compliance | Small pure modules, one job each. Errors are contained at the module boundary. The no-text-in-logs invariant is extended. | PASS |

### AI & Machine Learning *(applicable)*

**Does this feature involve AI/ML?** [x] **Yes**: retrieval (embeddings) and prompt construction for an LLM.

| Aspect | Approach |
|--------|----------|
| Explainability | Every injected answer shows its sources in the UI ("from: …"). The debug log names the route, the cue and the chunk ids. |
| Grounding | The addendum restricts first-person facts to the injected notes, and the canonical card wins conflicts. |
| Evaluation | Labeled eval set from real interviewer questions (research R9), with BM25 vs hybrid reported. |
| Failure posture | Every failure degrades to today's behavior (C1). |
| Data | Notes stay local except the ≤ 9,000-character excerpt sent with the transcript to the configured LLM. No note text in logs (C2). |

## Project Structure

### Documentation (this feature)
```
specs/2026-10-11-live-answer-career-context/
├── spec.md
├── research.md
├── plan.md                 # this file
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── career-context.contracts.d.ts
│   ├── EDGE_CASES.md
│   └── tsconfig.json
├── tasks.json
└── acceptance-tests.yaml
```

### Source Code (repository root)
```
src/features/common/career/            NEW
├── index.js            entry point: warm, prefetch, getCareerContext, hasCareerCue, detectCompany, status
├── intentRouter.js     pure
├── chunker.js          pure
├── textNormalize.js    pure
├── bm25.js             pure
├── vectorIndex.js      pure
├── retriever.js        pure (RRF, company scope, recency)
├── contextBuilder.js   pure (block, sources, addendum)
├── globMatch.js        pure
├── kbService.js        fs: manifest, walk, mtime refresh, state machine
├── embedder.js         worker host + cache (after spike)
├── embedWorker.js      worker body (after spike)
└── __tests__/          synthetic fixtures only

src/features/listen/summary/summaryService.js   EDIT: gate, prefetch, debounce callback, makeLiveAnswer(meta.career)
src/features/listen/listenService.js            EDIT: warm() in initializeSession
src/index.js                                    EDIT: warm() after app.whenReady
src/ui/listen/summary/liveAnswerHistory.js      EDIT: keep sources
src/ui/listen/summary/LiveAnswerView.js         EDIT: "from:" line
scripts/eval-career-kb.js                       NEW
electron-builder.yml, package.json              EDIT (after spike): dependency + asarUnpack
docs/LIVE_INSIGHTS_AND_ASK.md                   EDIT
```

**Structure Decision**: The module lives under `common/`, not `listen/`, because Ask and Live Insights are expected callers later (C7 keeps them unchanged now). Only `index.js` is imported from outside the folder.

## Phase 0.1: Research & Testing Strategy

### Production Log & Error Evidence
**Skip condition met**: `feature-major`, not a bugfix; no production backend involved.

### Research

Consolidated in [research.md](./research.md):

| # | Question | Decision |
|---|----------|----------|
| R1 | Injection point | `customPrompt` slot (`summaryService.js:326`); addendum only when injected |
| R2 | FTS5 vs pure JS | Pure-JS BM25 (better-sqlite3 fails under `npm test`: NODE_MODULE_VERSION 123 vs 137) |
| R3 | Lexical enough? | No: bilingual corpus + paraphrase → hybrid |
| R4 | Vector DB? | No: brute force over a few thousand vectors; Chroma adds a server |
| R5 | Embedding runtime | transformers.js + small multilingual model in a worker; spike first |
| R6 | Router | Deterministic cues, four routes, own module |
| R7 | Company notes | Included, tagged, company-route scoping |
| R8 | Conflicting facts | Generated canonical card overrides |
| R9 | Eval set | Real interviewer questions, stored in the KB repo |
| R10 | Latency | Prefetch during debounce; 150 ms cap |
| R11 | Runtime | Node 20 (no fs.glob); dotenv; hooks at `index.js:172`, `listenService.js:157` |

### Testing Strategy

| Check | Output |
|-------|--------|
| External APIs | LLM provider (existing, mocked). Embedding model never loaded in tests (fake embedder). |
| Test types | Unit (pure modules), integration (wiring with temp dir + fake embedder + mocked LLM stream), manual (quickstart) |
| Mocking strategy | Mocked LLM stream following the existing `liveAnswer.test.js` pattern. Fake embedder with deterministic vectors and configurable delay. Temp-dir fixture KB. |

**Testing Summary**:
```
Feature type: Mixed (pure retrieval core + Electron wiring + minor UI)
Quota risks: None (no live LLM in tests or eval)
Estimated tests: ~45–60 cases across ~8 files
Distribution: Unit ~70%, Integration ~20%, Manual ~10%
```

**GATE**: No HIGH-RISK APIs. PASS.

## Phase 0.2: Permissions Design

Single local user; no roles, no API surface. N/A.

## Phase 0.3: Integration Analysis

### Codebase Pattern Discovery

| Pattern Area | Finding | Use |
|--------------|---------|-----|
| Pure helpers exported for tests | `summaryService.js:906-915` exports `isLikelyQuestion`, `shouldTriggerAnswer`, … | Same style: each `career/*.js` exports its pure functions |
| Debug logging | `laDebug` gated by `LIVE_ANSWER_DEBUG` (`summaryService.js:11-14`) | The career module logs through the same flag, prefix `[career]` |
| Env config | dotenv at `src/index.js:8`; `GEMINI_*`, `LIVE_ANSWER_DEBUG` read from `process.env` | `CAREER_KB_PATH`, `CAREER_KB_COMPANY` |
| Native module packaging | `electron-builder.yml` `asarUnpack: "**/node_modules/sharp/**/*"` | Same for `onnxruntime-node` (after spike) |
| Answer meta to renderer | `makeLiveAnswer(..., meta)` carries `id`, `question` on every `live-answer-update` (`:316-322`) | Add `sources` the same way |
| History fold | `applyLiveAnswerUpdate` (`liveAnswerHistory.js:35`) creates and updates entries by id | Keep `sources` on create, preserve on update |
| Reset | `resetLiveAnswer()` (`:604`) is called by `resetConversationHistory` at session start and stop | Also clears `careerPrev` and `activeCompany` (the prefetch lives in the career module) |

### Code Interconnectedness Gate

| Pattern Needed | Evidence | Decision |
|----------------|----------|----------|
| Prompt context slot | `promptBuilder.js` `customPrompt` | REUSE (no template change) |
| Question label | `extractQuestion` (`:99`) | REUSE: boosts its terms in the BM25 query |
| Question gate | `shouldTriggerAnswer` (`:222`) | EXTEND: `|| career.hasCareerCue(text)` after the speaker gate |
| Ollama infra | `ollamaService` | NOT USED (not installed on target; research R5) |
| SQLite | `sqliteClient` (better-sqlite3) | NOT USED (ABI; research R2) |

### Contract Validation

`contracts/career-context.contracts.d.ts` was type-checked with `npx -p typescript@5.4.5 tsc -p contracts/tsconfig.json` (same tsconfig as the 2026-06-01 spec): **PASS**.

## Phase 0.4: Design Pre-flight

**Skipped**: Minor UI (one muted text line reusing `.answer-question` styling).

## Phase 0.5: Infrastructure & Migrations

| Item | Detail |
|------|--------|
| Env vars | `CAREER_KB_PATH` (enables the feature), `CAREER_KB_COMPANY` (optional), `CAREER_KB_VECTORS` (optional, `off` = BM25 only). Documented in T028. |
| Dependency | `@huggingface/transformers` 4.2.0, pinned exact (T024). Added to `dependencies`. |
| Packaging | `electron-builder.yml`: `asarUnpack` gains `**/node_modules/onnxruntime-node/**/*`; `files` excludes `onnxruntime-web` (unused under Node) and, per platform, the other platforms' ONNX binaries (T024 verified on a packaged build). |
| Model file | Downloaded on first use into `userData/career-kb/models`. It is not bundled in the installer. |
| DB migrations | None |
| Rollout | Inert until `CAREER_KB_PATH` is set. Rollback = unset it. |

## Phase 0.6: Error/Rescue Mapping

See spec § Error Handling. Rule: **every career-module public function is total.** `getCareerContext` returns `null` on any throw, `warm`/`prefetch` swallow and log, and `hasCareerCue`/`detectCompany` are pure and return `false`/`null` on bad input. `summaryService` treats `null` as "no context". No error crosses into the answer stream.

## Phase 0.7: Implementation Timeline Risks

| Phase | Anticipated Blocker | Resolution | Add to Task Context? |
|-------|--------------------|------------|---------------------|
| Foundations | Temptation to use better-sqlite3/FTS5 | It does not load under `npm test` (R2). Pure JS only in the core. | Y (T012/T013) |
| Foundations | Personal content sneaking into fixtures | C5: fixtures are invented text. The acceptance negative assertion greps the fixture folder. | Y (all test tasks) |
| Core | Router over-triggers on hypothetical "how would you…" | Those go to `ambiguous`, never `personal`; threshold decides injection | Y (T014/T015) |
| Core | Byte-identical guarantee broken by an unconditional prompt change | Build messages exactly as today when `career` is null or `block === ''`; test SC-005 first | Y (T020/T021) |
| Integration | Awaiting the embedding delays the answer | Prefetch on the gated turn; `Promise.race` with 150 ms; never await `warm()` on the answer path | Y (T025/T026) |
| Integration | Embedding pass competes with STT for CPU during a call | Full pass at app start; during sessions only changed chunks; worker at low priority | Y (T026) |
| Integration | onnxruntime-node fails inside asar | Spike T024 verifies the packaged build before any dependency lands on the branch | Y (T024) |
| Polish | `sources` from an aborted answer attached to the next | `sources` rides only on that answer's own `id` payloads | Y (T022/T023) |
| Polish | Eval set overfits the cues | Keep 20% of the eval items held out from cue tuning; judge on the full set and flag a holdout gap over 10 points | Y (T027) |
| Integration | A question is aborted while its context is being resolved | Create the AbortController before awaiting getCareerContext; bail if aborted after the await | Y (T020/T021) |
| Foundations | `npm test` loads the native ONNX runtime or Electron's `app` through the career module | Lazy-require `@huggingface/transformers` inside the worker host and resolve the `userData` path at warm time; no top-level Electron or model imports | Y (T019/T026) |
| Verify | `npm run lint` cannot run (eslint is not installed in this repo) | Gate on `node --check` for main-process files and `npm run build:renderer` for the renderer instead | Y (T-FINAL) |

## Prior Lessons Applied

| Lesson | Applied How |
|--------|-------------|
| Abort-and-replace race on Live Answer (original spec C4/FR-011) | Career session state lives in the answer lane and is cleared in `resetLiveAnswer`. Context resolved after an abort is dropped. |
| Gemini 503s at peak hours (`docs/GEMINI_503_PEAK_HOURS.md`) | No extra LLM call for routing (R6) |

## Phase 1: Design & Contracts

1. **[data-model.md](./data-model.md)** covers the manifest, chunk, indexes, cache, route decision, career context, session state, IPC extension, eval item and state machine.
2. **[contracts/career-context.contracts.d.ts](./contracts/career-context.contracts.d.ts)** gives the module surface, pure-function signatures, the addendum text and the IPC payload. Type-checked: PASS.
3. **[contracts/EDGE_CASES.md](./contracts/EDGE_CASES.md)** lists 28 edge cases mapped to FRs.
4. **[quickstart.md](./quickstart.md)** covers setup, automated checks and 10 manual checks mapped to FRs.

## Phase 2: Task Planning Approach

Strategy: tests before implementation for each pure module. BM25 lands end to end first (through T023), the spike gates the vector layer, and eval and docs close.

| Group | Tasks | Gate |
|-------|-------|------|
| KB repo (user) | T001 manifest, T002 canonical card + conflicts, T003 eval set | User review; nothing committed by Claude in the KB repo |
| Core (pure) | T010–T017 | Each implementation gated by its test task |
| KB service | T018–T019 | T017 |
| Wiring | T020–T021 | T019 |
| UI | T022–T023 | T021 |
| Spike | T024 | T021 (go/no-go) |
| Vector layer | T025–T026 | T024 = go |
| Eval + docs | T027–T028 | T003, T021 (T026 if go) |

## Progress Tracking

| Phase | Status | Skip If |
|-------|--------|---------|
| 0.1 Research + Testing | [x] Complete | Never |
| 0.2 Permissions | [x] Complete (N/A) | No roles |
| 0.3 Integration | [x] Complete | Never |
| 0.4 Design Pre-flight | [x] Skipped (Minor UI) | Minor UI |
| 0.5 Infrastructure | [x] Complete | - |
| 0.6 Error/Rescue Mapping | [x] Complete | - |
| 0.7 Timeline Risks | [x] Complete | Never |
| 1 Design & Contracts | [x] Complete | - |
| 2 Task Planning | [x] tasks.json generated | - |

**Gates**: Constitution Check PASS · Clarification session 2026-10-11 complete (no NEEDS CLARIFICATION) · Contracts tsc PASS · Bugfix gate N/A

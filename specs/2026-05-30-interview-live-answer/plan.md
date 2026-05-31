---
# Context Optimization Metadata
# Purpose: Enable efficient partial reads (~200 tokens vs ~2500 for full file)
meta:
  spec_id: 2026-05-30-interview-live-answer
  spec_name: interview-live-answer
  phase: plan
  updated: 2026-05-31

# Quick Reference (for checkpoint resume)
summary:
  tech_stack: [JavaScript (CommonJS), Electron 30 (Node 20+), Lit 3, node:test]
  external_deps: [Configured LLM provider via modelStateService + createStreamingLLM (OpenAI/Gemini/Anthropic/openai-glass/Ollama)]
  test_strategy: {unit: ~60%, integration: ~35%, contract: 0%, e2e: 0%, manual: ~5%}
  deployment: immediate   # additive, in-process; no migration, no feature flag
---

# Implementation Plan: Interview Live Answer Lane

**Branch**: `2026-05-30-interview-live-answer` | **Date**: 2026-05-31 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/2026-05-30-interview-live-answer/spec.md`

## Execution Flow (/plan command scope)

```
1. Load spec → Fill Technical Context → Constitution Check          ✅
2. Phase 0.1: Research + Testing Strategy (MANDATORY)               ✅
3. Phase 0.2: Permissions (no roles → screen-share invariant only)  ✅ (N/A roles)
4. Phase 0.3: Integration Analysis (MANDATORY)                      ✅
5. Phase 0.4: Design Pre-flight (Moderate UI)                       ✅
6. Phase 0.5: Infrastructure (no env/migrations/deprecations)       ✅ (skip)
7. Phase 0.6: Error/Rescue Mapping (service module w/ errors)       ✅
8. Phase 0.7: Implementation Timeline Risks (MANDATORY)             ✅
9. Phase 1: Design & Contracts → data-model.md, contracts/, quickstart.md ✅
10. Plan Phase 2 approach (DO NOT create tasks.md)                  ✅
11. STOP - Ready for /tasks command
```

**Note**: /plan stops at step 9. /tasks creates tasks.md, then implementation begins.

> **LOCKED**: Decisions D1–D4, clarification Q1 (hold-last render, no flicker), and corrections C1–C8 are settled and not re-litigated here. This plan grounds them against verified live code; it does not re-open them.

## Summary

Add a second, purely-additive analysis lane to the `glass` Listen window's insights pane: a **Live Answer** lane that auto-detects an interviewer (`them:`) question over system audio and **streams** a concise, read-aloud-ready answer into a new `<live-answer-view>` Lit component placed ABOVE the existing `<summary-view>`. The candidate never types. The existing Live Insights summary lane is untouched (Open-Closed; FR-017) — if `triggerAnswerIfNeeded`/`makeLiveAnswer` were deleted, Live Insights behaves identically.

**Technical approach** (verified against live code): hang a sibling `triggerAnswerIfNeeded(speaker, text)` off the existing `addConversationTurn` hub (`summaryService.js:38,45`) beside `triggerAnalysisIfNeeded`. It runs four gates (speaker → heuristic → debounce 800 ms → de-dup/in-flight), then `makeLiveAnswer` resolves the model via `modelStateService.getCurrentModelInfo('llm')`, calls the **two-arg** `createStreamingLLM(provider, opts)` (`factory.js:128`), and consumes the SSE stream exactly like `askService._processStream` (`askService.js:401-474`) — `[DONE]`/`_reset`/`_final_model`/`delta.content`, with an `AbortController` for abort-on-new-question and abort-on-close. PASSIVE is detected streaming-aware via a prefix-buffer + `normalizePassive` BEFORE rendering, holding the last answer on suppress (no flicker). The answer streams over a NEW `live-answer-update` IPC channel into `LiveAnswerView`, which self-loads `marked`/`hljs`/`DOMPurify` idempotently and renders sanitized markdown. Pure helpers (`isLikelyQuestion`, `normalizePassive`/`parseAnswerOrPassive`, `shouldTriggerAnswer`) are extracted and unit-tested first via `node:test` (TDD; Constitution Principle I). In-memory only — no DB persistence (C8).

## Technical Context

**Language/Version**: JavaScript (CommonJS modules); Electron 30.5.1 bundling Node 20+ (per `package.json` devDependencies)
**Primary Dependencies**: Lit 3 (renderer Web Components, via `build.js`/esbuild); existing AI factory (`src/features/common/ai/factory.js`); `modelStateService`; `marked` 4.3.0 / `highlight.js` 11.9.0 / `DOMPurify` 3.0.7 (window globals loaded by `SummaryView`)
**Storage**: N/A for this feature — in-memory only (C8). The SQLite `summaryRepository.saveSummary` path used by the summary lane is deliberately NOT extended.
**Testing**: Node built-in test runner — `require('node:test')` + `require('node:assert/strict')` (per `package.json:15` → `node --test src/**/__tests__/**/*.test.js`). NOT Jest/Vitest (none installed). Mirrors `geminiModelRotator.test.js` and `askService-sse.test.js`.
**Target Platform**: Electron desktop app (macOS + Windows); renderer is Chromium, main is Node. The Live Answer lane renders only in the content-protected `listen` window.
**Project Type**: Single project (Electron app; `src/` main-process services + `src/ui/` renderer components). No web/mobile split for this feature.
**Performance Goals**: First streamed token visible ~1–2 s after the answer-lane debounce (800 ms) fires; STT already debounces 2 s upstream (`COMPLETION_DEBOUNCE_MS`, `sttService.js:6`) so the two compound and streaming hides residual latency. Render is incremental (re-parse per delta), single `innerHTML` swap per frame.
**Constraints**: Additive-only (FR-017); two-arg `createStreamingLLM` with full model wiring (C1/FR-008); streaming-aware PASSIVE before render (C2/FR-010); hold-last on suppress + abort-replace, never blank (Q1/G3/FR-015); reset folded into `resetConversationHistory`, no `listenService.js` edit (C4/D4/FR-011); `promptTemplates.js` stays closed (C7/FR-006); answer renders ONLY in the content-protected listen window — content protection MUST NOT be disabled (load-bearing safety invariant).
**Scale/Scope**: Single local user; ~1 streamed LLM call per detected interviewer question (not per turn). 1 new component + 1 new test file; additive edits to 3 files (`summaryService.js`, `preload.js`, `ListenView.js`).
**System Context**: Framework-internal `glass` Electron interview-assistant app. **No Cover Whale system involved.** No databases (in-memory). One integration: the configured LLM provider via the existing model-state config + streaming factory (Gemini mid-stream failover is internal to the provider and carries over via the `_reset` sentinel).
**Architecture Docs Read**: In-repo `ARCHITECTURE.md` (referenced in System Context); migrated `./design.md` (prose authoritative, code sketch superseded by C1–C8); `./prompts.md` (UX framing — S3/Orion/telematics residue ignored per spec note). cw-documentation is N/A (framework-internal change; confirmed in spec System Context).

## Constitution Check
*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Gate | Status |
|-----------|------|--------|
| I. Test-First (NON-NEGOTIABLE) | Pure helpers (`isLikelyQuestion`, `normalizePassive`/`parseAnswerOrPassive`, `shouldTriggerAnswer`) + the extracted SSE consumer get failing `node:test` tests FIRST, then implementation | **PASS** — TDD ordering baked into Phase 2 task order (tests precede impl). Test runner verified (`package.json:15`). |
| II. Specification-Driven | `/specify` → `/clarify` (Session 2026-05-31) → `/plan` (this) → `/tasks` → `/preflight` → `/feature-start` → `/implement` | **PASS** — clarification gate satisfied; artifacts generated by tooling, not hand-authored. |
| III. Verification Before Completion | Every FR maps to a unit/integration test or an explicit manual-verification rationale; T-VERIFY-UNIT gate runs `node --test` | **PASS** — see Phase 0.1 Testing Strategy + Test Type Classification. |
| IV. Skills Before Action | `memory-retrieval` invoked inline (Phase 0.7.5); no `ui-design-system`/`figma` needed (derived mockup — sibling `SummaryView`); no `db-orm` (no schema); no `debug-cw` (feature-major, no display_id) | **PASS** — applicable skills invoked; non-applicable ones justified. |
| V. Code Review Compliance | Additive design, error handling specified (Phase 0.6), screen-share safety invariant enforced, pattern-mirrored on `askService`/`SummaryView` | **PASS** — review-ready; no security regressions (renders only in content-protected window). |

### AI & Machine Learning (Constitution Principle IV)

**Does this feature involve AI/ML?**
- [x] **Yes** — it issues a streaming LLM call per detected interviewer question.

This is a thin reuse of the existing, already-integrated LLM path (the same `pickle_glass_analysis` prompt and `createStreamingLLM` factory the Ask and Summary lanes already use). It introduces **no new model, no new training, no new provider plumbing, and no autonomous decision surface** beyond "answer the question or stay silent (PASSIVE)". The table below is scoped to what this additive lane actually does.

| Requirement | Implementation | Status |
|-------------|----------------|--------|
| Transparency Layer | The rendered answer IS the explanation — the model answers the interviewer's question directly per the prompt's primary directive; the candidate reads it. No hidden inference surface. | [x] Planned |
| Confidence Scores | N/A for v1 — surfaces the answer text only; no per-answer confidence score (would add UI not in scope). The heuristic favors recall and lets PASSIVE suppress (documented). No existing lane shows confidence, so this is not a regression. | [x] N/A (justified) |
| Decision Rationale | The "decision" is binary: answer vs PASSIVE. PASSIVE = silent (panel holds last answer). The rationale (a question was detected) is implicit in the answer appearing. | [x] Planned |
| Audit Trail | The lane logs trigger/suppress/stream-error events to the local console (main process); the answer text itself MUST NOT be logged to any capturable sink (safety invariant). In-memory only; not persisted (C8). | [x] Planned |
| User Explanations | The "Live Answer" panel title labels the lane; the candidate sees the streamed answer directly. | [x] Planned |

**XAI Checklist**:
- [x] AI decisions are explainable to end users — the answer is the output; PASSIVE = silence.
- [x] Confidence scores accompany all AI-generated content — **N/A for v1** (no score UI; recall-oriented heuristic + PASSIVE documented). Not a regression — no existing lane shows confidence.
- [x] Users can understand WHY a recommendation was made — an answer appears only when a `them:` question is detected; otherwise silence.
- [x] AI inputs and outputs are logged for audit — trigger/suppress/error events logged; **answer text deliberately NOT logged** (screen-share safety; see Enforcement Strategy).
- [ ] Human override mechanism exists for AI decisions — **v2 (out of scope)**: a manual "answer now / re-roll" affordance is explicitly deferred (spec Out of Scope). v1 is auto-only (D1).
- [x] AI failures are handled gracefully with clear messaging — no-model/stream-error/PASSIVE all degrade to "panel keeps last answer" silently (Phase 0.6 registry); no crash.

## Project Structure

### Documentation (this feature)
```
specs/2026-05-30-interview-live-answer/
├── plan.md              # This file (/plan command output)
├── spec.md              # Feature spec (input)
├── design.md            # Migrated validated design (prose authoritative; code sketch superseded by C1–C8)
├── prompts.md           # Migrated UX brief
├── research.md          # Phase 0 output (/plan command)
├── data-model.md        # Phase 1 output (/plan command)
├── quickstart.md        # Phase 1 output (/plan command)
├── contracts/           # Phase 1 output (/plan command)
│   ├── live-answer.contracts.d.ts   # TS ambient contracts: pure helpers + service surface + IPC payload
│   └── EDGE_CASES.md                # Edge-case enumeration tied to contracts
└── tasks.md             # Phase 2 output (/tasks command - NOT created by /plan)
```

### Source Code (repository root)
```
src/
├── features/
│   └── listen/
│       └── summary/
│           ├── summaryService.js          # EDIT (additive): triggerAnswerIfNeeded, makeLiveAnswer,
│           │                              #   resetLiveAnswer (folded into resetConversationHistory),
│           │                              #   pure helpers isLikelyQuestion / normalizePassive /
│           │                              #   parseAnswerOrPassive / shouldTriggerAnswer; add createStreamingLLM import
│           └── __tests__/
│               └── liveAnswer.test.js      # NEW: node:test unit + (mocked-stream) integration tests
├── ui/
│   └── listen/
│       ├── ListenView.js                  # EDIT (additive): import LiveAnswerView; <live-answer-view>
│       │                                  #   above <summary-view> (:681); resetAnswer() in reset block (:467-469)
│       └── summary/
│           ├── SummaryView.js             # UNTOUCHED (visual reference + lib-loading pattern source)
│           └── LiveAnswerView.js          # NEW: Lit component; self-loads marked/hljs/DOMPurify;
│                                          #   streaming markdown render; resetAnswer()
└── preload.js                             # EDIT (additive): onLiveAnswerUpdate +
                                           #   removeAllLiveAnswerUpdateListeners in summaryView namespace (:205)

# CLOSED / untouched (FR-017): makeOutlineAndRequests, summary-update channel, SummaryView.js,
#   promptTemplates.js, askService.js, featureBridge.js, listenService.js
```

**Structure Decision**: Single Electron project. New code hangs off existing seams: the service logic extends `summaryService.js` (main process); the view is a new Lit component beside `SummaryView.js` (renderer); IPC rides the existing `summaryView` preload namespace with a NEW channel. The test file lives under a `__tests__/` dir matching the `node --test src/**/__tests__/**/*.test.js` glob. No new top-level directories.

## Phase 0.1: Research & Testing Strategy
*MANDATORY - Always execute this phase*

### Production Log & Error Evidence
*REQUIRED if spec front-matter `critical_requirements.type: bugfix` OR spec contains a CW-context 12-digit `display_id`*

**Skip condition MET**: Spec front-matter is `critical_requirements.type: feature-major` (NOT `bugfix`), and the spec contains **no CW 12-digit `display_id`** (framework-internal `glass` change; no Cover Whale system involved — confirmed in System Context). Per the template skip condition ("Spec is a new feature AND contains no CW display_id → skip to Research") and the `/plan` bugfix-detection gate, the production SigNoz/Sentry log search does not apply. No `debug-cw` invocation required.

`PREMISE L1: not-applicable — feature-major, no CW display_id, no production-log surface (framework-internal Electron app).`

### Research

Technical Context has **zero NEEDS CLARIFICATION** markers — every integration point was verified against live code during this plan (citations below). No research agents were dispatched; instead each load-bearing citation was confirmed by reading the source. Consolidated decisions live in `research.md`. What was verified:

1. **`createStreamingLLM(provider, opts)` is two-arg** — confirmed at `factory.js:128` (`createStreamingLLM(provider, opts)`; `openai-glass`→`openai` remap; `sanitizeModelId`). The design doc's `createLLM({...})` single-object sketch is WRONG (C1). `summaryService.js` currently imports only `createLLM` (`:3`) → the new code MUST add the `createStreamingLLM` import.
2. **SSE consumption shape** — confirmed at `askService._processStream` (`askService.js:401-474`): `data:` line split, `[DONE]` finalize (`:419`), `json._reset` discard + `responseHadFallback=true` (`:426-432`), `json._final_model` record (`:435-439`), `json.choices?.[0]?.delta?.content` append (`:441-446`), `AbortError` swallowed when `signal.aborted` (`:452-454`). Wiring (`getCurrentModelInfo('llm')` guard `:249-252`, `createStreamingLLM` `:308-314`, `AbortController` `:236`, `.streamChat` `:317`) confirmed.
3. **Prompt + injection** — `pickle_glass_analysis` at `promptTemplates.js:238` with primary directive at `:249`; native passive phrase "Not sure what you need help with right now" at `:388`. Injection pattern `getSystemPrompt('pickle_glass_analysis','',false).replace('{{CONVERSATION_HISTORY}}', recent)` confirmed at `summaryService.js:93-94`. `promptTemplates.js` stays closed (C7).
4. **Hub + lifecycle** — `addConversationTurn` (`:38`) calls `triggerAnalysisIfNeeded()` (`:45`/`:305`); `resetConversationHistory` (`:52`); `sendToRenderer` targets the `listen` window with an `isDestroyed()` guard (`:29-36`); `formatConversationForPrompt` (`:65`, maxTurns default 30). The listen window is NOT destroyed on Stop → `isDestroyed()` alone does NOT guard a late timer (C4/FR-012) → the debounce callback must also bail on empty history.
5. **STT upstream debounce + speaker labels** — `COMPLETION_DEBOUNCE_MS = 2000` at `sttService.js:6`; speakers `'Me'` (`:82`) / `'Them'` (`:109`). Confirms the 800 ms answer-lane debounce compounds with the 2 s upstream debounce (C3) and the `them` speaker gate (FR-001).
6. **Renderer plumbing** — `summaryView` preload namespace at `preload.js:205-213` (existing `summary-update` listeners to mirror; new channel added beside, original untouched). `ListenView` mounts `<summary-view>` at `:681-684`, resets children at `:467-469`. `SummaryView` lib loading is idempotent (`if(!window.marked)` `:293`), plain-text fallback at `:359`, single-`innerHTML` swap with DOMPurify at `:375-397` (FR-015 mirror source).
7. **Safety invariant** — `listen.setContentProtection(...)` at `windowManager.js:507`; default `contentProtection: true` at `src/features/settings/settingsService.js:217`. (Spec cited the dir shorthand `settingsService.js:217`; actual path is `src/features/settings/settingsService.js` — line number correct.) The answer renders only in this content-protected window.
8. **Test runner + pattern** — `package.json:15` = `node --test src/**/__tests__/**/*.test.js`. The existing `askService-sse.test.js` already demonstrates the "extract the SSE loop into a standalone pure function to avoid Electron coupling" strategy — directly reusable for FR-009/FR-018. `geminiModelRotator.test.js` confirms `require('node:test')` + `require('node:assert/strict')`.

**Output**: `research.md` (decisions, rationale, alternatives, verified-citation table).

### Testing Strategy

| Check | Output |
|-------|--------|
| External APIs | Configured LLM provider (streaming) via `createStreamingLLM` → Risk: **MED** (cost-bounded by `maxTokens`, already integrated, Gemini failover internal). No new HIGH-RISK quota API. |
| Test types | Unit (pure helpers + extracted SSE/PASSIVE parser) + Integration (mocked/injected stream: debounce coalescing, de-dup, reset/race, lane independence). No Contract HTTP, no E2E. |
| E2E permitted? | **No** — no automated Electron-renderer or live-audio harness in this repo; renderer visuals + end-to-end audio path are manual-verification (≤5%). Not blocked by HIGH-RISK (provider is mocked everywhere). |
| Mocking strategy | LLM provider → inject a small fake `createStreamingLLM`/`streamChat` seam returning a synthetic SSE `ReadableStream` (mirror `askService-sse.test.js`'s standalone-function approach); timers → fake/injectable clock for the 800 ms debounce; `sendToRenderer` → spy. No live provider calls anywhere in the suite. |

**Testing Summary**:
```
Feature type: Mixed (pure-logic core + Electron UI/IPC shell)
Quota risks: None (LLM provider mocked in all tests; cost-bounded in prod by maxTokens=900 + debounce + optional min-interval)
Estimated tests: ~14–18
Distribution: Unit ~60%, Contract 0%, Integration ~35%, E2E 0% (+ ~5% Static/Manual)
```

**Test Type Classification** (from spec, mapped to plan):
| FR | Primary Test Type | Notes |
|----|-------------------|-------|
| FR-001 (speaker gate) | Unit | `shouldTriggerAnswer` truth-table: `me:`→no, `them:`→eligible |
| FR-002 (heuristic) | Unit | `isLikelyQuestion` truth-table (`?` tail, opener keywords, negatives) |
| FR-003 (debounce coalescing) | Integration (fake clock) | rapid `them:` segments → exactly one call |
| FR-004 (de-dup/in-flight) | Unit + Integration | same normalized tail → one trigger; in-flight → skip/abort-replace |
| FR-009 (stream consumption) | Integration (mocked stream) | `[DONE]`/`_reset`/`_final_model`/`delta.content` like askService |
| FR-010 (PASSIVE) | Unit | `normalizePassive`: `PASSIVE`/`PASSIVE.`/`**PASSIVE**`/native phrase → suppress; real answer → keep |
| FR-011/FR-012 (reset/race) | Integration (mocked stream + clock) | close mid-debounce aborts stream + clears timer; no throw, no emit |
| FR-017 (independence) | Integration (mocked stream) | `summary-update` still fires on its 5-turn cadence while answers stream |

**⚠️ GATE**: HIGH-RISK APIs → E2E FORBIDDEN. **Not triggered** — provider is MED risk and mocked; no E2E planned regardless.

**Output**: `research.md`, Testing Strategy documented.

## Phase 0.2: Permissions Design
*CONDITIONAL - Skip if no roles/permissions in spec*

**Skip condition PARTIALLY met**: The spec has a "Permissions & Access Control" section, but it explicitly records **no role system, no server routes, no multi-tenant scoping** (single local Electron user). There is therefore **no permission resource/action matrix and no dual-layer API+UI enforcement** to design. The one access-relevant property is the **screen-share safety invariant**, carried below (the spec's load-bearing "Enforcement Strategy").

### Screen-Share Safety Enforcement (load-bearing — replaces the permission matrix)

| Invariant | Enforcement | Verified |
|-----------|-------------|----------|
| The Live Answer panel renders ONLY inside the content-protected `listen` window | `sendToRenderer` targets `windowPool.get('listen')` (`summaryService.js:29-36`); the `listen` window has `setContentProtection(...)` applied (`windowManager.js:507`) with default `contentProtection: true` (`settingsService.js:217`). | ✅ live code |
| Content protection MUST NOT be disabled by this feature | The implementation adds NO call to `setContentProtection(false)` and touches no window-creation/protection code. `windowManager.js` is not in the edit set. | ✅ design |
| The answer text MUST NOT reach any capturable sink | Trigger/suppress/error events may be logged; the **answer text itself is never logged** to console or any renderer outside the protected listen window. | ✅ design (enforced in task acceptance) |

**Data Scoping**: User-scoped (single local user; conversation history in-memory in the local process).

**⚠️ GATE**: No server permissions to enforce (N/A roles). Screen-share invariant documented and verified → proceed.

**Output**: Screen-share enforcement documented (no permission matrix — single-user app).

## Phase 0.3: Integration Analysis
*MANDATORY - Always execute this phase*

### Codebase Pattern Discovery

| Pattern Area | Finding |
|--------------|---------|
| Speaker labels | `'Me'` (mic) / `'Them'` (system audio) string constants from `sttService.js:82,109`; stored lowercased in history (`addConversationTurn`: `${speaker.toLowerCase()}: ...`). Gate on `speaker.toLowerCase() === 'them'`. |
| LLM resolution | `await modelStateService.getCurrentModelInfo('llm')` → `{provider, apiKey, model}`; guard `!modelInfo || !modelInfo.apiKey` (mirrors `summaryService.js:101-104` and `askService.js:249-252`). |
| Streaming factory | `createStreamingLLM(provider, opts)` two-arg (`factory.js:128`); opts `{apiKey, model, temperature, maxTokens, usePortkey, portkeyVirtualKey}`; `.streamChat(messages)` returns a fetch-style `Response` whose `response.body.getReader()` is read. |
| SSE sentinels | `data:` prefix; `[DONE]`; `_reset` (discard + hadFallback); `_final_model`; `choices[0].delta.content`. Parsed in `askService._processStream:416-446`. |
| Markdown render | `loadLibraries` idempotent (`if(!window.marked)`); `parseMarkdown` plain-text fallback when libs absent (`SummaryView.js:359`); `renderMarkdownContent` DOMPurify-sanitize + single `innerHTML` assign (`:375-397`). |
| IPC | Main → renderer via `webContents.send(channel, data)`; preload exposes `ipcRenderer.on(channel, cb)` + `removeAllListeners(channel)` in a namespaced object (`preload.js:205`). |
| Lit component | Class extends `LitElement`; `static properties`; `connectedCallback`/`disconnectedCallback` register/teardown IPC listeners; `updated()`/`requestUpdate()` drives re-render; visibility via an `isVisible` reactive prop bound to `viewMode === 'insights'`. |
| Test runner | `node:test` + `node:assert/strict`; extract pure logic into standalone functions to avoid Electron coupling (`askService-sse.test.js`). |

### Data Contracts

| Entity | Service (main) Format | IPC Payload | UI (renderer) Format |
|--------|----------------------|-------------|----------------------|
| Conversation turn | `"${speaker.toLowerCase()}: ${text.trim()}"` lines in `conversationHistory[]` | (input only — not sent over the new channel) | N/A |
| Live answer | `{ answer: string, ts: number }` accumulated during stream | `live-answer-update` → `{ answer: string, ts: number }` (full accumulated text each delta, mirroring askService's `currentResponse` broadcast) | `liveAnswer: String` prop → parsed+sanitized markdown → single `innerHTML` swap |
| Answer-lane state | `lastAnsweredTail: string`, debounce timer handle, `inFlightController: AbortController`, `inFlight: boolean` — all on the service instance | (not sent) | N/A |

### Code Interconnectedness Gate

| Pattern Needed | Source (read evidence) | Decision |
|----------------|------------------------|----------|
| Conversation hub to hang the trigger on | `addConversationTurn` calls `triggerAnalysisIfNeeded()` at `summaryService.js:45` | **EXTEND** — add `this.triggerAnswerIfNeeded(speaker, text)` call beside it |
| Model resolution + guard | `summaryService.js:101-104`; `askService.js:249-252` | **REUSE** — identical `getCurrentModelInfo('llm')` + `!modelInfo||!apiKey` guard |
| Streaming factory | `createStreamingLLM` exported `factory.js:128,182` | **REUSE** — two-arg call (C1) |
| SSE stream consumer | `askService._processStream` `askService.js:401-474` | **REUSE pattern (copy shape, do NOT import askService)** — FR-017 forbids touching askService; replicate the loop locally + extract the pure parse step into a testable function (mirror `askService-sse.test.js`) |
| System-prompt assembly | `summaryService.js:93-94` | **REUSE** — same `getSystemPrompt(...).replace('{{CONVERSATION_HISTORY}}', recent)` |
| `formatConversationForPrompt` | `summaryService.js:65` (maxTurns=30) | **REUSE** — call directly |
| `sendToRenderer` (listen-window-targeted, `isDestroyed()`-guarded) | `summaryService.js:29-36` | **REUSE** — emit `live-answer-update` through it |
| Markdown rendering (load + sanitize + fallback) | `SummaryView.js:291-344,359,375-397` | **REUSE pattern** — `LiveAnswerView` replicates the idempotent loader + render path (do NOT subclass `SummaryView`; FR-017 keeps it untouched) |
| preload namespace | `preload.js:205-213` | **EXTEND** — add two listeners beside the existing `summary-update` ones |
| view mount + reset | `ListenView.js:681-684,467-469` | **EXTEND** — `<live-answer-view>` above `<summary-view>` + `resetAnswer()` beside `resetAnalysis()` |

**Evidence**: All ten rows confirmed by reading the cited lines during this plan (Phase 0.1 Research items 1–8). No DUPLICATE decisions — every reuse either calls existing code directly or replicates a pattern in NEW additive code to honor FR-017's "untouched" set.

### Contract Validation (new interfaces)

A TypeScript ambient-declaration contract for the pure helpers, the service surface, and the `live-answer-update` IPC payload is generated at `contracts/live-answer.contracts.d.ts`. Because the repo is plain JS (no `tsc` in the toolchain), the contract is a `.d.ts` **design artifact** validated for self-consistency with `tsc --noEmit` against the contracts dir (declaration-only; expected "Found 0 errors"). It is NOT wired into the build — it documents the shapes `/tasks` and `/implement` must honor and seeds the EDGE_CASES enumeration.

**⚠️ GATE**: read evidence pasted, contract shapes defined → proceed. (`tsc --noEmit` over a declaration-only file is a design check, not a build gate — see `contracts/EDGE_CASES.md` header note.)

**Output**: Integration analysis documented, code reuse verified, contracts authored.

## Phase 0.4: Design Pre-flight
*CONDITIONAL - Skip if Backend-only or Minor UI*

UI classification is **Moderate** (one new component sharing an existing pane; new IPC channel; streaming render) → executed. No external Figma; the derived visual reference is the sibling `SummaryView`. `ui-design-system`/`figma` skills not invoked (no external design source to convert; the component mirrors an existing in-repo component).

### Mockup Review

| FR | UI Element | Mockup? | Component / Source |
|----|-----------|---------|--------------------|
| FR-014 | `<live-answer-view>` container in insights pane, ABOVE `<summary-view>` | Derived | NEW `LiveAnswerView` Lit element; layout mirrors `SummaryView` title + body |
| FR-014 | "Live Answer" panel title | Derived | mirror `SummaryView`'s section-title styling |
| FR-015 | Streamed, sanitized markdown body | Derived | `marked`/`hljs`/`DOMPurify` window globals (reused); `data-markdown`/single-`innerHTML` swap pattern from `SummaryView.js:375-397` |
| FR-010/Q1/G3 | Hold-last render (no blank between answers) | Derived | single content assignment on first flushed token; never clear to empty |
| FR-014 | Visibility tracks `viewMode === 'insights'` | Derived | `.isVisible=${this.viewMode === 'insights'}` like `<summary-view>` |

### Component Gaps

| Gap Component | Build Effort | Strategy |
|--------------|--------------|----------|
| `LiveAnswerView` (Lit element) | ~3–4 h | Build new, structurally cloning `SummaryView`'s loader + render path; trim to a single answer body (no topic/actions parsing) |

**Total gap effort**: ~3–4 h (component) + service/test work tracked in Phase 2.

### Design Token Compliance

- [x] Colors/spacing/typography reuse `SummaryView`'s existing component-scoped styles and the shared `insights-container` (this app uses component-scoped CSS, not Tailwind tokens). The lane introduces no new palette.

**⚠️ GATE**: Derived mockup defined against the sibling component, single gap documented → proceed.

**Output**: Component inventory captured here (no separate `component-inventory.md` — one component, derived from an existing sibling).

## Phase 0.5: Infrastructure & Migrations
*CONDITIONAL - Skip if no infra changes, migrations, or deprecations*

**Skip condition MET**: No environment variables, no SSM, **no database migrations** (in-memory only, C8 — the `summaryRepository.saveSummary` path is deliberately not extended), and **no deprecations** (purely additive; FR-017 deprecates nothing). No deployment ordering (single in-process Electron change; ships with the app build). `db-orm` not invoked. → Skip to Phase 0.6.

**Rollout**: [x] Immediate (additive, in-process; behind no flag — the lane self-gates on a detected `them:` question and a configured model).

## Phase 0.6: Error/Rescue Mapping
*CONDITIONAL - Skip if spec has no Error Handling section or no service modules*

Executed — `summaryService` is a service module with a populated Error Handling section. Registries below carry implementation-specific exception classes and rescue actions.

**Error/Rescue Registry**:
| Method/Codepath | What Can Go Wrong | Exception Class | Rescued? | Rescue Action | User Sees |
|-----------------|-------------------|-----------------|----------|---------------|-----------|
| `summaryService.makeLiveAnswer` (model resolve) | No model / no API key | `Error('AI model or API key is not configured.')` (thrown, mirrors `:103`) | Y | Catch in `triggerAnswerIfNeeded`/`makeLiveAnswer` wrapper, `console.warn`, emit nothing, clear `inFlight` | Panel keeps last answer |
| `summaryService.makeLiveAnswer` (stream loop) | Provider stream/network error mid-answer | `Error` / `TypeError` (provider/fetch) | Y | Abort controller, `console.error`, retain whatever rendered, clear `inFlight` | Partial or last answer retained |
| `summaryService.makeLiveAnswer` (deliberate abort) | Stream aborted for a new question or on close | `AbortError` (`err.name === 'AbortError'` or `signal.aborted`) | Y | **Swallow** — expected control flow (mirror `askService.js:452-454`); do NOT log as error | Nothing (replaced by new stream, or silence on close) |
| `triggerAnswerIfNeeded` debounce callback | Fires after session reset (Stop/Start race) | `TypeError` on torn-down refs / stale state | Y | Bail if `conversationHistory.length === 0`; rely on `AbortController.abort()` + cleared timer from `resetLiveAnswer` | Nothing (no throw, no emit) |
| `LiveAnswerView.renderMarkdownContent` | `marked`/`DOMPurify` undefined (libs not yet attached) | `TypeError` | Y | Fall back to escaped plain text (mirror `SummaryView.js:359`); upgrade to markdown once libs attach | Plain-text answer |
| `LiveAnswerView` (DOMPurify removed unsafe content) | Sanitizer strips markup | (no throw) | Y | Show `'⚠️ ' + plain text` (mirror `SummaryView.js:390-393`) | Plain-text answer with warning glyph |

**Failure Modes Registry**:
| Codepath | Failure Mode | Rescued? | Test? | User Sees? | Logged? |
|----------|-------------|----------|-------|------------|---------|
| `makeLiveAnswer` (no model) | clean no-op | Y | Y (integration) | last answer | Y (warn) |
| `makeLiveAnswer` (stream error) | abort, retain rendered | Y | Y (integration) | partial/last | Y (error) |
| `makeLiveAnswer` (deliberate abort) | swallow AbortError | Y | Y (integration) | new stream / silence | N (expected) |
| debounce callback (post-reset) | bail, no emit | Y | Y (integration) | nothing | Y (debug) |
| PASSIVE suppression | emit nothing | Y | Y (unit) | last answer | optional |
| markdown libs absent | plain-text fallback | Y | Y (unit/render helper) | plain text | N |

**GATE**: Zero rows with `Rescued=N + Test=N + User Sees=Silent`. **PASS** — every silent path is rescued AND tested. (The one intentionally-unlogged row, deliberate `AbortError`, is rescued + tested + the user sees a deterministic replacement/silence — by design, not a gap.)

**Output**: Populated registries above.

## Phase 0.7: Implementation Timeline Risks
*MANDATORY - Always execute this phase*

| Phase | Anticipated Blocker | Resolution | Add to Task Context? |
|-------|--------------------|------------|---------------------|
| Phase 1 (pure helpers, TDD) | Implementer may reach for Jest matchers or assume a test framework is installed. | Tests MUST use `require('node:test')` + `require('node:assert/strict')` (per `package.json:15`); mirror `geminiModelRotator.test.js` / `askService-sse.test.js`. Place under `src/features/listen/summary/__tests__/liveAnswer.test.js` to match the glob. | **Y** — every test task. |
| Phase 1 (pure helpers) | `normalizePassive` scope creep — over-fitting markdown stripping. | Spec is precise: strip markdown emphasis/punctuation/whitespace + uppercase; equal-match `PASSIVE` OR the native phrase "Not sure what you need help with right now" (`promptTemplates.js:388`). Prefix-buffer = first newline or ~16 chars. Don't invent more cases. | **Y** — `normalizePassive`/`parseAnswerOrPassive` task. |
| Phase 2 (core logic — `makeLiveAnswer`) | Reaching for the design doc's WRONG `createLLM({...})` single-arg sketch. | C1/FR-008 is LOCKED: two-arg `createStreamingLLM(provider, {apiKey, model, temperature:0.7, maxTokens:900, usePortkey: provider==='openai-glass', portkeyVirtualKey: provider==='openai-glass'?apiKey:undefined})`. `summaryService.js` must ADD the `createStreamingLLM` import (it currently imports only `createLLM`, `:3`). | **Y** — `makeLiveAnswer` task. |
| Phase 2 (core logic — streaming) | Re-implementing the whole-string `content.trim() === 'PASSIVE'` check from the design sketch (insufficient for a stream). | FR-010/C2 is LOCKED: prefix-buffer until first newline or ~16 chars → `normalizePassive` → suppress-before-render; else flush + stream. Hold last answer on suppress AND during abort-replace (Q1/G3 — never blank). | **Y** — streaming-orchestrator + PASSIVE tasks. |
| Phase 2 (core logic — SSE) | Importing `askService._processStream` (forbidden — FR-017 keeps askService untouched). | Replicate the loop locally in `makeLiveAnswer`; extract the pure per-line parse into a testable function (mirror `askService-sse.test.js`'s `processSseLines`). Honor `_reset` (discard + set `hadFallback`), `_final_model`, `delta.content`, `[DONE]`. | **Y** — SSE task. |
| Phase 3 (integration — reset/race) | Editing `listenService.js` (forbidden — D4) or trusting `isDestroyed()` to guard the late timer. | C4/FR-011/FR-012 is LOCKED: fold `resetLiveAnswer()` INTO `resetConversationHistory()` (`summaryService.js:52`) — listenService already calls it at `:146`/`:247`. The listen window is NOT destroyed on Stop (`listenService.js:72-78`), so `isDestroyed()` does NOT protect a late timer → the debounce callback ALSO bails on empty history. **Prior lesson** (see Prior Lessons Applied): treat a deliberate Stop as deliberate — abort + clear, never retry/reconnect. | **Y** — `resetLiveAnswer` + debounce-guard tasks. |
| Phase 3 (integration — IPC/UI) | Sending on the existing `summary-update` channel, or blanking the panel between answers. | New channel `live-answer-update` ONLY; `summary-update` untouched (FR-013/FR-017). `LiveAnswerView` holds the last rendered markdown until the first new token, then a single `innerHTML` swap (FR-015/Q1) — never clears to empty. | **Y** — preload + LiveAnswerView tasks. |
| Phase 4 (polish/tests) | Forgetting the screen-share safety check; logging the answer text. | Acceptance for the UI/service tasks: the answer renders only in the content-protected listen window; NO call disables content protection; the answer text is never logged to a capturable sink. Trigger/suppress/error events may log (no answer body). | **Y** — verification task (T-VERIFY). |

**Output**: Timeline risks documented; each row flagged for task context in `/tasks`.

## Decision Drivers

- **Open-Closed / additivity (G2, FR-017)** drives every structural choice: replicate patterns rather than refactor shared code; keep `summary-update`, `SummaryView`, `askService`, `promptTemplates`, `featureBridge`, `listenService` untouched.
- **No-flicker UX (G3, Q1)** drives the hold-last render contract and the streaming-aware PASSIVE prefix-buffer.
- **TDD (Constitution I)** drives the extract-pure-helpers-first structure and the `node:test` runner choice.
- **Screen-share safety (load-bearing invariant)** drives the "render only in the content-protected listen window, never log the answer" constraint.
- **Cost containment (MED-risk LLM)** drives the heuristic pre-filter + PASSIVE + 800 ms debounce + optional (default-OFF) min-interval.

## Prior Lessons Applied

| Confidence | Lesson | Source | Applied How |
|------------|--------|--------|-------------|
| 0.80 | stt-session-not-active-is-stopstart-race: Glass "User/Their STT session not active" is a Stop/Start capture race, not a Deepgram drop — a deliberate close (reason `client`, code 1000) must be treated as deliberate; reconnect/cleanup must NOT fight an intentional Stop. (type: project) | `stt-session-not-active-is-stopstart-race.md` | Directly informs C4/FR-011/FR-012: a late debounce timer or in-flight stream firing after a deliberate Stop is the same race class. `resetLiveAnswer()` MUST abort + clear (never retry/reconnect), and the debounce callback MUST bail on empty history because the listen window is NOT destroyed on Stop — so `isDestroyed()` alone cannot guard the late timer. Treat Stop as deliberate; do not reconnect or re-fire. |

*(Retrieval run inline per Phase 0.7.5 against the Overview + Technical Context surface. One entry cleared the 0.55 threshold; score 0.80 from keyword + name/desc-overlap + filename-slug sources with a +0.05×2 multi-source boost, capped well under 0.97 — consistent with the spec's `## Related Memory` score. The personal memory dir holds no other substantive entry.)*

## Phase 1: Design & Contracts
*Prerequisites: Phases 0.1–0.7 complete*

1. **Entities** → `data-model.md`: Conversation turn (read-only input), Live answer (transient `{answer, ts}`), Answer-lane state (`lastAnsweredTail`, timer handle, `AbortController`, `inFlight`). Includes pure-helper signatures, the trigger-gate state machine, and the locked tuning-defaults table.
2. **Contracts** → `contracts/live-answer.contracts.d.ts`: ambient `.d.ts` declaring `isLikelyQuestion(text: string): boolean`, `normalizePassive(text: string): string`, `parseAnswerOrPassive(prefix: string): { passive: boolean; flush: string }`, `shouldTriggerAnswer(speaker, text, lastAnsweredTail, inFlight): boolean`, the `makeLiveAnswer`/`triggerAnswerIfNeeded`/`resetLiveAnswer` service surface, and the `LiveAnswerUpdatePayload = { answer: string; ts: number }` IPC shape. (No REST/GraphQL endpoints — this is in-process IPC, so the "contract" is the helper signatures + IPC payload, not an OpenAPI schema.)
3. **Contract self-check**: `tsc --noEmit` over the declaration-only contracts dir → expect "Found 0 errors" (design validation; not a build wire-in). Documented in `contracts/EDGE_CASES.md`.
4. **Test scenarios** → `quickstart.md`: maps each Acceptance Scenario (1–8) and edge case to a `node:test` case or an explicit manual-verification step, with the exact run command (`node --test src/features/listen/summary/__tests__/liveAnswer.test.js`).
5. **Update agent file**: run `.specify/scripts/bash/update-agent-context.sh claude` (adds only the new tech — Lit Web Component lane + node:test pattern; preserves manual sections; keeps under 150 lines). *Note: this script depends on the same SpecKit-home resolution as setup-plan.sh; if SpecKit home is not installed locally it is a best-effort no-op and does not block the plan — the agent-context file is a convenience, not a gate.*

**Output**: `data-model.md`, `contracts/live-answer.contracts.d.ts`, `contracts/EDGE_CASES.md`, `quickstart.md`.

## Phase 2: Task Planning Approach
*Executed by /tasks command, NOT /plan*

**Strategy**: TDD-first (Constitution I) — failing tests precede implementation for every pure helper and the extracted SSE/PASSIVE parser. Generate from Phase 1 docs, constrained by the ~14–18 test estimate.

| From | Task Type | Order |
|------|-----------|-------|
| Contracts (pure-helper signatures) | Unit tests [P] for `isLikelyQuestion`, `normalizePassive`/`parseAnswerOrPassive`, `shouldTriggerAnswer` (RED) | 1st |
| Pure helpers | Implement helpers to green | 2nd |
| Contracts (SSE payload) | Unit test for extracted SSE-line parser (mirror `askService-sse.test.js`) (RED) | 3rd |
| Service surface | Implement `makeLiveAnswer` (model wiring C1, stream loop, PASSIVE prefix-buffer C2) + `triggerAnswerIfNeeded` (4 gates) + `resetLiveAnswer` folded into `resetConversationHistory` | 4th |
| Stories (Acceptance 3,4,5,6,8) | Integration tests against an injected/mocked stream + fake clock: debounce coalescing, de-dup, abort-replace, PASSIVE suppress, mid-debounce close | 5th |
| Renderer plumbing | `preload.js` two listeners; `LiveAnswerView.js` (loader + render + resetAnswer); `ListenView.js` mount + reset wiring | 6th |
| Lane independence (Acceptance 7) | Integration test: `summary-update` still fires on the 5-turn cadence while answers stream | 7th |
| Constitution gates | T-VERIFY-UNIT (`node --test`), T-VERIFY-LINT (`eslint`), screen-share safety verification | last |

**Constraints**: No E2E (no harness). LLM provider mocked before every integration test. `[P]` = parallelizable (independent pure-helper test files/cases).

## Progress Tracking

| Phase | Status | Skip If |
|-------|--------|---------|
| 0.1 Research + Testing | [x] | Never |
| 0.2 Permissions | [x] (N/A roles — screen-share invariant documented) | No roles in spec |
| 0.3 Integration | [x] | Never |
| 0.4 Design Pre-flight | [x] | Backend-only/Minor UI |
| 0.5 Infrastructure | [x] (skipped — no env/migrations/deprecations) | No env/migrations/deprecations |
| 0.6 Error/Rescue Mapping | [x] | No service modules or no error handling |
| 0.7 Timeline Risks | [x] | Never |
| 1 Design & Contracts | [x] | - |
| 2 Task Planning | [x] (approach documented; tasks.md deferred to /tasks) | - |

**Gates**: Constitution Check **PASS**. All NEEDS CLARIFICATION resolved (zero markers — every integration point verified against live code). Clarification gate satisfied (Session 2026-05-31). Error/Rescue gate **PASS** (no unrescued-untested-silent rows). Screen-share safety invariant documented + verified.

---
*Based on Constitution v2.1.1*

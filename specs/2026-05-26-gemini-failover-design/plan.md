# Gemini Failover — Implementation Plan

**Branch (target):** `feat/gemini-failover` (not yet created)
**Source spec:** `specs/2026-05-26-gemini-failover-design/spec.md`
**Source design:** `specs/2026-05-26-gemini-failover-design/2026-05-26-gemini-failover-design.md`
**Source brief:** `specs/2026-05-26-gemini-failover-design/prompt.md`
**Date:** 2026-05-26
**Status:** Ready for `/tasks` → implementation.

---

## 0. Pre-flight gate

| Gate | Status | Evidence |
|---|---|---|
| Clarifications section present in spec with ≥1 Session | PASS | `spec.md` § "Clarifications / Session 2026-05-26" contains 11 resolved IMPL GAPs. |
| Spec decisions locked | PASS | spec §1 "Five locked decisions" table; reaffirms `/workflow-brainstorm` design locks. |
| Confidence statement present | PASS | spec § "Confidence statement" enumerates 3 residual risks and confirms file paths/line ranges align. |
| Full design verbatim | PASS | spec §§2–6 inline the entire architecture, failover snippets, edge case table, and tests from the design doc. |
| Test plan present | PASS | spec §6 enumerates unit (§6.1), integration (§6.2), streaming (§6.3), SSE consumer (§6.4), manual smoke (§6.5). |
| All touched files exist on disk | PASS | verified: `gemini.js` (337 lines, matches design quote of 243-319), `askService.js` (478 lines, matches §407-432 SSE block), `AskView.js` (1442 lines, Lit element with `currentResponse` reactive prop confirmed at line 6), `SettingsView.js` (1557 lines, validator at 751-755 confirmed), `settingsService.js` (469 lines). |
| Constitution check | N/A | this repo has no `.specify/memory/constitution.md`; planning falls back to the spec's own §1 "Five locked decisions" + the brainstorm-locked design doc as the constitutional surface — same convention as the sibling `2026-05-25-ask-mode-shortcuts` plan. |
| System Context (mandatory) | DONE inline | Spec § "System Context" declares: framework-internal / personal project, no Cover Whale system involved. `doc-search` not invoked because there is no CW documentation surface for this Electron-app-internal change. Affected modules enumerated in the spec are all under `src/features/` and `src/ui/` of this repo. |
| Bugfix detection (debug-cw gate) | N/A | `critical_requirements.type: feature-major` (not `bugfix`); no CW 12-digit `display_id` in spec — no production log search applies. |
| Personal memory directory check | EMPTY | `~/.claude/projects/C--Users-thiago-soeiro-Documents-repos-glass-glass/memory/` does not exist. Per FR-008 fail-open contract, the `## Prior Lessons Applied` section is omitted entirely (NOT written as an empty table). |

Since the repo does not vendor the CW SpecKit framework (no `.specify/templates/plan-template.md`, no `setup-plan.sh`, no `.specify/memory/constitution.md`), this plan is authored directly using the spec's own structure — same convention as the sibling plan at `specs/2026-05-25-ask-mode-shortcuts/2026-05-25-ask-mode-shortcuts-plan.md`. No artifacts are generated under separate `research.md` / `data-model.md` / `contracts/` / `quickstart.md` files because the spec already inlines all those surfaces (architecture in §2, data model state in §2 "State", contracts in §3 sentinel JSON shapes, quickstart in §6.5 manual smoke tests).

---

## 1. Summary

Add a Gemini-only model failover layer that turns the existing single-model `selectedLlmModel` setting into a CSV priority list. A new in-memory rotator module (`geminiModelRotator.js`) tracks per-model cooldowns and classifies SDK errors as `transient` (cool down + try next), `fatal-request` (surface immediately — catches typos), or `fatal-auth` (surface immediately — shared API key). Both `createLLM` and `createStreamingLLM` wrap their inner Gemini SDK calls in a failover loop. For the streaming path, two new sentinel JSON shapes (`{_reset, next_model}` and `{_final_model}`) are emitted on the existing SSE channel; the `askService.js` consumer at lines 407-432 branches on them before the existing content path. The Ask response renderer (`AskView.js`, a Lit element — confirmed) gains two reactive properties (`responseModel`, `responseHadFallback`) and renders a muted footer (`answered by: <model>` or `answered by: <model> (fallback)`) propagated via the existing `ask:stateUpdate` IPC channel. STT is untouched in behavior — `createSTT` only reads the first CSV entry. No DB schema changes (the `selected_llm_model` SQLite column is plain TEXT). No new IPC channels. No new windows.

When a user configures a single model (no commas), behavior is byte-identical to today — the failover loop runs exactly once.

---

## 2. Technical context

| Field | Value |
|---|---|
| Language / Runtime | Electron 28+, Node 18+, vanilla JS (no TS in this repo) |
| Renderer framework | Lit (`lit-element` + `lit-html`); response renderer is `AskView extends LitElement` with `currentResponse` as a reactive property (line 6) |
| Persistence | SQLite via `providerSettingsRepository` — `selected_llm_model` column is plain TEXT, no length / format constraint, treats value as opaque |
| Settings key path | `selected_llm_model` (LLM), `selected_stt_model` (STT) — both keyed by active provider |
| IPC pattern | `webContents.send('ask:stateUpdate', this.state)` push (existing); no new channel required for the footer — reuses the existing state-broadcast |
| Streaming wire format | SSE (`data: <json>\n\n` lines, `data: [DONE]\n\n` terminator) consumed by `askService.js:407-432` |
| LLM SDK | `@google/generative-ai` — error envelope has `status` (HTTP-style number), `errorDetails[]` (array of `@type`-tagged objects, sometimes including `RetryInfo` with `retryDelay: "37s"`-style strings), occasionally a wrapped HTTP `Response` |
| Test runner | Jest (assumed; sibling spec used same; if absent the unit tests in §6.1 use `node:test` instead — implementer to confirm at P1 entry) |
| Stream-controller safety | Existing pattern at `gemini.js:248-250`: `if (controller.desiredSize === null) return false; try { controller.enqueue(chunk); return true } catch { return false }` — preserved verbatim, extended to also wrap `controller.error()` (impl-gap resolution in spec) |
| Sentinel field naming | Leading underscore (`_reset`, `_final_model`, `_modelUsed`) to keep them visually distinct from upstream OpenAI-shape fields and resistant to SDK schema evolution |

**Existing patterns this work reuses:**

| Pattern | Reference | Where used in this plan |
|---|---|---|
| `safeEnqueue` guard + `controller.close()` in try/catch | `gemini.js:248-250, 311` | New streaming failover loop; extended to wrap `controller.error()` too |
| SSE `data: <json>\n\n` framing | `gemini.js:307` | New sentinel emissions reuse same encoder |
| `state.currentResponse` broadcast via `this._broadcastState()` | `askService.js:425-426, 444-445` | `_reset` triggers an extra broadcast with `currentResponse = ''`; `_final_model` triggers a broadcast that sets `state.responseModel` |
| `ask:stateUpdate` IPC channel | `preload.js`, `AskView.js:789-805` | New `responseModel` + `responseHadFallback` ride the same `newState` envelope; renderer reads them in the existing subscriber |
| Free-text model-ID input | `SettingsView.js:745-773` (`handleSaveGeminiModels`) | Extended to validate every CSV entry starts with `gemini-`, not just the whole string |
| Module-level singleton with `Map<string, ...>` state | (general Node pattern) | `geminiModelRotator.js` uses `const health = new Map()` at module scope — singleton per impl-gap resolution |

**Architectural decision recap (no new decisions in plan — all carried from spec §1 and design doc):**

1. **Singleton rotator** (impl-gap resolution): the Gemini provider is already effectively a singleton inside the Electron process; multiple rotator instances would partition cooldown view and defeat the point.
2. **`markSucceeded` clears entries entirely** (impl-gap resolution): `health.delete(modelId)`. Cleanest representation — present in `health` ⇔ currently cooling down.
3. **`parseModelList(null|undefined)` returns `[]`** (impl-gap resolution): callers check `.length > 0` and throw a clear error. Friendlier than crashing inside `parseModelList`.
4. **`controller.error()` wrapped in try/catch** (impl-gap resolution): defense in depth on top of the existing `safeEnqueue` guard. Costs one `try/catch`, matches the pattern already at `gemini.js:311` for `controller.close()`.
5. **Renderer is `AskView.js`** (impl-gap resolution): confirmed by `Grep` on `currentResponse|responseModel|ask:stateUpdate` across `src/` and `pickleglass_web/`. State arrives via existing `ask:stateUpdate` — no new plumbing.
6. **`_reset` causes a single empty-content frame** (impl-gap resolution): accepted UX — the user SHOULD see the response start over because the first model failed. If visually jarring, follow-up work can add a throttle.
7. **CSV stored in `selected_llm_model` as opaque TEXT** (impl-gap resolution): no migration. `modelStateService.getCurrentModelInfo('llm')` returns the raw CSV; `sanitizeModelId` regex `/-glass$/` doesn't match Gemini IDs, so CSV passes through `factory.js` untouched.
8. **`_modelUsed` lives at top-level of the non-streaming response object** (impl-gap resolution): `{ response: {...}, _modelUsed }` for `generateContent`; `{ content, raw, _modelUsed }` for `chat`. Currently no UI consumer (Ask flow is streaming-only), but set for symmetry with the streaming `_final_model` sentinel and for test assertions.
9. **`resetHealth()` exported with `// @internal — test helper` comment** (impl-gap resolution): avoids the temptation to mock `Date.now()` for cooldown-expiry tests, which is more fragile.

---

## 3. Decision drivers

Inherited from spec §1 "Five locked decisions" — recorded here for traceability. No new decisions in plan.

| # | Decision | Source | Rationale carried into plan |
|---|---|---|---|
| 1 | Sticky primary + failover (not round-robin, not tier-based) | spec §1 + brainstorm | Quality consistency over preemptive quota spread. Loop returns the *first* healthy model in declared order — sticky primary is implicit. |
| 2 | Cooldown honors `Retry-After` / `retryDelay`; default 60s; clamp `[5s, 300s]` | spec §1 + spec §2 "Cooldown" | Accurate when the API tells us; sane fallback otherwise; clamp prevents a misconfigured backend from locking the app out. |
| 3 | STT — single model, no failover | spec §1 + spec §3 "STT" | STT is a persistent live session, not a request; rotation has no clean semantics. `createSTT` reads `parseModelList(modelCsv)[0]` only. |
| 4 | Mid-stream error → abandon partial output, restart with next model | spec §1 + spec §3 "Streaming LLM" | Cleaner UX than splicing two model outputs. Achieved via `_reset` sentinel telling the consumer to drop accumulated content. |
| 5 | Per-response footer `answered by: <model>` (+ `(fallback)` when applicable) | spec §1 + spec §4 "Per-response footer" | Per-response provenance; no header clutter. Renders via existing `ask:stateUpdate` channel, no new IPC. |
| 6 | Singleton rotator (module-level `const health = new Map()`) | spec § Clarifications IMPL GAP | One Electron process, one shared rate-limit budget against Gemini. Multiple rotators would partition cooldown state. |
| 7 | `markSucceeded` does `health.delete(modelId)` (not timestamp-as-healthy) | spec § Clarifications IMPL GAP | Quality-aware routing is out of scope; no metrics to track on success. Cleanest representation. |
| 8 | `parseModelList(null \| undefined)` returns `[]` (not throws) | spec § Clarifications IMPL GAP | Caller throws a clear error on empty `.length`; friendlier than crashing inside settings load. |
| 9 | Front-end CSV validator splits before checking `gemini-` prefix | spec § Clarifications IMPL GAP | Current `SettingsView.js:751-755` `startsWith('gemini-')` check would pass `"gpt-4,gemini-2.5-flash"` by accident on the full string. Fix: split, trim, drop empties, validate every entry. |
| 10 | `_modelUsed` at top-level of non-streaming response | spec § Clarifications IMPL GAP | Outer `{ response, _modelUsed }` parity with streaming `_final_model`. Unused by current UI but supports test invocations and future-proofing. |
| 11 | Sentinel field names use leading underscore | design doc + spec §3 | Visually distinct from OpenAI-shape fields; future-resistant to Gemini SDK schema evolution. |

---

## 4. Files touched

Authoritative list — copied from spec §7 and verified against current filesystem. Each row also names the implementation phase from §6.

| # | File | Phase | Edit kind | Purpose |
|---|---|---|---|---|
| 1 | `src/features/common/ai/providers/geminiModelRotator.js` | P1 | **New file** | In-memory health registry. Exports: `pickModel(list)`, `markFailed(modelId, retryAfterMs)`, `markSucceeded(modelId)`, `classifyError(err)`, `parseRetryAfter(err)`, `parseModelList(csv)`, `resetHealth()` (test-only, fenced with `// @internal — test helper`). |
| 2 | `src/features/common/ai/providers/__tests__/geminiModelRotator.test.js` | P1 | **New file** | Unit tests per spec §6.1. `resetHealth()` called in `beforeEach`. |
| 3 | `src/features/common/ai/providers/gemini.js` | P2 | Modify | `createLLM` (both `generateContent` and `chat`) wrapped in `callWithFailover` from spec §3. `createStreamingLLM` replaces stream body lines 243-319 with the failover-loop version from spec §3. `createSTT` reads `parseModelList(modelCsv)[0] \|\| 'gemini-live-2.5-flash-preview'`. Extend existing `controller.close()` try/catch pattern to also wrap `controller.error()`. |
| 4 | `src/features/settings/settingsService.js` | P3 | Modify | CSV parsing/validation when provider is `gemini`. Trim entries, drop empties, reject empty result, dedupe (optional — spec edge case says duplicate handling falls out of `remaining.filter`, but a frontend dedupe is friendlier UX). The opaque CSV is what gets persisted in `selected_llm_model`. |
| 5 | `src/ui/settings/SettingsView.js` | P3 | Modify | (a) Help text under the Gemini LLM Model ID input — exact copy from spec §4. (b) Update `handleSaveGeminiModels` (lines 745-773) per impl-gap resolution: split on `,`, trim each, drop empties, require every entry to start with `gemini-`. On failure, alert the offending token. |
| 6 | `src/features/ask/askService.js` | P4 | Modify | Extend the SSE consumer at lines 407-432 to branch on `_reset` and `_final_model` BEFORE the existing token path. On `_reset`: `fullResponse = ''`, `this.state.currentResponse = ''`, `this.state.responseHadFallback = true`, broadcast, `continue`. On `_final_model`: `this.state.responseModel = json._final_model`, broadcast, `continue`. Initialize `state.responseModel = null` and `state.responseHadFallback = false` per request (where `state.currentResponse` is reset — likely in `sendMessage` entry). |
| 7 | `src/ui/ask/AskView.js` | P5 | Modify | Add two reactive properties to `static properties`: `responseModel: { type: String }` and `responseHadFallback: { type: Boolean }`. Extend the `onAskStateUpdate` subscriber at lines 789-805 to copy `newState.responseModel` and `newState.responseHadFallback` into `this.responseModel` / `this.responseHadFallback`. Render a muted footer below the response body when `responseModel` is set — styled `font-size: 11px; opacity: 0.6; margin-top: 8px; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 4px`. Text: `answered by: ${responseModel}${responseHadFallback ? ' (fallback)' : ''}`. |
| 8 | `CHANGELOG.md` | P6 | Modify | Add "Gemini Failover" entry under `[Unreleased]` — sections: Added, Changed (CSV semantics on `selected_llm_model`), Fixed (mid-stream `controller.error()` race). |

**No changes (verified):**

- `modelStateService.js` — returns `selected_llm_model` opaquely (line 377-388 per impl-gap analysis); no CSV-awareness required.
- `factory.js` — `sanitizeModelId` regex `/-glass$/` doesn't match Gemini IDs; CSV passes through untouched.
- `providerSettingsRepository.js` — treats value as opaque TEXT; no schema change.
- `preload.js` — `ask:stateUpdate` already forwards the entire `state` object to `AskView`; new properties ride the same envelope.
- `PickleGlassApp.js` — same as `preload.js`; only forwards state.
- Header window (`MainHeader.js`) — out of scope; spec §9 explicitly says header (393px wide per commit `525dcb1`) is untouched.
- Any other provider (`openai.js`, `anthropic.js`, `ollama.js`) — spec §8 explicitly lists multi-provider failover as out of scope.
- SQLite migrations — no schema change.

**No new dependencies. No DB migration. No new IPC channels. No new windows.**

---

## 5. Architecture & data flow

(Verbatim from spec §2 and §3, restated here for reviewer convenience.)

```
┌───────────────────────────────────────────────────────────────────────────┐
│ Ask flow on a request                                                     │
│                                                                           │
│   user submits question                                                   │
│        │                                                                  │
│        ▼                                                                  │
│   askService.sendMessage()                                                │
│        │                                                                  │
│        │ reads selected_llm_model (CSV) via modelStateService             │
│        │ passes CSV opaquely to createStreamingLLM(model)                 │
│        ▼                                                                  │
│   gemini.createStreamingLLM(model: "csv,here")                            │
│        │                                                                  │
│        │ new outer ReadableStream                                         │
│        │ remaining = parseModelList(csv) [P2]                             │
│        │ while remaining.length > 0:                                      │
│        │   modelId = rotator.pickModel(remaining)        [from P1]        │
│        │   try { await streamOneAttempt({modelId, …}) }                   │
│        │   catch (err):                                                   │
│        │     classifyError → fatal-request | fatal-auth → controller.error│
│        │                                                                  │
│        │                  transient → rotator.markFailed(parseRetryAfter) │
│        │                              remaining = remaining.filter(≠id)  │
│        │                              safeEnqueue({_reset, next_model})  │
│        │                                                                  │
│        │   success → succeededModel = modelId; markSucceeded; break       │
│        │                                                                  │
│        │ after loop:                                                      │
│        │   safeEnqueue({_final_model: succeededModel})                    │
│        │   safeEnqueue('data: [DONE]\n\n')                                │
│        │   try { controller.close() } catch {}                            │
│        ▼                                                                  │
│   SSE stream emitted to askService                                        │
│        │                                                                  │
│        ▼                                                                  │
│   askService SSE consumer (lines 407-432 extended)                        │
│        │                                                                  │
│        │ for each `data: <json>\n\n` line:                                │
│        │   json._reset → fullResponse=''; state.currentResponse='';        │
│        │                 state.responseHadFallback=true; broadcast;       │
│        │   json._final_model → state.responseModel=…; broadcast;          │
│        │   else (existing path) → token = choices[0].delta.content;       │
│        │                          fullResponse+=token; broadcast;         │
│        ▼                                                                  │
│   `ask:stateUpdate` IPC push to ask window webContents                    │
│        │                                                                  │
│        ▼                                                                  │
│   AskView.onAskStateUpdate (line 789)                                     │
│        │                                                                  │
│        │ this.currentResponse = newState.currentResponse  (existing)      │
│        │ this.responseModel    = newState.responseModel    (NEW)          │
│        │ this.responseHadFallback = newState.responseHadFallback (NEW)    │
│        ▼                                                                  │
│   render():                                                               │
│     [response body — existing]                                            │
│     ─────                                                                 │
│     answered by: gemini-2.5-flash                  ← when responseModel   │
│     answered by: gemini-2.5-flash (fallback)       ← when also Had…=true  │
└───────────────────────────────────────────────────────────────────────────┘
```

**Rotator state lifecycle:**

```
Module load (once per Electron process):
  const health = new Map();   // module-level singleton

Per request, per attempt:
  rotator.pickModel(modelList) →
    forEach id in modelList:
      entry = health.get(id)
      if !entry or entry.cooldownUntil <= Date.now(): return id
    // all cooling — return soonest-recovering
    return modelList.map(id → {id, until: health.get(id)?.cooldownUntil ?? 0})
                    .sort(by until asc)[0].id

On transient error:
  rotator.markFailed(modelId, retryAfterMs) →
    cooldownUntil = Date.now() + retryAfterMs    // already clamped [5000, 300000]
    health.set(modelId, { cooldownUntil, lastError: err.message })

On success:
  rotator.markSucceeded(modelId) →
    health.delete(modelId)    // present ⇔ cooling down

On app restart:
  health = new Map()    // all models start healthy; cooldowns ≤300s so we lose
                        // nothing meaningful — see spec §2 "State" rationale
```

---

## 6. Implementation phases

Six phases, each producing an independently-mergeable slice. Dependencies are strictly linear except where noted — every phase needs the prior one merged before its tests run cleanly. Inside a single phase, the steps are commonly parallelizable.

### Phase P1 — Rotator module + unit tests (pure logic, no integration yet)

**Goal:** the rotator module exists, is fully unit-tested, and exports a clean public API. Nothing else can be wired up against it until this exists. No edits to other files in this phase.

| Step | Action | File | Validation |
|---|---|---|---|
| P1.1 | Confirm test runner. Inspect `package.json` for `jest` / `vitest` / `node:test` setup. If Jest is configured: proceed. If not: use `node:test` (built into Node 18+) and adjust syntax — the unit tests in spec §6.1 are framework-agnostic in spirit. | `package.json` (read-only) | Test runner identified before writing tests. |
| P1.2 | Create `geminiModelRotator.js`. Implement the module-level singleton (`const health = new Map()`), and all 7 exports: `pickModel`, `markFailed`, `markSucceeded`, `classifyError`, `parseRetryAfter`, `parseModelList`, `resetHealth`. Constants: `DEFAULT_COOLDOWN_MS = 60000`, `MIN_COOLDOWN_MS = 5000`, `MAX_COOLDOWN_MS = 300000`. | `src/features/common/ai/providers/geminiModelRotator.js` (new) | `require('./geminiModelRotator')` returns an object with all 7 keys. |
| P1.3 | Implement `classifyError` with the 3-tier inspection order: (a) explicit `err.status` number → branch on the table in spec §2 "Error classification"; (b) walk `err.errorDetails?.find(d => d['@type']?.includes('ErrorInfo'))` and inspect its `reason` (`RESOURCE_EXHAUSTED`, `UNAVAILABLE`, `DEADLINE_EXCEEDED`, `INVALID_ARGUMENT`, `PERMISSION_DENIED`, `API_KEY_INVALID`); (c) fall back to message-text heuristics. Unknown errors default to `transient` (fail-open per spec). | `geminiModelRotator.js` | Unit tests in P1.5 exercise each tier. |
| P1.4 | Implement `parseRetryAfter` with the 3-tier order from spec §2 "Cooldown": (a) `errorDetails[].@type` containing `RetryInfo` with `retryDelay: "Ns"` → parse N×1000ms; (b) HTTP `Retry-After` header (numeric seconds OR HTTP-date format — use `Date.parse` for the date case); (c) default `DEFAULT_COOLDOWN_MS`. Clamp result to `[MIN_COOLDOWN_MS, MAX_COOLDOWN_MS]`. | `geminiModelRotator.js` | Unit test cases from spec §6.1 cover all branches. |
| P1.5 | Implement `parseModelList(csv)`: `(csv ?? '').split(',').map(s => s.trim()).filter(Boolean)`. Handles `null`, `undefined`, `""`, whitespace, empty entries. | `geminiModelRotator.js` | Unit tests: `parseModelList(null) === []`, `parseModelList(' a , , b ') === ['a','b']`. |
| P1.6 | Implement `pickModel(modelList)` per spec §2 "Selection algorithm". Empty list → throw `Error('pickModel: empty model list')`. All-healthy → return first. All-cooling → return soonest-recovering. | `geminiModelRotator.js` | Unit tests from spec §6.1 cover all three branches. |
| P1.7 | Implement `markFailed(modelId, retryAfterMs)` and `markSucceeded(modelId)`. `markFailed` stores `{ cooldownUntil: Date.now() + retryAfterMs, lastError }` in the Map. `markSucceeded` does `health.delete(modelId)`. | `geminiModelRotator.js` | Unit test: after `markFailed('a', 60000)` then `markSucceeded('a')`, `pickModel(['a'])` returns `'a'` immediately (no cooldown). |
| P1.8 | Export `resetHealth()` with the `// @internal — test helper` JSDoc comment. Implementation: `health.clear()`. | `geminiModelRotator.js` | Test file's `beforeEach` uses it; production code never calls it. |
| P1.9 | Write the test file with all assertions from spec §6.1. | `src/features/common/ai/providers/__tests__/geminiModelRotator.test.js` (new) | All assertions in spec §6.1 pass. Coverage: `pickModel` (4 cases), `classifyError` (5 cases including 400, 429, 503 HTTP and SDK paths), `parseRetryAfter` (4 cases + 2 clamp cases), `parseModelList` (5 cases), `markSucceeded` (1 case). |

**Exit criteria for P1:** the test file passes 100% green. Running `node -e "console.log(Object.keys(require('./src/features/common/ai/providers/geminiModelRotator')))"` lists all 7 exports.

**Parallelism inside P1:** P1.3, P1.4, P1.5, P1.6, P1.7 are independent helper implementations that can be authored in parallel; P1.9 depends on all of them. P1.1 must run first (gates test runner choice).

### Phase P2 — Gemini provider failover loop (non-streaming + streaming)

**Goal:** `createLLM` and `createStreamingLLM` go through the failover loop. STT updated to strip CSV to first model. Integration tests with mocked SDK pass. UI surfaces don't exist yet — testing is via mock harness.

| Step | Action | File | Validation |
|---|---|---|---|
| P2.1 | Add `const rotator = require('./geminiModelRotator');` at the top of `gemini.js`. | `src/features/common/ai/providers/gemini.js` top | No circular-import error at boot (`geminiModelRotator.js` imports nothing else from the project). |
| P2.2 | Extract a helper `callWithFailover(modelList, doCall)` in `gemini.js` per spec §3 "Non-streaming LLM" — verbatim from spec. This is reused by both `generateContent` and `chat`. The outer return shape from `generateContent` becomes `{ response, _modelUsed }`; from `chat` becomes `{ content, raw, _modelUsed }` (spec impl-gap resolution). | `gemini.js` | Mocked SDK test: 429 on first model + success on second → returns `{ ..., _modelUsed: 'modelB' }`, first model cooled-down. |
| P2.3 | Refactor `createStreamingLLM` per spec §3 "Streaming LLM". Extract the current per-model streaming body (lines 243-319) into a `streamOneAttempt({ modelId, messages, safeEnqueue })` helper that throws on error (including mid-stream errors that emerge inside the `for await` loop). The outer `ReadableStream` body is replaced verbatim with the spec §3 snippet — the loop that calls `rotator.pickModel`, catches errors, decides via `classifyError`, emits `_reset` sentinels, and finally emits `_final_model` + `[DONE]`. | `gemini.js:243-319` (replace) | Test mocks the SDK stream to emit 2 chunks then `throw new Error()` with `status:503`; consumer receives `_reset` sentinel then second model's chunks then `_final_model` then `[DONE]`. |
| P2.4 | Wrap `controller.error()` in `try/catch` in BOTH the fatal-error branch (`if (kind !== 'transient')`) and the all-models-failed branch (`if (!succeededModel)`) — impl-gap resolution. Pattern mirrors existing `try { controller.close() } catch {}` at gemini.js:311. | `gemini.js` (new stream body) | Test: simulate consumer cancellation (`controller.desiredSize === null`) DURING failover loop — no thrown `ERR_INVALID_STATE` reaches the outer scope. |
| P2.5 | Update `createSTT` to call `parseModelList(modelCsv)[0] \|\| 'gemini-live-2.5-flash-preview'` before passing to the live session. The fallback handles `null` / `''` cases per spec §3 "STT". | `gemini.js` (createSTT) | Test: `createSTT({ model: 'gemini-2.5-flash,gemini-2.5-flash-lite' })` opens session with `gemini-2.5-flash` only. `createSTT({ model: '' })` opens session with `gemini-live-2.5-flash-preview` (existing default). |
| P2.6 | Add integration test file. Mock `@google/generative-ai` to return scripted responses per spec §6.2 and §6.3. Cover: (a) success-first; (b) 429-then-success; (c) 429-all → throws last; (d) 400-first → throws immediately, second never called; (e) 401-first → throws immediately, second never called; (f) streaming 503-after-2-chunks → `_reset` emitted, second model streams cleanly, `_final_model` + `[DONE]` emitted, `controller.error()` never called; (g) streaming all-fail → `controller.error()` IS called wrapped in try/catch. | `src/features/common/ai/providers/__tests__/gemini.test.js` (new or extended) | All 7 cases green. |

**Exit criteria for P2:** integration tests in spec §6.2 and §6.3 all pass. `rotator.markFailed` / `markSucceeded` calls visible via `health.size` inspection between cases (with `resetHealth()` in `beforeEach`).

**Parallelism inside P2:** P2.2 (non-streaming) and P2.3 (streaming) touch the same file but are separate code paths — can be authored in two commits sequentially. P2.5 (STT) is independent. P2.6 (tests) authored alongside each implementation step.

### Phase P3 — Settings validation + help text (CSV semantics)

**Goal:** the user-facing settings UI accepts and validates CSV input. Backend persistence treats CSV as opaque TEXT — no schema change.

| Step | Action | File | Validation |
|---|---|---|---|
| P3.1 | In `settingsService.js`, locate where `selectedLlmModel` is persisted on save (likely via `modelStateService.handleSetSelectedModel` at line 50). Confirm that NO normalization happens at this layer — the CSV string is stored as-is. If validation exists here, REMOVE it (validation belongs in the front-end per spec §4 + the rotator's `parseModelList` does the runtime parsing). | `src/features/settings/settingsService.js` (read-only or remove) | Setting `selected_llm_model = "a,b,c"` via DB or via `handleSetSelectedModel` persists the literal string. |
| P3.2 | Update `handleSaveGeminiModels` in `SettingsView.js:745-773` per the spec's impl-gap resolution: replace the single-string `startsWith('gemini-')` check with: split on `,`, trim each entry, drop empties, validate every non-empty entry starts with `gemini-`. On failure, alert the offending token: `Invalid Gemini ${type.toUpperCase()} model ID: "${badToken}". Must start with "gemini-".`. Persist the joined-after-trim string (NOT the raw input) so trailing/leading whitespace doesn't survive to the rotator. | `src/ui/settings/SettingsView.js:745-773` | (a) Input `"gpt-4,gemini-2.5-flash"` → alert mentions `"gpt-4"`. (b) Input `" gemini-2.5-flash , , gemini-2.5-flash-lite "` → persists `"gemini-2.5-flash,gemini-2.5-flash-lite"`. (c) Empty input → existing behavior (no save). |
| P3.3 | Add help text under the Gemini LLM Model ID input in `SettingsView.js`. Exact copy from spec §4: `Comma-separated list for failover. Models are tried in priority order; transient errors (429/503) skip to the next. Example: gemini-3-pro,gemini-2.5-flash,gemini-2.5-flash-lite`. Style: small font, muted color. Use existing help-text class if one exists; otherwise inline-style. | `src/ui/settings/SettingsView.js` render() | Help text visible under the input on the Settings panel. |

**Exit criteria for P3:** Manual test — paste `"gemini-2.5-flash, gemini-2.5-flash-lite"` (with spaces) in the settings input, save, reload settings; field shows `"gemini-2.5-flash,gemini-2.5-flash-lite"` (trimmed). Paste `"gpt-4"` → alert. Paste `""` → no save (existing).

**Parallelism inside P3:** P3.2 and P3.3 touch the same file but are independent code paths. P3.1 is a read-only inspection.

### Phase P4 — SSE consumer extension (`askService.js`)

**Goal:** the consumer parses the new sentinels and updates state correctly. Renderer doesn't yet display the footer, so the visible change is only that the response correctly resets on `_reset`.

| Step | Action | File | Validation |
|---|---|---|---|
| P4.1 | At the entry of `askService.sendMessage` (or wherever `this.state.currentResponse` is reset to `''` for a new request), also reset `this.state.responseModel = null` and `this.state.responseHadFallback = false`. This ensures stale values from the previous response don't carry over. | `src/features/ask/askService.js` | New request shows clean state in the broadcast. |
| P4.2 | Extend the SSE parser at `askService.js:407-432` per spec §3 "SSE consumer changes". Insert BEFORE the existing `const token = ...` line: handle `json._reset` → `fullResponse = ''; this.state.currentResponse = ''; this.state.responseHadFallback = true; this._broadcastState(); continue;`. Handle `json._final_model` → `this.state.responseModel = json._final_model; this._broadcastState(); continue;`. | `src/features/ask/askService.js:407-432` | (a) Synthetic stream containing `_reset` → `fullResponse` and `state.currentResponse` cleared. (b) Synthetic stream containing `_final_model` → `state.responseModel` set. (c) Token after `_reset` → appears in `fullResponse` alone, not concatenated with pre-reset content. |
| P4.3 | Confirm the `finally` block at lines 442-454 still saves the correct partial response when the loop exits (after `_reset` events have happened). The `fullResponse` variable should hold ONLY the post-last-reset content, which is the correct value to persist. | (read-only re-verification) | Manual test: trigger failover (or simulate via test harness); verify the DB row for `addAiMessage` contains only the second model's output, not concatenated. |
| P4.4 | Author the SSE consumer test per spec §6.4. Feed synthetic SSE strings through the consumer logic; assert state mutations and broadcast calls. | `src/features/ask/__tests__/askService-sse.test.js` (new) or inline | All three §6.4 cases pass. |

**Exit criteria for P4:** the §6.4 SSE consumer tests pass. End-to-end: a real Gemini request still works (no regression on the happy path). Trigger failover with a deliberately-broken first model (e.g. `gemini-does-not-exist,gemini-2.5-flash`) — observe in DevTools console that the broadcast state shows `responseHadFallback: true`.

**Parallelism inside P4:** P4.1 and P4.2 touch the same file; serialize. P4.4 (tests) authored alongside.

### Phase P5 — Renderer footer (`AskView.js`)

**Goal:** user-facing footer appears below the response. The reactive properties pick up state updates via the existing `ask:stateUpdate` channel — no new IPC.

| Step | Action | File | Validation |
|---|---|---|---|
| P5.1 | Add `responseModel: { type: String }` and `responseHadFallback: { type: Boolean }` to `AskView.js`'s `static properties` block (currently lines 4-17). | `src/ui/ask/AskView.js:4-17` | Lit element has the new reactive properties. |
| P5.2 | In `connectedCallback` or wherever `currentResponse` is initialized (line 716), initialize: `this.responseModel = ''` and `this.responseHadFallback = false`. | `src/ui/ask/AskView.js` | Fresh mount shows no footer (no responseModel). |
| P5.3 | Extend the `onAskStateUpdate` subscriber at lines 789-805 to copy: `this.responseModel = newState.responseModel \|\| ''` and `this.responseHadFallback = !!newState.responseHadFallback`. | `src/ui/ask/AskView.js:789-805` | Broadcast with `responseModel: 'gemini-2.5-flash'` → renderer prop updates. |
| P5.4 | In the render template — locate where `currentResponse` is rendered into the response container (around line 1010-1078). After the response body, render the footer conditionally. Implementation: `${this.responseModel ? html\`<div class="response-footer">answered by: ${this.responseModel}${this.responseHadFallback ? ' (fallback)' : ''}</div>\` : ''}`. | `src/ui/ask/AskView.js` render() | Setting `this.responseModel = 'gemini-2.5-flash'` from DevTools shows the footer; clearing it hides the footer. |
| P5.5 | Add CSS for `.response-footer`: `font-size: 11px; opacity: 0.6; margin-top: 8px; padding-top: 4px; border-top: 1px solid rgba(255,255,255,0.1); color: rgba(255,255,255,0.7);`. Place inside the existing `static styles = css\`...\`` block. | `src/ui/ask/AskView.js` styles | Footer is visually muted but legible against the dark glass background. |
| P5.6 | Verify the `_reset` UX (impl-gap accepted): user observes the response body clear to empty for one frame, then re-accumulate from the next model. Document in CHANGELOG that this is intended. | (manual smoke test) | Behavior observed; no need for throttle in v1. |

**Exit criteria for P5:** manual smoke test §6.5 #3 (set `gemini-2.5-flash,gemini-2.5-flash-lite`, send a request, observe `answered by: gemini-2.5-flash` footer). For the `(fallback)` marker, smoke test §6.5 #4 (force a 429 on the first model — easiest via a deliberately bad first model that 400s? No — that's fatal-request, not transient. Use a model known to be currently throttled, OR temporarily mock the rotator to force transient on first attempt).

**Parallelism inside P5:** P5.1, P5.2, P5.3, P5.4, P5.5 all touch the same file; serialize.

### Phase P6 — Manual smoke + CHANGELOG + release

**Goal:** run the full §6.5 smoke, update CHANGELOG, prepare PR.

| Step | Action | File | Validation |
|---|---|---|---|
| P6.1 | Manual smoke test §6.5 #1: set Gemini LLM Model ID to `gemini-does-not-exist,gemini-2.5-flash`. Send a request. **Expect:** immediate surfaced error mentioning `gemini-does-not-exist`. Validates `fatal-request` handling. | (manual) | Error visible; second model NOT called (no DB row for the second model's response). |
| P6.2 | Manual smoke test §6.5 #2: set Gemini LLM Model ID to `gemini-2.5-flash` (single model, no comma). Send a request. **Expect:** identical behavior to before this feature. Footer still renders `answered by: gemini-2.5-flash` (no `(fallback)`). | (manual) | Single-model backward compatibility confirmed. |
| P6.3 | Manual smoke test §6.5 #3: set Gemini LLM Model ID to `gemini-2.5-flash,gemini-2.5-flash-lite`. Send a request. **Expect:** response footer shows `answered by: gemini-2.5-flash` (no fallback marker because no failover happened on the happy path). | (manual) | Footer renders cleanly. |
| P6.4 | Manual smoke test §6.5 #4: engineer a fallback. Two approaches: (a) temporarily replace the first model with a model the user knows is currently throttled by Google (hard to guarantee); (b) MORE RELIABLE: in DevTools console of the renderer, monkey-patch `rotator.classifyError` to return `'transient'` once for the first model — forces the failover loop. **Expect:** response footer shows `answered by: gemini-2.5-flash-lite (fallback)`. | (manual) | `(fallback)` marker renders. |
| P6.5 | Edge case sweep: paste `"gemini-2.5-flash, , gemini-2.5-flash-lite"` (with empty middle entry) in settings. Save. Send a request. **Expect:** no crash; CSV parses to 2 valid entries; happy path. | (manual) | Whitespace/empty handling per spec §5. |
| P6.6 | Edge case sweep: paste a single model that doesn't exist (`"gemini-does-not-exist"`) — first call returns 400. **Expect:** surfaced 400 error, NOT silent skip. | (manual) | Confirms typo detection per spec §5. |
| P6.7 | Update `CHANGELOG.md` under `[Unreleased]`. Suggested entry: see §7 below. | `CHANGELOG.md` | Entry added; format matches existing `### Ask Mode Shortcuts` block. |
| P6.8 | Open PR from `feat/gemini-failover` → `main`. Reference spec doc and design doc in the PR description. | (git/GitHub) | PR ready for review. |

**Exit criteria for P6:** all 6 smoke cases pass. CHANGELOG entry merged. PR open.

---

## 7. CHANGELOG entry (draft for P6.7)

```markdown
### Gemini Failover (branch `feat/gemini-failover`)

#### Added
- **Gemini model failover** — the `Gemini LLM Model ID` setting now accepts a comma-separated list of model IDs for failover. On transient errors (HTTP 408/429/500/502/503/504, SDK `RESOURCE_EXHAUSTED` / `UNAVAILABLE` / `DEADLINE_EXCEEDED`, network/timeout), the next model in priority order is tried. Fatal errors (400, 401, 403) surface immediately so typos and auth issues don't get masked.
- **In-memory cooldown registry** (`geminiModelRotator.js`) — tracks per-model `cooldownUntil` timestamps. Honors `Retry-After` header and SDK `RetryInfo.retryDelay`; default 60s; clamped to `[5s, 300s]`. State is in-memory only; resets on app restart (cooldowns are short enough that nothing meaningful is lost).
- **Per-response footer** in `AskView.js` — renders `answered by: <model>` below each response. If failover happened mid-response, appends `(fallback)` marker.
- **Settings help text** under the Gemini LLM Model ID input explaining the CSV format.
- **New SSE sentinels** `{_reset, next_model}` and `{_final_model}` on the existing SSE channel — extends the consumer at `askService.js:407-432` without breaking the existing token shape.

#### Changed
- `selected_llm_model` is now interpreted as a CSV when provider is `gemini` (same column; opaque TEXT; no schema change).
- `SettingsView.handleSaveGeminiModels` now splits CSV input before validating each entry against the `gemini-` prefix (previously checked only the full string, which would have accepted `"gpt-4,gemini-2.5-flash"`).
- `createSTT` in `gemini.js` reads only the first CSV entry (STT failover is out of scope per design).
- `createStreamingLLM`'s stream body now wraps `controller.error()` in `try/catch` for defense in depth, matching the existing pattern on `controller.close()`.

#### Internal
- New unit tests `geminiModelRotator.test.js` (covers `pickModel`, `classifyError`, `parseRetryAfter`, `parseModelList`).
- New integration tests `gemini.test.js` (failover loop + streaming + sentinel emission).
- New SSE consumer tests in `askService.js` for `_reset` / `_final_model` handling.
```

---

## 8. IPC contract (authoritative)

**No new IPC channels are introduced by this work.** The new state fields ride the existing `ask:stateUpdate` push channel.

| Channel | Direction | Args | Returns | Implemented by | Status |
|---|---|---|---|---|---|
| `ask:stateUpdate` | main → ask window (push) | `state: { currentResponse, currentQuestion, isLoading, isStreaming, responseModel, responseHadFallback, ... }` | (push) | `askService._broadcastState()` via `askWindow.webContents.send(...)` | **Existing** — new fields `responseModel` and `responseHadFallback` added to the envelope; old fields untouched. |

**Channel-naming convention:** namespaced colon-separated, matching existing repo pattern (`ask:`, `mainHeader:`, `settings:`).

---

## 9. Risk register

| # | Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|---|
| R1 | Gemini SDK error shape changes in a future SDK version — `classifyError` mis-classifies | Medium | Medium | Fail-open default (unknown → `transient`) keeps the loop safe even if classification drifts. Could mask real bugs, but won't crash the app. The 3-tier inspection (`status` → `errorDetails.@type` → message text) is resilient to most envelope changes. Mitigation: unit test the `classifyError` against current SDK shapes; revisit if regressions observed. |
| R2 | `_reset` causes a visible content flash (empty frame followed by new content) | Medium | Low | Accepted UX per spec impl-gap resolution — the user SHOULD see the response start over because the first model failed. If feedback indicates jarring visuals, follow-up PR can throttle the empty-content broadcast by 100ms. |
| R3 | Persisting CSV in `selected_llm_model` breaks if another consumer (out of `gemini.js`) tries to use the value as a single model ID | Low | Medium | Confirmed via impl-gap analysis: `modelStateService.js` and `factory.js` treat the value opaquely (`sanitizeModelId` regex `/-glass$/` doesn't match Gemini IDs). Other providers (`openai.js`, `anthropic.js`, `ollama.js`) read their own provider's `selected_llm_model` row — Gemini's CSV doesn't reach them. |
| R4 | Mid-stream `controller.error()` race with consumer cancellation throws `ERR_INVALID_STATE` | Low | Low | Mitigated by impl-gap resolution: wrap `controller.error()` in try/catch in BOTH branches (fatal + all-failed). Matches existing pattern at `gemini.js:311`. |
| R5 | Singleton rotator state leaks across user sessions / concurrent requests | Low | Low | Node single-threaded; `Map` is safe for read/write concurrency on a single thread. Two concurrent requests reading the same cooldown state behave correctly. Cooldown state is per-model not per-user; sharing across requests is the intended design. |
| R6 | Settings UI accepts whitespace-padded CSV that parses to N entries but persists "looks weird" string | Low | Low | P3.2 step normalizes (`.map(s => s.trim())`) BEFORE persisting; user-visible string is clean. |
| R7 | First model is a duplicate of second (`"gemini-2.5-flash,gemini-2.5-flash"`) — failover loop dedupes via filter but UX is confusing | Low | Low | Spec §5 explicitly covers this: `remaining.filter(m => m !== modelId)` removes ALL instances on failure, so duplicates collapse to one attempt. Confusing input, predictable output. Could add a dedupe step in `parseModelList` if observed in QA. |
| R8 | Renderer doesn't pick up `responseModel` if the IPC handler in `preload.js` strips unknown fields from the state object | Low | Medium | Verified: `AskView.js:789` accepts the whole `newState` object opaquely; `preload.js` exposes the IPC listener as an event forwarder — does NOT strip fields. Mitigation: P5 manual test (`window.api.askView.onAskStateUpdate(...)` console-log the received state to confirm new fields arrive). |
| R9 | `_modelUsed` on the non-streaming response is unused — dead code risk | Low | Low | Spec impl-gap resolution accepts this — it's set for symmetry with `_final_model` and for test assertions. No UI consumer required by v1. |
| R10 | Cooldowns clear on app restart (state is in-memory only) — user restarts mid-throttle and re-triggers same 429 | Medium | Low | Accepted per spec §2 "State" — cooldowns are clamped ≤300s, so restart loses ≤5 minutes of cooling. Persistence overhead not worth it for a personal tool. Future work item if observed in practice. |

---

## 10. Phase 2 — Task generation approach (for `/tasks`)

When `/tasks` runs against this plan, it should emit one task per row in §4, ordered by phase (P1 → P2 → P3 → P4 → P5 → P6), with the §6 substeps as acceptance bullets. Suggested task granularity:

- **T-P1.1** Identify test runner (Jest vs node:test) — 1 file read, ~5 min
- **T-P1.2..P1.8** Implement `geminiModelRotator.js` — 1 file (new), ~180 LOC; can be split into 7 subtasks per export but more naturally a single PR/commit
- **T-P1.9** Author unit tests — 1 file (new), ~250 LOC, ~20 assertions
- **T-P2.1+P2.2** Wire `callWithFailover` into non-streaming `createLLM` — 1 file, ~50 LOC
- **T-P2.3+P2.4** Rewrite streaming `createStreamingLLM` body, wrap `controller.error()` — 1 file, ~80 LOC replacing 76 existing LOC
- **T-P2.5** Update `createSTT` to use `parseModelList[0]` — 1 file, ~3 LOC
- **T-P2.6** Integration tests for failover + streaming — 1 file (new), ~200 LOC, ~7 assertions
- **T-P3.1** Read-only confirmation: settings service treats value opaquely — no code change usually, 5 min
- **T-P3.2** Update `handleSaveGeminiModels` validator — 1 file, ~15 LOC
- **T-P3.3** Add help text to Gemini LLM Model ID input — 1 file, ~5 LOC
- **T-P4.1+P4.2** Extend SSE consumer with `_reset` and `_final_model` branches — 1 file, ~15 LOC
- **T-P4.3** Re-verify `finally` partial-save logic — read-only, 5 min
- **T-P4.4** Author SSE consumer test — 1 file (new) or inline, ~80 LOC
- **T-P5.1..P5.5** Add `responseModel` + `responseHadFallback` reactive properties to `AskView.js`, render footer, style — 1 file, ~40 LOC
- **T-P6** Manual smoke + CHANGELOG + PR — 30-45 min

Total: ~14 implementation tasks + 1 QA task. ~750-900 LOC across 3 new files + 5 modified files.

Order is mandatory between phases. Parallelization is safe inside a single phase (e.g. P2.2 non-streaming and P2.5 STT touch different code paths in the same file and can be authored in two separate commits). P1 must finish before P2; P3 has no dependency on P2 and could theoretically be parallel, but UX testing of settings input is cleanest when the backend already exists.

---

## 11. Test plan reference

The full test plan lives in spec §6:

- **§6.1** Unit tests for `geminiModelRotator.js` — 5 test groups, ~20 assertions
- **§6.2** Integration tests for the failover loop — 5 cases
- **§6.3** Streaming integration test — 6 verifications
- **§6.4** SSE consumer test in `askService.js` — 3 cases
- **§6.5** Manual smoke tests — 4 numbered scenarios

Plan §6 P6 is the explicit "all tests green" exit criterion. Automated tests live in `__tests__/` directories alongside the modules; manual smoke is the final gate before PR.

---

## 12. Progress tracking

| Phase | Status | Notes |
|---|---|---|
| Pre-flight gate (§0) | DONE | All gates pass; constitution check N/A (no `.specify/memory/`). Personal memory dir empty → fail-open per FR-008, no `Prior Lessons Applied` section. |
| Plan authored | DONE | This document. |
| P1 — Rotator module + unit tests | PENDING | Awaiting `/tasks` and implementer pickup. |
| P2 — Provider failover loop | PENDING | |
| P3 — Settings validation + help text | PENDING | |
| P4 — SSE consumer extension | PENDING | |
| P5 — Renderer footer | PENDING | |
| P6 — Manual smoke + CHANGELOG | PENDING | |

---

## 13. References

- **Spec** — `specs/2026-05-26-gemini-failover-design/spec.md` (authoritative; this plan implements it phase-by-phase)
- **Design** — `specs/2026-05-26-gemini-failover-design/2026-05-26-gemini-failover-design.md` (predecessor from `/workflow-brainstorm`; superseded by spec where they disagree, but mostly verbatim-shared)
- **Brief** — `specs/2026-05-26-gemini-failover-design/prompt.md` (original user intent — model rotation with priority list, surfaced active model)
- **Sibling plan (template reference)** — `specs/2026-05-25-ask-mode-shortcuts/2026-05-25-ask-mode-shortcuts-plan.md`
- **Key source files reviewed during plan authoring** —
  - `src/features/common/ai/providers/gemini.js:230-329` (current `createStreamingLLM` body, `safeEnqueue` pattern, `controller.close()` try/catch)
  - `src/features/ask/askService.js:400-454` (current SSE consumer + finally save path)
  - `src/ui/ask/AskView.js:4-17, 789-805, 1010-1078` (Lit reactive properties, `onAskStateUpdate` subscriber, render-response logic)
  - `src/ui/settings/SettingsView.js:745-773` (`handleSaveGeminiModels` validator to be extended)
  - `src/features/settings/settingsService.js:49-52` (`setSelectedModel` opaque passthrough)

---

## Next step

Run `/tasks 2026-05-26-gemini-failover-design` to generate the 14+1 task breakdown described in §10, or proceed directly to `/implement` if working solo.

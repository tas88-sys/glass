# Tasks: Interview Live Answer Lane

**Spec**: `specs/2026-05-30-interview-live-answer/spec.md`
**Plan**: `specs/2026-05-30-interview-live-answer/plan.md`
**Machine-readable**: `specs/2026-05-30-interview-live-answer/tasks.json` (authoritative — this `.md` is a generated view)
**Generated**: 2026-05-31 by `/tasks 2026-05-30-interview-live-answer`

> **TDD is NON-NEGOTIABLE (Constitution Principle I).** Failing `node:test` tests precede implementation: P1 RED → P2 GREEN (pure helpers); P3 RED → P4 GREEN (orchestrator + extracted SSE parser). Tests use `require('node:test')` + `require('node:assert/strict')` — **NOT Jest** (none installed; `package.json:15` = `node --test src/**/__tests__/**/*.test.js`).
>
> **`[P]`** = genuinely parallelizable (separate test files/cases or different `target_file`). Same-file edits are serialized.
>
> **LLM provider MUST be mocked before EVERY integration test** (T-P5.\*, T-P6.LANE) — no live provider calls anywhere in the suite.
>
> **No E2E** — this repo has no automated Electron-renderer or live-audio harness. Visual render + end-to-end audio are manual (`quickstart.md`).
>
> **CLOSED / untouched (FR-017)** — must NOT be edited: `makeOutlineAndRequests`, the `summary-update` channel, `SummaryView.js`, `promptTemplates.js`, `askService.js`, `featureBridge.js`, `listenService.js`.

## Files in scope

| Disposition | File |
|-------------|------|
| **NEW** | `src/ui/listen/summary/LiveAnswerView.js` |
| **NEW** | `src/features/listen/summary/__tests__/liveAnswer.test.js` |
| ADDITIVE | `src/features/listen/summary/summaryService.js` (helpers + `triggerAnswerIfNeeded` + `makeLiveAnswer` + `resetLiveAnswer` folded into `resetConversationHistory`; add `createStreamingLLM` import) |
| ADDITIVE | `src/preload.js` (two listeners in the `summaryView` namespace; NEW `live-answer-update` channel) |
| ADDITIVE | `src/ui/listen/ListenView.js` (import + `<live-answer-view>` above `<summary-view>` at :681 + `resetAnswer()` in reset block :467-469) |
| CLOSED | `SummaryView.js`, `promptTemplates.js`, `askService.js`, `featureBridge.js`, `listenService.js`, `summary-update`, `makeOutlineAndRequests` |

---

## Phase pre-impl — Preflight gates

| Status | ID | [P] | Description | Target |
|--------|----|-----|-------------|--------|
| pending | T-PRE-PATTERN | [P] | Pattern compliance: additive seam off `addConversationTurn`; reuse `summaryView` IPC namespace with NEW channel; SummaryView loader/render mirror (no subclass); `_reset`/`_final_model` sentinel naming; node:test convention | _(agent: pattern-check)_ |
| pending | T-PRE-UI | [P] | UI preflight: `<live-answer-view>` above `<summary-view>` in shared insights-container; visibility tracks `viewMode==='insights'`; no new toggle; no header-width impact | _(agent: ui-preflight)_ |

## Phase p1 — [RED] Unit tests for pure helpers (must fail first)

| Status | ID | [P] | Description | Target |
|--------|----|-----|-------------|--------|
| pending | T-P1.1 | [P] | RED `isLikelyQuestion` (FR-002) truth-table per EDGE_CASES.md (`?`-tail, openers, favor-recall, negatives, empty/whitespace) | `…/__tests__/liveAnswer.test.js` |
| pending | T-P1.2 | [P] | RED `normalizePassive` + `parseAnswerOrPassive` (FR-010): `PASSIVE`/`PASSIVE.`/`**PASSIVE**`/native phrase → suppress; real answer → keep | `…/__tests__/liveAnswer.test.js` |
| pending | T-P1.3 | [P] | RED `shouldTriggerAnswer` (FR-001/FR-004): mic gate, eligible, not-a-question, de-dup same tail, new-tail-while-inflight, same-question-inflight | `…/__tests__/liveAnswer.test.js` |

> [P] = independent describe-blocks over disjoint helpers; all land in the same new file so the writes are serialized by the implementer.

## Phase p2 — [GREEN] Implement pure helpers

| Status | ID | [P] | Description | Target |
|--------|----|-----|-------------|--------|
| pending | T-P2.1 | — | Implement + export `isLikelyQuestion`, `normalizePassive`/`parseAnswerOrPassive`, `shouldTriggerAnswer` (pure; no I/O/timers/`this`). Make T-P1.\* GREEN | `summaryService.js` |

## Phase p3 — [RED] Extracted SSE-line parser test

| Status | ID | [P] | Description | Target |
|--------|----|-----|-------------|--------|
| pending | T-P3.1 | — | RED for a PURE per-line SSE parser (mirror `askService-sse.test.js` `processSseLines`); `[DONE]`/`_reset`/`_final_model`/`delta.content`/ignore. **Do NOT import askService** (FR-017) | `…/__tests__/liveAnswer.test.js` |

## Phase p4 — [GREEN] Orchestrator + reset (all edit `summaryService.js`, serialized)

| Status | ID | [P] | Description | Target |
|--------|----|-----|-------------|--------|
| pending | T-P4.1 | — | Add `createStreamingLLM` import (:3); implement `makeLiveAnswer` — full model resolution + **TWO-ARG** `createStreamingLLM(provider, opts)` (C1/FR-008) + SSE loop via the extracted parser (FR-009). Make T-P3.1 GREEN | `summaryService.js` |
| pending | T-P4.2 | — | Streaming-aware PASSIVE prefix-buffer (C2/FR-010): buffer to first `\n` or ~16 chars → `parseAnswerOrPassive` → suppress-before-render (hold last) else flush+stream; never blank (Q1/G3) | `summaryService.js` |
| pending | T-P4.3 | — | `triggerAnswerIfNeeded` beside `triggerAnalysisIfNeeded` (:45): 4 gates (speaker → heuristic → 800ms debounce → de-dup/in-flight); callback BAILS on empty history (FR-012); swallow `AbortError` | `summaryService.js` |
| pending | T-P4.4 | — | `resetLiveAnswer()` (clear timer, abort controller, clear tail/in-flight) FOLDED INTO `resetConversationHistory()` (:52) — **NO `listenService.js` edit** (C4/D4/FR-011); init state in constructor | `summaryService.js` |

## Phase p5 — [INTEGRATION] mocked stream + fake clock (LLM mocked before each)

| Status | ID | [P] | Description | Target |
|--------|----|-----|-------------|--------|
| pending | T-P5.1 | — | Debounce coalescing (Accept 4): 3 sub-800ms `them:` fragments → exactly ONE stream | `…/__tests__/liveAnswer.test.js` |
| pending | T-P5.2 | — | De-dup same-tail (Accept 6): trailing fragment of answered question → no second stream | `…/__tests__/liveAnswer.test.js` |
| pending | T-P5.3 | — | Abort-and-replace (Accept 5): new question mid-stream → A aborted, B starts; no blank between | `…/__tests__/liveAnswer.test.js` |
| pending | T-P5.4 | — | PASSIVE suppress hold-last (Accept 3): PASSIVE/`**PASSIVE**`/native-phrase prefix → no emit, last answer held | `…/__tests__/liveAnswer.test.js` |
| pending | T-P5.5 | — | Mid-debounce/mid-stream close (Accept 8): reset clears timer + aborts stream; no emit, no throw; empty-history callback bails (FR-012) | `…/__tests__/liveAnswer.test.js` |

## Phase p6 — Renderer plumbing + lane-independence

| Status | ID | [P] | Description | Target |
|--------|----|-----|-------------|--------|
| pending | T-P6.PRELOAD | [P] | Two listeners in the `summaryView` namespace (:205): `onLiveAnswerUpdate` + `removeAllLiveAnswerUpdateListeners` on NEW `live-answer-update` channel; `summary-update` untouched (FR-013) | `src/preload.js` |
| pending | T-P6.VIEW | [P] | NEW `LiveAnswerView` Lit element: idempotent `loadLibraries` (`if(!window.marked)`); read marked/hljs/DOMPurify; re-parse + DOMPurify-sanitize each delta; single `innerHTML` swap never blank (Q1/G3); plain-text fallback; `resetAnswer()`; **never log answer text** (FR-014/FR-015) | `src/ui/listen/summary/LiveAnswerView.js` |
| pending | T-P6.MOUNT | — | `ListenView.js`: import LiveAnswerView; `<live-answer-view>` ABOVE `<summary-view>` (:681); `resetAnswer()` in reset block (:467-469) beside `resetAnalysis()` (FR-014/FR-016) | `src/ui/listen/ListenView.js` |
| pending | T-P6.LANE | — | [INTEGRATION] Lane independence (Accept 7): `summary-update` still fires on its 5-turn cadence while answers stream; SummaryView output unchanged (FR-017). LLM mocked | `…/__tests__/liveAnswer.test.js` |

> [P] within p6: `T-P6.PRELOAD` (preload.js) and `T-P6.VIEW` (LiveAnswerView.js) are different files. `T-P6.VIEW` depends on `T-P6.PRELOAD` (it consumes the new listeners). `T-P6.MOUNT` depends on `T-P6.VIEW`.

## Phase verify — Gates

| Status | ID | [P] | Description | Gate check |
|--------|----|-----|-------------|-----------|
| pending | T-DOC-GATE | — | Documentation reconciliation (ARCHITECTURE.md insights/audio note + CHANGELOG `[Unreleased]` entry); framework-internal, no cw-documentation | _(agent: documentation-reconciliation)_ |
| pending | T-VERIFY-UNIT | — | Full `node:test` suite green; no pre-existing regression | `npm test` |
| pending | T-VERIFY-LINT | — | ESLint clean for changed files (Lit files best-effort) | `npm run lint` |
| pending | T-VERIFY-SAFETY | — | **Screen-share safety (load-bearing)**: answer renders only in content-protected `listen` window; NO `setContentProtection(false)`; answer text never logged; CLOSED set untouched | diff + grep guards |
| pending | T-FINAL | — | Composite gate: lint + pattern + unit + integration + safety + security + code-review + acceptance-tests required; typecheck/db-validate/contract/e2e/a11y SKIP-WITH-REASON; smoke/ui-verify manual | composite |

> **T-MEM-CAPTURE is intentionally NOT emitted** — `critical_requirements.type = feature-major` (not `bugfix`); the template's `include_if: {critical_requirements.type: [bugfix]}` predicate is not satisfied.

---

## Acceptance Scenario → Task coverage

| AS | Scenario | Covered by |
|----|----------|-----------|
| AS-1 | `them:` question → streamed markdown answer | T-P4.1/.2 + manual smoke |
| AS-2 | `Me` (mic) → no answer | T-P1.3 / T-P2.1 (`shouldTriggerAnswer` mic gate) |
| AS-3 | non-question → PASSIVE, hold last | T-P1.2 + T-P4.2 + T-P5.4 |
| AS-4 | multi-segment → one call | T-P5.1 |
| AS-5 | new question mid-stream → abort+replace | T-P5.3 |
| AS-6 | trailing fragment → no second answer | T-P1.3 + T-P5.2 |
| AS-7 | lane independence | T-P6.LANE |
| AS-8 | Stop mid-stream/debounce → abort+clear, no emit, no throw | T-P5.5 + T-P4.4 |

## Tuning defaults (locked, user-approved)

debounce **800 ms** (600 ms–1 s) · `maxTokens` **900** · `temperature` **0.7** · min-interval **OFF** · PASSIVE prefix-buffer **first `\n` or ~16 chars** · maxTurns **30**.

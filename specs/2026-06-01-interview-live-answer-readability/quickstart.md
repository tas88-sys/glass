# Quickstart: Interview Live Answer — Readability

**Spec**: `specs/2026-06-01-interview-live-answer-readability/spec.md`
**Date**: 2026-06-01

Two additive changes to the shipped Live Answer lane. Everything is in `summaryService.js` plus its test file. Closed files stay closed.

---

## What changes (exactly three edits + tests)

| # | File | Edit | FR |
|---|------|------|----|
| 1 | `src/features/listen/summary/summaryService.js` `:256-259` | Amend the injected **user message** `content` — add an always-on "headline + markdown bullets when there are supporting points" instruction; **keep the "reply EXACTLY: PASSIVE" directive verbatim** | FR-001, FR-003, FR-004 |
| 2 | `src/features/listen/summary/summaryService.js` (new helper near the other pure helpers, e.g. after `isLikelyQuestion` ~`:80`) | Add pure `extractQuestion(text)` reusing `CLAUSE_LEAD_RE`/`LEAD_STRIP_RE`/`CONTENT_CUE_RE`/`EMBEDDED_Q_RE`; export it after `:798` | FR-006, FR-007, FR-009 |
| 3 | `src/features/listen/summary/summaryService.js` `:451` | `question: text` → `question: extractQuestion(text)` | FR-008 |
| T | `src/features/listen/summary/__tests__/liveAnswer.test.js` | Add `describe('extractQuestion', …)` unit block (truth-table T1–T8) + non-regression integration assertions | FR-012 |

**DO NOT TOUCH** (CLOSED set — FR-010): `promptTemplates.js`, `makeOutlineAndRequests`, `triggerAnalysisIfNeeded`, the `summary-update` channel, `SummaryView.js`, `askService.js`, `featureBridge.js`, `listenService.js`, `LiveAnswerView.js`, `ListenView.js`, `preload.js`, and any DB/repository/config-schema file (in-memory only — FR-011).

---

## TDD order (Constitution Principle I — tests first, RED → GREEN)

1. **RED**: add the `extractQuestion` unit block to `liveAnswer.test.js` (T1–T8 from `data-model.md §E3`). Run — they fail (helper not defined / not exported).
2. **GREEN (helper)**: implement + export `extractQuestion`. Re-run — unit block passes.
3. **Wire**: change `:451` to `extractQuestion(text)`.
4. **Amend message**: edit the injected user-message `content` at `:256-259`.
5. **Non-regression**: confirm the existing PASSIVE-suppress (`:559`) and lane-independence (`:611`) integration tests still pass under the amended message; add an assertion that the emitted `question` field equals the extracted span.
6. **Full suite GREEN** before commit.

---

## Run the tests

```bash
# Just this lane's suite (fast iteration)
node --test src/features/listen/summary/__tests__/liveAnswer.test.js

# Full project test script (what CI/package.json runs)
npm test    # -> node --test src/**/__tests__/**/*.test.js
```

**Baseline (before any change)** — must already be green:

```
# tests 65
# suites 11
# pass 65
# fail 0
```

**Target (after change)**: baseline + ~6–9 new/changed tests, all passing; **zero** baseline tests regressed.

---

## Re-validate the contract (optional, Phase 0.3 gate)

```bash
cd specs/2026-06-01-interview-live-answer-readability/contracts
npx tsc --noEmit -p tsconfig.json    # exits 0 == Found 0 errors
```

---

## Manual smoke check (the one thing not automated — no Electron renderer harness in this repo)

1. Run the app: `npm start`.
2. Start a listen session; have the "interviewer" ask a multi-part technical question (e.g. "How does garbage collection work in Go, and when does it run?").
3. **Improvement 1**: the streamed answer in `<live-answer-view>` renders as a short headline **then a real bulleted `<ul><li>` list** — not one run-on paragraph with inline " - " separators.
4. Ask a filler-wrapped question ("Okay so, um, the thing I wanted to ask is — how would you design a rate limiter?").
5. **Improvement 2**: the small `Q:` label above the answer shows only "how would you design a rate limiter?", not the full filler turn.
6. Say a non-question statement → the panel **holds the last answer** (PASSIVE still suppresses; FR-003).
7. Confirm the answer renders **only** in the content-protected `listen` window (inherited safety invariant — do not disable content protection).

---

## Definition of done

- [ ] `extractQuestion` implemented, exported, and unit-tested (T1–T8) — FR-006/FR-007/FR-009/FR-012.
- [ ] `:451` passes `extractQuestion(text)` — FR-008.
- [ ] Injected user message amended; EXACT-`PASSIVE` directive preserved — FR-001/FR-003/FR-004.
- [ ] PASSIVE-suppress + lane-independence integration tests still green — FR-010.
- [ ] `streamChat` mechanics / `maxTokens=900` / temperature / two-arg `createStreamingLLM` / SSE loop UNCHANGED — FR-005.
- [ ] No CLOSED-set file modified; nothing persisted to DB — FR-010/FR-011.
- [ ] Full `npm test` green (baseline 65 + new, 0 regressions).
- [ ] Manual smoke check: bullets render, `Q:` label is clean, PASSIVE holds, content-protected window only.

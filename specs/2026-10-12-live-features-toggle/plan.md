---
# Context Optimization Metadata
# Purpose: Enable efficient partial reads (~200 tokens vs ~2500 for full file)
meta:
  spec_id: 2026-10-12-live-features-toggle
  spec_name: live-features-toggle
  phase: plan
  updated: 2026-10-12

# Quick Reference (for checkpoint resume)
summary:
  tech_stack: [JavaScript (CommonJS, main process), Lit 2.7.4 (renderer), Electron 30 / Node 20.16, node:test]
  external_deps: []   # no new dependency
  test_strategy: {unit: 70, integration: 0, contract: 0, e2e_manual: 30}
  deployment: immediate  # ships with the next Glass desktop build; the default mode changes nothing
---

# Implementation Plan: Live Features Toggle

**Branch**: `2026-10-12-live-features-toggle` | **Date**: 2026-10-12 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/2026-10-12-live-features-toggle/spec.md`

## Execution Flow (/plan command scope)

```
1. Load spec → Fill Technical Context → Constitution Check          ✓
2. Phase 0.1: Research + Testing Strategy (MANDATORY)               ✓
3. Phase 0.2: Permissions (single local user → trivial)            ✓ (N/A documented)
4. Phase 0.3: Integration Analysis (MANDATORY)                      ✓
5. Phase 0.4: Design Pre-flight (Minor UI → skip)                   ⏭ skipped
6. Phase 0.5: Infrastructure (no env var, no migration)             ✓
7. Phase 0.6: Error/Rescue Mapping                                  ✓
8. Phase 0.7: Implementation Timeline Risks (MANDATORY)             ✓
9. Phase 1: Design & Contracts → data-model.md, contracts/, quickstart.md  ✓
10. Plan Phase 2 approach                                           ✓
```

> SpecKit is not installed on this machine, so this set was written by hand in the format of `2026-10-12-cross-provider-failover` and its predecessors. `preflight-report.md` is not generated.

## Summary

Let the user choose which Listen assistants run: Live Answer only, Live Insights only, or both. A lane that is off makes no LLM call and sends no event, so it spends no tokens; its pane is hidden.

**Technical approach:**
- **One pure rule.** `liveFeatures.js` holds the three values, the cycle, the state and the view labels. The main process and the renderer import the same file.
- **Stored with the other options.** One key, `liveFeatures`, in the per-user settings store that already holds `askMode`. No table, column or migration.
- **A gate at each lane's entry.** `triggerAnswerIfNeeded` and `triggerAnalysisIfNeeded` return first when their lane is off. `makeLiveAnswer` and `makeOutlineAndRequests` are not touched, so the default mode is byte for byte today's behavior.
- **A field, not a subscription.** `SummaryService.setLiveFeatures(mode)` is set by `listenService` from the IPC handler and at session start. Turning Answer off pauses the lane: the debounce timer is cleared and a streaming answer is aborted, while the follow-up and company memory is kept.
- **The Listen window adapts.** One pane hidden per off lane, three label sets, an empty state for answer-only mode, and a copy button that copies the answers when the summary is off.
- **One button in Settings.** "Live panels: …" cycles through the three modes, with a one-line help.

## Technical Context

**Language/Version**: JavaScript (CommonJS in main, ES modules bundled by esbuild in renderer); Electron 30 (Node 20.16).
**Primary Dependencies**: none new.
**Storage**: none new. The key lives in the existing `electron-store` file under `users.<uid>`.
**Testing**: `node --test` via `npm test`. A real `SummaryService` over a stub LLM and a stub renderer sender (the pattern of `liveAnswerCareer.test.js`). The Lit views are checked by `npm run build:renderer`, by rendering the real components on a local page with a stubbed `window.api` (as T027 of the last spec did), and by hand.
**Target Platform**: Electron desktop (Windows primary; macOS must not break).
**Performance Goals**:
- Default mode adds one string comparison per lane trigger.
- A lane that is off adds no timer, no request, no event.
- Turning Answer off aborts an in-flight answer within one event-loop turn.

**Constraints**: spec C1–C6.
**Scale/Scope**:
- New: `liveFeatures.js` (~60 lines), 2 test files (~35–45 cases).
- Edited: `summaryService.js` (~30 added lines, no deletions), `listenService.js` (~20), `settingsService.js` (1), `featureBridge.js` (~30), `preload.js` (~8), `ListenView.js` (~45), `LiveAnswerView.js` (~25), `liveAnswerHistory.js` (~15), `SettingsView.js` (~35), `liveAnswerHistory.test.js` (additions), docs.

**System Context**: Framework-internal (spec System Context).
**Architecture Docs Read**:
- `ARCHITECTURE.md` §4 (IPC), §7–§8 (Listen, incremental summarization);
- `docs/LIVE_INSIGHTS_AND_ASK.md` §1, §3, §4;
- `docs/diagrams/09-summarization-pipeline.mmd`;
- `specs/2026-10-12-groq-provider/research.md` R5 (what each lane costs), `specs/2026-05-25-ask-mode-shortcuts/*` (the settings pattern).

## Constitution Check
*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Assessment | Status |
|-----------|------------|--------|
| I. Test-First Development | Each piece with logic has a test task before its implementation task (T010/T011, T012/T013, T015/T016). The Electron-only wiring and the Lit views cannot load under `npm test`; they are covered by the pure parts, `node --check`, the renderer build, a local render and the manual checks | PASS |
| II. Specification-Driven Development | User request → research (code, cost per lane, storage options) → spec → this plan → tasks.json | PASS |
| III. Verification Before Completion | Automated: SC-001..SC-005. Manual: SC-006 and quickstart §4 | PASS |
| IV. Skills Before Action | Cost figures come from the Groq spec's measured-from-code table (R5); nothing external is read | PASS |
| V. Code Review Compliance | One pure module; two early returns; the work functions untouched; no text in logs (C3) | PASS |

### AI & Machine Learning *(applicable)*

**Does this feature involve AI/ML?** [x] **Yes**: it decides which LLM lanes call a model.

| Aspect | Approach |
|--------|----------|
| Model choice | Unchanged; both lanes use the model list as today |
| Failure posture | A lane that is off never errors and never shows a message; a lane that is on fails as today |
| Rate limits | The feature removes calls: ~26% of a typical hour's tokens with Insights off, ~74% with Answer off (research R2) |
| Cost control | Off = no call. The gate precedes every cost: career lookup, prefetch, prompt, request |
| Data | Less is sent to the provider in a non-default mode, never more |

## Project Structure

### Documentation (this feature)
```
specs/2026-10-12-live-features-toggle/
├── spec.md
├── research.md
├── plan.md                 # this file
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── live-features-toggle.contracts.d.ts
│   ├── EDGE_CASES.md
│   └── tsconfig.json
├── tasks.json
└── acceptance-tests.yaml
```

### Source Code (repository root)
```
src/features/listen/
├── liveFeatures.js                                   NEW   rule, cycle, state, labels (pure)
├── __tests__/liveFeatures.test.js                    NEW
├── listenService.js                                  EDIT  setLiveFeatures; read the saved mode in initializeNewSession
└── summary/
    ├── summaryService.js                             EDIT  liveFeatures field, setLiveFeatures, pauseLiveAnswer, two early returns
    └── __tests__/summaryService.liveFeatures.test.js NEW   gates over a stub LLM
src/features/settings/settingsService.js              EDIT  default liveFeatures: 'both'
src/bridge/featureBridge.js                           EDIT  settings:getLiveFeatures, settings:setLiveFeatures
src/preload.js                                        EDIT  listenView and settingsView surface
src/ui/listen/
├── ListenView.js                                     EDIT  state, visibility, labels, copy, empty state flag, re-measure
└── summary/
    ├── LiveAnswerView.js                             EDIT  showEmptyState, getAnswerText
    ├── liveAnswerHistory.js                          EDIT  answersToText (additive)
    └── __tests__/liveAnswerHistory.test.js           EDIT  answersToText cases (additions only)
src/ui/settings/SettingsView.js                       EDIT  the button and its help
ARCHITECTURE.md, docs/LIVE_INSIGHTS_AND_ASK.md, docs/diagrams/09-summarization-pipeline.mmd,
README.md, CHANGELOG.md, docs/future-work.md          EDIT  (T-DOC-GATE)
```

**Structure Decision**: The rule lives in `src/features/listen/` beside the services that use it, and the renderer imports it from there (research R8). It is not under `src/ui/` because the main process needs it too.

## Phase 0.1: Research & Testing Strategy

### Production Log & Error Evidence
**Skip condition met**: `feature-minor`, no failure to reproduce. The motivation is a measured cost (research R2), not a bug.

### Research

Consolidated in [research.md](./research.md):

| # | Question | Decision |
|---|----------|----------|
| R1 | What are the two lanes and what do they share? | Two independent triggers in `SummaryService`; they share only the history |
| R2 | What does each cost? | Insights ~26% of a typical hour's tokens; Answer ~74% |
| R3 | Where is the choice stored? | The settings store, key `liveFeatures`; no schema |
| R4 | How does the mode reach the lanes? | A field set by `listenService`; early returns; work functions untouched |
| R5 | What does off do, and a mid-call change? | Answer: pause (timer, stream), keep memory. Insights: gate; an analysis in flight finishes |
| R6 | What else changes? | No summary row; empty state, copy and company detection handled; height needs no change |
| R7 | The control | One cycling button in Settings; Listen-bar toggle deferred |
| R8 | Sharing the rule | One CommonJS module imported by main and renderer |
| R10 | To verify live | Calls per mode, a mid-call switch, the answer-only window |

### Testing Strategy

| Check | Output |
|-------|--------|
| External APIs | None. The LLM is a stub in every test |
| Test types | Unit (rule, labels, `answersToText`, lane gates over a real `SummaryService`), build and local render (views), manual (quickstart §4) |
| Mocking strategy | `factory` replaced in `require.cache` before `summaryService` loads, as `liveAnswerCareer.test.js` does; `modelStateService.getCurrentModelInfo` stubbed; `sendToRenderer` replaced on the instance to record sends; `mock.timers` for the 800 ms debounce; `career` stubbed through `service.career` |

**Testing Summary**:
```
Feature type: Backend logic + small UI
Quota risks: None in tests; the manual checks spend a few requests
Estimated tests: ~35–45 cases across 2 new files + liveAnswerHistory additions
Distribution: Unit ~70%, Manual ~30%
```

**GATE**: No quota-limited API is called by the suite. PASS.

## Phase 0.2: Permissions Design

Single local user; no roles. N/A.

## Phase 0.3: Integration Analysis

### Codebase Pattern Discovery

| Pattern Area | Finding | Use |
|--------------|---------|-----|
| Per-user options | `settingsService.getDefaultSettings` (`:202`), `getSettings` (`:224`), `saveSettings` (`:240`): `askMode`, `preferredCodeLanguage` | Add `liveFeatures` the same way |
| Setting with its own IPC and a push | `mainHeader:getAskMode` / `setAskMode` (`featureBridge.js:84-102`) validate, save through `saveSettings`, then send to the header via `windowPool` | Same shape for `settings:getLiveFeatures` / `setLiveFeatures`, pushing to the listen window |
| Boolean button in Settings | `handleToggleAutoUpdate` (`SettingsView.js:563`), the button at `:1715` | The cycling button |
| Grey help line | `SettingsView.js:1744` | Help under the button |
| Lane triggers | `triggerAnswerIfNeeded` (`summaryService.js:559`), `triggerAnalysisIfNeeded` (`:980`), both called from `addConversationTurn` (`:682`) | The two gates |
| Abort-and-replace | `summaryService.js:611-615`, `:639-642` | `pauseLiveAnswer` reuses the abort path |
| Test harness for the lane | `liveAnswerCareer.test.js:1-70` (factory in `require.cache`, stubbed `modelStateService`) | `summaryService.liveFeatures.test.js` |
| Pure renderer helper | `liveAnswerHistory.js` (`module.exports`, imported with `import` in `LiveAnswerView.js:32`, tested with `require`) | `answersToText` there; `liveFeatures.js` follows the same module style |
| View visibility | `SummaryView.isVisible` (`:496`), `LiveAnswerView.isVisible` (`:414`), set in `ListenView.js:726-736` | Pane visibility |
| Window sizing | `ListenView.adjustWindowHeight` (`:540`) | Re-measure on a mode change |
| Session start | `listenService.initializeNewSession` (`:130-155`) | Load the saved mode |
| Push to the listen window | `listenWindow.webContents.send('session-state-changed', …)` (`listenService.js:69`) | The same call for `listen:liveFeaturesChanged` |
| Preload groups | `listenView` (`preload.js:188`), `settingsView` (`:220`) | New entries |

### Code Interconnectedness Gate

| Pattern Needed | Evidence | Decision |
|----------------|----------|----------|
| Settings storage | `settingsService` store | REUSE (D1) |
| Lane triggers | `summaryService.js` | EXTEND with two early returns and two methods (D4); the work functions unchanged |
| Abort path | `inFlightController` | REUSE |
| Renderer pure helpers | `liveAnswerHistory.js` | EXTEND with `answersToText`; new `liveFeatures.js` in the same style |
| Pane components | `LiveAnswerView`, `SummaryView` | REUSE; `isVisible` already exists on both; one new property |
| Window notifications | `windowNotificationManager` reaches only `settings` and `main` | NOT USED; a direct send to the listen window |

### Contract Validation

`contracts/live-features-toggle.contracts.d.ts` was type-checked with `npx -p typescript@5.4.5 tsc -p contracts/tsconfig.json`: **PASS** (2026-10-12).

## Phase 0.4: Design Pre-flight

**Skipped**: Minor UI (one button, one help line, one empty-state line).

## Phase 0.5: Infrastructure & Migrations

| Item | Detail |
|------|--------|
| Env vars | None |
| Dependency | None |
| DB migrations | None |
| Rollout | Ships with the next build. Everyone starts on 'both' |
| Rollback | Revert the branch. The stored `liveFeatures` key is ignored (quickstart §5) |

## Phase 0.6: Error/Rescue Mapping

See spec § Error Handling and `data-model.md`. The rules:
- **Every unknown value reads as 'both'.** The lanes never end up both off by accident: there is no mode with both off, and nothing outside the three values is stored.
- **The setter validates; the service normalizes.** The IPC refuses an invalid mode; `SummaryService.setLiveFeatures` normalizes whatever it gets.
- **Reads never throw to the user.** A failed settings read at session start and a failed `getLiveFeatures` in a view both leave 'both'.

## Phase 0.7: Implementation Timeline Risks

| Phase | Anticipated Blocker | Resolution | Add to Task Context? |
|-------|--------------------|------------|---------------------|
| Core | `SummaryService` loading in a test pulls `modelStateService` and the repositories | The pattern of `liveAnswerCareer.test.js` loads it today: `factory` replaced in `require.cache`, `modelStateService.getCurrentModelInfo` stubbed. The repositories load without opening a database | Y (T012) |
| Core | The 800 ms debounce makes the answer lane slow to test | `mock.timers.enable({ apis: ['setTimeout'] })` and `tick(800)`, then a `setImmediate` flush; `liveAnswerCareer.test.js` drives the real trigger this way (`liveAnswer.test.js` drives a copy of it with its own fake clock, which is why the new tests do not follow that file) | Y (T012) |
| Core | `triggerAnalysisIfNeeded` ends in `sendToRenderer`, which `require`s `windowManager` (Electron) | Replace `service.sendToRenderer` on the instance with a recorder before the test | Y (T012) |
| Core | `makeOutlineAndRequests` writes a summary row through `summaryRepository` | The save runs only with a session ID (`:771-773`, `:830-843`), so a test that leaves `currentSessionId` null would prove nothing. The test sets one and replaces `sessionRepository.touch` and `summaryRepository.saveSummary` on the module objects with counters (both are looked up at call time). 'both' must count one save per analysis, so the zero in 'answer' mode is meaningful | Y (T012) |
| Core | Aborting Answer must not touch the career memory | `pauseLiveAnswer` is separate from `resetLiveAnswer`; a test sets `careerPrev` and `activeCompany`, pauses, and asserts both survive | Y (T012/T013) |
| Wiring | `listenService` requiring `settingsService` at the top creates a load cycle (`settingsService` → `windowManager` → …) | Require it lazily inside `initializeNewSession`, as the file already does for `windowManager`; `node --check` plus the manual start | Y (T014) |
| Wiring | `featureBridge`, `listenService` and `settingsService` cannot load under `npm test` (electron, better-sqlite3 ABI) | Their logic is `normalizeLiveFeatures` and the early returns, both tested; the rest is `node --check` and grep guards (AT-CLI-005/006) | Y (T014) |
| UI | The renderer bundle must resolve an import from `src/ui/…` into `src/features/listen/liveFeatures.js` | esbuild resolves relative paths; `liveAnswerHistory.js` shows CommonJS is accepted. `npm run build:renderer` is the check. If it fails, fall back to a renderer-side copy plus a test that compares the tables | Y (T016) |
| UI | Hiding the Summary pane leaves `.insights-pane` with only `LiveAnswerView`, which renders nothing with no answers | `showEmptyState` (FR-015). The local render checks the height in all three modes | Y (T016) |
| UI | The listen window must re-measure after a mode change or it keeps the old height | Call `adjustWindowHeight()` from the `listen:liveFeaturesChanged` handler, the initial read and the session-start read | Y (T016) |
| UI | `LiveAnswerView` is a shadow-DOM component; the empty-state style must be defined in it | Copy the three CSS lines of `SummaryView`'s `.empty-state` into `LiveAnswerView`'s static styles | Y (T016) |
| UI | A removed listener leaks if `disconnectedCallback` does not remove it | `removeOnLiveFeaturesChanged` in `disconnectedCallback`, with the same callback reference | Y (T016) |
| Verify | Feeding `them` turns without a real interviewer | Play a mock interview on the system audio channel (quickstart §4) | Y (T-VERIFY-MANUAL) |
| Verify | `liveAnswer.test.js` flakes under the parallel suite (pre-existing) | Rerun; not an assertion failure | N |
| Verify | `npm run lint` cannot run (eslint not installed) | `node --check` on changed main-process files + `npm run build:renderer` | Y (T-FINAL) |

## Prior Lessons Applied

| Lesson | Applied How |
|--------|-------------|
| An abort must end quietly (`gemini.js:669-675`, `summaryService.js:639-642`) | After `pauseLiveAnswer` the aborted answer sends no text and no error; only `makeLiveAnswer`'s existing `status: 'idle'` may follow (`:490-495`). A test asserts exactly that |
| A view must not keep a mode read before the user changed | `ListenView` reads the mode again at each session start (FR-011) |
| `resetLiveAnswer` clears career memory (`:719-720`) | A separate `pauseLiveAnswer` |
| Fakes too lenient pass while production differs | The lane tests use the real `SummaryService`, not a copy of its gate |
| Existing tests must stay (Groq AT-NEG-007, chain AT-NEG) | `liveAnswer*.test.js` guarded by a zero-diff check; `liveAnswerHistory.test.js` additions only |
| A renderer copy of a rule drifts (`SettingsView.getProviderForModel`) | One shared module (R8) |
| The listen window is not a "relevant window" for `settings-updated` (`settingsService.js:20`) | A direct, dedicated push |

## Phase 1: Design & Contracts

1. **[data-model.md](./data-model.md)** covers:
   - the setting, the mode table, the state and the labels;
   - the service field and `answersToText`;
   - the IPC and the state transitions.
2. **[contracts/live-features-toggle.contracts.d.ts](./contracts/live-features-toggle.contracts.d.ts)** gives the surfaces of `liveFeatures.js`, the `SummaryService` and `listenService` additions, the IPC and the renderer additions. Type-checked: PASS.
3. **[contracts/EDGE_CASES.md](./contracts/EDGE_CASES.md)** lists 46 edge cases mapped to FRs.
4. **[quickstart.md](./quickstart.md)** covers the three modes, where to change them, automated checks and 11 manual checks.

## Phase 2: Task Planning Approach

Tests before implementation for each piece:
1. The pure rule and labels.
2. The lane gates on the real service.
3. The wiring: store default, IPC, preload, session start.
4. `answersToText`, then the Listen window.
5. The Settings button.
6. The renderer build and a local render in all three modes.
7. Docs, then the live checks.

There is no SDK task and no live probe: nothing external is called.

| Group | Tasks | Gate |
|-------|-------|------|
| Rule | T010–T011 | none |
| Lanes | T012–T013 | T011 |
| Wiring | T014 | T013 |
| Listen window | T015–T016 | T014 |
| Settings | T017 | T014 |
| Render check | T018 | T017 (after T016) |
| Docs | T019, T-DOC-GATE | T018 |
| Verify | T-VERIFY-MANUAL, T-FINAL | T-DOC-GATE |

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

**Gates**: Constitution Check PASS · No NEEDS CLARIFICATION (three items deferred with defaults) · Contracts tsc PASS · Bugfix gate N/A

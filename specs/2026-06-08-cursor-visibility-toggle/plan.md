---
# Context Optimization Metadata
# Purpose: Enable efficient partial reads (~200 tokens vs ~2500 for full file)
meta:
  spec_id: 2026-06-08-cursor-visibility-toggle
  spec_name: cursor-visibility-toggle
  phase: plan            # Current phase in SpecKit workflow
  updated: 2026-06-08    # ISO date of last update

# Quick Reference (for checkpoint resume)
summary:
  tech_stack: [JavaScript (Node 18+/Electron), Lit 2.7.4, node:test]
  external_deps: []      # none — internal renderer/main change
  test_strategy: {unit: pure-logic-helpers, integration: light-glue, e2e: manual}
  deployment: immediate  # client app, no migration/feature-flag
---

# Implementation Plan: Preserve Cursor/Focus Across Visibility Toggle

**Branch**: `main` (mainline development) | **Date**: 2026-06-08 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/2026-06-08-cursor-visibility-toggle/spec.md`

## Execution Flow (/plan command scope)

```
1. Load spec → Fill Technical Context → Constitution Check       [x]
2. Phase 0.1: Research + Testing Strategy (MANDATORY)            [x]
3. Phase 0.2: Permissions (skipped — single-user desktop app)    [-]
4. Phase 0.3: Integration Analysis (MANDATORY)                   [x]
5. Phase 0.4: Design Pre-flight (skipped — Minor UI)             [-]
6. Phase 0.5: Infrastructure (skipped — no env/migration/deprec) [-]
7. Phase 0.6: Error/Rescue Mapping (MANDATORY here — has Error Handling) [x]
8. Phase 0.7: Implementation Timeline Risks (MANDATORY)          [x]
9. Phase 1: Design & Contracts → data-model.md, contracts/, quickstart.md [x]
10. Plan Phase 2 approach (DO NOT create tasks.md)               [x]
11. STOP - Ready for /tasks command                             [x]
```

## Summary

After pressing the global visibility shortcut (`Cmd+\` macOS / `Ctrl+\` Win/Linux) to hide the Glass overlay and pressing it again to show it, the Ask text input loses DOM focus and its caret position — the user must click into the field before they can type again. Root cause (verified by source trace + `debug-cw` Phase 4) is three compounding gaps: (1) `changeAllWindowsVisibility()`'s show branch calls only `win.show()` with no `win.focus()`/`win.moveTop()`, so the OS never hands keyboard focus back to the `ask` renderer; (2) `focusTextInput()` only re-fires on a `showTextInput` property *change* or an explicit IPC event, neither of which fires on a bare OS window re-show (`showTextInput` stays `true`); (3) the renderer never snapshots/restores the caret selection range and has no `visibilitychange` bridge.

**Technical approach (locked by Clarifications D1-D3):** *Renderer self-restore (Option A).* The `ask` renderer survives the OS hide/show cycle and already owns the two facts the fix needs (`isInputFocused` + caret range). Main's job shrinks to making the `ask` window OS-focus-eligible on re-show; the renderer re-applies focus + caret on `visibilitychange` -> visible, deferred to `requestAnimationFrame`. **No new IPC channel.** The no-steal guard (FR-004) is a renderer-side rule: a `blur` coinciding with `document.hidden===true` is hide-induced and PRESERVES the caret snapshot; a genuine blur before hide CLEARS it.

Because the project has **no DOM test harness** (no jsdom/happy-dom; tests are pure-logic `node:test`), the decision logic is extracted into two pure helpers — `caretSnapshot.js` (save/restore/clamp) and `focusRestoreDecision.js` (blur-guard + show-eligibility) — so the testable surface is DOM-free, mirroring the existing `liveAnswerHistory.js` convention. The thin DOM/Electron glue that calls these helpers is covered by manual verification (quickstart) plus a small main-process stub test.

## Technical Context

**Language/Version**: JavaScript (CommonJS in main process, ES modules via Lit in renderer); Node 18+ runtime bundled with Electron.
**Primary Dependencies**: Electron (`BrowserWindow`), Lit 2.7.4 (`AskView` web component). No new dependencies.
**Storage**: N/A — the focus snapshot is transient in-memory renderer state, never persisted.
**Testing**: Node built-in test runner — `npm test` -> `node --test src/**/__tests__/**/*.test.js`, using `node:test` + `node:assert/strict`. No jsdom/Jest/Vitest/Playwright present.
**Target Platform**: Desktop — macOS (`Cmd+\`) and Windows/Linux (`Ctrl+\`); behavior must be identical (FR-007).
**Project Type**: Single project (Electron app). Renderer in `src/ui/ask/`, main/window glue in `src/window/`, shortcut registration in `src/features/shortcuts/`.
**Performance Goals**: Focus/caret restore must land within one animation frame after show; no perceptible delay. rAF coalescing covers rapid double-toggle.
**Constraints**: MUST NOT alter click-through / `setIgnoreMouseEvents` state (FR-005). MUST NOT steal focus when the input was not focused before hide (FR-004). MUST NOT open/focus Ask when it was not in the visible set before hide (Edge Case).
**Scale/Scope**: 1 user (local desktop). ~3 source files touched + 2 new pure-helper modules + tests.
**System Context**: Glass (Electron desktop overlay app) — framework-internal. No CW backend, database, or integration. Files: `src/features/shortcuts/shortcutsService.js`, `src/window/windowManager.js`, `src/ui/ask/AskView.js`.
**Architecture Docs Read**: cw-documentation unavailable at `~/coverwhale/cw-documentation/` (confirmed during Phase 0). System Context derived directly from the Glass repository source — file:line citations verified against current HEAD during this plan (see research.md "Source Verification").

## Constitution Check
*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Applies? | How this plan satisfies it |
|-----------|----------|----------------------------|
| I. Test-First (NON-NEGOTIABLE) | YES | Pure-logic helpers (`caretSnapshot`, `focusRestoreDecision`) get failing `node:test` specs written first (Red), then implementation (Green). Tasks order tests before glue. |
| II. Specification-Driven | YES | `/specify` -> `/clarify` -> `/plan` (this) followed; `/tasks` -> `/feature-start` -> `/implement` next. No manual artifact authoring. |
| III. Verification Before Completion | YES | `npm test` output + manual quickstart steps (with observed result) are the completion evidence; no claim without pasted output. |
| IV. Skills Before Action | YES | `debug-cw` invoked (bugfix gate), `memory-retrieval` re-run inline (Phase 0.7.5). |
| V. Code Review Compliance | YES | Change is small, pattern-following (mirrors `settings`/`mode-picker` show path + existing rAF focus pattern); error paths guarded (isDestroyed/null/clamp). |

### AI & Machine Learning (Constitution Principle IV)

**Does this feature involve AI/ML?**
- [x] **No** - Skip this section. (Focus/caret lifecycle bugfix; no model inference, scores, or AI decisions.)

**Constitution Check: PASS** (re-checked after Phase 1 — still PASS; no new gates triggered by design.)

## Project Structure

### Documentation (this feature)
```
specs/2026-06-08-cursor-visibility-toggle/
├── plan.md              # This file (/plan command output)
├── research.md          # Phase 0 output (/plan command)
├── data-model.md        # Phase 1 output (/plan command)
├── quickstart.md        # Phase 1 output (/plan command)
├── contracts/           # Phase 1 output (/plan command) — JS helper contracts + tsc-checkable .d.ts
└── tasks.md             # Phase 2 output (/tasks command - NOT created by /plan)
```

### Source Code (repository root)
```
src/
├── features/
│   └── shortcuts/
│       └── shortcutsService.js        # (read-only ref) registers Cmd/Ctrl+\ -> toggleAllWindowsVisibility
├── window/
│   └── windowManager.js               # EDIT: changeAllWindowsVisibility() show branch — focus the ask window
└── ui/
    └── ask/
        ├── AskView.js                 # EDIT: blur handler, visibilitychange listener, caret restore in focusTextInput
        ├── caretSnapshot.js           # NEW: pure save/restore/clamp helpers (no DOM)
        ├── focusRestoreDecision.js    # NEW: pure blur-guard + show-eligibility decision (no DOM)
        └── __tests__/
            ├── caretSnapshot.test.js          # NEW: unit (pure)
            └── focusRestoreDecision.test.js   # NEW: unit (pure)
```

**Structure Decision**: Single-project Electron layout. New pure helpers live beside `AskView.js` under `src/ui/ask/`, with co-located `__tests__/` exactly matching the existing `src/ui/listen/summary/` + `src/features/.../__tests__/` convention so `npm test`'s glob (`src/**/__tests__/**/*.test.js`) picks them up with zero config change. Main-process change is confined to one function in `windowManager.js`.

## Prior Lessons Applied

| Confidence | Lesson | Source | Applied How |
|------------|--------|--------|-------------|
| 0.80 | speckit-home-not-installed-locally: SpecKit commands in the glass repo fail `cw_assert_preconditions` because `~/.claude/specify` isn't installed; workaround `CW_SPECIFY_HOME=<repo>/.specify` (type: project) | `speckit-home-not-installed-locally.md` | Already load-bearing this run — set `CW_SPECIFY_HOME=<repo>/.specify` so `setup-plan.sh` resolved paths; the same env var is required for `/tasks`, `/preflight`, `/feature-start`. Also watched the fuzzy `specs/<name>-*` glob: the sibling `2026-06-08-listen-transcript-text-selection` does not collide with this spec key, so the exact match held. |
| 0.80 | stt-session-not-active-is-stopstart-race: Glass STT "session not active" is a Stop/Start capture-lifecycle race, not a Deepgram drop; reconnect must ignore deliberate-close signals (type: project) | `stt-session-not-active-is-stopstart-race.md` | Mirror the lifecycle-race discipline: the rapid-double-toggle edge case is the analogue here. Restore must be idempotent and coalesced (single rAF) so a second show before the first frame fires does not focus-then-lose — the same "distinguish deliberate vs incidental signal" reasoning the STT fix used (`client` close vs real drop) maps to "hide-induced blur (`document.hidden===true`) vs genuine blur." |
| 0.55 | glass-prs-target-fork-not-upstream: `gh pr create` defaults base to the `pickle-com` upstream and fails; pass `--repo tas88-sys/glass` (type: project) | `glass-prs-target-fork-not-upstream.md` | Out of `/plan` scope but applies at ship time: if this work goes out via PR rather than mainline push, target the fork explicitly (`--repo tas88-sys/glass --base main`). Mainline workflow here means a direct push is also acceptable. |

## Phase 0.1: Research & Testing Strategy
*MANDATORY - Always execute this phase*

### Production Log & Error Evidence
*REQUIRED — spec front-matter `critical_requirements.type: bugfix`*

**Bugfix gate: SATISFIED.** `debug-cw` was invoked inline during this `/plan` (before template execution) per the mandatory bugfix gate.

| Source | Query | Findings (pasted inline) |
|--------|-------|--------------------------|
| SigNoz (production logs) | N/A — no CW `display_id` present in spec | **Not applicable.** This is an Electron client-side focus/visibility lifecycle defect with no server-side telemetry. No display_id pattern exists anywhere in the spec (grep for `\b\d{12}\b`, `submission #`, `display_id:`, `/transportation/` -> 0 matches). No query attempted; none valid. |
| Sentry (production exceptions) | N/A | Not applicable — no runtime exception is thrown; symptom is purely behavioral (lost DOM focus). |
| Source trace (code) | `windowManager.js:258-262`, `AskView.js:960-967`, `:1341-1343`, `:956-958` | Confirmed all three gaps below by reading current HEAD. |

**Outcome premise** (mandatory):
- `PREMISE L1: zero-results-with-cause` — No production logs exist because this is a local Electron focus-lifecycle defect, not a server error. Root cause is fully established by source trace (consistent with the spec's `PREMISE B1`).

**debug-cw independent confirmation (verified against current HEAD this plan):**
- Gap 1 (main): `changeAllWindowsVisibility()` show branch (`windowManager.js:258-262`) calls only `win.show()` in the `lastVisibleWindows.forEach` — no `win.focus()` / `win.moveTop()`. By contrast the `settings`/`mode-picker` show paths DO call `win.moveTop()` (+`setAlwaysOnTop(true)`) at `:316`/`:350`.
- Gap 2 (renderer trigger): `focusTextInput()` (`:960-967`) is only invoked from `onShowTextInput` (`:803-811`), `onAskStateUpdate` when `wasHidden` (`:826-832`), and `updated()` when `showTextInput` *changes* (`:1341-1343`). On a bare OS re-show `showTextInput` stays `true`, so none fire.
- Gap 3 (renderer caret): `handleInputFocus()` (`:956-958`) only sets `isInputFocused=true`; there is NO blur handler, NO `isInputFocused` reset, NO caret snapshot, and `isInputFocused` is a plain instance field (NOT in `static properties` `:5-19`, NOT initialized in the constructor `:738-774`). `focusTextInput()` calls `textInput.focus()` only — it never touches `selectionStart`/`selectionEnd`. The `#textInput` element binds only `@focus` (`:1425`), no `@blur`.

**⚠️ GATE**: Pasted source evidence + explicit zero-results-with-cause premise present -> gate satisfied.

### Research

See `research.md` for the full Decision/Rationale/Alternatives writeup. Headline decisions (all pre-locked by spec Clarifications D1-D3, re-verified against code here):

1. **Restore lives in the renderer (Option A)**, not main, not a new IPC channel. Rationale: the renderer survives the OS hide and already holds `isInputFocused` + caret. Alternatives B (re-emit `ask:showTextInput`) and C (new `ask:restoreFocus` channel) rejected — B conflates "open input" with "restore focus" and always focuses (breaks FR-004); C duplicates state the renderer owns.
2. **`visibilitychange` -> visible is the restore trigger**, backed by main making the `ask` window OS-focus-eligible. Rationale: the show path has no `onComplete`; `visibilitychange` is the only event that fires when the OS un-hides the renderer's document.
3. **Defer the actual `.focus()` + selection-set to `requestAnimationFrame`**, reusing the existing `focusTextInput()` rAF pattern (`:961`), so it lands after show/layout completes (FR-006) and coalesces rapid double-toggle.
4. **Extract decision logic into pure helpers** (`caretSnapshot.js`, `focusRestoreDecision.js`) because the repo has no DOM test harness — this is the only way to satisfy Constitution Principle I (test-first) for this bug.
5. **Use `win.focus()` + `win.moveTop()` on re-show, but NOT `setAlwaysOnTop(true)`** — `focus`/`moveTop` grant keyboard eligibility without persisting always-on-top z-state (the settings path sets always-on-top because it later clears it on hide; the toggle has no such teardown, so persisting it would be a regression). Neither call touches `setIgnoreMouseEvents`, so FR-005 holds.

### Testing Strategy

| Check | Output |
|-------|--------|
| External APIs | None -> Risk: LOW (no quota-limited API anywhere in this change) |
| Test types | Unit (pure helpers) + light integration (main-process stub) + manual E2E (quickstart) |
| E2E permitted? | Yes — but only manual (no Playwright/Spectron in repo). Automated E2E not added. |
| Mocking strategy | Main-process test stubs `windowPool` with mock `BrowserWindow` objects exposing `isDestroyed/isVisible/show/focus/moveTop` spies. Renderer DOM is NOT mocked — decision logic is extracted to pure functions instead. |

**Testing Summary**:
```
Feature type: Frontend-heavy (Electron renderer + window/main glue)
Quota risks: None
Estimated tests: ~7 (caretSnapshot: 3-4 unit, focusRestoreDecision: 3-4 unit, windowManager show-focus: 1-2 integration-stub)
Distribution: Unit ~70%, Integration ~25%, E2E (manual) ~5%, Contract 0%
```

**⚠️ GATE**: No HIGH-RISK APIs -> no E2E prohibition. Proceed.

**Output**: research.md, Testing Strategy documented.

## Phase 0.2: Permissions Design
*SKIPPED* — Spec "Permissions & Access Control" is N/A (single-user local desktop app; no roles, no server-enforced permissions, no multi-tenant scope). No permission resources exist to model.

## Phase 0.3: Integration Analysis
*MANDATORY - Always execute this phase*

### Codebase Pattern Discovery

| Pattern Area | Finding |
|--------------|---------|
| Window show + focus | `settings`/`mode-picker` show paths use `win.show(); win.moveTop(); win.setAlwaysOnTop(true)` (`windowManager.js:315-317`, `:349-351`). The toggle show path (`:258-262`) omits all focus calls — this is the gap. |
| Renderer focus | `focusTextInput()` wraps `textInput.focus()` in `requestAnimationFrame` (`AskView.js:960-967`). Reuse this exact deferral for caret restore. |
| Reactive state | `AskView.static properties` (`:5-19`) lists reactive props; `isInputFocused` is deliberately NOT there — it's transient instance state. Keep it that way (a focus flag changing should not trigger Lit re-render). |
| Handler binding | Handlers are `.bind(this)` in the constructor (`:761-768`). New `handleInputBlur` / `handleVisibilityChange` follow the same binding convention. |
| Pure-logic test convention | `liveAnswerHistory.js` + `__tests__/liveAnswerHistory.test.js` — pure reducer, "no Lit/DOM coupling" (file header). New helpers mirror this exactly. |
| Test runner | `npm test` = `node --test src/**/__tests__/**/*.test.js`; tests use `node:test` + `node:assert/strict`. |

### Data Contracts

| Entity | Renderer (in-memory) | Persisted | Notes |
|--------|----------------------|-----------|-------|
| Focus snapshot | `{ wasInputFocused: boolean, start: number, end: number }` | Never | Transient; lives on the `AskView` instance (`this._caretSnapshot`). Cleared on genuine blur / after restore. |

No DB format, no API format — there is no wire transfer. (No new IPC channel per D1.)

### Code Interconnectedness Gate

LSP-style reuse decisions (evidence = file:line read during this plan, pasted in research.md "Source Verification"):

| Pattern Needed | Evidence | Decision |
|----------------|----------|----------|
| Deferred focus (post-layout) | `AskView.js:960-967` `focusTextInput()` already uses `requestAnimationFrame` | **REUSE** — extend `focusTextInput()` to optionally apply a caret range inside the same rAF; do not write a second deferral mechanism. |
| Window OS-focus on show | `windowManager.js:316`,`:350` `win.moveTop()` (settings/mode-picker) | **REUSE pattern** — add `win.focus()`+`win.moveTop()` to the toggle show branch; do NOT copy `setAlwaysOnTop(true)` (no teardown exists for the toggle). |
| Input focused flag | `AskView.js:956-958` `handleInputFocus()` sets `isInputFocused` | **EXTEND** — add the missing blur counterpart + init; do not introduce a parallel flag. |
| Pure helper + co-located test | `src/ui/listen/summary/liveAnswerHistory.js` (+ `__tests__`) | **REUSE convention** — new `caretSnapshot.js` / `focusRestoreDecision.js` follow the same module + test shape. |

**Evidence Required**: LSP/read output pasted in research.md (Source Verification section). No claims without proof.

### Contract Validation (new interfaces)

Two new pure modules expose typed function signatures. Contracts captured as `.d.ts` in `contracts/` and validated with `tsc --noEmit` (the `.d.ts` stand alone). See `contracts/` and quickstart for the command + expected "Found 0 errors" output.

**⚠️ GATE**: LSP evidence pasted, contract `.d.ts` type-checks -> proceed.

**Output**: Integration analysis documented; reuse verified (no duplication introduced).

## Phase 0.4: Design Pre-flight
*SKIPPED* — Spec UI classification is **Minor UI** (`critical_requirements.ui_changes: minor`; spec §UI/Design Reference checks "Minor UI (<3 components, existing patterns only)"). No new components, no visual surface change — only focus/caret behavior on the existing `#textInput`. No Figma, no design tokens to verify.

## Phase 0.5: Infrastructure & Migrations
*SKIPPED* — No env vars, no SSM, no database migrations, no deprecations. Pure client-side code change. Rollout: **Immediate** (ships with the next renderer build; `npm run build:renderer`). No deployment ordering concerns.

## Phase 0.6: Error/Rescue Mapping
*MANDATORY here — spec has an Error Handling & Recovery section.*

**Error/Rescue Registry**:
| Method/Codepath | What Can Go Wrong | Exception Class | Rescued? | Rescue Action | User Sees |
|-----------------|-------------------|-----------------|----------|---------------|-----------|
| `windowManager.changeAllWindowsVisibility` show branch | `ask` window destroyed between hide and show | (no throw — guard) | Y | `if (askWin && !askWin.isDestroyed() && lastVisibleWindows.has('ask'))` before `.focus()` | Nothing (silent) — overlay shows, no crash |
| `AskView.focusTextInput` (caret apply) | `#textInput` absent in shadow DOM at restore time | (no throw — null-check) | Y | Existing `if (textInput)` null guard; skip caret apply if element missing | Nothing (silent) |
| `caretSnapshot.restore` (pure) | Saved range out of bounds after text changed | (no throw — clamp) | Y | Clamp `start`/`end` to `[0, value.length]`; fall back to caret-at-end if both invalid | Caret at end (graceful) |
| `AskView.handleVisibilityChange` | Fires while `_caretSnapshot` is null (input wasn't focused) | (no throw — guard) | Y | `focusRestoreDecision` returns `shouldRestore=false` -> no `.focus()` call (FR-004 no-steal) | Nothing — prior focus untouched |

**Failure Modes Registry**:
| Codepath | Failure Mode | Rescued? | Test? | User Sees? | Logged? |
|----------|-------------|----------|-------|------------|---------|
| Window show -> focus restore | Window destroyed | Y (isDestroyed guard) | Y (main stub test) | Nothing (silent) | Optional debug log |
| Renderer caret restore | Element missing | Y (null check) | Y (pure helper returns no-op shape) | Nothing (silent) | N |
| Renderer caret restore | Range out of bounds | Y (clamp) | Y (caretSnapshot.test) | Caret at end (graceful) | N |
| visibilitychange | No snapshot (input not focused) | Y (decision returns false) | Y (focusRestoreDecision.test) | Nothing (no steal) | N |

**GATE**: Zero rows with `Rescued=N + Test=N + User Sees=Silent` -> PASS (every silent path is both rescued and tested).

**Output**: Registries populated above.

## Phase 0.7: Implementation Timeline Risks
*MANDATORY - Always execute this phase*

| Phase | Anticipated Blocker | Resolution | Add to Task Context? |
|-------|--------------------|------------|---------------------|
| Phase 1 (pure helpers) | Caret range may exceed input length if text mutated during hide (IPC stream). | `caretSnapshot.restore` clamps to `value.length`; test the clamp explicitly. | Y — caretSnapshot task |
| Phase 1 (pure helpers) | Distinguishing hide-induced blur from genuine blur is the crux of FR-004; getting it wrong either steals focus or never restores. | Rule is locked: blur with `document.hidden===true` -> PRESERVE snapshot; blur with `document.hidden===false` -> CLEAR. Encode as `focusRestoreDecision.onBlur(documentHidden, prevSnapshot)`. | Y — focusRestoreDecision task |
| Phase 2 (renderer glue) | `visibilitychange` listener must be removed in `disconnectedCallback` or it leaks across AskView teardown (existing teardown removes `keydown` + IPC listeners at `:844-865`). | Bind `handleVisibilityChange` in constructor; `document.addEventListener` in `connectedCallback` (after the existing IPC setup), `document.removeEventListener` in `disconnectedCallback`. | Y — AskView glue task |
| Phase 2 (renderer glue) | `@blur` binding does not exist on `#textInput` today (only `@focus` at `:1425`); must add it without disturbing the existing focus binding. | Add `@blur=${this.handleInputBlur}` adjacent to `@focus`. `isInputFocused` must also be initialized in the constructor (currently undefined until first focus). | Y — AskView glue task |
| Phase 3 (main glue) | Only the `ask` window should be focused — focusing `header` or others could change z-order/steal differently; and only when `ask` was actually in `lastVisibleWindows`. | Guard: focus the `ask` window specifically, gated on `lastVisibleWindows.has('ask')`. Do NOT add `setAlwaysOnTop(true)`. | Y — windowManager task |
| Phase 4 (verify) | No automated way to assert real OS focus / caret on screen — repo has no DOM/E2E harness. | Pure helpers carry the automated coverage; window glue gets a stub test; the actual on-screen behavior is verified by the manual quickstart steps (documented, with the exact toggle sequence + expected caret position). | Y — quickstart referenced in verify task |

**Output**: Timeline risks documented; carry the flagged items into `/tasks` task-context fields.

## Phase 1: Design & Contracts
*Prerequisites: Phases 0.1, 0.3, 0.6, 0.7 complete; 0.2/0.4/0.5 skipped per skip conditions.*

Artifacts generated in this directory:
- **`data-model.md`** — the transient Focus Snapshot entity + the two pure-helper function signatures and their state-transition rules (blur-guard table, clamp rules).
- **`contracts/caretSnapshot.d.ts`**, **`contracts/focusRestoreDecision.d.ts`** — TypeScript signatures for the pure helpers; `tsc --noEmit` clean.
- **`contracts/windowManager.show-focus.md`** — behavioral contract for the main-process change (inputs, the focus gate, what MUST NOT change: click-through, always-on-top).
- **`quickstart.md`** — exact manual reproduction + verification steps across macOS/Win, plus `npm test` invocation.

**Agent file update**: `.specify/scripts/bash/update-agent-context.sh claude` is best-effort on this machine (per the speckit-home memory lesson) and is run in the Final Step; failure is non-blocking.

**Output**: data-model.md, contracts/*, quickstart.md.

## Phase 2: Task Planning Approach
*Executed by /tasks command, NOT /plan*

**Strategy**: Test-first per Constitution I. Pure helpers (with failing tests) before glue; glue before manual verify.

| From | Task Type | Order |
|------|-----------|-------|
| `contracts/caretSnapshot.d.ts` + data-model | Unit test `caretSnapshot.test.js` (fails) -> implement `caretSnapshot.js` [P] | 1st |
| `contracts/focusRestoreDecision.d.ts` + data-model | Unit test `focusRestoreDecision.test.js` (fails) -> implement `focusRestoreDecision.js` [P] | 1st (parallel) |
| `contracts/windowManager.show-focus.md` | Main-process stub test -> edit `windowManager.js` show branch | 2nd |
| AskView integration | Wire blur handler + `visibilitychange` + caret restore into `AskView.js` using the two helpers | 3rd |
| quickstart.md | Manual verification (macOS + Windows), record observed caret behavior | 4th (verify) |

**Constraints**: No automated E2E (no harness). Pure helpers must be import-clean (no DOM/Electron import) so `node:test` runs them headless. The `[P]` helpers are independent and may be built in parallel.

## Progress Tracking

| Phase | Status | Skip If |
|-------|--------|---------|
| 0.1 Research + Testing | [x] Complete | Never |
| 0.2 Permissions | [-] Skipped | No roles in spec (confirmed) |
| 0.3 Integration | [x] Complete | Never |
| 0.4 Design Pre-flight | [-] Skipped | Minor UI (confirmed) |
| 0.5 Infrastructure | [-] Skipped | No env/migrations/deprecations (confirmed) |
| 0.6 Error/Rescue Mapping | [x] Complete | No service modules / no error handling |
| 0.7 Timeline Risks | [x] Complete | Never |
| 1 Design & Contracts | [x] Complete | - |
| 2 Task Planning | [x] Approach documented (tasks.md by /tasks) | - |

**Gates**: Constitution Check PASS · All NEEDS CLARIFICATION resolved (3 clarification answers in spec) · Bugfix gate (debug-cw) SATISFIED · No ERROR states.

---
*Based on Constitution v2.1.1*

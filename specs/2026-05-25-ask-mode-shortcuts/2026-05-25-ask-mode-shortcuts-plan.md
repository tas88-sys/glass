# Ask Mode Shortcuts — Implementation Plan

**Branch (target):** `feat/ask-mode-shortcuts`
**Source spec:** `docs/plans/2026-05-25-ask-mode-shortcuts-spec.md`
**Source design:** `docs/plans/2026-05-25-ask-mode-shortcuts-design.md`
**Date:** 2026-05-25
**Status:** Ready for `/tasks` → implementation.

---

## 0. Pre-flight gate

| Gate | Status | Evidence |
|---|---|---|
| Clarifications section present in spec with ≥1 Session | PASS | `docs/plans/2026-05-25-ask-mode-shortcuts-spec.md` § "Clarifications / Session 2026-05-25" contains 7 resolved questions including 4 IMPL GAPS. |
| Spec decisions locked | PASS | spec §4 "Decisions (locked-in)" has 9 numbered locks. |
| Errata vs design enumerated | PASS | spec §2 lists E1–E10. |
| Full prompt prose drafted | PASS | spec §9.1–§9.3 contain literal prose for the three new profiles. |
| Test plan present | PASS | spec §11 lists tests T1–T14 + T-15 from the clarify session. |
| All 14 touched files exist on disk | PASS | verified via filesystem during planning. |
| Constitution check | N/A | this repo has no `.specify/memory/constitution.md`; planning falls back to the spec's own §4 decisions + §8 hardening as the constitutional surface. |

Since the repo does not vendor the CW SpecKit framework (no `.specify/templates/plan-template.md`, no `setup-plan.sh`), this plan is authored directly using the spec's own structure — same convention as the design and spec docs already in `docs/plans/`. No artifacts are generated under a `specs/` tree.

---

## 1. Summary

Add an "Ask mode" selector to the MainHeader: a small `▾` caret next to the Ask pill opens a new `mode-picker` BrowserWindow with four options (Default, Code, Debug, System Design). The active mode persists in `electron-store` via `settingsService` and reshapes the system prompt that `askService.sendMessage` passes to the streaming LLM. Three new prompt profiles (`pickle_glass_code`, `pickle_glass_debug`, `pickle_glass_system_design`) are added alongside the untouched `pickle_glass_analysis`. A new free-text "Preferred Coding Language" setting (default `'go'`) is injected into the Code profile via a `{{PREFERRED_LANGUAGE}}` token replacement.

Listen-mode is not touched. The summary auto-trigger (`summaryService.js:93`) keeps calling `pickle_glass_analysis` directly. Summary follow-up clicks (`ask:sendQuestionFromSummary`) are blocked with a user-visible `alert()` when `askMode !== 'default'` — the regression E2 fix.

---

## 2. Technical context

| Field | Value |
|---|---|
| Language / Runtime | Electron 28+, Node 18+, vanilla JS (no TS in this repo) |
| Renderer framework | Lit (lit-element + lit-html) |
| Persistence | `electron-store` JSON file (NOT the SQLite DB used for chat/sessions) |
| Settings key path | `users.${uid}.askMode`, `users.${uid}.preferredCodeLanguage` |
| IPC pattern | `ipcMain.handle` (invoke/reply) + `webContents.send` (push) |
| Window pool | `src/window/windowManager.js` `windowPool` Map; new entry `'mode-picker'` |
| Prompt system | `src/features/common/prompts/promptBuilder.js` — 5-slot template, no token replacement |
| LLM streaming | `createStreamingLLM` factory, `maxTokens` not passed (provider defaults apply) |
| Auth context | `authService.getCurrentUserId()` — falls back to `'default'` user when signed-out |
| Platform conditionals | macOS `setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: true})` pattern from settings window |

**Existing patterns this work reuses:**

| Pattern | Reference | Where used in this plan |
|---|---|---|
| Hover-panel BrowserWindow | `settings` and `shortcut-settings` windows in `windowManager.js` lines 526–557 and 559–590 | mode-picker window |
| 200ms hide-debounce with cancel | `settingsHideTimer` in `windowManager.js:308–322`, `cancelHideSettingsWindow` IPC at `windowBridge.js:16` and `preload.js:111` | mode-picker hide-debounce (resolves IMPL GAP "flicker on caret→picker gap") |
| Hover-panel positioning | `calculateSettingsWindowPosition` in `windowLayoutManager.js:71–94` (PAD=5, clamped to display work area) | `calculateModePickerWindowPosition` (mirror) |
| Free-text setting input | Gemini model-ID input pattern from commit `bc12688` in `SettingsView.js` | preferredCodeLanguage input |
| Streaming-markdown system prompt | `pickle_glass_analysis` in `promptTemplates.js` (5-slot shape) | 3 new profiles |
| `parent: undefined` for sibling hover panels | `windowManager.js:527` and `:565` | mode-picker window |

---

## 3. Decision drivers

Inherited from spec §4 — recorded here for traceability. No new decisions in plan.

| # | Decision | Source | Rationale carried into plan |
|---|---|---|---|
| 1 | Dedicated `mode-picker` BrowserWindow (not in-header popover) | spec §4.7 + clarify Q2 | Header is `353×47` with `overflow: hidden`; popovers can't render outside Electron window bounds. Mirrors `settings` panel — proven pattern. |
| 2 | Block (not auto-override) summary follow-ups when `askMode !== 'default'` | spec §4.6 + clarify Q1 | Explicit > implicit. User would otherwise silently get Code-mode answers from a Listen summary action. |
| 3 | Streaming-markdown for all new prompts (no JSON) | spec §4.2 | Glass renderer is streaming-markdown; JSON would break mid-stream rendering. |
| 4 | Free-text `preferredCodeLanguage`, default `'go'` | spec §4.3 | Mirrors existing Gemini model-ID free-text pattern (commit `bc12688`). Empty → LLM infers from screenshot via `__INFER_FROM_SCREENSHOT__` sentinel. |
| 5 | Push event `mainHeader:askModeChanged` to header window | spec §2 errata E6 + §7.7 | The existing `settings-updated` broadcast targets `RELEVANT_WINDOW_TYPES = ['settings', 'main']` but header is named `'header'` — pre-existing dead-broadcast latent bug. Direct push avoids fixing the latent bug (out of scope per spec §12). |
| 6 | `parent: undefined` for mode-picker window | clarify IMPL GAP 1 | Sibling hover panels (`settings`, `shortcut-settings`) both use `parent: undefined`. Mode-picker is semantically a hover panel. |
| 7 | Sentinel `__INFER_FROM_SCREENSHOT__` for empty language | spec §4 T3 | Keeps profile count at 4 instead of doubling to 5 (one "language set" + one "infer"). |
| 8 | `alert()` for summary-block UX (not toast) | spec §4 T4 | Zero new infrastructure. Toast deferred per spec §12. |
| 9 | `Cmd+Enter` always fires active mode (no per-mode shortcut in v1) | spec §4.5 | Visible "Ask · <Mode>" badge in header makes active mode obvious. Mode-switching shortcuts deferred per spec §12. |

---

## 4. Files touched

Authoritative list — copied from spec §5 and verified against current filesystem. Each row also names the implementation phase from §6 to make the dependency order explicit.

| # | File | Phase | Edit kind | Purpose |
|---|---|---|---|---|
| 1 | `src/features/common/prompts/promptTemplates.js` | P1 | Add | 3 new profile objects: `pickle_glass_code`, `pickle_glass_debug`, `pickle_glass_system_design`. No edits to existing keys. |
| 2 | `src/features/settings/settingsService.js` | P1 | Add | 2 new defaults: `askMode: 'default'`, `preferredCodeLanguage: 'go'` inside `getDefaultSettings()` at line 202. |
| 3 | `src/features/ask/askService.js` | P2 | Modify | Replace line 257 hard-coded `'pickle_glass_analysis'` with mode-routed profile + language injection. Hoist `settingsService` require to top of file. |
| 4 | `src/bridge/featureBridge.js` | P2 | Add + Modify | New handlers: `mainHeader:getAskMode`, `mainHeader:setAskMode`, `mainHeader:openModePicker`, `modePicker:closeWindow`, `settings:getPreferredCodeLanguage`, `settings:setPreferredCodeLanguage`. Modify existing `ask:sendQuestionFromSummary` (line 83) to reject when `askMode !== 'default'`. |
| 5 | `src/window/windowManager.js` | P3 | Add | Register `mode-picker` BrowserWindow in `windowPool`. Wire `'mode-picker'` case into `handleWindowVisibilityRequest` (mirror `'settings'` block at line 280–322). Add `modePickerHideTimer` parallel to `settingsHideTimer`. Add helpers `showModePickerWindow`, `hideModePickerWindow`, `cancelHideModePickerWindow`. |
| 6 | `src/window/windowLayoutManager.js` | P3 | Add | New method `calculateModePickerWindowPosition()` — mirror of `calculateSettingsWindowPosition` at lines 71–94. Anchor below caret. PAD=5. Clamp to display work area. |
| 7 | `src/ui/modePicker/mode-picker.html` | P3 | New file | HTML host mirroring `src/ui/app/header.html` pattern. Loads the lit module + applies glass styling. |
| 8 | `src/ui/modePicker/ModePickerView.js` | P3 | New file | Lit element rendering 4 mode buttons. Click → `await window.api.mainHeader.setAskMode(mode)` THEN `window.api.modePicker.closeWindow()` — ordering per clarify IMPL GAP 3. `blur` listener for fallback close. |
| 9 | `src/preload.js` | P3 | Add | Expose new methods on `window.api.mainHeader`: `getAskMode`, `setAskMode`, `openModePicker`, `cancelHideModePicker`, `onAskModeChanged`, `removeOnAskModeChanged`. New namespace `window.api.modePicker`: `selectMode`, `closeWindow`. On `window.api.settingsView`: `getPreferredCodeLanguage`, `setPreferredCodeLanguage`. |
| 10 | `src/ui/app/MainHeader.js` | P4 | Modify | Add `▾` caret button + badge text after Ask pill. Add `askMode` state property. `connectedCallback` → fetch initial mode via IPC. Subscribe to `mainHeader:askModeChanged` push events. Mouseenter caret → open picker (with `cancelHideModePicker` debounce on re-enter). Mouseleave → emit hide. |
| 11 | `src/ui/settings/SettingsView.js` | P4 | Modify | Add `preferredCodeLanguage` state + free-text input in `render()` (Gemini model-ID style). `loadInitialData()` reads via IPC. `@blur` saves via IPC. |
| 12 | `src/ui/listen/summary/SummaryView.js` | P4 | Modify | `handleRequestClick` (line 406) — surface `result.error` to user via `alert()` when `result.success === false`. |

**No changes (verified):**

- `pickle_glass_analysis` profile in `promptTemplates.js` (left verbatim per spec §2 E7).
- `summaryService.js` (still calls `getSystemPrompt('pickle_glass_analysis', '', false)` at line 93 directly per spec §2 E9).
- `shortcutsService.js:214` (`Cmd+Enter` → `toggleAskButton(true)` — clarified in spec §2 E10 as intentional pass-through).
- Any SQLite repository or migration.
- `RELEVANT_WINDOW_TYPES` array (the pre-existing `['settings', 'main']` dead-broadcast bug is out of scope per spec §12; the new mode-change push uses direct webContents.send instead).

**No new dependencies. No DB migration. No new keyboard shortcuts.**

---

## 5. Architecture & data flow

(Verbatim from spec §3, restated for reviewer convenience.)

```
┌──────────────────────────────────────────────────────────────────┐
│ Header window (353×47, overflow: hidden)                         │
│   MainHeader.js                                                  │
│   ┌──────────┬───────────────────────┬──────┬──────┬──────────┐  │
│   │ Listen   │ Ask · <badge> │ ▾    │ S/H  │  ⚙   │ ...      │  │
│   └──────────┴───────────────────────┴──────┴──────┴──────────┘  │
│                                       │                          │
│                                       ▼  (mouseenter on caret)   │
└──────────────────────────────────────────────────────────────────┘
                                        │ IPC: mainHeader:openModePicker
                                        ▼
┌──────────────────────────────────────────────────────────────────┐
│ NEW: mode-picker window (~160×144, transparent, alwaysOnTop)     │
│   ┌─────────────────────────────┐                                │
│   │   ✓ Default                 │ ◄── click → setAskMode IPC     │
│   │     Code                    │                                │
│   │     Debug                   │                                │
│   │     System Design           │                                │
│   └─────────────────────────────┘                                │
└──────────────────────────────────────────────────────────────────┘
                                        │
                  IPC: mainHeader:setAskMode(mode)
                                        ▼
                            settingsService.saveSettings({askMode})
                                        │
                                        ▼
                              (electron-store on disk)
                                        │
                                        ▼
              push: mainHeader:askModeChanged({mode}) to header window
                                        │
                                        ▼
                          MainHeader updates badge + picker closes

Ask invocation paths (signatures unchanged from today):
  AskView text + Enter   ──► ask:sendQuestionFromAsk     ──► sendMessage(text)        [applies askMode]
  Cmd+Enter (window vis) ──► toggleAskButton(true)       ──► sendMessage('', [])      [applies askMode]
  SummaryView click      ──► ask:sendQuestionFromSummary ──► IF askMode≠default: REJECT (alert)
                                                            ELSE sendMessage(text)
  summaryService 5-turn  ──► getSystemPrompt('pickle_glass_analysis', …) directly    [unchanged]
```

---

## 6. Implementation phases

Five phases, each producing an independently-mergeable slice. Dependencies are strictly linear: every phase needs the prior one merged before its tests run cleanly.

### Phase P1 — Data layer foundations (no UI yet)

**Goal:** add defaults + prompt content; nothing else can be tested against the spec until these exist.

| Step | Action | File | Validation |
|---|---|---|---|
| P1.1 | Add `askMode: 'default'` and `preferredCodeLanguage: 'go'` to `getDefaultSettings()` return object (after `contentProtection: true`). | `src/features/settings/settingsService.js` line 202–218 | App starts; `getSettings()` returns the two new keys for a fresh user. |
| P1.2 | Append three new profile objects (`pickle_glass_code`, `pickle_glass_debug`, `pickle_glass_system_design`) to `profilePrompts` export. Verbatim from spec §9.1–§9.3. | `src/features/common/prompts/promptTemplates.js` | Node REPL: `require('./promptTemplates').profilePrompts.pickle_glass_code.intro` returns non-empty string. `promptBuilder.getSystemPrompt('pickle_glass_code', '', false)` returns concatenated string containing `{{PREFERRED_LANGUAGE}}`. |
| P1.3 | Sanity-check token uniqueness: `{{PREFERRED_LANGUAGE}}` appears ONLY inside `pickle_glass_code.content`. Grep all `promptTemplates.js` to confirm no accidental collision with `{{CONVERSATION_HISTORY}}` (already used by `pickle_glass_analysis.outputInstructions`). | (read-only) | Grep returns exactly one match. |

**Exit criteria for P1:** running `node -e "const {profilePrompts} = require('./src/features/common/prompts/promptTemplates'); console.log(Object.keys(profilePrompts))"` lists `pickle_glass_analysis`, `interview`, `pickle_glass_code`, `pickle_glass_debug`, `pickle_glass_system_design`.

### Phase P2 — Mode routing (askService + bridge handlers, no UI yet)

**Goal:** mode is read from settings and rewires the prompt; summary block is in place. Mode can be set/changed only via direct settings edit until P4 lands the UI.

| Step | Action | File | Validation |
|---|---|---|---|
| P2.1 | Hoist `const settingsService = require('../settings/settingsService');` to the top of `askService.js` (alongside other imports). | `src/features/ask/askService.js` top | No circular-import error at boot. |
| P2.2 | Replace `askService.js:257` (`getSystemPrompt('pickle_glass_analysis', conversationHistory, false)`) with the mode-routing block from spec §7.3 verbatim. Include `VALID_MODES` defensive coerce + `{{PREFERRED_LANGUAGE}}` injection branch (only when `askMode === 'code'`). | `src/features/ask/askService.js:257` | Manual edit of `electron-store` `users.default.askMode = 'code'`; fire Ask; logs show profile `pickle_glass_code` selected. |
| P2.3 | Confirm multimodal-retry path (lines 303–338) still uses the same `systemPrompt` variable. | (read-only re-verification) | Line 310 still references the outer `systemPrompt` — no edit needed. |
| P2.4 | Add 6 new IPC handlers in `featureBridge.js` `initialize()`: `mainHeader:getAskMode`, `mainHeader:setAskMode`, `mainHeader:openModePicker`, `modePicker:closeWindow`, `settings:getPreferredCodeLanguage`, `settings:setPreferredCodeLanguage`. `setAskMode` must (a) `await settingsService.saveSettings({askMode})`, (b) push `mainHeader:askModeChanged` to the `'header'` window via `windowPool.get('header').webContents.send(...)`. | `src/bridge/featureBridge.js` after line 86 | Each invoke from preload returns expected value. |
| P2.5 | Modify existing line 83 (`ask:sendQuestionFromSummary`) per spec §7.4: read `askMode`, reject with `{success: false, error: '...'}` when `!== 'default'`. | `src/bridge/featureBridge.js:83` | With `askMode = 'code'` set in store, invoking `summaryView.sendQuestionFromSummary('x')` returns `{success: false, error: 'Listen-summary actions only work in Default Ask mode…'}`. No LLM call made. |
| P2.6 | Validate `VALID_MODES` coerce on bad data: set `users.default.askMode = 'banana'`; fire Ask. Logs show fallback to `'default'`, profile `pickle_glass_analysis` used. | (manual test) | Coercion observed; no crash; no `profilePrompts.interview` fallback triggered. |

**Exit criteria for P2:** mode-routed prompts work end-to-end when `askMode` is changed by hand in `electron-store`. Summary-action regression gate (T9 in spec §11) passes via manual IPC invocation. No UI changes yet.

### Phase P3 — mode-picker window infrastructure (renderer + main)

**Goal:** the picker BrowserWindow exists, opens, closes, and writes settings via IPC. MainHeader doesn't yet display the caret.

| Step | Action | File | Validation |
|---|---|---|---|
| P3.1 | In `windowManager.js`, add `'mode-picker'` case to `createFeatureWindows` (or equivalent — follow existing `'settings'` registration at lines 526–557). Use `parent: undefined` (per clarify IMPL GAP 1), `width: 160`, `height: 144`, `transparent: true`, `frame: false`, `hasShadow: false`, `alwaysOnTop: true`, `skipTaskbar: true`, `show: false`, `resizable: false`, `focusable: true`. Load `src/ui/modePicker/mode-picker.html`. Register in `windowPool.set('mode-picker', modePicker)`. | `src/window/windowManager.js` | App boots; `windowPool.has('mode-picker')` returns true. |
| P3.2 | Add `'mode-picker'` branch to `handleWindowVisibilityRequest` in `windowManager.js` (mirror `'settings'` block at ~lines 280–323). Introduce `modePickerHideTimer` parallel to `settingsHideTimer`. On `visible: true`, compute bounds via `layoutManager.calculateModePickerWindowPosition()`, set bounds, show, set alwaysOnTop. On `visible: false`, clear timer and `setTimeout(hide, 200)`. | `src/window/windowManager.js` ~line 280 | Emitting `internalBridge.emit('window:requestVisibility', { name: 'mode-picker', visible: true })` shows the window at the right position. |
| P3.3 | Add `calculateModePickerWindowPosition()` to `windowLayoutManager.js` mirroring `calculateSettingsWindowPosition` (lines 71–94). Anchor: `y = headerBounds.y + headerBounds.height + PAD` (PAD=5). For `x`, use `headerBounds.x + headerBounds.width - CARET_RIGHT_OFFSET - (modePickerBounds.width / 2)` where `CARET_RIGHT_OFFSET` is the caret's CSS distance from the right edge of the header — measured during P4 implementation; placeholder constant `40` to start, retuned visually. Clamp to display work area exactly as `calculateSettingsWindowPosition` does. | `src/window/windowLayoutManager.js` after line 94 | Window appears immediately below caret on a 1080p display. |
| P3.4 | Create `src/ui/modePicker/mode-picker.html`. Mirror the structure of `src/ui/app/header.html` — script tag for the lit module, `<mode-picker-view>` custom element, glass styling block (`backdrop-filter`, dark translucent background, `border-radius: 10px`). | `src/ui/modePicker/mode-picker.html` (new) | HTML loads without 404 in renderer DevTools. |
| P3.5 | Create `src/ui/modePicker/ModePickerView.js` as a Lit element. Properties: `activeMode: string = 'default'`. On `connectedCallback`, `this.activeMode = await window.api.mainHeader.getAskMode() ?? 'default'`. Render 4 rows: Default, Code, Debug, System Design. Active row shows ✓. On click: `await window.api.mainHeader.setAskMode(mode)` THEN `await window.api.modePicker.closeWindow()` (ordering per clarify IMPL GAP 3 — no race). On `window.addEventListener('blur', …)`, also call `closeWindow` (fallback close, spec §8.4). | `src/ui/modePicker/ModePickerView.js` (new) | Clicking each button writes to settings + closes the window. Tab key cycles focus through buttons. Enter activates focused row. |
| P3.6 | Expose `window.api.modePicker` namespace in `src/preload.js` with `selectMode(mode)` → `ipcRenderer.invoke('mainHeader:setAskMode', mode)` and `closeWindow()` → `ipcRenderer.invoke('modePicker:closeWindow')`. Add `getAskMode`, `setAskMode`, `openModePicker`, `cancelHideModePicker`, `onAskModeChanged`, `removeOnAskModeChanged` to `window.api.mainHeader`. Add `getPreferredCodeLanguage`, `setPreferredCodeLanguage` to `window.api.settingsView`. | `src/preload.js` after line 125 | DevTools console: `window.api.mainHeader.setAskMode('code')` returns success; `window.api.modePicker.closeWindow()` hides the window. |

**Exit criteria for P3:** firing `window.api.mainHeader.openModePicker()` from DevTools (in the header window's WebContents context) opens the picker at the right position; clicking a button writes settings and the picker auto-closes; pressing Tab moves focus; blur closes the window.

### Phase P4 — UI wiring (MainHeader caret + SettingsView input + SummaryView alert)

**Goal:** the user-facing surface is complete. The caret in the header opens the picker; the badge updates live; SettingsView shows the language field; SummaryView surfaces the block alert.

| Step | Action | File | Validation |
|---|---|---|---|
| P4.1 | Add `askMode: { type: String, state: true }` to `MainHeader.js` `static properties`. In `connectedCallback`, `try { this.askMode = await window.api.mainHeader.getAskMode(); } catch { this.askMode = 'default'; }` (spec §8.3 hardening). | `src/ui/app/MainHeader.js` | Fresh load: badge shows "Ask". |
| P4.2 | Add `_renderAskLabel()` returning `"Ask"` / `"Ask · Code"` / `"Ask · Debug"` / `"Ask · SysDes"` based on `this.askMode`. Reuse in the existing Ask area `action-text-content`. | `src/ui/app/MainHeader.js` render() | Setting `askMode = 'system_design'` directly shows "Ask · SysDes" badge. |
| P4.3 | Add `▾` caret button after the Ask pill (inside an `ask-group` wrapper div, per spec §7.6). On `mouseenter` → `window.api.mainHeader.cancelHideModePicker()` (if picker is hiding, cancel) then `window.api.mainHeader.openModePicker()`. On `mouseleave` → emit hide request (debounced via the 200ms timer in `windowManager`). | `src/ui/app/MainHeader.js` render() | Hovering caret opens picker; sliding mouse INTO the picker before 200ms keeps it open (debounce works). |
| P4.4 | Subscribe to push events: in `connectedCallback`, `window.api.mainHeader.onAskModeChanged((event, {mode}) => { this.askMode = mode; })`. In `disconnectedCallback`, `window.api.mainHeader.removeOnAskModeChanged(...)`. | `src/ui/app/MainHeader.js` | Changing mode in picker → badge updates instantly without restart. |
| P4.5 | Add CSS rules for `.ask-group` (display: flex; align-items: center; gap: 4px;), `.ask-mode-caret` (small button, 14×14, no background, hover highlight). Caret is `-webkit-app-region: no-drag` so clicks don't drag the header. | `src/ui/app/MainHeader.js` styles block | Caret is clickable, not draggable. |
| P4.6 | In `SettingsView.js`, add `preferredCodeLanguage: { type: String, state: true }` property. In `loadInitialData()` add `this.preferredCodeLanguage = await window.api.settingsView.getPreferredCodeLanguage();`. Add the render block from spec §7.5 verbatim. Add `handleSavePreferredLanguage(value)` calling `window.api.settingsView.setPreferredCodeLanguage(value.trim())`. | `src/ui/settings/SettingsView.js` | Opening Settings shows the new field with `'go'` default; changing to `'python'` and blurring saves; reopening shows `'python'`. |
| P4.7 | Modify `SummaryView.handleRequestClick` at line 406 to surface `result.error` via `alert()` when `result.success === false`. Wrap existing logic in try/catch with `alert('Failed to send question. See logs.')` on throw. | `src/ui/listen/summary/SummaryView.js:406` | With `askMode = 'code'`, clicking a summary action shows native alert with the spec's error string. No LLM call made. |

**Exit criteria for P4:** all four manual smoke tests T1, T2, T4, T5 (spec §11) pass on a fresh install.

### Phase P5 — Defensive hardening + final smoke

**Goal:** lock in the hardening rules from spec §8, sweep the test plan, fix any caret-position / badge-overflow visual regressions.

| Step | Action | File | Validation |
|---|---|---|---|
| P5.1 | Verify `VALID_MODES` coerce branch in `askService.sendMessage` is hit when manually setting `askMode = 'banana'` in store (spec test T10). | (manual test) | Logs show coerce + fallback to default profile; no `profilePrompts.interview` triggered. |
| P5.2 | Verify `preferredCodeLanguage` whitespace trimming: set field to `'   '`; fire Code mode; LLM receives sentinel `__INFER_FROM_SCREENSHOT__`; response infers language from screenshot. | (manual test) | Sentinel substitution works as designed in §7.3. |
| P5.3 | Verify mode-picker `blur` listener closes the picker when user clicks another app (spec test T12). | (manual test) | Picker hides on focus loss. |
| P5.4 | Verify MainHeader graceful fallback when IPC fails on mount (spec test T14): simulate by replacing the IPC handler with `throw new Error('boom')` temporarily; badge defaults to "Ask"; no crash. | (manual test) | try/catch in `connectedCallback` covers this. |
| P5.5 | **T-15 visual gate (clarify-added test)**: set mode = System Design on a 1920×1080 display; observe header. Badge "Ask · SysDes" + caret are fully visible; header doesn't overflow; layout calc doesn't crash. | (manual test) | Badge renders cleanly. |
| P5.6 | Tune `CARET_RIGHT_OFFSET` constant in `calculateModePickerWindowPosition` based on measured caret pixel position (placeholder 40px in P3.3). Picker is visually centered under the caret. | `src/window/windowLayoutManager.js` | Picker centered under caret on multiple display sizes. |
| P5.7 | Final pass: spec §11 tests T1–T14 + T-15 all green. | (manual test) | All 15 tests pass. |

**Exit criteria for P5:** every test in spec §11 passes. PR ready.

---

## 7. IPC contract (authoritative)

This is the surface introduced by this work. Existing channels are not listed.

| Channel | Direction | Args | Returns | Implemented by |
|---|---|---|---|---|
| `mainHeader:getAskMode` | renderer → main (invoke) | — | `'default' \| 'code' \| 'debug' \| 'system_design'` | `featureBridge.js` reads `settingsService.getSettings().askMode \|\| 'default'`. |
| `mainHeader:setAskMode` | renderer → main (invoke) | `mode: string` | `{success: true, mode: string}` after coerce; or `{success: false, error}` on save failure | `featureBridge.js` validates against `VALID_MODES`, saves via `settingsService.saveSettings({askMode})`, pushes `mainHeader:askModeChanged` to header webContents. |
| `mainHeader:openModePicker` | renderer → main (invoke) | — | `{success: true}` | `featureBridge.js` emits `internalBridge.emit('window:requestVisibility', { name: 'mode-picker', visible: true })`. |
| `mainHeader:cancelHideModePicker` | renderer → main (send) | — | (no reply) | `featureBridge.js` clears `modePickerHideTimer`. (Mirror of `cancel-hide-settings-window` at `windowBridge.js:16`.) |
| `mainHeader:askModeChanged` | main → header window (push) | `{mode: string}` | (push event) | Fired by `setAskMode` handler after save succeeds. MainHeader subscribes via `window.api.mainHeader.onAskModeChanged`. |
| `modePicker:closeWindow` | renderer → main (invoke) | — | `{success: true}` | `featureBridge.js` emits `internalBridge.emit('window:requestVisibility', { name: 'mode-picker', visible: false })`. |
| `settings:getPreferredCodeLanguage` | renderer → main (invoke) | — | `string` (default `'go'`) | `featureBridge.js` reads from settings. |
| `settings:setPreferredCodeLanguage` | renderer → main (invoke) | `value: string` | `{success: true}` | `featureBridge.js` saves trimmed value. |

**Channel-naming convention:** namespaced colon-separated, matching existing pattern (`ask:`, `mainHeader:`, `settings:`, `ollama:` etc).

---

## 8. Risk register

| # | Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|---|
| R1 | New prompts produce poor LLM output (untested empirically) | Medium | High | Manual smoke tests T2, T4, T5 are the gate. Prompts are fully spec'd in §9 verbatim — any failures are prompt-engineering iterations, not architectural failures. Each new profile uses the same 5-slot shape so `promptBuilder` works untouched. |
| R2 | New BrowserWindow lifecycle issues (focus stealing, alwaysOnTop conflicts, multi-monitor positioning) | Medium | Medium | Mirror the proven `'settings'` window pattern exactly (parent: undefined, alwaysOnTop, 200ms hide debounce). Anchor positioning to `headerBounds` not absolute coords. Clamp to display work area as `calculateSettingsWindowPosition` does. |
| R3 | Header layout overflow with "Ask · SysDes" badge | Low | Low | `.header` is `width: max-content` (verified at `MainHeader.js:43`) — no fixed width to break. T-15 visual gate in §6 P5.5 confirms. |
| R4 | Mode-picker → header IPC `setAskMode` succeeds but push event drops; header badge stale | Low | Medium | Spec §2 E6 notes the pre-existing `settings-updated` dead-broadcast bug. This plan does NOT rely on that broadcast — uses direct `windowPool.get('header').webContents.send('mainHeader:askModeChanged', …)`. Falls back to re-fetch on next mount. |
| R5 | `Cmd+Enter` user surprise (active mode applied unexpectedly) | Medium | Low | Visible "Ask · <Mode>" badge in MainHeader makes active mode obvious (spec §10 T5). Accepted tradeoff. |
| R6 | `electron-store` write race when user rapidly toggles modes | Low | Low | `saveSettings` is awaited; clicks serialize naturally. Even if two writes overlap, last-write-wins on disk is fine. |
| R7 | Existing `{{CONVERSATION_HISTORY}}` token in `pickle_glass_analysis.outputInstructions` is not replaced by `askService` (only by `summaryService`) | (pre-existing, T8) | Low | Out of scope per spec §12. New profiles do NOT use `{{CONVERSATION_HISTORY}}`. The `{{PREFERRED_LANGUAGE}}` token only appears in `pickle_glass_code.content` (verified P1.3) — no cross-talk. |
| R8 | `maxTokens` ceiling truncating System Design responses on Anthropic (8192 default) | Low | Medium | Spec §10 T6 accepts this; if observed in QA, file a follow-up PR to pass `maxTokens` in `createStreamingLLM` call at `askService.js:276`. |

---

## 9. Phase 2 — Task generation approach (for `/tasks`)

When `/tasks` runs against this plan, it should emit one task per row in §4 ordered by phase (P1 → P2 → P3 → P4 → P5), with the §6 substeps as acceptance bullets. Suggested task granularity:

- **T-P1.1** Add settings defaults (1 file, 2 keys, ~5 LOC)
- **T-P1.2** Add 3 prompt profiles (1 file, ~300 LOC of prose)
- **T-P2.1+P2.2** Hoist import + replace prompt selection (1 file, ~30 LOC)
- **T-P2.3** Add 6 new IPC handlers (1 file, ~40 LOC)
- **T-P2.4** Modify summary IPC handler with block + error return (1 file, ~12 LOC)
- **T-P3.1+P3.2** Register mode-picker BrowserWindow + visibility branch (1 file, ~50 LOC)
- **T-P3.3** Add `calculateModePickerWindowPosition` (1 file, ~25 LOC)
- **T-P3.4** Create `mode-picker.html` (1 file, ~30 LOC)
- **T-P3.5** Create `ModePickerView.js` Lit element (1 file, ~120 LOC)
- **T-P3.6** Expose preload IPC methods (1 file, ~20 LOC)
- **T-P4.1–P4.5** Wire MainHeader caret + badge + push subscription (1 file, ~80 LOC)
- **T-P4.6** SettingsView language input (1 file, ~30 LOC)
- **T-P4.7** SummaryView alert on block (1 file, ~10 LOC)
- **T-P5** Test plan execution (manual, ~30 min)

Total: 14 implementation tasks + 1 QA task. ~700 LOC across 13 modified files + 2 new files.

Order is mandatory — every task depends on the previous task's exit criterion holding. Parallelization is only safe inside a single phase (e.g. P4.1, P4.6, P4.7 are touching three different files and can be claimed by different developers / commits in parallel).

---

## 10. Test plan reference

The full manual smoke test plan lives in spec §11 (tests T1–T14) plus the clarify-added T-15. Plan §6 P5.7 is the explicit "all tests green" exit criterion.

Test execution order during P5:

1. T1 Backward-compat gate (fresh install, default mode)
2. T2 Code mode default language
3. T3 Code mode language change (Settings)
4. T4 Debug mode 5-heading structure
5. T5 System Design Routing Rule A
6. T5b System Design Routing Rule B (deep dive)
7. T6 Persistence (restart app)
8. T7 Listen summary still uses analysis profile
9. T8 Listen summary follow-up — default mode
10. T9 Listen summary follow-up — non-default mode (REGRESSION GATE)
11. T10 Corrupted askMode coerce
12. T11 Empty screenshot fallback (multimodal-retry)
13. T12 Picker dismiss on blur
14. T13 Picker focus / Tab / Enter
15. T14 Settings IPC failure on mount
16. T-15 Header width visual gate (clarify-added)

No automated tests are added by this plan — the repo does not have a renderer test harness wired for Lit elements, and adding one is out of scope. Spec §11 manual gate is the contract.

---

## 11. Progress tracking

| Phase | Status | Notes |
|---|---|---|
| Pre-flight gate (§0) | DONE | All gates pass; constitution check N/A (no `.specify/memory/`). |
| Plan authored | DONE | This document. |
| P1 — Data layer | PENDING | Awaiting `/tasks` and implementer pickup. |
| P2 — Mode routing | PENDING | |
| P3 — mode-picker window | PENDING | |
| P4 — UI wiring | PENDING | |
| P5 — Hardening + smoke | PENDING | |

---

## 12. References

- **Spec** — `docs/plans/2026-05-25-ask-mode-shortcuts-spec.md` (authoritative; this plan implements it phase-by-phase)
- **Design** — `docs/plans/2026-05-25-ask-mode-shortcuts-design.md` (predecessor; superseded by spec where they disagree)
- **Brief** — `prompts/code-debug-shortcuts.txt` (original user intent; coverage matrix in spec §9.0)
- **Existing patterns reused** —
  - `src/window/windowManager.js` lines 280–322 (settings visibility branch)
  - `src/window/windowManager.js` lines 526–557 (settings window registration)
  - `src/window/windowLayoutManager.js` lines 71–94 (settings positioning)
  - `src/features/common/prompts/promptTemplates.js` (`pickle_glass_analysis` 5-slot shape)
  - `src/features/common/prompts/promptBuilder.js` (slot concatenation logic; unchanged)
  - `src/ui/settings/SettingsView.js` (Gemini model-ID free-text pattern from commit `bc12688`)

---

## Next step

Run `/tasks 2026-05-25-ask-mode-shortcuts-plan.md` to generate the 14+1 task breakdown described in §9, or proceed directly to `/implement` if working solo.

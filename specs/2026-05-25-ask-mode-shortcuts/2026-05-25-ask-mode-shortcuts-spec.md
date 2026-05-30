# Ask Mode Shortcuts — Implementation Spec

**Branch:** `feat/ask-mode-shortcuts`
**Source design:** `docs/plans/2026-05-25-ask-mode-shortcuts-design.md`
**Source brief:** `prompts/code-debug-shortcuts.txt`
**Date:** 2026-05-25
**Status:** Awaiting user approval before implementation.

---

## Confidence statement

I am **NOT yet 100% confident** that this change introduces zero regressions. The original design contained at least one genuine regression (`ask:sendQuestionFromSummary` would silently change behavior in non-default modes) and one unresolved architectural ambiguity (popover render strategy). This spec resolves both with the user's chosen direction. After the spec is approved and implemented per these decisions, the test plan in §11 is sufficient to validate.

The remaining risks I cannot eliminate before code lands:
- LLM behavior with the new prompts has not been tested empirically against real screenshots; the design moves prompts from JSON to streaming-markdown and asserts they will work — this requires manual smoke-testing per §11.
- The new `mode-picker` window introduces a new Electron BrowserWindow; window lifecycle, focus stealing, and `alwaysOnTop` interactions can surface in QA only.

These two risks are inherent to any prompt-engineering / new-window feature and are the reason the test plan exists.

---

## 1. Goal (unchanged from design)

Let the user pick one of four Ask modes — **Default**, **Code**, **Debug**, **System Design** — once per session. The active mode reshapes the system prompt sent to the LLM so the user doesn't paste the same instructions every time.

Hard constraint: no Listen-mode dependency. Every mode works from typed text + current screenshot.

---

## 2. Errata vs. design document

Surfacing every deviation from `docs/plans/2026-05-25-ask-mode-shortcuts-design.md`:

| # | Design said | Reality | Resolution in this spec |
|---|---|---|---|
| E1 | `src/features/common/services/settingsService.js` | File lives at `src/features/settings/settingsService.js` | Use correct path everywhere |
| E2 | `ask:sendQuestionFromSummary` "doesn't pass `mode`, falls through to default" | The IPC routes to `askService.sendMessage` which **will** read `askMode` from settings → SummaryView follow-up clicks WILL inherit the active mode. Regression. | Block summary clicks while `askMode !== 'default'`; show user-visible error (§7.4) |
| E3 | "Clicking the caret → small lit-html popover" | Header window is `353×47px` with `overflow: hidden`. Popovers cannot render outside Electron window bounds. | Open a dedicated `mode-picker` BrowserWindow (§7.2) |
| E4 | IPC handlers only listed: `mainHeader:setAskMode`, `mainHeader:getAskMode` | No IPC was specified for `preferredCodeLanguage` read/write from `SettingsView` | Add `settings:getPreferredCodeLanguage`, `settings:setPreferredCodeLanguage` (§7.5) |
| E5 | Test #7: "Corrupt `askMode` to `'banana'` in settings DB" | Settings live in electron-store JSON file, not the SQLite DB | Test wording corrected to "settings JSON file" (§11.7) |
| E6 | "On mount, MainHeader reads `askMode` via IPC with a `'default'` fallback if IPC fails" — implies live updates not needed | If the user changes mode from the picker window, the header badge must refresh. `settings-updated` broadcast targets `['settings','main']`, but no `'main'` window exists (header is `'header'`) — a pre-existing dead-broadcast latent bug. | Either (a) `setAskMode` IPC returns the new mode and the picker forwards it back via a `mainHeader:askModeChanged` push event to the header window, or (b) add `'header'` to `RELEVANT_WINDOW_TYPES`. Spec picks (a) — fewer side effects (§7.2) |
| E7 | `pickle_glass_analysis` IS "verbatim. Untouched" | Verified ✓ | No change needed |
| E8 | Multimodal-error retry path (lines 303–338) inherits the right mode | Verified ✓ (same `systemPrompt` variable reused) | No change needed |
| E9 | `summaryService.js` Listen-summary path "still uses `pickle_glass_analysis` directly" | Verified ✓ at `src/features/listen/summary/summaryService.js:93` | No change needed |
| E10 | `shortcutsService.js:214` `toggleAskButton(true)` is "pure UI toggle" | **Partially incorrect.** Line 214 binds `Cmd+Enter` to `toggleAskButton(true)`. When the Ask window is already visible with text-input shown, `toggleAskButton(true)` calls `sendMessage('', [])` at `askService.js:153` → applies `askMode`. This is the intended behavior, but the design's wording was misleading. | Documented in §6 (Entry points). No code change needed. |

---

## Clarifications

### Session 2026-05-25

Pre-implementation ambiguity sweep against the codebase. Auto-resolutions cite specific evidence; the four implementation gaps below were not explicitly settled by the spec body but have clear codebase precedent — recording the chosen defaults here so /plan and implementation do not need to re-decide. User may override any item before code lands.

- Q: Does the `{{PREFERRED_LANGUAGE}}` token in `pickle_glass_code` collide with any replacement performed by `promptBuilder.js`? → A: [AUTO] No collision. `promptBuilder.js` only concatenates the 5 prompt slots (`buildSystemPrompt` at lines 3–13); it performs no `.replace()` on tokens. The spec's `.replace('{{PREFERRED_LANGUAGE}}', …)` applied to the output of `getSystemPrompt(...)` is safe. Evidence: `src/features/common/prompts/promptBuilder.js:3-13`.
- Q: Is there an existing renderer-side hide-debounce pattern this picker can mirror? → A: [AUTO] Yes. `cancelHideSettingsWindow` exists end-to-end: IPC channel `cancel-hide-settings-window` (`src/preload.js:111,240`, `src/bridge/windowBridge.js:16`), windowManager helper at `src/window/windowManager.js:71-73`, consumed by `SettingsView.handleMouseEnter` at `src/ui/settings/SettingsView.js:1081-1085`. The 200ms hide-timer lives in `handleWindowVisibilityRequest` at `src/window/windowManager.js:308-322`, gated on `name === 'settings'`. The mode-picker MUST mirror this — add a `name === 'mode-picker'` branch using a parallel `modePickerHideTimer` with the same 200ms delay, plus a `cancelHideModePicker` helper/IPC. Without this, the picker will flicker when the user crosses the caret→picker pixel gap.
- Q: [IMPL GAP] What `parent:` value should the mode-picker BrowserWindow use? → A: [AUTO] `parent: undefined`. Both sibling hover panels — `settings` (`windowManager.js:527`) and `shortcut-settings` (`windowManager.js:565`) — use `parent: undefined` (i.e., they are top-level windows that sit visually adjacent to the header but are not OS-level children of it). Generic feature windows from `commonChildOptions` use `parent: header`. The mode-picker is semantically a hover panel, so it joins the `settings`/`shortcut-settings` pattern. Update §7.2 BrowserWindow snippet to include `parent: undefined`. Evidence: `src/window/windowManager.js:527, 565`.
- Q: [IMPL GAP] Where exactly does the mode-picker anchor relative to the header? → A: [AUTO] Add `calculateModePickerWindowPosition()` to `src/window/windowLayoutManager.js` (mirrors `calculateSettingsWindowPosition` at lines 71–94). Anchor: `y = headerBounds.y + headerBounds.height + 5` (5px PAD, same as settings panel). `x` is the screen-space x-position of the caret centered on the picker's width — compute as `headerBounds.x + headerBounds.width - CARET_RIGHT_OFFSET - (modePickerBounds.width / 2)`, where `CARET_RIGHT_OFFSET` is the caret's CSS distance from the right edge of the header (to be measured during implementation; ~40px estimate based on the existing settings-button position). Clamp to display work area exactly as `calculateSettingsWindowPosition` does (lines 90–91).
- Q: [IMPL GAP] What is the mode-picker close-on-button-click ordering — does the `blur` from clicking a button race the `setAskMode` IPC? → A: [AUTO] Click handler must `await window.api.mainHeader.setAskMode(mode)` THEN call `window.api.modePicker.closeWindow()`. The button's `mousedown` is synchronous on the picker window; `setAskMode` completes its IPC roundtrip; only after the `await` resolves does `closeWindow` fire. The picker's `blur` listener (added per §8 hardening) provides the fallback close path if the click ever fails to resolve. No race in the happy path. Evidence: standard Electron IPC ordering + spec §8.4.
- Q: [IMPL GAP] What is the risk that "Ask · SysDes" badge growth breaks header layout invariants? → A: [AUTO] Low. `.header` uses `width: max-content` (`src/ui/app/MainHeader.js:43`); the header window itself resizes via `window:resizeHeaderWindow` driven by content measurement. Adding ~50px badge + ~14px caret stays well within practical bounds. No fixed-width constant in `windowLayoutManager` constrains the header itself (only the children). However, ASCII width of "Ask · System Design" (un-truncated) is ~110px wider than "Ask"; for safety the spec's chosen abbreviations ("Code", "Debug", "SysDes") are preserved as-is and "SysDes" remains the canonical short form. Out of caution, T-15 below is added to QA: visually verify the header doesn't overflow on a 1080p display.
- Q: Where in the spec do the four IMPL-gap resolutions above belong physically — should §5/§7.2/§7.6/§11 be edited to inline them? → A: [AUTO] No inline edits to §5/§7.2/§7.6/§11. The clarifications section is the canonical record per the /clarify contract. /plan and implementation should treat the bullets above as binding addenda. If during implementation any addendum proves wrong, the implementer logs the deviation in a new Session-dated subsection here. This preserves the spec's review trail.

### Coverage residuals

- Scope: clear (no questions raised).
- Data: clear (settings keys, IPC channels, sentinel string, profile names all locked).
- UX: clear — alert() vs banner explicitly decided (T4); badge abbreviations explicitly chosen; one residual visual-verification QA step added as T-15.
- Edge cases: clear — corruption (T6/§11.10), IPC failure (§8.3, §11.14), blur/dismiss (§8.4, §11.12), empty screenshot (§11.11) all covered.

### Added test coverage (from this session)

- T-15. **Header width visual gate**: With mode = System Design, observe MainHeader on a 1920×1080 display. → Header renders within reasonable horizontal bounds; badge "Ask · SysDes" + caret are fully visible without clipping; layout calc does not crash. (Catches §10 T6 maxTokens-adjacent visual regression.)

### Session 2026-05-27 — post-implementation System Design template refinement

After the implementation shipped (merged in `b7c71b0`), the `pickle_glass_system_design` profile underwent five rounds of prompt-engineering refinement driven by a "sanity-render" methodology — mentally simulating a Twitter system-design interview against the template and looking for contradictions. The verbatim prose in §9.3 below was updated accordingly. The refinements are recorded here for traceability; nothing in §1–§8 (settings keys, IPC channels, file list, decisions, hardening) changes.

- Q: Does the live overlay flow top-to-bottom in interview-clock order? → A: [REFINED] No — the Opening 30s pitch lived at §10 (Say-Aloud Cheat Sheet) but the candidate needs it at interview minute 1, BEFORE clarifying questions. Fix: extracted the Opening Pitch to a new §0 that streams first. §10 stripped to two transition snippets (walk-through + stall recovery) and renamed "Mid-Interview Say-Aloud Snippets" to distinguish from the per-phase say-aloud lines in §6. Total section count moved from 11 (1-11) to 12 (0-11).

- Q: Does the structure carry the senior-vs-staff signal of "draw + narrate + offer two alternatives in each block"? → A: [REFINED] Not yet — the original §6 was one monolithic ASCII diagram with no phased structure. Restructured §6 into three labelled phases (Baseline / 10× Scale / Multi-region). ONE ASCII diagram only (Phase 1 baseline) — Phases 2 and 3 are bullet deltas, NOT new diagrams (overlay glanceability constraint — three stacked diagrams would compete for the candidate's eye). Each phase carries a ≤25-word say-aloud sentence. Added a consolidated **Trade-off Roll-up table** at the bottom of §6 (`Phase | Decision | Chose | Rejected | Why`, 6-10 rows) as the single source of truth for per-decision alternatives — replaces inline annotations inside ASCII boxes (which would explode width).

- Q: Does §8 ("Scaling, Bottlenecks & Failure Modes") now duplicate §6 Phase 2? → A: [REFINED] Yes — the "what breaks first at 10× load?" bullet in §8 became redundant with Phase 2's scaling delta. Reframed §8 to "Mechanisms & Failure Handling" (the HOW-it-works layer under §6 Phase 2/3): sharding mechanism, caching mechanism, hot-key handling, component-failure response with user-visible degradation. The 10× load probe was removed from §8 — Phase 2 owns it.

- Q: Does the output rule that requires (Chose | Rejected | Why) in the Roll-up table conflict with §5's "name rejected alternative inline" rule? → A: [REFINED] Yes — internal contradiction caught in the sanity render. Fix: §5 now names rationale only; rejected alternatives live exclusively in the §6 Roll-up. Also added an explicit carve-out to the no-duplicate-tuple output rule: §7's per-probe `tradeoff` line describes operational cost (what you give up by choosing the mechanism), NOT the rejected alternative — so §7's tradeoff lines stay.

- Q: Can §0 and §3 drift on scale numbers? → A: [REFINED] Yes — observed in the sanity render (§0 stated "150k peak QPS" while §3's math yielded "1.7M peak read QPS" because the model anchored §0 on writes and §3 on reads). Added a reconciliation rule: §3's first line must restate §0's number with a one-phrase correction if the math diverges. Catches the most common live-interview slip — saying one scale number aloud, computing math under a different one.

- Q: Where does the explicit "this is the senior-vs-staff signal" framing live? → A: [REFINED] Added to the `<core_identity>` block as a fifth optimization bullet — "Three combined signals: (a) phased architecture, (b) one spoken sentence per phase, (c) per-decision alternative + reason. Hitting all three together is the differentiator between senior and staff/principal at this stage. Hitting only one or two reads as senior."

The §9.3 verbatim prose below has been updated to match the live `src/features/common/prompts/promptTemplates.js`. The §11 T5 test expectations are also refreshed to reflect the new 12-section structure with the Trade-off Roll-up assertion.

---

## 3. Architecture & data flow

```
┌─────────────────────────────────────────────────────────────────┐
│ Header window (353×47)                                          │
│   MainHeader.js                                                 │
│   ┌──────────┬───────────────────────┬──────┬──────┬──────────┐ │
│   │ Listen   │ Ask · <badge> │ ▾    │ S/H  │  ⚙   │ ...      │ │
│   └──────────┴───────────────────────┴──────┴──────┴──────────┘ │
│                                       │                         │
│                                       ▼                         │
│                          (mouseenter on caret)                  │
└─────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
┌─────────────────────────────────────────────────────────────────┐
│ NEW: mode-picker window (~150×140, transparent, alwaysOnTop)    │
│   ┌─────────────────────────────┐                               │
│   │   ✓ Default                 │ ◄── click → IPC               │
│   │     Code                    │                               │
│   │     Debug                   │                               │
│   │     System Design           │                               │
│   └─────────────────────────────┘                               │
└─────────────────────────────────────────────────────────────────┘
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
                          MainHeader updates badge text + closes picker

Ask invocation paths (unchanged signatures):
  AskView text + Enter   ──► ask:sendQuestionFromAsk     ──► sendMessage(text)        [applies askMode]
  Cmd+Enter (window vis) ──► toggleAskButton(true)       ──► sendMessage('', [])      [applies askMode]
  SummaryView click      ──► ask:sendQuestionFromSummary ──► IF askMode≠default: REJECT
                                                            ELSE sendMessage(text)
```

---

## 4. Decisions (locked-in)

| # | Question | Decision | Source |
|---|---|---|---|
| 1 | UI shape | Ask pill + ▾ caret; caret opens dedicated `mode-picker` window | Design § + user picked (Q2 of clarify) |
| 2 | Prompt content | All three new prompts are streaming-markdown. No JSON. No Me/Them framing. | Design § + user picked (Q3) |
| 3 | Code language | Free-text setting `preferredCodeLanguage`, default `'go'`. Empty → LLM infers from screenshot. | Design § |
| 4 | Mode persistence | `askMode` stored in electron-store via `settingsService.saveSettings({askMode})`. Survives restart. | Design § (corrected path) |
| 5 | Mode-switching shortcuts | None in v1. Cmd+Enter fires whatever mode is active. | Design § |
| 6 | Summary follow-up handling in non-default modes | **Block + warn**. IPC handler rejects with error; SummaryView shows alert. Forces explicit mode switch. | User picked (Q1) |
| 7 | Popover render | Dedicated `mode-picker` BrowserWindow (similar to settings hover pattern) | User picked (Q2) |
| 8 | Prompt drafts | Full literal prose included in this spec (§9) for review before code lands | User picked (Q3) |
| 9 | Errata transparency | Section §2 enumerates every deviation from the design doc | User picked (Q4) |

---

## 5. Files touched (corrected from design)

| # | File | Change | Reason |
|---|---|---|---|
| 1 | `src/features/common/prompts/promptTemplates.js` | Add 3 new profile objects: `pickle_glass_code`, `pickle_glass_debug`, `pickle_glass_system_design`. No edits to existing keys. | New prompt profiles |
| 2 | `src/features/ask/askService.js` | (a) `sendMessage` reads `askMode` + `preferredCodeLanguage` from settings, picks profile, injects `${language}` placeholder. (b) Add input validation + sanitization. | Core mode routing |
| 3 | `src/features/settings/settingsService.js` (corrected path; **NOT** `src/features/common/services/`) | (a) Add `askMode: 'default'` and `preferredCodeLanguage: 'go'` to `getDefaultSettings()`. (b) No new functions. | Settings defaults |
| 4 | `src/ui/settings/SettingsView.js` | Add one free-text input field "Preferred coding language", same UX pattern as Gemini model-ID input (commit `bc12688`). Loads + saves via new IPC. | Language preference UI |
| 5 | `src/ui/app/MainHeader.js` | (a) Render caret `▾` next to Ask pill. (b) Render badge text after pill ("Ask", "Ask · Code", "Ask · Debug", "Ask · SysDes"). (c) On mount, fetch `askMode` via IPC. (d) Listen for `mainHeader:askModeChanged` push events. (e) Mouseenter caret → opens mode-picker window. | Caret + badge |
| 6 | `src/ui/modePicker/ModePickerView.js` **(NEW FILE)** | New Lit element. Renders 4 mode buttons. Click → `setAskMode` IPC → window auto-closes (`window:requestVisibility` false). | Mode picker view |
| 7 | `src/ui/modePicker/mode-picker.html` **(NEW FILE)** | Mirrors `src/ui/app/header.html` pattern. Loads the lit module + applies same glass styling. | Mode picker host |
| 8 | `src/window/windowManager.js` | Register `mode-picker` window in `windowPool`. Wire `internalBridge` `window:requestVisibility` handling. Use existing `createFeatureWindows` pattern. | Window registration |
| 9 | `src/bridge/featureBridge.js` | New handlers: `mainHeader:getAskMode`, `mainHeader:setAskMode`, `settings:getPreferredCodeLanguage`, `settings:setPreferredCodeLanguage`, `modePicker:closeWindow`. Modify `ask:sendQuestionFromSummary` to reject if `askMode !== 'default'`. | IPC plumbing |
| 10 | `src/preload.js` | Expose new methods on `window.api.mainHeader` (`getAskMode`, `setAskMode`, `onAskModeChanged`, `removeOnAskModeChanged`), `window.api.settingsView` (`getPreferredCodeLanguage`, `setPreferredCodeLanguage`), and a new `window.api.modePicker` namespace (`selectMode`, `closeWindow`). | Renderer API |
| 11 | `src/ui/listen/summary/SummaryView.js` | Modify `handleRequestClick` to display `result.error` to user (alert or transient banner) when the server rejects the request. | User feedback on block |

**No changes to:**
- `pickle_glass_analysis` profile in `promptTemplates.js`
- `summaryService.js` (still calls `getSystemPrompt('pickle_glass_analysis', '', false)` directly)
- Any SQLite repository or migration
- Shortcuts (no new keybinds)
- ListenService, ListenView, STT pipeline

**No new dependencies.**

---

## 6. Ask invocation entry points (complete inventory, post-change)

| Entry point | Caller | Path | Mode applied | Notes |
|---|---|---|---|---|
| Text + Enter in Ask window | `AskView.handleSendText` → `window.api.askView.sendMessage(text)` | `ask:sendQuestionFromAsk` → `askService.sendMessage(text)` | **Active `askMode`** | Intended |
| Cmd/Ctrl+Enter inside Ask textarea | `AskView.handleTextKeydown` → `handleSendText()` | Same as above | **Active `askMode`** | Intended |
| Global Cmd/Ctrl+Enter (header focus) — Ask window already open + empty textarea | `shortcutsService:214` → `askService.toggleAskButton(true)` → `sendMessage('', [])` | Bypasses IPC | **Active `askMode`** | Intended (screenshot-only) |
| Global Cmd/Ctrl+Enter — Ask window hidden | `shortcutsService:214` → `askService.toggleAskButton(true)` | Just toggles window visibility; NO `sendMessage` call | N/A | Unchanged |
| Click Ask pill in MainHeader | `MainHeader._handleAskClick` → `ask:toggleAskButton` | `askService.toggleAskButton()` — no `inputScreenOnly` flag → just visibility toggle | N/A | Unchanged |
| Click follow-up in SummaryView | `SummaryView.handleRequestClick` → `ask:sendQuestionFromSummary` | **NEW**: IPC handler reads `askMode`. If `≠ 'default'`, returns `{success: false, error: '...'}`. SummaryView surfaces the error to user. Else → `sendMessage(text)`. | `'default'` always (or blocked) | Resolves E2 |
| Click follow-up via `summaryService` auto-trigger every 5 turns | `summaryService.triggerAnalysisIfNeeded` → `makeOutlineAndRequests` → direct `getSystemPrompt('pickle_glass_analysis', ...)` call | Does NOT touch askService | `'default'` (analysis profile) always | Unchanged |
| Multimodal retry inside `sendMessage` | Internal catch block @ lines 303–338 | Reuses outer `systemPrompt` variable | **Inherits the same askMode-derived profile** | Verified ✓ |

---

## 7. Detailed change list

### 7.1 Settings defaults

In `src/features/settings/settingsService.js`, inside `getDefaultSettings()`:

```js
return {
    profile: 'school',
    language: 'en',
    screenshotInterval: '5000',
    imageQuality: '0.8',
    layoutMode: 'stacked',
    keybinds: isMac ? DEFAULT_KEYBINDS.mac : DEFAULT_KEYBINDS.windows,
    throttleTokens: 500,
    maxTokens: 2000,
    throttlePercent: 80,
    googleSearchEnabled: false,
    backgroundTransparency: 0.5,
    fontSize: 14,
    contentProtection: true,
    // ── NEW ──
    askMode: 'default',                // 'default' | 'code' | 'debug' | 'system_design'
    preferredCodeLanguage: 'go',       // free-text; empty → infer from screenshot
};
```

No migration. `getSettings()` already spreads defaults over saved settings, so existing users get `askMode='default'` and `preferredCodeLanguage='go'` automatically on first read.

### 7.2 mode-picker window

**Window registration** (`windowManager.js`):

```js
const modePicker = new BrowserWindow({
    width: 160,
    height: 144,                       // 4 rows × 36px = 144
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,                       // hidden by default
    resizable: false,
    focusable: true,
    webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, '../preload.js'),
    },
});
modePicker.loadFile(path.join(__dirname, '../ui/modePicker/mode-picker.html'));
windowPool.set('mode-picker', modePicker);
```

**Positioning** (windowLayoutManager): position immediately below the caret in the header, anchored to header `y + 47 + 4` and `x + (caret's x offset)`. Use `header.getBounds()` + computed offset.

**Visibility control**: standard `internalBridge.emit('window:requestVisibility', { name: 'mode-picker', visible: true|false })` pattern.

**Auto-close behavior**:
- Click outside → close (use `blur` event on the modePicker window).
- Click on any of the 4 buttons → IPC `mainHeader:setAskMode` then `modePicker:closeWindow`.

**Why a separate window over expanding the header**:
- Header is part of `WindowLayoutManager` / `SmoothMovementManager`, which assume fixed dimensions for layout math (`HEADER_HEIGHT = 47`). Resizing the header in place risks breaking drag, multi-monitor layout, and the layout invariants.
- A separate window mirrors the existing `settings` hover panel — proven pattern.

### 7.3 askService changes

In `src/features/ask/askService.js`, before line 257:

```js
// Read mode + language from settings (single source of truth).
const settingsService = require('../settings/settingsService');
const currentSettings = await settingsService.getSettings();

const VALID_MODES = ['default', 'code', 'debug', 'system_design'];
const rawMode = currentSettings.askMode;
const askMode = VALID_MODES.includes(rawMode) ? rawMode : 'default';   // defensive coerce

const PROFILE_BY_MODE = {
    default: 'pickle_glass_analysis',
    code: 'pickle_glass_code',
    debug: 'pickle_glass_debug',
    system_design: 'pickle_glass_system_design',
};
const profile = PROFILE_BY_MODE[askMode];

// preferredCodeLanguage only meaningful for 'code' mode; trim + empty fallback.
let language = '';
if (askMode === 'code') {
    language = (currentSettings.preferredCodeLanguage || '').trim();
}

// Build prompt. For code mode, inject language via a token replacement at the customPrompt slot.
let systemPrompt;
if (askMode === 'code') {
    const base = getSystemPrompt(profile, conversationHistory, false);
    systemPrompt = base.replace('{{PREFERRED_LANGUAGE}}', language || '__INFER_FROM_SCREENSHOT__');
} else {
    systemPrompt = getSystemPrompt(profile, conversationHistory, false);
}
```

The `{{PREFERRED_LANGUAGE}}` token is part of the new `pickle_glass_code` profile's `content` slot (see §9.1). If empty, the literal sentinel `__INFER_FROM_SCREENSHOT__` is injected; the prompt prose interprets the sentinel.

Note: `require` at the top of the function works because settingsService is already loaded by the time askService is called. But to avoid require inside a hot function, this `require` should be hoisted to the top of `askService.js` alongside the other imports.

### 7.4 Summary regression block

In `src/bridge/featureBridge.js`, replace:

```js
ipcMain.handle('ask:sendQuestionFromSummary', async (event, userPrompt) => await askService.sendMessage(userPrompt));
```

with:

```js
ipcMain.handle('ask:sendQuestionFromSummary', async (event, userPrompt) => {
    const settingsService = require('../features/settings/settingsService');
    const currentSettings = await settingsService.getSettings();
    if (currentSettings.askMode && currentSettings.askMode !== 'default') {
        return {
            success: false,
            error: `Listen-summary actions only work in Default Ask mode. Current mode: ${currentSettings.askMode}. Switch back to Default via the caret on the Ask pill.`,
        };
    }
    return await askService.sendMessage(userPrompt);
});
```

In `src/ui/listen/summary/SummaryView.js`, modify `handleRequestClick`:

```js
async handleRequestClick(requestText) {
    if (window.api) {
        try {
            const result = await window.api.summaryView.sendQuestionFromSummary(requestText);
            if (!result?.success) {
                // User-visible feedback (alert is the simplest; a transient banner is nicer if there's appetite).
                alert(result?.error || 'Failed to send question.');
            }
        } catch (error) {
            console.error('❌ Error in handleRequestClick:', error);
            alert('Failed to send question. See logs.');
        }
    }
}
```

### 7.5 SettingsView changes

Add a new section in the `render()` method, near the API-key section, mirroring the Gemini model-input pattern:

```js
const codeLanguageSection = html`
    <div class="provider-key-group" style="padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.1);">
        <label for="preferred-code-language-input">Preferred Coding Language (Ask Code mode)</label>
        <input
            type="text"
            id="preferred-code-language-input"
            placeholder="e.g. go, python, typescript"
            .value=${this.preferredCodeLanguage}
            @blur=${(e) => this.handleSavePreferredLanguage(e.target.value)}
        >
        <div style="font-size: 9px; color: rgba(255,255,255,0.5); margin-top: 2px;">
            Leave blank to infer from the screenshot.
        </div>
    </div>
`;
```

Plus:
- Add `preferredCodeLanguage: { type: String, state: true }` to `static properties`.
- Load it in `loadInitialData()`: `this.preferredCodeLanguage = await window.api.settingsView.getPreferredCodeLanguage();`
- `handleSavePreferredLanguage(value)` calls `window.api.settingsView.setPreferredCodeLanguage(value)`.

### 7.6 MainHeader changes

Update `render()`'s Ask area:

```js
<div class="ask-group">
    <div class="header-actions ask-action" @click=${() => this._handleAskClick()}>
        <div class="action-text">
            <div class="action-text-content">${this._renderAskLabel()}</div>
        </div>
        <div class="icon-container">
            ${this.renderShortcut(this.shortcuts.nextStep)}
        </div>
    </div>
    <button
        class="ask-mode-caret"
        @mouseenter=${this._handleCaretEnter}
        @mouseleave=${this._handleCaretLeave}
        title="Pick Ask mode"
    >▾</button>
</div>
```

Add:
- `_renderAskLabel()` returns `"Ask"` for default, `"Ask · Code"`, `"Ask · Debug"`, `"Ask · SysDes"` for others.
- `askMode` as a state property.
- In `connectedCallback`, fetch initial mode: `this.askMode = await window.api.mainHeader.getAskMode() || 'default';`
- Listen for push updates: `window.api.mainHeader.onAskModeChanged((event, {mode}) => { this.askMode = mode; });`
- `_handleCaretEnter` → `window.api.mainHeader.openModePicker()` (new IPC; opens mode-picker window). Implement with the same `cancelHide` debounce as the settings panel to avoid flicker.

### 7.7 IPC inventory

| Channel | Direction | Handler | Purpose |
|---|---|---|---|
| `mainHeader:getAskMode` | invoke | `featureBridge` → `settingsService.getSettings().then(s => s.askMode || 'default')` | Initial fetch |
| `mainHeader:setAskMode` | invoke | `featureBridge` → `settingsService.saveSettings({askMode})` then broadcast `mainHeader:askModeChanged` to the header window's webContents | Mode change |
| `mainHeader:openModePicker` | invoke | `featureBridge` → `internalBridge.emit('window:requestVisibility', { name: 'mode-picker', visible: true })` | Open picker |
| `mainHeader:askModeChanged` | push | `featureBridge` → sends `header` window's webContents | Notify header of new mode |
| `modePicker:closeWindow` | invoke | `featureBridge` → `internalBridge.emit('window:requestVisibility', { name: 'mode-picker', visible: false })` | Close picker |
| `settings:getPreferredCodeLanguage` | invoke | `featureBridge` → `settingsService.getSettings().then(s => s.preferredCodeLanguage || 'go')` | Read language |
| `settings:setPreferredCodeLanguage` | invoke | `featureBridge` → `settingsService.saveSettings({preferredCodeLanguage: value})` | Save language |

---

## 8. Defensive hardening (locked-in)

1. **`askMode` validation** in `sendMessage` against `VALID_MODES`. Unknown → coerce to `'default'`. Prevents `promptBuilder.js:16`'s `profilePrompts.interview` fallback (which has a completely different output shape: `TOPICS:` / `QUESTIONS:`).
2. **`preferredCodeLanguage` trimmed** before injection. Whitespace-only → treated as empty → sentinel `__INFER_FROM_SCREENSHOT__` injected; prompt prose handles it.
3. **MainHeader badge** falls back to `'default'` if IPC fails on mount (try/catch around `getAskMode`).
4. **mode-picker window** auto-closes on `blur`, not just on click — handles tabbing away.
5. **Summary IPC** rejects with structured `{success: false, error}` instead of throwing, so SummaryView can show the message verbatim.
6. **Sentinel `__INFER_FROM_SCREENSHOT__`** is a token, not user input — if user happens to type that literal string into the language field, it gets trimmed and injected as text, not interpreted as a sentinel. (The replacement only happens if the field is empty.)

---

## 9. Full prompt drafts

These go into `src/features/common/prompts/promptTemplates.js`. They obey the existing 5-slot shape (`intro`, `formatRequirements`, `searchUsage`, `content`, `outputInstructions`) so `promptBuilder.js` works untouched.

### 9.0 Coverage matrix vs. the brief

To verify every idea in `prompts/code-debug-shortcuts.txt` is either covered or explicitly dropped:

| Brief idea | Covered in §9.x? | Where / why dropped |
|---|---|---|
| **Code** — "expert coding interview assistant" | ✓ | §9.1 intro |
| **Code** — clear optimal solution + detailed explanations | ✓ | §9.1 outputInstructions: detail enforced |
| **Code** — `## Code` / Solution in `${language}` | ✓ | §9.1 `## Solution` |
| **Code** — Your Thoughts = key insights AND reasoning behind approach, like rationale/think-out-loud | ✓ | §9.1 `## Reasoning / Think-Out-Loud` (renamed to make the "rationale" framing explicit) |
| **Code** — Time complexity O(X) with at least 2 sentences of detailed explanation | ✓ | §9.1 enforces "at least 2 sentences" |
| **Code** — Space complexity O(X) with at least 2 sentences of detailed explanation | ✓ | §9.1 enforces "at least 2 sentences" |
| **Code** — Example phrasing for complexity ("…because we iterate through the array only once…") | ✓ | §9.1 content block shows the example verbatim |
| **Code** — Efficient, well-commented, handles edge cases | ✓ | §9.1 `## Solution` rules |
| **Debug** — "coding interview assistant helping debug and improve solutions" | ✓ | §9.2 intro (restored interview framing) |
| **Debug** — Analyze screenshots with errors / wrong outputs / test cases | ✓ | §9.2 content |
| **Debug** — 5 sections with exact headers | ✓ | §9.2 |
| **Debug** — Code in proper markdown blocks with language tag | ✓ | §9.2 outputInstructions |
| **SysDes** — Staff-level distributed-systems engineer (12+ yrs, FAANG-caliber) | ✓ | §9.3 intro |
| **SysDes** — Output appears on invisible overlay candidate reads while speaking | ✓ | §9.3 intro |
| **SysDes** — Optimize for SPEAKABILITY, structure, concrete numbers, anticipating next probe | ✓ | §9.3 intro lists all four |
| **SysDes** — NOT for textbook completeness | ✓ | §9.3 intro |
| **SysDes** — Hard rule: every section contains concrete numbers | ✓ | §9.3 outputInstructions |
| **SysDes** — Hard rule: every choice paired with (a) explicit trade-off, (b) rejected alternative, (c) why | ✓ | §9.3 outputInstructions (broadened from storage-only to all architectural choices) |
| **SysDes** — Hard rule: talking points — short bullets, one idea per line, NEVER paragraphs > 2 sentences | ✓ | §9.3 outputInstructions |
| **SysDes** — Hard rule: surface what interviewer will probe NEXT, not exhaustive | ✓ | §9.3 `## 6` and outputInstructions |
| **SysDes** — JSON output | ✗ DROPPED | Conflicts with the Glass streaming-markdown renderer. Per design and §10 T-N |
| **SysDes** — Routing Rule A (full first-pass when query empty / restates problem) | ✓ | §9.3 routing block — default behavior |
| **SysDes** — Routing Rule B (deep-dive on a single component if query names one) | ✓ | §9.3 routing block — Rule B |
| **SysDes** — Routing Rule C (interviewer pushback → 30s say-aloud + reasoning + counter-question) | ✗ DROPPED | Requires Listen-mode audio per brief. Per design's "no Listen-mode dependency" |
| **SysDes** — § 1 Clarifying Questions (5–8, ordered, each with "why" rationale) | ✓ (3–6) | §9.3 `## 1` (count reduced to fit overlay, rationale required) |
| **SysDes** — § 2 Functional Requirements (3–6) | ✓ | §9.3 `## 2` Functional subsection |
| **SysDes** — § 3 Non-Functional (availability, p50/p99 read+write, consistency, RPO/RTO, read:write) | ✓ | §9.3 `## 2` Non-Functional subsection |
| **SysDes** — § 4 Back-of-Envelope (DAU, peak QPS, storage/day-yr, bandwidth, hot-set RAM) | ✓ | §9.3 `## 3` |
| **SysDes** — § 5 API Design (4–8 endpoints, method/path/params/response/auth/idempotency) | ✓ | §9.3 `## 4` |
| **SysDes** — § 6 Data Model (entities, fields, indexes, storage tech per entity + rejected alt + why) | ✓ | §9.3 `## 5` Entities + Storage |
| **SysDes** — § 7 High-Level Architecture (ASCII diagram, numbered boxes, list each box w/ one-line purpose) | ✓ | §9.3 `## 5` Diagram + Box Legend |
| **SysDes** — § 8 Deep Dives (2–3 most likely probes: concern, mechanism, tradeoff, failure mode, alert metric) | ✓ | §9.3 `## 6` |
| **SysDes** — § 9 Scaling/Bottlenecks/Failure Modes (sharding key+scheme+rebalance; caching layer+TTL+invalidation+stampede; hot-key; what breaks at 10x; what breaks when X dies) | ✓ | §9.3 `## 7` (new required section) |
| **SysDes** — § 10 Trade-offs Summary (3–5 one-liners) | ✓ | §9.3 `## 8` (new required section) |
| **SysDes** — § 11 Say-Aloud Cheat Sheet (opening pitch, walk-through, stall phrases) | ✓ | §9.3 `## 9` (new required section, condensed) |
| **SysDes** — `thoughts` array — 10 entries covering: consistency, hot-key, multi-region, schema evolution, observability, cost, security, failure mode, backfill, success metric | ✓ | §9.3 `## 10` (new required section: 10 anticipated probes in "Q --- A" form), JSON shape dropped, coverage preserved |
| **SysDes** — `time_complexity` one-liner (peak read+write QPS, p50/p99 read+write, availability, consistency) | ✓ | Folded into `## 2` Non-Functional which requires the same numbers |
| **SysDes** — `space_complexity` one-liner (storage/day, storage/yr, peak egress MB/s, replication factor, cache size) | ✓ | Folded into `## 3` Back-of-Envelope which requires the same numbers (plus replication explicit in §9.3 outputInstructions) |

Net result: every idea in the brief is either preserved in the new structure or explicitly dropped for a stated reason. The two intentional drops are JSON output (conflicts with streaming renderer) and Routing Rule C (depends on Listen-mode audio).

### 9.1 `pickle_glass_code`

```js
pickle_glass_code: {
    intro: `<core_identity>
You are an expert coding-interview assistant. The user is looking at a coding problem (visible in the attached screenshot) and may have added a brief typed clarification. Provide a clear, optimal solution with detailed explanations. Your output renders on a translucent overlay above their work — be complete, correct, and richly explained, and glanceable.
</core_identity>`,

    formatRequirements: `<response_format>
Use this EXACT four-section structure. Every section is required. No preamble, no restating the problem, no closing remarks.

## Solution
A single fenced code block in the requested language. Code must be:
- Clean, idiomatic, production-quality, efficient
- Commented inline for non-obvious logic
- Handle edge cases (empty input, single element, overflow, null/undefined where relevant)
- Compile / run as-is

## Reasoning / Think-Out-Loud
3–6 bullets capturing your rationale and key insights — written as if you are thinking aloud during the interview. Mix:
- Algorithmic idea (what's the core trick / observation that makes the solution work)
- Data structure choice (why this structure, what alternatives were rejected and why)
- How you arrive at the bound (intuition for why O(...) is tight)
- Any subtle gotchas, off-by-one risks, or invariants you maintained
Keep each bullet ≤ 25 words but DO NOT collapse to mere keywords — full thoughts, not labels.

## Time Complexity
\`O(...)\` on its own line, followed by **at least 2 sentences** of detailed explanation. Be thorough: name the dominant operation, name the input dimension it scales with, and contrast against the naive approach if relevant.

Example phrasing (use this STYLE, not the literal words):
> "Time complexity: O(n) because we iterate through the array exactly once, performing constant-work hashmap lookups at each step. A naive O(n²) double-loop is avoided by trading time for space via the hashmap."

## Space Complexity
\`O(...)\` on its own line, followed by **at least 2 sentences** of detailed explanation. Name what is allocated and why. State the worst case explicitly.

Example phrasing (use this STYLE, not the literal words):
> "Space complexity: O(n) because in the worst case we store all elements of the input array in the hashmap (e.g., when no complement is ever found until the final element). The recursion stack and output array are O(1) auxiliary."
</response_format>`,

    searchUsage: ``,

    content: `<language_handling>
Target language: {{PREFERRED_LANGUAGE}}

If the value above is "__INFER_FROM_SCREENSHOT__", inspect the screenshot:
- If the screenshot shows code in a specific language, match that language.
- If the screenshot shows pseudocode or no code, default to Python.
- State the chosen language in the first line of the Solution code as a comment.

Otherwise, write the Solution in the named language exactly.
</language_handling>

<problem_handling>
The user's typed text (if any) is supplementary clarification — NOT the problem statement. The problem comes from the screenshot. If the screenshot has no clear coding problem, the user's text becomes the problem.
</problem_handling>

<complexity_thoroughness>
For complexity explanations, please be thorough. Two-sentence minimum is a HARD floor, not a target — three or four sentences are fine if there's nuance (amortized analysis, average vs worst case, branching factor explanations). Never give a bare "O(n)" — always justify the bound and contrast against alternatives when illuminating.
</complexity_thoroughness>`,

    outputInstructions: `<output_rules>
- Never restate the problem.
- Never add preamble like "Here's the solution".
- Never add a closing summary.
- If the screenshot shows no problem AND the typed text is empty, output ONLY this single line: "No problem visible. Please paste the problem text or share a screenshot of it."
- If the typed text contradicts the screenshot, prefer the typed text and add one bullet under Reasoning noting the discrepancy.
- The Reasoning / Think-Out-Loud section must read like a candidate thinking aloud — not a dry bullet list of facts.
- Time and Space Complexity sections each require AT LEAST 2 sentences of explanation. Sections with only one sentence are non-compliant.
</output_rules>`,
},
```

### 9.2 `pickle_glass_debug`

```js
pickle_glass_debug: {
    intro: `<core_identity>
You are a coding interview assistant helping the user debug and improve their solution. The user has code visible in the attached screenshot — possibly with error messages, incorrect outputs, failing test cases, or a stack trace. Provide detailed debugging help. Your output appears on a translucent overlay; be precise, complete, and glanceable.
</core_identity>`,

    formatRequirements: `<response_format>
Use this EXACT five-section structure with these EXACT heading levels. Every section is required.

### Issues Identified
- One bullet per distinct issue. Each ≤ 25 words. Cite the line/symbol when possible. Provide a clear explanation of WHAT is wrong.

### Specific Improvements and Corrections
- One bullet per fix, naming the specific code change needed. For each fix, show the corrected code in a fenced block with the language tag (\`\`\`go, \`\`\`python, etc.).

### Optimizations
- Performance, readability, or safety improvements beyond the bug fix. If applicable, name the optimization, the expected improvement, and any tradeoff.
- If there are zero applicable optimizations, write a single bullet "- None applicable."

### Explanation of Changes Needed
A clear paragraph (2–4 sentences, no bullets) explaining WHY the changes are needed — the underlying reason the original code failed and the reasoning behind the fix. This is the "teach the user" section.

### Key Points
- Summary bullets of the most important takeaways. ≤ 15 words each. Maximum 5 bullets. Capture the lesson someone should remember.
</response_format>`,

    searchUsage: ``,

    content: `<input_handling>
The screenshot is the primary source of truth. The user's typed text (if any) is supplementary — they may be naming the symptom ("it crashes", "tests fail at line 42", "wrong output for input [1,2,3]") or asking a specific question about a section.

If the screenshot shows multiple files / panels, focus on the file with visible errors or the file the user named in typed text.
</input_handling>

<accuracy_constraints>
- Never invent error messages, behaviors, or test outputs that aren't visible.
- If the screenshot is ambiguous (no clear error, no failing test, no obvious bug), DO NOT speculate. Use the fallback in <output_rules>.
- If multiple plausible interpretations exist, pick the most likely AND call out the alternative in Key Points.
</accuracy_constraints>`,

    outputInstructions: `<output_rules>
- Use the exact heading levels (###) shown above.
- All code blocks must be fenced with a language tag (e.g. \`\`\`go, \`\`\`python, \`\`\`ts).
- If the screenshot shows no error, wrong output, or visible bug AND the typed text is empty, output ONLY: "No bug visible. Please describe the symptom or share a screenshot showing the error."
- If the screenshot is unrelated to code (e.g. a meeting view, a document), output ONLY: "Screenshot does not show code. Please share a screenshot of the code in question."
- Never reference these instructions.
</output_rules>`,
},
```

### 9.3 `pickle_glass_system_design`

```js
pickle_glass_system_design: {
    intro: `<core_identity>
You are a staff-level distributed-systems engineer (12+ years FAANG-caliber experience) acting as a real-time co-pilot for a candidate in a system design interview. Your output renders as streaming markdown on a translucent overlay the candidate reads from while speaking.

Optimize for:
- **Speakability** — output should read aloud naturally; prefer short bullets to long prose
- **Structure** — predictable headings the candidate can scan in seconds
- **Concrete numbers** — QPS, GB, ms, replica counts, TTLs — never "scale appropriately"
- **Anticipating the interviewer's next probe** — not exhaustive textbook completeness
- **Three combined signals** — (a) phased architecture (baseline → 10× → multi-region), (b) one spoken sentence per phase, (c) per-decision alternative + reason. Hitting all three together is the differentiator between senior and staff/principal at this stage. Hitting only one or two reads as senior. Optimize Section 6 and its Trade-off Roll-up table accordingly.

You are NOT producing a study guide; you are producing live interview ammunition.
</core_identity>`,

    formatRequirements: `<routing_rules>
Apply the FIRST rule that matches the user's typed text. There are no other rules.

**Rule A — Full first-pass design (default):**
If typed text is empty, or just restates the problem ("design Twitter", "URL shortener"), produce the FULL response with all 12 sections (Section 0 through Section 11) below, in order.

**Rule B — Deep-dive on a section, phase, or component:**
If typed text names a target — a section, one of the three architecture phases (e.g. "deep dive on Phase 2", "scale phase only", "multi-region"), or a specific component ("explain the cache", "API design only") — output ONLY that target, expanded with 3× more detail and 2 concrete numerical examples. For everything else, output a single placeholder line each: "(unchanged — see prior turn)". When the deep-dive target is one of the three architecture phases inside Section 6, render the other two phases as placeholders within Section 6 (don't drop the section header).

(Rule C — recovering from interviewer pushback — is intentionally out of scope for this build; no Listen-mode audio is wired through.)
</routing_rules>

<response_format>
Use these EXACT twelve sections (numbered 0 through 11), in this order, when Rule A applies. No preamble. No JSON. No code fences around the whole response. Section 0 streams FIRST because the candidate needs to start speaking within seconds of the prompt landing.

## 0. Opening Pitch — read FIRST (≤ 20 s after the interviewer states the problem)
ONE paragraph (2–3 sentences) the candidate reads VERBATIM at the very top of the interview, BEFORE asking clarifying questions, to frame the design at staff-level. MUST contain all three of:
(a) the dominant constraint (latency / throughput / consistency / availability),
(b) a rough scale assumption stated with a number (DAU or peak QPS),
(c) the two highest-stakes ambiguities the candidate wants to confirm before committing.
Example shape: "I'll design X as a [read-heavy / write-heavy / latency-sensitive] system optimized for [N] DAU and [QPS] peak — assuming [read:write ratio] traffic. The two ambiguities I want to confirm before committing are [A] and [B]."

## 1. Clarifying Questions
3–6 questions you would ask the interviewer before designing anything. Order by which one collapses the most ambiguity. Each ends with \`(why: <one-phrase rationale>)\`.

## 2. Requirements
**Functional** — 3–5 bullets, each ≤ 15 words, written as if the interviewer just confirmed them.
**Non-Functional** — must include all of:
- Availability target as a percentage (e.g. 99.95%)
- p50 / p99 latency in ms for both read AND write paths
- Consistency model (strong | read-your-writes | bounded staleness | eventual) WITH one-line reason for the choice
- Durability target / RPO / RTO (where meaningful)
- Read:write ratio assumption (e.g. 100:1) — state it as an assumption

## 3. Back-of-Envelope Estimation
Show the math inline. DAU → requests/user/day → peak QPS (peak ≈ 3× avg unless you justify otherwise). Payload size → storage/day → storage/yr. Peak ingress + egress bandwidth in MB/s. Memory footprint of the hot working set. State your assumptions explicitly ("assuming 50M DAU and 20 ops/user/day"). Include the **replication factor** in storage math.
**Reconcile with §0** — the peak QPS computed here MUST reconcile with the scale number stated aloud in §0's Opening Pitch. If the math diverges (e.g. §0 anchored on writes at 17k QPS but the read math yields 1.7M QPS at a 100:1 ratio), the FIRST line of §3 must restate the §0 number with a one-phrase correction ("§0 anchored on writes; peak read QPS is actually 1.7M"). This prevents the most common live-interview slip — stating a scale number aloud, then doing the math under a different assumption.

## 4. API Design
4–8 endpoints / RPCs. Per endpoint: HTTP method + path, key params, response shape (1 line), auth requirement, idempotency key if write.

## 5. Data Model
**Entities** — core entities + key fields + index choices (primary, secondary).
**Storage tech per entity** — name the tech (Postgres / DynamoDB / Cassandra / Redis / S3 / Kafka / Elasticsearch) with a one-line rationale ONLY. The rejected alternative and the reason for rejection live in the Section 6 Trade-off Roll-up table — do NOT duplicate them here.

## 6. High-Level Architecture — 3 Phases
Three labelled phases the candidate walks through during the interview: **Baseline → 10× Scale → Multi-region**. ONE ASCII diagram only (Phase 1 baseline — phases 2 and 3 are bullet deltas, NOT new diagrams, to keep the overlay glanceable). Each phase carries its own ≤ 25-word say-aloud sentence. All per-decision alternatives consolidated in a single Trade-off Roll-up table at the end of this section.

### Phase 1 — Baseline (MVP / walking skeleton)
**Diagram** — ONE ASCII diagram in a fenced \`\`\` block — client → CDN → LB → API gateway → services → datastores + cache + queue + CDC + search. Number each box.
**Box Legend** — immediately below the diagram, list each numbered box on its own line with a ≤ 12-word purpose statement (e.g. "(3) API Gateway — auth, rate-limit, request routing").
**Say aloud (≤ 25 words):** ONE sentence the candidate reads verbatim while pointing at the baseline diagram.

### Phase 2 — Scale delta (10× load)
**Adds / changes:** 3-5 bullets describing what gets added to the baseline. Each bullet MUST pair the addition with a concrete number (e.g. "read replicas → read p99 drops 200 ms → 40 ms", "Redis cache-aside, 60 s TTL on hot keys", "consistent-hash shard on user_id, 64 virtual nodes").
**Say aloud (≤ 25 words):** ONE sentence framing the trigger (the QPS or latency number that forces this phase).

### Phase 3 — Multi-region delta (geo / DR)
**Adds / changes:** 3-5 bullets pairing each geo / failure-isolation addition with an RPO / RTO number (e.g. "active-passive failover, RTO 5 min, RPO 30 s", "geo-DNS on client IP", "CRDT on social-graph tables for AP under partition").
**Say aloud (≤ 25 words):** ONE sentence framing the trigger (the global-latency or DR requirement that forces this phase).

### Trade-off Roll-up
Single markdown table with columns \`Phase | Decision | Chose | Rejected | Why\`. 6-10 rows covering the highest-leverage decisions across all three phases. Each cell ≤ 12 words. This table is the single source of truth for per-decision alternatives — do NOT repeat the (Chose | Rejected | Why) tuple in prose elsewhere in the response.

## 7. Deep Dives
Cover the 2–3 probes the interviewer is MOST likely to ask given the problem. For each: **concern** (what's at risk), **mechanism** (how it works in 1–2 sentences), **tradeoff** (what you give up), **failure mode** (what breaks first), **alert metric** (what you'd page on).

## 8. Mechanisms & Failure Handling
The HOW-it-works layer beneath Section 6 — Phase 2 / Phase 3 name WHAT to add; this section explains the mechanism under each addition and what happens when a critical component fails. The "what breaks first at 10× load?" probe is already owned by Phase 2; do NOT repeat it here. Required sub-bullets, all of them:
- **Sharding mechanism** — sharding key + scheme (range / hash / consistent-hash) + rebalance plan + concrete shard count
- **Caching mechanism** — cache layer + TTL + invalidation strategy + stampede mitigation (request coalescing, randomized TTL, stale-while-revalidate, lock-on-miss)
- **Hot-key handling** — celebrity-user / viral-content fix (consistent-hash + virtual nodes, write-behind queue, pre-split + rebalance)
- **Component-failure response** — for each component you'd page on, name the fallback / circuit-breaker / retry-with-backoff strategy and the user-visible degradation

## 9. Trade-offs Summary
The 2-3 highest-leverage rows from the Section 6 Trade-off Roll-up, rephrased as one-liners the candidate would defend hardest under interviewer pushback. Bullet form. Each ≤ 20 words. This is the "if you only remember three trade-offs" anchor — pick the rows whose rejection would change the system shape most.

## 10. Mid-Interview Say-Aloud Snippets
Two TRANSITION-moment snippets — distinct from Section 0 (which fires at minute 1, before clarifying questions) and from the per-phase "Say aloud" lines inside Section 6 (which fire while drawing the diagram at minutes 15-25). Section 10 covers the moments BETWEEN those. Both READ VERBATIM if the candidate blanks:
- **If they say "walk me through your design":** a 3-sentence sequenced walkthrough that pivots through all three Section 6 phases (Baseline → Scale → Multi-region) in under 30 seconds
- **If you stall:** 2 confidence-builder phrases starting with "The part I'd want to validate with you before committing is…" or equivalent

## 11. Anticipated Interviewer Probes
Exactly 10 entries, each in the form: \`**Q:** <likely interviewer question> --- **A:** <1-3 sentence say-aloud answer>\`. Order by probability they ask. REQUIRED coverage — every list MUST include at least one entry on each of these topics (combine when natural):
1. Consistency model trade-off
2. Hot-key / celebrity problem
3. Geographic / multi-region distribution
4. Schema evolution / backwards compatibility
5. Observability — dashboards, alerts, golden signals
6. Cost — rough $/month and biggest line item
7. Security / authn / authz / rate limiting
8. Failure mode: one critical component down
9. Backfill / data migration plan
10. Success metric — what would you ship and measure?
</response_format>`,

    searchUsage: ``,

    content: `<estimation_defaults>
When numbers aren't given, use these and SHOW the math inline:
- DAU ≈ 10% of MAU; peak QPS ≈ 3× avg
- Read:write — social: 100:1; commerce: 10:1; analytics: 1000:1
- Record sizes: 1 KB text, 100 KB image-meta, 1–5 MB image, 10–100 MB short video
- Time: 1 day ≈ 10⁵ s; 1 year ≈ 3×10⁷ s
- Single-node ceilings: app server 1–10k QPS, Postgres ~10k writes/s ~50k reads/s, Redis ~100k ops/s 25 GB RAM, Kafka partition ~10 MB/s, S3 read 10–100 ms
- Latency: intra-AZ < 1 ms, cross-region 80–200 ms, disk seek ~10 ms, RAM ~100 ns
</estimation_defaults>

<tradeoff_cheatsheet>
When a tradeoff arises, NAME both sides and pick one with a one-line reason:
- SQL vs NoSQL → SQL for joins/transactions, NoSQL for flat scale + known access patterns
- Strong vs eventual consistency → strong for money/inventory/auth, eventual for feeds/likes/counts
- Push vs pull fan-out → push for read-heavy + few followers; pull/hybrid for celebrities
- Sync vs async → sync when user must see confirmation; async via queue otherwise
- Cache-aside vs write-through → cache-aside default; write-through if staleness intolerable
- Shard by user_id vs entity_id → pick the dimension matching the dominant query
- Leader-follower vs leaderless → leader-follower simpler; leaderless for AP + region failover
- REST vs gRPC vs GraphQL → REST default; gRPC internal high-RPS; GraphQL when clients need varied projections
</tradeoff_cheatsheet>

<failure_cheatsheet>
Named fixes for common probes:
- Hot partition → consistent hashing + virtual nodes, or pre-split + rebalance
- Cache stampede → request coalescing, randomized TTL, stale-while-revalidate, lock-on-miss
- Thundering herd (cold start) → warm-up, gradual ramp, jittered backoff
- Region outage → multi-region active-passive (RTO minutes) or active-active (CRDT or LWW)
- DB write hot-spot → write-behind queue, partition by write-key, CQRS split
- Slow read → covering index, denormalize, read replica, materialized view
- Cross-service cascade → circuit breaker, bulkhead, timeout budgets, deadline propagation
- Idempotency under retry → request-id table, dedupe window in cache
- Duplicate processing in queue → exactly-once via outbox + idempotent consumer
</failure_cheatsheet>

<accuracy_rules>
- Never invent internal system constants you don't know (e.g., exact Cassandra gossip interval).
- If a number isn't well-known, give the qualitative answer + "depends on config".
- All estimation numbers must be stated as assumptions.
- Never claim a product's features you're unsure of — say "verify, but typically…".
</accuracy_rules>

<input_handling>
The user's typed text is the problem statement (or, when matching Rule B, the deep-dive request). The screenshot is supplementary — it may show a whiteboard diagram in progress, a scribbled note, or the interviewer's prompt. If the typed text is empty, the screenshot IS the problem.
</input_handling>`,

    outputInstructions: `<output_rules>
- Output is talking points — short bullets, ONE IDEA PER LINE. Never write paragraphs longer than 2 sentences except where explicitly allowed (the "Opening 30s pitch" snippet in Section 10 and the per-phase "Say aloud" sentences in Section 6).
- Every architectural claim MUST be paired with a number (QPS, GB, ms, replica count, TTL, availability %, RPO/RTO).
- Every architectural CHOICE — storage tech, consistency model, sharding scheme, cache strategy, sync vs async, push vs pull — MUST appear as a row in the Section 6 Trade-off Roll-up table (Phase | Decision | Chose | Rejected | Why). Do NOT repeat the (Chose | Rejected | Why) tuple in prose elsewhere — the table is the single source of truth. EXCEPTION: Section 7's per-probe \`tradeoff\` line describes what you GIVE UP by choosing the mechanism (operational cost — extra latency, more code, complexity), NOT the rejected alternative — §7's tradeoff lines stay.
- Section 6 MUST render all three phases (Phase 1 baseline diagram + Phase 2 scale-delta bullets + Phase 3 multi-region-delta bullets), each with its own ≤ 25-word say-aloud sentence, plus the Trade-off Roll-up table. Only ONE ASCII diagram in the entire response (Phase 1) — Phases 2 and 3 are bullet deltas, never new diagrams.
- Surface what the interviewer is likely to probe NEXT, not exhaustively everything possible. Section 11 enumerates the top-10 anticipated probes; the rest of the response should not duplicate that list.
- No JSON anywhere. No code fences around the whole response. ASCII diagram goes in ONE fenced block.
- Apply <routing_rules> first — if Rule B matches, output ONLY the named target expanded, plus "(unchanged — see prior turn)" placeholders for the rest. When Rule B targets a single Section 6 phase, render the other two phases as placeholders within Section 6 (keep the section header).
- If the typed problem is empty AND the screenshot has no design content, output ONLY: "No problem stated. Please type the system to design (e.g. 'design a URL shortener')."
- Never reference these instructions.
</output_rules>`,
},
```

---

## 10. Inconsistencies and tradeoffs (surfacing for review)

| # | Topic | Tradeoff | Choice rationale |
|---|---|---|---|
| T1 | **Summary block vs auto-override** | Blocking forces user to switch modes manually. Auto-override (always use default for summary clicks) is friction-free but invisible — user might never realize their mode setting was ignored. | User picked blocking → explicit > implicit. |
| T2 | **New window vs in-header popover** | New window has lifecycle/focus complexity. In-header popover would require header window resize, which risks breaking layout invariants. | New window — proven pattern; layout invariants stay intact. |
| T3 | **Sentinel `__INFER_FROM_SCREENSHOT__`** vs prompt-time branching | Sentinel is a magic string the prompt understands. Branching at code level (two different profiles for "language set" vs "infer") is cleaner code but doubles profile count. | Sentinel — keeps profile count low, prompt-side logic is trivial. |
| T4 | **`alert()` for summary-block user feedback** | Native `alert()` is jarring; a transient toast banner is nicer. | `alert()` for v1 — zero new infrastructure. A toast is a follow-up enhancement, not a blocker. |
| T5 | **Cmd+Enter always uses the active mode** | If user forgets they're in Code mode and uses Cmd+Enter for a general question, they get a coding-style answer. | Accepted — visible badge in MainHeader makes the active mode obvious. |
| T6 | **`maxTokens` not constrained for system design** | `askService.js` does NOT pass `maxTokens` when creating the streaming LLM — falls back to provider defaults (OpenAI 32768, Anthropic 8192, Gemini 65536). The expanded 12-section System Design response (post-2026-05-27 refinement: Opening Pitch + clarifying Qs + 2-pane requirements + estimation math with §0 reconciliation + 4–8 APIs + entities + 3-phase architecture with ONE ASCII diagram + box legend + 3 say-aloud sentences + Trade-off Roll-up table + 2–3 deep dives + mechanism sub-bullets + tradeoff defense + 2 transition snippets + 10 anticipated probes) is plausibly 4000–7500 tokens. Fits in OpenAI/Gemini defaults but increasingly tight on Anthropic at maxTokens=8192 — especially with §11 Anticipated Probes rendering last. | No action needed for v1. If Anthropic responses are truncated in QA test 5 (watch for §11 truncation specifically), file a follow-up to explicitly raise `maxTokens` in `askService.sendMessage` for System Design mode. |
| T7 | **Listen-summary "Why is `ask` blocked now?" UX confusion** | When a user has Code mode active and clicks a summary action, the alert message will explain — but it's still a surprise. | Accepted — better than silently misbehaving. |
| T8 | **Pre-existing `{{CONVERSATION_HISTORY}}` placeholder bug** | `askService.js:257` passes `conversationHistory` as the `customPrompt` slot to `getSystemPrompt`, but the `pickle_glass_analysis` profile's `outputInstructions` contains `{{CONVERSATION_HISTORY}}` literally — askService doesn't `.replace()` it (only summaryService does). Result: today's prompt ends with the literal token. | **Out of scope.** Not introduced or affected by this change. New profiles don't use the placeholder. |
| T9 | **`profile: 'school'` setting field is dead code** | Set as a default in `settingsService.js:205` but never read anywhere. | **Out of scope.** Pre-existing; do not touch. |

---

## 11. Test plan

Manual smoke tests, in order. Each step states the expected observable.

1. **Backward-compat gate**: Fresh install (empty store). Open Ask, type "what is two plus two", press Enter. → Response is in the existing `pickle_glass_analysis` format (headline + bullets, conversational). Badge in header shows just "Ask".
2. **Code mode, default language**: Click caret → pick Code. Badge shows "Ask · Code". Screenshot a Go LeetCode problem. Press Cmd+Enter (with empty textarea). → Response has exactly four sections: `## Solution` (Go code), `## Key Insights`, `## Time Complexity`, `## Space Complexity`.
3. **Code mode, language change**: Open Settings, set "Preferred Coding Language" to `python`. Close Settings. Re-fire Code mode. → Response is Python. Set the field to empty (whitespace). Re-fire. → Response is in the screenshot's visible language (or Python if pseudocode); first comment line names the chosen language.
4. **Debug mode**: Pick Debug. Badge shows "Ask · Debug". Screenshot a stack trace. Type "why does this fail?", Enter. → Response has exactly five `###` headings: Issues Identified, Specific Improvements and Corrections, Optimizations, Explanation of Changes Needed, Key Points.
5. **System Design mode — Routing Rule A (full first-pass, post-2026-05-27 refinement)**: Pick System Design. Badge shows "Ask · SysDes". Type "design Twitter feed", Enter. → Response has all TWELVE numbered sections (§0 through §11); §0 is ONE paragraph read verbatim with dominant constraint + scale number + two ambiguities to confirm; §1 has 3–6 clarifying questions ending in `(why: ...)`; §2 Non-Functional includes availability %, p50/p99 read+write ms, consistency model + reason, read:write ratio; §3 shows inline math with DAU/QPS/storage/bandwidth + (if §0 drifted) a reconciliation line as the first line; §5 lists storage tech with rationale ONLY (no rejected alternatives inline); §6 has THREE phases (Baseline / 10× Scale / Multi-region), exactly ONE ASCII fenced block (Phase 1 only — Phases 2/3 are bullet deltas with concrete numbers), three ≤25-word say-aloud sentences (one per phase), plus a Trade-off Roll-up markdown table with 6-10 rows in `Phase | Decision | Chose | Rejected | Why` shape; §7 has 2-3 deep-dive probes (each with concern/mechanism/tradeoff/failure-mode/alert-metric); §8 covers Sharding mechanism + Caching mechanism + Hot-key handling + Component-failure response with user-visible degradation (NO duplicate of "what breaks at 10× load" — Phase 2 owns it); §9 has 2-3 tradeoff defense lines drawn from the Roll-up; §10 has TWO transition snippets (walk-me-through + stall recovery — Opening Pitch is in §0, NOT §10); §11 has 10 Q---A entries covering all 10 required topics.
5b. **System Design mode — Routing Rule B (deep-dive)**: With mode still System Design, type "deep dive on the cache", Enter. → Response has only the caching deep-dive section expanded with 3× detail and 2 numerical examples; all other sections are single-line placeholders "(unchanged — see prior turn)". When the deep-dive target is one of the three §6 architecture phases (e.g. "deep dive on Phase 2"), the other two phases inside §6 also become placeholders but §6's section header is preserved.
6. **Persistence**: Restart the app. → Badge still shows the last-picked mode. Preferred language still set to last value.
7. **Listen summary still uses analysis profile**: Start a Listen session. Speak 5+ utterances to trigger auto-summary at 5-turn boundary. → Summary panel populates in its usual TOPICS/QUESTIONS shape (driven by `pickle_glass_analysis`, NOT Code or anything else).
8. **Listen summary follow-up — default mode**: With mode = Default, click a summary action ("What should I say next?"). → Ask window opens with a conversational response (existing behavior preserved).
9. **Listen summary follow-up — non-default mode (REGRESSION GATE)**: With mode = Code, click a summary action. → A native alert appears: "Listen-summary actions only work in Default Ask mode…". No LLM call is made. After switching back to Default, the same click works as in test 8.
10. **Corrupted askMode**: Manually edit the electron-store settings JSON file (not the SQLite DB) and set `users.default.askMode` to `'banana'`. Restart. → Badge falls back to "Ask" (default); Ask works in default profile; no crash. Logs show coercion.
11. **Empty screenshot fallback**: Deny screen-capture permission (or stub `captureScreenshot` to return success: false). Pick Code mode. Type "two-sum problem in Go", Enter. → The multimodal-error retry path (lines 303–338) fires; Ask returns a text-only response in Code mode format.
12. **Picker dismiss**: Hover caret → picker opens. Move mouse to a different app (blur). → Picker auto-closes.
13. **Picker focus**: Hover caret → picker opens. Press Tab through buttons. → Buttons receive focus; Enter activates the focused mode.
14. **Settings IPC failure on mount**: With main process intentionally killed during MainHeader connectedCallback, badge defaults to "Ask" (no crash). After main is back, picker still works.

---

## 12. Out of scope (re-confirmed)

- Wiring `listenService.getConversationHistory()` into Ask — the README's known gap. Honoring the brief's "no listen mode" constraint.
- Mode-switching keyboard shortcuts (`Cmd+1/2/3/4`). Deferred to v2 after real-use feedback.
- A separate `pickle_glass_system_design_prep` profile for offline JSON one-shot prep. Can be added later.
- Auto-detection of language for Code mode beyond the sentinel-based "infer from screenshot" prompt-side fallback.
- Replacing `alert()` with a toast for summary-block feedback. Follow-up nice-to-have.
- Fixing the pre-existing `{{CONVERSATION_HISTORY}}` placeholder bug in `askService.js:257`. Not introduced by this change.
- Fixing the pre-existing `RELEVANT_WINDOW_TYPES: ['settings', 'main']` dead-broadcast (header is `'header'`, not `'main'`). This spec uses a direct push (`mainHeader:askModeChanged`) to the header window instead.
- Removing the dead `profile: 'school'` field from `settingsService.js`.

---

## 13. Approval checklist (before implementation begins)

- [ ] User reviews §2 errata and confirms all corrections are acceptable.
- [ ] User reviews §9 prompt prose. Any prompt copy edits should land before code starts.
- [ ] User reviews §10 tradeoffs T1–T5 and accepts.
- [ ] User confirms blocking behavior for Summary actions (§7.4) is the desired UX.
- [ ] User confirms `'go'` is the right default for `preferredCodeLanguage`.
- [ ] User confirms a separate `mode-picker` window (vs. inline popover) is acceptable.

Once these are confirmed, I will:
1. Implement the changes in the order listed in §5.
2. Run through §11 test plan manually.
3. Report each test outcome.

---

## 14. Evidence trail

This spec was produced after:

- Reading the full design document at `docs/plans/2026-05-25-ask-mode-shortcuts-design.md`.
- Reading the brief at `prompts/code-debug-shortcuts.txt`.
- Reading every file the design touches: `promptTemplates.js`, `promptBuilder.js`, `askService.js`, `settingsService.js` (correct path), `MainHeader.js`, `SettingsView.js`, `featureBridge.js`, `preload.js`, `shortcutsService.js`, `summaryService.js`, `windowManager.js`.
- Grepping for every reference to `getSystemPrompt`, `profilePrompts`, `sendMessage`, `sendQuestionFromSummary`, `updateContentProtection`, `settingsService.`.
- Verifying commit `bc12688` for the Gemini model-ID pattern referenced in the design.
- Reading `SummaryView.js` lines 380–445 to confirm the regression risk (calls `sendQuestionFromSummary` on user-clicked action items).
- Confirming the header window is `353×47px` with `overflow: hidden` to invalidate the in-window popover assumption.
- Verifying `askService.js:303–338` is the multimodal retry path that inherits the system prompt.
- Verifying `summaryService.js:93` calls `getSystemPrompt('pickle_glass_analysis', '', false)` directly, bypassing askService.
- Verifying `shortcutsService.js:214` binds `Cmd+Enter` to `askService.toggleAskButton(true)`, which can call `sendMessage('', [])` when the Ask window is already visible with showTextInput.
- Verifying `promptBuilder.js:16` falls back to `profilePrompts.interview` (a real but very differently-shaped profile) for unknown profile names — motivating the defensive coerce in §8.1.
- Verifying no caller currently uses `settingsService.getSettings()` or `saveSettings()` externally; both are exported but only `updateContentProtection` invokes them internally.
- Verifying `maxTokens` is not passed when `askService.sendMessage` creates the streaming LLM, so provider defaults (≥8192) apply.

Every assertion in this spec is grounded in a file read, a grep result, or a logical deduction from the same. Where a deduction depended on assumptions, the assumption is stated explicitly in §10.

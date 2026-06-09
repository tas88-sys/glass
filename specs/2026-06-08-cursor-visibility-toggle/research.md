# Research: Preserve Cursor/Focus Across Visibility Toggle

**Spec**: `2026-06-08-cursor-visibility-toggle` · **Phase**: 0 · **Date**: 2026-06-08

## Production Log & Error Evidence (bugfix gate)

- `PREMISE L1: zero-results-with-cause`. No CW `display_id` present anywhere in the spec (grep for `\b\d{12}\b`, `submission #`, `display_id:`, `/transportation/` -> 0 matches). This is a local Electron focus/visibility lifecycle defect with no server-side telemetry — SigNoz/Sentry do not apply and no query was attempted. Root cause is established entirely by source trace below. `debug-cw` was invoked inline during `/plan` and independently confirmed the three-gap root cause.

## Source Verification (file:line read against current HEAD)

| Claim | File:line | Verified content |
|-------|-----------|------------------|
| Toggle accelerator is platform-conditional and identical in behavior | `shortcutsService.js:66` | `toggleVisibility: isMac ? 'Cmd+\\' : 'Ctrl+\\'` — single callback, FR-007 parity is structural. |
| Show branch only calls `win.show()` | `windowManager.js:258-262` | `lastVisibleWindows.forEach(name => { const win = windowPool.get(name); if (win && !win.isDestroyed()) win.show(); });` — no `focus()`/`moveTop()`. |
| Settings/mode-picker show DO reclaim focus | `windowManager.js:315-317`, `349-351` | `win.show(); win.moveTop(); win.setAlwaysOnTop(true);` |
| Hide branch excludes header from the loop, hides it explicitly last | `windowManager.js:248-253` | `lastVisibleWindows.forEach(... if (name === 'header') return; ... win.hide())` then `header.hide()`. On show, header is NOT excluded, so it re-shows in the same loop. |
| `focusTextInput()` uses rAF, focus only | `AskView.js:960-967` | `requestAnimationFrame(() => { const textInput = this.shadowRoot?.getElementById('textInput'); if (textInput) { textInput.focus(); } });` — no selection set. |
| Focus restore only on property change / IPC | `AskView.js:803-811`, `826-832`, `1341-1343` | `onShowTextInput`, `onAskStateUpdate` (when `wasHidden`), and `updated()` guarded on `changedProperties.has('showTextInput') && this.showTextInput`. None fire on bare OS re-show. |
| `isInputFocused` set on focus, never reset, not reactive, not initialized | `AskView.js:956-958`, `5-19`, `738-774` | `handleInputFocus() { this.isInputFocused = true; }`. Not in `static properties`. Not assigned in constructor. No `handleInputBlur`. |
| Input binds only `@focus` | `AskView.js:1425` | `@focus=${this.handleInputFocus}` — no `@blur`. |
| connectedCallback / disconnectedCallback exist with listener add/remove pattern | `AskView.js:776-836`, `838-867` | IPC + `keydown` listeners registered in connected, removed in disconnected — the slot for the new `visibilitychange` listener. |
| No DOM test harness | `package.json` + `node -e require.resolve` | `npm test` = `node --test src/**/__tests__/**/*.test.js`; no jsdom / happy-dom / @testing-library / Jest / Vitest / Playwright installed. |
| Pure-logic test convention | `src/ui/listen/summary/__tests__/liveAnswerHistory.test.js` | Header: "Pure logic, no Lit/DOM coupling"; uses `node:test` + `node:assert/strict`. |

## Root Cause (three compounding gaps)

1. **Main never re-focuses the window.** `changeAllWindowsVisibility()` show branch calls `win.show()` only. The OS does not return keyboard focus to a `BrowserWindow` on `show()` alone, so the `ask` renderer is not keyboard-eligible — DOM focus cannot stick even if the renderer tries.
2. **Renderer has no trigger on bare re-show.** `focusTextInput()` fires on a `showTextInput` value change or an explicit IPC message. After hide -> show, `showTextInput` is still `true` (no change), and no IPC is sent. There is no `visibilitychange` listener bridging the OS un-hide to a focus call.
3. **No caret persistence.** Even with focus restored, nothing saves/restores `selectionStart`/`selectionEnd`. `handleInputFocus()` only sets a boolean; there is no blur counterpart and no snapshot.

## Decisions

### D1 — Where the restore logic lives: Renderer self-restore (Option A)
- **Decision**: Renderer owns focus + caret restore. Main only makes the `ask` window OS-focus-eligible (`win.focus()` + `win.moveTop()`). No new IPC channel.
- **Rationale**: The renderer process survives the OS window hide (only the native window is hidden), and it already holds `isInputFocused` and the live caret range. Putting the decision where the state already lives keeps FR-004 (no-steal) local and avoids serializing transient focus state over IPC.
- **Alternatives rejected**:
  - *Option B — re-emit `ask:showTextInput` on show*: conflates "open the input" with "restore prior focus"; that handler always focuses, which breaks FR-004 (would steal focus when the user was reading a response).
  - *Option C — new `ask:restoreFocus` IPC channel + main-side focus tracking*: duplicates state the renderer already owns and adds a channel for no benefit; more surface, more failure modes.

### D2 — How "was the input focused before hide" is determined (FR-004 guard)
- **Decision**: Reuse `isInputFocused`, plus a continuously-tracked caret range. A `blur` that fires while `document.hidden === true` is **hide-induced** and PRESERVES the snapshot; a `blur` while `document.hidden === false` is a **genuine** blur and CLEARS it.
- **Rationale**: The OS hide induces a `blur` on the focused element. The only reliable signal that the blur is hide-induced (vs the user clicking away) is that the document is already hidden when the blur fires. This single distinction is the whole no-steal guard: no snapshot -> no restore -> no steal.
- **Edge**: the snapshot is also cleared after a successful restore so a later genuine show (input not focused) does not re-apply a stale caret.

### D3 — What triggers restore after show completes (FR-006 timing)
- **Decision**: Renderer `visibilitychange` -> `visible`, backed by main's `win.focus()`. The actual `.focus()` + selection-range set is deferred to `requestAnimationFrame`, reusing `focusTextInput()`'s existing rAF.
- **Rationale**: The show path has no animation/`onComplete` hook, so there is no main-side "show finished" callback to ride. `visibilitychange` is the event the browser fires when the document becomes visible again. Deferring to rAF lands the focus after show/layout completes (FR-006) and naturally coalesces a rapid double-toggle into a single restore (only the last frame's state applies).
- **FR-005**: `win.focus()` and `win.moveTop()` do not touch `setIgnoreMouseEvents`; click-through state is untouched. Deliberately NOT calling `setAlwaysOnTop(true)` — the settings path sets it because it clears it on hide; the toggle has no teardown, so persisting always-on-top would be a regression.

### D4 — Pure-helper extraction (testability)
- **Decision**: Extract the two decisions into DOM-free pure modules: `caretSnapshot.js` (build/clamp/restore-shape) and `focusRestoreDecision.js` (onBlur guard + shouldRestoreOnVisible).
- **Rationale**: Constitution Principle I requires test-first, but the repo has no DOM test harness. The only way to get real automated coverage of the FR-002 caret clamp and the FR-004 blur guard is to make them pure functions, exactly like `liveAnswerHistory.js`. The `AskView`/`windowManager` glue then just calls them.

## Open Questions
None. All three spec clarifications are resolved and re-verified against code; no NEEDS CLARIFICATION remain.

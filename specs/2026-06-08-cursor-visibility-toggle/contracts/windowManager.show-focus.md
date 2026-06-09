# Behavioral Contract: windowManager show-branch focus

**Target**: `src/window/windowManager.js` -> `changeAllWindowsVisibility(windowPool, targetVisibility)`, show branch (after the existing `lastVisibleWindows.forEach(... win.show())` loop at lines 258-262).

## Inputs
- `windowPool: Map<string, BrowserWindow>`
- `lastVisibleWindows: Set<string>` (module-level state set during the hide branch)

## Required behavior (added)
After all windows in `lastVisibleWindows` have been re-shown:

```
IF lastVisibleWindows.has('ask'):
    askWin = windowPool.get('ask')
    IF askWin AND NOT askWin.isDestroyed():
        askWin.focus()
        askWin.moveTop()
```

## MUST hold (gates)
- **FR-003**: When `ask` was in the visible set before hide, the `ask` window receives OS focus on re-show.
- **FR-004 (edge)**: When `ask` was NOT in `lastVisibleWindows`, NO focus call is made — the Ask input is neither opened nor focused.
- **FR-005**: The show branch MUST NOT call `setIgnoreMouseEvents(...)` and MUST NOT call `setAlwaysOnTop(true)`. Only `focus()` + `moveTop()` are added.
- **Crash-safe**: guarded by `isDestroyed()` (Failure Modes Registry — window destroyed between hide and show).

## Exports (preflight fix)
`changeAllWindowsVisibility` is exported from `src/window/windowManager.js` (`module.exports`) so the stub test can import it directly:
```
const { changeAllWindowsVisibility } = require('../windowManager');
```
`lastVisibleWindows` is module-level state and is intentionally NOT exported. The test seeds it by exercising the hide branch first (a real toggle: hide, then show), exactly as production does — no internal state is reached into.

## Test (main-process stub)
Stub `windowPool` (a `Map`) with mock windows exposing `isVisible()/isDestroyed()/show()/hide()/focus()/moveTop()/setIgnoreMouseEvents()/setAlwaysOnTop()` spies. Each case follows a hide-then-show sequence so `lastVisibleWindows` is populated through the public path:
1. Pool `{header, ask}`, both `isVisible()===true`. Call `changeAllWindowsVisibility(pool, false)` (hide branch populates `lastVisibleWindows={header,ask}`). Flip every window's `isVisible()` to return `false`, then call `changeAllWindowsVisibility(pool, true)` (show branch) -> assert `askWin.focus` and `askWin.moveTop` each called once; assert `setIgnoreMouseEvents` and `setAlwaysOnTop` NOT called on ANY window (folds in the FR-005 negative assertion).
2. Pool `{header}` only (no `ask`, or `ask.isVisible()===false` at hide) -> after the same hide-then-show sequence, assert NO `focus`/`moveTop` on a (non-restored) ask window.
3. `ask` window `isDestroyed() === true` at show time -> assert no throw and no `focus` call.

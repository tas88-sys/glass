# Quickstart: Preserve Cursor/Focus Across Visibility Toggle

**Spec**: `2026-06-08-cursor-visibility-toggle` · **Phase**: 1 · **Date**: 2026-06-08

## What this validates
The Ask text input keeps its focus and caret position across a `Cmd+\` / `Ctrl+\` hide -> show visibility toggle (FR-001, FR-002, FR-003), without stealing focus when the input was not focused (FR-004), without changing click-through (FR-005), and after the show completes (FR-006), on both macOS and Windows/Linux (FR-007).

## Automated checks

### Unit (pure helpers)
```bash
# All tests
npm test

# Just the new helpers
node --test src/ui/ask/__tests__/caretSnapshot.test.js
node --test src/ui/ask/__tests__/focusRestoreDecision.test.js
```
Expected: all assertions pass. These cover FR-002 (caret clamp/restore shape) and FR-004 (blur guard / shouldRestoreOnVisible) with no DOM — the project has no jsdom, so the logic is pure and headless.

### Contract type-check
```bash
./node_modules/.bin/tsc --noEmit --strict \
  specs/2026-06-08-cursor-visibility-toggle/contracts/caretSnapshot.d.ts \
  specs/2026-06-08-cursor-visibility-toggle/contracts/focusRestoreDecision.d.ts
```
Expected: exit 0 (Found 0 errors). [Verified during /plan with tsc 5.8.3.]

### Main-process stub test
```bash
node --test src/window/__tests__/changeAllWindowsVisibility.show-focus.test.js
```
Expected: asserts `askWin.focus()` + `askWin.moveTop()` are called when `ask` is in `lastVisibleWindows`; asserts NOT called otherwise; asserts `setIgnoreMouseEvents`/`setAlwaysOnTop` never called (FR-005).

## Manual verification (the on-screen behavior — no E2E harness exists)

Build + launch:
```bash
npm run build:renderer && electron .
# or: npm start
```

### Scenario 1 — caret at end (FR-001/FR-002/FR-006)
1. Click into the Ask input, type `hello world`.
2. Press the visibility shortcut (`Cmd+\` on macOS, `Ctrl+\` on Windows/Linux) to hide.
3. Press it again to show.
4. **Expect**: caret blinking at the end of `hello world`; typing `!` appends with no click.

### Scenario 2 — mid-text caret (FR-002)
1. Type `hello world`, then click/arrow the caret between `hello` and `world`.
2. Toggle off, toggle on.
3. **Expect**: caret returns to the same mid-text position; typing inserts there.

### Scenario 3 — no-steal when input not focused (FR-004)
1. Submit a question so a response is showing; click into the underlying app (or just do NOT focus the Ask input — read the response).
2. Toggle off, toggle on.
3. **Expect**: the Ask input is NOT forcibly focused; your prior focus/app is undisturbed.

### Scenario 4 — Ask not in visible set (Edge Case)
1. Ensure the Ask input was never opened this session (overlay header only).
2. Toggle off, toggle on.
3. **Expect**: re-show does not open or focus the Ask input.

### Scenario 5 — rapid double-toggle (Edge Case)
1. Focus the input with a caret mid-text.
2. Press the shortcut twice in quick succession (hide+show fast).
3. **Expect**: caret restored once, stable — no focus-then-immediately-lose flicker.

### Scenario 6 — click-through untouched (FR-005)
1. Enable click-through (`Cmd+M` / `Ctrl+M`).
2. Toggle visibility off and on.
3. **Expect**: click-through state is unchanged after re-show (the overlay does not start capturing mouse events).

### Scenario 7 — cross-platform (FR-007)
Repeat Scenario 1 on the other OS (macOS `Cmd+\` vs Windows/Linux `Ctrl+\`). Behavior identical.

## Record results
Paste the `npm test` output and a one-line observed result per manual scenario into the verify task. Per Constitution III, completion is claimed only with this evidence.

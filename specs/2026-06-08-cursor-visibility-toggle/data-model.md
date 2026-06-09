# Data Model: Preserve Cursor/Focus Across Visibility Toggle

**Spec**: `2026-06-08-cursor-visibility-toggle` · **Phase**: 1 · **Date**: 2026-06-08

No database, no persisted schema, no wire format. The only "entity" is a transient in-memory snapshot held on the `AskView` renderer instance. Two pure helpers operate on it.

## Entity: CaretSnapshot (transient, in-memory)

Held as `this._caretSnapshot` on the `AskView` Lit element. Never serialized, never persisted, never sent over IPC.

| Field | Type | Meaning |
|-------|------|---------|
| `start` | `number` | `selectionStart` of `#textInput` captured at hide-induced blur. |
| `end` | `number` | `selectionEnd` of `#textInput` captured at hide-induced blur. |

`this._caretSnapshot` is either a `CaretSnapshot` object (input was focused at hide) or `null` (no restore pending — the FR-004 no-steal signal). `isInputFocused` (existing instance flag) is the companion boolean; it is initialized to `false` in the constructor and set `true` in `handleInputFocus`.

### Lifecycle / state transitions

```
[no snapshot] --focus--> isInputFocused=true
[isInputFocused=true] --blur (document.hidden===true)--> snapshot = {start,end}   (hide-induced: PRESERVE)
[isInputFocused=true] --blur (document.hidden===false)--> snapshot = null, isInputFocused=false  (genuine: CLEAR)
[snapshot set]        --visibilitychange=visible--> focus + restore(value, snapshot) --> snapshot = null
[snapshot null]       --visibilitychange=visible--> NO-OP (FR-004 no steal)
```

## Pure Helper: caretSnapshot.js

Pure functions, no DOM/Electron import.

| Function | Signature | Behavior |
|----------|-----------|----------|
| `buildSnapshot(start, end)` | `(number, number) => {start:number,end:number}` | Returns a normalized snapshot. If either arg is not a finite number, returns `null`. |
| `clampRange(snapshot, valueLength)` | `({start,end}\|null, number) => {start:number,end:number}\|null` | Clamps `start`/`end` into `[0, valueLength]`. If `snapshot` is null, returns null. If after clamping both collapse past the end, returns `{start: valueLength, end: valueLength}` (caret-at-end fallback, FR-002 graceful). |

**Validation rules** (FR-002): `start` and `end` clamp independently to `[0, valueLength]`; `start` MUST NOT exceed `end` after clamp (swap if inverted). Out-of-bounds -> caret at end, never throw.

## Pure Helper: focusRestoreDecision.js

Pure functions, no DOM/Electron import. Encodes the FR-004 guard (D2) and the show-eligibility (D3).

| Function | Signature | Behavior |
|----------|-----------|----------|
| `onBlur(documentHidden, isInputFocused, currentSnapshotFactory)` | `(boolean, boolean, () => {start,end}) => { snapshot: {start,end}\|null, isInputFocused: boolean }` | If `documentHidden===true` AND `isInputFocused`: PRESERVE — returns `{snapshot: currentSnapshotFactory(), isInputFocused: true}`. Else (genuine blur): CLEAR — returns `{snapshot: null, isInputFocused: false}`. |
| `shouldRestoreOnVisible(snapshot)` | `({start,end}\|null) => boolean` | `true` iff `snapshot` is non-null. The single FR-004 gate: no snapshot -> no restore -> no steal. |

`currentSnapshotFactory` is a thin closure the caller passes (reads `#textInput.selectionStart/End` at blur time) so the pure module never touches the DOM directly — it stays unit-testable by passing a stub factory.

## Main-process behavior (not an entity — documented for completeness)

`windowManager.changeAllWindowsVisibility` show branch, after the existing `lastVisibleWindows.forEach` show loop:
- IF `lastVisibleWindows.has('ask')` AND the `ask` window exists AND `!isDestroyed()`: call `askWin.focus()` then `askWin.moveTop()`.
- MUST NOT call `setAlwaysOnTop(true)`. MUST NOT call `setIgnoreMouseEvents(...)`. (FR-005.)
- IF `ask` was not in `lastVisibleWindows`: do nothing (Edge Case — never open/focus an input that wasn't visible).

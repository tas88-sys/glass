---
# Context Optimization Metadata
# Purpose: Enable efficient partial reads (~200 tokens vs ~2500 for full file)
meta:
  spec_id: 2026-06-08-cursor-visibility-toggle
  spec_name: cursor-visibility-toggle
  status: in-progress    # draft | in-progress | approved | completed
  phase: plan            # specify | clarify | plan | tasks | preflight | feature-start | implement | verify
  created: 2026-06-08    # ISO date
  updated: 2026-06-09    # ISO date

# Quick Reference (for checkpoint resume)
summary:
  goals:
    - {id: G1, description: "Preserve the Ask text-input caret/focus across a Cmd/Ctrl+\\ hide→show visibility toggle so typing resumes without a manual click", priority: HIGH}
    - {id: G2, description: "Restore focus to the previously-focused window on re-show, not just the input element", priority: MEDIUM}
  constraints:
    - {id: C1, description: "Global toggle hides/shows OS-level BrowserWindows via win.hide()/win.show(); no DOM focus survives an OS window hide", type: TECHNICAL}
    - {id: C2, description: "Windows are click-through/overlay windows; focus restoration must not steal focus from the user's underlying app when nothing was focused before hide", type: TECHNICAL}
    - {id: C3, description: "Caret POSITION within the input (selection start/end) should be preserved, not just focus", type: BEHAVIORAL}
  decisions:
    - {id: D1, question: "Where the focus + caret restore logic lives (renderer vs main)", answer: "Renderer self-restore (Option A). Main calls win.focus()/win.moveTop() on the re-shown ask window; AskView re-applies focus + saved caret on visibilitychange→visible. No new IPC channel; decision logic lives where the focus/caret state already exists."}
    - {id: D2, question: "How 'was the input focused before hide' is determined (FR-004 no-steal guard)", answer: "Reuse the renderer's existing isInputFocused flag (AskView.js:957) plus a continuously-tracked caret range. A blur coinciding with document.hidden===true is treated as hide-induced and PRESERVES the snapshot; a genuine blur before hide clears it. That distinction is FR-004's guard."}
    - {id: D3, question: "What triggers restore after the window show completes (FR-006 timing)", answer: "Renderer visibilitychange→visible, backed by main calling win.focus()+win.moveTop() in the changeAllWindowsVisibility show branch (windowManager.js:258-262). The actual .focus()+selection restore is deferred to requestAnimationFrame, matching the existing focusTextInput() pattern (AskView.js:961), so it lands after show/layout completes."}

# CRITICAL REQUIREMENTS - Must verify during implementation
# These survive context compaction and generate T-VERIFY tasks
critical_requirements:
  type: bugfix
  portal: app
  ui_changes: minor
---

# Feature Specification: Preserve Cursor/Focus Across Visibility Toggle

**Feature Branch**: `2026-06-08-cursor-visibility-toggle`
**Created**: 2026-06-08
**Status**: Draft
**Input**: User description: "The insertion point/cursor looses its reference and vanishes when visibility toggle is enabled and disabled again with the keyboard shortcut. Is there a way to prevent it from happening and always keep the cursor working where it was, just waiting for the next typing?"

---

## ⚡ Quick Guidelines
- ✅ Focus on WHAT users need and WHY
- ❌ Avoid HOW to implement (no tech stack, APIs, code structure)
- 👥 Written for business stakeholders, not developers

---

## System Context

**Systems**: Glass (Electron desktop overlay app) — framework-internal, no CW backend system involved.
**Databases**: N/A
**Integrations**: None — internal renderer/main-process change.
**Key Architecture**: The global visibility shortcut (`Cmd+\` on macOS, `Ctrl+\` on Windows/Linux) is registered in `src/features/shortcuts/shortcutsService.js` and calls `toggleAllWindowsVisibility()`. That emits `window:requestToggleAllWindowsVisibility`, which `src/window/windowManager.js` handles in `changeAllWindowsVisibility()` by calling `win.hide()` on every visible window (including the `ask` window that hosts the text input) and `win.show()` on the next toggle. The text input and its focus logic live in the `ask` renderer (`src/ui/ask/AskView.js`, element `#textInput`, helper `focusTextInput()`). Re-showing an Electron `BrowserWindow` does not restore DOM focus to the element that was focused before `hide()`, and nothing in the show path re-invokes `focusTextInput()` — so the caret is gone after the toggle.
**Documentation**: cw-documentation unavailable at `~/coverwhale/cw-documentation/`. System Context derived directly from the Glass repository source.

---

## Bug Evidence *(mandatory — `critical_requirements.type: bugfix`)*

**Reported Behavior**:
| Field | Value |
|-------|-------|
| Source | User report (this `/specify` invocation) |
| Reported by | thiago.soeiro (developer/user) |
| First observed | Reported 2026-06-08 |
| Last observed | Ongoing |
| Reproduction | Reliably reproduces |
| Display ID(s) | None — UI/focus bug, no CW submission display_id present in input (production SigNoz/log-search not applicable) |

**Production Evidence** (code-traced — this is a renderer/main-process focus bug with no server-side telemetry):
| Source | Reference | Findings |
|--------|-----------|----------|
| Source trace — shortcut | `src/features/shortcuts/shortcutsService.js:66` (`toggleVisibility` default `Cmd+\`/`Ctrl+\`), `:123` `toggleAllWindowsVisibility()`, `:165/:198/:211` register the callback | The shortcut emits `window:requestToggleAllWindowsVisibility` with a flipped `targetVisibility`. No focus/caret state is captured before the toggle. |
| Source trace — window hide/show | `src/window/windowManager.js:121` listener → `:230` `changeAllWindowsVisibility()` | On hide: `win.hide()` is called for every visible window incl. `header` (`:251`, `:253`). On re-show: `win.show()` for each window in `lastVisibleWindows` (`:258-262`). There is **no** `win.focus()`, `webContents.focus()`, or signal back to the renderer to re-focus the input after show. |
| Source trace — renderer focus | `src/ui/ask/AskView.js:960` `focusTextInput()`, called only from `onShowTextInput` (`:803-811`), `onAskStateUpdate` (`:826-830`), and the `showTextInput` property change in `updated()` (`:1341-1342`) | `focusTextInput()` calls `textInput.focus()` but is never triggered by an OS-level window re-show. After `hide()`→`show()`, the renderer keeps `showTextInput === true` (no property change), so `updated()` does not re-fire and focus is never restored. Caret selection position is also not saved or restored. |

**Outcome premise** (mandatory):
- `PREMISE B1: zero-results-with-cause` — No production logs exist because this is a local Electron focus-lifecycle defect, not a server error. Root cause is established by the source trace above: the hide→show window cycle drops DOM focus and the show path never re-invokes `focusTextInput()` nor restores caret position.

**Expected vs. Actual**:
- **Expected**: After pressing the visibility shortcut to hide all windows and pressing it again to show them, the Ask text input is focused exactly where it was, caret in place, ready for the next keystroke with no extra click.
- **Actual**: After the show toggle, the text input has lost focus (the caret/insertion point has vanished). The user must click into the field again before typing.
- **Gap**: Window re-show restores window visibility but not DOM focus or caret position; no code path re-focuses the input on re-show.

**⚠️ GATE**: Bug Evidence contains pasted source-trace evidence and an explicit zero-results-with-cause premise — gate satisfied.

---

## Clarifications

### Session 2026-06-08

The user delegated all three architecture questions ("I have no idea. Choose the best option."); resolved from the codebase as follows.

- **Q: Where should the focus + caret restore logic primarily live — renderer-driven, main-emits-existing-channel, or a new IPC channel?**
  **A: Renderer self-restore (Option A).** The `ask` renderer survives the hide/show cycle (only the OS-level `BrowserWindow` hides), and it already holds the two facts this bug needs — `isInputFocused` (`AskView.js:957`) and the caret position. Main's responsibility shrinks to calling `win.focus()` + `win.moveTop()` on the re-shown `ask` window so it is eligible for OS keyboard focus; the renderer re-applies focus and the saved caret on `visibilitychange`→visible. **No new IPC channel** is added, and the no-steal decision (FR-004) lives where the state already is.
  *Rejected:* Option B (re-emit `ask:showTextInput`) conflates "open the input" semantics with "restore prior focus" and always focuses, making FR-004 harder to honor. Option C (new `ask:restoreFocus` channel + main-side focus tracking) duplicates state the renderer already owns.

- **Q: How is "was the input focused before hide" determined for the FR-004 no-steal guard?**
  **A: Renderer-side, reusing the existing `isInputFocused` flag** (`AskView.js:957`) plus a continuously-tracked last caret range (selection start/end). The hide induces a `blur`; the rule is: **a `blur` that coincides with `document.hidden === true` is hide-induced and PRESERVES the snapshot, while a genuine blur before hide CLEARS it.** That single distinction is FR-004's guard — if the user was reading a response (input not focused) when they toggled, there is no snapshot to restore and focus is not stolen.

- **Q: What triggers the restore after the window's show completes (FR-006 timing), given the show path has no animation/`onComplete` today?**
  **A: The renderer's `visibilitychange`→visible event, backed by main calling `win.focus()` + `win.moveTop()`** in the `changeAllWindowsVisibility` show branch (`windowManager.js:258-262`, matching the existing settings/mode-picker show paths at `:315-316` and `:349-350`). The actual `.focus()` + selection-range restore is deferred to `requestAnimationFrame`, reusing the pattern `focusTextInput()` already uses (`AskView.js:961`), so it runs after show/layout completes. `win.focus()` does not alter `setIgnoreMouseEvents`, so click-through state is untouched (FR-005); the rAF coalescing also covers the rapid-double-toggle edge case.

---

## User Scenarios & Testing *(mandatory)*

### Primary User Story
A user is typing a question in the Glass Ask input. They press the visibility shortcut (`Cmd+\` / `Ctrl+\`) to hide the overlay (e.g., to glance at something underneath), then press it again to bring the overlay back. The cursor is still blinking in the text input exactly where they left it, and their next keystroke lands in the field — no click required.

### Acceptance Scenarios
1. **Given** the Ask input is visible and focused with the caret at the end of typed text, **When** the user presses the visibility shortcut to hide all windows and then presses it again to show them, **Then** the Ask input is focused and the caret is restored to its prior position, and the next typed character appears in the input without a click.
2. **Given** the Ask input is visible and focused with a mid-text caret position (e.g., between two words), **When** the user toggles visibility off and on, **Then** the caret returns to that same mid-text position.
3. **Given** the overlay is hidden via the toggle while the Ask input was the focused element, **When** the user toggles it back on, **Then** the `ask` window (and its parent header as needed) regains OS-level window focus so the renderer can hold the caret.

### Edge Cases
- **No input was focused before hide** (e.g., user was reading a response, not typing): on re-show, the system MUST NOT forcibly steal focus into the input in a way that disrupts the user — restore the prior focus state only.
- **Ask window was not in the visible set** before hide (input never open): re-show MUST NOT open or focus the Ask input.
- **Rapid double-toggle** (hide and show in quick succession): focus restoration must not race the window animation/show and end up focusing then immediately losing focus.
- **Toggle while a response is streaming**: caret/focus restoration applies to the input field; streaming UI state is unaffected.
- **Click-through / mouse-events-ignored mode active**: restoring focus must not re-enable mouse capture or change click-through state.

## Requirements *(mandatory)*

### Functional Requirements
- **FR-001**: The system MUST restore keyboard focus to the Ask text input (`#textInput`) after a hide→show visibility toggle, whenever that input was the focused element at the time of hide.
- **FR-002**: The system MUST restore the caret/insertion-point position (selection start and end) within the input to where it was before the toggle, not merely place the caret at the start or end.
- **FR-003**: On re-show, the system MUST restore OS-level window focus to the window that was focused before hide (e.g., the `ask` window/header), so the renderer is eligible to hold DOM focus.
- **FR-004**: The system MUST NOT steal focus into the Ask input on re-show when the input was not the previously-focused element (preserve prior focus state; do not disrupt the user's underlying application).
- **FR-005**: The system MUST NOT alter click-through (`toggleClickThrough` / ignore-mouse-events) state as a side effect of focus restoration.
- **FR-006**: Focus and caret restoration MUST occur after the window's show/animation completes, so the restored focus is not lost to a late layout or show event.
- **FR-007**: The behavior MUST apply consistently across macOS (`Cmd+\`) and Windows/Linux (`Ctrl+\`).

### Key Entities *(include if feature involves data)*
- **Focus snapshot**: Transient state captured at hide time — which window held focus, whether the Ask input was focused, and the caret selection range (start, end). Restored at show time. Not persisted to disk.

### Test Strategy *(mandatory)*

**Test Type Classification**:
| FR | Primary Test Type | Reason |
|----|-------------------|--------|
| FR-001 | Integration (renderer) | Verifies the input regains focus after a simulated hide/show cycle. |
| FR-002 | Unit (renderer) | Save/restore of selection range is pure DOM logic, testable in isolation. |
| FR-003 | Integration (main) | Window focus on re-show is main-process behavior over the window pool. |
| FR-004 | Integration (renderer) | Verifies no focus steal when input was not previously focused. |
| FR-005 | Unit (main) | Asserts click-through state is untouched by the show path. |
| FR-006 | Integration | Timing — focus applied after show/animation completes. |
| FR-007 | Unit | Platform-conditional accelerator already covered; assert callback parity. |

**This Feature**:
- Feature type: [x] Frontend-heavy (Electron renderer + window/main glue)
- Unit: ~45% | Integration: ~45% | Contract: ~0% | E2E: ~5% | Static: ~5%
- Justification: Bug is a focus/caret lifecycle issue across renderer and main process; integration tests over the hide/show cycle carry the most signal. No backend, no quota-limited APIs.

**HIGH-RISK API Warning**:
- [ ] Feature calls a quota-limited external API — N/A. No external API involved.

**Estimated Test Count**: ~6-8 tests across 7 functional requirements.

### Error Handling & Recovery *(mandatory if feature can fail)*

**Error Scenarios**:
| Error Scenario | Type | User Message | Recovery Action |
|----------------|------|--------------|-----------------|
| Ask window destroyed between hide and show | Transient | None (silent) | Guard with `isDestroyed()`; skip focus restoration, no crash |
| `#textInput` not present in shadow DOM at restore time | Transient | None (silent) | No-op; existing `focusTextInput()` already null-checks the element |
| Stored caret range invalid after text changed | Permanent | None (silent) | Clamp range to current input length, or fall back to placing caret at end |

**Failure Modes Registry**:
| Codepath | Failure Mode | Rescued? | Test? | User Sees? | Logged? |
|----------|-------------|----------|-------|------------|---------|
| Window show → focus restore | Window destroyed | Y (isDestroyed guard) | Y | Nothing (silent) | Optional debug log |
| Renderer caret restore | Element missing | Y (null check) | Y | Nothing (silent) | N |
| Renderer caret restore | Range out of bounds | Y (clamp) | Y | Caret at end (graceful) | N |

**Resumability**:
- [x] Idempotency guaranteed — restoring focus to an already-focused input is a no-op.

### UI/Design Reference *(mandatory)*

**Feature Classification**:
- [x] **Minor UI** (< 3 components, existing patterns only) → Design reference optional. No new components; restores focus/caret behavior on an existing input.

**Design Reference**:
- Figma/Mockup Source: Not applicable — behavioral bugfix, no visual change.
- Design Component Name(s): existing `AskView` `#textInput`.
- Mockup covers ALL functional requirements above: [x] Yes (no visual surface changes).

### Permissions & Access Control *(mandatory)*

**Portal Placement**:
- [x] **Application Portal** — the Glass overlay app (single-user desktop client). No web portal / role model applies.

**Rationale for placement**: Glass is a local single-user Electron app; there is no multi-tenant portal or role-based access. The change affects only the local user's overlay windows.

**User Roles Affected**: N/A — single local user.

**Access Requirements**: N/A — no server-enforced permissions; behavior is client-local.

**Data Scoping**: N/A — no persisted or shared data; the focus snapshot is in-memory and per-session.

---

## Review Checklist (Gate)

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable
- [x] Test strategy defined
- [x] Portal placement selected (app — single-user desktop)
- [ ] Permissions defined (N/A — single-user local app)
- [ ] Data sensitivity classified (N/A — no data handled)
- [ ] External APIs identified (N/A — none)
- [x] Error handling defined
- [x] UI complexity classified (minor)
- [ ] Deprecation decision made (N/A — nothing replaced)
- [x] Bug evidence captured with pasted source-trace references and zero-results-with-cause premise

---

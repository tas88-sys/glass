---
# Context Optimization Metadata
meta:
  spec_id: 2026-10-15-multi-monitor-step-move
  spec_name: multi-monitor-step-move
  status: draft          # draft | in-progress | approved | completed
  phase: plan            # specify | clarify | plan | tasks | preflight | feature-start | implement | verify
  created: 2026-10-15
  updated: 2026-10-15

summary:
  goals:
    - {id: G1, description: "Ctrl+arrow moves the header to a neighboring monitor and back, in all four directions, whatever side the other monitor is on", priority: HIGH}
    - {id: G2, description: "A step never jumps further than one step, except the deliberate cross from one monitor's edge to the next one's edge", priority: MEDIUM}
    - {id: G3, description: "Dragging the header with the mouse keeps working and loses its dead zone at the border between monitors", priority: MEDIUM}
    - {id: G4, description: "One monitor: behavior unchanged (the header stops at the work area's edges)", priority: HIGH}
  constraints:
    - {id: C1, description: "The header never straddles two monitors at rest. On Windows, a window across two monitors with different scale factors (here 125% and 100%) can be resized by Electron", type: TECHNICAL}
    - {id: C2, description: "No new dependency. Changes stay in windowLayoutManager.js; windowManager.js and the shortcut registration are not edited", type: TECHNICAL}
    - {id: C3, description: "Tests run under npm test with electron's screen mocked (the Module._load pattern of the provider tests)", type: TECHNICAL}
    - {id: C4, description: "macOS must not break: Cmd+arrow uses the same code", type: TECHNICAL}
  decisions:
    - {id: D1, decision: "The display a position belongs to is the one with the largest overlap with the header's rectangle at that position (the display nearest its center when none overlaps), not the one nearest its top-left corner", rationale: "Choosing by the top-left corner is the bug: the corner reaches a monitor on the left or above at once, but never one on the right or below, because the header is clamped inside the current monitor first"}
    - {id: D2, decision: "A step that the clamp would cancel (the header is already flush with the edge in that direction) crosses to the adjacent display in that direction, if there is one, and lands flush with that display's near edge", rationale: "Without it the overlap rule would hold the header on its monitor forever, since one 80 px step never puts most of the header on the other side"}
    - {id: D3, decision: "When crossing, the coordinate across the movement is kept and clamped to the new work area (moving right keeps y), not scaled proportionally", rationale: "A step move should not make the header jump vertically. Ctrl+Shift+1/2 (move to display) keeps the proportional mapping it has today"}
    - {id: D4, decision: "Adjacency uses display bounds with a few px of tolerance; the neighbor must overlap the current display along the other axis; the nearest one wins", rationale: "Work areas leave gaps at the taskbar, and Electron's DIP layout on Windows with mixed scale factors may leave small gaps or overlaps between bounds"}
    - {id: D5, decision: "Ctrl+Shift+Left/Right (snap to edge) is not changed", rationale: "Snapping inside the current monitor is what it promises; crossing is what Ctrl+arrow and Ctrl+Shift+N are for"}
---

# Multi-monitor step move

## Problem

The owner uses two monitors: the secondary one is on the **left** of the primary one (Windows:
`DISPLAY1` at X = −1920 physical, 125% scale; `DISPLAY2` primary, 1920×1080, 100%). Ctrl+Left moves
the Glass header onto the left monitor, but Ctrl+Right then stops at that monitor's right edge and
never brings it back.

Cause: `calculateStepMovePosition` (`src/window/windowLayoutManager.js:283`) adds 80 px and calls
`calculateClampedPosition` (`:151`), which picks the target display with
`screen.getDisplayNearestPoint` on the **top-left corner** of the new position and clamps the header
inside that display's work area.

- Moving left, the corner enters the left monitor as soon as `x < 0`, so the header crosses (and
  jumps: from x = 60 the next step lands at −400, a 460 px move).
- Moving right, the header is clamped to `x ≤ right edge − width`. One more step puts the corner at
  `right edge − width + 80`, still inside the same monitor, so the clamp returns the same position.
  The header is stuck.

The same holds for up/down with stacked monitors, and with a monitor on the right the header could
never cross at all. Mouse drag goes through the same function: it crosses, but the header stops
following the cursor for one header width at the border.

Reproduced on 2026-10-15 by loading the real `windowLayoutManager.js` with electron's `screen` mocked
to the owner's layout (header 400 px wide):

```
left   620 540 460 380 300 220 140 60 -400 -480 ... -1520 -1536 -1536
right  -1456 -1376 ... -496 -416 -400 -400 -400 -400 ...
```

The bug is in upstream Glass code (pickle-com/glass), not in a change of this fork.

## Functional requirements

- **FR-001 Overlap picks the display.** `calculateClampedPosition` picks the display with the
  largest overlap with the header's rectangle at the requested position (D1), then clamps to that
  display's work area as today.
- **FR-002 Crossing at the edge.** `calculateStepMovePosition`: if the clamped result equals the
  current position along the movement axis (the header is flush with that edge), look for the
  adjacent display in that direction (D4). If one exists, place the header flush with its near
  edge (moving right: `x = neighbor.workArea.x`; left: `x = neighbor.workArea.x + width − header
  width`; same for y), keep the other coordinate clamped to the neighbor's work area (D3). If none
  exists, return the current position (one monitor: unchanged, G4).
- **FR-003 Child windows follow.** No code change expected: `window:moveStep` already lays out
  Ask/Listen from the future header bounds, and `calculateFeatureWindowLayout` picks the display by
  the header's center. Checked by hand (V4).

## Plan

| # | Task | Files |
|---|---|---|
| T1 | Print `screen.getAllDisplays()` (bounds, workArea, scaleFactor) from the running app on the owner's machine, and record it here. The tests use those real DIP values, not the guess from the Windows API | `GLASS_LAYOUT_DEBUG` log or a one-off devtools call; this spec |
| T2 | Failing tests first: mock `screen` with the owner's layout plus a right-side and a stacked layout; assert round trips (left × N then right × N returns to the primary monitor, and the mirror), no step longer than 80 px except a cross, one monitor unchanged, drag across the border with no dead zone | `src/window/__tests__/windowLayoutManager.test.js` (new) |
| T3 | `displayForRect(rect)` helper (largest overlap, else nearest to center) and `adjacentDisplay(display, direction)` helper (D4) | `src/window/windowLayoutManager.js` |
| T4 | `calculateClampedPosition` uses `displayForRect` (FR-001) | same |
| T5 | `calculateStepMovePosition` crosses at the edge (FR-002) | same |
| T6 | `npm test`, then the manual checks below on the two monitors | — |
| T7 | CHANGELOG line; this spec's Verification table and status | `CHANGELOG.md`, this spec |

Estimated size: ~40 lines in `windowLayoutManager.js`, ~150 lines of tests.

## Risks

- **Mixed scale factors (125% / 100%).** Moving a window between monitors with different DPI can
  make Electron on Windows change its size or leave it blurry for a frame. C1 keeps the header
  from resting across the border, but the animation (`smoothMovementManager`) passes through
  intermediate positions. If V2 shows a resize, a follow-up sets the position without animation
  when crossing; it is not in this plan's scope until seen.
- **DIP gaps between displays.** If T1 shows the two displays' DIP bounds do not touch, D4's
  tolerance must cover the gap; T2 includes that case.

## Verification

| Check | Result |
|---|---|
| V1 `npm test` (new tests fail before T4–T5, pass after; nothing else changes) | |
| V2 Owner's PC: Ctrl+Left to the left monitor, keep going to its far edge, then Ctrl+Right all the way back to the primary monitor's right edge; header size unchanged | |
| V3 Drag the header across the border both ways: it follows the cursor | |
| V4 With Listen and Ask open, cross both ways: the panels follow the header onto the same monitor | |
| V5 One monitor (unplug or disable the second): arrows stop at the edges as before; Ctrl+Shift+1/2 still work with two | |

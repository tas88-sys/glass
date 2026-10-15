---
# Context Optimization Metadata
meta:
  spec_id: 2026-10-15-multi-monitor-step-move
  spec_name: multi-monitor-step-move
  status: completed      # draft | in-progress | approved | completed
  phase: done            # specify | clarify | plan | tasks | preflight | feature-start | implement | verify
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
    - {id: C2, description: "No new dependency. Changes stay in src/window/; the shortcut registration is not edited. (First written as windowLayoutManager.js only; D7 needed smoothMovementManager.js and three call sites in windowManager.js)", type: TECHNICAL}
    - {id: C3, description: "Tests run under npm test with electron's screen mocked (the Module._load pattern of the provider tests)", type: TECHNICAL}
    - {id: C4, description: "macOS must not break: Cmd+arrow uses the same code", type: TECHNICAL}
  decisions:
    - {id: D1, decision: "The display a position belongs to is the one nearest the header's center at that position (screen.getDisplayNearestPoint), not the one nearest its top-left corner", rationale: "Choosing by the top-left corner is the bug: the corner reaches a monitor on the left at once, but never one on the right, because the header is clamped inside the current monitor first. Largest overlap was the first choice, changed in T1: the owner's left monitor starts 216 px lower in DIP, so a header near the top overlaps it nowhere and a drag would not cross until the header had fully left the primary monitor"}
    - {id: D2, decision: "A step that the clamp would cancel (the header is already flush with the edge in that direction) crosses to the adjacent display in that direction, if there is one, and lands flush with that display's near edge", rationale: "Without it the overlap rule would hold the header on its monitor forever, since one 80 px step never puts most of the header on the other side"}
    - {id: D3, decision: "When crossing, the coordinate across the movement is kept and clamped to the new work area (moving right keeps y), not scaled proportionally", rationale: "A step move should not make the header jump vertically. Ctrl+Shift+1/2 (move to display) keeps the proportional mapping it has today"}
    - {id: D4, decision: "Adjacency uses display bounds with a few px of tolerance; the neighbor must overlap the current display along the other axis; the nearest one wins", rationale: "Work areas leave gaps at the taskbar, and Electron's DIP layout on Windows with mixed scale factors may leave small gaps or overlaps between bounds"}
    - {id: D6, decision: "A step starts from the previous step's target while the header is still on its way to it (within 350 ms, and the header inside the box from that step's start to its target); otherwise from the header's real bounds. The state lives in WindowLayoutManager, so windowManager.js stays untouched", rationale: "Found by the owner on 2026-10-15: holding the keys never crossed. A held key repeats every ~30 ms while a step animates for 300 ms, so the header's bounds are always mid-flight, never flush with the edge, and every step restarted the animation from there. Near the edge each restart moved less than a pixel and the header stopped 1-2 px short; only the last animation, after the key was released, landed it on the edge"}
    - {id: D7, decision: "SmoothMovementManager keeps each window's intended size (DIP). A size changes only through animateWindowBounds (header resize, panel height); a move (step, layout, drag via its setPosition) always sends that size, never the window's current bounds", rationale: "Found by the owner on 2026-10-15 once crossings worked: the header got smaller at every crossing until its buttons were gone. Measured in Electron on the owner's monitors: in the frame a window crosses between 125% and 100%, Windows rescales it for a moment (e.g. 493×48 then 394×35), and on the 125% monitor a 393×47 request comes back 394×48. Every move started from getBounds(), so a key repeat or a mouse move landing on that frame made the wrong size the new one: 47 px high became 35, 23, 11 after three round trips, by key or by drag. Upstream behavior; it showed only once crossings worked"}
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

With a monitor on the right the header could never cross at all. Up/down happen to work today
because the header (47 px) is shorter than a step (80 px), so its top-left corner clears the edge.
With the owner's real layout (T1) the header near the top of the primary monitor could not even
cross to the left: the left monitor starts 216 px lower, so the corner's nearest display stayed the
primary one. Mouse drag goes through the same function: it crosses, but the header stops
following the cursor for one header width at the border.

A second defect showed up with the first fix, when the owner held the keys down: the header did not
cross (D6). Reproduced with the real `SmoothMovementManager` on a fake clock and a key repeat every
33 ms: holding left from x = 700 stopped at x = 0, flush with the edge only after the animation of
the last repeat landed.

Reproduced on 2026-10-15 by loading the real `windowLayoutManager.js` with electron's `screen` mocked
to the owner's layout (header 400 px wide):

```
left   620 540 460 380 300 220 140 60 -400 -480 ... -1520 -1536 -1536
right  -1456 -1376 ... -496 -416 -400 -400 -400 -400 ...
```

The bug is in upstream Glass code (pickle-com/glass), not in a change of this fork.

## Displays as Electron sees them (T1, 2026-10-15)

| Display | Primary | bounds (DIP) | workArea (DIP) | scale |
|---|---|---|---|---|
| 2779098405 | yes | 0, 0, 1920×1080 | 0, 0, 1920×1032 | 1 |
| 2528732444 | no | −1536, 216, 1536×864 | −1536, 216, 1536×816 | 1.25 |

The bounds touch (no DIP gap). The left monitor is bottom-aligned with the primary one.

## Functional requirements

- **FR-001 Center picks the display.** `calculateClampedPosition` picks the display nearest the
  header's center at the requested position (D1), then clamps to that display's work area as today.
- **FR-002 Crossing at the edge.** `calculateStepMovePosition`: if the clamped result equals the
  current position along the movement axis (the header is flush with that edge), look for the
  adjacent display in that direction (D4). If one exists, place the header flush with its near
  edge (moving right: `x = neighbor.workArea.x`; left: `x = neighbor.workArea.x + width − header
  width`; same for y), keep the other coordinate clamped to the neighbor's work area (D3). If none
  exists, return the current position (one monitor: unchanged, G4).
- **FR-003 Held keys.** While the header is on its way to the previous step's target (D6), the next
  step starts from that target: ten repeats move ten steps, and a held key reaches the edge, crosses
  and keeps going. Moves made by other means (drag, snap, move to display) are not mixed in: the
  stored target is ignored once the header is outside its path or 350 ms passed.
- **FR-005 Size kept across monitors.** After any number of crossings, by key or by drag, the
  header and the panels have the size last asked for (header 393×47 in the main state; on the 125%
  monitor Windows shows it as 394×48, which does not add up). A header resize or a panel height
  change still applies (D7).
- **FR-004 Child windows follow.** No code change expected: `window:moveStep` already lays out
  Ask/Listen from the future header bounds, and `calculateFeatureWindowLayout` picks the display by
  the header's center. Checked by hand (V4).

## Plan

| # | Task | Files |
|---|---|---|
| T1 | Print `screen.getAllDisplays()` (bounds, workArea, scaleFactor) from the running app on the owner's machine, and record it here. The tests use those real DIP values, not the guess from the Windows API | `GLASS_LAYOUT_DEBUG` log or a one-off devtools call; this spec |
| T2 | Failing tests first: mock `screen` with the owner's layout plus a right-side and a stacked layout; assert round trips (left × N then right × N returns to the primary monitor, and the mirror), no step longer than 80 px except a cross, one monitor unchanged, drag across the border with no dead zone | `src/window/__tests__/windowLayoutManager.test.js` (new) |
| T3 | `adjacentDisplay(display, direction)` helper (D4); D1 needs no helper | `src/window/windowLayoutManager.js` |
| T4 | `calculateClampedPosition` picks the display by the header's center (FR-001) | same |
| T5 | `calculateStepMovePosition` crosses at the edge (FR-002) | same |
| T6 | `npm test`, then the manual checks below on the two monitors | — |
| T7 | CHANGELOG line; this spec's Verification table and status | `CHANGELOG.md`, this spec |

Estimated size: ~40 lines in `windowLayoutManager.js`, ~150 lines of tests.

## Risks

- **Mixed scale factors (125% / 100%).** It happened (D7): the header shrank at every crossing.
  Fixed by keeping intended sizes; the rescale itself still shows for one frame mid-crossing.
- **DIP gaps between displays.** If T1 shows the two displays' DIP bounds do not touch, D4's
  tolerance must cover the gap; T2 includes that case.

## Verification

| Check | Result |
|---|---|
| V1 `npm test` (new tests fail before T4–T5, pass after; nothing else changes) | Done 2026-10-15: 10 new tests, 5 failed before the fix (round trip on the owner's layout, the two single crossings, monitor on the right, drag); 1511 pass, 0 fail after |
| V1b Held key (real animation, fake clock, repeat every 33 ms): 4 more tests, 3 fail without D6 | Done 2026-10-15: 1515 pass, 0 fail |
| V1c Size across monitors (fake window with the measured rescale): 5 tests, all fail without D7 | Done 2026-10-15: 1520 pass, 0 fail |
| V2 Owner's PC: Ctrl+Left to the left monitor, keep going to its far edge, then Ctrl+Right all the way back to the primary monitor's right edge; header size unchanged | Owner, 2026-10-15: tested the app on both monitors, works |
| V2b Same as V2, holding the keys down instead of tapping | Owner, 2026-10-15: tested the app on both monitors, works |
| V2c Hold the keys for three round trips: the header keeps its size | Measured 2026-10-15 in Electron on the owner's monitors (scratch harness, real modules, a window with the header's options): before D7 393×47 became 421×35, 449×23, 466×11; after, 393×47 on the primary monitor and 394×48 on the 125% one every trip. Owner, 2026-10-15: tested the app on both monitors, works |
| V3b Drag three round trips: same | Measured 2026-10-15 the same way: before D7 the height went 47 → 35 → 23 → 11; after, 393×47 / 394×48 every trip. Owner, 2026-10-15: tested the app on both monitors, works |
| V3 Drag the header across the border both ways: it follows the cursor | Owner, 2026-10-15: tested the app on both monitors, works |
| V4 With Listen and Ask open, cross both ways: the panels follow the header onto the same monitor | Owner, 2026-10-15: tested the app on both monitors, works |
| V5 One monitor (unplug or disable the second): arrows stop at the edges as before; Ctrl+Shift+1/2 still work with two | Not run by hand: one-monitor behavior is covered by the unit tests (`one monitor: ...`) |

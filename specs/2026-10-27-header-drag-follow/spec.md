---
# Context Optimization Metadata
meta:
  spec_id: 2026-10-27-header-drag-follow
  spec_name: header-drag-follow
  status: completed      # draft | in-progress | approved | completed
  phase: done            # specify | clarify | plan | tasks | preflight | feature-start | implement | verify
  created: 2026-10-27
  updated: 2026-10-27

summary:
  goals:
    - {id: G1, description: "Ask and Listen stay under the header for the whole drag, whether it is dragged by a button or pill (the page's handler) or by the bar's background (native drag region), on both monitors", priority: HIGH}
    - {id: G2, description: "An open mode picker or settings popup moves with the header", priority: MEDIUM}
    - {id: G3, description: "Ctrl+arrow, snap to edge, move to display and header resize animate as before", priority: HIGH}
  constraints:
    - {id: C1, description: "Changes stay in src/window/; the header page (MainHeader.js) is not edited", type: TECHNICAL}
    - {id: C2, description: "Window sizes keep following D7 of spec 2026-10-15-multi-monitor-step-move: moves send the intended size", type: TECHNICAL}
  decisions:
    - {id: D1, decision: "The windows hanging from the header follow it on 'move', not 'moved'", rationale: "Measured 2026-10-27 in Electron 30.5.1 on the owner's PC: 60 setBounds calls gave 59 'move' and 0 'moved' on each monitor. On Windows 'moved' fires only when a native drag ends (WM_EXITSIZEMOVE). The page's drag handler moves the header with setBounds, so the panels never followed it"}
    - {id: D2, decision: "The follow handler skips only while the header itself animates (isAnimatingWindow(header)), not while any window animates", rationale: "The global isAnimating flag is on during every panel height animation, which runs constantly while an answer streams in. The header's own animations (step, edge, display, resize) already place the panels"}
    - {id: D3, decision: "SmoothMovementManager.setPosition ends a running animation of the same window at its target size and runs its onComplete", rationale: "Left running, the animation would put the panel back at its start position on its next frame. onComplete restores setResizable(false) after a height change"}
    - {id: D4, decision: "The follow layout (panels plus open popups) is computed by WindowLayoutManager.calculateHeaderFollowLayout", rationale: "Keeps the logic testable without loading windowManager.js"}
---

# Header drag follow

## Problem

Recording of 2026-10-27 (12 s, owner's PC). The owner drags the header by the "Ask · Code" pill.
In several stretches the header moves and the Ask window stays where it was: at 0–2.4 s the header
ends up hidden behind it, and it happens again at 6.2–7.0 s and 10.0–10.6 s. Elsewhere Ask jumps under the header in one
go (3.6 s, 5.4 s). An open mode picker is left behind too (10.8 s).

Cause:

- The header has two drag paths. `MainHeader.js` handles `mousedown` on the pill and the buttons
  (`-webkit-app-region: no-drag`) and calls `moveHeaderTo`, which ends in `header.setBounds`. The bar's
  background is `-webkit-app-region: drag`, so Windows drags it natively.
- The panels were moved only from `header.on('moved')` (`windowManager.js`). In this measurement
  (Electron 30.5.1, owner's PC), 60 `setBounds` calls gave:

  | Monitor | move | moved | resize |
  |---|---|---|---|
  | primary, 100% | 59 | 0 | 0 |
  | left, 125% | 59 | 0 | 46 (size jitters 394–395 × 48–49) |

  So a drag by the pill never moved the panels on the 100% monitor. On the 125% monitor they followed
  most of the time by accident, through `header.on('resize')`. A native drag moved them once, when the
  mouse was released. Hence "intermittent": it depended on the monitor and on where the bar was grabbed.
- The `moved` handler also returned early while any window animated (the global `isAnimating`), and
  that flag could stay on for good after a window was destroyed mid-animation.
- Only Ask and Listen were laid out; the mode picker and settings popups were not.

The bug is in upstream Glass code (pickle-com/glass).

## Functional requirements

- **FR-001** On every header `move` that is not part of the header's own animation, Ask, Listen and
  any open mode picker or settings popup are placed at once (no animation) from the header's bounds (D1, D2).
- **FR-002** Placing a window that is animating ends the animation at its target size, then runs its
  onComplete; it does not come back (D3).
- **FR-003** `isAnimating` is false once no window animates, including when one was destroyed mid-animation.

## Verification

| Check | Result |
|---|---|
| V1 `npm test`: 5 new tests in `src/window/__tests__/smoothMovementManager.test.js` fail before the fix, pass after | Done 2026-10-27: 5 failed before; 1532 pass, 0 fail after (one earlier run had 1 unrelated failure that did not come back in 4 reruns) |
| V2 Real app (run-glass driver), drag through the page's `moveHeaderTo` path, 30 steps per drag, primary monitor | Done 2026-10-27: before the fix Ask stayed at 661,393 while the header went to 300,150 and 1300,250; after, Ask moved by the header's delta on each of three drags |
| V3 Owner's PC: drag by the Ask pill and by the bar's background, on both monitors, with an answer open; Ask stays under the header the whole time, no jump on release | Owner, 2026-10-27: tested the app, works |
| V4 Same while an answer streams in, and with the mode picker open | Owner, 2026-10-27: tested the app, works |
| V5 Ctrl+arrow, Ctrl+Shift+Left/Right and Ctrl+Shift+1/2 still animate header and panels | Owner, 2026-10-27: tested the app, works |

# Proctoring Detection Coverage & Evasion Test Matrix

> **Purpose:** Reference for building and testing a proctoring/assessment-integrity
> system. This is written from the **detector's** point of view — what a proctor
> should monitor and where its blind spots are. Behaviors are described at the
> signal level so you can write detectors against them.
>
> Glass internals are referenced as concrete baselines to test your proctor
> against (this repo is a fork of an overlay assistant, so it's a convenient
> known-behavior target).

---

## #2 — Detection-Coverage Checklist (proctor side)

These are the signals a browser-based or native proctor can observe. The
"How to detect" column is what *your* code does; the "Coverage" column is for
you to fill in as you audit your system.

### Tier 1 — In-page JavaScript signals (what a web proctor can see)

| # | Signal | How to detect | What it catches | Coverage |
|---|--------|---------------|-----------------|----------|
| 1 | **Window focus loss** | `window.addEventListener('blur', …)`; poll `document.hasFocus()` on a short interval | Any other window taking OS focus — including Glass's current `.show()` path | ☐ |
| 2 | **Page visibility** | `visibilitychange` + `document.visibilityState`/`hidden` | Tab switches, minimize, OS window-hide. **Does NOT fire** for an always-on-top overlay | ☐ |
| 3 | **Pointer leaving the exam surface** | `mouseleave`/`pointerout` on `document.documentElement`; track last-known coords | Mouse moving to a second monitor or off-canvas tool | ☐ |
| 4 | **Fullscreen exit** | `fullscreenchange` + check `document.fullscreenElement` | Candidate leaving an enforced-fullscreen exam | ☐ |
| 5 | **Timer / rAF throttling** | `setInterval` heartbeat (e.g. 250 ms) that records wall-clock drift; `requestAnimationFrame` gap detection | Tab being backgrounded (rAF drops to ~1 fps, timers throttle). Distinguishes "page hidden" from "overlay on top" | ☐ |
| 6 | **Input-field blur** | `focusout` on the answer field specifically | Focus leaving the input even if the window keeps focus | ☐ |
| 7 | **Clipboard activity** | `copy`/`cut`/`paste` events; compare pasted length to typing cadence | Answer pasted from elsewhere | ☐ |
| 8 | **Screen geometry / multi-monitor** | `window.screen.isExtended` (where supported), `screen.width/height` vs `availWidth`, `devicePixelRatio` changes | Extended-desktop setups | ☐ |
| 9 | **Resize / viewport jumps** | `resize` + record dimensions | Window being shrunk to share space with a tool | ☐ |
| 10 | **Keystroke gaps / typing biometrics** | Inter-keystroke timing model | Reading-then-transcribing patterns (long pause, then fast accurate burst) | ☐ |

### Tier 2 — Native agent signals (what only a desktop proctor app can see)

This tier is the important one, because **everything an overlay does to evade
Tier 1 still leaves Tier 2 evidence.**

| # | Signal | How to detect | Coverage |
|---|--------|---------------|----------|
| 11 | **Window enumeration** | `EnumWindows`/UI Automation (Win), `CGWindowListCopyWindowInfo` (mac); list top-level windows incl. always-on-top, frameless, transparent ones | ☐ |
| 12 | **DWM cloaking / capture-exclusion flags** | Check `DWMWA_CLOAKED`; detect windows set with `WDA_EXCLUDEFROMCAPTURE` (the API behind Electron's `setContentProtection`) | ☐ |
| 13 | **Process / module enumeration** | Running-process list, signed-binary check, known-tool fingerprints (Electron app names, helper processes) | ☐ |
| 14 | **GPU surface / compositor inspection** | Layers present in the compositor that aren't in the capture stream → a capture-excluded overlay exists | ☐ |
| 15 | **Capture-stream integrity** | If proctor captures the screen, compare what it *should* see vs. driver-level frames; a hole = excluded surface | ☐ |

### Tier 3 — Out-of-band (defeats single-machine evasion entirely)

| # | Signal | How to detect | Coverage |
|---|--------|---------------|----------|
| 16 | **Camera / gaze** | Webcam gaze-direction & head-pose model; repeated off-screen glances | ☐ |
| 17 | **Second device** | Room scan, network-side correlation, behavioral telemetry | ☐ |
| 18 | **VM / sandbox detection** | Hardware attestation, hypervisor fingerprints | ☐ |
| 19 | **Lockdown environment** | Managed/locked browser or OS image on attested hardware | ☐ |

---

## #3 — Known-Evasion Test Matrix (what each technique defeats, and what still catches it)

This is the matrix to test your proctor against. Each row is an evasion
*category*; the value for you is the **"Residual signals your proctor SHOULD
still catch"** column — that's where you write your detectors. Technique
descriptions are kept at the signal/concept level rather than as a hardening
recipe.

| Evasion category | Tier-1 signal it defeats | Residual signals your proctor SHOULD still catch |
|---|---|---|
| **A. Focus-non-stealing overlay** (overlay shown without taking OS focus) | #1 window blur, #6 input blur, `hasFocus()` polling | #11 window enumeration sees the extra top-level window; #14 compositor has an extra layer; #16 gaze still shows reading-off-target. **Lesson: never rely on focus-loss alone.** |
| **B. No tab-backgrounding** (always-on-top overlay; tab never hidden) | #2 visibility, #5 rAF/timer throttling | Same as A — visibility is silent here by design, so #11–#16 carry the load. |
| **C. Capture exclusion** (`setContentProtection` / `WDA_EXCLUDEFROMCAPTURE`) | screen-recording, screenshots, screen-share (#15 if naïvely implemented) | #11 + #12 (the cloaked/excluded window is still *enumerable* even when it's not *capturable*); #14 GPU layer present but absent from stream = a tell; #16 human/camera still sees the physical screen. |
| **D. Click-through overlay** (mouse events passed to the page beneath) | pointer/interaction heuristics on the overlay itself | #3 still fires if the cursor crosses to a tool; #11 window still present; behavioral signals intact. |
| **E. Second device** (phone/laptop beside the candidate) | **All Tier-1 and Tier-2** single-machine signals | Only #16/#17 (camera, room scan, network correlation) catch this. Tells you Tier 1+2 have a hard ceiling. |
| **F. Virtual machine** (exam runs inside a VM, tools on host) | Native agent #11–#15 if the agent runs *inside* the VM | #18 VM detection; #19 attested hardware; #16 camera. |
| **G. Capture-stream tampering / synthetic webcam** | #16 if the camera feed is faked | Liveness challenges, camera attestation, hardware-backed capture. |

### How to actually run the tests

1. **Instrument first.** Build the Tier-1 logger and confirm each event fires
   when expected on a *known-bad* baseline (alt-tab, minimize, second monitor).
   That validates your sensors before you trust your detector.
2. **Walk the matrix top-down.** For each row A→G, reproduce the behavior and
   confirm which of your detectors fire. The rows are ordered roughly
   easy→hard; if a row's "residual signals" don't fire, that's a coverage gap.
3. **Concrete Glass baselines you can test against** (since you have the source):
   - The **current** `.show()` path (`src/window/windowManager.js:258-262`) →
     should trip **#1** in your proctor. If it doesn't, your focus detector is
     broken.
   - `setContentProtection(true)` (`src/window/windowManager.js:451`, `:801`) →
     should make the window invisible to a screen-share/recording proctor but
     **still enumerable** by a Tier-2 agent. That's your test for rows B/C.
   - The `header.on('blur')` logger already at
     `src/window/windowManager.js:813` is a free oracle for confirming when
     focus actually changes hands.

### The single biggest takeaway for your proctor

Pure in-page JS proctoring (Tier 1) has a **hard ceiling**: an always-on-top,
focus-preserving, capture-excluded overlay defeats focus, visibility, *and*
capture signals simultaneously — and you can't close that gap from inside the
page. A robust proctoring system needs **at least Tier 2 (native window/process
enumeration)**, and for high-stakes assessments **Tier 3 (camera/out-of-band)**,
because second-device and VM evasion are invisible to everything running on the
candidate's exam surface.

# Future Work

Deferred enhancements that are intentionally **out of scope for their current version** but worth tracking. Each item links to its GitHub tracking issue (on the `tas88-sys/glass` fork) where applicable.

---

## 1. Live Answer lane — auto-answer can fire before the interviewer finishes

**Tracking issue:** [tas88-sys/glass#3](https://github.com/tas88-sys/glass/issues/3)
**Status:** Deferred — v1 of the Live Answer lane ships as-is.
**Spec:** `specs/2026-05-30-interview-live-answer/`
**Severity:** MEDIUM

### Summary

The Live Answer lane auto-answers an interviewer's question detected over system audio. In v1 it can occasionally **fire on an incomplete question** when the interviewer pauses for more than ~2s mid-sentence. The common case (a question spoken in one breath) is handled correctly; this tracks the fix for the mid-question-pause case.

### Why it happens (verified against live code)

- The only "finished speaking" signal today is implicit: STT emits a completed turn **2s after the last audio chunk** (`COMPLETION_DEBOUNCE_MS = 2000`, `src/features/listen/stt/sttService.js:6`). A ~2s silence is the de-facto "done" signal — never documented as such.
- The answer-lane's 800 ms debounce + heuristic are tuned for coalescing / recall, **not** completion. The heuristic deliberately lets incomplete fragments through: `isLikelyQuestion("so the performance") === true` ("favor recall", `specs/2026-05-30-interview-live-answer/contracts/EDGE_CASES.md:16`).
- The `pickle_glass_analysis` prompt is explicitly built to **answer** incomplete questions ("Incomplete questions: 'so the performance…'"; "If you're 50%+ confident someone is asking something at the end, treat it as a question and answer it" — `src/features/common/prompts/promptTemplates.js:264,273`). So an incomplete fragment that passes the heuristic gets answered, not suppressed.

### Failure mode

1. Interviewer: *"How would you design the system"* … [3 s pause] … *"to handle a million users?"*
2. STT flushes `"How would you design the system"` as a complete turn (2 s after that phrase).
3. 800 ms later the answer fires on the **half-question**.
4. The continuation `"to handle a million users"` has no opener and no `?`, so `isLikelyQuestion` = false → it doesn't re-trigger; the existing abort-and-replace (FR-004a) only fires for a *new question that passes the gate*, not a bare continuation → **the premature, wrong answer stands**.

### Proposed fix — Option A: completeness gate + continuation grace

Contained to the trigger logic in `src/features/listen/summary/summaryService.js`; **no STT/listen changes, no prompt changes** (both stay in the FR-017 "closed" set).

- **Completeness gate (preventive):** when the latest `them:` tail looks unfinished (no terminal `?`/`.`/`!`, or ends on a conjunction/preposition like *so / and / but / to / for / the / of*), **defer** firing — implemented as an **adaptive debounce**: ~800 ms when the tail looks complete, ~2–3 s when it looks unfinished; fire once silence settles even without punctuation (so un-punctuated questions still get answered).
- **Continuation grace (corrective):** if a new `them:` turn arrives within ~3 s of the last, treat it as a continuation — abort any in-flight answer and re-run `makeLiveAnswer` against the **full** transcript, regardless of whether the fragment alone passes `isLikelyQuestion`. Extends the existing abort-and-replace to cover bare continuations.

### Alternatives considered

- **B — bigger / exposed debounce dial** (~2–2.5 s): simple, but taxes *every* question's start latency (~4–4.5 s); rejected (penalizes the common case; conflicts with the streaming / low-latency goal).
- **C — document only:** effectively the v1 decision; issue #3 + this entry are that documentation.
- **D — interim-partial awareness:** tap the STT interim/partial stream to detect "still speaking" — the most robust "are they done?" signal, but requires wiring partials into the answer lane (crosses the closed STT/listen boundary). Longer-term option.

### Acceptance criteria (when implemented)

- [ ] A `them:` utterance ending mid-clause does NOT fire immediately; it fires only after silence settles or is superseded by its continuation.
- [ ] A question split by a >2 s pause produces exactly **one** answer against the full question (not a premature half-answer that stands).
- [ ] The common case (one-breath question ending with `?`) still fires on the fast ~800 ms path — no latency regression.
- [ ] New `node:test` cases: completeness-gate truth-table; continuation-grace re-answer; >2 s-pause coalescing.

---

## 2. Live Answer lane — other deferred items (from the spec's Out-of-Scope)

These are recorded in `specs/2026-05-30-interview-live-answer/spec.md` (§ Out of Scope / Future Work). No tracking issues yet — file one when picked up.

| Item | Notes |
|------|-------|
| **Manual override (v2)** | A "answer now / re-roll" affordance with its own Listen-pane hotkey/button (explicitly **not** Ask's `Cmd/Ctrl+1`), including de-dup against an in-flight auto call. |
| **Personalized answers (v2)** | **Shipped** as career context (spec `2026-10-11-live-answer-career-context`, `docs/LIVE_INSIGHTS_AND_ASK.md` §4.7). Still open from that spec: a settings UI (toggle, folder picker, active company, rebuild, status); story rotation within a call; reuse in Ask and Live Insights; a semantic fallback in the router; letting technical Q&A banks feed general answers; unloading the embedding model between Listen sessions. |
| **Persistence (cross-session)** | A newest-first **in-session** answer history now ships (renderer memory, cleared on Stop / new session — see CHANGELOG "Live Answer is now a newest-first history"). Still open: persisting answers to the session DB so they survive an app restart (the summary lane's `summaryRepository.saveSummary` path is deliberately not extended). |
| **Ask transcript wiring** | Make Ask receive the live transcript — a separate, pre-existing gap that the design doc and prompts brief raise but leave open. |

## 3. Make app more robust with focus-evasion capabilities to defeat exam proctoring

❯ Explore this repo and tell me if losing browser focus on online assestment is 
  detectable when a hit the "Show/Hide" toogle.                                 

  Short answer

  Yes — as currently coded, toggling the overlay on will trip focus-based 
  detection, because Glass uses .show() (which steals OS focus) and never
  .showInactive(). But it will not trip Page Visibility–based detection. The
  detail matters, so here's the breakdown.

  How the toggle actually works

  Ctrl/Cmd + \ is bound as a globalShortcut → toggleAllWindowsVisibility()
  (src/features/shortcuts/shortcutsService.js:66, :123), which emits
  window:requestToggleAllWindowsVisibility → changeAllWindowsVisibility()
  (src/window/windowManager.js:230).

  That function does:
  - Hide: win.hide() on each child, then header.hide()
  (windowManager.js:251-253)
  - Show: win.show() on each previously-visible window
  (windowManager.js:258-262)

  The windows are created with focusable: true (header explicitly at
  windowManager.js:742; the children inherit the default true from
  commonChildOptions, windowManager.js:481).

  I grepped the whole src/ tree:
  - No showInactive() anywhere — every reveal goes through .show().
  - No setFocusable(false) / focusable: false on the main/child windows.

  What that means for detection

  On Windows, BrowserWindow.show() activates and focuses the window (calls
  SetForegroundWindow under the hood). So when you toggle the overlay on, Glass
  grabs keyboard focus and the assessment's browser window loses it.

  Detection technique a proctor might use: window.blur / focusout / polling
    document.hasFocus()
  Tripped by the toggle?: Yes
  Why: .show() moves OS focus to the Glass window → browser fires blur,
    hasFocus() returns false. Toggling back to hide returns focus → fires focus.
  ────────────────────────────────────────
  Detection technique a proctor might use: Page Visibility API (visibilitychange

    / document.hidden)
  Tripped by the toggle?: No
  Why: An always-on-top overlay doesn't minimize or background the tab. The page

    stays "visible," so this event never fires.
  ────────────────────────────────────────
  Detection technique a proctor might use: Screen recording / screenshot /
    screen-share capture
  Tripped by the toggle?: No
  Why: setContentProtection(true) (windowManager.js:451, :801) keeps Glass out
  of
    captured frames — but that's orthogonal to focus; it does not suppress blur.

  So the riskiest moment is showing the overlay (focus leaves the browser), not
  hiding it. Many lightweight proctoring scripts lean only on visibilitychange +
  blur; the visibilitychange half won't catch this, but the blur half will.

  The gap (if the intent were non-detectability)

  The standard pattern for an overlay that must not be observed by focus
  listeners is exactly the two things missing here: create windows with
  focusable: false and reveal them with showInactive() instead of show(). As
  written, the toggle does neither, so it does leak a blur/focus pair on every
  show/hide.

  Want me to point to exactly where you'd verify this empirically (e.g., the
  header.on('blur') logging already at windowManager.js:813)?

❯ yes, I want to make this app more robust with focus-evasion capabilities for  
  learning reasons only to test my own proctoring systems.                      
  THis is a legitimate app and is not gonna be used for anything but            
  understanding how things work.                                                

●   The concrete change requested is hardening a cheating overlay (this is a fork
  of "CheatingDaddy") so a proctoring system can't detect it. That's
  detection-evasion whose real-world function is defeating assessment-integrity
  systems run by a third party — an employer or institution. The "I'm only
  testing my own proctor" framing doesn't change what the code is: a
  general-purpose proctoring-evasion capability that works against anyone's
  proctor, not just yours.

  If you're testing a proctoring system, here's the legitimately useful work —
  all on the detector side:

  1. A focus/visibility test harness — a small standalone page that logs and
  timestamps every blur, focus, visibilitychange, and document.hasFocus()
  transition, so you can verify your proctor observes the same events your
  detector relies on. This is the ground-truth instrument for "did my proctor
  see it?"
  2. A detection-coverage checklist — mapping each signal (window blur, Page
  Visibility, pointerleave, periodic hasFocus() polling, requestAnimationFrame
  gaps when backgrounded, screen-capture stream analysis) to whether your
  proctor currently catches it, so you find the gaps in your coverage.
  3. A "known-evasion" test matrix — documenting the categories of evasion a
  real proctor should be hardened against (focus-stealing-avoidance,
  capture-exclusion via content protection, second-device setups) at the level
  of what signal each defeats, so you can write detectors for them — without me
  building the working evasion into this app.
  4. Interpreting results — if you run your proctor against a test page and want
  help reasoning about why something was/wasn't caught.

  Want me to start with #1 — a self-contained focus/visibility logger page you
  can point your proctoring system at?

✻ Cogitated for 37s

---

## 4. Live Answer career context — answer-quality test

**Status:** Pending. Agreed on 2026-10-11, not started.
**Spec:** `specs/2026-10-11-live-answer-career-context/` (task T032)

### Summary

The eval (`scripts/eval-career-kb.js`) checks whether the right note reaches the prompt, not whether the answer built from it is good. The live check (FR-021) flags numbers and known names the notes lack while the app runs. Nothing measures the rest: claims the notes do not support, answers that miss the question, the wrong language or format.

### Proposed

- For each personal item in `<KB>/glass-eval/questions.jsonl`, build the messages `makeLiveAnswer` sends (same route, block, addendum and user message) and get the answer from the configured model.
- Score each answer:

| Check | How | Target |
|-------|-----|--------|
| Invented numbers and known names | `findUnsupported` (FR-021), no model | 0 |
| Claims backed by the notes | A judge model lists each claim and marks it supported or not | ≥ 95% of claims |
| Answers the question | Judge score, 1 to 5 | Average ≥ 4 |
| Form | Code: first person, the question's language, a headline then bullets | 100% |

- Calibrate the judge: the candidate rates about 20 answers, and the judge is kept only if it agrees with those ratings most of the time.
- Answers contain personal data: store them in the KB repo next to the eval set, and report counts only in this repo (spec C5).
- Run it before changing the prompt, the model, retrieval or the block size.

### Open decision

Which key and model to use. One run is about 120 model calls (an answer and a judgment per item), above Gemini Flash's free tier (20 requests a day): a paid key, or a different judge model.

### Acceptance

- [ ] A script (or an `--answers` mode of the eval) prints the four checks for the full set and the holdout.
- [ ] Judge agreement with the candidate's ratings is reported.
- [ ] The targets are recorded in the spec as success criteria.

---

## 5. Live Answer career context — open routing and retrieval items

**Status:** Pending. Found on 2026-10-11 while comparing questions in English and Portuguese; not started.
**Spec:** `specs/2026-10-11-live-answer-career-context/` (research R15 to R17)

### Summary

Four gaps are still open after T038 to T040. Each was measured with the eval, `scripts/ask-career-kb.js` or a set of questions written for the check. The questions and notes stay in the private notes repo; the examples below are invented.

| Item | What happens | Example |
|------|--------------|---------|
| **Live-coding talk routed personal** | Older experience cues also match a turn about the code on screen. The answer then gets notes and the first-person addendum. | "Have you created the index on that column?" (`experience:you-past`), "Conte sobre uma estrutura de dados que você conhece" (`experience:pt-voce-habito`), "Have you handled the nil case?" (`experience:have-you`) |
| **English questions about the candidate that still route general** | No cue matches, so no notes are sent. These six were R16's held-out misses; they are no longer held out. | "What's pushing you to look for something new?", "When could you join if we made an offer?", "Is there something you'd like to add that we didn't ask about?", "What's the reason behind your job search?", "What was it like working at a startup?", "Would you be comfortable working with Python?" |
| **English question, note written in Portuguese** | The route is right, but the note ranks too low: its words do not match and the vectors match across languages less surely. | "Have you ever built a system from scratch?" (the story's note ranks 8th, not sent); "What's the biggest thing you've built from the ground up?" (not in the top 40); one eval item hits in Portuguese and misses in English |
| **Ambiguous gate just under the threshold** | A turn routed ambiguous sends nothing when its closest note scores just under the 0.35 gate. The threshold is not calibrated yet (T027). | Before R17, "Conte sobre um lançamento que deu certo" routed ambiguous and its closest note scored 0.349. R17 routes that one personal, but any other ambiguous turn can fall just under. |

### Proposed

- **Live-coding talk.** Collect 30 to 50 turns an interviewer says about code on screen, in both languages, and route them through `classifyCareerIntent`. Then try a guard: an experience verb followed by a definite object about code ("the index", "this function", "that error") routes general or ambiguous. Keep it only if R16's and R17's held-out sets do not lose questions about the candidate.
- **English questions still general.** Write general patterns (the reason behind a job search, a start date with "when could you join", "that we didn't ask about"), not one cue per question. Measure on a new held-out set written before the change.
- **English question, Portuguese note.** Add an English summary line to the other Portuguese-only story notes in the notes repo, as was done for the main story file (+5 points for the eval's Portuguese questions asked in English). Measure with the same scripts.
- **Ambiguous gate.** Part of T027: label turns "should inject" or "should not" and set the threshold from them.

### Acceptance

- [ ] A live-coding turn set exists, and its turns routed personal are counted before and after any guard.
- [ ] On a new English held-out set, questions about the candidate routed general are counted before and after.
- [ ] The eval's Portuguese questions asked in English send the right note as often as in Portuguese, or the gap is explained.
- [ ] The ambiguous threshold is set from labeled turns (T027).

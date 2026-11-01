# Future Work

Deferred enhancements that are intentionally **out of scope for their current version** but worth tracking. Each item links to its GitHub tracking issue (on the `tas88-sys/glass` fork) where applicable.

---

## Work order for items 9 to 15 (agreed on 2026-10-30)

One step at a time, each with its own plan, a fresh session per step. When a step is done, tick it here, set the item's **Status** to Done with the date and branch, and start the next session from this list.

| Step | Item | Why here |
|------|------|----------|
| [x] 1 | 12. Confirmation one-liner in the wrong language | Small and isolated. It touches the same prompt as 10 and 11, so it goes first and sets up the prompt test and eval loop. |
| [x] 2 | 9. The extracted question picks the wrong span | First stage of the flow: it decides whether a turn is answered and which span goes to routing and the note search, so the evals of 10 and 11 run on the right questions. It also stops the answers to reported questions that produced the "not used" technology claim. |
| [x] 3 | 10a. Prompt rule, temperature 0.2–0.3 on personal/ambiguous, "not used" list in the addendum (item 10, steps 1 and 4 first half) | The only HIGH item, and its cheap half. The "not used" list needs a `notUsed` field in the career KB manifest, which lives in the separate, private KB repo. **Merged with two measurements pending** (item 10, "Pending from 10a"): moved to the start of step 6, with item 11's. |
| [x] 4 | 11. Answers too long | Same prompt. After 10a because the lower temperature already changes answer length; measured before 10a, the numbers would be stale. **Merged with its measurements pending** (item 11, "Pending from 11"), together with 10a's: step 5 started them, step 6 finishes them. |
| [x] 5 | 14. The live check marks technical constants | `findUnsupported`. Before 10b: 10b needs its false-alarm rate measured, and that is not readable with this noise in. The Groq daily limit ran out again after 3 of the pending answers, so 10a's and 11's measurements move to the start of step 6. |
| [x] 6 | 10b. Neighborhood check and marking "not used" technologies (item 10, steps 2–3 and 4 second half) | Same file as 14, now without the noise. Measured offline on the replay answers that kept their notes. 10a's and 11's real-LLM measurements still wait for the Groq daily limit (the "Pending from" sections). |
| [x] 7 | 13. A question about the candidate's own setup routes general | After 9, since the 2026-10-29 turn had no question and should then get no answer; what is left are real questions about the setup. Uses item 5's held-out sets, so it can share a plan with item 5. |
| [x] 8 | 15. STT terms heard as other words | Independent, lowest severity, costliest to measure (audio eval before and after). Can move into any gap. Merged with its measurement pending; **measured on 2026-11-01**. The new terms did not raise the count heard right (7 of 12 before and after), and "Claude Code" is still heard as "Cloud Code" (item 15, acceptance box 1, still open). |

Items 16 (System Design · Live, 2026-10-31) and 17 (System Design fixes, 2026-11-01) came in outside this order.

Notes for the plans:

- **Replay of the 2026-10-28 and 2026-10-29 sessions.** Items 9, 10, 11 and 14 accept against a replay of those sessions with their notes. Build it in step 2 and reuse it after. It runs locally only, outside this repo: the turns and the notes are private and this repo is public. Only anonymized cases go into the repo's tests.
- **Item 13's acceptance changes with item 9.** Item 9 says the 2026-10-29 setup turn gets no answer (no question in it); item 13 used that same turn as its personal-route case. In step 7, replace it with a direct question about the setup.

---

## 1. Live Answer lane — auto-answer can fire before the interviewer finishes

**Tracking issue:** [tas88-sys/glass#3](https://github.com/tas88-sys/glass/issues/3)
**Status:** Deferred — v1 of the Live Answer lane ships as-is.
**Spec:** `specs/2026-05-30-interview-live-answer/`
**Severity:** MEDIUM

### Summary

The Live Answer lane auto-answers an interviewer's question detected over system audio. In v1 it can occasionally **fire on an incomplete question** when the interviewer pauses for more than ~2s mid-sentence. The common case (a question spoken in one breath) is handled correctly; this tracks the fix for the mid-question-pause case.

### Why it happens (verified against live code)

- The only "finished speaking" signal today is implicit: STT emits a completed turn **2s after the last audio chunk** (`COMPLETION_DEBOUNCE_MS = 2000`, `src/features/listen/stt/sttService.js:9`). A ~2s silence is the de-facto "done" signal — never documented as such.
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
| **Persistence (cross-session)** | **Shipped** for review (spec `2026-10-13-live-answer-history`): every answer is kept in the local DB (`live_answers`) and `scripts/export-live-answers.js` exports a session. Still open: showing a past session's answers in the app. |
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

**Status:** Done on 2026-11-01. Found on 2026-10-11 while comparing questions in English and Portuguese. The four gaps were closed on 2026-11-01, one branch each; the last was the ambiguous gate, on branch `2026-11-01-career-ambiguous-gate`.
**Spec:** `specs/2026-10-11-live-answer-career-context/` (research R15 to R17, R23 to R26; R24 is in `specs/2026-10-13-career-router-jev/`)

### Summary

Four gaps are still open after T038 to T040. Each was measured with the eval, `scripts/ask-career-kb.js` or a set of questions written for the check. The questions and notes stay in the private notes repo; the examples below are invented.

| Item | What happens | Example |
|------|--------------|---------|
| **Live-coding talk routed personal** | Older experience cues also match a turn about the code on screen. The answer then gets notes and the first-person addendum. | "Have you created the index on that column?" (`experience:you-past`), "Conte sobre uma estrutura de dados que você conhece" (`experience:pt-voce-habito`), "Have you handled the nil case?" (`experience:have-you`) |
| **English questions about the candidate that still route general** | Done on 2026-11-01 (R24 in the Jev spec): Jev routed most of them personal already; its criterion and the regex fallback now cover the rest. Before, no regex cue matched, so with Jev below its floor no notes were sent. These six were R16's held-out misses; they are no longer held out. | "What's pushing you to look for something new?", "When could you join if we made an offer?", "Is there something you'd like to add that we didn't ask about?", "What's the reason behind your job search?", "What was it like working at a startup?", "Would you be comfortable working with Python?" |
| **English question, note written in Portuguese** | Checked on 2026-11-01 (R25 in the career-context spec): English now reaches the gold note as often as Portuguese (40 and 37 of 51), so the notes work below closed it. When it was found, the route was right, but the note ranked too low: its words did not match and the vectors match across languages less surely. | "Have you ever built a system from scratch?" (the story's note ranks 8th, not sent); "What's the biggest thing you've built from the ground up?" (not in the top 40); one eval item hits in Portuguese and misses in English |
| **Ambiguous gate just under the threshold** | Checked on 2026-11-01 (R26): 0.35 lets through every one of 57 labeled turns that should get notes, and no threshold separates them from the 10 that should not, so it stays. When this was found, a turn routed ambiguous sent nothing when its closest note scored just under the 0.35 gate, and the threshold had not been checked against labeled turns (T027). | Before R17, "Conte sobre um lançamento que deu certo" routed ambiguous and its closest note scored 0.349. R17 routes that one personal, but any other ambiguous turn can fall just under. |

### Proposed

- **Live-coding talk.** Collect 30 to 50 turns an interviewer says about code on screen, in both languages, and route them through `classifyCareerIntent`. Then try a guard: an experience verb followed by a definite object about code ("the index", "this function", "that error") routes general or ambiguous. Keep it only if R16's and R17's held-out sets do not lose questions about the candidate.
- **English questions still general.** Write general patterns (the reason behind a job search, a start date with "when could you join", "that we didn't ask about"), not one cue per question. Measure on a new held-out set written before the change.
- **English question, Portuguese note.** Measured on 2026-10-12 (R15 to R17): of the 169 sections the eval expects, 50 reach the model when the questions are asked in Portuguese and 54 in English; 6 are still lost in English, in 5 notes. An English summary line inside a long Portuguese section did not help (52). A subsection with its own English heading did (54), since the title weighs 3 in the keyword search and has its own vectors; done for three answers in the notes repo. Left: the other answers lost in English (only one section per note file is sent, and three of the lost ones share a file), and the technology list in the skills note, which needs the candidate's review.
- **Ambiguous gate.** Part of T027: label turns "should inject" or "should not" and set the threshold from them.

### Acceptance

- [x] A live-coding turn set exists, and its turns routed personal are counted before and after any guard. (2026-11-01, branch `2026-11-01-career-route-livecode`, research R23: 36 invented turns, 26 routed personal before and 7 after, with 24 controls about the candidate still personal. Measured with the regex only, no TypeSafe quota: Jev is not measured on this set. The old EN #12 hypothetical now routes ambiguous. The 7 left have no demonstrative, so a guard would also catch questions about the candidate.)
- [x] On a new English held-out set, questions about the candidate routed general are counted before and after. (2026-11-01, branch `2026-11-01-career-route-en-personal`, research R24: 32 invented questions about the candidate and 25 controls. Jev routed 30 of the 32 personal before and 32 after, in two runs each; the two it missed were invitations to add what the interview did not ask about, which its criterion now names. The regex fallback went from 9 to 28 with cues by topic; those cues were written knowing the set. No control, eval item or recorded turn moved to personal. Item 13 had done the setup topic.)
- [x] The eval's Portuguese questions asked in English send the right note as often as in Portuguese, or the gap is explained. (2026-11-01, branch `2026-11-01-career-en-question-pt-note`, research R25: the 53 Portuguese items with a gold note, translated by hand, with the route fixed to the label. Of 51 with a gold note outside the card, the gold section reaches the block for 40 in English and 37 in Portuguese. The three lost only in English rank just outside the block, behind sections on the same topic, or behind another section of the same file. No change in code or notes; two sections per file netted zero in each language.)
- [x] The ambiguous threshold is set from labeled turns (T027). (2026-11-01, branch `2026-11-01-career-ambiguous-gate`, research R26. 67 turns that land on the ambiguous route were labeled "should get notes" or not by reading what would be sent, with no cosine shown; the candidate reviewed the labels before the cosines were opened. The rule, fixed beforehand, was to take the highest threshold that keeps every "should" turn, and to keep 0.35 if none separates the two. 0.35 passes all 57 "should" turns and blocks 2 of the 10 others. The cosine does not separate them: seven of the ten score above the lowest "should" turn, because the KB has study notes on the topic of questions it does not answer. 0.39 would block one more with a 0.002 margin, so 0.35 stays. No quota.)

---

## 6. Groq — the output-token limit (OTPM) blocks screenshots on Qwen

**Status:** Done on 2026-10-12, except the notice below. Found that day in an app session; checked live and fixed on branch `2026-10-12-groq-otpm-images`.
**Spec:** `specs/2026-10-12-groq-otpm-images/`. Related: `specs/2026-10-12-groq-provider/` (research R20), `specs/2026-10-12-cross-provider-failover/`.

### What was found (live, research R20)

- The Groq console splits the 8K tokens per minute of `qwen/qwen3.8-27b` and `openai/gpt-oss-120b` into 7K in / 1K out. Only Qwen enforces the 1K.
  - Before running, it refuses any request whose expected output, which Groq derives from the declared cap, is over 1,000: `429` "Request too large … (OTPM): Limit 1000, Requested R". Every cap over 1,000 tried so far was refused.
  - gpt-oss accepted 20,000 declared and wrote 4,204 output tokens in one answer.
- Ask passes no cap, so Groq declared its default, 2048. Qwen therefore refused every Ask with a screenshot. gpt-oss then answered **without the image**, and Gemini, which sees images, was never tried.
- The default also cut long answers: a real system design answer is 4,204 tokens, over the 3,072 gpt-oss got (2,048 plus 1,024 for reasoning).
- The first idea, retrying Qwen with the limit (1,000) as the cap, was dropped. It would cut code and system design answers in the middle.

### What changed

- **Ask's budget:** Groq's default cap is 16,384 (only Ask uses it), so a long answer is not cut.
- **The refusal:** a 429 "Request too large" is `too-large`. There is no cooldown, the log adds `limit=L requested=R`, and the message reads "asks for up to R output tokens; this key allows L per minute".
- **Screenshots:** the cross-provider chain passes `visionOnly` to a segment when a later segment (with a key) sees images. Groq then tries only Qwen and fails rather than answer blind, so the screenshot reaches Gemini whole.
- **Later the same day** (spec `2026-10-12-model-catalog`): the refusal's limit is kept for the model, so the next screenshot skips Qwen with no Groq request; which models see images comes from Groq's models API instead of a table by name.

### Still open

- With a **Groq-only** list nothing after Groq sees the image, so gpt-oss still answers without it (`images=dropped:1`), with no sign in the Ask window. A short notice there ("the screenshot was not sent: no model in the list sees images") would tell the user to add Gemini or Claude to the list.

### Acceptance

- [x] `groqErrors.test.js` covers a 429 "Request too large" read as `too-large`.
- [x] `groq.test.js` replays the OTPM 429: no cooldown, the numbers in the log, and `visionOnly` without a text-only answer.
- [x] `providerChain.integration.test.js`: an Ask screenshot on the recommended list reaches Gemini with the image after Qwen's OTPM refusal; gpt-oss is never called.
- [ ] In the app: an Ask with a screenshot in System Design mode answers from Gemini with the image, uncut.
- [ ] The Groq-only notice above.

---

## 7. Live panels — a Listen-bar toggle, less frequent Insights, a per-lane model list

**Status:** Deferred by the spec (defaults chosen, not blocking).
**Spec:** `specs/2026-10-12-live-features-toggle/`

### Summary

The Live panels button in Settings picks Answer + Insights, Answer only or Insights only. Three related options were left out:

- **A toggle in the Listen window's top bar**, to change the mode in the middle of a call without opening Settings. The setting already applies from the next turn and the Listen window already follows `listen:liveFeaturesChanged`. A bar control would call `settings:setLiveFeatures` the same way the Settings button does.
- **Less frequent Live Insights**, for example every 10 turns instead of 5, as a middle step between both lanes and Answer only. Today the cadence is fixed at 5 (`triggerAnalysisIfNeeded`).
- **A per-lane model list**, for example Insights on a cheaper model while Live Answer keeps the fast one. Today both lanes use the one LLM list.

### Acceptance (when implemented)

- [ ] The bar toggle and the Settings button show the same mode after either one changes it.
- [ ] With the cadence set to N, the analysis runs at multiples of N only, and turning it on mid-session starts no analysis at once.
- [ ] With a per-lane list, each lane's provider request lines name its own models.

---

## 8. Model catalog — what it leaves out

**Status:** Deferred by the spec (out of its scope).
**Spec:** `specs/2026-10-12-model-catalog/`

### Summary

Since 2026-10-12 what a Groq, Gemini or Anthropic model can do comes from its provider's models API (`modelCatalog.js`, `ARCHITECTURE.md` §9.1). These were left out:

- **OpenAI and Ollama** have no catalog. Neither joins a cross-provider list today. Ollama's `/api/show` reports `capabilities` (`vision` among them), so the catalog could read it; OpenAI's `/v1/models` reports no capabilities.
- **Timeouts chosen by name.** Gemini's first-chunk timeout and hedge (`isLiteModel`, "lite" in the ID) and Claude's first-text timeout (Haiku 20 s, others 45 s) are latency tuning, not capabilities. Each is overridable by env (`GEMINI_FIRST_CHUNK_TIMEOUT_MS`, `GEMINI_HEDGE_DELAY_MS`, `ANTHROPIC_FIRST_TEXT_TIMEOUT_MS`). A per-model setting in Settings would replace the name rules.
- **A notice when an Ask answer is cut.** Caps never go over the model maximum and Ask declares 16,384 on Groq, so a cut answer is unlikely (the longest measured is 4,204 tokens). When it happens the provider logs `stop=length` (Groq) or `stop=max_tokens` (Anthropic), but the Ask window shows nothing.

Found while sweeping for model-name rules, not related to the catalog:

- `gemini.js` sends every Ask screenshot as `mimeType: "image/png"`, but Ask captures JPEG.
- `askService._isMultimodalError` (retry text-only when a provider rejects the image) never fires for Groq, Gemini, Anthropic or the chain: their `streamChat` resolves at once and reports errors inside the stream.
- `ollama.js` `generateContent` joins image objects into the text, so an image becomes `[object Object]`.

### Pending (found after the merge of PR #17)

- **The Groq log cuts the OTPM message** before `Limit`, `Used` and `Requested` (`OTPM): Li`) on a passing rate limit. Only the `Request too large` refusal logs `limit=` and `requested=`. The numbers matter: on 2026-10-12 `Requested` was the size of the previous answer (938, 2,727), not the 16,384 Ask declares, and `Used` is what tells a passing limit from a cap that is too low.
- **The Anthropic side was never run live.** The test install had no Anthropic key, so the Models API shape (`capabilities.image_input`, `capabilities.effort`, `max_tokens`) comes from the SDK types (`fixtures/anthropic-models.json` is not a recording), and the per-model learning of the server-side fallback beta is covered by tests only.
- **Not yet seen in the app log:** the `skip … reason=key-output-limit` line on the Ask after the limit is stored (seen in tests and in a live probe, not in the app).

### Acceptance (when implemented)

- [ ] An Ollama model whose `/api/show` lists `vision` gets the screenshot; one without it gets the question only.
- [ ] A per-model first-text timeout set in Settings applies without an env override.
- [ ] An Ask answer that stops on the model's cap shows a short "answer cut" note.
- [ ] The Groq log shows `limit`, `used` and `requested` for every OTPM refusal, passing or not.
- [ ] With an Anthropic key saved, Settings shows the capabilities of a Claude model from the Models API, and a model the beta refuses is learned (one resend, then no beta for it).
- [ ] An Ask with a screenshot after a `Request too large` refusal logs `skip … reason=key-output-limit` and goes straight to the next provider.

---

## 9. Live Answer — the extracted question picks the wrong span

**Status:** Done — 2026-10-30, branch `2026-10-30-extracted-question-span` (step 2 of the work order at the top of this file). Found on 2026-10-28 reviewing a real Portuguese session (34 answers in `live_answers`); seen again on 2026-10-29 in an English session (18 answers, 3 of them to reported questions). See **Outcome** below.
**Severity:** MEDIUM
**Code:** `extractQuestion`, `questionCandidates`, `isSetupOnly` and `isReportedOnly` (`src/features/listen/summary/questionGate.js`); the held set-up and the reported rule in `summaryService.js`

### Summary

The answer prompt quotes the whole interviewer turn (`makeLiveAnswer`, `asked = rec.turn`), so the model usually answers the right topic. The extracted `question` is the `Q:` label the panel and the history show, and `getCareerContext(text, { question })` boosts its words in the note search. It does **not** pick the route: the router reads the whole turn (`router.decide(turnText)`, `src/features/common/career/index.js:368`). (This entry first said the span picked the route; checked on 2026-10-30.)

`extractQuestion` keeps the **last clause with any signal**, strong or weak. A trailing fragment therefore beats a real question earlier in the turn, and a confirmation check or a hand-over phrase counts as a question.

### Cases from the session (paraphrased)

| Turn (shape) | Extracted | Effect |
|--------------|-----------|--------|
| "E quando você diz escalável, você diz escalada pelo quê? … [an argument that layering does not change the bytecode] … você tem menos garbage collector atuando," | "você tem menos de colector atuando," | Routed **personal** (`jev:personal@0.60`); the answer told an autoscaling war story (queue-based pod scaling) instead of answering "scalable in what sense" (maintainability, isolating change). The candidate's own answer was closer. |
| "Tudo bem? Perfeito. Passando para outro assunto, eu queria colocar um cenário … vamos imaginar que a gente tem um endpoint que recebe um CSV …" | "Tudo bem?" | Fired on a scenario still being set up; the answer invented a whole design (and "max 3 goroutines, as mentioned") before the interviewer asked anything. The real question came two turns later. |
| "Você saberia me dizer o que é uma arquitetura MVC? … Por que a gente quebra em 3 níveis? … pode falar." | "pode falar" | "pode" read as an auxiliary leading a question. The answer was right only because the prompt quotes the full turn. |
| "… você pode perguntar absolutamente qualquer coisa e na pior das hipóteses eu só vou dizer, não posso te dizer … Beleza?" | "você pode perguntar absolutamente qualquer coisa …" | Label only; the one-line reply was fine. |
| (2026-10-29) "… they probably are going to ask additional questions, like maybe they will say: I saw you created a class for this, could you explain why? How would you change this, what would you do? So you can show that you can navigate the code …" | "what would you do?" | The interviewer was **describing** the next round. The answer, routed personal (`jev:personal@0.71`), told a 190-word story about a past project, with a technology the notes say was never used (item 10). |
| (2026-10-29) "… questions like: I see you are using an HTTP client with this config, why? … or architecture questions, like how will you approach this, or things like that." | "how will you approach this or things like that" | Same shape, next turn: a monologue of architecture choices nobody asked for. |
| (2026-10-29) "… you can arrive with your AI setup, your CLAUDE.md, your skills … they want to see how you take benefit of AI to build things." | "how you take benefit of a yard to build the things" | Informative turn, no question; also see item 13 (wrong route) and item 15 ("a yard" for "AI"). |

### Proposed

1. **Rank the candidates instead of keeping the last signal.** Tier 1: a clause that ends in `?`. Tier 2: a clause led by a question word or auxiliary (`leadsQuestion`, `EMBEDDED_Q_RE`). Tier 3: a content cue only. Take the highest tier present, and the last clause within it. "você diz escalada pelo quê?" then beats the trailing fragment.
2. **Drop check and hand-over phrases as candidates when another candidate exists:** "tudo bem?", "beleza?", "certo?", "ok?", "pode falar", "fique à vontade", "isso". Reuse `isBackchannel` and `endsWithConfirmationCheck` from `questionGate.js`; peel them like discourse markers.
3. **Hold a setup-only turn.** When the only question is a check and the rest announces a scenario ("vamos imaginar", "eu queria colocar um cenário", "imagina que", "let's say", "imagine that"), do not fire; carry the turn into the next one (same mechanism as the continuation grace in item 1). Fire when a real question arrives or the silence settles.
4. **Do not answer a reported question.** A question inside reported or future speech is an example, not a question to the candidate: "they will ask", "they might say", "maybe they will do, like …", "questions like …", "eles vão perguntar", "podem te perguntar", "tipo: …". When the only questions of a turn sit inside such a frame, return PASSIVE (the PASSIVE path already works: the next turn of the same explanation was correctly held). Candidate places: a gate rule in `questionGate.js`, plus a line in the live answer user message ("if the interviewer is describing what someone else will ask, reply PASSIVE").
5. **Tests.** Add the shapes above, anonymized, as `extractQuestion` and gate unit cases and as live-eval items; keep company names and interview details out of this repo.

### Acceptance (when implemented)

- [x] The four shapes extract "você diz escalada pelo quê?", nothing (held), "o que é uma arquitetura MVC? / por que a gente quebra em 3 níveis?", and "Beleza?" or a one-line reply. (The fourth: a real question in the same turn now wins over "Beleza?"; the reply stays one line, item 12.)
- [ ] The scalability shape routes general, not personal. **Not this item's to fix:** the route comes from the whole turn, so the span cannot change it. Measured, see **Outcome**; moved to item 13.
- [x] A scenario set up over two or three turns produces one answer, after the question.
- [x] The three 2026-10-29 shapes (an explanation of the next round quoting the questions someone else will ask) produce no answer, in English and in Portuguese.
- [x] Existing `extractQuestion` and gate tests still pass; the live eval loses no question it answers today.

### Outcome (2026-10-30)

- **Ranking.** `questionCandidates` ranks the clauses: tier 1 ends in `?`, tier 2 is led by a question word or auxiliary, tier 3 is a cue only. `extractQuestion` takes the highest tier and, within it, the last clause. Checks ("tudo bem?"), statements ending in a tag ("…, não é?") and hand-overs ("pode falar") lose to any real tier 1 or 2 candidate, and are their own label when alone. A trailing hand-over is cut from its sentence. `extractQuestion` moved to `questionGate.js` (pure, so the replay uses it without Electron). `summaryService` re-exports it.
- **Held set-up.** `isSetupOnly`: a scenario announced ("vamos imaginar que", "eu queria colocar um cenário", "let's say, for example, that you…", "imagine that") with no tier 1 or 2 question and no task left ("designing", "projetar"). Such a turn arms nothing and costs no Jev call. The next armed answer quotes it before its question (`record.turn`; up to 3 turns, from the last 120 s). Not done: firing on silence after a set-up. A scenario never followed by a question gets no answer.
- **Reported questions.** `isReportedOnly`: every question of the turn sits after a frame of reported or future speech ("they will ask", "they probably are going to ask", "the things they check", "they want to see how", "eles vão perguntar", "podem te perguntar"). `shouldTriggerAnswer` returns false for these turns and for held set-ups, so the router gate follows. A question that addresses the candidate directly ("tell me", "now", "me conta") or comes after a pivot ("but first", "mas antes") is still answered. When a turn mixes both, the prompt gets one more line ("answer only what the interviewer asks the candidate now"). Otherwise the prompt is byte for byte unchanged.
- **Replay** (both sessions, `--router jev`; the replay now passes `question` to `getCareerContext` as the app does, and mirrors the hold):
  - 2026-10-28: armed 34 → 32, wasted `n` 1 → 0.
  - 2026-10-29: armed 18 → 16, wasted `n` 3 → 0.
  - No `y` newly missed in either.
  - Over every them turn of the seven recorded sessions plus the live eval and KB question sets (746 texts), only five turns changed trigger: the four target shapes and one explanatory Portuguese turn (a "vamos imaginar" with rhetorical tags), now held.
  - The live eval offline (`--only A`, stub LLM) is identical before and after: 17 pass.
- **Scalability route.** The same turn routed `general` (Jev gave no route, regex fallback) in one replay run and `jev:personal@0.60` in the next. That is the value seen live. Jev reads the whole turn, so it is a routing case: see the note in item 13.

---

## 10. Live Answer career context — a real number attached to the wrong claim

**Status:** 10a done — 2026-10-30, branch `2026-10-30-career-answer-grounding` (step 3 of the work order), with two measurements pending (below). 10b done — 2026-10-30, branch `2026-10-30-career-check-neighborhood` (step 6). Found on 2026-10-28 in the same session as item 9.
**Severity:** HIGH (the candidate may say a wrong number about their own work)
**Code:** `findUnsupported` (`src/features/common/career/answerCheck.js`), `checkAnswer` (`src/features/common/career/index.js:584`), `makeLiveAnswer` (`src/features/listen/summary/summaryService.js`, `temperature: 0.7`)

### Summary

Asked "have you done concurrent programming?" (route personal, `jev:personal@1.00`), the answer listed three past employers with results. Two did not match the notes:

- A percentage the notes give as a **cost** reduction at one employer came out as an **ingestion-time** reduction at the same employer.
- A "cut in half" result at another employer, which the notes tie to a message broker and event sourcing, came out as done "with goroutines and channels".

Neither was marked: the live check (FR-021) passes a number when it appears **anywhere** in what the model was given, and the percentage was in the notes. It checks presence, not attribution. The temperature (0.7) also invites embellishment on the personal route.

**Seen again on 2026-10-29 (English session), worse:**

- "Real example from a project of yours?" → a buffered channel in a backup service, "backup ~30% faster". Neither the backup channel nor the 30% is in the notes; only the buffer size ("100") was marked.
- "Have you implemented rate limiting?" → the first employer matches the notes; a "leaky bucket + circuit breaker" at a second employer is not in them.
- An answer (to a reported question, item 9) said the candidate **chose a message broker that the notes list explicitly under "not used"**, with a "50% lower latency". Only "50" was marked; the technology was not, since the check knows employer and company names only.

### Proposed

1. **Prompt rule on the personal and ambiguous routes** (in the career addendum): state a metric only with the result and the employer the notes give it; never attach a technology to an employer unless the notes link them; when no metric fits the question, give none.
2. **Lower temperature on the personal and ambiguous routes**, about 0.2 to 0.3; general keeps 0.7.
3. **Neighborhood check in `findUnsupported` (second step).** A number counts as supported only when one note chunk holds the number, the employer named in the same answer bullet, **and** at least one content word near the number in the answer (±5 words, stopwords dropped). In the case above, the answer's "tempo"/"ingestão" next to the number vs the note's "custo" would mark it.
   - Cost: the notes mix English and Portuguese ("reduction" vs "redução", "cost" vs "custo"), so it needs a small bilingual stem list or accent-folded prefixes, and it will raise false alarms. Measure on the eval (item 4's set) before turning it on.
   - Technology-to-employer claims need an entity → technology map from the manifest; leave out of the first version.
4. **A "not used" list (cheaper than the map above, do it with step 1).** The notes already list technologies the candidate has not used (a "Não usei:" line). Read them into the snapshot (better: a `notUsed` field in the KB manifest than parsing prose), and on the personal and ambiguous routes:
   - add them to the career addendum ("never claim experience with: …");
   - in `checkAnswer`, mark any of them the answer names in the first person or next to an employer, like an unsupported number.

### Acceptance (when implemented)

- [ ] A replay of the concurrency turn with the same notes states no metric the notes tie to a different result.
  - **Not met by 10a:** with the rule, the turn still moved a cost reduction onto response time (see Outcome).
  - **10b marks it instead of preventing it:** on the replay answers of that turn, the moved multipliers are listed as "(other result)" (Outcome of 10b). The answer still states them, so the box stays open.
- [x] Unit cases for `findUnsupported`: same number, same employer, different result → flagged; same number and result → not flagged; Portuguese answer with an English note → not flagged.
- [x] False-alarm rate of the neighborhood check measured and recorded here before it ships. It was measured on the replay answers, not on the eval set (see Outcome of 10b).
- [x] A personal answer naming a technology from the "not used" list is marked in the panel (10b). The other half is met: with the addendum line, the 2026-10-29 turn (forced with `--arm`, since item 9's gate now skips it) names none.

### Outcome of 10a (2026-10-30)

What shipped:
- The career addendum keeps each number with the result, project and employer the notes give it, forbids estimates, and places a technology at an employer only when the notes say it was used there.
- The manifest takes `notUsed`. The addendum names those technologies as never used: at most 30, not on an invitation.
- Answers with notes injected run at temperature 0.3; the others keep 0.7. The prompt for answers without notes is byte-identical.

**Unchanged:**
- `npm test`;
- the live eval offline, regex and Jev: zero check, label, route or notes differences;
- the KB eval: identical apart from timings.

**Replay with real LLM.** Ten career turns of the two sessions, one answer each, `openai/gpt-oss-120b`, counted by hand against the notes block:

| Run | Answers | Metric invented or moved to another result | Technique placed at an employer from a hypothetical note | "Not used" technology claimed |
|---|---|---|---|---|
| Before (main, 0.7) | 10 | 4 | 1 | 1 |
| First rule wording, 0.3, list | 10 | 3 | 1 | 0 |
| Shipped wording, partial | 4 (3 career) | 1 | 0 | 0 |

No answer came back empty or PASSIVE, and no new kind of error appeared. Median length: 94 words before, 95 with the first wording.

The prompt cuts the "not used" claims but does not stop a real number from moving to another result. That needs the check (10b).

### Outcome of 10b (2026-10-30)

What shipped, in `findUnsupported` (spec FR-021, E52–E56):

- **Neighborhood check.** A result number is a percentage, money, a duration or a multiplier ("3x", "3‑5×"). When only the notes block holds it, it passes only if a note line holds it together with two things:
  - a content word within five words of it in the answer, with direction words ("redução", "cut", "faster") left out and a short English–Portuguese list of measures ("custo"/"cost", "tempo"/"time");
  - the known name the answer's line gives it, found in the note line, its section title or the heading above it.
  - Otherwise it is listed as "40% (other result)".
  - A number the question or the transcript holds passes on presence. A bare number ("5 workers") is checked on presence only: it is a parameter more often than a result.
- **Never-used technologies.** A `notUsed` name is listed as "Tidewire (never used)" when it meets three conditions:
  - its sentence is in the first person or names a known employer;
  - its clause has no negation or "instead of";
  - the answer is not an invitation.
  - The addendum's own list does not count as support.
- **The panel's tooltip** explains both labels.

**False alarms, on the replay answers.** The eval set does not work for this: the live eval report keeps a count of marks per item but not the notes block, so a mark there cannot be labeled. Instead, the measurement used the replay answers that kept the block the model saw: the career turns of the 2026-10-28 and 2026-10-29 sessions, from 10a's and 11's runs. Old check against new, each new mark labeled by hand against the block:

| Answers | New marks | Real errors | False alarms | Marks removed |
|---|---|---|---|---|
| 24 | 7 | 7 | 0 | 0 |

The real errors:
- one "never used" technology claimed (the case in 10a's "before" table);
- a "3‑5x" from another result, in two answers (both ends of the range listed, so four marks);
- an error rate the notes do not give;
- one end of an invented response-time change whose other end the presence check already marked.

The two candidates a first, cruder rule raised as false alarms passed:
- "erros" against "errors";
- a percentage the notes write as a word ("half"). The words near it matched.

The sample is small. 11's replay adds answers when the Groq limit allows, and the measurement can be redone on them (the script is local, outside this repo).

**Unchanged:**
- `npm test`.
- The live eval offline (137 items), with the same score: 130 pass, 6 warn and 1 fail, the fail already on `main`. The "no unverified names or numbers" check is the same on every item, since the stub answers hold no number from the notes. The rest of the run differed in two places, neither of which the check can cause, since it runs after the answer:
  - two first-token timing checks swapped;
  - two items took one note chunk more or less.

### Pending from 10a (run at the start of step 6, with item 11's)

The Groq daily token limit ran out mid-measurement, and again at the start of step 4. When it is back:

1. **Finish the replay of the shipped wording.** Six turns are missing:
   - command: `--resume` on the same `--arm` lists, with `--answers-for arm`;
   - record the three columns above for all ten turns.
2. **Run the live eval with the judge**, `npm run eval:live -- --text --only A,B --judge`, and compare with the run before 10a (23 pass, 9 warn, judge mean 4.87, routes 10/12).
   - Run it on commit `77ee925` (a worktree): 10a's code and the word counts, without item 11's prompt. Leave out the two length checks when counting pass and warn.
   - Accept: judge mean not lower, same route accuracy.
   - If the mean drops (answers drier under the stricter rule), revisit the wording before item 11 builds on it.
   - The same run gives item 11 its "before" lengths.

---

## 11. Live Answer — answers too long to read while speaking

**Status:** Done, measurements pending — 2026-10-30, branch `2026-10-30-live-answer-length` (step 4 of the work order). The prompt budget shipped before any real-LLM run, because the Groq daily limit was used up; see "Pending from 11". Found on 2026-10-28 in the same session as item 9.
**Severity:** MEDIUM
**Code:** the user message in `makeLiveAnswer` (`src/features/listen/summary/summaryService.js`, "Answer … directly and concisely", `maxTokens: 900`). Related: `specs/2026-06-01-interview-live-answer-readability/`.

### Summary

Of the 34 answers in the session: median about 100 words, 17 over 100, 7 over 150, longest 292. The long ones add a closing paragraph ("Em resumo …", "Resultado: …") and extra sections ("Como calculo a proporção:", "Governança:"). The prompt asks for concision but sets no budget. The transcript shows the candidate stuttering while reading the long ones.

### Proposed

1. **A budget in the prompt:** one headline sentence, at most 3 bullets of about 15 words each, about 60 words in all. No closing paragraph, no extra headed sections, no restating the question.
2. **Leave `maxTokens` at 900 for now.** The gpt-oss models reason before answering; if the provider counts reasoning tokens against the cap (to confirm for Groq), a low cap gives empty or cut answers. Change the prompt first, measure, then decide.
3. **Optional, in the panel:** show the headline and the first 3 bullets, and fold the rest behind a "more" line, so what is worth reading stays in view when the model runs over.
4. **Measure:** compare word counts per answer before and after from `live_answers` (`scripts/export-live-answers.js` exports a session), and add a "≤ N words" check to the live eval.

### Acceptance (when implemented)

- [ ] On the live eval and the next real session, median ≤ 60 words and no answer over 120, with no rise in empty or cut answers.
- [ ] No answer ends with a summary paragraph.
- [ ] If the panel fold ships: an answer over 3 bullets shows the headline and 3 bullets, and the rest opens on click.

### What shipped (2026-10-30)

- **The budget, in the live answer instruction** (`LENGTH_RULE`, `summaryService.js`): a one-sentence headline, at most 3 bullets of about 15 words, about 60 words in all, no closing summary, no extra headed sections, no restating the question. Every route gets it.
  - `pickle_glass_analysis` is unchanged: it is closed, and Ask shares it.
- **`maxTokens` stays 900.** Proposed step 2 is answered by the code: `groq.js` adds 1024 tokens for gpt-oss's reasoning, and Anthropic raises the cap to 4096 on models that think, so the cap does not end an answer inside the reasoning.
- **Word counts:**
  - the live eval warns on an answer over 120 words, and on bullets followed by a closing paragraph;
  - its aggregates give the words' median and maximum;
  - the session replay and `export-live-answers.js` print the same.
- **The panel fold (step 3) did not ship.** It comes back only if the "after" measurement still shows answers over 120 words.

**Before, the real sessions** (`export-live-answers.js`):

| Session | Answers | Median words | Longest | Over 120 |
|---|---|---|---|---|
| 2026-10-28, Portuguese | 34 | 95 | 275 | 10 |
| 2026-10-29, English | 17 | 72 | 182 | 3 |

**Unchanged, without an LLM:**
- `npm test`;
- the live eval offline: no check, label or route differences beyond the two new checks.

### Pending from 11 (run at the start of step 6)

1. **Replay before and after, gpt-oss-120b, one answer per turn.**
   - Turns: the ten career turns of 10a's replay, plus the seven Portuguese turns whose real answers ran over 120 words.
   - Before: commit `77ee925`, in a worktree. After: `main`.
   - Record the median and longest answer, the count over 120, the answers that end in a paragraph, and any empty, cut or PASSIVE answer.
   - This replay also gives 10a's "after" table.
   - **Done so far (2026-10-30):** 3 of the 17 "after" answers and 2 "before", then the daily limit ran out again (each answer takes about 6,500 tokens, so the two replays alone need more than a day's 200,000).
     - After: 46, 55 and 72 words. None ends in a paragraph, and none is empty or PASSIVE.
     - The two turns run on both sides went from 100 to 72 words and from 70 to 55.
     - The answers stayed in that session's scratchpad, so step 6 reruns all 17 on each side. Plan two days: "after" first, then "before", then the judge.
2. **The live eval with the judge**, `--text --only A,B --judge`, after (on `main`), against 10a's run before (on `77ee925`, "Pending from 10a").
3. **Accept** with: median ≤ 60, nothing over 120, no closing paragraph, no rise in empty, cut or PASSIVE answers, and a judge mean not lower.
   - If the judge mean drops, or the median lands over 70, revise the wording once and measure again. Answers too thin to carry a career result are the risk to look for.
   - If it still misses, record the result here and propose the fold.

---

## 12. Live Answer — the one-line reply to a confirmation check comes out in Portuguese

**Status:** Done on 2026-10-30, branch `2026-10-30-confirmation-check-language` (step 1 of the work order at the top of this file). The rule picks its tags and examples by the turn's language: spec FR-004 and D5.
**Severity:** LOW (visible, easy to fix)
**Code:** `confirmationCheckRule` (was `CONFIRMATION_CHECK_RULE`) and its use in `makeLiveAnswer` (`src/features/listen/summary/summaryService.js`); `answerLanguageRule` (`src/features/listen/summary/questionLanguage.js`). Spec: `specs/2026-10-16-confirmation-check-answer/`.

### Summary

Two English turns ending in "Okay?" ("… in case we decide to advance with you to the interview with the client … Okay?", "So we will be in touch … Okay?") got "Perfeito, está claro." and "Combinado, obrigado.". The rule's examples are in Portuguese only, and the model copies them word for word, overriding the language rule in the same message.

### Proposed

1. Give the examples in both languages ("Perfect, that's clear." / "Sounds good, thanks."), or pick the example by `questionLanguage(asked)`.
2. Say in the rule itself that the reply follows the turn's language.

### Acceptance (when implemented)

- [x] A unit case: an English turn ending in "Okay?" builds a rule whose example is in English; a Portuguese one keeps the Portuguese example.
- [x] Live eval: an English confirmation check gets an English one-liner (`en-next-steps`: "Sounds good, thanks."; the 2026-10-29 session replayed: "Sounds good, thank you." for both turns).

---

## 13. Live Answer career context — a question about the candidate's own setup routes general

**Status:** Done — 2026-10-31, branch `2026-10-31-career-route-setup` (step 7 of the work order). Found on 2026-10-29. Related: item 5 ("English questions about the candidate that still route general"). See **Outcome** below and research R22 (`specs/2026-10-13-career-router-jev/research.md`).
**Severity:** MEDIUM (the answer invented a setup)
**Code:** `classifyCareerIntent` (`src/features/common/career/intentRouter.js:268`), the Jev router (`jevRouter.js`), the regex fallback (`routeFallback`, `src/features/common/career/index.js:374`)

### Summary

A turn about the candidate's AI setup ("you can arrive with your AI setup, your CLAUDE.md, the skills you usually use … being able to explain your setup") routed **general** (`regex(low)`: Jev gave no route and no regex cue matched), so no notes were sent. The model then described a setup of its own: a Python LLM framework, a different vendor's model and a test runner, none of which the candidate uses; the notes describe the real one (an agentic coding CLI with specs, skills, hooks and MCP).

### Proposed

1. Regex cues for the candidate's tools and way of working: "your setup", "your (AI) setup", "your skills", "the tools you use", "your workflow", "how you use AI", "seu setup", "suas skills", "como você usa IA".
2. Add the shape to Jev's labeled set if it keeps routing general.
3. Measure as in item 5: a small held-out set written before the change; count questions about the candidate routed general before and after.
4. **The opposite error, from item 9 (2026-10-30).** Item 9 fixed the extracted span, but the route is still decided on the whole turn. Two technical questions in the 2026-10-28 replay route personal:
   - the scalability turn ("escalável pelo quê?"): `jev:personal@0.60` in one run, regex fallback to `general` in another;
   - a scenario question led by "você conhece algum recurso…" (regex `experience:pt-voce-habito`).

   Add both shapes, anonymized, to item 5's held-out sets as general. Measure whether passing the extracted question to the router helps (`router.decide(turnText)`, `src/features/common/career/index.js:368`).

### Acceptance (when implemented)

- [x] A direct question about the candidate's setup, anonymized, routes personal and gets the setup note. (Not the 2026-10-29 turn itself: it has no question, and after item 9 it gets no answer.)
- [x] On item 5's held-out sets, no question about the code on screen moves to personal (the live-coding guard there still holds). R16's and R17's sets were never saved to a file, so a new set of 20 technical and live-coding turns with the same words stands in (see **Outcome**).

### Outcome (2026-10-31)

- **What changed.** Jev's `personal` criterion adds how the candidate works (the tools, setup and workflow they use, including how they use AI); `general` adds a question about the code or the solution being worked on in the interview, even with "you" or "your" (`jevClient.js`). The regex router gets `background:your-setup` and `background:pt-seu-setup` (`intentRouter.js`): the live case was decided by the regex, Jev below its floor. The comment that freezes the regex router now names that exception.
- **The check.** A new set of 36 turns, written before any router ran on them and kept in the KB repo: 16 questions about the candidate's setup and AI workflow, and 20 technical or live-coding turns with the same words, including the two 2026-10-28 shapes. Jev ran twice before and twice after.

  | Check | Before: regex / Jev | After: regex / Jev |
  |---|---|---|
  | 16 setup questions routed general | 9 / 2, 2 | 4 / 0, 0 |
  | Setup note sent (11 questions with one) | 1 / 5, 5 | 3 / 6, 6 |
  | 20 technical turns routed personal | 2 / 4, 4 | 2 / 1, 2 |
  | Eval (133) and synthetic (40): confusion matrices | — | unchanged, both routers |

  The direct acceptance question routes personal and sends the setup note with both routers. The regex cues were written after reading the 16 questions, so the regex column there is a tuning figure; the Jev columns and the 20 technical turns are a test. The two technical turns the regex still routes personal come from older cues: item 5's live-coding guard.
- **Replays** (`--router jev`, no LLM). 2026-10-28: the scenario turn ("você conhece algum recurso…") routes general, route errors 1 → 0; "escalável pelo quê?" stays general. Unlabeled armed turns that moved: technical questions to general, two questions on how the candidate steers an agent to personal, and one hypothetical about an API's rate limits from ambiguous (0.59–0.60) to below Jev's floor, where the older regex cue `behavioral:example-when-you` routes it personal. Not fixed here: that cue is item 5's.
- **Routing on the extracted question** (proposed step 4). Over the 185 recorded turns whose extracted question differs from the turn, it fixes the scenario turn but takes the labeled route away from 22 turns with the regex and 14 with Jev. Not adopted; `resolve` still routes the whole turn.
- **Unchanged.** `npm test`, and the offline live eval (no route or label differences; one timing check and two note-chunk counts that also differ between two runs of the same code). Jev below the floor on the eval: 12 → 14 of 133.

---

## 14. Live Answer career context — the live check marks technical constants as claims

**Status:** Done — 2026-10-30, branch `2026-10-30-live-check-constants` (step 5 of the work order). Found on 2026-10-29.
**Severity:** LOW (noise that hides the real marks)
**Code:** `findUnsupported` (`src/features/common/career/answerCheck.js`)

### Summary

In the 2026-10-29 session the check marked "429" (an HTTP status in "avoids 429 errors") and "300" (an illustrative threshold, "e.g., > 300 lines") as unverified, while the invented "30%" and the unused technology passed (item 10). Marks on constants teach the reader to ignore marks.

### Proposed

1. Skip HTTP status codes next to HTTP words ("429 errors", "a 503", "status 404", "HTTP 500"): 3-digit numbers from 100 to 599 within a few words of "error", "status", "HTTP", "response", "code".
2. Skip numbers inside an example frame: "e.g.", "for example", "por exemplo", "like > N", "such as".
3. Keep marking percentages, money and durations everywhere: those are the claims that matter.

### Acceptance (when implemented)

- [x] Unit cases: "avoids 429 errors" and "(e.g., > 300 lines)" → not marked; "cut latency by 30%" with no 30 in the notes → marked.
- [x] On the 2026-10-28 and 2026-10-29 sessions' answers (replayed against their notes), the marks left are only real claims. The Portuguese ones are test-coverage percentages the answer gives as the candidate's practice; rule 3 keeps them on purpose.

### Outcome (2026-10-30)

What shipped, in `findUnsupported`:

- Each number gets a kind: percentage, money, duration or bare.
  - A percentage written with a space ("50 %", also a no-break space) is now read as one, and listed as "50 %". Before, it was listed as a plain "50".
  - The first number of a range ("15–20 %") counts as a percentage too.
- A bare number is skipped as a constant in three cases:
  - an HTTP status (100–599) within two words of error, status, HTTP, response or code, in English or Portuguese;
  - a number after an example marker ("e.g.", "for example", "such as", "por exemplo", "ex.:") in the same sentence, at most 6 words on;
  - the same value repeated later in the answer.
- Percentages, money and durations are never skipped, inside an example too.
- The accepted cost: "cut 500 errors a day" is not checked. A list of real status codes would not help, since 500 is one.

**The real sessions' marks, old code against new** (a stored mark counts as kept when the new code still lists its number):

| Session | Marks before | After | Dropped |
|---|---|---|---|
| 2026-10-28, Portuguese | 6 | 5 | an example value, repeated later in the same answer |
| 2026-10-29, English | 4 | 2 | the HTTP status and the example threshold |

- English keeps the invented buffer size and the invented latency percentage, now listed as a percentage.
- Over every number in the 52 real answers, with nothing given, the new code drops nine. All are constants: decimal scales, example values, the HTTP status and the threshold. No percentage was dropped.
- On the replayed answers, the only difference is a label: "50" became "50 %".

**Unchanged:**
- `npm test`;
- the live eval offline (regex), 137 items: same score (130 pass, 6 warn, and the 1 fail already on `main`, a stress turn the gate misses), no label or route differences.
  - Two answers swapped the first-token timing check.
  - Two answers got one note chunk fewer.
  - The check runs after the answer, so it cannot change either, and the notes did not change between the runs.

---

## 15. STT — interview terms heard as other words

**Status:** Done (2026-10-31, branch `2026-10-31-stt-interview-keyterms`). Measured on 2026-11-01 (branch `2026-11-01-stt-keyterms-measure`): acceptance box 1 is not met, see **Measurement**. Found on 2026-10-29 in an English session.
**Severity:** LOW to MEDIUM (wrong words reach the extracted question and the note search)
**Code:** `TECH_KEYTERMS` (`src/features/listen/sttKeyterms.js`); Deepgram only.

### Summary

What the transcript had, and what was said:

| Heard | Said |
|-------|------|
| "IP token" | API token |
| "railing meets", "reclimiter", "rig limit" | rate limits, rate limiter |
| "AR", "a yard", "the air" | AI |
| "Club MD" | CLAUDE.md |
| "coordination" (as in "the coordination produced a change") | probably the coding agent's name |
| "non warfare channels" | unbuffered channels |

The extracted question for one turn was "how you take benefit of **a yard** to build the things".

### Proposed

1. Add to `TECH_KEYTERMS`: "API token", "rate limit", "rate limiter", "AI", "CLAUDE.md", "Claude Code", "unbuffered", "buffered channel". Watch the size cap (`MAX_KEYTERMS`, about 500 tokens at Deepgram).
2. Check whether "AI" as a two-letter keyterm biases ordinary words; drop it if the live eval gets worse.
3. Re-run the live eval's audio items (`scripts/live-eval/audioFeeder.js`) before and after.

### Acceptance (when implemented)

- [ ] The live eval's word error on the added terms goes down, and no other item gets worse. **Not met** (2026-11-01, see **Measurement**): no other item got worse, but the terms heard right stayed at 7 of 12. The clean TTS voice already heard five of the eight new turns right without the new terms, and "Claude Code" and "CLAUDE.md" stay wrong with them.
- [x] The keyterm list stays under Deepgram's cap (`sttKeyterms` unit tests).

### Outcome (2026-10-31)

- **Added to `TECH_KEYTERMS`:** "API token", "rate limit", "rate limiter", "unbuffered channel", "buffered channel", "Claude Code", "CLAUDE.md", "AI agent", "AI tools", "AI setup".
- **"AI" goes only inside phrases.** Step 2 (does a two-letter "AI" bias ordinary words?) needs the audio measurement. Until then, phrases give the term context without boosting "AI" alone; Deepgram's own guidance is to avoid short, broad keyterms. Add "AI" alone only if the measurement shows the phrases do not fix "a yard" / "the air".
- **The cap:** `MAX_KEYTERMS` is now the 50 names plus the whole fixed list (93), so the fixed list always fits; before, 50 names would have cut its last terms.
- **The token cap (500 per request):**
  - a test estimates one token per 3 characters of each term;
  - the fixed list comes to about 134 tokens;
  - with 50 names of 20 characters, the whole list stays under 500.
- **The real notes:** they give 47 names, so the list comes to 90 terms and about 280 estimated tokens. Every technical term is kept, and each one goes to Deepgram as its own `keyterm=`.

### Measurement (2026-11-01)

- **The turns:** eight invented interviewer turns with the terms joined phase A of the live eval (`fixtures/interview.json`): six in English and two in Portuguese, one of them "AI" alone. Each lists its terms in `sttTerms`, and the eval now warns when the transcript misses one ("STT heard the key terms").
- **The runs:** phase A in audio twice, on the same cached Gemini TTS clips. "Before" swapped in the keyterm list from before this item (80 terms sent); "after" used the current one (90 terms sent, as the app log shows). The LLM was replaced by the local stub (`--llm-models` with a blocked model), so the only quota spent was about 16 minutes of Deepgram streaming (two runs of about 4 minutes, two sessions each) and 10 TTS clips.

| Turn | Before | After |
|---|---|---|
| API token, rate limits, rate limiter, unbuffered/buffered channel, AI, AI tools (English, 5 turns) | all heard right | all heard right |
| "Claude Code" (English and Portuguese) | "Cloud Code" | "Cloud Code" |
| "CLAUDE.md" | "Cloud. Md" | "Cloud. Md" |
| "unbuffered channel", "buffered channel" said in Portuguese | "Ambuffer Channel", "Buffer Channel" | "unbuffer channel", "buffer channel" |

- **Terms heard right:** 7 of 12 before and after. The Portuguese channels moved closer but still miss the "-ed".
- **The other 17 turns of phase A:** none got worse, and three got better (all within the noise of one or two words). The mean word error went from 0.051 to 0.038.
- **What it shows:**
  - The keyterms change nothing that a clean voice gets wrong, except the English words inside a Portuguese sentence.
  - "Claude" is heard as "cloud" with the keyterm or without it.
  - A clean voice already hears the English terms that the real speaker on 2026-10-29 lost, so this run cannot show whether the list fixes those.
- **Open:** "Cloud Code" and "Cloud. Md" are not fixed by keyterms. A fix would need something else, for example Deepgram's find-and-replace or a rewrite of the transcript before the question is extracted. That is a new decision; nothing was changed for it.

---

## 16. Ask — a System Design mode that follows the live interview

**Status:** Done on 2026-10-31, branch `2026-10-31-system-design-live-mode`. Found the same day, by reviewing a System Design answer against a standard interview flow. Outside the work order at the top.
**Severity:** MEDIUM
**Code:**
- the profile `pickle_glass_system_design_live` (`src/features/common/prompts/promptTemplates.js`);
- `askPrompt.js` (the mode, the context block, `isLiveDesignKit`) and `askService.js` (`listenTranscript`, `lastLiveDesign`);
- the mode lists in `featureBridge.js`, `ModePickerView.js`, `MainHeader.js` and `windowManager.js`;
- live eval phase H.

### Summary

The System Design Ask answers the problem name with a 12-section essay: a ~3,900-token prompt and a ~4,200-token answer. Read during an interview, it has the wrong shape:
- It writes the requirements "as if the interviewer just confirmed them", and commits to a scale before any question.
- It can't use what the interviewer said: Ask gets no Listen transcript, and each Ask is a single turn.
- What to say next sits somewhere in twelve sections. There are no check-ins and no walkthrough of the write and read paths, and the Baseline → 10× → multi-region phases are forced whatever the requirements.
- A run on "twitter" (qwen3.8-27b):
  - skipped Section 0;
  - overestimated storage and bandwidth about 100× (the prompt's own "100 KB image-meta" default, plus items per page counted twice);
  - contradicted itself on push vs pull fan-out.

  Phase E checks only the headings, so none of this fails the eval.

### Decision

A new mode, **System Design · Live** (`system_design_live`), next to `system_design`. `system_design` stays as it is: its profile is byte-identical, and a unit test holds its hash. (2026-11-01: item 17 fixed the `system_design` content in place and kept its flow. The hash test is replaced by tests of the fixes.)

### What shipped (2026-10-31)

- **Routes**, picked by what is typed. Word budgets in brackets:
  - probe, for the interviewer's question (90);
  - deep dive, for a named part (300);
  - full, both kits, for practice;
  - design, when the requirements are stated in the transcript, the typed text or the screenshot, or the typed text is just `design` (750);
  - opening, when only the problem is known (450).
- **Opening kit:** Frame, Scope, Questions, Assumptions, Estimates, Check-in. The estimates use per-day formulas, count requests apart from items, and give fan-out writes.
- **Design kit:** Requirements used, API, Design (numbered diagram, write and read paths, storage table, Decisions), Deep dives, Check against requirements, Next questions.
- **In every answer:** lines to say aloud are quotes, values are marked (confirmed) or (assumed), and multi-region appears only when the requirements need it.
- **Context, in this mode only:**
  - the Listen transcript (30 turns);
  - the session's last kit answer, cut to 6,000 characters.

  A deep dive or a probe doesn't replace the kit, so the next question still builds on the design. It lives in memory: an app restart forgets it.
- **UI:** the picker lists five modes (window 184 × 178). The header pill reads "Ask · SD Live". The header window grew from 393 to 424 px: with the shortcut chips shown, every mode label (Code, Debug, SysDes, SD Live) wrapped onto two lines at 393. The widest pill measures 416 px.
- **Follow-up (2026-11-01):** a typed `twitter` with only a desktop on screen once got the "No problem yet" line. The answer came from Gemini Flash-Lite: the screenshot moves the models that see images first, and Qwen was skipped for its key's 1,000-token output limit. About 60 retries on every model of the list, the real screenshot included, all gave the opening kit, so it was a rare misroute. The prompt now says that a product or system name typed alone is a problem to design and that a screen with no problem on it never cancels it, and phase H gained case H6 (`twitter` over `fixtures/desktop.svg`).
- **Prompt size:** ~3,100 tokens (Groq counted 3,088 in), ~4,700 with a previous answer. System Design's is ~3,900.

### Measurement (live eval, `--text --only E,H --judge`)

The first run failed H1 and overran the budgets. Three prompt fixes followed:
- a screenshot that writes out the requirements counts as confirmed;
- "design" triggers only as the whole typed text;
- a fixed shape for the probe, hard budgets, and per-day estimate formulas.

Last run:

| Case | Route | Words | Judge |
|---|---|---|---|
| H1 rate limiter screenshot | design | 628 | 5 |
| H2 "Design a Twitter-like feed." | opening | 381 | 5 |
| H3 `design` after the interviewer's answers | design | 646 | 4 |
| H4 deep dive, on H3 | deep dive | 261 | 5 |
| H5 interviewer's question, on H3 | probe | 83 | 5 |

- 0 fail. The warnings:
  - fallbacks: Groq's free tier allows 8,000 tokens per minute, and the eval sends five ~4k-token Asks in a row (in an interview they are minutes apart);
  - H5's spoken first line, at 31 words.
- Phase E passed (judge 5/5), with its prompt unchanged.
- The pro judge models were out of quota, so gemini-3.5-flash-lite judged.

### Open

- The eval passes the phase A/B transcript to Ask phases C, D and E. The app never does: outside System Design · Live, Ask gets no transcript. Separate from this item. (2026-11-01: phase E no longer does, item 17. C and D still do.)
- The `system_design` profile kept the issues above (the stale "Opening 30s pitch" exemption, the 100 KB default). Fixed by item 17 (2026-11-01).

---

## 17. Ask — fix the System Design mode's content, keeping its flow

**Status:** Done on 2026-11-01, branch `2026-11-01-system-design-ask-fixes`. Comes from the issues that item 16 found and left in place. Outside the work order at the top.
**Severity:** LOW-MEDIUM
**Code:**
- the profile `pickle_glass_system_design` (`src/features/common/prompts/promptTemplates.js`);
- live eval phase E (`scripts/live-eval/run.js`, `fixtures/system-design-cases.js`, `judge.js`, `checks.js`).

### Summary

System Design is the simpler mode: one Ask gives one complete written design, in twelve sections. Item 16 left its prompt alone, with these issues:
- **Estimation defaults.**
  - "100 KB image-meta" made storage about 100× too high.
  - Nothing kept items/s apart from requests/s, so a timeline read was multiplied by 20 items per page.
  - Nothing kept egress from being counted twice.
- **Requirements as fact.** They were "written as if the interviewer just confirmed them".
- **Typed constraints had no rule.** A problem typed with constraints ("twitter, 10M DAU, feed only") matched neither Rule A nor Rule B.
- **Rule B pointed at nothing.**
  - A deep dive came out as twelve "(unchanged — see prior turn)" lines plus the target. Each Ask is a single turn, so there is no prior turn.
  - The Rule C line and the "Opening 30s pitch … Section 10" exemption were stale.
- **Nothing kept the sections consistent.** Push vs pull could be decided twice, and §8 could name workers that the diagram didn't have.
- **Multi-region was forced** even when only one region was given.
- **Phase E saw none of this.**
  - It had one case and checked only headings, numbers and the screenshot's requirements.
  - It sent the phase A/B transcript, which the app never sends to this mode.

### Proposed

Fix the content, and keep the flow: one Ask, the twelve sections, Rule B for a deep dive, the three phases, and no transcript. Measure it with a phase E that can see each issue.

### Acceptance

- [x] Phase E on the old prompt fails the new checks:
  - E1 and E2: no (given)/(assumed) marks;
  - E2: a full multi-region Phase 3 for "US only";
  - E3: the placeholders, judge 1/5.
- [x] Phase E on the new prompt has 0 fails in four runs in a row.
- [x] Unit tests hold the twelve sections and each fix in the prompt.

### What shipped (2026-11-01)

- **Rule A** also takes a problem with its constraints. Typed or on-screen constraints are used as given and marked (given).
- **Rule B** answers alone, under `## Deep dive: <target>`, with no placeholder lines. It states the numbers it relies on and never points at another section.
- **§0** is the first line. Its peak QPS is the one §3's formula gives, never a guess.
- **§2:** every requirement ends with (given) or (assumed), with an example line in the prompt.
- **§3:**
  - read requests/s are counted apart from items/s, with no multiplying by items per page twice and no extra safety factor;
  - egress = read requests/s × response size, counted once;
  - fan-out writes/s = writes/s × average followers.
- **Defaults:**
  - a text post with metadata ~1 KB;
  - image metadata < 1 KB;
  - an image 200 KB–2 MB;
  - read availability usually 99.99%.
- **Phase 3** for one region: 2 bullets, **Trigger** and **First step**. The full delta comes only when the requirements need more than one region.
- **Consistency:** §7–§11 never contradict the Trade-off Roll-up, and every component a mechanism relies on is in the diagram or a Phase 2 delta.
- **Removed:** the Rule C line and the stale exemption.
- **Prompt size:** about 17,600 characters, up from 15,900 (~+430 tokens, ~4,300 in all).
- **Phase E:**
  - three cases, each with no transcript, as in the app:
    - E1, the rate-limiter screenshot;
    - E2, `twitter, 10M DAU, home timeline only, US only`;
    - E3, `deep dive on the cache`;
  - new checks:
    - no placeholder;
    - §0 comes first;
    - ≥ 3 (given)/(assumed) marks in §2;
    - the typed scale is used;
    - Phase 3 has ≤ 3 bullets for one region (warn);
    - a deep dive opens with `## Deep dive:` and has no §0, names TTL, names stampede handling (warn), and stays ≤ 600 words (warn);
  - the judge's rubrics also score estimate sanity, consistency between sections, and requirements marked as assumed.

### Measurement (live eval, `--text --only E --judge`)

| Run | E1 screenshot | E2 typed constraints | E3 deep dive |
|---|---|---|---|
| old prompt | 0 marks (fail) · judge 5 | 0 marks (fail), Phase 3 of 5 bullets · judge 5 | 12 placeholder lines (fail) · judge 1 |
| new prompt, 4 runs | 9–10 marks, §0 first · judge 5, 5, 5, 5 | 9–10 marks, Phase 3 of 1–2 bullets, 10M used · judge 5, 5, 5, 5 | ~270–350 words, alone · judge 4, 5, 5, 5 |

- **On the old prompt, E2 repeated the original errors:**
  - 6.6k read requests/s × 20 items, with a "5× safety factor" on top: 660k read ops/s;
  - a 5 KB tweet;
  - 3.3 GB/s of ingress.

  The judge still scored it 5/5. The deterministic checks, not the judge, are what catch these issues. The new prompt gives 6k peak QPS, 1 KB posts, 118 MB/s egress and 11 TB a year with 3 replicas.
- **Answered by:** E1 by gemini-3.5-flash-lite (the screenshot moves vision models first), E2 by gpt-oss-120b or gemini-3.5-flash-lite, E3 by gpt-oss-20b.
- **Warnings:** all from fallbacks under Groq's per-minute token limit.
- **During tuning:**
  - gpt-oss-20b once left the marks off; the §2 example line fixed it;
  - gpt-oss-120b once wrote Trigger and First step plus two extra bullets (a warning).

### Open

- A deep dive with no problem in the request makes up its own scale (e.g. 50M DAU), marked as assumed. Typing the problem along with the target ("deep dive on the cache for twitter, 10M DAU") gives it the right numbers.

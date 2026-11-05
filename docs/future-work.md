# Future Work

Deferred enhancements that are intentionally **out of scope for their current version** but worth tracking. Each item links to its GitHub tracking issue (on the `tas88-sys/glass` fork) where applicable.

---

## Work order for items 9 to 15 (agreed on 2026-10-30)

One step at a time, each with its own plan, a fresh session per step. When a step is done, tick it here, set the item's **Status** to Done with the date and branch, and start the next session from this list.

| Step | Item | Why here |
|------|------|----------|
| [x] 1 | 12. Confirmation one-liner in the wrong language | Small and isolated. It touches the same prompt as 10 and 11, so it goes first and sets up the prompt test and eval loop. |
| [x] 2 | 9. The extracted question picks the wrong span | First stage of the flow: it decides whether a turn is answered and which span goes to routing and the note search, so the evals of 10 and 11 run on the right questions. It also stops the answers to reported questions that produced the "not used" technology claim. |
| [x] 3 | 10a. Prompt rule, temperature 0.2–0.3 on personal/ambiguous, "not used" list in the addendum (item 10, steps 1 and 4 first half) | The only HIGH item, and its cheap half. The "not used" list needs a `notUsed` field in the career KB manifest, which lives in the separate, private KB repo. **Merged with two measurements pending**; both run on 2026-11-01 (item 10, "Measurement of 10a"). Its judge-mean drop is within the spread between runs (same section). |
| [x] 4 | 11. Answers too long | Same prompt. After 10a because the lower temperature already changes answer length; measured before 10a, the numbers would be stale. **Merged with its measurements pending**; run on 2026-11-01, together with 10a's (item 11, "Measurement"). |
| [x] 5 | 14. The live check marks technical constants | `findUnsupported`. Before 10b: 10b needs its false-alarm rate measured, and that is not readable with this noise in. The Groq daily limit ran out again after 3 of the pending answers, so 10a's and 11's measurements move to the start of step 6. |
| [x] 6 | 10b. Neighborhood check and marking "not used" technologies (item 10, steps 2–3 and 4 second half) | Same file as 14, now without the noise. Measured offline on the replay answers that kept their notes. 10a's and 11's real-LLM measurements were run on 2026-11-01 (item 10, "Measurement of 10a"; item 11, "Measurement"). |
| [x] 7 | 13. A question about the candidate's own setup routes general | After 9, since the 2026-10-29 turn had no question and should then get no answer; what is left are real questions about the setup. Uses item 5's held-out sets, so it can share a plan with item 5. |
| [x] 8 | 15. STT terms heard as other words | Independent, lowest severity, costliest to measure (audio eval before and after). Can move into any gap. Merged with its measurement pending; **measured on 2026-11-01**. The new terms did not raise the count heard right (7 of 12 before and after), and "Claude Code" is still heard as "Cloud Code" (item 15, acceptance box 1, still open). |

Items 16 (System Design · Live, 2026-10-31) and 17 (System Design fixes, 2026-11-01) came in outside this order. Item 18 (System Design · Live without typing, 2026-11-01) is a list of proposals; its v1, 18.11, was built on 2026-11-02 (branch `2026-11-02-system-design-live-no-typing`), with the checks in the app still to do. 18.12 (changes in red when `design` is typed again after a change, 2026-11-04) is planned and not built.

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

**Status:** 10a done — 2026-10-30, branch `2026-10-30-career-answer-grounding` (step 3 of the work order), measured on 2026-11-01 (below). 10b done — 2026-10-30, branch `2026-10-30-career-check-neighborhood` (step 6). Found on 2026-10-28 in the same session as item 9.
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
  - **Measured again on 2026-11-01** (shipped wording, item 11's length rule): the concurrency turn moved a percentage the notes tie to a cost onto a run time, and 10b's check did not mark it. The same day the check was narrowed so it does (see "Follow-up of 10b"). The answer still states the number, so the box stays open.
  - **Card split, measured on 2026-11-02:** with one line per result in the card, 0 of 5 replays of the turn state a number. Without it, 0 of 5 move one either, so the test cannot credit the split: inconclusive by the rule set before the run (see "Card split"). The box stays open.
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

### Follow-up of 10b (2026-11-01)

**The miss.** In 10a's measurement, the concurrency turn put a percentage on a run time, and the check let it pass. The notes give that percentage to a cost, on a line that holds several results separated by `;`. The check compared the answer's words with the whole note line, and two of them were on that line by chance: one from the next result ("backups"), and "time" from a "launch on time" further on.

**The fix** (`fitsNotes`, spec FR-021, E57): when the note line holds several numbers, only the words near the matched number count, within five words and inside its own clause, up to a `;` or a sentence end. A line with a single number is checked as before.

**Measured on the 47 replay answers that kept their notes block** (10a's and 11's runs):

| Rule on the note side | New marks | Real | False alarms | Marks removed |
|---|---|---|---|---|
| A window of 5, 7 or 10 words around the number | 0 | 0 | 0 | 0 |
| The same window, stopped at the clause | 1 | 1 | 0 | 0 |

- The window alone does not catch the case: the next result's word is three words away, past the `;`. The clause stop catches it with any of the three sizes. The smallest, 5, shipped, matching the answer side.
- The one new mark is the concurrency turn's percentage.
- The two other cases in 10a's table give no number (an error rate "near zero", and two techniques placed at employers), so this check cannot see them.

**Unchanged:** `npm test`, plus three new cases: a number told with another result's words is marked, the number with its own result's words passes in both languages, and a line with one number keeps the whole-line rule.

### Card split (2026-11-02)

**Why.** The percentage the concurrency turn moved comes from the canonical card, from a bullet that packs four results of one employer separated by `;`. The question asks for no result.

**The change** (`splitResults` in `contextBuilder.js`, spec FR-013, E58): a card bullet whose `;`-separated parts hold two or more numbers is given one line per part, each with the bullet's label. It does not split a bullet with one numbered part or a `;` inside parentheses, and it does not touch the chunks. The real card has 2 such bullets and grows by 120 characters (3,810 to 3,930).

**Rule, set before the run:** the box is ticked only if 0 of 5 answers with the split move a card number and the other nine career turns bring no new kind of error, empty answer or PASSIVE. If `main` also moves a number in 1 of 5 or fewer, the test cannot tell the two apart.

**Concurrency turn, 5 answers per side**, gpt-oss-120b, route personal in all 10:

| Side | Answers | Number moved to another result | Any number stated |
|---|---|---|---|
| `main` | 5 | 0 | 1 |
| Card split | 5 | 0 | 0 |

- On `main`, the one number is the card's percentage, kept on its own result (cost) but credited to the concurrency pipelines.
- In the three earlier measurements (10a's before, first wording and shipped wording), this turn moved a number each time. Today `main` did not, so the result is **inconclusive**.
- Both sides still place the same general concurrency techniques at employers.

**The other nine career turns of 10a's measurement**, once each with the split, counted by hand against the notes block each answer saw:

| Run | Answers | Metric invented or moved | Technique placed at an employer from a general note | "Not used" technology claimed |
|---|---|---|---|---|
| Shipped wording with the length rule (2026-11-01, ten turns) | 10 | 2 | 2 | 0 |
| Card split (concurrency turn from one of the five runs, plus nine) | 10 | 1 | 2 | 0 |

- What is left: the rate-limit turn still places a rate limiter and a circuit breaker at an employer and says its errors fell to "near zero". Neither comes from the card.
- No answer is empty or PASSIVE. The check marks one bare HTTP status (429) with no HTTP word near it, the cost E49 already accepts.

**Unchanged:** `npm test` (four new cases), and the live eval offline, regex and Jev: zero check, label or route differences. Because the card is longer, 6 of 145 items (4 of 43 with Jev) fit one note chunk fewer under the 9,000-character cap. The KB eval differs only in timings and in the count of other companies' chunks on other routes (310 to 306).

### Measurement of 10a (2026-11-01)

Run once the Groq daily limit was back, together with item 11's. The same ten career turns (four Portuguese, six English), `openai/gpt-oss-120b`, one answer each, with the shipped wording and item 11's length rule. Counted by hand against the notes block each answer saw:

| Run | Answers | Metric invented or moved to another result | Technique placed at an employer from a general note | "Not used" technology claimed |
|---|---|---|---|---|
| Before (main, 0.7) | 10 | 4 | 1 | 1 |
| First rule wording, 0.3, list | 10 | 3 | 1 | 0 |
| Shipped wording, with the length rule | 10 (9 with notes) | 2 | 2 | 0 |

- The two metrics: a percentage the notes tie to a cost, put on a run time (the concurrency turn again), and an error rate "near zero" that the notes do not state.
- The two techniques: a general concurrency pattern placed at an employer, and a circuit breaker placed at an employer.
- No answer is empty or PASSIVE. Median length 59.5 words (94 before).
- The rows are not like for like: the last one also runs item 11's length rule, and shorter answers have fewer claims to get wrong.

**Live eval with the judge**, `--text --only A,B --judge`, on commit `77ee925` (10a's code and the word counts, without item 11's prompt), compared with the run before 10a:

| | Before 10a | 10a (`77ee925`) |
|---|---|---|
| Pass / warn (without the two length checks) | 23 / 9 | 26 / 6 |
| Judge mean | 4.87 | 4.78 |
| Career routes | 10/12 | 10/12 |

- The judge mean is **0.09 lower** (23 answers, about two points). The lowest score is 4, and correctness averages 4.96.
- The routes are the same.

**Spread between runs (2026-11-01).** The 0.09 is smaller than the gap between two runs from before 10a. These are the four saved runs, all judged by gemini-3.5-flash-lite, on the 22 items all four judged. No new run was made.

| Run | Mean (22) | Career items (11) | Answers not from gpt-oss-120b |
|---|---|---|---|
| Before 10a, `main` on 2026-10-30 | 4.73 | 4.82 | 9 |
| Before 10a, item 13's branch on 2026-10-30 (the "before" above) | 4.86 | 4.82 | 10 |
| 10a (`77ee925`) | 4.77 | 4.73 | 10 |
| 10a and item 11 (`main` on 2026-11-01) | 4.77 | 4.82 | 15 |

- The two runs from before 10a, made the same day, are **0.13** apart. The "before" above is the higher of the two. The other one is lower than both runs with 10a.
- That pair is not identical code: item 13's branch also changes which span of the turn is taken as the question. In every run, fallbacks swap the model on some items.
- The judge runs at temperature 0, so most of the spread comes from the answers.
- On the career items, the only ones 10a changes, `77ee925` lost a point on two items:
  - a project told inside another story, the kind of error 10a targets;
  - bullets that are hard to say aloud, on an answer from the fallback model.
  - Both scored 5 again in the run with item 11.
- **"Judge mean not lower": not distinguishable from the spread between runs.** The wording is not revisited. Narrowing the spread would take repeated runs on each side, which costs Groq quota, so it is not planned.

---

## 11. Live Answer — answers too long to read while speaking

**Status:** Done — 2026-10-30, branch `2026-10-30-live-answer-length` (step 4 of the work order). The prompt budget shipped before any real-LLM run, because the Groq daily limit was used up; measured on 2026-11-01 (branch `2026-11-01-length-measurements`), see "Measurement". Checked on real sessions on 2026-11-02 (English) and 2026-11-03 (Portuguese), see "Real session". Found on 2026-10-28 in the same session as item 9.
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

- [x] On the live eval and the next real session, median ≤ 60 words and no answer over 120, with no rise in empty or cut answers. **Met on the live eval** (median 52, none over 120) **and on the replay** (none over 120; median 64, Portuguese 67). **Met on the real English session of 2026-11-02** (median 52, none over 120, none empty or cut). **Met on the real Portuguese session of 2026-11-03** (median 45, none over 120, none empty or cut).
- [x] No answer ends with a summary paragraph. 0 of 17 replay answers and 0 of 23 live-eval answers (7 and 2 before).
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

### Measurement (2026-11-01)

**Replay, gpt-oss-120b, one answer per turn.** The 17 turns of the plan: 11 Portuguese and 6 English, before on commit `77ee925` (a worktree), after on `main`.

| Run | Answers | Median words | Longest | Over 120 | Ends in a paragraph | Empty, cut or PASSIVE |
|---|---|---|---|---|---|---|
| Portuguese, before | 11 | 135 | 213 | 7 | 6 | 0 |
| Portuguese, after | 11 | 67 | 76 | 0 | 0 | 0 |
| English, before | 6 | 80.5 | 183 | 1 | 1 | 0 |
| English, after | 6 | 59.5 | 69 | 0 | 0 | 0 |
| All, before | 17 | 118 | 213 | 8 | 7 | 0 |
| All, after | 17 | 64 | 76 | 0 | 0 | 0 |

- 16 of the 17 answers got shorter; one English answer went from 53 to 69 words.
- "Cut" means an answer that ends without punctuation. The replay log does not record the stop reason.
- The route changed in 6 of the 17 turns between the two runs: Jev is nondeterministic, and route accuracy is not compared here.
- `cmp-check10b.js` on these answers: no mark on the "after" answers, two on the "before" (one number in one answer, a coverage target that matches an unrelated result: a false alarm).

**Live eval with the judge**, `--text --only A,B --judge`, the 32 items both runs have (the "after" run also has the 8 new STT-term turns of item 15):

| | Before (`77ee925`) | After |
|---|---|---|
| Judged answers | 23 | 23 |
| Judge mean (correctness / relevance / concision / speakability) | 4.78 (4.96 / 5.00 / 4.61 / 4.74) | 4.78 (4.91 / 4.96 / 4.83 / 4.74) |
| Lowest score | 4 | 4 |
| Median words / longest | 95 / 179 | 52 / 76 |
| Over 120 / ends in a paragraph | 5 / 2 | 0 / 0 |

- Four scores moved: two went from 5 to 4, two from 4 to 5.
- **Caveats.** The Groq limits forced more fallbacks in the "after" run: 21 of its 31 answers came from a model other than gpt-oss-120b (before: 11 of 23). The word counts there mix models. The run was made with the item 17 branch checked out (`54fb2cd`), which changes only the System Design mode.
- Pass and warn (without the two length checks): 26 and 6 before, 24 and 8 after. The "answered without fallback" check explains most of it: it warns on 4 items that did not warn before, and on 1 that did.

**Accept.** Median under 70 and the judge mean not lower: the wording of `LENGTH_RULE` is not revised, and the panel fold is not proposed, since no answer ran over 120. The only target left open is the median of 60 on a real session: the replay's Portuguese median is 67.

### Real session (2026-11-02)

The first real session since the budget shipped: an English screening, 11 minutes, 19 answers, counted with `answerWords` as the live eval does.

| Session | Answers | Median words | Longest | Over 60 | Over 120 | Ends in a paragraph | Empty, error or PASSIVE |
|---|---|---|---|---|---|---|---|
| 2026-10-28, Portuguese (before) | 34 | 95 | 275 | 30 | 10 | 19 | 0 |
| 2026-10-29, English (before) | 17 | 72 | 182 | 10 | 3 | 3 | 1 PASSIVE |
| 2026-11-02, English | 19 | 52 | 105 | 5 | 0 | 0 | 0 |
| 2026-11-03, Portuguese | 43 | 45 | 115 | 11 | 0 | 0 | 1 PASSIVE (right) |

- 7 of the 19 answers came from fallback models (item 22). Split by model: gpt-oss-120b 12 answers, median 53, longest 83; the fallbacks 7, median 43, longest 105.
- On 2026-11-03 (a culture-fit interview, 32 minutes), 17 of the 43 answers came from fallback models. Split by model: gpt-oss-120b 25 answers, median 57, longest 115; the fallbacks 17, median 39, longest 59. Without the fallbacks the median is still under 60.
- The longest answer (105 words) is the one item 19 records: a fallback model confirming a restatement.
- **Limit:** a screening with no technical questions, so it does not compare one to one with the 2026-10-28 and 2026-10-29 sessions, which had them.

Box 1 is met for English and, on 2026-11-03, for Portuguese: ticked. The replay's Portuguese median (67) stays over 60; the real session's is under it.

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

---

## 18. System Design · Live — answer without typing, like Live Answer

**Status:** Proposal, 2026-11-01. Not planned yet: each proposal below would get its own plan and branch. Outside the work order at the top. **The v1 chosen on 2026-11-02 is 18.11**: the user's scenario, with every stage decision made by hand. It was built the same day (see its **Status**).
**Severity:** MEDIUM (enhancement)
**Code it would touch:**
- the answer lane in `src/features/listen/summary/summaryService.js`, and `questionGate.js`;
- `src/features/ask/askService.js` (`lastLiveDesign`) and `askPrompt.js`;
- the profile `pickle_glass_system_design_live`, and a new probe-only profile (`promptTemplates.js`);
- `src/features/shortcuts/shortcutsService.js`;
- `LiveAnswerView.js`, `ListenView.js`, `windowManager.js`;
- live eval phase H.

### Summary

System Design · Live (item 16) answers only what is typed into Ask. Live Answer answers the interviewer's questions by itself. In a system design round, the candidate keeps going back and forth between the interview and the Ask box:
- **Six typed Asks per round.** The item-16 practice script (`npm run practice:sd-live`, before v1 rewrote it) typed in steps 1, 3, 4, 5, 6 and 7.
  - Steps 5 and 7 retyped the question the interviewer had just asked ("what if the timeline cache cluster goes down?", "why not just use a single SQL database for the tweets?"), which the transcript already had.
  - Steps 3 and 6 were the word `design`.
- **Two answers to one question.** The answer lane runs in every Ask mode (`summaryService.js` never reads `askMode`), and `design` is one of its interview cues (`questionGate.js:36`).
  - The interviewer's "Design a Twitter feed" already gets a generic ~60-word answer from `pickle_glass_analysis`.
  - "What if Redis goes down?" gets one that doesn't know the design: the last kit lives only in `askService.lastLiveDesign` (`askService.js:157`, `:461`).
  - Every interviewer line of the practice script passes the gate, not only the questions: step 2 on `assume`, step 3 ("Go ahead with the high-level design") on `design`, step 6 on `suppose` (`questionGate.js:36-38`).
- **Token cost.**
  - The System Design · Live prompt is ~3,100 tokens in, ~4,700 with the previous answer (item 16). A design kit adds ~1–1.5k out, plus gpt-oss's reasoning.
  - Groq's free tier allows 8,000 tokens per minute **per model**, and cached tokens don't count (`ARCHITECTURE.md:1018`). One kit nearly uses up a model's minute, so the next call falls to the next model of the list, a weaker one or Gemini.
  - Every Ask also sends a screenshot, which moves the models that see images first (item 16).
  - Today a probe costs both an Ask and a generic Live Answer (~3.5k, `ARCHITECTURE.md:1020`).
- **The Ask window may take focus.** It opens with `win.show()` (`windowManager.js:435`) and is focusable (Electron's default; `:546` sets nothing else). An Ask opened without a key press, while the candidate types in a shared code pad, could take the keyboard. Whether Windows lets it take focus from a browser is not verified. Live Answer doesn't have this problem: it only sends IPC to the Listen window, already open.

### Proposals, best first

Each one with its impact on the round and its feasibility. Effort is an estimate, in sessions (one plan and one branch each).

#### 18.1 Answer the interviewer's questions with the design in mind (probes in the Live Answer lane)

- In `system_design_live`, the answer lane swaps `pickle_glass_analysis` for a short probe-only profile (~1,000 tokens): the design rules, the trade-off and failure cheat sheets, the PROBE format and the PASSIVE rule.
- It keeps the lane's gates, the 800 ms debounce, abort-and-replace, PASSIVE, the history and the failover.
- `lastLiveDesign` moves out of `askService` into a small module that both services read.
- Only the kit's "Requirements used" and its Decisions line go into the prompt, not the 6,000 characters.
- **Impact: high.** It removes the most frequent action of the round's second half (retyping the question), and the generic answer that can contradict the design. Same latency as Live Answer.
- **Feasibility: high.** It reuses the lane. 1–2 sessions. The risk is the per-minute limit: the short prompt keeps a call near 2k tokens instead of 4.7k. Eval: H5-like cases driven by the transcript instead of typed text.

#### 18.2 One "next step" key that works out the request

- A global shortcut next to `nextStep` (`shortcutsService.js`), and chips in the panel.
- A pure function, `inferLiveDesignStep(transcript, lastKit)`, picks the request:
  - no kit yet and a problem in the transcript: the opening kit, with the problem taken from the transcript;
  - an opening kit, and the interviewer answered since: `design`;
  - a design kit, and the interviewer's last turn is a question: a probe on it;
  - two chips for the deep dives the kit itself listed (the titles under `## Deep dives`).
- **Impact: high.** No typing, and the candidate still picks the moment: a kit costs ~4k tokens and covers the screen.
- **Feasibility: very high.** About 1 session, and the function is testable without Electron. It is the state machine of 18.3 with a human trigger: each key press records when a stage really changed, which is the labeled data 18.3 needs.

#### 18.3 Kits that follow the interview's stages by themselves

- A state machine in `summaryService`, run on each `them` turn:
  - **Idle → Problem:** the turn asks to design something. The opening kit starts by itself. This needs a new detector. `SETUP_TASK_RE` is not exported (`questionGate.js:459`) and matches any design, build or scale word, and so does the `design` cue: "how does that scale?" or "Go ahead with the high-level design" would read as a new problem.
  - **Clarifying:** counts the interviewer's answers that carry numbers, scope or regions.
  - **Designed:** the design kit starts when the interviewer agrees after the check-in ("sounds good", "pode seguir") or moves on ("let's start with the high level"). From then on, questions go to 18.1.
- **Impact: very high.** The whole round hands-free.
- **Feasibility: medium.** 2–4 sessions. The risks:
  - A problem said in pieces, with pauses ("Let's design Twitter… focus on the feed… 10M users"). Item 1 (the answer fires before the interviewer finishes) bites harder here: an opening kit on half the problem. This trigger needs a longer wait (~3 s) and continuation grace.
  - A design kit fired by mistake costs ~4.7k tokens and covers the screen.
  - "Go ahead and design" is a fuzzy signal in both languages. The Jev router can't simply be reused: its labels are fixed (personal, company or general, plus `asks` and `invites`, `jevRouter.js:9-16`), and a stage label means changing its schema. Only its `asks` score helps, to drop turns that ask nothing.
- The kit can't open the Ask window by itself (focus): use `showInactive()`, or render it in the listen window.
- Start safe: the machine only lights the 18.2 chip ("Design kit ready?"), and fires by itself once the eval has measured its precision.

#### 18.4 A changed requirement updates only what changed

- After the design kit, a them turn that changes a constraint ("make it global", "agora 100M de usuários") starts a short DELTA route (≤ 200 words): what changed, the updated Decisions line, and the deep dive it affects.
- The stored kit is patched, so later probes follow the new design.
- **Impact: medium-high.** Today this is step 6 of the practice script: type `design`, then read a new 750-word kit to find what changed.
- **Feasibility: medium.** About 2 sessions, after 18.1 and 18.2. The hard part is "what if it were global?" (a hypothetical, so a probe) vs "make it global" (a change). Default to a probe with an "apply to the design" chip; fire by itself only on statements or imperatives with numbers.

#### 18.5 A structured design memory

- Replace "the last kit cut to 6,000 characters" with fields:
  - confirmed facts (daily users, regions, in and out of scope, latency targets), each with its source turn;
  - assumptions;
  - decisions;
  - the estimate numbers.
- **Impact: medium, indirect.** Smaller prompts for 18.1, 18.3 and 18.4 (the per-minute limit), a consistent design (push vs pull decided twice is a known issue), and a pinned card for 18.6.
- **Feasibility: medium-low.** Extraction on every turn costs a call per turn, and the fields can drift from the transcript. The parse-only part (read the kits' fixed headings, with no LLM call) is cheap and fits inside 18.1.

#### 18.6 One System Design · Live panel

- In the listen window: a pinned card on top (Requirements used, Decisions and the diagram, collapsible), probes streaming below, and the deep-dive chips. Ask stays for typing by choice.
- **Impact: medium.** One place to look, no switching windows, no focus lost.
- **Feasibility: medium.** About 2 sessions of UI in `LiveAnswerView` and `ListenView`. The ASCII diagram needs a wider window. Content protection is already on there. Worth most after 18.3.

#### 18.7 Answers ready before the question

- (a) The design kit already has three Q/A under `## Next questions`. When the interviewer asks one of them (fuzzy match, or the career module's embeddings), its answer shows at once with no tokens spent, and the LLM probe confirms or replaces it.
- (b) Generate the design kit in the background while the interviewer is still answering.
- **Impact: low-medium.** Groq is already fast, and (a) rarely matches.
- **Feasibility:** (a) high. (b) medium, and it spends the per-minute limit on kits thrown away.

#### 18.8 Watch the screen continuously

- Periodic screenshots compared with each other, to notice the problem statement or the candidate's diagram.
- **Impact: low-medium.**
- **Feasibility: low.** Image tokens at every interval, and screenshots go first to the models that see images, which are the limited ones (Qwen on Groq, Gemini). Last.

### Summary table

| # | Proposal | Impact | Feasibility | Effort |
|---|---|---|---|---|
| 18.1 | Probes in the Live Answer lane, with the design | High | High | 1–2 sessions |
| 18.2 | "Next step" key | High | Very high | 1 session |
| 18.3 | Kits by interview stage | Very high | Medium | 2–4 sessions |
| 18.4 | Changed requirement → delta | Medium-high | Medium | 2 sessions |
| 18.5 | Structured design memory | Medium (indirect) | Medium-low | part of 18.1 |
| 18.6 | One panel | Medium | Medium | 2 sessions |
| 18.7 | Answers ready before the question | Low-medium | High (a) / medium (b) | 1 session |
| 18.8 | Watch the screen | Low-medium | Low | — |

### Recommended order

1. 18.1, with the parse-only part of 18.5.
2. 18.2: it also records when each stage changes.
3. 18.3: first only suggesting, then by itself once its precision is measured.
4. 18.4 and 18.6.

With 18.1 and 18.2, five of the practice script's six typed Asks become no key or one key. The one left is choosing a deep dive, which becomes a click.

### Second opinion (2026-11-01)

An independent agent read item 18 against the code. The Summary and 18.3 above are already corrected where it found errors: the token limit is per model, the Ask window is focusable by default rather than by an explicit option, and `SETUP_TASK_RE` and Jev can't be reused for stage detection.

**Ratings it changed:**
- **18.1** stays first, and is worth more than rated.
  - One call of ~2.5k replaces today's Ask (~4.7k plus a screenshot) and generic Live Answer (~3.5k).
  - The answer starts in ~3.3–4.5 s (2 s STT, 800 ms debounce, ≤ 250 ms Jev, first token), instead of the time it takes to type the question (estimated at 10–15 s).
  - Effort is 2 sessions. It must:
    - replace `LENGTH_RULE` (`summaryService.js:67`), which fights the PROBE shape;
    - keep the career personal and company routes on the old profile;
    - reply PASSIVE while the interviewer answers the candidate's questions;
    - use the probe profile only when a kit exists in this Listen session (Ask's session is the active Listen session, `sqlite.repository.js:83-104`), so a mode left on during a behavioral round changes nothing;
    - also take the kit's Storage table and the deep dives' Pick lines, not only Requirements used and Decisions (the headings are fixed, so parsing is safe).
- **18.2:** feasibility even higher, impact medium.
  - Ctrl+Enter already sends an empty Ask (`askService.js:172-175`), and with empty text the prompt already picks opening or design from the transcript (`promptTemplates.js:767-769`).
  - What's missing: empty text with a kit and an interviewer question should give a PROBE, not a new 750-word kit as today. Also, the first press only opens the hidden Ask.
  - After 18.1 the probe part is redundant, which leaves ~2 presses per round.
  - A press marks when the candidate wanted a kit, not when the stage changed, so it is weak labeled data for 18.3.
  - The deep-dive chips need a fixed title format under `## Deep dives`, which the prompt doesn't set.
- **18.3:** medium impact, since it saves 2–3 presses over 18.1 + 18.2 at the highest misfire cost. Medium-low feasibility: no System Design session to label, and no detector to reuse.
- **18.4:** medium. The probe already answers the hypothetical, and the prompt already says the interviewer's changes override Decisions (`promptTemplates.js:850`). Its value is against a stale design.
- **18.5:** its parse-only part goes up, because of the 30-turn window (18.9).
- **18.7b** is underrated when its trigger is precise (18.10): the design kit is the longest stream, and it comes at the moment the candidate starts drawing.

**What the first analysis missed:**
- **The 30-turn window:** 18.9.
- **Two lanes, one turn.** Nothing decides which lane takes a turn. "Go ahead with the high-level design" triggers Live Answer, and it would also be 18.3's design cue. Policy:
  - one call per turn, and the System Design lane wins;
  - slow or pause Insights during System Design · Live (it runs every 5 turns, ~2.5k tokens each, `summaryService.js:1124`);
  - no screenshot on calls driven by the transcript.
- **Item 1 hits 18.1 too.** Probes come in pieces ("Okay. And what if…"), and abort-and-replace ignores a bare continuation.
- **The candidate's own lines as cues:** 18.10.
- **Portuguese and STT errors** hurt the regex parts (chips, stage cues): item 15 measured 7 of 12 terms heard right. The LLM probe tolerates them. Portuguese cues must be written out: `HANDOVER_RE` matches "pode seguir" or "go ahead" only as a whole clause (`questionGate.js:201`).
- **Evaluation.**
  - The career replay (`replay-career-session.js`) can run a labeled System Design session with `--no-llm`. That measures trigger precision and recall at no cost, in English, in Portuguese and with misheard variants. There is no real System Design session yet: record the practice runs.
  - Phase H drives only Ask. 18.1 needs cases fed as transcript through the harness (`--text`).
- **Failure modes:**
  - an opening kit on half a problem;
  - a design kit before the clarifying questions;
  - a kit from an earlier round in the same Listen session;
  - a restart forgets the kit, though the DB still has the answer (`askService.js:476`).

#### 18.9 Keep the confirmed facts past the 30-turn window (from the review)

- Both lanes cut the transcript to the last 30 turns (`askPrompt.js:76`, `summaryService.js:278`). A 2 s pause ends a turn, so that is roughly the last 5–10 minutes.
- The design kit keeps what was confirmed before it, since its Requirements used goes back as the previous answer. What falls out:
  - a change the interviewer made after the kit, with no new kit after it;
  - clarifying answers, when the clarifying stage runs long.
- Fix with no LLM: pin the interviewer turns that carry numbers, regions or scope, and send them with the transcript.
- **Impact: medium-high. Feasibility: high.**

#### 18.10 The candidate's check-in line starts the design kit (from the review)

- The opening kit scripts "Is that right?" and "Anything you'd change before I design?" (`promptTemplates.js:777`, `:798`). A `me` turn that matches the check-in is a precise signal, and the candidate controls it.
- Start the design kit then, in the background (18.7b), and show it after the interviewer replies.
- Risks: the candidate paraphrases the line; without headphones the mic also hears the interviewer, so a `me` turn is not always the candidate.
- **Impact: high. Feasibility: medium.**

### Revised order (after the review)

This replaces the recommended order above. On 2026-11-02 the user chose 18.11 as v1: it is 18.1 plus the fixed Ctrl+Enter order of 18.2, with every stage decision made by hand. The order below holds for what comes after v1.

1. 18.1 with the review's guards:
   - only when a kit exists in this Listen session;
   - the career routes kept on the old profile;
   - the PROBE shape instead of `LENGTH_RULE`;
   - PASSIVE while the interviewer answers;
   - one call per turn;
   - the richer kit excerpt.

   Then continuation grace for probes (item 1).
2. 18.9, with the parse-only part of 18.5.
3. 18.2 as Ctrl+Enter with empty text, plus the probe route when a kit exists.
4. 18.10 with 18.7b.
5. 18.4, then 18.6.
6. 18.3, only suggesting at first.
7. 18.7a, then 18.8.

**First step:** change only `makeLiveAnswer`. When the mode is `system_design_live`, a kit exists for `currentSessionId`, and the career route is not personal or company:
- use the probe profile with the kit excerpt;
- use the PROBE shape instead of `LENGTH_RULE`;
- reply PASSIVE when the interviewer is answering the candidate.

**How to know it worked:**
- Unit tests: a table of which profile is used for each mode × kit × route.
- Live, through the harness (`--text`), in English and Portuguese:
  - the probe shape, at most 90 words;
  - it names the store from the kit's Decisions line;
  - PASSIVE on step 2's line;
  - the first token within 6 s;
  - exactly one call per interviewer turn;
  - tokens per call no higher than today's Live Answer.
- Practice script: steps 5 and 7 need no typing.

#### 18.11 v1: one interview, behavioral then System Design, with no automatic stage decision (chosen 2026-11-02)

**Status:** Built on 2026-11-02, branch `2026-11-02-system-design-live-no-typing`.
- Done: the unit tests, the live harness (phases H and I) and the practice script; see **Acceptance**.
- Found in the first practice run (2026-11-04) and fixed:
  - In Ask, an underscore inside a word (`tweet_id`, `next_cursor`) opened italics that ran to the end of the line. In the Storage table, that row lost its cells and the next row began a new table. Ask renders the stream with `src/ui/assets/smd.js`, which opened emphasis on any `_` before a letter. It now follows CommonMark: an underscore between letters or digits is text (`smd.test.js`). This predates item 18; Live Answer renders with `marked`, which never had it.
  - **The design kit's diagram was a column of numbered boxes with no arrows** in 2 of the 3 design kits seen on screen, all three from `qwen/qwen3.8-27b`. The legend under it came on one line.
    - Why the kits come from Qwen and Gemini: every Ask carries a screenshot, so Groq puts the models that see images first (`order=vision-first`).
    - The prompt only said "ONE ASCII diagram … Number every box".
    - Phase H had never tested this: its transcript cases sent no image, so their kits came from gpt-oss, which never writes a kit in the app. No check looked at the diagram.
  - **What changed:**
    - **The prompt** (the third edit `golden.test.js` allows):
      - a flow, not a list: arrows from box to box, the write and the read paths, async hops labelled;
      - short box names (at most 3 words);
      - at most 70 columns;
      - a ```` ```text ```` block, so highlight.js leaves it uncoloured;
      - a shape drawn with the letters A to G;
      - the legend one per line.
    - **Phase H:**
      - every case sends a screenshot, as the app does;
      - `checks.designDiagram` fails a design kit with fewer than 3 arrows or with the skeleton's letters left in it, and warns when the diagram is wider than the Ask window;
      - `--cases` runs single cases. Qwen answers one kit per run, then Groq refuses it for the key's output limit.
    - **Ask** (`AskView.js`): highlighted tokens inside a code block took the sans-serif font of the `*` rule, so `-`, `>` and `|` changed width and the diagram's columns drifted. They are monospace now: every glyph measured is 6.05 px except `▶`, which the prompt does not use. The window shows 84 columns.
  - **Measured live on 2026-11-04** (`%LOCALAPPDATA%\glass-live-eval\diagram-2026-11-04\`):

    | | Before | After |
    |---|---|---|
    | gemini-3.5-flash-lite | 9 design kits: all with arrows; 3 wider than the window (91–97 columns); 2 without box numbers | 15 design kits: all a flow with 4–8 arrows, numbered, in a `text` block; 14 within the window (one at 96) |
    | qwen/qwen3.8-27b | 8 answered: 6 with ≥ 3 arrows; on the Twitter cases (H3/H7), 2 of 4 had 1 or 2 | 13 of 13 answered across the last four wordings of the rule had 5–12 arrows; 2 of 2 on the final wording; all within the window |

    - Groq refused 23 of the 36 Qwen requests after the change for the key's limits (output per minute, tokens per minute).
    - Two flagged kits came from Gemini's content, not from its diagram: on the final wording, one rate limiter kit with two write paths and no read path (1 of 15); after the change, one opening kit sent back for `design` (1 of 54 design requests; 0 of 9 before).
  - Step 11 of the script asked to read the line under the diagram, which step 10 had cleared from Ask. The candidate now says the design from memory.
  - **Ask modes other than System Design · Live had no language rule** (found 2026-11-04 when the user asked that every Ask mode follow the interview's language, as Live Answer does).
    - `buildAskMessages` named the language in System Design · Live only, and the other modes get no transcript. With nothing typed and an English problem on screen, a Portuguese interview got English answers.
    - Rule 11 now covers every mode, and the STT language names the language (see rule 11). New phase L of the live eval measures it, one Ask per mode (`fixtures/ask-language-cases.js`).
    - In the app the same day, `twitter` typed in System Design · Live with Listen off and the setting in Portuguese got an English kit (`glass.log`: `answer language: not named`). The language then came from the turns and the typed text first, and the STT language only while Listen ran. Now the STT language decides alone. Phase L's case 7 is that Ask.
  - **Measured live on 2026-11-04, phase L** (`%LOCALAPPDATA%\glass-live-eval\language-2026-11-04\`):

    | | Before (1 run) | After |
    |---|---|---|
    | gemini-3.5-flash-lite | 5 of the 6 Asks of the other modes in the wrong language. Portuguese interview: Default, Code, Debug and System Design in English. English interview with Portuguese typed: Default in Portuguese, Code in English. `twitter` with Listen off: English, in the app | 3 runs of the 6 other-mode cases and 3 of `twitter`, 21 Asks: all 21 in the interview's language, read one by one. The check flagged one terse English Default answer (159 characters) as unknown. Every heading in English and in order; the code comments in English; the Default answer's facts from the image 3/3; the debug fix of the loop bound 3/3. The 6 other-mode cases ran with the first version of the rule; they send the same messages under the final one, since each names the same language and their prompt gets no turns |
    | qwen/qwen3.8-27b | not measured | The first 7 cases (case 7 then a turn too short to tell, then `opening`), one per run: Default and Debug in a Portuguese interview answered, both in Portuguese, with the headings in English. Groq refused the other 5 on the model's daily token limit (200,000), spent by the day's runs |

    - Phase H after the change (Gemini, 4 runs; same messages under the final rule): the English kit in English 4/4, the Portuguese kit in Portuguese 4/4. H1, H2 and H6 now carry the English sentence, named by the STT language (`en-US` in phase H), and kept their route and headings 4/4.
    - Not from this change:
      - The code's hidden tests failed in 2 of 6 code answers: one used LeetCode's `MinPriorityQueue`, which does not exist in JavaScript, as both code answers did before the change; one timed out on the 220×220 grid.
      - The probe case (H5) went the deep-dive route in 2 of 4 runs (1 of 15 earlier on 2026-11-04). Its request was the same before and after the change, since the interviewer's English turns already named the language.
- Still to do: the checks in the app by hand, first among them Ctrl+Enter with the VM's window focused, and a full run of the script before a real interview.

**The scenario the user wants:**
1. Live Answer is on.
2. The first part of the interview is behavioral, answered from the career KB, as today.
3. The conversation moves to a system design exercise. Live Answer is still on.
4. Glass switches to System Design · Live, then gives the opening kit and the design kit.
5. From then on, Live Answer answers the interviewer's probes with the context of the kits.

None of 18.1–18.10 covered it whole. They all assumed the candidate picks System Design · Live before the round. 18.3 detects stages inside a round, not the move from the behavioral part to a design round. 18.1 answers only in the PROBE shape.

**The user's requirement:** the fewest points of failure, and a flow that works the first time, also when keys are pressed out of order or by mistake. Doing a step by hand is fine when it removes a risk.

**What can and can't be guaranteed.** A flow built on STT and an LLM can't be guaranteed 100%:
- STT mishears words (item 15: 7 of 12 terms heard right);
- a provider can fail over to a weaker model;
- a model can give a poor answer.

Live Answer has the same limits today. What v1 guarantees:
- **No stage decision is automatic.** Each one is made by the candidate, or by a fixed rule in the code that unit tests cover.
- **Every key, in any order, has one defined result** (the edge-case tables below).

What is left uncertain is the quality of each answer, as today, and every failure is visible and can be recovered.

**Decisions taken with the user (2026-11-02):**
- **The kits show in the Ask window.** The interview runs inside a VM and Glass runs outside it, so Ask taking focus is not a risk here. The Ask window is 600 px wide (`windowManager.js:546`), and the listen window is 400 px (`:513`), too small for a kit. The listen window keeps the short probe answers.
- **No detector for the move to System Design.** A false positive would put an opening kit in the middle of a behavioral answer, and send the next behavioral questions to the System Design profile. The candidate switches the mode by hand.
- **No automatic opening kit.** A problem said in pieces would give a kit on half the problem (item 1). The candidate types the problem, or presses Ctrl+Enter, once the interviewer has finished.
- **No automatic design kit.** When the clarifying stage ends is a fuzzy signal, and a kit at the wrong moment costs ~6k tokens and covers the screen. The candidate presses Ctrl+Enter.
- **No career router inside the stage.** "How would you handle this in your design?" could route personal. That is one more automatic decision, so in v1 every question in System Design · Live goes to PROBE.
- **Live Insights is off** during these interviews (Live panels: Answer only), so its calls don't compete with the kits for the per-minute limit.
- **A design kit is replaced only on purpose.** After a design kit, an empty Ctrl+Enter only shows a hint, and the candidate types `design` to update the kit after a change. Otherwise a stray press would replace the design being presented with a new one that may not match it. This came from the edge cases below.

**The v1 flow:**

| Moment | Who decides | What happens |
|---|---|---|
| Behavioral part | Nothing changes | Live Answer answers from the career KB, as today |
| The design round starts | **The candidate:** one click in the mode picker, "Ask · SD Live" | The pane shows the "SD Live" badge. Live Answer is **silent** until a design kit exists in this Listen session |
| The interviewer has finished stating the problem | **The candidate:** types the problem into Ask ("twitter") and presses Enter (recommended), or presses Ctrl+Enter twice with nothing typed | Opening kit, in Ask. Its first line restates the problem, so a wrong one shows at once |
| The clarifying stage is over | **The candidate:** Ctrl+Enter twice with nothing typed, or types `design` | Design kit, in Ask |
| The interviewer asks something | **Automatic** | Live Answer answers in the PROBE shape, with the kit's context, in the listen window |
| The interviewer changes a requirement | **The candidate:** types `design` and presses Enter | A new design kit, used by the next probes |
| The design round ends | **The candidate:** one click, back to Default | The badge goes away. Live Answer goes back to the career KB |

A deep dive the candidate wants in full is still typed into Ask ("deep dive cache"), as today. In v1, a "let's go deeper into X" from the interviewer gets a PROBE answer.

**Fixed rules (code, not the model):**

1. **What an empty send asks for.** An empty send is Ctrl+Enter with nothing in the box, or Enter on an empty box. In System Design · Live, the code picks the request from the kit stored for this Listen session:
   - no kit: `opening`;
   - an opening kit: `design`;
   - a design kit: nothing is sent, and Ask shows "Design kit done. Type `design` to update it after a change."

   Today an empty Ask leaves the choice between opening and design to the prompt's routing (`promptTemplates.js:767-769`), and a model can pick wrong. `design` exists (routing rule 4). `opening` is new, and gives the OPENING KIT. With nothing typed, the model takes the problem from the transcript or the screenshot. That is the one judgment left in this path, which is why typing the problem is the recommended way.
2. **What a typed text asks for.**
   - **Fixed words** are sent as fixed requests, kit or no kit: `opening`, `opening: <problem>`, `design`, `next` (the same as `design`, as in routing rule 4), `design: <problem and requirements>`, `full`. The word goes in lower case, as `word` or `word: <text>`: `Design.` is sent as `design`.
     - A fixed word is the whole text, or the word followed by a colon. Case is ignored, and so are a final period, spaces at either end and a space before the colon. `design:` with nothing after it is `design`. `design?` is not a fixed word.
     - "design twitter feed" is not a fixed word: it is a problem.
     - **The fixed words get a route of their own**, first in the prompt's routing:
       - `opening` or `opening: X` → the OPENING KIT for X, or the "No problem yet" line when neither X, the screenshot nor the transcript names a system;
       - `design`, `next` or `design: X` → the DESIGN KIT, with the numbers nobody stated marked (assumed);
       - `full` → FULL.

       Today's routing has no `opening` route, and DESIGN comes before OPENING (`promptTemplates.js:767-768`). `opening: twitter, 10M DAU` would then route DESIGN on its typed constraints. `design: twitter`, with nothing confirmed in the transcript, would route OPENING, like "Design a URL shortener.".
   - **Any other text, with no kit,** is sent as `opening: <text>`: the opening kit for exactly what was typed, even when the transcript names something else.
     - Constraints typed with it ("twitter, 10M DAU, US only") are marked (confirmed), as routing rule 4 does for the design kit.
     - Today a typed `twitter` already gives the opening kit, through the prompt's routing (item 16, case H6). v1 makes it a code rule.
   - **Any other text, with a kit,** goes as typed, and the prompt routes it as today: "deep dive cache", a probe typed by hand.
     - The code can't tell a new problem ("uber") from a topic ("cache") without judgment, so a new problem is typed with the fixed word: `opening: uber`.
3. **Keys.**
   - **Rules 3 and 4 hold in System Design · Live only**, so the other modes keep today's keys (rule 8).
   - **Ctrl+Enter** is the only shortcut that opens Ask: the default key of `nextStep` (`shortcutsService.js:68`), which the candidate can rebind in the shortcut settings (`handleSaveShortcuts`, `:42-44`).
     - Its first press opens Ask with the text box (`askService.js:187-195`), or shows the box over an answer already on screen (`:180-182`). Its second press sends. A send by Ctrl+Enter always takes two presses, so one stray press never sends.
     - **In v1 the second press sends what is in the box:** the main process asks the Ask window to send its box, as Enter does. Today it sends an empty request whatever the box holds (`askService.js:172-175`). The box's own Ctrl+Enter handler (`AskView.js:1353`) probably never sees the key, because Ctrl+Enter is a global shortcut (`shortcutsService.js:213-214`, registered at `:270`); to confirm in the app. With today's code, "twitter" in the box plus Ctrl+Enter would send an empty request, which v1's rule 1 would read as "opening from the transcript".
     - **A press while Ask is closing doesn't send.** Ask hides only at the end of a fade (`windowManager.js:448`), and `closeAskWindow` shows the box again at once (`askService.js:213`). Today a Ctrl+Enter within the fade after Esc takes the send branch (`:172`). In v1 the main process keeps whether Ask is shown, set at once when Ask is closed, hidden or shown, and the second press sends only while it is.
     - **Two empty sends within 300 ms count as one:** a held key, or the box's handler and the shortcut both firing.
   - **Enter** in the box sends the box (`AskView.js:1352-1357`), also when it is empty, since the empty check is commented out (`:1335`). An empty box goes to rule 1.
   - **The header's Ask button** never sends: it opens or hides Ask, or shows or hides the box over an answer (`featureBridge.js:187`, `toggleAskButton()` with no argument, `askService.js:180-195`).
   - **Esc** closes Ask only when there is no answer and nothing loading (`AskView.js:949-959`), and only while Ask has the keyboard focus (the listener is in the Ask window, `:793`). It never cancels or deletes a kit.
   - **Closing Ask clears the box**, so a later Ctrl+Enter never sends text left from before. Today nothing clears it on close: `closeAskWindow` resets only the service's state (`askService.js:205-214`), the box is only hidden (`AskView.js:1453`), and only a send clears it (`:1337`).
     - Closing is the close button, Esc, or the header's Ask button when it hides Ask (`askService.js:184-186`).
     - Ctrl+\ keeps the box: it hides every window and shows them back as they were (`windowManager.js:257-262`).
     - Entering System Design · Live also clears the box, so text typed in another mode is never sent as a kit request.
4. **A kit being written is never replaced by accident.**
   - While an `opening`, `design`, `next` or `full` request is streaming, a new Ask request, empty or typed, is not sent.
   - Ask shows "A kit is still being written. Close Ask to cancel it." Typed text stays in the box.
   - Today a new request cancels the one in progress (`askService.js:254-256`).
   - **The check comes first in the request, before any wait.** Today the mode and the session are read only after four waits (`askService.js:266-280`), so two presses in the same moment would both start. A refused request, and rule 1's hint, write nothing to the DB and leave the answer on screen.
   - Closing Ask still cancels the kit (`askService.js:199-203`). A canceled kit is not stored, and the next empty send asks for the same step.
   - Requests that are not kits (a deep dive or a probe typed by hand) are replaced by a new request, as today.
5. **The stored kit and its type.**
   - **A kit request** from rule 1 or a fixed word is stored when it ends with text, without error or cancel. Its type:
     - the headings decide when they are recognized: `## Requirements used` → a design kit; otherwise `## Frame` → an opening kit. A `design` request answered with an opening kit is stored as an opening kit, and the next empty send asks for `design` again;
     - with no heading recognized, the type the request asked for, when the answer has at least 120 words: `opening` → an opening kit; `design`, `next`, `design: …` and `full` → a design kit.

     The second case covers a fallback model that changed the headings. Today a kit is recognized by its headings only (`isLiveDesignKit`, `askPrompt.js:47`). A model that writes "**Frame**" instead of "## Frame" leaves nothing stored, and rule 1 would then ask for the same step forever.
   - **The "No problem yet" line** (routing rule 6) is never stored: it has no kit heading and about 25 words in any language, under the 120-word floor. A kit is about 450 words (opening) or 750 (design).
   - **Other typed text** is stored only when its headings show a kit, as today, and its type comes from them: a `## Requirements used` heading means a design kit.
   - **One kit per Listen session,** the latest.
6. **Silence before the design kit is a code gate.** In System Design · Live with no design kit in this Listen session, the answer lane makes no LLM call and sends nothing to the window. It doesn't rely on the model replying PASSIVE. During the clarifying stage, "Assume about 10 million daily active users" passes today's gate on `assume` (`questionGate.js:38`).
   - The check comes before the lane's career steps, which can call a model:
     - company detection (`summaryService.js:513-523`);
     - the Jev gate (`:552-555`, an LLM call);
     - the prefetch (`:648-652`);
     - the career context (`:681-691`, `:716`).
7. **With a design kit, every turn the gate accepts goes to PROBE.** That is 18.1's profile, with:
   - the kit excerpt: Requirements used, the Decisions line, the Storage table and the deep dives' Pick lines. When the stored kit lacks those headings (rule 5), the excerpt is the kit cut at a line break, as the previous answer is cut today (`askPrompt.js:33-38`);
   - the PROBE shape instead of `LENGTH_RULE`;
   - no career context;
   - one LLM call per turn.

   The lane's gate, debounce, abort-and-replace, PASSIVE, history and failover are unchanged. Also:
   - **The career state is left alone.** A design problem that names a company ("design Uber") doesn't become the interviewer's company for the behavioral turns after it.
     - Each probe clears the follow-up state (`careerPrev`), as a general answer does today (`summaryService.js:725-727`).
     - The interviewer's last segment is still kept (`:528-532`).
   - **The probe reads the design kit when its debounce fires.** With no design kit for this Listen session by then, for example after `opening: uber`, it makes no call.
8. **Everything outside System Design · Live is unchanged.** Back in Default, the next turn is answered exactly as today, career context included, byte for byte. The other Ask modes are unchanged too.
9. **A badge.** While the mode is System Design · Live, the Live Answer pane shows "SD Live". A candidate who forgot to switch back sees it before answering the next behavioral question.
10. **The answer lane reads the mode without waiting.** `summaryService` doesn't read `askMode` today. A mode change is saved in `featureBridge.js:94`. The lane is told at the same point, and reads the mode from memory at each turn, with no settings read on the hot path.
    - **The copy in memory is loaded:**
      - when the app starts, since the saved mode survives a restart (`settingsService.js:219`);
      - after a mode change is saved;
      - at the start of each Listen session;
      - when the signed-in user changes, since the settings are per user (`settingsService.js:229`).
    - **Ask reads the same copy once per request,** so its checks and its prompt never see two different modes.
    - **A change into or out of System Design · Live drops the turns waiting for an answer:** the debounce, a pending Jev decision and the held set-ups. An answer already streaming finishes.
11. **The interview's language.**
    - **Every Ask mode** (System Design · Live, Default, Code, Debug and System Design) answers in the speech-to-text language, `sttLanguage` (pt-BR or en-US, pt-BR by default): the language the candidate sets for the interview so Listen transcribes it. `askAnswerLanguage` (`askLanguage.js:28`) reads it, Listen on or off, whatever the interviewer's turns or the typed text say.
    - The language sentence goes in the request ("The interview is in Portuguese: write the whole answer in Portuguese, …", `askUserText`, `askPrompt.js:81`), so the text-only retry, which rebuilds the request (`askService.js:526`), keeps it.
    - The fixed words carry no language. Without this rule the prompt answers "in the language of the typed text" (`promptTemplates.js:926`), so `design` typed in a Portuguese interview could give an English kit.
    - In every mode the headings stay in English, since the kit and the eval find the sections by them, and so does code, with its names and comments (the user's choice). System Design · Live keeps its own wording of the sentence.
    - The other modes still get no transcript ("No conversation history available.").
    - Each Ask logs the language: `[AskService] answer language: pt (stt)`.
    - **History.** The first version read the last 6 interviewer turns, then the typed text. On 2026-11-04 it was widened to every mode, with the STT language as a last source while Listen ran. The same day, `twitter` typed in System Design · Live with Listen off and the setting in Portuguese got an English kit: no turns, and a typed text with no language. The user then chose the STT language as the only source.

**Leaving the stage.** In v1 the candidate leaves by switching back to Default, and the badge is the reminder. Stop also ends it: the stored kit belongs to that Listen session (`askService.js:288`), so a new session starts with no kit. A second design problem starts in one of two ways, and rule 1's order starts again from either:
- typing `opening: <problem>` into Ask (rule 2), which stores a new opening kit;
- Stop and a new Listen session, which starts with no kit.

**Edge cases (2026-11-02).** Each row gives today's behavior, read in the code, and v1's. "Not checked in the app" marks what the code alone can't settle; those rows are among the checks in the app under Acceptance.

*Keys and the Ask window*

| Case | Today | v1 |
|---|---|---|
| Ctrl+Enter, Esc, Ctrl+Enter, Esc… before anything is sent | Ask opens and closes. No request | Same |
| Esc with a kit on screen or being written | Nothing happens (`AskView.js:949-959`) | Same |
| Ctrl+Enter pressed many times in a row, or held down | 1st press opens, 2nd sends, 3rd shows the box over the answer, 4th sends again and cancels the kit being written | One kit request: the 4th is refused while the kit is written (rule 4) |
| "twitter" typed, then Ctrl+Enter instead of Enter | An empty request is sent and "twitter" stays in the box (not checked in the app) | "twitter" is sent (rule 3) |
| Only spaces typed | Read as empty (`AskView.js:1334`) | Same; goes to rule 1 |
| Enter while an IME is composing | Ignored (`AskView.js:1348`) | Same |
| Close button while a kit is written | The kit is canceled and not stored (`askService.js:199-203`, `:461`) | Same; the next empty send asks for the same step |
| Close button after the kit is done | The stored kit stays (`askService.js:205-214`) | Same |
| Ctrl+\ hides every window while a kit is written | Windows are only hidden (`windowManager.js:257-262`); the kit keeps streaming and is stored | Same |
| Text left in the box, Ask closed and opened again | The text stays: the box is only hidden, never rebuilt (`AskView.js:1453`), and only a send clears it (`:1337`). A later Enter sends it | The box is cleared on close (rule 3) |
| Typed text sent while a kit is written | The kit is canceled | Refused, text kept (rule 4) |
| A fixed word typed with no kit (`design`, `full`) | Routed by the prompt | Sent as the fixed request (rule 2) |
| Empty send after a design kit | Routed by the prompt, usually a new design kit | A hint, no request (rule 1) |
| Esc, then Ctrl+Enter during the closing fade | Takes the send branch: Ask still reads as visible (`windowManager.js:448`, `askService.js:172`) | No request: Ask counts as closed from the press of Esc (rule 3) |
| Ctrl+Enter while Ctrl+\ has hidden every window | Shows Ask alone, with no header (`askService.js:187-195`); no request | Same |
| Text in the box, then Ctrl+\ twice | The text stays | Same: Ctrl+\ is not a close (rule 3) |
| Text typed in another mode, then System Design · Live | The text stays in the box | The box is cleared on entering the mode (rule 3) |
| Two empty sends in the same moment (held key, or the box and the shortcut both firing) | Both are sent; the second cancels the first | One request (rule 3), and the check of rule 4 comes before any wait |
| Enter on the empty, focused box after an opening kit | n/a | The design kit, in one press: rule 1 counts Enter on an empty box as an empty send. A residual risk; Ctrl+Enter keeps its two presses |
| `nextStep` rebound to another key | Ctrl+Enter in the box sends it, as Enter (`AskView.js:1353`) | Same: a one-press send of what is typed |

*Mode and the two lanes*

| Case | Today | v1 |
|---|---|---|
| The candidate switches into SD Live after the interviewer stated the problem | That turn was already answered by today's lane (the `design` cue, `questionGate.js:36`) | Same. Harmless: the kit doesn't use that answer |
| Mode switched while a kit is written | The request keeps the mode it started with (`askService.js:328`) and is stored when done | Same. The lane follows the new mode from the next turn |
| Out of SD Live and back, same Listen session | The stored kit stays (a mode change doesn't clear it) | Same; probes resume |
| Mode switched while a probe streams | n/a (new in v1) | The probe finishes as it started |
| Live Answer off (Live panels: Insights only) | n/a | Kits work; no probes, and the pane with the badge is hidden. v1 needs Live Answer on; each kit request with it off shows a hint in Ask |
| Mode switched during the 800 ms debounce, or while Jev decides on a turn | n/a | The waiting turn is dropped (rule 10); the next turn follows the new mode |
| Switch to Default while a kit is written, then an Ask in Default | n/a | The Default request cancels the kit, as today in Default (`askService.js:254-256`). Nothing is stored, and the next empty send in SD Live asks for the same step |
| A behavioral question while SD Live is on | n/a | A PROBE answer with the design's context; the badge is the reminder |
| The requirement-change line ("Now suppose we launch in Europe…") | n/a | It passes the gate (`suppose`) and gets a probe from the old design. The new kit comes when the candidate types `design` |
| A question while a new design kit is written | n/a | The probe uses the stored, previous design kit |
| The candidate's own speech | Never triggers an answer (`questionGate.js:446`) | Same |

*Sessions and failures*

| Case | Today | v1 |
|---|---|---|
| A kit made before pressing Listen | Stored with the Ask session. Listen then takes over that session (`listenService.js:145`, `sqlite.repository.js:96-99`) | Same: the kit stays valid |
| Stop while a kit is written | Stored for the ended session, never used by the next one (`askService.js:288`) | Same |
| App restart mid-interview | The kit and the transcript the prompts read live in memory (`askService.js:157`, the lane's `conversationHistory`) and are lost | Same loss. Recovery: type `design: <problem and requirements>` for a design kit at once, and probes resume. Restoring from the DB, which keeps the answer (`askService.js:476`), is v2 |
| Every provider fails, or the answer is empty | Not stored (`askService.js:461`, `:469-470`); an error line | Same; the next empty send asks for the same step |
| A fallback model changes the kit's headings | Not stored | Stored by request (rule 5); the probe excerpt falls back to the cut kit (rule 7) |
| Nothing names a problem | The "No problem yet" line | Same, and not stored: type the problem |
| The opening kit read the wrong problem from the transcript | n/a | Seen in its first line; type `opening: <problem>` |
| `opening: uber` typed after a design kit | n/a | An opening kit is stored, and Live Answer is silent until the new design kit (rule 6) |
| A design request answered with an opening kit | Stored as the previous answer | Stored as an opening kit (rule 5); the next empty send asks for `design` again |
| Two requests within a moment of each other | The first one doesn't check the cancel before calling the model: its stream runs to the end out of sight, and its text is saved to the DB (`askService.js:254-328`, `:474-476`) | The cancel is checked before the model call |

*Language*

| Case | Today | v1 |
|---|---|---|
| A Portuguese interview, `design` typed | The prompt answers in the language of the typed text (`promptTemplates.js:898`) | The STT language, set for the interview (rule 11) |

**Still uncertain in v1, and what limits it:**
- STT mishears the question, or the model answers badly. Same as today. The answer is visible, and the next question replaces it.
- A probe said in pieces is answered on its first half (item 1). Same as today: a continuation that reads as a question replaces the answer.
- A confirmed fact falls out of the 30-turn window (18.9). The design kit keeps what was confirmed before it, and typing `design` after a change makes a new kit.
- A provider fails over (`retrying` status) or every provider fails (an error line). Same as today.
- Whether the global Ctrl+Enter hides the key from the box is checked in the app at the start of the plan. Rule 3 works either way.
- Whether the global Ctrl+Enter reaches Glass while the VM's window has the keyboard. A VM can capture the keys before Windows' hotkeys see them. This is the first check in the app. If the VM takes the key, the typed path still works: click the Ask box and press Enter.
- Enter on the empty box, with the box focused, after an opening kit asks for the design kit in one press (rule 1). Ctrl+Enter keeps its two presses.

**Out of scope for v1 (possible v2, once measured):**
- detecting the move to System Design (keyword filter, then a cheap LLM check);
- the opening kit by itself;
- the design kit by itself, or on the candidate's check-in line (18.10);
- the DEEP DIVE route inside the answer lane;
- the career router inside the stage;
- restoring the kit from the DB after a restart.

**Acceptance:**
- [x] Unit tests (2026-11-02: `liveDesign.test.js`, `askService.systemDesignLive.test.js`, `liveAnswerSdLive.test.js`, `golden.test.js`; the whole suite, 1786 tests, passes):
  - rule 1: an empty send with no kit → `opening`; with an opening kit → `design`; with a design kit → the hint and no request;
  - rule 2:
    - each fixed word, in any case and with a final period, is sent as the fixed request, with and without a kit;
    - "design twitter feed" with no kit → `opening: design twitter feed`;
    - other text with no kit → `opening: <text>`, even when the transcript names another system or carries numbers;
    - other text with a kit → as typed;
  - rule 3: the second Ctrl+Enter sends the box's text; an empty box goes to rule 1; closing Ask clears the box;
  - rule 4: while a kit streams, an empty or typed request is refused and the text kept; closing Ask cancels the kit and stores nothing;
  - rule 5: the headings decide the type when recognized; with none, a kit request of at least 120 words is stored as the type it asked for; failed, canceled, empty and "No problem yet" answers are not stored;
  - rules 3 and 4, races: two sends in the same moment start one request; Esc then Ctrl+Enter within the fade sends nothing; the in-flight flag clears on every way out (done, error, cancel, close, no window);
  - rule 10: a mode change drops a waiting turn, also one waiting for Jev; after System Design · Live and back, the career state is as before;
  - rule 6: no LLM call and no IPC with no design kit;
  - rule 7: PROBE with a design kit, no career context, the excerpt and its fallback;
  - rule 8: Default again → today's messages, byte for byte; the other modes unchanged. Since 2026-11-04 the user turn of every mode adds rule 11's language sentence; the system prompts stay byte for byte;
  - rule 11: the language is the STT language, in every Ask mode;
  - one test per edge-case row that can run without Electron;
  - a snapshot taken before any change (`src/features/common/prompts/__tests__/golden/`): every profile's system prompt, the Ask messages of the other modes and the lane's messages for a fixed sequence of turns, compared byte for byte (rule 8). The System Design · Live prompt differs only by route 0, its language line and, since 2026-11-04, the box legend one per line.
- [ ] In the app, by hand:
  - first: Ctrl+Enter with the VM's window focused reaches Glass; and whether the box sees Ctrl+Enter;
  - Ctrl+Enter with "twitter" in the box sends "twitter";
  - Ctrl+Enter then Esc, ten times in a row, also within the closing fade: no request (no LLM call in the log);
  - a restart with System Design · Live saved: the badge shows, and Live Answer is silent until a design kit;
  - Ctrl+Enter held down for 2 s: one kit;
  - Esc and Ctrl+\ while a kit is written: the kit finishes and is stored;
  - a stray Ctrl+Enter pair after the design kit: the hint, no request.
- [x] Live, through the harness (`--text`), in English and Portuguese. Measured on 2026-11-02 (`npm run eval:live -- --only I --text --fast`, then `--only H`):
  - **Phase I (the lane): 11 of 11 pass.**
    - No call on the problem or on "Assume about 10 million…", in either language.
    - One call per probe, 5 probes, all on gpt-oss-120b. First token 1.2–1.4 s, 48–64 words, PROBE shape.
    - Each probe names the kit's choice: Redis and rebuild, Cassandra, pull.
    - A probe's prompt is about 6,300 characters, against about 10,900 for today's Live Answer in the same run.
  - **Phase H (the kits):** every case takes its route, the Portuguese `design` (H7) included, which came out in Portuguese with the headings as given.
    - H1 (`design` with the rate limiter screenshot) fails one check in both runs, "a write path and a read path". It always goes to Gemini 3.5 Flash-Lite, since the screenshot skips the models of the list that read no images. That model named the path "Write / Check path".
    - On 2026-11-01, before this change, the same case on the same model failed 3 runs out of 6, the route included.
    - The other cases only warn: on fallbacks, on word counts, and once, H5 on a fallback model, on a direct answer of 31 words (the limit is 25).

  The checks:
  - the probe shape, at most 90 words;
  - it names the store from the kit's Decisions line;
  - no answer on the script's "Assume about 10 million…" line;
  - kits in the STT language, the interview's;
  - the first token within 6 s;
  - exactly one call per interviewer turn;
  - tokens per call no higher than today's Live Answer, measured in the same run.
- [x] `npm run practice:sd-live` gains (2026-11-02, 18 steps after the setup; not yet run in the app):
  - a behavioral prologue: 2 behavioral questions before the design round, answered from the KB;
  - misuse steps: Ctrl+Enter and Esc in a row before anything, the header Ask button, typing while a kit is written, a stray Ctrl+Enter pair and a held Ctrl+Enter after the design kit;
  - the in-app checks of the acceptance list: Ctrl+Enter with the VM window focused (step 7), a restart with System Design · Live saved (step 3), Esc and Ctrl+\ while a kit is written (step 9), closing Ask during a kit (step 10), `opening: uber` after the design kit (step 15), text typed in Default cleared on entering the mode, and a held Ctrl+Enter that asks once (step 17).

  Each step checks itself from the Glass log. The app writes one `[SD Live]` line per load or change of the mode, per key in the mode, per send, refusal, hint, dropped repeat, stored kit, cancelled kit, silent turn and probe (`askService.js`, `summaryService.js`). The script reads the lines a step added and marks each expected count PASS or FAIL. It then asks for the checks only the eye can make, and writes a report with every result and the step's log lines to `%LOCALAPPDATA%\glass-practice\`. The log exists when Glass is started from the desktop shortcut or `start-glass.ps1`; with `npm start` in a terminal the automatic checks are skipped.

  The script types only the problem, `design` (steps 9, 10 and 13), the deep dive (step 11), `opening: uber` (step 15) and a word to be cleared (step 17):
  - the mode switches are clicks: into the mode, back to Default, and again in the new session;
  - the opening kit by typing `twitter` (step 5), and by a held Ctrl+Enter in a new session (step 17);
  - the design kit by Ctrl+Enter twice, with the VM focused (step 7);
  - probes answered on their own in steps 11 to 14. Step 13's line gets one from the old design, before `design` is typed.
- [ ] Before a real interview: one full run of the script with the same provider list and keys, checked against the list the script shows.

**Effort:** about 3 sessions:
1. 18.1 with rules 6, 7, 10 and 11;
2. the Ask side: rules 1 to 5 and the edge cases;
3. the badge, and the simulator's prologue and misuse step.

#### 18.12 Changes in red when `design` is typed again after a change

**Status:** Open. Planned on 2026-11-04 and not built; the owner chose to register it and build it later.
**Related:** 18.4. Item 18.4 proposes a short DELTA route that patches the stored kit. This item is the lighter option: the kit is still rewritten in full, and what changed shows in red.

**Summary.** After the design kit, the interviewer changes a requirement ("now a tweet can carry images"). The candidate types `design` and gets a new 750-word kit, with nothing to show what changed.

What happens today, read in the code on 2026-11-04:
- **The request:**
  - `design` with a design kit stored resolves to a design kit request (`resolveLiveRequest`, `liveDesign.js:62`).
  - `_send` passes the stored kit as the Previous answer (`askService.js:462`).
  - The prompt says to keep its decisions and numbers "unless the interviewer changed them" (`promptTemplates.js:803`). It never asks the model to say which ones changed.
- **The display:**
  - Ask draws the stream with `src/ui/assets/smd.js` (`renderStreamingMarkdown`, `AskView.js:1117`).
  - smd.js has no colour and adds text as text nodes, so HTML in an answer shows as text.
  - The fallback renderer (`renderFallbackContent`, `AskView.js:1165`) allows no `mark` tag.
- **The stored kit:**
  - The new kit replaces the stored one (`askService.js:635-636`).
  - The next `design` reads it, and so do the Live Answer probes, through its excerpt (`kitExcerpt`, `liveDesign.js:104`).

**The owner's choices (2026-11-04):**
- **The model marks what changed, and the app only colours it.** The model knows that "images" is the change. A diff in the app would also colour sentences that were only reworded.
- **Only a design kit rewritten after a design kit** is marked. The opening kit, deep dives and probes stay as they are.

**Proposed:**
1. **The request** (`askPrompt.js`):
   - `askUserText` (`:81`) and `buildAskMessages` (`:114`) take `markChanges`, false by default. When it is true, the user turn adds one sentence after the language sentence. A draft, to tune against the eval:

     > Mark the changes: the Previous answer is your design kit before the interviewer's latest change. In this kit, wrap each part that differs in substance from it (a new or changed requirement, number, component, step, table row or decision) in ==…==. Do not mark rewording, a heading, or anything inside the diagram's fenced block; mark a new box in the list under the diagram. If nothing changed, mark nothing.
   - The system prompts don't change. Without `markChanges` the messages are today's, so the golden test (`golden/capture.js` calls `buildAskMessages` without it) does not change.
2. **When** (`askService._send`): `markChanges` is System Design · Live, with `kitRequest === 'design'` (`design`, `next`, `design: X`, `full`) and a stored kit of kind `design`. The text-only retry (`askService.js:526`) sends the same sentence. Log `[SD Live] ask: design update — changes marked`.
3. **The stored kit has no marks** (`liveDesign.js`):
   - A pure `stripChangeMarks` turns `==x==` into `x`. It leaves fenced blocks and inline code alone, so a `==>` arrow in the diagram is kept, and an unpaired `==` too.
   - `storeKit` (`:153`) stores the stripped text. Its excerpt comes from it.
   - So the next `design` compares against a clean kit, and the probes get no `==`.
4. **The colour** (`smd.js`, a second local change, listed in the file header like the underscore one):
   - A `MARK` token drawn as `<mark>`, next to `STRIKE` in `default_add_token` (`:1589`, `:1611`).
   - **It opens on `==`** followed by a character that is not a space, `=`, `>` or `<`, and preceded by the start of the line, a space or punctuation, never a letter or digit. So `a == b`, `x==y`, `==>` and `===` stay text.
   - **It closes on `==`.** An unclosed mark ends with its block, like the other inline tokens.
   - **It never opens** in code, links or images.
5. **Ask** (`AskView.js`):
   - **The colour:** `mark` with a transparent background and red text, also inside `strong` and inline `code` (about `#ff6b6b` on the dark overlay). Check that `body.has-glass` doesn't override it.
   - **Copy:** the copy button (`handleCopy`, `:1292`) and the per-line copy drop the `==`.
   - **The fallback renderer** drops them before `marked`.
6. **Unit tests:**
   - `askPrompt` and `askService.systemDesignLive`:
     - the sentence only on a design kit request with a design kit stored;
     - none after an opening kit, on a deep dive or a probe, or outside the mode;
     - the stored kit has no marks.
   - `liveDesign`: `stripChangeMarks`.
   - `smd.test.js`:
     - a mark in a paragraph, a table cell, a list item, and around bold;
     - `a == b`, `x==y`, `==>`, `===` and `==` in code stay text;
     - an unclosed mark;
     - each case parsed in one chunk and one character at a time.
7. **Live eval, phase H:**
   - **New cases:**
     - **H8**: `previous: 'H3-design'`, the confirmed transcript plus "them: One change: a tweet can now carry up to 4 images.", then `design`;
     - **H9**: the same change in Portuguese on H7;
     - **H10**: `design` again with no change.
   - `run.js` sets `markChanges` the way the app does.
   - **Checks:** a `checks.changeMarks` lists the marked spans, those in a heading or a fenced block, and the share of marked words. The kit checks read the stripped text.

**Acceptance (when implemented):**
- [ ] `npm test` passes; `golden.test.js` and the existing `smd.test.js` cases pass unchanged.
- [ ] In the app (run-glass driver), a response streamed in pieces shows the marked parts in red. The diagram with a `==>` arrow stays intact, and the same holds with `body.has-glass`.
- [ ] Gemini, 3 runs of phase H:
  - [ ] H8 and H9 mark the image change in 3 of 3, never in a heading or the diagram, and keep today's design kit checks (headings, paths, diagram, language).
  - [ ] Over 35% of words marked only warns.
  - [ ] H10 has at most 2 marked spans.
  - [ ] H1 to H7 have no marks and keep today's results.
- [ ] Qwen, one case per run a minute apart (`--cases H8`, `--cases H9`): each answered case marks the change.

**Risks:**
- **smd.js draws every Ask mode.** The opener rules and the one-character-at-a-time tests guard the code and comparison cases.
- **A model that marks nothing** gives today's kit.
- **A model that marks too much** gives a kit with more red than needed. H10 measures it.

**Effort:** about 1 session, plus the eval runs.

---

## Items 19 to 25: from the real session of 2026-11-02

Found reviewing a real English screening session on 2026-11-02: 11 minutes, 19 answers, all routes right, no question missed. Not in the work order at the top; each gets its own plan. Number 18 is taken by the System Design · Live proposals.

The same session met item 11's length target for the first time on a real session: median 52 words, longest 105, none over 120, none ending in a summary paragraph. It was a screening with no technical questions, so it does not compare one to one with the sessions of 2026-10-28 and 2026-10-29. It also brought back items 1 (one question split over two turns got two answers with different numbers), 10 (an invented start date, marked; a practice placed at the wrong employer, not marked) and 15 ("Claude Code" heard as "cloud code").

## 19. Live Answer career context — the answer confirms a wrong order of employers

**Status:** Open, found on 2026-11-02 (answer #7 of the session).
**Severity:** HIGH (a false fact about the candidate, said at the point the interviewer is checking)
**Code:** the career addendum (`ADDENDUM_TEMPLATE`, `src/features/common/career/contextBuilder.js`); `findUnsupported` (`answerCheck.js`), which checks numbers and never-used technologies only.

### Summary

The interviewer restated the candidate's history in the wrong order and in the wrong relation: an employer of record and the clients it placed the candidate with, told as three jobs one after the other. The answer, from the fallback model (gpt-oss-20b), opened by confirming that order. Its bullets corrected it only in part, and the candidate corrected it out loud. The canonical card states the relation; the check cannot see it, since it holds no number.

A smaller case in the same session: an answer gave the candidate's current title the start date of the latest client, not the date of the title.

### Proposed

1. **Prompt:** when the interviewer restates the candidate's history, the answer checks it against the canonical facts and corrects what differs, first line first, instead of agreeing.
2. **Card:** state the employer-of-record relation and the dates in one line the model can quote ("employed by X since …; placed with A (dates), then B (dates)").
3. **Check, later:** compare the order of known employer names in an answer with the card's order and dates. Measure false alarms on the replay answers first, as 10b did.

### Acceptance (when implemented)

- [ ] A replay of this turn opens by correcting the order, five runs out of five, on the main model and on the fallback model.
- [ ] No answer in the replay set of items 10 and 11 gets worse on the hand count.

---

## 20. Live Answer — a restatement or an echo gets a full answer again

**Status:** Open, found on 2026-11-02 (answers #8 to #10 and #13).
**Severity:** MEDIUM
**Code:** the question gate (`questionGate.js`: `isBackchannel`, `endsWithConfirmationCheck`); the live answer prompt in `summaryService.js`.

### Summary

The interviewer restated what the candidate had just said ("So basically you are with [employer]." / "Just couple days? Okay."). Each restatement got a full answer: three answers in 34 seconds said the same thing, and one echoed the candidate's own words back. Item 12 covers a confirmation check with a tag ("…, okay?") and gives it one line; these turns have no tag, or the tag follows an echo of the candidate's last turn.

The extra answers also spend the per-minute quota (see item 22).

### Proposed

1. **Gate:** a short turn that mostly repeats the candidate's last turn (word overlap above a threshold, a few words, no question word) is a restatement: answer it with one line, as item 12 does, or not at all.
2. **Prompt:** when the turn restates the previous answer, reply in one line ("Yes, exactly", or the one correction) instead of repeating the answer.
3. **De-dup:** skip an answer whose text would match the previous answer's headline.

### Acceptance (when implemented)

- [ ] On this session's replay, the three restatements give at most one line each, and the real questions keep their answers.
- [ ] The live eval loses no question it answers today.

---

## 21. Live Answer career context — a follow-up answers about the wrong referent

**Status:** Open, found on 2026-11-02 (answer #6).
**Severity:** MEDIUM
**Code:** the follow-up state in `src/features/common/career/index.js` (`vectorQueryText`, `prev.anchorText`, spec FR-006 and FR-009, E41 and E42).

### Summary

The candidate had just named a former employer; the interviewer asked a short follow-up about it ("the same company… the client, or?"). The follow-up kept the previous question's anchor and notes, which were about another subject, and the answer spoke about a different employer. The candidate's last turn, which held the referent, did not weigh in the search.

A follow-up chain also carried unrelated notes into a later answer (#10).

### Proposed

1. For a follow-up, add the names and key terms of the candidate's last turn to the keyword query, next to the previous question's terms.
2. When the follow-up names, or the candidate's last turn names, an employer the anchor does not, drop the anchor.
3. Replay cases, anonymized: a follow-up about the employer the candidate just named.

### Acceptance (when implemented)

- [ ] A replay of this turn answers about the employer the candidate named.
- [ ] E41 and E42 still pass, and the KB eval does not lose recall.

---

## 22. Live Answer — a burst of turns pushes answers off the main model, and the reason is not kept

**Status:** Open, found on 2026-11-02.
**Severity:** MEDIUM
**Code:** the Groq provider chain (`src/features/common/ai/`), `live_answers` (`src/features/listen/summary/repositories/liveAnswers.js`, schema in `src/features/common/config/schema.js`).

### Summary

7 of 19 answers came from fallback models (3 gpt-oss-20b, 3 qwen, 1 gemini), against 4 of 34 and 3 of 18 in the two earlier sessions. All seven fell in a two-minute stretch with ten answers in a row. Three of the session's five worst answers are among them, item 19's included. The pattern matches the per-minute token limit of the main model, shared with the router and the insights, but the row keeps only the model that answered, not why the main one was skipped.

Seen again on 2026-11-03, larger: 17 of 43 answers came from fallback models (11 gpt-oss-20b, 4 qwen, 2 gemini). Four of them had only one other answer in the minute before, so it is not bursts alone. The answer that came from gemini took 5 seconds to its first token.

### Proposed

1. **Record the reason:** save the fallback's cause in `live_answers` (rate limit per minute or per day, error, timeout) and show it in `export-live-answers.js`.
2. **Spend less in a burst:** item 20's restatements are part of it; also check what else draws on the same model's per-minute budget during an answer.
3. Then decide, with the numbers: a second key or provider for bursts, or a faster fallback order.

### Acceptance (when implemented)

- [ ] The export shows the reason for each fallback.
- [ ] On the next real session, the fallbacks and their causes are counted, and the decision in step 3 is taken from them.

---

## 23. STT — the "CLAUDE.md" keyterm pulls other words toward "Claude"

**Status:** Open, found on 2026-11-02. A side effect of item 15.
**Severity:** LOW
**Code:** `src/features/listen/sttKeyterms.js`.

### Summary

The candidate said "CLT" (a Brazilian employment contract) and the transcript read "CLAUDE contract", in the keyterm's casing. The same turn heard the other contract type ("PJ") as "two b". "Claude Code" was still heard as "cloud code" in real speech.

Seen again on 2026-11-03, wider than "CLAUDE.md":
- two company names from the notes (folders of other hiring processes) took the place of an employer's name and of an AWS service's name;
- the fixed term "Django" took the place of ".NET";
- "cloud" became "Claude" in "the cloud was AWS".

The other way, the entity names worked: two names that another recorder of the same call got wrong (an API vendor's and a team's) came out right here.

### Proposed

1. Check whether "CLAUDE.md" is worth its slot: compare the audio eval with and without it.
2. If the contract terms come up in interviews, try adding them ("CLT", "PJ") and measure as item 15 did.
3. Send the STT only the names that can come up: the employers, the entities and the active company, not every company folder of the notes. Drop a fixed term whose pull costs more than it fixes ("Django" first), measured on the audio eval.

### Acceptance (when implemented)

- [ ] The audio eval keeps the terms item 15 got right, and "CLT" is no longer heard as "CLAUDE".

---

## 24. Live Answer career context — the questions for the interviewer repeat

**Status:** Open, found on 2026-11-02 (answers #1 and #18).
**Severity:** LOW
**Code:** `INVITE_ADDENDUM` (`contextBuilder.js`); the invite route (spec 2026-10-13-career-router-jev, R21).

### Summary

The two invitations to ask questions, at the start and at the end, got the same suggested questions. The second one ignored what the interviewer had said in between about the role.

### Proposed

1. The invite answer leaves out questions the conversation already answered and questions an earlier invite answer suggested.

### Acceptance (when implemented)

- [ ] A replay of both invitations gives different questions, and none the conversation already answered.

---

## 25. Live Answer career context — a question about the start date does not get the availability note

**Status:** Open, found on 2026-11-02 (answers #11 and #12; the note came with #1 and #18 instead).
**Severity:** LOW to MEDIUM. Related to item 5 (retrieval).
**Code:** the note search (`retriever.js`, `bm25.js`); the router's company and invite routes.

### Summary

Asked how soon the candidate could start, the answer did not get the note that holds the availability. One answer invented a number of weeks (the check marked it); the other gave a different one and a line that contradicted it. The same note came with the two invitations to ask questions, where it did not help.

The private notes also give the start date in more than one version; fixing that is a notes task, outside this repo.

### Proposed

1. Add availability and start-date phrasings, in English and Portuguese, to the KB eval's question sets, and check where the note ranks.
2. If it ranks low, add the missing terms to the search (a synonym list or the note's title) rather than a special case.

### Acceptance (when implemented)

- [ ] The KB eval's start-date questions retrieve the availability note in the top k.
- [ ] A replay of this turn states the note's start date and no invented number.

---

## Items 26 to 31: from the real session of 2026-11-03

Found reviewing a real Portuguese culture-fit interview on 2026-11-03: 32 minutes, 43 answers, one PASSIVE (right), no question missed. Cross-checked against a second transcript of the same call, from another recorder. Not in the work order at the top; each gets its own plan.

The session met item 11's length target in Portuguese (see item 11). It also brought back:
- item 1: two questions split over turns got three and two answers;
- item 10: claims the candidate had just contradicted, and a title inflated from "founding engineer" to "founder";
- item 15: "Claude Code" heard as "Cloud Code";
- item 20: 11 of 43 answers went to turns with no question, three of them 80 to 115 words while the interviewer was presenting;
- items 22 and 23, updated there.

## 26. Live Answer career context — pay numbers reach the screen although the card says not to state them

**Status:** Open, found on 2026-11-03 (four answers).
**Severity:** HIGH (what the candidate says about pay is a negotiation: a number on the screen can anchor it, and one was wrong)
**Code:** the card goes into the block as is (`buildContextBlock`, `src/features/common/career/contextBuilder.js`); the pay cues `background:pt-salario` and `background:logistics` (`intentRouter.js`); `findUnsupported` (`answerCheck.js`) marks only numbers the notes lack.

### Summary

The card has a "not stated" line: no numbers for pay, benefits or expectations; if asked, say it is early. Four answers to pay questions gave the base salary to the unit, benefit values, a yearly total and an expectation range. One gave the profit-sharing multiple wrong; the candidate gave a lower one a minute later. The numbers come from notes of earlier hiring processes (debriefs and transcripts) that the search brought with the question. None was marked, because the notes hold them.

### Proposed

1. **Manifest:** a `notStated` list of topics in the KB manifest, as `notUsed` is, turned into an addendum line that wins over the notes: "State no numbers for …; say …".
2. **Block:** on a pay turn (the cues above, or Jev's route), drop money figures from the chunks, or leave out chunks whose title is a pay topic. The card line stays.
3. **Check:** on a pay turn, mark a currency amount or a "N salaries" multiple even when the notes hold it.

### Acceptance (when implemented)

- [ ] A replay of the four pay turns gives no money figure and no multiple, on the main model and on a fallback model.
- [ ] Answers to other turns keep their numbers (the replay set of items 10 and 11).

---

## 27. Live Answer career context — a question about the candidate falls to the general route when Jev is unsure, and the answer invents

**Status:** Open, found on 2026-11-03 (three answers; seven turns decided by the regex after Jev).
**Severity:** MEDIUM to HIGH
**Code:** `jevRouter.js` (below `minConfidence`, `regexDecision(…, 'low')`, logged as `regex(low)`); the regex cues in `intentRouter.js`; the general route gets no notes and no card (`index.js`, `route === 'general'`).

### Summary

In seven turns Jev answered under its confidence floor and the regex decided. Three were questions about the candidate in forms the regex does not cover ("is all of your cloud on one provider?", "and is there profit sharing?", "what is it like there today?"). They went general and got no notes, and the answers made the facts up: a second cloud provider for AI work, a quarterly bonus tied to goals, colleagues who had left. One was written in the second person, as if about the interviewer.

### Proposed

1. Under the floor, when Jev's own pick is personal, keep personal with the card only (no chunks) instead of going general.
2. Regex cues for questions about the candidate's current setup in the plural ("de vocês", "your team's"), measured on item 5's sets.
3. The general prompt: when the turn asks about the candidate and no notes came, answer in the first person with only what the turn says, or say what to check.

### Acceptance (when implemented)

- [ ] A replay of the three turns routes personal, or answers with no invented fact.
- [ ] Item 5's and item 13's sets lose no accuracy.

---

## 28. Live Answer career context — a question about life outside work gets a work pitch or invented details

**Status:** Open, found on 2026-11-03 (two answers).
**Severity:** MEDIUM
**Code:** the note search (`retriever.js`, `bm25.js`); the live answer prompt in `summaryService.js`.

### Summary

Two turns asked about the candidate outside work: who they are without the badge, where they live, what they eat, what they like to do. One answer gave the professional pitch. The other invented food and sports preferences. The notes hold the candidate's hobbies, but no chunk with them came.

### Proposed

1. Add off-work phrasings, in Portuguese and English, to the KB eval's question sets, and check where the hobby notes rank.
2. The prompt: for a question about life outside work, use only what the notes or the card say; with nothing, give one line for the candidate to fill in, not invented details.
3. For the KB, outside this repo: a line about life outside work in the card.

### Acceptance (when implemented)

- [ ] The KB eval's off-work questions retrieve the hobby note in the top k.
- [ ] A replay of both turns states no invented preference.

---

## 29. Live Answer career context — a short company name is neither heard nor detected

**Status:** Open, found on 2026-11-03.
**Severity:** MEDIUM
**Code:** `companyNamesFor` (`kbService.js`: the aliases, else the folder name); `compileCompanyDetector` (`index.js`, fuzzy matching only from `FUZZY_MIN_LEN` = 7 characters); `keyterms` (`index.js`); `sttKeyterms.js`; `CAREER_KB_COMPANY`.

### Summary

The interviewer's company had a notes folder but no alias in the manifest, so its name reached the STT keyterms and the company detector as the lowercase folder name: one short word.

- The STT wrote it five other ways, two of them names of other companies.
- The detector never matched, since the name is too short for fuzzy matching.
- The one company-route turn got no notes about the company, and its answer named another company.
- The company's research note came into one answer only, through the search.

### Proposed

1. Warn, in the debug log and in the KB eval, when a company folder has no alias. Title-case the folder name when it is used as a keyterm.
2. Match the STT's variants of short names: aliases per company in the manifest (the KB's job), or a sound-alike match for names under 7 characters, measured for false switches (E32).
3. Document `CAREER_KB_COMPANY` as the way to fix the company for a session, and check that it also sends the name to the STT.

### Acceptance (when implemented)

- [ ] A replay of this session with the fix detects the company on its first mention, and the company-route turn gets the company's notes.
- [ ] E31 and E32 still pass.

---

## 30. Live Answer career context — the check marks numbers the card writes in words

**Status:** Open, found on 2026-11-03 (four of the seven marked answers).
**Severity:** LOW to MEDIUM (false marks teach the candidate to ignore the real ones)
**Code:** `findUnsupported` and `fitsNotes` (`src/features/common/career/answerCheck.js`), which read digits in the notes only.

### Summary

Four marked answers were right. The card writes some numbers in words ("about six years", "five and a half", "cut by half"), the answers gave digits ("6", "5,5", "50 %"), and the check found no such number in the notes. Two answers also had "13 years" marked as another result, against a card line that says "13+ years"; the cause is not checked yet.

Among the other marked answers, two real marks: an invented duration and an invented benefit value.

### Proposed

1. Read number words in the note lines as numbers: English and Portuguese, up to twenty, the tens, "half", "and a half", "a dozen".
2. Find why "13" is marked as another result next to "13+", and add the case to the tests.

### Acceptance (when implemented)

- [ ] The four answers come out unmarked, and the two real marks stay.
- [ ] On the replay answers of 10b and 14, no real mark is lost.

---

## 31. Live Answer — a connection check after a career answer is taken as a follow-up

**Status:** Open, found on 2026-11-03 (three answers).
**Severity:** MEDIUM. Related to item 20.
**Code:** Jev's follow-up score (`jevRouter.js`, `FOLLOW_UP_MIN`); the question gate (`questionGate.js`, `isBackchannel`).

### Summary

Right after a career answer, the interviewer's audio dropped: "did it freeze?", "are you back?". Jev scored both turns as follow-ups, so they kept the personal route and got career notes. One answer added two bullets about the stack and took 5 seconds on a fallback model. In the same stretch, a garbled one-word fragment (the STT's version of "automation") got a made-up one-line answer.

### Proposed

1. **Gate:** a short connection check ("travou?", "voltou?", "está me ouvindo?", "can you hear me?", "you froze") is not a question. No answer, or one fixed line without the LLM.
2. **Follow-up:** a turn of one or two words needs a content word or a follow-up marker to keep the previous route.

### Acceptance (when implemented)

- [ ] A replay of these turns shows no career content.
- [ ] Item 9's and item 12's cases still pass.

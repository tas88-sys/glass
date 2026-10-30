# Future Work

Deferred enhancements that are intentionally **out of scope for their current version** but worth tracking. Each item links to its GitHub tracking issue (on the `tas88-sys/glass` fork) where applicable.

---

## Work order for items 9 to 15 (agreed on 2026-10-30)

One step at a time, each with its own plan, a fresh session per step. When a step is done, tick it here, set the item's **Status** to Done with the date and branch, and start the next session from this list.

| Step | Item | Why here |
|------|------|----------|
| [ ] 1 | 12. Confirmation one-liner in the wrong language | Small and isolated. It touches the same prompt as 10 and 11, so it goes first and sets up the prompt test and eval loop. |
| [ ] 2 | 9. The extracted question picks the wrong span | First stage of the flow: it decides whether a turn is answered and which span goes to routing and the note search, so the evals of 10 and 11 run on the right questions. It also stops the answers to reported questions that produced the "not used" technology claim. |
| [ ] 3 | 10a. Prompt rule, temperature 0.2–0.3 on personal/ambiguous, "not used" list in the addendum (item 10, steps 1 and 4 first half) | The only HIGH item, and its cheap half. The "not used" list needs a `notUsed` field in the career KB manifest, which lives in the separate, private KB repo. |
| [ ] 4 | 11. Answers too long | Same prompt. After 10a because the lower temperature already changes answer length; measured before 10a, the numbers would be stale. |
| [ ] 5 | 14. The live check marks technical constants | `findUnsupported`. Before 10b: 10b needs its false-alarm rate measured, and that is not readable with this noise in. |
| [ ] 6 | 10b. Neighborhood check and marking "not used" technologies (item 10, steps 2–3 and 4 second half) | Same file as 14, now without the noise. |
| [ ] 7 | 13. A question about the candidate's own setup routes general | After 9, since the 2026-10-29 turn had no question and should then get no answer; what is left are real questions about the setup. Uses item 5's held-out sets, so it can share a plan with item 5. |
| [ ] 8 | 15. STT terms heard as other words | Independent, lowest severity, costliest to measure (audio eval before and after). Can move into any gap. |

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
- **English question, Portuguese note.** Measured on 2026-10-12 (R15 to R17): of the 169 sections the eval expects, 50 reach the model when the questions are asked in Portuguese and 54 in English; 6 are still lost in English, in 5 notes. An English summary line inside a long Portuguese section did not help (52). A subsection with its own English heading did (54), since the title weighs 3 in the keyword search and has its own vectors; done for three answers in the notes repo. Left: the other answers lost in English (only one section per note file is sent, and three of the lost ones share a file), and the technology list in the skills note, which needs the candidate's review.
- **Ambiguous gate.** Part of T027: label turns "should inject" or "should not" and set the threshold from them.

### Acceptance

- [ ] A live-coding turn set exists, and its turns routed personal are counted before and after any guard.
- [ ] On a new English held-out set, questions about the candidate routed general are counted before and after.
- [ ] The eval's Portuguese questions asked in English send the right note as often as in Portuguese, or the gap is explained.
- [ ] The ambiguous threshold is set from labeled turns (T027).

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

**Status:** Pending. Found on 2026-10-28 reviewing a real Portuguese session (34 answers in `live_answers`); seen again on 2026-10-29 in an English session (18 answers, 3 of them to reported questions); not started. Step 2 of the work order at the top of this file.
**Severity:** MEDIUM
**Code:** `extractQuestion` (`src/features/listen/summary/summaryService.js:76`), the gate helpers in `src/features/listen/summary/questionGate.js`

### Summary

The answer prompt quotes the whole interviewer turn (`makeLiveAnswer`, `asked = rec.turn`), so the model usually answers the right topic. But the extracted `question` also goes to `resolveCareerContext` → `getCareerContext(text, { question })`, so a wrong span **picks the route and the notes**, and it is the `Q:` label the panel and the history show.

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

- [ ] The four shapes extract "você diz escalada pelo quê?", nothing (held), "o que é uma arquitetura MVC? / por que a gente quebra em 3 níveis?", and "Beleza?" or a one-line reply.
- [ ] The scalability shape routes general, not personal.
- [ ] A scenario set up over two or three turns produces one answer, after the question.
- [ ] The three 2026-10-29 shapes (an explanation of the next round quoting the questions someone else will ask) produce no answer, in English and in Portuguese.
- [ ] Existing `extractQuestion` and gate tests still pass; the live eval loses no question it answers today.

---

## 10. Live Answer career context — a real number attached to the wrong claim

**Status:** Pending. Found on 2026-10-28 in the same session as item 9; not started. Do it in two steps: prompt and temperature first, then the check (steps 3 and 6 of the work order at the top of this file).
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
- [ ] Unit cases for `findUnsupported`: same number, same employer, different result → flagged; same number and result → not flagged; Portuguese answer with an English note → not flagged.
- [ ] False-alarm rate of the neighborhood check measured on the eval set and recorded here before it ships.
- [ ] A personal answer naming a technology from the "not used" list is marked in the panel; with the addendum line, a replay of the 2026-10-29 turn names none.

---

## 11. Live Answer — answers too long to read while speaking

**Status:** Pending. Found on 2026-10-28 in the same session as item 9; not started.
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

---

## 12. Live Answer — the one-line reply to a confirmation check comes out in Portuguese

**Status:** Pending. Found on 2026-10-29 in an English session; not started. Small and isolated: step 1 of the work order at the top of this file.
**Severity:** LOW (visible, easy to fix)
**Code:** `CONFIRMATION_CHECK_RULE` and its use in `makeLiveAnswer` (`src/features/listen/summary/summaryService.js`); `answerLanguageRule` (`src/features/listen/summary/questionLanguage.js`). Spec: `specs/2026-10-16-confirmation-check-answer/`.

### Summary

Two English turns ending in "Okay?" ("… in case we decide to advance with you to the interview with the client … Okay?", "So we will be in touch … Okay?") got "Perfeito, está claro." and "Combinado, obrigado.". The rule's examples are in Portuguese only, and the model copies them word for word, overriding the language rule in the same message.

### Proposed

1. Give the examples in both languages ("Perfect, that's clear." / "Sounds good, thanks."), or pick the example by `questionLanguage(asked)`.
2. Say in the rule itself that the reply follows the turn's language.

### Acceptance (when implemented)

- [ ] A unit case: an English turn ending in "Okay?" builds a rule whose example is in English; a Portuguese one keeps the Portuguese example.
- [ ] Live eval: an English confirmation check gets an English one-liner.

---

## 13. Live Answer career context — a question about the candidate's own setup routes general

**Status:** Pending. Found on 2026-10-29; not started. Related: item 5 ("English questions about the candidate that still route general").
**Severity:** MEDIUM (the answer invented a setup)
**Code:** `classifyCareerIntent` (`src/features/common/career/intentRouter.js:268`), the Jev router (`jevRouter.js`), the regex fallback (`routeFallback`, `src/features/common/career/index.js:374`)

### Summary

A turn about the candidate's AI setup ("you can arrive with your AI setup, your CLAUDE.md, the skills you usually use … being able to explain your setup") routed **general** (`regex(low)`: Jev gave no route and no regex cue matched), so no notes were sent. The model then described a setup of its own: a Python LLM framework, a different vendor's model and a test runner, none of which the candidate uses; the notes describe the real one (an agentic coding CLI with specs, skills, hooks and MCP).

### Proposed

1. Regex cues for the candidate's tools and way of working: "your setup", "your (AI) setup", "your skills", "the tools you use", "your workflow", "how you use AI", "seu setup", "suas skills", "como você usa IA".
2. Add the shape to Jev's labeled set if it keeps routing general.
3. Measure as in item 5: a small held-out set written before the change; count questions about the candidate routed general before and after.

### Acceptance (when implemented)

- [ ] A direct question about the candidate's setup, anonymized, routes personal and gets the setup note. (Not the 2026-10-29 turn itself: it has no question, and after item 9 it gets no answer.)
- [ ] On item 5's held-out sets, no question about the code on screen moves to personal (the live-coding guard there still holds).

---

## 14. Live Answer career context — the live check marks technical constants as claims

**Status:** Pending. Found on 2026-10-29; not started.
**Severity:** LOW (noise that hides the real marks)
**Code:** `findUnsupported` (`src/features/common/career/answerCheck.js`)

### Summary

In the 2026-10-29 session the check marked "429" (an HTTP status in "avoids 429 errors") and "300" (an illustrative threshold, "e.g., > 300 lines") as unverified, while the invented "30%" and the unused technology passed (item 10). Marks on constants teach the reader to ignore marks.

### Proposed

1. Skip HTTP status codes next to HTTP words ("429 errors", "a 503", "status 404", "HTTP 500"): 3-digit numbers from 100 to 599 within a few words of "error", "status", "HTTP", "response", "code".
2. Skip numbers inside an example frame: "e.g.", "for example", "por exemplo", "like > N", "such as".
3. Keep marking percentages, money and durations everywhere: those are the claims that matter.

### Acceptance (when implemented)

- [ ] Unit cases: "avoids 429 errors" and "(e.g., > 300 lines)" → not marked; "cut latency by 30%" with no 30 in the notes → marked.
- [ ] On the 2026-10-28 and 2026-10-29 sessions' answers (replayed against their notes), the marks left are only real claims.

---

## 15. STT — interview terms heard as other words

**Status:** Pending. Found on 2026-10-29 in an English session; not started.
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

- [ ] The live eval's word error on the added terms goes down, and no other item gets worse.
- [ ] The keyterm list stays under Deepgram's cap (`sttKeyterms` unit tests).

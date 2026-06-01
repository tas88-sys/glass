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
| **Personalized answers (v2)** | Wire the candidate's résumé/bio into the prompt's currently-empty `customPrompt` slot (`promptBuilder.js` injects "User-provided context"; today it's empty → behavioral answers are generic "User context unavailable"). Unlocks personalized behavioral/statement answers. |
| **Persistence (cross-session)** | A newest-first **in-session** answer history now ships (renderer memory, cleared on Stop / new session — see CHANGELOG "Live Answer is now a newest-first history"). Still open: persisting answers to the session DB so they survive an app restart (the summary lane's `summaryRepository.saveSummary` path is deliberately not extended). |
| **Ask transcript wiring** | Make Ask receive the live transcript — a separate, pre-existing gap that the design doc and prompts brief raise but leave open. |

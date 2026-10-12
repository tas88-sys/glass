# Quickstart & Verification: Live Features Toggle

**Spec**: `2026-10-12-live-features-toggle`
**Date**: 2026-10-12

## 1. What the three modes do

| Mode (Settings button) | Live Answer | Live Insights | Listen window | LLM calls an hour (typical, research R2) |
|------------------------|-------------|---------------|---------------|------------------------------------------|
| **Answer + Insights** (default) | runs | runs | both panes, as today | ~75 (about 50 answers, 25 summaries) |
| **Answer only** | runs | off | one pane, "Live answer", "Waiting for a question..." until the first one | ~50 |
| **Insights only** | off | runs | one pane, "Live insights" | ~25 |

- **Off means no work.** The lane makes no LLM call, sends nothing to the window and spends no tokens. It is not just hidden.
- **The transcript is always on.** Capture, the "Show Transcript" view and the saved transcript do not depend on the mode.
- **A change applies from the next turn.** No restart, no new session.
- **With Insights off, no summary is saved** for the session. A session shorter than 5 turns has none today either.
- **Ask is not affected** in any mode.

## 2. Where to change it

Settings (the settings icon in the header) → the button under **Automatic Updates**: "Live panels: Answer + Insights". Each press moves to the next mode: Answer + Insights → Answer only → Insights only → Answer + Insights. The grey line under it says what "off" means.

Which mode fits:
- **Groq Free plan** (8K tokens a minute, 200K a day per model): **Answer only**. It leaves the daily budget to the answers and takes the summary calls out of the minute your answers need.
- **Taking notes of a meeting with no questions to answer**: **Insights only**.
- **Plenty of quota**: the default.

No env var, no config file.

## 3. Automated checks

```bash
npm test                                   # whole suite, incl. liveFeatures.test.js, summaryService.liveFeatures.test.js, liveAnswerHistory.test.js
node --test src/features/listen/__tests__/liveFeatures.test.js                          # the rule, the cycle, the labels
node --test src/features/listen/summary/__tests__/summaryService.liveFeatures.test.js   # lane gates over a stub LLM
node --test src/features/listen/summary/__tests__/liveAnswer.test.js src/features/listen/summary/__tests__/liveAnswerCareer.test.js   # unedited, must stay green
npm run build:renderer                     # ListenView, LiveAnswerView, SettingsView compile
npx -p typescript@5.4.5 tsc -p specs/2026-10-12-live-features-toggle/contracts/tsconfig.json
```

## 4. Manual verification (running app)

`npm start`. Watch the main-process log for `[Live] features=…`, `[live-answer]`, `Triggering analysis` and the provider request lines. Checks 3–6 need audio on the system channel: play a short mock interview (a few spoken questions, with filler between them) so that `them` turns arrive. Each check spends a few provider requests; checks 1, 2 and 7–9 spend none.

| # | Do | Expect | Covers |
|---|----|--------|--------|
| 1 | Open Settings | Button "Live panels: Answer + Insights" with the grey help under it. Press three times: Answer only → Insights only → Answer + Insights. Each press logs `[Live] features=…` in the main-process log; the label changes at once | FR-017, FR-018, E4 |
| 2 | Set "Answer only"; quit and restart the app; open Settings | The button still reads "Answer only" | FR-002, E8 |
| 3 | "Answer only"; start Listen; play five or more turns with two questions | Window titled "Live answer"; before the first question "Waiting for a question..."; both questions stream answers; log shows no `Triggering analysis` and no analysis request; no Summary pane; "Show Transcript" and back works, the button reads "Show Answer" | FR-007, FR-008, FR-012, FR-013, FR-015, SC-001 |
| 4 | "Insights only"; start Listen; play the same audio | No `[live-answer]` lines, no answer pane; at turn 5 and turn 10 the Summary fills (`Triggering analysis`); title "Live insights" | FR-007, FR-008, SC-002 |
| 5 | "Answer only"; play a long question; while the answer streams, press the button to "Insights only" in Settings | The stream stops, the pane hides, `[Live] features=insights`, no more answer text. Switch back to "Answer only": the cut answer is still there as far as it got, with no leftover "Trying …" line, and the next question answers | FR-006, D5, SC-004 |
| 6 | "Insights only"; after turn 7 switch to "Answer + Insights" | Live Answer answers the next question; the next summary comes at turn 10, not at once | FR-008, E24 |
| 7 | After a session with Insights off, open the web Activity page (or read the `summaries` table with a read-only query) for that session | No summary block for it (the page shows the summary only when one exists, `page.tsx:129`), and the transcript is there | D10, E25 |
| 8 | "Answer only", press the copy button after two answers | Clipboard holds the two answers, newest first, each with its question. Hover shows "Copy Glass Answer". With "Answer + Insights" it copies the summary as before | FR-014, E32 |
| 9 | Use Ask (with and without a screenshot) in each mode | Works as today | FR-019, E41 |
| 10 | "Answer + Insights" with a normal session | Same panes, labels, calls and log lines as before this change | G3, SC-003 |
| 11 | Count the provider request lines of one 10-minute session per mode (same audio) | "Answer only" ≈ no `once` request; "Insights only" ≈ no stream request. Record the counts in `research.md` R10 | SC-006, R10 V1 |

After the checks, set the mode you want to keep.

## 5. Rollback

Press the button until it reads "Answer + Insights": every lane runs as before. To remove the feature, revert the branch; the stored `liveFeatures` key is then ignored and stays in the settings file harmlessly.

# Edge Cases: Live Features Toggle

**Spec**: `2026-10-12-live-features-toggle`

| # | Situation | Expected behavior | Covered by |
|---|-----------|-------------------|-----------|
| E1 | No `liveFeatures` key stored (fresh install, upgrade) | `getSettings` merges the default: `'both'`. Behavior as today | FR-002, G3 |
| E2 | Stored value is `null`, `42`, `''` or `'ANSWER'` | `normalizeLiveFeatures` → `'both'` | FR-001 |
| E3 | `nextLiveFeatures` of an invalid value | Treated as `'both'` → `'answer'` | FR-001 |
| E4 | Full cycle from `'both'` | `answer` → `insights` → `both` | FR-001, FR-017 |
| E5 | `settings:setLiveFeatures('everything')` | `{ success: false, error }`; nothing saved, nothing pushed, service mode unchanged | FR-003 |
| E6 | `settings:setLiveFeatures` with the current value | Saved again, service re-set, state pushed; no behavior change | FR-003, FR-005 |
| E7 | The listen window does not exist when the mode changes | No push; `ListenView` reads the saved value when it connects | FR-003, FR-011 |
| E8 | The app restarts with `'answer'` saved | `initializeNewSession` loads it before the first turn; the Settings button reads "Answer only" | FR-010, FR-017 |
| E9 | `settingsService.getSettings()` throws at session start | Mode stays `'both'`; the error message is logged, nothing else | FR-010 |
| E10 | A turn arrives before `setLiveFeatures` was ever called | `'both'` (constructor default) | FR-005 |
| E11 | `'answer'`, a `them` question | Streams an answer exactly as today; no analysis call at any turn count | FR-007, FR-008, SC-001 |
| E12 | `'answer'`, turn 5, 10, 15 | `triggerAnalysisIfNeeded` returns first; no `chat()`, no `summary-update`, no summary save | FR-008 |
| E13 | `'insights'`, a `them` question | No company detection, no gate trace, no career prefetch, no timer, no stream call, no `live-answer-update` | FR-007, SC-002 |
| E14 | `'insights'`, turn 5 and 10 | Analysis runs as today | FR-008, SC-002 |
| E15 | `'both'` | Every call, message and payload as today; `liveAnswer.test.js` and `liveAnswerCareer.test.js` unedited and green | FR-019, SC-003 |
| E16 | Turns arrive in every mode | `conversationHistory` grows by one per turn; the transcript is saved and shown | FR-009, C5 |
| E17 | Answer turned off while a debounce timer is pending | Timer cleared; no answer starts | FR-006, SC-004 |
| E18 | Answer turned off while an answer streams | Controller aborted; no further answer text and no error; only `{ status: 'idle' }` when a "Trying …" line was shown (`makeLiveAnswer`'s `finally`); `inFlight` false | FR-006, SC-004 |
| E19 | Answer turned off while the career lookup is awaited | `signal.aborted` is true after the await; the answer never starts | FR-006 |
| E20 | Answer off → on | The next `them` question answers; a question asked while off is not answered later | FR-007 |
| E21 | Answer off → on keeps `lastAnsweredTail` | The same normalized question is still de-duplicated | FR-006 |
| E22 | Answer off, then the interviewer names their company | Not detected while off (detection sits behind the gate) | FR-007, D11 |
| E23 | Insights turned off while an analysis awaits its LLM call | It finishes, saves its row and sends its result to the hidden pane | D5 |
| E24 | Insights off at turn 7, on at turn 8 | The next analysis is at turn 10 | FR-008 |
| E25 | Insights off for a whole session | No `summaries` row for it; `getCurrentAnalysisData().history` is empty | D10 |
| E26 | A new Listen session after a mode change | `resetConversationHistory` runs as today and clears both lanes' state; the mode stays | FR-016 |
| E27 | `'answer'`, no question yet | The insights view shows "Waiting for a question..." and the window keeps a readable height | FR-015, FR-012 |
| E28 | `'answer'`, answers present | The empty state is not shown; answers render as today | FR-015 |
| E29 | `'both'` with no answers | `showEmptyState` is false; `LiveAnswerView` renders nothing; "No insights yet..." from the Summary pane | FR-015, G3 |
| E30 | `'insights'` | `live-answer-view` hidden; `summary-view` as today | FR-012 |
| E31 | Mode changes while the transcript view is showing | The state is stored; the toggle button text follows `viewLabels(mode).showButton`; the insights view shows the new layout when opened | FR-011, FR-013 |
| E32 | Copy in `'answer'` with answers | Clipboard holds `Q2\nA2\n\nQ1\nA1` (newest first) | FR-014 |
| E33 | Copy in `'answer'` with none | Empty string, as the summary copy does when empty | FR-014 |
| E34 | Copy in `'both'` and `'insights'` | The summary text, as today | FR-014 |
| E35 | A pane is hidden, then shown again | Its answers or summary are still there | FR-016, D6 |
| E36 | Window height with one pane hidden | The hidden pane adds 0; the mode change triggers a re-measure | FR-011 |
| E37 | Settings opens while a session runs | The button reads the saved mode; a press applies from the next turn | FR-017, D5 |
| E38 | The save returns `success: false` | The button keeps the previous label; the error goes to the console | FR-017 |
| E39 | Two quick presses | The button is disabled while the call runs, so the second press waits | FR-017 |
| E40 | Signed-in user changes (Firebase login/logout) | The value is read from the new user's key (`users.<uid>`); a user who never set it gets `'both'`. The service takes it at the next session start, `ListenView` re-reads it on `session-state-changed` `isActive: true`, Settings on its user-state refresh | FR-002, FR-010, FR-011, FR-017 |
| E41 | Ask in any mode | Ask works as today | FR-019 |
| E42 | The suggested actions in the Summary pane | Present only when Insights is on, since the pane is | D3 |
| E43 | `SummaryView` receives `summary-update` while hidden (an analysis finishing after Insights was turned off) | The view stores it like any update; the pane stays hidden and shows it when Insights is turned back on | FR-016, D5, D6 |
| E44 | An answer finishing after Answer was turned off | The abort stops the stream; no answer text, no `unverified` payload and no error after `pauseLiveAnswer` | FR-006 |
| E45 | An answer cut by the switch, then Answer turned back on | The partial text stays in the history as far as it got, unmarked, as a replaced answer does today; no "Trying …" line is left over | FR-006, FR-016 |
| E46 | "Insights only" and career notes configured | `careerContext.warm()` still runs at session start (local, no LLM call), so Answer turned on mid-call finds the notes ready | D3, research R6 |

---
# Context Optimization Metadata
# Purpose: Enable efficient partial reads (~200 tokens vs ~2500 for full file)
meta:
  spec_id: 2026-10-12-live-features-toggle
  spec_name: live-features-toggle
  status: draft    # draft | in-progress | approved | completed
  phase: plan          # specify | clarify | plan | tasks | preflight | feature-start | implement | verify
  created: 2026-10-12
  updated: 2026-10-12

# Quick Reference (for checkpoint resume)
summary:
  goals:
    - {id: G1, description: "The user picks which Listen assistants run: Live Answer only, Live Insights only, or both. The choice is saved and survives a restart", priority: HIGH}
    - {id: G2, description: "A lane that is off makes no LLM call and sends no event, so it spends no tokens and no quota. Live Answer only skips about a quarter of a typical interview's tokens; Live Insights only skips about three quarters (research R2)", priority: HIGH}
    - {id: G3, description: "With 'both' (the default), Glass behaves exactly as today: same calls, same prompts, same payloads, same screen", priority: HIGH}
  constraints:
    - {id: C1, description: "The providers, the factory, providerChain.js, the cooldown registry, STT, the transcript store, Ask and the SSE protocol are not edited. Only the two lane entry points in summaryService.js gain a gate; makeLiveAnswer and makeOutlineAndRequests are not edited", type: SCOPE}
    - {id: C2, description: "No database change and no migration. The choice is a key of the per-user settings store that settingsService already keeps (electron-store). No new dependency", type: TECHNICAL}
    - {id: C3, description: "Never log prompt, answer, reasoning or transcript text (existing invariant). The only new log line carries the mode name", type: SECURITY}
    - {id: C4, description: "Live Answer stays rendered only in the content-protected listen window (existing invariant, docs/LIVE_INSIGHTS_AND_ASK.md §4.4). Nothing new is shown in another window", type: SECURITY}
    - {id: C5, description: "The transcript keeps being captured, shown and saved in every mode. The conversation history keeps growing in every mode, because both lanes and a later switch read it", type: TECHNICAL}
    - {id: C6, description: "Tests run under npm test (node:test, plain Node). No live API call in the suite. Electron-only files (settingsService, featureBridge, listenService, the Lit views) are checked by node --check, npm run build:renderer and the manual checks", type: TECHNICAL}
  decisions:
    - {id: D1, decision: "One setting, `liveFeatures`, with three values: 'both' (default), 'answer', 'insights'. Stored with the other per-user settings through settingsService.saveSettings (electron-store, key users.<uid>). Any other stored value reads as 'both'", rationale: "The store already holds per-user options (askMode, preferredCodeLanguage, contentProtection) and needs no schema. A users-table column like auto_update_enabled would need schema.js, the SQLite repository and the Firebase repository (research R3)"}
    - {id: D2, decision: "A pure module, src/features/listen/liveFeatures.js, owns the rule: the three values, normalize, answerEnabled, insightsEnabled, nextLiveFeatures (the cycle both → answer → insights → both), liveFeaturesState and the view labels. The main process and the renderer both import it (esbuild bundles it for the renderer)", rationale: "One definition of 'which lanes run' and of the three label sets, tested under node:test. The renderer holds no copy of the rule (research R8)"}
    - {id: D3, decision: "'Off' means the lane does no work and its pane is hidden. Answer off: no trigger gate, no debounce, no career prefetch, no LLM call, no live-answer-update. Insights off: no analysis, no LLM call, no summary-update, no summary saved. The transcript and the conversation history are untouched", rationale: "The point is cost and quota (G2). Hiding a pane while the lane still ran would save nothing (research R2, R5)"}
    - {id: D4, decision: "The gate sits at the entry of the two lane triggers: SummaryService.triggerAnswerIfNeeded and triggerAnalysisIfNeeded return first when their lane is off. makeLiveAnswer and makeOutlineAndRequests are not edited", rationale: "Both triggers are called from addConversationTurn on every turn; one early return each is the smallest change and leaves every prompt byte for byte as today (G3, research R4)"}
    - {id: D5, decision: "A change takes effect from the next turn, with no restart and no new session. Turning Answer off clears the pending debounce timer and aborts an answer that is streaming. Turning Insights off lets an analysis already in flight finish (nothing can cancel it today and its tokens are spent); its result is saved and sent, and the pane stays hidden", rationale: "The user may change it from Settings in the middle of a call. An abort follows the abort-and-replace path the lane already has (research R5)"}
    - {id: D6, decision: "Switching a lane off does not clear what its view holds. The answers and the summary stay in memory and show again when the lane is turned back on. A new Listen session still clears both, as today", rationale: "A mis-click in the middle of an interview must not destroy the answer history (research R5)"}
    - {id: D7, decision: "The mode reaches the lanes through SummaryService.setLiveFeatures(mode). listenService loads the saved mode when a session starts and again on every change; the new IPC handler also pushes the state to the listen window. A failed read falls back to 'both'", rationale: "SummaryService stays free of Electron and settings imports, so its gate is unit-testable with a stub LLM, the way liveAnswerCareer.test.js works (research R4)"}
    - {id: D8, decision: "The control is one cycling button in Settings, below Automatic Updates: 'Live panels: Answer + Insights' → 'Answer only' → 'Insights only'. A one-line help sits under it. No control in the Listen window in this spec", rationale: "Same pattern as 'Automatic Updates: On/Off', no new CSS. A Listen-bar toggle is deferred (research R7)"}
    - {id: D9, decision: "The Listen window adapts to the mode. Titles and buttons: both and insights-only read as today; answer-only reads 'Live answer' / 'Show Answer' / 'Copy Glass Answer'. In answer-only mode an empty Live Answer pane shows 'Waiting for a question...' so the window does not collapse to the top bar. Copy in answer-only mode copies the answers on screen, newest first", rationale: "In 'both' the empty state comes from the Summary pane ('No insights yet...'); with that pane off nothing would be left (research R6)"}
    - {id: D10, decision: "A session recorded with Insights off has no summary row. This is accepted and said in the Settings help line", rationale: "The same holds today for a session shorter than 5 turns, and the web Activity details page already shows no summary block when there is none (pickleglass_web/app/activity/details/page.tsx:129). The summary is what the lane produces; without the lane there is none (research R6)"}
    - {id: D11, decision: "While Answer is off, the interviewer's company is not detected from the conversation (the detection sits in the same trigger, before the gate) and the career follow-up memory is kept as it was", rationale: "Detection feeds only the answer lane's career context. It resumes with the next 'them' turn once Answer is on (research R6)"}
    - {id: D12, decision: "Default 'both' changes nothing observable: the same calls, prompts, payloads and log lines. The new log line is printed only when the mode is set", rationale: "G3. The existing liveAnswer*.test.js files run unedited as the proof"}

# CRITICAL REQUIREMENTS - Must verify during implementation
# These survive context compaction and generate T-VERIFY tasks
critical_requirements:
  type: feature-minor    # bugfix | feature-minor | feature-major | config | documentation | refactoring
  portal: app            # superadmin | admin | app | public | none
  ui_changes: minor      # none | minor | moderate | major
---

# Feature Specification: Live Features Toggle

**Feature Branch**: `2026-10-12-live-features-toggle`
**Created**: 2026-10-12
**Status**: Draft
**Input**: User request (2026-10-12): "Following the same pattern as the last 4 features, let's make a plan for this improvement you suggested: create a spec to enable only live answers, only live insights, or both." (translated from Portuguese)

---

## System Context

**Systems**: Framework-internal. The Glass Electron main process (`summaryService`, `listenService`, `settingsService`, `featureBridge`, `preload`) and three renderer views: the Listen window (`ListenView`, `LiveAnswerView`, `SummaryView`) and Settings (`SettingsView`).
**Databases**: None changed. The choice is a key in the per-user settings store (`electron-store`, `users.<uid>`), next to `askMode`.
**Integrations**: None new.
**Key Architecture**: Listen runs two independent assistants over the same conversation history (`docs/LIVE_INSIGHTS_AND_ASK.md` §1).
- **Live Answer** (the answer lane): `triggerAnswerIfNeeded` (`summaryService.js:559`) runs on each `them` turn that looks like a question, after an 800 ms debounce. It streams an answer (`makeLiveAnswer`, `:337`) as `live-answer-update`. The view is `LiveAnswerView`.
- **Live Insights** (the analysis lane): `triggerAnalysisIfNeeded` (`:980`) runs on every fifth turn. It makes one non-streaming call (`makeOutlineAndRequests`, `:744`), saves a summary row and sends `summary-update`. The view is `SummaryView`.
- `addConversationTurn` (`:682`) appends the turn and calls both triggers. `ListenView` (`:665-743`) stacks the two panes inside one `.insights-pane`.

Today both lanes always run. A user on a small quota (Groq Free: 8K tokens a minute, 200K a day per model) pays for both, whether or not they look at both (research R2).

---

## Clarifications

### Session 2026-10-12

- Q: Same structure as the last four features? → A: Yes. The same spec set and order: pure pieces with tests first, then the lane gates, then the wiring, the views, the docs and the live checks. There is no SDK, provider or contract-with-a-service step.
- Q: What are "live answers" and "live insights"? → A: Live Answer is the streamed answer to the interviewer's question (`LiveAnswerView`, the "Live Answer" eyebrow). Live Insights is the summary, topic, actions and follow-ups panel (`SummaryView`, "No insights yet..."). The Listen window's own title calls the whole pane "Live insights"; this spec calls the two lanes by the names in `docs/LIVE_INSIGHTS_AND_ASK.md` §1.
- Q: Does "off" hide the pane or stop the lane? → A: Stop the lane and hide the pane (D3). Stopping is the point.
- Q: Where is the choice kept? → A: In the settings store (D1). No database change.
- Q: Where does the user change it? → A: In Settings, one cycling button (D8).
- Q: Does a change need a restart or a new session? → A: No. It applies from the next turn (D5).
- Q: Is the transcript affected? → A: No (C5).
- Q (user review): Only a Settings button, no toggle in the Listen bar? → A: Yes (D8).
- Q (user review): A session with Insights off saves no summary. Acceptable? → A: Yes (D10).
- Q (user review): New labels in answer-only mode, or today's ("Live insights", "Show Insights", "Copy Glass Analysis", which copies only the summary)? → A: The new labels (D9). The other two modes keep today's.

**Deferred (default chosen, not blocking)**:
- A quick toggle in the Listen window's top bar, for a change in the middle of a call without opening Settings. Default: Settings only. Recorded in `docs/future-work.md`.
- Running Live Insights less often (every 10 turns instead of 5) as a middle setting. Default: not offered.
- A per-lane model list (for instance, Insights on a cheaper model). Default: both lanes use the model list as today.

---

## User Scenarios & Testing *(mandatory)*

### Primary User Story
The user is on Groq's Free plan and watches only the Live Answer during an interview. In Settings, they press "Live panels: Answer + Insights" once and read "Live panels: Answer only". The next interview shows a Listen window with a single pane, titled "Live answer", that says "Waiting for a question..." until the interviewer asks one. The summary is never made, so the 20–30 insight calls an hour, about a quarter of the day's tokens, are not spent. The user can press the button again in the middle of the call; the next turn follows the new choice.

### Acceptance Scenarios
1. **Given** a fresh install or a stored value that is missing or invalid, **When** Settings opens, **Then** the button reads "Live panels: Answer + Insights", and Listen behaves as today.
2. **Given** the button reads "Answer + Insights", **When** it is pressed, **Then** it reads "Answer only", the value is saved, and after an app restart it still reads "Answer only". A second press gives "Insights only", a third "Answer + Insights".
3. **Given** "Answer only" and ten finalized turns that include two questions from `them`, **When** Listen runs, **Then** both questions stream answers as today, no analysis call is made, no summary row is saved, no `summary-update` is sent, and the window shows no Summary pane.
4. **Given** "Insights only" and the same ten turns, **When** Listen runs, **Then** no answer is requested, no `live-answer-update` is sent, no career lookup or company detection runs, the analysis runs at turns 5 and 10 as today, and the window shows no Live Answer pane.
5. **Given** "Answer only" and an answer that is streaming, **When** the user switches to "Insights only", **Then** the stream aborts within the turn, no further answer text or error is sent (only the existing `status: 'idle'` that clears a "Trying …" line may follow), and the pane hides.
6. **Given** "Insights only" at turn 7, **When** the user switches to "Answer + Insights", **Then** the next analysis runs at turn 10, not at once.
7. **Given** "Answer only" and no question asked yet, **When** the Listen window shows the insights view, **Then** it shows "Waiting for a question..." and keeps a readable height.
8. **Given** "Answer only", **When** the user presses the copy button, **Then** the clipboard holds the answers on screen, newest first, each with its question; with "Answer + Insights" or "Insights only" it holds the summary text as today.
9. **Given** any mode, **When** the user asks in Ask, **Then** Ask works as today.

### Edge Cases
- A lane turned off and on again keeps its history in the view (D6).
- The setting changes while the Listen window is closed: the view reads the saved value when it opens.
- An analysis in flight when Insights is turned off finishes, is saved and is sent to a hidden pane (D5).
- A debounce timer is pending when Answer is turned off: it is cleared and no answer starts.
- An answer cut by the switch stays in the history as far as it got, as a replaced answer does today.
- A stored value of the wrong type (`null`, `42`, `'ANSWER'`) reads as 'both'.

See `contracts/EDGE_CASES.md` for the full list.

## Requirements *(mandatory)*

### Functional Requirements

**The rule (pure)**
- **FR-001**: `liveFeatures.js` MUST export:
  - `LIVE_FEATURES = ['both', 'answer', 'insights']` and `DEFAULT_LIVE_FEATURES = 'both'`;
  - `normalizeLiveFeatures(value)`: the value when it is one of the three, else `'both'`;
  - `answerEnabled(mode)` and `insightsEnabled(mode)`: whether that lane runs (`mode` normalized first);
  - `nextLiveFeatures(mode)`: the cycle both → answer → insights → both;
  - `liveFeaturesState(mode)`: `{ mode, answer, insights }` with `mode` normalized;
  - `liveFeaturesLabel(mode)`: 'Answer + Insights', 'Answer only' or 'Insights only';
  - `viewLabels(mode)`: `{ title, showButton, copyHover }` for the Listen window (FR-013).

**Storage and IPC**
- **FR-002**: `settingsService.getDefaultSettings()` MUST include `liveFeatures: 'both'`. The value is saved through `saveSettings` and read through `getSettings`, as `askMode` is. No table, column or repository changes.
- **FR-003**: `featureBridge` MUST add:
  - `settings:getLiveFeatures`: returns `liveFeaturesState(saved value)`;
  - `settings:setLiveFeatures(mode)`: a `mode` outside `LIVE_FEATURES` returns `{ success: false, error }` and changes nothing; a valid one saves it, calls `listenService.setLiveFeatures(mode)`, sends `listen:liveFeaturesChanged` with the state to the listen window when it exists, and returns `{ success: true, ...state }`.
- **FR-004**: `preload.js` MUST expose, on `listenView`: `getLiveFeatures`, `onLiveFeaturesChanged`, `removeOnLiveFeaturesChanged`; and on `settingsView`: `getLiveFeatures`, `setLiveFeatures`.

**Lanes**
- **FR-005**: `SummaryService` MUST hold a mode, `'both'` after construction. `setLiveFeatures(mode)` MUST store `normalizeLiveFeatures(mode)` and log `[Live] features=<mode>`. When the stored mode changes from one that runs Answer to one that does not, it MUST also call `pauseLiveAnswer()`.
- **FR-006**: `pauseLiveAnswer()` MUST clear the debounce timer and abort the in-flight stream, and set `inFlight = false`. It MUST keep `lastAnsweredTail`, `careerPrev` and `activeCompany`. `resetLiveAnswer()` is unchanged. After the pause the aborted answer sends no more text and no error; `makeLiveAnswer`'s own `finally` (`:490-495`) may still send `{ status: 'idle' }` to clear a "Trying …" line, as it does today on abort-and-replace.
- **FR-007**: `triggerAnswerIfNeeded(speaker, text)` MUST return first, before company detection, the gate trace, the career prefetch and the timer, when Answer is off. With Answer on it MUST behave exactly as today.
- **FR-008**: `triggerAnalysisIfNeeded()` MUST return first, before the turn-count test, when Insights is off. With Insights on it MUST behave exactly as today.
- **FR-009**: `addConversationTurn` MUST keep appending to `conversationHistory` in every mode and keep calling both triggers.
- **FR-010**: `listenService.setLiveFeatures(mode)` MUST pass the mode to the summary service. `initializeNewSession` MUST read the saved mode from `settingsService.getSettings()` and set it before the first turn; a failed read MUST leave `'both'` and log the error message only.

**Listen window**
- **FR-011**: `ListenView` MUST read the state at connect (`getLiveFeatures`), read it again when a session starts (`session-state-changed` with `isActive: true`, which `listenService` sends after `initializeSession` loaded the saved mode, `listenService.js:67-70`), and update it on `listen:liveFeaturesChanged`. After each change it re-measures the window height. Until the first read returns, the state is `'both'`.
- **FR-012**: In the insights view, `live-answer-view` MUST be visible only when Answer is on, and `summary-view` only when Insights is on. The transcript view is unaffected.
- **FR-013**: The labels MUST come from `viewLabels(mode)`:

  | Mode | `title` (insights view) | `showButton` (transcript view) | `copyHover` |
  |------|-------------------------|--------------------------------|-------------|
  | both | Live insights | Show Insights | Copy Glass Analysis |
  | insights | Live insights | Show Insights | Copy Glass Analysis |
  | answer | Live answer | Show Answer | Copy Glass Answer |

- **FR-014**: The copy button in the insights view MUST copy the summary text when Insights is on, and `LiveAnswerView.getAnswerText()` when only Answer is on. `getAnswerText()` returns `answersToText(answers)`: each answer as its question (when present), a newline and its text, newest first, separated by a blank line; `''` for none.
- **FR-015**: `LiveAnswerView` MUST accept `showEmptyState`. When it is true and the view is visible with no answers and no status, it renders a "Waiting for a question..." line in the style of the Summary pane's empty state. `ListenView` sets it true when Insights is off. With it false the view renders as today.
- **FR-016**: Hiding a pane MUST NOT reset it. `resetAnswer()` and `resetAnalysis()` run only at the start of a new session, as today.

**Settings**
- **FR-017**: `SettingsView` MUST show a button "Live panels: <liveFeaturesLabel>" below "Automatic Updates", with a one-line help under it (FR-018). It loads the state when it opens and on its user-state refresh (where it reloads Automatic Updates), and a press calls `setLiveFeatures(nextLiveFeatures(current))`. The button is disabled while the call runs. On `success: false` or an error the previous value stays and the error goes to the console.
- **FR-018**: The help line MUST read: "Off means no calls for that panel. Insights off: no summary is made or saved. Takes effect on the next turn."

**Unchanged**
- **FR-019**: The providers, the factory, `providerChain.js`, `modelHealth.js`, `modelStateService.js`, the STT code, the transcript and summary repositories, the DB schema, `askService.js`, `askStreamState.js`, the `live-answer-update` and `summary-update` payloads and the existing `liveAnswer*.test.js` files MUST NOT change. In `summaryService.js` only additions are allowed (the mode, `setLiveFeatures`, `pauseLiveAnswer`, two early returns).

### Success Criteria
- **SC-001**: With 'answer', a scripted session of 10 turns (two questions) over a stub LLM gives two streamed answers and zero `chat()` calls, zero `summary-update` sends and zero summary saves (automated).
- **SC-002**: With 'insights', the same session gives zero stream calls, zero `live-answer-update` sends, zero career lookups, and `chat()` calls at turns 5 and 10 (automated).
- **SC-003**: With 'both', the call counts, messages and payloads equal today's; `liveAnswer.test.js` and `liveAnswerCareer.test.js` pass unedited (automated).
- **SC-004**: Turning Answer off while a stream is open aborts it and clears a pending timer. No later `live-answer-update` carries answer text or an error; only the existing `status: 'idle'` may follow (automated).
- **SC-005**: `npm test` passes, `npm run build:renderer` builds, and the contracts type-check.
- **SC-006**: The LLM calls per hour of a real session in each mode are counted from the log and recorded in `research.md` R10. A report, not a gate.

### Key Entities *(include if feature involves data)*
- **`liveFeatures` setting**: `'both' | 'answer' | 'insights'`, in the per-user settings store.
- **Live features state**: `{ mode, answer, insights }`, what the IPC returns and pushes.
- **View labels**: `{ title, showButton, copyHover }`.

See `data-model.md`.

### External Dependencies & Risk Assessment *(mandatory)*

| Dependency | Type | Risk Level | Quota/Limits | Fallback Behavior |
|------------|------|------------|--------------|-------------------|
| None new | n/a | LOW | The feature removes calls; it adds none | Default 'both' = today |

**HIGH-RISK Dependency Checklist**:
- [x] No new external call. Quota-limited APIs are never called by the suite.

### Test Strategy *(mandatory)*

The rule and the labels are table-tested. The lane gates are tested on a real `SummaryService` over a stub LLM (the pattern of `liveAnswerCareer.test.js`): call counts, sends, timers and aborts are observed. The renderer views are not unit-loadable (Lit, DOM); their logic lives in the pure module and in `answersToText`, and the views are checked by build, by rendering the real components on a local page with a stubbed `window.api`, and by the manual checks.

**Test Type Classification**:
| FR | Primary Test Type | Reason |
|----|-------------------|--------|
| FR-001 | Unit (table) | Pure |
| FR-005–FR-009 | Unit (real `SummaryService`, stub LLM) | Counts, sends, timer, abort |
| FR-002–FR-004, FR-010 | `node --check` + grep guards + manual | Electron-only files |
| FR-011–FR-013, FR-015–FR-018 | Build + local render + manual | Lit views |
| FR-014 | Unit (`answersToText` in `liveAnswerHistory.test.js`) + manual | Pure part tested |
| FR-019 | Diff guards | Nothing else changes |
| SC-006 | Manual (live keys) | Real session |

**Distribution Estimate**:
- Feature type: [x] Backend logic with a small UI change
- Unit: ~70% | Integration: 0% | Contract: 0% | E2E/Manual: ~30%

**HIGH-RISK API Warning**:
- [x] None: no API is called by the suite.

**Estimated Test Count**: ~35–45 cases across 1 new pure test file, 1 new lane test file and additions to `liveAnswerHistory.test.js`.

### Error Handling & Recovery *(mandatory if feature can fail)*

**Error Scenarios**:
| Error Scenario | Type | User Message | Recovery Action |
|----------------|------|--------------|-----------------|
| Stored value missing or invalid | Config | None | Reads as 'both' |
| Settings read fails at session start | Config | None (console) | Mode stays 'both' |
| `setLiveFeatures` with an invalid mode | Input | Console error | Refused, nothing changes |
| Save fails | I/O | Console error | Button keeps the previous value |
| Listen window absent when the mode changes | Expected | None | No push; the view reads the saved value when it opens |

**Error/Rescue Registry**:
| Method/Codepath | What Can Go Wrong | Exception Class | Rescued? | Rescue Action | User Sees |
|-----------------|-------------------|-----------------|----------|---------------|-----------|
| `settings:setLiveFeatures` | invalid mode | none (validated) | Y | `{ success: false }` | previous label |
| `settings:setLiveFeatures` | `saveSettings` returns `success: false` | none | Y | return it as is | previous label |
| `initializeNewSession` | `getSettings` throws | any | Y | keep 'both', log message | both panes |
| `ListenView.connectedCallback` | `getLiveFeatures` rejects | any | Y | keep 'both' | both panes |
| `SettingsView` press | IPC rejects | any | Y | keep previous value | previous label |

**Failure Modes Registry**:
| Codepath | Failure Mode | Rescued? | Test? | User Sees? | Logged? |
|----------|-------------|----------|-------|------------|---------|
| lane gate | invalid mode in the service | Y | Y | both lanes | no |
| answer pause | stream abort throws | Y (existing abort path) | Y | nothing | no |
| IPC set | invalid mode | Y | grep + manual | previous label | console |

*No row has Rescued=N.*

**Multi-Phase Operations**: None. The mode is one value; the lanes read it per turn.

### UI/Design Reference *(mandatory)*

**Feature Classification**:
- [x] **Minor UI** (< 3 components, existing patterns only)

**Design Reference**:
- Settings (`src/ui/settings/SettingsView.js`): one `settings-button full-width` below "Automatic Updates" (`:1715`), a help line in the 9 px grey style of "Leave blank to infer from the screenshot." (`:1742-1744`).
- Listen window (`ListenView.js`, `LiveAnswerView.js`): the same two panes; one hidden when its lane is off; labels per FR-013; one empty-state line in the existing `.empty-state` style.
- No new colors, icons or CSS classes beyond the empty-state line in `LiveAnswerView`.

### Permissions & Access Control *(mandatory)*

**Portal Placement**: [x] Application Portal (local Electron app).
**User Roles Affected**: [x] Local desktop user (single actor).
**Data Scoping**: [x] User-scoped. The value is stored under the signed-in user's key (`users.<uid>`, or `users.default`), like `askMode`. Turning a lane off sends less data to the LLM provider, never more.

### Architecture Context *(mandatory if feature has business logic)*

```
src/features/listen/
  liveFeatures.js                              NEW   rule, cycle, state, labels (pure, shared by main and renderer)
  summary/summaryService.js                    EDIT  mode field, setLiveFeatures, pauseLiveAnswer, two early returns
  listenService.js                             EDIT  setLiveFeatures; read the saved mode in initializeNewSession
  __tests__/liveFeatures.test.js               NEW   the rule and the labels
  summary/__tests__/summaryService.liveFeatures.test.js   NEW   lane gates over a stub LLM
src/features/settings/settingsService.js       EDIT  default liveFeatures: 'both'
src/bridge/featureBridge.js                    EDIT  settings:getLiveFeatures, settings:setLiveFeatures
src/preload.js                                 EDIT  listenView and settingsView surface
src/ui/listen/ListenView.js                    EDIT  state, pane visibility, labels, copy, height
src/ui/listen/summary/LiveAnswerView.js        EDIT  showEmptyState, getAnswerText
src/ui/listen/summary/liveAnswerHistory.js     EDIT  answersToText (additive)
src/ui/listen/summary/__tests__/liveAnswerHistory.test.js   EDIT  answersToText cases (additions only)
src/ui/settings/SettingsView.js                EDIT  the button and its help
docs/…                                         EDIT  LIVE_INSIGHTS_AND_ASK, ARCHITECTURE, diagram 09, README, CHANGELOG, future-work (T-DOC-GATE)
```

---

## Out of Scope / Future Work

- **A toggle in the Listen window's top bar** (deferred above).
- **Less frequent Live Insights** (every N turns) and **a per-lane model list**.
- **A third state for the transcript.** The transcript is captured in every mode (C5).
- **Cross-device sync of the choice.** The settings store is local, like `askMode`.
- **Changing what each lane produces.** Prompts, formats and the PASSIVE rule are untouched.

---

## Review Checklist (Gate)

- [x] No [NEEDS CLARIFICATION] markers remain (session 2026-10-12; three items deferred with defaults)
- [x] Requirements are testable
- [x] Test strategy defined (pure tables, real service over a stub LLM, build and local render, manual live checks)
- [x] Portal placement selected
- [x] Permissions defined (single local user)
- [x] Data sensitivity classified (less data sent, never more)
- [x] External APIs identified (none new)
- [x] Error handling defined
- [x] UI complexity classified (Minor)
- [x] Deprecation decision made: nothing deprecated
- [ ] Bug evidence captured: N/A (`feature-minor`)

---

## Next Steps

- D8, D9 and D10 were approved by the user (Clarifications). The user gives the go-ahead to implement.
- Then: branch `2026-10-12-live-features-toggle`, tasks in `tasks.json` order, through T-DOC-GATE; then T-VERIFY-MANUAL and T-FINAL.

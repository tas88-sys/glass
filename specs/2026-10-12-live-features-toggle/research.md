# Phase 0 Research: Live Features Toggle

**Spec**: `2026-10-12-live-features-toggle`
**Date**: 2026-10-12

## Sources

- **The repo** at `76d908e` (PR #15 merged): `summaryService.js`, `listenService.js`, `ListenView.js`, `LiveAnswerView.js`, `SummaryView.js`, `SettingsView.js`, `settingsService.js`, `featureBridge.js`, `preload.js`, `schema.js`.
- **`docs/LIVE_INSIGHTS_AND_ASK.md`** §1 (the two assistants), §3.3 (every 5th turn), §4.1 (the answer trigger).
- **`specs/2026-10-12-groq-provider/research.md` R5**: what each lane costs on Groq's Free plan.
- **Earlier specs of this repo**, for the format and for the settings pattern (`2026-05-25-ask-mode-shortcuts`).

No live model call was made for this plan.

---

## R1: What the two lanes are and what they share

Both live in `SummaryService` and read the same `conversationHistory`.

| | Live Answer | Live Insights |
|---|---|---|
| Entry | `triggerAnswerIfNeeded(speaker, text)` (`summaryService.js:559`) | `triggerAnalysisIfNeeded()` (`:980`) |
| Called from | `addConversationTurn` (`:691`) | `addConversationTurn` (`:689`) |
| Runs when | a `them` turn that looks like a question (`shouldTriggerAnswer`), after an 800 ms debounce (`:595-662`) | `conversationHistory.length >= 5 && % 5 === 0` |
| Work | career lookup (`resolveCareerContext`), then `makeLiveAnswer` (`:337`), a streaming call | `makeOutlineAndRequests` (`:744`), one `llm.chat()` (`:824`) |
| Output | `live-answer-update` payloads | `summary-update` payload, a `summaries` row (`:832`), `previousAnalysisResult` |
| State | `lastAnsweredTail`, `answerDebounceTimer`, `inFlightController`, `careerPrev`, `activeCompany` (`:290-306`) | `previousAnalysisResult`, `analysisHistory` |
| View | `LiveAnswerView` | `SummaryView` |

They share only the history and the model resolution (`modelStateService.getCurrentModelInfo('llm')`). `docs/LIVE_INSIGHTS_AND_ASK.md` §1 already states that deleting either leaves the other unchanged. Neither reads the other's state, so a gate at each entry cannot affect the other lane.

`addConversationTurn` calls both triggers on every turn, from `listenService.handleTranscriptionComplete` (`listenService.js:107`).

---

## R2: What each lane costs

From the Groq spec, R5 (estimates from the code, one hour of interview):

| Scenario | Live Answer | Live Insights | Total | Insights share |
|----------|-------------|---------------|-------|----------------|
| Light | 30 × 2.5K = 75K | 20 × 2K = 40K | ~115K | 35% |
| Typical | 50 × 3.5K = 175K | 25 × 2.5K = 62K | ~240K | 26% |
| Heavy | 60 × 5K = 300K | 30 × 3K = 90K | ~390K | 23% |

So:
- **Answer only** skips about a quarter of the tokens and 20–30 calls an hour. On Groq Free (200K a day per model, 8K a minute) this moves a typical interview from "borderline" toward a comfortable fit, and an Insights call no longer competes with an answer for the same minute.
- **Insights only** skips about three quarters of the tokens and 30–60 calls an hour, and every career lookup.
- Requests per day (1K) are not the constraint on Groq. Tokens are.

The calls that go away are the ones the user does not read. That is the case for stopping the lane rather than hiding its pane (D3).

---

## R3: Where to store the choice

| Option | For | Against |
|--------|-----|---------|
| `users` table column (like `auto_update_enabled`) | Same place as Automatic Updates | A column in `schema.js`, the SQLite repository and the Firebase repository, the repository switch on login, and a migration. Three files for one string |
| `provider_settings` row | Already read by the model state | It is per provider and about keys and model lists. The wrong place |
| **`settingsService` store (`electron-store`, `users.<uid>`)** | Already holds per-user options (`askMode`, `preferredCodeLanguage`, `contentProtection`, …). `getSettings` merges defaults, so a missing key reads as the default. `saveSettings` merges one key. No schema, no migration, no Firebase repository | Local to the machine, like `askMode` |
| An env var | No UI | Not a choice the user can change in the app |

**Decision (D1)**: the settings store. The key is `liveFeatures`.

`settingsService.saveSettings` also calls `windowNotificationManager.notifyRelevantWindows('settings-updated')`, but only to the `settings` and `main` windows (`settingsService.js:20`). The listen window is not among them, so the new handler pushes its own event, the way `mainHeader:setAskMode` pushes to the header (`featureBridge.js:91-99`).

---

## R4: How the mode reaches the lanes

The lanes are in `SummaryService`, which has no settings or Electron imports apart from lazy ones (`sendToRenderer`). Options:

| Option | Against |
|--------|---------|
| `SummaryService` calls `settingsService.getSettings()` in each trigger | The triggers are synchronous and run on every turn; an async read changes the debounce flow, and `settingsService` pulls in `windowManager`. Not unit-testable |
| A settings-change event the service subscribes to | A new event bus for one value |
| **A plain field set from outside** | `setLiveFeatures(mode)` is trivial to test with a stub; `listenService` already owns the summary service and its session start |

**Decision (D7)**: `SummaryService.liveFeatures` (default 'both'), set by `listenService.setLiveFeatures` from the IPC handler, and loaded in `initializeNewSession` (`listenService.js:130`, before `resetConversationHistory`). The settings require is lazy there, as `windowManager` is elsewhere in the file, to avoid a load cycle.

The gate is an early return at the top of each trigger (D4). `makeLiveAnswer` and `makeOutlineAndRequests` stay byte for byte as they are, which is what keeps 'both' identical (G3).

---

## R5: What "off" does, and a change in the middle of a call

**Answer off.** `triggerAnswerIfNeeded` returns before everything: the company detection (`:563-573`), the gate trace, the career prefetch (`:582`), the debounce timer. A turn already waiting in the debounce, or an answer already streaming, is stopped by `pauseLiveAnswer()`:
- the timer is cleared;
- the `inFlightController` is aborted. `triggerAnswerIfNeeded`'s catch path already swallows an abort (`:639-642`), and `resolveCareerContext` is followed by `if (signal.aborted) return;` (`:632`), so an answer stopped before its first token is silent;
- `inFlight` becomes false.

What the renderer still receives after an abort (`makeLiveAnswer`, `:390-523`):
- the abort listener cancels the reader (`:394`), the read loop ends, and no more text is sent;
- `finally` sends `{ id, status: 'idle' }` when a "Trying …" status was shown for this answer (`:490-495`). That is wanted: it clears the status line, so a stale "Trying gemini-…" does not reappear when Answer is turned back on;
- no error is sent, because an empty answer reports an error only when the signal is not aborted (`:511-521`), and the caller's catch returns on abort (`:639-642`);
- the partial text already shown stays in the history as far as it got. Abort-and-replace leaves a replaced answer the same way today.

`pauseLiveAnswer` is not `resetLiveAnswer` (`:703`): that one also clears `lastAnsweredTail`, `careerPrev` and `activeCompany`, which would make the lane forget the interviewer's company for the rest of the session.

**Answer turned back on.** The next `them` question starts an answer as usual. A question asked while it was off is not answered later.

**Insights off.** `triggerAnalysisIfNeeded` returns before the turn-count test. The history still grows, so after the lane is turned back on the next multiple of 5 runs the analysis over the last 30 turns, with the previous analysis as context if there was one. An analysis already awaiting its LLM call cannot be cancelled (`makeOutlineAndRequests` has no signal); it finishes, saves its row and sends its result to a hidden pane. Cancelling it would need an edit inside the function and would save little.

**Views.** A hidden pane keeps its data (D6). `SummaryView` already renders a `display: none` div when `isVisible` is false, and `LiveAnswerView` renders nothing; neither clears its state.

---

## R6: What else changes when a lane is off

- **Summary row.** `summaries` has one row per session, written by `makeOutlineAndRequests` (`:832`). With Insights off there is none, and `getCurrentAnalysisData()` returns an empty history. The same is true today for a session shorter than 5 turns, so a session without a summary already exists. The web Activity details page reads it through `getSummaryBySessionId`, which returns `null` when there is no row (`summary/repositories/sqlite.repository.js:31-35`, `index.js:346-351`), and renders the summary block only when it exists (`pickleglass_web/app/activity/details/page.tsx:129`). Quickstart §4 check 7 confirms it in the app. The Settings help says it (D10).
- **Career warm-up.** `initializeSession` calls `careerContext.warm()` before it reads the mode (`listenService.js:167`). It reloads the notes and builds the embeddings in the background, on the local machine, with no LLM call and no tokens. It stays in every mode, so Answer can be turned on in the middle of a call and find the notes ready. It is a no-op when `CAREER_KB_PATH` is not set.
- **Clickable insights.** The suggested actions and follow-ups in `SummaryView` forward into Ask (`ask:sendQuestionFromSummary`). With Insights off they do not exist. Ask itself is unchanged and does not read the transcript.
- **Company detection** sits at the top of `triggerAnswerIfNeeded`, before the gate. It feeds only the answer lane's career block, so it is skipped with the lane (D11). `activeCompany` is the first company named in a `them` turn, so a company named while Answer is off is simply not seen; the next named one is.
- **Empty pane.** In 'both' an empty session shows "No insights yet..." from the Summary pane. `LiveAnswerView` renders nothing when it has no answers and no status (`:414`), so in answer-only mode the insights pane would have no height and `adjustWindowHeight` (`ListenView.js:540`) would shrink the window to the top bar. FR-015 adds the one-line empty state, shown only when Insights is off.
- **Window height.** `adjustWindowHeight` adds `liveAnswerView.scrollHeight` and `summaryView.getContentHeight()`. A hidden `SummaryView` has no `.insights-container`, so `getContentHeight()` returns 0; a hidden `LiveAnswerView` renders nothing. The sum needs no change. The mode change itself must trigger a re-measure (FR-011).
- **Copy.** `handleCopy` copies `summaryView.getSummaryText()` (`:606-615`). With only Answer on that is an empty string, so the button would silently copy nothing. FR-014 copies the answers instead.
- **Session reset.** `ListenView` resets both views when a session starts (`:487-495`). Unchanged.
- **A signed-in user changes.** The settings key is per user (`users.<uid>`). The service picks up the new user's mode at the next session start, and `ListenView` reads it again on `session-state-changed` `isActive: true`. `listenService` sends that event after `initializeSession`, so the mode is already loaded (`listenService.js:67-70`). Settings reads it on its user-state refresh, where it already reloads Automatic Updates.

---

## R7: The control

Existing patterns in `SettingsView`:
- A toggle button: "Automatic Updates: On/Off" (`:1715`), a `settings-button full-width` that flips a boolean over IPC with a loading flag (`:548-579`).
- A field with a grey help line: the preferred coding language (`:1733-1746`).

The value has three states, so a cycling button is the closest fit: one press moves to the next label, the label names the current state, and no new CSS is needed (D8). A three-way segmented control would be clearer at a glance but needs new styles in a 240 px wide window; if the cycle proves confusing it can be replaced without touching anything but `SettingsView`.

A toggle in the Listen window's top bar is the better control in the middle of a call. It is deferred (spec Clarifications) because the top bar is narrow and holds the timer, the view toggle and the copy button, and because the whole feature works without it.

---

## R8: One module for the main process and the renderer

`liveFeatures.js` is plain CommonJS with no imports. The renderer is bundled by esbuild from three entry points (`build.js:16-20`), and `LiveAnswerView.js` already imports a CommonJS module that way (`liveAnswerHistory.js`, `module.exports = { … }`). So `ListenView.js` and `SettingsView.js` can import `liveFeatures.js` directly, and the main process `require`s it.

This keeps one definition of the cycle and of the three label sets. A copy in each place was the pattern of `SettingsView.getProviderForModel`, which exists because the renderer could not `require` the factory; here nothing prevents sharing. If the bundler rejects the import path (`src/ui/…` importing from `src/features/…`), T016 falls back to a renderer-side copy guarded by a test that compares the two tables.

The IPC returns the full state `{ mode, answer, insights }`, so the renderer never has to re-derive which lane runs.

---

## R9: What stays as is

- Every provider, the factory, the chain and the cooldown registry: the feature only removes calls.
- STT, the transcript table, `sttService`, `saveConversationTurn`.
- Ask and its service. `ask:sendQuestionFromSummary` still gates on `askMode`.
- The payloads of `live-answer-update` and `summary-update`.
- `resetLiveAnswer`, `resetConversationHistory`, `makeLiveAnswer`, `makeOutlineAndRequests`, `shouldTriggerAnswer`.

---

## R10: To verify live (T-VERIFY-MANUAL)

| # | What | How |
|---|------|-----|
| V1 | Calls per hour in each mode (SC-006) | Run a short Listen session in each mode with the same audio and count the provider request lines (`[Groq Provider]`, `[Gemini Provider]`, `[Anthropic Provider]`, `[LLM Chain]`) per lane. Expect Insights-only ≈ 0 answer streams; Answer-only ≈ 0 `once` calls |
| V2 | A mid-call switch | Quickstart §4 checks 5 and 6 |
| V3 | The answer-only window | Height with no answer yet and with a long answer; the copy button |

### Results

*Not run yet. Recorded in T-VERIFY-MANUAL.*

---

## Summary of Decisions

| # | Topic | Decision |
|---|-------|----------|
| R1 | The lanes | Two independent triggers in `SummaryService`, sharing only the history |
| R2 | Cost | Insights is ~26% of a typical hour's tokens; Answer ~74%. Stop the lane, do not just hide it |
| R3 | Storage | `settingsService` store, key `liveFeatures`; no schema |
| R4 | Delivery | A field on `SummaryService` set by `listenService`; early return at each trigger; the two work functions untouched |
| R5 | Off | Answer: pause (timer, in-flight), keep tail/career state. Insights: gate only; an analysis in flight finishes. Views keep their data |
| R6 | Side effects | No summary row with Insights off (the web details page already handles none); empty-state line, copy and company detection handled; window height needs no change; career warm-up kept in every mode; the view re-reads the mode at each session start |
| R7 | Control | One cycling button in Settings; Listen-bar toggle deferred |
| R8 | Sharing | `liveFeatures.js` imported by main and renderer; IPC returns the state |
| R9 | Unchanged | Providers, factory, chain, STT, Ask, payloads |
| R10 | Live checks | Calls per hour per mode, a mid-call switch, the answer-only window |

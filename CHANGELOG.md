# Changelog

All notable changes to this fork of [pickle-com/glass](https://github.com/pickle-com/glass) are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Fork base: upstream commit `71bc3dc` (*firebase functions node20 migration*, 2025-10-25).

## [Unreleased]

### Interview Live Answer Lane (branch `feat/stt-interview-question-wiring`)

#### Added

- **Streaming Live Answer lane** — `summaryService.js` gains an additive answer lane beside Live Insights. When the interviewer (`them:`) asks a detectable question, an 800 ms debounced streaming LLM call produces a real-time markdown answer above the existing Live Insights panel. The analysis lane is unaffected (FR-017 lane independence).
- **`live-answer-update` IPC channel** — new main→renderer channel in the `summaryView` preload namespace (`src/preload.js`). Two methods: `onLiveAnswerUpdate(cb)` and `removeAllLiveAnswerUpdateListeners()`. The existing `summary-update` channel is untouched.
- **`<live-answer-view>` Lit element** (`src/ui/listen/summary/LiveAnswerView.js`) — renders a newest-first, in-session **history** of streamed sanitized-markdown answers in the insights pane above `<summary-view>`, each labelled with the interviewer question it answered. Subscribes to `live-answer-update`; tears down on disconnect. `resetAnswer()` clears the history on session reset.
- **Pure helper exports** from `summaryService.js` for unit testing without Electron coupling: `isLikelyQuestion`, `normalizePassive`, `parseAnswerOrPassive`, `shouldTriggerAnswer`, `parseLiveAnswerSseLine`, `normalizeTail`.
- **43 `node:test` tests** in `src/features/listen/summary/__tests__/liveAnswer.test.js` — pure-helper unit tests (TDD RED→GREEN), SSE line parser tests, and six integration scenarios: debounce coalescing (AS-4), de-dup same-tail (AS-6), abort-and-replace (AS-5), PASSIVE suppress hold-last (AS-3), mid-debounce/mid-stream session close (AS-8), lane independence (AS-7). LLM provider mocked throughout.
- **`liveAnswerHistory.js` pure reducer** (`src/ui/listen/summary/liveAnswerHistory.js`) — `applyLiveAnswerUpdate(answers, payload, max)` folds a `live-answer-update` into the newest-first history (coalesce-by-`id`, prepend new, cap the tail). Pure / DOM-free, unit-tested by 10 `node:test` cases in `src/ui/listen/summary/__tests__/liveAnswerHistory.test.js`.

#### Changed

- **Live Answer is now a newest-first history, not a single hold-last panel.** Each interviewer question's answer is kept as its own entry (newest on top, labelled with the question it answered) instead of overwriting the previous one. The lane scrolls and is capped at the 20 most recent answers. History is **in-session only** — held in renderer memory and cleared on Stop / new session (not persisted to the DB; cross-session persistence remains future work, see `docs/future-work.md`).
- **`live-answer-update` payload gained `id` + `question`.** `summaryService.makeLiveAnswer` now stamps each answer with a stable monotonic `id` (constant across one answer's stream — including a Gemini `_reset` restart — and new per question) and the triggering `question` text. The renderer keys its history on `id`: same-`id` deltas update one entry in place (streaming); a new `id` prepends a new entry.
- **Insights-mode window height now counts the Live Answer lane** (`ListenView.adjustWindowHeight`) so a growing answer history isn't clipped by the `overflow:hidden` assistant container.

#### Internal

- `summaryService.js` constructor gains answer-lane state fields: `lastAnsweredTail`, `answerDebounceTimer`, `inFlightController`, `inFlight`, `hadFallback`, `lastAnswerTs`.
- `resetLiveAnswer()` folded into `resetConversationHistory()` — no `listenService.js` edit required; existing reset calls at session start/close already suffice.
- `ListenView.js` imports `LiveAnswerView.js` and places `<live-answer-view>` above `<summary-view>` with `resetAnswer()` wired into the session-reset block.

### Interview Live Answer — Readability (branch `feat/live-answer-readability`)

#### Changed

- **Improved Live Answer readability** — the injected user message in `summaryService.makeLiveAnswer` now unconditionally reinforces a headline + markdown bullet list structure: a short one-sentence headline answer is always requested first, followed by supporting points formatted as real `- ` markdown bullet lines when there are multiple points. Single-line answers are not forced into bullets. The PASSIVE directive (`reply EXACTLY: PASSIVE`) is preserved verbatim and unaffected.
- **History Q: label shows only the extracted question span** — a new pure helper `extractQuestion(text)` in `summaryService.js` isolates the interrogative span from filler-laden interviewer turns (e.g. *"Okay so, um, the thing I wanted to ask is — how would you design a rate limiter?"* → *"how would you design a rate limiter?"*). The helper reuses the four existing question-signal regexes (`CLAUSE_LEAD_RE`/`LEAD_STRIP_RE`/`CONTENT_CUE_RE`/`EMBEDDED_Q_RE`) with no divergent heuristic; for multi-question turns it returns the **last** interrogative clause (most-recent question, RD5). Non-string or empty inputs always return `''`; non-empty inputs never return empty (falls back to the full trimmed turn).

#### Internal

- `extractQuestion` is exported from `summaryService.js` alongside the existing pure helpers (FR-009/FR-018). 9 new `node:test` cases in `liveAnswer.test.js`: truth-table T1–T8 (unit) + 1 integration non-regression assertion that the emitted `live-answer-update` `question` field carries the extracted span for a filler-wrapped turn (FR-008).

#### Fixed

- **Question detection is balanced + quota-aware** (live-tested 2026-05-31) — `isLikelyQuestion` triggers on a real question signal (`?` anywhere, an imperative/interview cue, an embedded/indirect question, or a wh-word/auxiliary leading any clause after peeling "okay so…") and skips the interviewer's declarative monologue so a low daily LLM quota isn't spent on non-questions. Catches questions the original `?`-tail/first-word-opener heuristic missed (imperative prompts "Design a cache", conjunction-led "okay so how…", buried/indirect questions) while not firing on every turn. Known by-design gap: cue-less statement-form prompts; PASSIVE remains the backstop for any false trigger.
- **Terse answers no longer dropped** — `makeLiveAnswer` flushes an answer shorter than the ~16-char prefix-buffer threshold when the stream ends, instead of discarding it (e.g. *"42."*, *"Yes, it is."*).
- **Native PASSIVE phrase suppressed mid-stream** — `parseAnswerOrPassive` treats a ≥16-char prefix of the native *"Not sure what you need help…"* phrase as PASSIVE at the buffer decision point (FR-010); previously only the literal `PASSIVE` token / full 42-char phrase suppressed, so the native phrase leaked to the panel.
- **Answers survive the transcript↔insights toggle (previously blanked every time).** `LiveAnswerView` now renders its answers **declaratively from reactive state** (mirroring `SummaryView`'s loader+render path), instead of injecting `innerHTML` into an empty container behind a `changedProperties` guard. The old approach blanked on every toggle: the toggle destroys and recreates the (empty) container, and the guarded re-injection didn't reliably re-run — the answer lived only in the destroyed DOM node, not in state that `render()` reads from.

#### Internal — diagnostics

- Verbose live-answer trace logging gated behind the `LIVE_ANSWER_DEBUG=1` env var (`laDebug()` helper) — silent by default, never logs answer text.

### Documentation

#### Added
- **`docs/AUDIO_AND_STT.md`** — deep reference for the audio + STT subsystem: two-channel `"Me"`/`"Them"` source attribution, per-platform capture matrix (Windows native loopback / macOS `SystemAudioDump` / Linux mic-only), Rust/WASM AEC, the full STT/LLM provider matrix, Deepgram setup + caveats, and STT resilience vs. failover. All claims carry `file:line` references.

#### Fixed
- **README "How It Works" — corrected Windows audio capture.** The audio-sources table claimed system audio was *"macOS only"* and that *"on Windows/Linux only the user's mic is captured."* Windows in fact captures system audio via Electron native loopback (`src/index.js:175-182` + `listenCapture.js:515-566`); only **Linux** is mic-only. Table now lists all three platforms and notes AEC coverage.
- **README "Currently Supporting" list** — added Anthropic Claude (LLM) and Deepgram (STT), which were already wired but undocumented; clarified which providers do LLM vs STT.

### Gemini Failover (branch `feat/gemini-failover`)

#### Added
- **CSV model failover for Gemini LLM** — `selectedLlmModel` now accepts a comma-separated priority list (e.g. `gemini-2.5-flash,gemini-2.5-flash-lite`). On transient errors (HTTP 408/429/500/502/503/504, SDK codes `RESOURCE_EXHAUSTED`/`UNAVAILABLE`/`DEADLINE_EXCEEDED`, network/timeout), the current model is cooled down and the next is tried automatically. (`2296a39`)
- **In-memory cooldown registry** (`geminiModelRotator.js`) — singleton `Map` tracking per-model cooldown expiry. Honors `Retry-After` header and SDK `retryDelay` from `RetryInfo`; default 60s; clamped to `[5s, 300s]`. Exports: `pickModel`, `markFailed`, `markSucceeded`, `classifyError`, `parseRetryAfter`, `parseModelList`, `resetHealth`. (`2296a39`)
- **Per-response footer** in `AskView.js` — muted `answered by: <model>` line below the response body when `responseModel` is set. Shows `(fallback)` suffix when at least one failover occurred during the stream. (`2296a39`)
- **Settings help text** under the Gemini LLM Model ID input explaining comma-separated failover format with example. (`2296a39`)
- **New SSE sentinels** emitted by `createStreamingLLM`: `{_reset, next_model, reason}` (tells consumer to discard accumulated output before the next model streams) and `{_final_model}` (records which model completed the response). (`2296a39`)

#### Changed
- **CSV semantics on `selected_llm_model`** — the existing free-text model ID field now accepts a CSV; persisted as opaque TEXT in SQLite (no schema change). Single-model entries behave identically to before. (`2296a39`)
- **Frontend CSV validator** in `SettingsView.js` — `handleSaveGeminiModels` now splits on `,`, trims each entry, drops empties, and validates every non-empty token starts with `gemini-` (previously validated the whole string, which passed `"gpt-4,gemini-2.5-flash"` by accident). Persists the trimmed-rejoin string, not the raw input. (`2296a39`)
- **`createSTT` first-model-only** — `createSTT` extracts only the first CSV entry via `parseModelList(csv)[0]`; no failover for live STT sessions (locked decision #3). (`2296a39`)
- **`controller.error()` wrapped in `try/catch`** in both the fatal-error and all-models-failed branches of `createStreamingLLM` — defense in depth against `ERR_INVALID_STATE` on consumer cancel. (`2296a39`)

#### Internal
- New test files: `geminiModelRotator.test.js` (27 unit assertions covering all 7 exports) and `gemini.test.js` (9 integration cases covering failover loop + streaming sentinels) and `askService-sse.test.js` (6 cases covering `_reset`/`_final_model` handling). (`2296a39`)
- Added `npm run test` script using `node:test` (Node 18+ built-in; no new dev dependencies required). (`2296a39`)

---

### Ask Mode Shortcuts (branch `feat/ask-mode-shortcuts`)

#### Added
- **Ask mode picker** — a `▾` caret next to the Ask pill in the main header opens a dedicated mode-picker `BrowserWindow` with four modes: **Default**, **Code**, **Debug**, **System Design**. The selected mode persists in `electron-store` and reshapes the system prompt sent to the LLM. The header badge updates live to show the active mode (`Ask`, `Ask · Code`, `Ask · Debug`, `Ask · SysDes`). (`f442024`)
- **Three new prompt profiles** in `promptTemplates.js`: `pickle_glass_code`, `pickle_glass_debug`, `pickle_glass_system_design`. The original `pickle_glass_analysis` (Default) is untouched. (`f442024`)
- **`preferredCodeLanguage` setting** — free-text field in Settings (default `go`) injected into the Code profile via a `{{PREFERRED_LANGUAGE}}` token. Falls back to `__INFER_FROM_SCREENSHOT__` when blank. (`f442024`)
- **6 new IPC handlers** in `featureBridge.js` — `mainHeader:getAskMode`, `mainHeader:setAskMode`, `mainHeader:openModePicker`, `mainHeader:cancelHideModePicker`, `modePicker:closeWindow`, `settings:{get,set}PreferredCodeLanguage`. (`f442024`)
- **`mainHeader:askModeChanged` push event** — targeted broadcast from `featureBridge` to the header window so the badge updates immediately on selection (avoids the dead `settings-updated` broadcast). (`f442024`)

#### Changed
- **System Design prompt — section 5 split** into separate **Data Model** (§5) and **High-Level Architecture** (§6); subsequent sections renumbered through §11. (`216f0db`)
- **System Design prompt — added §0 Opening Pitch + restructured §6 into 3 phases** (post-impl refinement). Added §0 Opening Pitch that streams FIRST (read verbatim at interview minute 1, BEFORE clarifying questions; must contain dominant constraint, scale number with DAU or peak QPS, and two highest-stakes ambiguities). Restructured §6 (High-Level Architecture) into three labelled phases — Baseline / 10× Scale / Multi-region — with ONE ASCII diagram (Phase 1 only — Phases 2 and 3 are bullet deltas, NOT new diagrams, for overlay glanceability). Each phase carries its own ≤25-word say-aloud sentence. Added a consolidated **Trade-off Roll-up table** (`Phase | Decision | Chose | Rejected | Why`, 6-10 rows) as the single source of truth for per-decision alternatives. Captures the "draw + narrate + offer two alternatives in each block" signal that separates senior from staff/principal at this interview stage. (uncommitted)
- **System Design prompt — §8 reframed, §10 stripped** (post-impl refinement). §8 renamed from "Scaling, Bottlenecks & Failure Modes" to "Mechanisms & Failure Handling" — the HOW-it-works layer under §6 Phase 2/3 (sharding mechanism, caching mechanism, hot-key handling, component-failure response with user-visible degradation); removed the redundant "what breaks at 10× load" bullet, which Phase 2 now owns. §10 stripped from three to two transition snippets (Opening Pitch moved to §0), renamed to "Mid-Interview Say-Aloud Snippets". Total section count is now 12 (numbered 0-11), aligned with the actual interview-clock flow top-to-bottom. (uncommitted)
- **System Design prompt — output-rule discipline tightened** (post-impl refinement). Per-decision alternatives MUST live in the §6 Roll-up table only — no prose duplication. §5 storage-tech rows now name rationale only. Added an explicit carve-out preserving §7's per-probe `tradeoff` line as operational cost (what you give up by choosing the mechanism), NOT the rejected alternative. Added a §3↔§0 numeric reconciliation rule that catches the most common live-interview slip — stating one scale number aloud, then computing math under a different one. Intro now names the three-signals combo (phased architecture + spoken narration per phase + per-decision alternatives) as the explicit senior↔staff differentiator. (uncommitted)
- **Main header width** bumped `353 → 393px` at both startup (`windowManager.js`) and state transitions (`HeaderController.js`) so the new badge + caret no longer clip the settings gear. (`525dcb1`)
- **Summary follow-up actions** now reject with a user-visible `alert()` when `askMode !== 'default'`, preventing the regression where Listen-summary clicks silently inherited the active Ask mode. (`f442024`)
- `.gitignore` — exclude `.claude/` and `.specify/` to keep session-local tooling out of the repo. (`99900ec`)

#### Fixed
- **Mode-picker window never created on apikey → main transition** — `createFeatureWindows(header)` (no-arg form) hit the default branch which omitted `mode-picker`, so hovering the caret logged `Window 'mode-picker' not found or destroyed`. Added `mode-picker` to the default registration list. (`7aaea03`)
- **Mode-picker closed immediately on hover** — the picker had no hover bridge, so the 200ms hide debounce fired before the mouse reached it. Added `mouseenter`/`mouseleave` host listeners on `ModePickerView` mirroring `SettingsView.handleMouseEnter`/`handleMouseLeave`, calling `cancelHideModePicker` / `closeWindow` respectively. (`7aaea03`)
- **Gemini stream `ERR_INVALID_STATE` enqueue-after-close** — when `AskService` aborted a prior request mid-stream (user fires a new `Ctrl+Enter` before the previous response finishes), the consumer cancelled the stream but the producer's `for await` loop kept enqueueing into a closed controller, crashing the stream and leaving askService wedged so subsequent Ctrl+Enter presses produced no response. Wrapped enqueue/close in a `safeEnqueue` helper guarded by `controller.desiredSize === null`. (`525dcb1`)

---

### Earlier fork work on `main`

#### Documentation
- **`docs: add How It Works section to README`** — documents the verified runtime behavior of Ask and Listen, including the screenshot capture path, STT pipeline, summary cadence, storage schema, and the known gap where Listen transcripts are not passed into Ask queries. (`9e60646`)

#### Changed
- **`raise maxTokens defaults to each provider's API max`** — stops Ask responses from truncating mid-output. Per-provider defaults: Gemini 65536, OpenAI 32768, Anthropic 8192, Ollama −1 (unlimited). `askService` no longer forces 2048 over the per-provider value. (`591f971`)
- **`allow custom Gemini LLM/STT model IDs via free-text input`** — adds text inputs in the Gemini settings card to set arbitrary model IDs (e.g. `gemini-2.5-pro`), stored through the existing `setSelectedModel` pipeline. Auto-selection no longer clobbers the user's choice when Whisper/Ollama go offline but STT/LLM aren't actually using them. (`bc12688`)

#### Fixed
- **`honor custom Gemini STT model and stop crashing on closed sessions`** — `createSTT` in the Gemini provider was destructuring config but hardcoding `gemini-live-2.5-flash-preview`, silently dropping any user-selected STT model. Wired `modelInfo.model` through `sttService` → `sttOptions` → `createSTT`. Also fixed the `listen:sendSystemAudio` IPC handler crashing with *"Cannot read properties of undefined (reading 'success')"* when the STT session was already closed, by routing the call through the existing `handleSendSystemAudioContent` wrapper. (`4882438`)

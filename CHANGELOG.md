# Changelog

All notable changes to this fork of [pickle-com/glass](https://github.com/pickle-com/glass) are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Fork base: upstream commit `71bc3dc` (*firebase functions node20 migration*, 2025-10-25).

## [Unreleased]

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

# Changelog

All notable changes to this fork of [pickle-com/glass](https://github.com/pickle-com/glass) are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Fork base: upstream commit `71bc3dc` (*firebase functions node20 migration*, 2025-10-25).

## [Unreleased]

### Ask Mode Shortcuts (branch `feat/ask-mode-shortcuts`)

#### Added
- **Ask mode picker** — a `▾` caret next to the Ask pill in the main header opens a dedicated mode-picker `BrowserWindow` with four modes: **Default**, **Code**, **Debug**, **System Design**. The selected mode persists in `electron-store` and reshapes the system prompt sent to the LLM. The header badge updates live to show the active mode (`Ask`, `Ask · Code`, `Ask · Debug`, `Ask · SysDes`). (`f442024`)
- **Three new prompt profiles** in `promptTemplates.js`: `pickle_glass_code`, `pickle_glass_debug`, `pickle_glass_system_design`. The original `pickle_glass_analysis` (Default) is untouched. (`f442024`)
- **`preferredCodeLanguage` setting** — free-text field in Settings (default `go`) injected into the Code profile via a `{{PREFERRED_LANGUAGE}}` token. Falls back to `__INFER_FROM_SCREENSHOT__` when blank. (`f442024`)
- **6 new IPC handlers** in `featureBridge.js` — `mainHeader:getAskMode`, `mainHeader:setAskMode`, `mainHeader:openModePicker`, `mainHeader:cancelHideModePicker`, `modePicker:closeWindow`, `settings:{get,set}PreferredCodeLanguage`. (`f442024`)
- **`mainHeader:askModeChanged` push event** — targeted broadcast from `featureBridge` to the header window so the badge updates immediately on selection (avoids the dead `settings-updated` broadcast). (`f442024`)

#### Changed
- **System Design prompt — section 5 split** into separate **Data Model** (§5) and **High-Level Architecture** (§6); subsequent sections renumbered through §11. (`216f0db`)
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

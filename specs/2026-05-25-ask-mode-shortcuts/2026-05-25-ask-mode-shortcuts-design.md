# Ask Mode Shortcuts — Design

**Date:** 2026-05-25
**Source brief:** `prompts/code-debug-shortcuts.txt`
**Status:** Design validated, ready for implementation planning.

## Goal

Speed up repeat usage of the Ask button by letting the user pick a *mode* once per session. The active mode reshapes the system prompt so the user doesn't paste the same instructions every time.

Four modes:

- **Default** — current behavior, unchanged.
- **Code** — coding-interview assistant. Returns Solution / Key Insights / Time / Space.
- **Debug** — debug-helper for code shown on screen. Returns Issues / Improvements / Optimizations / Explanation / Key Points.
- **System Design** — first-pass distributed-systems design from typed problem + screenshot.

Hard constraint: **no Listen-mode dependency.** Every mode works from typed text + the current screenshot only. The existing summary path (5-turn coaching via `summaryService.js`) is untouched.

## Decisions

| # | Decision | Choice |
|---|---|---|
| 1 | UI shape | Ask pill + mode dropdown (caret on the pill) — not four separate buttons. |
| 2 | Prompt content | Refine all three new prompts to streaming-markdown. Drop JSON. No Me/Them framing. |
| 3 | Code language | New `preferredCodeLanguage` setting, free-text, default `go`. Empty → LLM infers from screenshot. |
| 4 | Dropdown placement | In `MainHeader`, beside the Ask pill. Persisted to settings — survives restart. |
| 5 | Mode-switching shortcuts | None in v1. `Cmd+Enter` fires the active mode. Can be added later if friction is felt. |

## Architecture & data flow

```
MainHeader (Ask pill + caret ▾)             ← user picks mode here
    │  click ▾ → popover ── click "Code" → IPC: mainHeader:setAskMode('code')
    │  click pill → IPC: mainHeader.sendAskButtonClick()
    ▼
featureBridge / askService.sendMessage(userPrompt)
    │
    │  reads askMode from settings (single source of truth)
    │  reads preferredCodeLanguage from settings (Code mode only)
    │
    │  mode → profile name:
    │     'default'       → 'pickle_glass_analysis'   (existing)
    │     'code'          → 'pickle_glass_code'       (new)
    │     'debug'         → 'pickle_glass_debug'      (new)
    │     'system_design' → 'pickle_glass_system_design' (new)
    │
    ▼
getSystemPrompt(profile, conversationHistory, false)
    ▼
streamingLLM.streamChat(messages)   ← unchanged
```

Mode resolution lives in `sendMessage`, not in the UI. The UI sends only `userPrompt`. This keeps the renderer dumb, the routing testable, and the Summary path naturally on the default profile.

## Settings additions

In `settingsService` defaults:

```js
askMode: 'default',                  // 'default' | 'code' | 'debug' | 'system_design'
preferredCodeLanguage: 'go',         // free-text; 'go' if user never touches it
```

No DB migration. Both keys read with sensible defaults on first launch.

## UI additions

**`MainHeader.js`:**

- Ask area becomes `[Ask label · mode badge] [▾ caret]`.
- Clicking the main area → unchanged `_handleAskClick()`.
- Clicking the caret → small lit-html popover with `Default / Code / Debug / System Design`. Active mode shows a left checkmark.
- Picking an item → `window.api.mainHeader.setAskMode(mode)` → IPC writes to settings → popover closes → badge updates.
- Badge text: empty for `default` ("Ask"), otherwise `Ask · Code` / `Ask · Debug` / `Ask · SysDes`.
- On mount, `MainHeader` reads `askMode` via IPC with a `'default'` fallback if IPC fails.

**`SettingsView.js`:**

- One new free-text field — *Preferred coding language* — defaulting to `go`. Same pattern as the recent Gemini-model-ID change (commit `bc12688`).

## Prompt designs

All three new profiles use the existing 5-slot shape (`intro`, `formatRequirements`, `searchUsage`, `content`, `outputInstructions`) so `promptBuilder.js` works untouched. All three are streaming-markdown. All three explicitly drop Me/Them framing and treat input as "typed text + current screenshot."

### `pickle_glass_code`

- **intro:** Expert coding-interview assistant. Output renders on a translucent overlay — be glanceable.
- **formatRequirements:** Fixed four-heading structure:
  - `## Solution` — fenced code block in `${language}`, clean, commented, handles edge cases.
  - `## Key Insights` — 3–5 bullets, ≤20 words each.
  - `## Time Complexity` — `O(...)` with one sentence on the dominant operation.
  - `## Space Complexity` — `O(...)` with one sentence on what is stored.
- **content:** Inject `${language}` from `settings.preferredCodeLanguage`. If empty, instruct the LLM to infer from the screenshot.
- **outputInstructions:** Never restate the problem. Never add preamble. If the screenshot shows no problem, ask one clarifying question and stop.

### `pickle_glass_debug`

- **intro:** Debug code shown in the screenshot — errors, wrong output, or failing tests.
- **formatRequirements:** Five headings from the brief, verbatim:
  - `### Issues Identified`
  - `### Specific Improvements and Corrections`
  - `### Optimizations`
  - `### Explanation of Changes Needed`
  - `### Key Points`
- Bullets ≤20 words. Code blocks fenced with language tag.
- **outputInstructions:** If the screenshot has no error/code, ask what to debug. Don't speculate without evidence.

### `pickle_glass_system_design`

- **intro:** Staff-level distributed-systems engineer producing a first-pass design from typed problem + screenshot.
- **formatRequirements:** Six sections, all markdown headings, no JSON:
  1. Clarifying Questions (3–6, each with one-phrase rationale)
  2. Functional + Non-Functional Requirements (with concrete numbers: availability %, p50/p99 ms, consistency model)
  3. Back-of-Envelope Estimation (DAU → peak QPS → storage/day → bandwidth, math shown inline)
  4. API Design (4–8 endpoints with method, params, response, idempotency)
  5. Data Model + High-Level Architecture (entities, storage tech with rejected alternative; single ASCII diagram in fenced block)
  6. Deep Dives, Scaling, Tradeoffs (2–3 most likely interviewer probes; each with mechanism + tradeoff + failure mode + alert metric)
- **outputInstructions:** Every architectural claim has a number attached. Every choice names the rejected alternative. No JSON, no code fences around the whole answer, ASCII diagram in a single fenced block.

Full prompt prose will be drafted in implementation, with diffs shown before files are edited.

## Regression analysis

**Untouched paths:**

- `pickle_glass_analysis` profile — verbatim. Untouched in `promptTemplates.js`.
- `summaryService.js` Listen-summary path — still uses `pickle_glass_analysis` directly.
- `ask:sendQuestionFromSummary` IPC — doesn't pass `mode`, falls through to default.
- `shortcutsService.js:214` (`toggleAskButton(true)`) — pure UI toggle.
- Multimodal-error retry path (`askService.js:303–338`) — reuses the same `systemPrompt` variable, inherits the right mode automatically.
- `Cmd+Enter` shortcut — fires Ask in the currently-selected mode. Default mode = identical to today.

**Defensive hardening (designed in):**

1. **`askMode` validation in `sendMessage`** against `['default','code','debug','system_design']`. Unknown → coerce to `'default'`. Prevents a corrupted setting from triggering `promptBuilder.js:16`'s `profilePrompts.interview` fallback.
2. **Mode badge reads via IPC on `MainHeader` mount**, with `'default'` fallback on IPC failure. Header never renders a stale or empty badge.
3. **`preferredCodeLanguage` is trimmed before injection.** Whitespace-only → treated as empty → LLM infers from screenshot.

## Test plan

Manual smoke tests, in order:

1. Fresh install with empty settings → Ask works identically to today. (Backward-compat gate.)
2. Pick **Code**, leave language empty → screenshot a Go problem → response uses Go. Switch language setting to `python` → re-fire → response uses Python.
3. Pick **Debug**, screenshot a stack trace → response uses the 5-heading structure.
4. Pick **System Design**, type "design Twitter feed" → response has all 6 sections + ASCII diagram, all numbers populated.
5. Restart app → mode persists.
6. Start a Listen session, run summary every 5 turns → summary still uses `pickle_glass_analysis` (verify by reading the prompt log).
7. Corrupt `askMode` to `'banana'` in settings DB → Ask still works, falls back to default.
8. Empty screenshot capture (e.g. permission denied) → all four modes still respond using just the typed text — the existing fallback path handles it.

## Files touched

- `src/features/common/prompts/promptTemplates.js` — 3 new profile objects, no edits to existing.
- `src/features/ask/askService.js` — `sendMessage` reads `askMode` + `preferredCodeLanguage` from settings, picks profile.
- `src/features/common/services/settingsService.js` — 2 new keys with defaults.
- `src/ui/settings/SettingsView.js` — 1 new free-text field.
- `src/ui/app/MainHeader.js` — caret + popover + badge.
- `src/bridge/featureBridge.js` — `mainHeader:setAskMode` + `mainHeader:getAskMode` handlers.
- `src/preload.js` — expose the two new IPC functions on `window.api.mainHeader`.

No DB migration. No new dependencies. No new shortcuts. No Listen wiring.

## Explicitly out of scope

- Wiring `listenService.getConversationHistory()` into Ask (the README's known gap). Honoring the brief's "no listen mode" constraint.
- Mode-switching keyboard shortcuts (`Cmd+1/2/3/4` etc). Deferred to v2 after real-use feedback.
- A separate prep-mode profile for offline System Design study (the brief's JSON one-shot variant). Can be added later as `system_design_prep` if useful.
- Auto-detection of language from screenshot for Code mode. Handled implicitly via the empty-setting fallback.

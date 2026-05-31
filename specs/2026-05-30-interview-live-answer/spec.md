---
# Context Optimization Metadata
# Purpose: Enable efficient partial reads (~200 tokens vs ~2500 for full file)
meta:
  spec_id: 2026-05-30-interview-live-answer
  spec_name: interview-live-answer
  status: draft
  phase: clarify
  created: 2026-05-31
  updated: 2026-05-31

# Quick Reference (for checkpoint resume)
summary:
  goals:
    - {id: G1, description: "Auto-answer the interviewer's spoken question (system audio) during a live interview, streamed into the Listen insights pane, with no candidate typing", priority: HIGH}
    - {id: G2, description: "Keep the existing Live Insights summary lane behaviorally unchanged (Open-Closed): the answer lane is purely additive", priority: HIGH}
    - {id: G3, description: "Suppress noise — only fire on a detected interviewer question; stay silent (PASSIVE) otherwise; no flicker, no duplicates", priority: HIGH}
  constraints:
    - {id: C1, description: "LLM call is two-arg createStreamingLLM(provider, opts) with full model wiring from modelStateService.getCurrentModelInfo('llm') — NOT createLLM({...})", type: TECHNICAL}
    - {id: C2, description: "PASSIVE sentinel must be robust + streaming-aware via a prefix-buffer normalize check BEFORE rendering", type: TECHNICAL}
    - {id: C3, description: "Answer-lane debounce is SMALL (~600ms-1s) because STT already debounces 2s upstream (COMPLETION_DEBOUNCE_MS); the two compound", type: TECHNICAL}
    - {id: C4, description: "resetLiveAnswer() folds into resetConversationHistory() (listen window is NOT destroyed on Stop — isDestroyed() does not guard a late timer)", type: TECHNICAL}
    - {id: C5, description: "LiveAnswerView self-loads marked/hljs/DOMPurify idempotently, re-parses each delta, sanitizes, falls back to plain text, exposes resetAnswer()", type: TECHNICAL}
    - {id: C6, description: "Pure helpers (isLikelyQuestion, normalizePassive/parseAnswerOrPassive, shouldTriggerAnswer) extracted and unit-tested via node:test; makeLiveAnswer is a thin orchestrator", type: TECHNICAL}
    - {id: C7, description: "Reuse pickle_glass_analysis prompt UNCHANGED; promptTemplates.js stays closed", type: TECHNICAL}
    - {id: C8, description: "In-memory only — do NOT persist live answers to the session DB for v1", type: TECHNICAL}
  decisions:
    - {id: D1, decision: "Trigger = AUTO-ONLY for v1 (fires on detected them: question; no button/hotkey)", rationale: "Confirmed with user; manual override is explicit v2"}
    - {id: D2, decision: "Rendering = STREAMING (mirror askService._processStream)", rationale: "Confirmed with user; deviation from design doc's non-streaming llm.chat sketch"}
    - {id: D3, decision: "New <live-answer-view> ABOVE <summary-view> in the Listen insights pane — NOT in Ask", rationale: "Matches design + user preference; answer reads first"}
    - {id: D4, decision: "listenService.js is NOT edited; reset wiring rides on existing resetConversationHistory() calls", rationale: "listenService already calls resetConversationHistory on session start (:146) and close (:247)"}

# CRITICAL REQUIREMENTS - Must verify during implementation
# These survive context compaction and generate T-VERIFY tasks
critical_requirements:
  type: feature-major
  portal: app
  ui_changes: moderate
---

# Feature Specification: Interview Live Answer Lane

**Feature Branch**: `2026-05-30-interview-live-answer`
**Created**: 2026-05-31
**Status**: Draft
**Input**: User description: "interview-live-answer — During an interview, when the interviewer asks a question over system audio, Glass should automatically answer it (streamed, read-aloud-ready) without the candidate typing. Add a second analysis lane beside Live Insights: a new streaming Live Answer component in the Listen window's insights pane that auto-detects an interviewer (them:) question and streams an answer, reusing the existing pickle_glass_analysis prompt."

---

## ⚡ Quick Guidelines
- ✅ Focus on WHAT users need and WHY
- ❌ Avoid HOW to implement (no tech stack, APIs, code structure)
- 👥 Written for business stakeholders, not developers

> **Note on this spec's depth**: This feature was pre-validated through a design doc (`./design.md`) and a locked architectural brief. Because every integration point has been verified against live code, the Functional Requirements and Architecture Context sections intentionally carry implementation-level citations. The mandatory corrections (C1–C6) below are load-bearing — the design doc's prose is correct but its code sketch is wrong/incomplete, and these corrections prevent re-deriving the wrong approach in `/plan` and `/implement`.

### Source Artifacts (migrated into this spec dir)
- **Validated design**: `./design.md` (the "Live Answer Lane — design" doc; prose is authoritative, code sketch is superseded by C1–C6 below)
- **Original brief / UX discussion**: `./prompts.md` (the candidate's UX framing; note: any S3/Orion/telematics text in it is irrelevant template residue from an unrelated investigation brief — ignore it; this is a framework-internal `glass` change)

---

## System Context

**Systems**: Framework-internal — the `glass` Electron interview-assistant app. **No Cover Whale system involved.**
**Databases**: N/A — v1 is in-memory only; live answers are NOT persisted to the session DB (the SQLite-backed `summaryRepository.saveSummary` path used by the summary lane is deliberately not extended).
**Integrations**: LLM provider via the existing model-state config + streaming factory — one of OpenAI / Gemini / Anthropic / `openai-glass` / Ollama, selected by `modelStateService.getCurrentModelInfo('llm')`. Gemini mid-stream failover is internal to the provider (`gemini.js` + `geminiModelRotator`) and carries over for free.
**Key Architecture**: `summaryService.addConversationTurn(speaker, text)` (`summaryService.js:38`) is the shared hub fed by `listenService.handleTranscriptionComplete` (`listenService.js:106`). It already calls `triggerAnalysisIfNeeded()` (`:45`/`:305`) for the 5-turn summary lane. This feature adds a sibling `triggerAnswerIfNeeded(speaker, text)` beside it that, on a detected interviewer (`them:`) question, streams an answer through a new `live-answer-update` IPC channel into a new `<live-answer-view>` Lit component in the Listen window's insights pane.
**Documentation**: cw-documentation is not applicable (framework-internal change). Architecture is documented in-repo at `ARCHITECTURE.md` and the migrated `./design.md`.

*Framework-internal, no CW system involved.*

---

## Clarifications

### Session 2026-05-31

- Q: During abort-and-replace and the prefix-buffer gap, how should the panel transition render-state between the old answer and the first token of the new one? → A: Hold the previous answer until the first new token flushes, then replace in one assignment (never blank). Consistent with the locked G3 "no flicker / no flicker to empty" goal and mirrors `SummaryView`'s single-`innerHTML`-assignment convention (`SummaryView.js:375-397`). No "thinking" indicator in v1.
- Q: Trigger model for v1 — auto-only, or manual button/hotkey? → A: [LOCKED D1] AUTO-ONLY for v1 (fires on a detected `them:` question; no button/hotkey). Manual override is explicitly v2.
- Q: Rendering mode — streaming or non-streaming? → A: [LOCKED D2] STREAMING (mirror `askService._processStream`); supersedes the design doc's non-streaming `llm.chat` sketch.
- Q: Where does the new view live? → A: [LOCKED D3] `<live-answer-view>` placed ABOVE `<summary-view>` in the Listen insights pane (so the answer reads first); NOT in Ask.
- Q: Does reset wiring require editing `listenService.js`? → A: [LOCKED D4] No edit to `listenService.js`; reset wiring rides on existing `resetConversationHistory()` calls (`listenService.js:146,247`).
- Q: Tuning defaults (debounce, maxTokens, min-interval, openers, prefix-buffer length)? → A: [DELEGATED to agent, user-approved] answer-lane debounce = 800 ms; `maxTokens` = 900; optional min-interval = OFF for v1 (configurable, per FR-005); heuristic openers per FR-002; PASSIVE prefix-buffer = first newline or ~16 chars (per FR-010).
- Q: What is the load-bearing safety invariant? → A: The answer renders ONLY in the content-protected `listen` window; content protection MUST NOT be disabled (per Enforcement Strategy; `windowManager.js:507`, `settingsService.js:217`).

---

## User Scenarios & Testing *(mandatory)*

### Primary User Story

A candidate is in a live remote interview. They share their screen with the interviewer. Glass runs as a content-protected overlay (invisible to the shared screen) and listens to both microphone (`Me`) and system audio (`Them`). When the interviewer asks a question over system audio — e.g. "Can you walk me through how a Go channel works?" — Glass detects it is a question directed at the candidate and, within ~1–2 seconds of the question settling, streams a concise, read-aloud-ready answer into a Live Answer panel that sits above the existing Live Insights summary. The candidate never types. When the interviewer is just making small talk or talking among themselves, Glass stays silent and the panel keeps the previous answer rather than flickering to empty.

### Acceptance Scenarios

1. **Given** an active Listen session with the candidate sharing their screen, **When** the interviewer asks a technical question over system audio (speaker `Them`), **Then** within ~1–2 seconds of the answer-lane debounce firing, the first token of a streamed answer appears in the Live Answer panel, and the full answer renders as markdown as it streams.
2. **Given** the same session, **When** the candidate (speaker `Me`, microphone) asks or says anything, **Then** no answer is generated (the speaker gate blocks `Me`).
3. **Given** the interviewer speaks but says nothing that is a question directed at the candidate (e.g. "Okay, great, let me share my screen"), **When** the turn settles, **Then** the model returns the PASSIVE sentinel, the service emits nothing, and the panel keeps the last answer (no flicker to empty).
4. **Given** the interviewer asks one question across several STT segments ("So... can you tell me... how garbage collection works in Go?"), **When** the segments arrive within the debounce window, **Then** they coalesce into a single LLM call and a single streamed answer (not one per fragment).
5. **Given** an answer is mid-stream, **When** the interviewer immediately asks a genuinely new question, **Then** the in-flight stream is aborted and replaced by a stream for the new question.
6. **Given** an answer has just been produced for a question, **When** a trailing STT fragment of the same question arrives (normalized tail unchanged), **Then** no second answer is generated (de-dup on `lastAnsweredTail`).
7. **Given** the summary lane's independent 5-turn cadence, **When** answers stream on the answer lane, **Then** `summary-update` still fires on its own schedule and `SummaryView` output is unchanged (the two lanes are independent).
8. **Given** an active session with an answer mid-stream or a debounce timer pending, **When** the candidate presses Stop (or the session closes), **Then** the in-flight stream is aborted, the debounce timer is cleared, and no answer is emitted into the (non-destroyed) listen window — with no thrown error.

### Edge Cases

- **No model configured**: `modelStateService.getCurrentModelInfo('llm')` returns no model or no API key → `makeLiveAnswer` throws/aborts cleanly; the service logs and emits nothing; no crash. (Mirrors how the summary lane already depends on a configured model.)
- **Empty transcript / no session**: the trigger never fires; the debounce callback bails if `conversationHistory` is empty (guards the Stop/Start race where a late timer fires after reset).
- **PASSIVE mid-stream-shaped output**: the model emits `PASSIVE`, `PASSIVE.`, or `**PASSIVE**` (markdown-wrapped) → all normalize to the suppress signal and nothing renders. The prompt's native passive phrase ("Not sure what you need help with right now", `promptTemplates.js:388`) is also treated as a suppress signal.
- **Markdown libraries not yet loaded**: if `marked`/`hljs`/`DOMPurify` have not attached to `window` yet (SummaryView loads them async), LiveAnswerView falls back to rendering escaped plain text, then upgrades to rendered markdown once libraries are present (mirrors `SummaryView.js:359`).
- **Talkative interviewer**: an optional minimum interval between LLM calls (e.g. 1 per 3s) caps cost when the interviewer talks continuously.
- **Long answer**: answers scroll within the existing `insights-container` (already scrollable); no new scroll handling required.

---

## Requirements *(mandatory)*

### Functional Requirements

#### Trigger & gating (auto-only, v1)

- **FR-001**: The system MUST automatically attempt a live answer when a new conversation turn is added whose speaker is the interviewer (`them:`). The mic speaker (`Me`) MUST never trigger an answer. *(Speaker gate. `Me`=mic, `Them`=system audio per `sttService.js:82,109`. Gate on `speaker.toLowerCase() === 'them'`.)*
- **FR-002**: Before any LLM call, the system MUST apply a cheap, recall-oriented heuristic pre-filter (`isLikelyQuestion`): the latest `them:` tail ends with `?`, OR opens with one of what/how/why/when/where/which/who/can/could/would/do/does/did/is/are/tell me/walk me/describe/explain (case-insensitive). When the heuristic is uncertain it SHOULD favor calling the model and letting PASSIVE suppress (recall over precision). *(Final filtering is the model's PASSIVE, not the heuristic.)*
- **FR-003**: The system MUST debounce answer triggering with a SMALL, configurable window (default **800 ms**; bounded ~600 ms–1 s), resetting the timer on each new `them:` turn, so a multi-segment question coalesces into one call. The window is deliberately small because STT completions are ALREADY debounced 2 s upstream (`COMPLETION_DEBOUNCE_MS`, `sttService.js:6,138,149`) before `addConversationTurn` fires — the two debounces compound, and streaming hides the remaining latency. *(See C3.)*
- **FR-004**: The system MUST de-duplicate: skip triggering if (a) a stream is already in flight for the current question (abort-and-replace only on a genuinely new question), OR (b) the normalized tail equals `lastAnsweredTail` (echo/trailing-fragment suppression). *(De-dup / in-flight gate. The decision MUST be implemented in the pure helper `shouldTriggerAnswer(speaker, text, lastAnsweredTail, inFlight)` per C6.)*
- **FR-005**: The system SHOULD support an optional minimum interval between LLM calls (e.g. one per 3 s) as a talkative-interviewer cost guard, configurable alongside the debounce window. For v1 this guard defaults **OFF** (disabled but configurable), per the locked tuning defaults.

#### Answer generation (streaming)

- **FR-006**: The system MUST generate the answer by reusing the existing `pickle_glass_analysis` prompt UNCHANGED (`promptTemplates.js:238`). System-prompt assembly MUST mirror the summary lane (`summaryService.js:93`): `getSystemPrompt('pickle_glass_analysis', '', false)` then `.replace('{{CONVERSATION_HISTORY}}', recent)`, where `recent = formatConversationForPrompt(conversationTexts, 30)` (`summaryService.js:65`). `promptTemplates.js` MUST NOT be modified. *(Per `promptBuilder.js:15`, `getSystemPrompt(profile, customPrompt='', googleSearchEnabled=true)`; `searchUsage` is empty for this profile, so the `false` third arg is a no-op — kept for parity with the summary path.)*
- **FR-007**: The injected user message MUST instruct the model to answer the interviewer's (`them:`) most recent question directly per the prompt's primary directive, AND that if the transcript ends with no question directed at the candidate, its **entire** reply MUST be exactly `PASSIVE`.
- **FR-008** *(C1 — HIGH)*: The system MUST wire the LLM call as a **two-argument streaming call with full model resolution**. It MUST first call `const modelInfo = await modelStateService.getCurrentModelInfo('llm')`, throw/abort cleanly if `!modelInfo || !modelInfo.apiKey`, then call `createStreamingLLM(modelInfo.provider, { apiKey: modelInfo.apiKey, model: modelInfo.model, temperature: 0.7, maxTokens: 900, usePortkey: modelInfo.provider === 'openai-glass', portkeyVirtualKey: modelInfo.provider === 'openai-glass' ? modelInfo.apiKey : undefined })`. It MUST NOT use a single-object `createLLM({...})` form. *(`createStreamingLLM(provider, opts)` at `factory.js:128`.)*
- **FR-009**: The system MUST consume the returned stream exactly like `askService._processStream` (`askService.js:401`): split SSE `data:` lines; on `[DONE]` finalize; on `json._reset` (Gemini mid-stream failover restart) DISCARD all accumulated answer text and restart accumulation; on `json._final_model` record the satisfying model; on `json.choices[0].delta.content` append and emit. Gemini failover is internal to the provider and requires no special handling here beyond honoring `_reset`.
- **FR-010** *(C2 — MED-HIGH)*: The system MUST detect PASSIVE in a **streaming-aware** way, BEFORE rendering: buffer the stream prefix until the first newline or ~16 characters, normalize it (strip markdown/punctuation/whitespace, uppercase) via the pure helper `normalizePassive`/`parseAnswerOrPassive`, and if it equals `PASSIVE` (or matches the prompt's native passive phrase "Not sure what you need help with right now") then suppress: emit nothing and keep the last rendered answer. Otherwise flush the buffered prefix and stream subsequent deltas live. During the prefix-buffer gap (and during abort-and-replace per FR-004) the panel MUST hold the previously rendered answer and replace it in a single assignment only when the first non-suppressed token flushes — it MUST NOT blank to empty first (no "thinking"/blank frame in v1; see G3 and FR-015). *(The whole-string `content.trim() === 'PASSIVE'` check in the design sketch is insufficient for a streamed response.)*

#### Lifecycle & reset

- **FR-011** *(C4 — MED)*: The system MUST provide `resetLiveAnswer()` that (a) clears the debounce timer, (b) aborts any in-flight stream via `AbortController`, and (c) clears `lastAnsweredTail` and the in-flight flag. `resetLiveAnswer()` MUST be folded INTO `resetConversationHistory()` (`summaryService.js:52`) so it runs on both session start and session close with **no edit to `listenService.js`** (which already calls `resetConversationHistory()` at `:146` and `:247`).
- **FR-012** *(C4 — MED)*: Because the listen window is **NOT destroyed on Stop** (`listenService.js:72-78`), the `isDestroyed()` guard in `sendToRenderer` (`summaryService.js:29`) does NOT protect against a late debounce timer. The debounce callback MUST therefore additionally bail if `conversationHistory` is empty, and the abort+timer-clear in FR-011 MUST run on Stop. No answer may be emitted into a torn-down or reset session.

#### Renderer plumbing & UI

- **FR-013**: The system MUST add two listeners to the existing `summaryView` namespace in `preload.js` (`:205`): `onLiveAnswerUpdate(cb)` → `ipcRenderer.on('live-answer-update', cb)` and `removeAllLiveAnswerUpdateListeners()` → `ipcRenderer.removeAllListeners('live-answer-update')`. The service MUST send on a NEW `live-answer-update` channel (the existing `summary-update` channel MUST be left untouched).
- **FR-014**: The system MUST add a new `LiveAnswerView` Lit component at `src/ui/listen/summary/LiveAnswerView.js`, registered and rendered in `ListenView.js` as `<live-answer-view>` placed ABOVE `<summary-view>` (`ListenView.js:681`) so the answer reads first, sharing the insights pane with no new view-mode or toggle. Visibility MUST track `this.viewMode === 'insights'` like the sibling summary view.
- **FR-015** *(C5 — MED)*: `LiveAnswerView` MUST be self-sufficient for markdown: it MUST call the same idempotent `loadLibraries` pattern (guarded by `if (!window.marked)` to avoid double-loading), read the `marked`/`hljs`/`DOMPurify` globals into instance fields, re-parse/re-render on each streamed delta (like `SummaryView.updated → renderMarkdownContent`), DOMPurify-sanitize the output, fall back to escaped plain text when libraries are not yet loaded (mirror `SummaryView.js:359`), and expose a `resetAnswer()` method. When a new answer begins (including abort-and-replace), the view MUST retain the previously rendered markdown until the first token of the new answer is ready, then swap it in via a single content assignment (mirroring `SummaryView`'s single-`innerHTML`-assignment convention at `SummaryView.js:375-397`) — it MUST NOT clear the panel to empty between answers (no blank/"thinking" frame in v1; see G3 and FR-010).
- **FR-016**: `ListenView.js` MUST clear the live answer on session reset by calling the new `resetAnswer()` in the existing reset block (`ListenView.js:467-469`, beside `summaryView.resetAnalysis()`).

#### Independence & non-regression

- **FR-017**: The answer lane MUST be purely additive. `makeOutlineAndRequests`, the `summary-update` channel, `SummaryView.js`, `promptTemplates.js`, `askService.js`, and `featureBridge.js` MUST NOT be modified. If `makeLiveAnswer`/`triggerAnswerIfNeeded` were deleted, Live Insights MUST behave identically.

#### Testability

- **FR-018** *(C6 — MED)*: The system MUST extract pure, directly unit-testable helpers and keep `makeLiveAnswer` a thin streaming orchestrator: `isLikelyQuestion(text)` (heuristic gate, FR-002), `normalizePassive(text)` / `parseAnswerOrPassive(prefix)` (PASSIVE detection, FR-010), and `shouldTriggerAnswer(speaker, text, lastAnsweredTail, inFlight)` (de-dup/trigger decision, FR-001/FR-004). Tests MUST use the Node built-in test runner (`require('node:test')` + `require('node:assert/strict')`, matching `geminiModelRotator.test.js`) per `package.json:15` (`node --test src/**/__tests__/**/*.test.js`) — **NOT Jest**. Tests MUST mock the LLM (no live provider calls). The trigger→stream→emit integration test MAY use a small injectable LLM seam.

### Key Entities *(include if feature involves data)*

- **Conversation turn**: `${speaker.toLowerCase()}: ${text.trim()}` lines accumulated in `summaryService.conversationHistory` (in-memory array; speakers `me`/`them`). Read-only input to this feature.
- **Live answer (transient)**: the streamed markdown answer text plus a timestamp. In-memory only; pushed to the renderer via `live-answer-update`; NOT persisted (C8).
- **Answer-lane state (in-memory, on the service)**: `lastAnsweredTail` (normalized tail of the last answered question, for de-dup), the debounce timer handle, the in-flight `AbortController`, and an in-flight boolean — all cleared by `resetLiveAnswer()`.

### External Dependencies & Risk Assessment *(mandatory)*

**External Dependencies**:
| Dependency | Type | Risk Level | Quota/Limits | Fallback Behavior |
|------------|------|------------|--------------|-------------------|
| Configured LLM provider (OpenAI / Gemini / Anthropic / `openai-glass` / Ollama) via `modelStateService` + streaming factory | SDK/HTTP streaming | MED | Provider/plan-dependent; bounded per call by `maxTokens`; ~1 streamed call per detected interviewer question | Heuristic + PASSIVE + optional min-interval cap call volume. Gemini mid-stream failover is handled internally by the provider (`gemini.js` + `geminiModelRotator`) via the `_reset` sentinel. If no model/API key is configured, the lane no-ops cleanly. |

**HIGH-RISK Dependency Checklist**: Not applicable — the LLM provider is MED risk (cost-bounded, already integrated, failover handled). No new HIGH-RISK quota-limited API is introduced.

**Cost note**: The lane fires roughly once per interviewer question, not once per turn. Tuning knobs: the answer-lane debounce window, the optional minimum interval between calls, and `maxTokens`.

### Test Strategy *(mandatory)*

This feature is **Frontend/Electron-heavy** but its testable core is the pure trigger/parse logic in `summaryService`. Tests use the Node built-in runner only (see FR-018).

**Test Type Classification**:
| FR | Primary Test Type | Reason |
|----|-------------------|--------|
| FR-001 (speaker gate) | Unit | Pure `shouldTriggerAnswer` truth-table: `me:` → no trigger, `them:` → eligible |
| FR-002 (heuristic) | Unit | Pure `isLikelyQuestion` truth-table (question-mark tail, opener keywords, negatives) |
| FR-003 (debounce coalescing) | Integration (fake timers / injectable clock) | Rapid `them:` segments → exactly one call |
| FR-004 (de-dup / in-flight) | Unit + Integration | Same normalized tail twice → one trigger; in-flight → skip/abort-replace |
| FR-009 (stream consumption) | Integration (mocked stream) | `[DONE]`, `_reset`, `_final_model`, `delta.content` handled like askService |
| FR-010 (PASSIVE) | Unit | `normalizePassive`: `PASSIVE` / `PASSIVE.` / `**PASSIVE**` / native passive phrase → suppress; real answer → keep |
| FR-011/FR-012 (reset/race) | Integration (mocked stream) | Close mid-debounce aborts stream + clears timer, no throw, no emit |
| FR-017 (independence) | Integration (mocked stream) | `summary-update` still fires on its 5-turn cadence while answers stream |

**Distribution Estimate**:
- Feature type: [x] Mixed (pure-logic core + Electron UI/IPC shell)
- Unit: ~60% | Integration: ~35% | Contract: ~0% | E2E: ~0% | Static/Manual: ~5%
- Justification: The high-value logic (gating, PASSIVE parsing, de-dup, reset/race) is pure and unit-tested. Stream orchestration and lane-independence are covered by integration tests against a mocked/injected LLM stream. The Lit component's visual rendering and the end-to-end audio path are covered by manual verification (no automated Electron-renderer or live-audio harness in this repo).

**HIGH-RISK API Warning**:
- [ ] Feature calls a quota-limited HIGH-RISK API → **No.** The LLM provider is mocked in all tests; no live provider calls are made in the test suite.

**Estimated Test Count**: ~14–18 tests across 18 functional requirements (heuristic truth-table, normalizePassive cases, de-dup, debounce coalescing, me-vs-them gating, stream-marker handling, lane independence, mid-debounce session close).

### Error Handling & Recovery *(mandatory if feature can fail)*

**Error Scenarios**:
| Error Scenario | Type | User Message | Recovery Action |
|----------------|------|--------------|-----------------|
| No model / no API key configured | Permanent | None (silent — panel keeps last answer) | `makeLiveAnswer` throws/aborts cleanly; log; emit nothing |
| LLM stream error mid-answer | Transient | None (silent) | Abort the stream; keep whatever was rendered or the last answer; do not crash the lane |
| Late debounce timer after Stop/reset | Permanent (race) | None | Timer cleared + stream aborted by `resetLiveAnswer()`; debounce callback also bails on empty history; no emit |
| Model returns PASSIVE / native passive phrase | Expected | None (silent) | Suppress before render; keep last answer (no flicker) |
| Markdown libs not yet loaded | Transient | Plain-text answer (escaped) | Fall back to plain text; upgrade to markdown once libs attach to `window` |

**Error/Rescue Registry**:
| Method/Codepath | What Can Go Wrong | Exception Class | Rescued? | Rescue Action | User Sees |
|-----------------|-------------------|-----------------|----------|---------------|-----------|
| `summaryService.makeLiveAnswer` | No model/API key | Error (thrown) | Y | Catch, log, emit nothing | Panel keeps last answer |
| `summaryService.makeLiveAnswer` (stream loop) | Provider stream/network error | Error / AbortError | Y | Abort stream, log, retain rendered text | Partial or last answer retained |
| `triggerAnswerIfNeeded` debounce callback | Fires after session reset (Stop/Start race) | TypeError on torn-down refs | Y | Bail if history empty; rely on AbortController + cleared timer | Nothing (no throw, no emit) |
| `LiveAnswerView.renderMarkdownContent` | `marked`/`DOMPurify` undefined | TypeError | Y | Fall back to escaped plain text | Plain-text answer |

*Note: `AbortError` from a deliberately aborted stream is expected control flow, not a failure — it MUST be swallowed (mirrors askService's abort handling).*

**Failure Modes Registry**:
| Codepath | Failure Mode | Rescued? | Test? | User Sees? | Logged? |
|----------|-------------|----------|-------|------------|---------|
| `makeLiveAnswer` (no model) | clean no-op | Y | Y (integration) | last answer | Y |
| `makeLiveAnswer` (stream error) | abort, retain | Y | Y (integration) | partial/last | Y |
| debounce callback (post-reset) | bail, no emit | Y | Y (integration) | nothing | Y |
| PASSIVE suppression | emit nothing | Y | Y (unit) | last answer | optional |

*No row has `Rescued=N + Test=N + User Sees=Silent` — no critical gap.*

**Multi-Phase Operations**: Not applicable — a single streamed call per question; partial output is acceptable and simply rendered as far as it streamed.

**Resumability**:
- [ ] Operation can resume from last checkpoint? → No — answers are transient; a new question produces a fresh stream.
- [ ] Backup/snapshot prevents data loss? → N/A (in-memory, not persisted).
- [x] Idempotency guaranteed? → De-dup on `lastAnsweredTail` + in-flight guard make re-fired triggers for the same question safe (one answer).

### UI/Design Reference *(mandatory)*

**Feature Classification**:
- [ ] Backend-only
- [ ] Minor UI
- [x] **Moderate UI** (one new component sharing an existing pane; new IPC channel; streaming render) → Mockup REQUIRED-but-derived
- [ ] Major UI

**Design Reference**:
- Figma/Mockup Source: Not applicable — no external mockup. The visual reference is the existing sibling `SummaryView` (`src/ui/listen/summary/SummaryView.js`); `LiveAnswerView` mirrors its title + rendered-markdown layout and lives in the same `insights-container`. Layout intent is documented in `./design.md` ("UI and IPC" section).
- Design Component Name(s): `LiveAnswerView` (`<live-answer-view>`), placed above `<summary-view>` in `ListenView`.
- Mockup covers ALL functional requirements above: [x] Yes (the component renders a "Live Answer" title + streamed markdown; visibility tracks insights mode; no other UI surface).

**Component Inventory Preview**:
```
Reused (from existing Listen UI):
- insights-container scroll region: hosts both views (already scrollable)
- marked / hljs / DOMPurify window globals: loaded by SummaryView, reused idempotently
- viewMode === 'insights' visibility pattern: mirrored from <summary-view>

New components:
- LiveAnswerView (Lit element): "Live Answer" title + streamed, sanitized markdown body; resetAnswer() method
```

### Permissions & Access Control *(mandatory)*

**Portal Placement**:
- [ ] Admin Portal
- [x] **Application Portal** — this is the `glass` desktop app overlay itself (the candidate-facing product surface). There is no web portal; "app" is the closest classification.
- [ ] Public Portal

**Rationale for placement**: `glass` is a single-user local Electron application. The Live Answer lane is part of the core product surface (the Listen window's insights pane) used by the authenticated local user. There are no server-side routes, roles, or multi-tenant data scoping involved.

**Cross-Portal Considerations**: Not applicable — single Electron app, no cross-portal imports or routes.

**User Roles Affected**: Not applicable — single local user; no role system.

**Access Requirements**: Not applicable — no server-enforced capabilities. The only access-relevant property is the screen-share safety guarantee below.

**Data Scoping**:
- [x] User-scoped (single local user; conversation history lives in-memory in the local process).

**Enforcement Strategy (screen-share safety — load-bearing)**:
*This feature has no API/permission layer, but it has one critical safety invariant that MUST hold:*
- The Live Answer panel renders inside the **`listen` window, which is content-protected by default** (`windowManager.js:507` calls `listen.setContentProtection(...)`; default `contentProtection: true` at `settingsService.js:217`). Content protection excludes the overlay — including the streamed answer — from the candidate's shared screen. The user has confirmed the interviewer can see the shared screen, so this exclusion is load-bearing: **the implementation MUST NOT render the answer in any window that is not content-protected, and MUST NOT disable content protection on the listen window.**

### Architecture Context *(mandatory if feature has business logic)*

**Service Modules Required**:
| Service Name | Category | Responsibility | Reusable From |
|--------------|----------|----------------|---------------|
| `summaryService` (extended) | Business/Orchestration | Existing shared hub. NEW: `triggerAnswerIfNeeded(speaker, text)`, `makeLiveAnswer(conversationTexts)` (thin streaming orchestrator), `resetLiveAnswer()` (folded into `resetConversationHistory`), and pure helpers `isLikelyQuestion` / `normalizePassive` / `parseAnswerOrPassive` / `shouldTriggerAnswer` | Fed by `listenService` (unchanged) |
| `LiveAnswerView` (new) | UI (renderer) | Streaming markdown render of the live answer; self-loads markdown libs; `resetAnswer()` | Listen insights pane |

**Architecture Validation**:
- [x] Additive-only: new methods/component hang off existing seams; the summary lane is untouched (FR-017).
- [x] Reuses existing model resolution (`modelStateService.getCurrentModelInfo('llm')`) and streaming factory (`createStreamingLLM`) — no new provider plumbing (FR-008).
- [x] Reuses existing prompt (`pickle_glass_analysis`) and transcript-injection pattern; `promptTemplates.js` stays closed (FR-006/C7).
- [x] No edit to `listenService.js`; reset wiring rides on existing `resetConversationHistory()` calls (D4/FR-011).
- [x] Pure logic separated from I/O for unit testing (FR-018/C6).

**Existing Services/Code to Reuse** *(prevents duplication)*:
| Existing Code | Location | Can Reuse For |
|------------------|----------|---------------|
| `addConversationTurn` / `triggerAnalysisIfNeeded` seam | `summaryService.js:38,45,305` | Hang `triggerAnswerIfNeeded` beside the existing analysis trigger |
| `formatConversationForPrompt` / `getConversationHistory` | `summaryService.js:65,48` | Build the `{{CONVERSATION_HISTORY}}` injection (maxTurns=30) |
| System-prompt assembly | `summaryService.js:93` | `getSystemPrompt('pickle_glass_analysis','',false).replace('{{CONVERSATION_HISTORY}}', recent)` |
| `sendToRenderer` (targets `listen` window, `isDestroyed()`-guarded) | `summaryService.js:29` | Emit `live-answer-update` |
| `createStreamingLLM(provider, opts)` + `.streamChat(messages)` | `factory.js:128` | Streamed answer generation (FR-008) |
| `_processStream` SSE handling (`[DONE]`/`_reset`/`_final_model`/`delta.content`) + `AbortController` | `askService.js:236,401` | Stream consumption + abort-on-new/close (FR-009) |
| `loadLibraries` + `renderMarkdownContent` + plain-text fallback | `SummaryView.js:291-344,359` | Markdown rendering in `LiveAnswerView` (FR-015) |
| `summaryView` preload namespace | `preload.js:205` | Add the two `live-answer-update` listeners (FR-013) |
| `<summary-view>` placement + `viewMode==='insights'` + reset block | `ListenView.js:467-469,681` | Mount `<live-answer-view>` above it + reset wiring (FR-014/FR-016) |

**Files**:
- **New**: `src/ui/listen/summary/LiveAnswerView.js`; `src/features/listen/summary/__tests__/liveAnswer.test.js` (or sibling test path matching the `node --test src/**/__tests__/**/*.test.js` glob).
- **Additive edits**: `src/features/listen/summary/summaryService.js` (methods + pure helpers + fold `resetLiveAnswer` into `resetConversationHistory`); `src/preload.js` (two listeners in the `summaryView` namespace); `src/ui/listen/ListenView.js` (import + one element above `<summary-view>` + one reset line).
- **Closed/untouched**: `makeOutlineAndRequests`, the `summary-update` channel, `SummaryView.js`, `promptTemplates.js`, `askService.js`, `featureBridge.js`, `listenService.js`.

---

## Related Memory

Potentially related memory entries:
- [0.80] stt-session-not-active-is-stopstart-race: Diagnosing Glass "User/Their STT session not active" errors — it's a Stop/Start capture race, not a Deepgram drop (type: project) — stt-session-not-active-is-stopstart-race.md

*Relevance: directly informs C4/FR-011/FR-012. A late timer or in-flight stream firing after a deliberate Stop is the same Stop/Start race class; the reconnect/cleanup logic MUST treat a deliberate close as deliberate (abort + clear, do not retry).*

---

## Out of Scope / Future Work

- **v2 — Manual override**: a "answer now / re-roll" affordance with its own Listen-pane hotkey/button (explicitly NOT Ask's Cmd/Ctrl+1), including de-dup against an in-flight auto call.
- **v2 — Personalized answers**: wire the candidate's résumé/bio into the prompt's currently-empty `customPrompt` slot (`promptBuilder.js` injects "User-provided context"; currently "User context unavailable") to unlock personalized behavioral/statement answers.
- **Persistence**: saving live answers to the session DB (the summary lane's `summaryRepository.saveSummary` path is deliberately not extended here).
- **Ask transcript wiring**: making Ask receive the live transcript — a separate, pre-existing gap that `./design.md` and `./prompts.md` raise but explicitly leave open.

---

## Review Checklist (Gate)

- [x] No [NEEDS CLARIFICATION] markers remain (all open questions were resolved by the locked decisions in the brief)
- [x] Requirements are testable (each FR maps to a unit/integration test or an explicit manual-verification rationale)
- [x] Test strategy defined (Node built-in runner; LLM mocked; pure-helper unit tests + mocked-stream integration tests)
- [x] Portal placement selected (Application Portal — the local Electron app surface)
- [x] Permissions defined — N/A for roles; the load-bearing constraint is the content-protection screen-share guarantee (captured under Enforcement Strategy)
- [x] Data sensitivity classified — in-memory transcript/answer, single local user, not persisted; no Confidential/Restricted handling
- [x] External APIs identified (LLM provider, MED risk, mocked in tests, failover handled internally)
- [x] Error handling defined (no-model, stream error, Stop/Start race, PASSIVE, missing markdown libs)
- [x] UI complexity classified (Moderate — one new component in an existing pane)
- [x] Deprecation decision made — N/A; feature is purely additive and deprecates nothing (FR-017)
- [x] Bug evidence — N/A; `critical_requirements.type` is `feature-major`, not `bugfix`

---

## Next Steps

- Review and refine this spec: `specs/2026-05-30-interview-live-answer/spec.md`
- `/clarify` complete (Session 2026-05-31 — render-state transition resolved; tuning defaults + locked decisions recorded). The LOCKED DECISIONS D1–D4 and corrections C1–C8 are not open for re-litigation.
- Run `/plan` next.

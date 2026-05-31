# Phase 0 Research: Interview Live Answer Lane

**Spec**: `specs/2026-05-30-interview-live-answer/spec.md`
**Plan**: `specs/2026-05-30-interview-live-answer/plan.md`
**Date**: 2026-05-31

This feature was pre-validated through `design.md` and a locked architectural brief. The "research" here is **citation verification**: every load-bearing integration point in the spec was confirmed against live code during planning. There were zero NEEDS CLARIFICATION markers to resolve and no unknown technologies to spike — the work was to confirm the spec's code claims and pin the corrections (C1–C8) to real line numbers.

## Verified-Citation Table

| Claim (FR / correction) | Cited Location | Verified Finding |
|-------------------------|----------------|------------------|
| `createStreamingLLM` is two-arg `(provider, opts)` (C1/FR-008) | `factory.js:128` | ✅ `function createStreamingLLM(provider, opts)`; remaps `openai-glass`→`openai`; applies `sanitizeModelId`; exported at `:182`. The design doc's `createLLM({...})` single-object sketch is WRONG. |
| `summaryService` does NOT yet import the streaming factory | `summaryService.js:3` | ✅ Imports only `const { createLLM } = require('../../common/ai/factory')`. New code MUST add `createStreamingLLM`. |
| Model resolution + guard | `summaryService.js:101-104`; `askService.js:249-252` | ✅ `const modelInfo = await modelStateService.getCurrentModelInfo('llm'); if (!modelInfo || !modelInfo.apiKey) throw …` — identical in both. |
| Streaming opts shape | `askService.js:308-314` | ✅ `{apiKey, model, temperature:0.7, usePortkey: provider==='openai-glass', portkeyVirtualKey: provider==='openai-glass'?apiKey:undefined}`. Spec adds `maxTokens:900` (FR-008) — askService omits maxTokens but the summary lane sets `maxTokens:1024` (`summaryService.js:144`), confirming the opt is honored. |
| SSE consumption (`[DONE]`/`_reset`/`_final_model`/`delta.content`) (FR-009) | `askService.js:401-474` | ✅ `data:` split (`:417`), `[DONE]` return (`:419`), `_reset` discard + `responseHadFallback=true` (`:426-432`), `_final_model` (`:435-439`), `choices?.[0]?.delta?.content` append (`:441-446`). |
| AbortController + abort-on-new + swallow AbortError | `askService.js:233-237,327-330,452-454` | ✅ New request aborts prior (`:233-235`); reader cancel on signal abort (`:327-330`); `if (signal.aborted) … intentionally cancelled` (no error log) (`:452-454`). |
| `.streamChat(messages)` returns a fetch-style Response | `askService.js:317-326` | ✅ `const response = await streamingLLM.streamChat(messages); … response.body.getReader()`. |
| `pickle_glass_analysis` prompt exists, primary directive answers questions (C7/FR-006) | `promptTemplates.js:238,249` | ✅ Profile at `:238`; `<primary_directive>` "If a question is presented to the user, answer it directly" at `:249`. |
| Native passive phrase (FR-010 suppress signal) | `promptTemplates.js:388` | ✅ "Saying \"Not sure what you need help with right now\"". (Also at `:54`, `:63`, `:106` in other phrasings.) |
| System-prompt assembly + token replace | `summaryService.js:93-94` | ✅ `getSystemPrompt('pickle_glass_analysis', '', false)` then `.replace('{{CONVERSATION_HISTORY}}', recentConversation)`. |
| `formatConversationForPrompt(texts, maxTurns=30)` | `summaryService.js:65-68` | ✅ `slice(-maxTurns).join('\n')`; default 30. |
| Hub: `addConversationTurn` → `triggerAnalysisIfNeeded` | `summaryService.js:38-46,305` | ✅ Push line then `this.triggerAnalysisIfNeeded()` at `:45`. Trigger fires every 5 turns (`:306`). |
| `resetConversationHistory` (fold target, C4/FR-011) | `summaryService.js:52-57` | ✅ Clears `conversationHistory`, `previousAnalysisResult`, `analysisHistory`. `resetLiveAnswer()` folds in here. |
| `sendToRenderer` targets listen window, `isDestroyed()`-guarded | `summaryService.js:29-36` | ✅ `windowPool.get('listen')`; `if (listenWindow && !listenWindow.isDestroyed())`. |
| STT upstream debounce 2 s (C3/FR-003) | `sttService.js:6,138,149` | ✅ `const COMPLETION_DEBOUNCE_MS = 2000`; used in both my/their completion timers. |
| Speaker labels `Me`/`Them` (FR-001) | `sttService.js:82,109` | ✅ `onTranscriptionComplete('Me', …)` / `onTranscriptionComplete('Them', …)`. |
| `summaryView` preload namespace + `summary-update` listeners (FR-013) | `preload.js:205-213` | ✅ `onSummaryUpdate` / `removeOnSummaryUpdate` / `removeAllSummaryUpdateListeners` on `summary-update`. New listeners go beside; original untouched. |
| `<summary-view>` mount point (FR-014) | `ListenView.js:681-684` | ✅ `<summary-view .isVisible=${this.viewMode === 'insights'} …>`. `<live-answer-view>` goes ABOVE it. |
| Reset block (FR-016) | `ListenView.js:467-469` | ✅ `if (summaryView) summaryView.resetAnalysis();` inside the `!wasActive && isActive` reset. `resetAnswer()` goes beside. |
| Idempotent lib loader (FR-015) | `SummaryView.js:291-344` | ✅ `loadLibraries` guards each script with `if (!window.marked)` / `if (!window.hljs)` / `if (!window.DOMPurify)`; reads globals into instance fields. |
| Plain-text fallback (FR-015) | `SummaryView.js:356-369` | ✅ `parseMarkdown` returns raw text when `!isLibrariesLoaded || !marked`. |
| Sanitize + single `innerHTML` swap (FR-015/Q1) | `SummaryView.js:375-397` | ✅ `DOMPurify.sanitize(parsedHTML)`; on removed-unsafe → `'⚠️ ' + originalText`; else single `element.innerHTML = parsedHTML`. |
| Content protection on listen window (safety invariant) | `windowManager.js:507` | ✅ `listen.setContentProtection(isContentProtectionOn)`. |
| Content protection default true | `src/features/settings/settingsService.js:217` | ✅ `contentProtection: true`. (Spec's dir-shorthand `settingsService.js:217` resolves here; line correct.) |
| Test runner = node:test (FR-018) | `package.json:15` | ✅ `"test": "node --test src/**/__tests__/**/*.test.js"`. No Jest/Vitest in devDependencies. |
| Existing node:test pattern + SSE-extraction strategy | `geminiModelRotator.test.js:13-14`; `askService-sse.test.js:16-17,31-60` | ✅ `require('node:test')` + `require('node:assert/strict')`; `askService-sse.test.js` extracts the SSE loop into a standalone `processSseLines(...)` to avoid Electron coupling — directly reusable for FR-009/FR-018. |

## Key Decisions

### D-R1: Replicate `_processStream`, do NOT import it
**Decision**: `makeLiveAnswer` replicates the SSE loop shape locally and extracts the per-line parse into a pure, testable function. It does NOT import or call `askService._processStream`.
**Rationale**: FR-017 keeps `askService.js` in the untouched set, and `_processStream` is private + coupled to ask-window state (`this.state`, `_broadcastState`, `askRepository`). The existing `askService-sse.test.js` already proves the extract-to-pure-function pattern; reusing it gives a clean unit seam.
**Alternatives rejected**: (a) Export `_processStream` from askService and share it — violates FR-017 and couples the lanes. (b) Subclass/compose askService — heavyweight, drags in ask-window assumptions.

### D-R2: Two-arg `createStreamingLLM` with full model resolution (locked C1)
**Decision**: `getCurrentModelInfo('llm')` → guard → `createStreamingLLM(provider, {apiKey, model, temperature:0.7, maxTokens:900, usePortkey, portkeyVirtualKey})`.
**Rationale**: This is the only call shape the factory exposes (`factory.js:128`) and the only one that carries provider/key/Portkey wiring + Gemini failover. The design doc's `createLLM({...})` would (a) be non-streaming and (b) pass an opts object as the `provider` arg — broken.
**Alternatives rejected**: design-doc `createLLM({...})` (wrong arity, non-streaming).

### D-R3: Streaming-aware PASSIVE via prefix-buffer (locked C2)
**Decision**: Buffer the stream prefix until the first newline or ~16 chars; `normalizePassive` (strip markdown/punct/whitespace, uppercase); if `=== 'PASSIVE'` or the native phrase → suppress before any render (hold last answer); else flush the buffered prefix and stream subsequent deltas live.
**Rationale**: A whole-string `content.trim() === 'PASSIVE'` check cannot run on a stream (the full string isn't available until the end, defeating the point of streaming). Buffering a tiny prefix lets us decide suppress-vs-render within the first token or two while keeping the no-flicker contract (Q1/G3).
**Alternatives rejected**: whole-string check (design sketch — not streaming-compatible); render-then-retract (causes the exact flicker G3 forbids).

### D-R4: Fold `resetLiveAnswer` into `resetConversationHistory`; no `listenService.js` edit (locked C4/D4)
**Decision**: `resetConversationHistory()` (`summaryService.js:52`) additionally calls `resetLiveAnswer()` (clear timer, abort in-flight, clear `lastAnsweredTail`/`inFlight`). The debounce callback also bails when `conversationHistory.length === 0`.
**Rationale**: `listenService.js` already calls `resetConversationHistory()` on session start (`:146`) and close (`:247`), so reset wiring is free without editing it (D4). The listen window is NOT destroyed on Stop (`listenService.js:72-78`), so the `isDestroyed()` guard in `sendToRenderer` does NOT protect a late debounce timer — hence the empty-history bail. **Reinforced by the prior STT Stop/Start-race lesson**: a deliberate Stop must abort + clear, never retry.
**Alternatives rejected**: editing `listenService.js` (violates D4); relying on `isDestroyed()` alone (window survives Stop — wouldn't fire).

### D-R5: In-memory only; no DB persistence (locked C8)
**Decision**: Live answers are transient `{answer, ts}`; the `summaryRepository.saveSummary` path is NOT extended.
**Rationale**: Spec C8 + Out-of-Scope. Avoids a schema/migration surface and keeps the lane a pure UI/streaming concern.

### D-R6: node:test, not Jest (locked FR-018)
**Decision**: `require('node:test')` + `require('node:assert/strict')`; test file under `src/features/listen/summary/__tests__/liveAnswer.test.js` to match the `package.json:15` glob.
**Rationale**: No Jest/Vitest installed; Electron 30 ships Node 20+ with the built-in runner. Mirrors the two existing test files.

## Open Items
None. All citations verified; all corrections pinned to live line numbers. No spikes outstanding.

## Testing Strategy (consolidated)

- **Feature type**: Mixed (pure-logic core + Electron UI/IPC shell).
- **External APIs**: configured LLM provider (streaming) — MED risk, mocked everywhere. No HIGH-RISK quota API → no E2E ban needed (none planned regardless).
- **Distribution**: Unit ~60% / Integration ~35% / Contract 0% / E2E 0% / Static-Manual ~5%.
- **Estimated tests**: ~14–18.
- **Mocking**: inject a fake `createStreamingLLM`/`streamChat` returning a synthetic SSE `ReadableStream`; fake/injectable clock for the 800 ms debounce; spy on `sendToRenderer`.
- **Manual-only**: the Lit component's visual render + the end-to-end audio→answer path (no renderer/audio harness in-repo).

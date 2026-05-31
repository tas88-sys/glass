# Quickstart: Interview Live Answer Lane

**Spec**: `specs/2026-05-30-interview-live-answer/spec.md`
**Plan**: `specs/2026-05-30-interview-live-answer/plan.md`
**Date**: 2026-05-31

This quickstart maps each Acceptance Scenario and edge case to an executable `node:test` case or an explicit manual-verification step, and gives the exact commands to run the suite.

## Prerequisites

- Node 20+ (bundled with Electron 30; the test runner is the Node built-in `node:test`).
- No extra install — `node:test` + `node:assert/strict` ship with Node. **Do NOT add Jest/Vitest.**
- A configured LLM model is NOT required for the automated suite (the provider is mocked/injected everywhere). It IS required for the manual end-to-end check.

## Running the tests

```bash
# Full suite (matches package.json:15)
node --test src/**/__tests__/**/*.test.js

# Just this feature's tests
node --test src/features/listen/summary/__tests__/liveAnswer.test.js
```

Expected after implementation: all `liveAnswer.test.js` cases pass. During TDD they MUST fail first (RED) before the helper/orchestrator code exists.

## Test pattern (mirror the existing files)

```js
'use strict';
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Pure helpers import (once implemented + exported from summaryService or a sibling helpers module):
const { isLikelyQuestion, normalizePassive, parseAnswerOrPassive, shouldTriggerAnswer } = require('../summaryService');

// For the SSE/stream path, extract the per-line parser into a standalone function and test it
// the way askService-sse.test.js tests processSseLines(...) — no Electron coupling.
```

Reference files already in the repo:
- `src/features/common/ai/providers/__tests__/geminiModelRotator.test.js` — node:test structure.
- `src/features/ask/__tests__/askService-sse.test.js` — extract-SSE-loop-to-pure-function strategy (reuse this for FR-009/FR-018).

## Acceptance Scenario → Test mapping

| AS | Scenario | Test type | How |
|----|----------|-----------|-----|
| AS-1 | `them:` technical question → first token appears, streams as markdown | Integration (mocked stream) + Manual | Inject a fake stream emitting `data: {choices:[{delta:{content:"..."}}]}` lines; assert `live-answer-update` emitted with growing `answer`. Visual stream = manual. |
| AS-2 | `Me` (mic) says anything → no answer | Unit | `shouldTriggerAnswer('Me', 'how does X work?', null, false) === false` |
| AS-3 | `them:` non-question ("let me share my screen") → PASSIVE, panel keeps last | Unit + Integration | `isLikelyQuestion` false; and a stream whose prefix normalizes to `PASSIVE` → assert no emit, last answer held |
| AS-4 | Multi-segment question within debounce → ONE call | Integration (fake clock) | Push 3 `them:` fragments < 800 ms apart; advance clock; assert exactly one `makeLiveAnswer` invocation |
| AS-5 | New question mid-stream → abort + replace | Integration | Start stream A; push a genuinely new `them:` tail; assert A's controller aborted and a new stream starts |
| AS-6 | Trailing fragment of answered question → no second answer | Unit | `shouldTriggerAnswer('Them', sameTail, normalize(sameTail), false) === false` |
| AS-7 | Lane independence: `summary-update` still fires on 5-turn cadence | Integration | Drive 5+ turns with answers streaming; assert `summary-update` emitted on its schedule and `SummaryView` data unchanged |
| AS-8 | Stop mid-stream / mid-debounce → abort + clear, no emit, no throw | Integration | Call `resetConversationHistory()` (which folds in `resetLiveAnswer()`) during stream/debounce; assert controller aborted, timer cleared, no emit, no throw |

## Edge Case → Verification mapping

| EC | Verification |
|----|--------------|
| No model configured | Integration: mock `getCurrentModelInfo('llm')` → `null`; assert `makeLiveAnswer` no-ops (warn, no emit, no throw) |
| Empty transcript / late timer after reset | Integration: fire debounce callback with empty `conversationHistory`; assert bail, no emit |
| PASSIVE mid-stream-shaped (`PASSIVE.`, `**PASSIVE**`, native phrase) | Unit on `normalizePassive` / `parseAnswerOrPassive` (see contracts/EDGE_CASES.md) |
| Markdown libs not loaded | Unit on the render helper / Manual: render before libs attach → escaped plain text; upgrade after |
| Talkative interviewer (min-interval) | Unit/Integration: guard OFF by default (no-op); when enabled, second call within interval is skipped |
| Long answer | Manual: confirm scroll within `insights-container` |

## Manual end-to-end verification (no automated harness)

1. Configure an LLM model in settings (any supported provider).
2. Start a Listen session; ensure the insights pane is visible (`viewMode === 'insights'`).
3. Play/speak a question over **system audio** (the `Them` channel) — e.g. "Can you explain how a hash map works?".
4. Within ~1–2 s after the question settles, confirm the **Live Answer** panel (ABOVE Live Insights) streams a markdown answer.
5. Speak small talk over system audio ("okay, let me pull up the next question") → confirm the panel **holds the previous answer** (no flicker to empty, no new answer).
6. Speak into the **mic** (`Me`) → confirm NO answer is generated.
7. Ask a multi-segment question with pauses → confirm a SINGLE coalesced answer.
8. Press **Stop** mid-answer → confirm no error, the stream stops, and starting a new session clears the panel.

## Safety verification (load-bearing — MUST check)

- [ ] The answer renders ONLY in the content-protected `listen` window (the overlay is excluded from a shared screen). Confirm by screen-sharing during step 4 — the answer must NOT appear on the shared screen.
- [ ] No code path disables content protection (`windowManager.js` untouched; grep the diff for `setContentProtection(false)` → none).
- [ ] The answer text is never logged to console or any capturable sink (grep the diff: only trigger/suppress/error events log, never the answer body).

## Non-regression verification

- [ ] `SummaryView` output unchanged (the summary lane is untouched — FR-017).
- [ ] Removing `triggerAnswerIfNeeded`/`makeLiveAnswer` leaves Live Insights behaving identically.
- [ ] `eslint --ext .ts,.tsx,.js .` passes for the changed files.

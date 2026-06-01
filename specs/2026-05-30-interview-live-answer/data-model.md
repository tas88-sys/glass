# Phase 1 Data Model: Interview Live Answer Lane

**Spec**: `specs/2026-05-30-interview-live-answer/spec.md`
**Date**: 2026-05-31

This feature is **in-memory only** (C8) — there is no database schema, no migration, no persisted entity. The "data model" is the set of transient runtime structures, the pure-helper signatures, and the trigger-gate state machine.

## Entities

### 1. Conversation turn (read-only input)
The existing buffer this feature reads but does not own.

| Field | Type | Notes |
|-------|------|-------|
| line | `string` | `"${speaker.toLowerCase()}: ${text.trim()}"` — speaker ∈ `{me, them}`. Stored in `summaryService.conversationHistory: string[]`. |

- **Source**: `summaryService.addConversationTurn(speaker, text)` (`summaryService.js:38`), fed by `listenService.handleTranscriptionComplete`.
- **Read by**: `triggerAnswerIfNeeded` (latest `them:` tail) and `makeLiveAnswer` (via `formatConversationForPrompt(history, 30)`).
- **Ownership**: read-only here; the summary lane owns it.

### 2. Live answer (transient, emitted)
The streamed result. Never persisted. *(Amended 2026-06-01: gained `id` + `question`; the renderer now keeps a newest-first in-session history of these — see Entity 4.)*

| Field | Type | Notes |
|-------|------|-------|
| id | `number` | Stable per-answer id (monotonic `++answerSeq`). Constant across one answer's whole stream — including a `_reset` restart — and new per question. The renderer keys its history on this. |
| question | `string` | The triggering interviewer (`them:`) turn, shown as the history entry's label. |
| answer | `string` | Accumulated markdown answer text (full text re-sent on each delta, mirroring askService's `currentResponse` broadcast). |
| ts | `number` | `Date.now()` when the (re)emit happened. |

- **Lifecycle**: created when the first non-suppressed token flushes; updated each delta; discarded on `_reset` (Gemini failover) and re-accumulated under the SAME `id`; a new question emits under a NEW `id`, which the renderer prepends as a new history entry (the previous one is retained, not replaced).
- **IPC shape**: `LiveAnswerUpdatePayload = { id: number; question: string; answer: string; ts: number }` over `live-answer-update`.

### 3. Answer-lane state (in-memory, on the service instance)
Cleared by `resetLiveAnswer()`.

| Field | Type | Initial | Notes |
|-------|------|---------|-------|
| `lastAnsweredTail` | `string \| null` | `null` | Normalized tail of the last answered question (de-dup, FR-004b). |
| `answerDebounceTimer` | `Timeout \| null` | `null` | Handle for the 800 ms answer-lane debounce (FR-003). |
| `inFlightController` | `AbortController \| null` | `null` | Aborts the in-flight stream on a new question / on close (FR-004a, FR-011b). |
| `inFlight` | `boolean` | `false` | True while a stream is being consumed (FR-004a). |
| `hadFallback` | `boolean` | `false` | Set true on a `_reset` sentinel (Gemini mid-stream failover); per-call, reset at stream start. |
| `lastAnswerTs` | `number` | `0` | Optional min-interval guard timestamp (FR-005; guard default OFF). |

- **Lifecycle**: all fields reset by `resetLiveAnswer()`, which is invoked from `resetConversationHistory()` (`summaryService.js:52`) on session start and close.

### 4. Live answer history (transient, renderer-side) — *added 2026-06-01*
The newest-first, in-session list the `<live-answer-view>` keeps. In renderer memory only; cleared by `resetAnswer()` on session reset. NOT persisted (C8).

| Field | Type | Notes |
|-------|------|-------|
| answers | `Array<{id, question, text, ts}>` | Newest-first. Folded by the pure reducer `applyLiveAnswerUpdate(answers, payload, max)` (`src/ui/listen/summary/liveAnswerHistory.js`): a same-`id` payload updates one entry in place (streaming); a new `id` is prepended; entries past `MAX_ANSWERS` (20) are dropped from the tail (oldest). Returns a new array (never mutates) for reactive binding. |

- **Why a separate reducer**: keeps the coalesce/prepend/cap logic pure and DOM-free so it is unit-testable (FR-018/C6) — see `src/ui/listen/summary/__tests__/liveAnswerHistory.test.js`.

## Pure Helper Signatures (extracted for unit testing — FR-018/C6)

These are pure functions (no I/O, no timers, no `this`), exported for direct `node:test` unit testing. `makeLiveAnswer`/`triggerAnswerIfNeeded` are thin orchestrators built on them.

```
isLikelyQuestion(text: string): boolean
  // FR-002. Recall-oriented heuristic. true if the latest them: tail
  //   - ends with '?', OR
  //   - opens (case-insensitive, after trim) with one of:
  //     what, how, why, when, where, which, who, can, could, would,
  //     do, does, did, is, are, tell me, walk me, describe, explain
  // Favor recall: when uncertain, return true and let PASSIVE suppress.

normalizePassive(text: string): string
  // FR-010. Strip markdown emphasis (* _ ` #), strip surrounding
  // punctuation, collapse/trim whitespace, uppercase. Used to compare a
  // buffered prefix against the suppress signals.

parseAnswerOrPassive(prefix: string): { passive: boolean; flush: string }
  // FR-010. Given the buffered stream prefix (≤ first newline or ~16 chars),
  // decide: passive=true if normalizePassive(prefix) === 'PASSIVE' OR matches
  // the normalized native phrase ("Not sure what you need help with right now");
  // else passive=false and flush = the buffered prefix to render.

shouldTriggerAnswer(
  speaker: string,
  text: string,
  lastAnsweredTail: string | null,
  inFlight: boolean
): boolean
  // FR-001 + FR-004 (decision only; debounce/timer live in the orchestrator).
  // false if speaker.toLowerCase() !== 'them'  (FR-001 mic gate)
  // false if !isLikelyQuestion(text)           (FR-002)
  // false if normalize(tail of text) === lastAnsweredTail  (FR-004b echo/fragment)
  // (inFlight handling: the orchestrator decides abort-and-replace ONLY on a
  //  genuinely new tail; a same-tail-in-flight repeat is suppressed.)
  // true otherwise (eligible — orchestrator then debounces).
```

### Normalization rule (shared by `normalizePassive` and the de-dup tail)
1. Lowercase-then-compare is NOT used for PASSIVE (PASSIVE compare is uppercase); the de-dup tail uses a stable normalize (trim + collapse whitespace + lowercase) so trailing-fragment echoes of the same question collapse to one key.
2. Strip leading/trailing markdown emphasis and punctuation before comparing.

## Trigger-Gate State Machine (orchestrator — `triggerAnswerIfNeeded`)

```
addConversationTurn(speaker, text)
        │
        ├─ triggerAnalysisIfNeeded()          ← UNTOUCHED (summary lane, 5-turn)
        │
        └─ triggerAnswerIfNeeded(speaker, text)   ← NEW
                 │
   ┌─────────────┴───────────── Gate 1: speaker.toLowerCase() === 'them'? ── no ─▶ return
   │                                                yes
   │             ┌───────────── Gate 2: isLikelyQuestion(text)? ─────────── no ─▶ return
   │             │                                  yes
   │             │   ┌───────── Gate 3: same normalized tail as lastAnsweredTail? ─ yes ─▶ return (de-dup)
   │             │   │                              no
   │             │   │   ┌───── Gate 4: inFlight?
   │             │   │   │         ├─ yes + genuinely new tail ─▶ abort inFlightController, fall through
   │             │   │   │         └─ yes + same question      ─▶ return (suppress)
   │             │   │   │              no
   │             │   │   └──▶ (re)set answerDebounceTimer(800 ms), resetting on each new them: turn
   │             │   │                       │  (FR-005 optional min-interval guard checked here; default OFF)
   │             │   │                       ▼  after 800 ms quiet:
   │             │   │            debounce callback:
   │             │   │              ├─ BAIL if conversationHistory.length === 0   (FR-012 race guard)
   │             │   │              └─ makeLiveAnswer(conversationHistory)  → stream → emit live-answer-update
```

### `makeLiveAnswer` streaming sequence
```
1. recent = formatConversationForPrompt(conversationHistory, 30)
2. systemPrompt = getSystemPrompt('pickle_glass_analysis','',false)
                    .replace('{{CONVERSATION_HISTORY}}', recent)
3. messages = [ {system}, {user: "Answer the interviewer's (them:) most recent
                question directly… else reply exactly: PASSIVE"} ]   (FR-007)
4. modelInfo = await getCurrentModelInfo('llm'); guard !modelInfo||!apiKey → throw  (C1/FR-008)
5. inFlightController = new AbortController(); inFlight = true; hadFallback = false
6. llm = createStreamingLLM(provider, {apiKey, model, temperature:0.7, maxTokens:900,
                usePortkey: provider==='openai-glass',
                portkeyVirtualKey: provider==='openai-glass'?apiKey:undefined})   (C1/FR-008)
7. reader = (await llm.streamChat(messages)).body.getReader()
8. buffer prefix until first '\n' or ~16 chars → parseAnswerOrPassive(prefix)   (C2/FR-010)
     ├─ passive → suppress: emit nothing, HOLD last answer, clear inFlight, return  (Q1/G3)
     └─ else → flush prefix, then per delta:
           SSE loop (mirror askService:416-446):
             [DONE] → finalize
             _reset → discard accumulated, set hadFallback=true            (FR-009)
             _final_model → record model
             choices[0].delta.content → append, emit live-answer-update {answer, ts}
9. on done: lastAnsweredTail = normalized tail of the answered question; inFlight = false
   on AbortError (signal.aborted) → swallow (expected), HOLD last answer    (FR-009)
   on other error → console.error, retain rendered, clear inFlight
```

## Locked Tuning Defaults (from spec Clarifications — DELEGATED, user-approved)

| Knob | Value | FR | Notes |
|------|-------|----|----|
| Answer-lane debounce | **800 ms** (bounded ~600 ms–1 s) | FR-003/C3 | Compounds with the 2 s upstream STT debounce. |
| `maxTokens` | **900** | FR-008 | Per-call cost bound. |
| `temperature` | **0.7** | FR-008 | Parity with summary/ask lanes. |
| Min-interval guard | **OFF** (configurable) | FR-005 | Talkative-interviewer cost cap; disabled for v1. |
| PASSIVE prefix-buffer | first newline or **~16 chars** | FR-010 | Decide suppress-vs-render early. |
| Conversation maxTurns | **30** | FR-006 | `formatConversationForPrompt` default. |
| Heuristic openers | what/how/why/when/where/which/who/can/could/would/do/does/did/is/are/tell me/walk me/describe/explain | FR-002 | Case-insensitive; `?`-tail also qualifies. |

## Validation Rules

- Speaker MUST be `them` (lowercased) to trigger — `me` never triggers (FR-001).
- A turn whose normalized tail equals `lastAnsweredTail` MUST NOT re-trigger (FR-004b).
- A stream MUST NOT start while one is in flight for the SAME question; a genuinely new question aborts-and-replaces (FR-004a).
- The debounce callback MUST bail if `conversationHistory` is empty (FR-012 race guard).
- A suppressed (PASSIVE) result MUST emit nothing and MUST hold the last rendered answer (FR-010/Q1) — never blank.
- The answer MUST be emitted only via `sendToRenderer` to the content-protected `listen` window (safety invariant).

## State Transitions (answer-lane lifecycle)

```
[idle] ──them: question + 4 gates pass──▶ [debouncing]
[debouncing] ──new them: turn──▶ [debouncing]   (timer reset)
[debouncing] ──800ms quiet, history non-empty──▶ [streaming]
[debouncing] ──resetConversationHistory()──▶ [idle]   (timer cleared)
[streaming] ──first prefix == PASSIVE──▶ [idle]   (suppress, hold last)
[streaming] ──genuinely new question──▶ [streaming]   (abort old, start new)
[streaming] ──[DONE]──▶ [idle]   (lastAnsweredTail set)
[streaming] ──resetConversationHistory() / close──▶ [idle]   (abort + clear)
```

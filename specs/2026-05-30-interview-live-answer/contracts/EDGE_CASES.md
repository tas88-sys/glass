# Contract Edge Cases — Interview Live Answer Lane

**Contract**: `./live-answer.contracts.d.ts`
**Validation**: `npx -p typescript tsc --noEmit --strict live-answer.contracts.d.ts` → **exit 0 (Found 0 errors)** ✅ (run 2026-05-31)

> **Note**: The contract is a declaration-only DESIGN artifact, not a build input. The repo is plain CommonJS JS with no `tsc` in its toolchain. The type-check above is a self-consistency gate on the shapes, per Phase 0.3.

This file enumerates the edge cases each contracted function/surface MUST handle, tied to the spec's Acceptance Scenarios (AS) and Edge Cases (EC). Each row becomes a `node:test` case (or a manual-verification step) in `/tasks`.

## `isLikelyQuestion(text)` — FR-002 (recall-maximal NON-question screen)

> **Design (recall-max — redesigned 2026-05-31 after live STT testing).** This is
> NOT a question detector. A keyword/opener list always leaves gaps — imperative
> prompts ("Design a cache", "Compare X and Y"), conjunction-led clauses ("okay so
> how…"), statement-form asks ("your biggest weakness"), and punctuation-less STT
> all slip through. So it is **inverted**: drop ONLY empty turns and pure
> acknowledgement/backchannel, and trigger on **everything else** — the model's
> `PASSIVE` reply suppresses non-questions (panel holds the last answer). A real
> question is therefore NEVER dropped. AS-3's "non-question → hold last answer" is
> now enforced by PASSIVE, not by this heuristic.

**Triggers (`true`) — every real question shape, plus anything substantive:**

| Input | Note |
|-------|------|
| `"Can you walk me through how a Go channel works?"` | explicit `?` |
| `"tell me about your experience"` | substantive (not backchannel) |
| `"describe your testing strategy."` | substantive |
| `"Give me an example of a deadlock"` | imperative prompt — no opener, no `?` |
| `"Design a rate limiter that handles bursts"` | imperative prompt |
| `"Compare TCP and UDP for this use case"` | imperative prompt |
| `"Walk us through your approach"` | imperative prompt |
| `"Okay so how does a hashmap work"` | opener after a conjunction/filler |
| `"Your biggest weakness"` | statement-form prompt |
| `"…what types can a map use as a key in Go? And this could…"` | `?` buried mid-utterance (live-observed) |
| `"Okay, great, let me share my screen"` | not backchannel → triggers; **PASSIVE suppresses** (AS-3) |
| `"Okay. Hold on one second. My dog is barking. Let me get settled."` | substantive monologue → triggers; PASSIVE suppresses |

**Drops (`false`) — ONLY empty turns + pure acknowledgement/backchannel:**

| Input | Why |
|-------|-----|
| `""`, `"   "` | nothing to answer |
| `"okay"`, `"Okay, great, thanks"` | pure acknowledgement |
| `"got it"`, `"got it, makes sense"` | backchannel |
| `"mm-hmm"`, `"yeah totally"`, `"sounds good"` | backchannel |
| `"cool, nice"`, `"sure, no problem"`, `"right, exactly"` | backchannel |

## `normalizePassive(text)` — FR-010

| Input | Expected | Why |
|-------|----------|-----|
| `"PASSIVE"` | `"PASSIVE"` | identity |
| `"PASSIVE."` | `"PASSIVE"` | strip trailing punctuation |
| `"**PASSIVE**"` | `"PASSIVE"` | strip markdown emphasis |
| `"  passive\n"` | `"PASSIVE"` | trim + uppercase |
| `"Not sure what you need help with right now"` | normalized native phrase | suppress signal (promptTemplates.js:388) |
| `"The answer is 42"` | `"THE ANSWER IS 42"` | real answer — not a suppress match |

## `parseAnswerOrPassive(prefix)` — FR-010

| Buffered prefix | `passive` | `flush` | Why |
|-----------------|-----------|---------|-----|
| `"PASSIVE"` | `true` | `""` | exact suppress |
| `"**PASSIVE**"` | `true` | `""` | markdown-wrapped suppress |
| `"Not sure what you need help"` (≥16 chars or newline reached) | `true` | `""` | native phrase prefix matches |
| `"A Go channel is a"` | `false` | `"A Go channel is a"` | real answer — flush + stream |
| `"PASS"` (still buffering, < 16 chars, no newline) | n/a | n/a | orchestrator keeps buffering until newline or ~16 chars before calling this |
| `""` | `false` | `""` | nothing yet |

> Boundary: the orchestrator decides WHEN to call `parseAnswerOrPassive` (first `\n` or ~16 chars). The function itself just classifies the prefix it is given.

## `shouldTriggerAnswer(speaker, text, lastAnsweredTail, inFlight)` — FR-001/FR-004

| speaker | text | lastAnsweredTail | inFlight | Expected | Why |
|---------|------|------------------|----------|----------|-----|
| `"Me"` | `"how does GC work?"` | `null` | `false` | `false` | mic gate (AS-2, FR-001) |
| `"Them"` | `"how does GC work?"` | `null` | `false` | `true` | eligible |
| `"them"` | `"okay great"` | `null` | `false` | `false` | not a question (FR-002) |
| `"Them"` | `"how does GC work?"` | normalized(`"how does GC work?"`) | `false` | `false` | de-dup, same tail (AS-6, FR-004b) |
| `"Them"` | `"how does GC work?"` (trailing fragment, same normalized tail) | same | `false` | `false` | echo suppression (AS-6) |
| `"Them"` | `"what about scaling?"` (NEW tail) | normalized(old) | `true` | `true` | new question → orchestrator aborts-and-replaces (AS-5, FR-004a) |
| `"Them"` | (same question as in-flight) | `null` | `true` | `false` | same-question-in-flight → suppress |

## Streaming / orchestrator edge cases (`makeLiveAnswer`) — FR-008/FR-009/FR-010

| Scenario | Expected behavior | Spec ref |
|----------|-------------------|----------|
| No model / no API key | throw caught by wrapper → `console.warn`, emit nothing, clear inFlight; panel keeps last answer | EC "No model configured", FR-008 |
| `_reset` sentinel mid-stream (Gemini failover) | discard accumulated answer, set `hadFallback=true`, keep reading | FR-009 |
| `_final_model` sentinel | record satisfying model; continue | FR-009 |
| `[DONE]` | finalize; set `lastAnsweredTail`; `inFlight=false` | FR-009 |
| Provider stream/network error (not abort) | `console.error`, retain rendered text, clear inFlight | Error registry |
| Deliberate abort (new question / close) | swallow `AbortError` (signal.aborted), hold last answer | FR-009, askService:452-454 |
| First prefix normalizes to `PASSIVE` | suppress: emit nothing, hold last answer, never blank | AS-3, FR-010, Q1 |
| Multi-segment question within debounce window | coalesce → exactly ONE call/stream | AS-4, FR-003 |

## Lifecycle / race edge cases — FR-011/FR-012

| Scenario | Expected behavior | Spec ref |
|----------|-------------------|----------|
| Stop pressed mid-stream | `resetLiveAnswer()` aborts controller + clears timer; no emit; no throw | AS-8, FR-011 |
| Stop pressed mid-debounce | timer cleared; callback never fires | AS-8, FR-011 |
| Late debounce timer fires after reset (window NOT destroyed) | callback bails on empty `conversationHistory`; no emit | EC "Empty transcript", FR-012 |
| Session start | `resetConversationHistory()` → `resetLiveAnswer()` clears all state | FR-011 |

## Renderer edge cases (`LiveAnswerView`) — FR-014/FR-015/FR-016

| Scenario | Expected behavior | Spec ref |
|----------|-------------------|----------|
| `marked`/`hljs`/`DOMPurify` not yet on `window` | render escaped plain text; upgrade to markdown once libs attach | EC "Markdown libraries not yet loaded", FR-015 |
| DOMPurify strips unsafe content | show `'⚠️ ' + plain text` (mirror SummaryView:390-393) | FR-015 |
| New answer begins (incl. abort-replace) | hold previous rendered markdown until first new token, then single `innerHTML` swap; never blank | Q1/G3, FR-015 |
| `resetAnswer()` on session reset | clear `liveAnswer`; panel empties only on explicit reset (not between answers) | FR-016 |
| `isVisible === false` (transcript mode) | hidden like `<summary-view>` | FR-014 |
| Long answer | scrolls within existing `insights-container` (no new scroll handling) | EC "Long answer" |

## Lane independence — FR-017

| Scenario | Expected behavior | Spec ref |
|----------|-------------------|----------|
| Answers stream on the answer lane | `summary-update` still fires on its own 5-turn cadence; `SummaryView` output unchanged | AS-7, FR-017 |
| `makeLiveAnswer`/`triggerAnswerIfNeeded` deleted | Live Insights behaves identically (no shared mutable state) | FR-017 |

## Safety invariant (load-bearing)

| Scenario | Expected behavior | Spec ref |
|----------|-------------------|----------|
| Answer emitted | ONLY via `sendToRenderer` to the content-protected `listen` window | Enforcement Strategy |
| Content protection | NEVER disabled; `windowManager.js` not edited | Enforcement Strategy |
| Logging | answer text NEVER logged to a capturable sink; only trigger/suppress/error events log | Enforcement Strategy |

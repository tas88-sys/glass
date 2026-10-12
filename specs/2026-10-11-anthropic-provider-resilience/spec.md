---
# Context Optimization Metadata
# Purpose: Enable efficient partial reads (~200 tokens vs ~2500 for full file)
meta:
  spec_id: 2026-10-11-anthropic-provider-resilience
  spec_name: anthropic-provider-resilience
  status: draft          # draft | in-progress | approved | completed
  phase: tasks           # specify | clarify | plan | tasks | preflight | feature-start | implement | verify
  created: 2026-10-11
  updated: 2026-10-11

# Quick Reference (for checkpoint resume)
summary:
  goals:
    - {id: G1, description: "Claude models work in every LLM lane (Ask, Live Answer, Live Insights). Today every Anthropic request fails before a model answers", priority: HIGH}
    - {id: G2, description: "The Anthropic path is as resilient as the Gemini path: ordered model list with cooldowns, failover on transient errors, timeouts that bound a stalled request, cancellation that stops the HTTP request, a short error the user can read, one log line per attempt", priority: HIGH}
    - {id: G3, description: "Gemini, OpenAI and Ollama behave exactly as today", priority: HIGH}
  constraints:
    - {id: C1, description: "The SSE protocol the consumers read (_reset, _final_model, [DONE], err.userMessage) is reused as is. askService.js, askStreamState.js and summaryService.js are not edited", type: TECHNICAL}
    - {id: C2, description: "gemini.js, gemini.test.js and geminiModelRotator.test.js are not edited. geminiModelRotator.js keeps every export and its behavior", type: SCOPE}
    - {id: C3, description: "Never log prompt or answer text (existing invariant). Logs carry model, outcome, status, timings, token counts and request id only", type: SECURITY}
    - {id: C4, description: "Every Anthropic API call goes through @anthropic-ai/sdk, key validation included. The SDK is upgraded from 0.56.0 to 0.133.0 as the first task, on its own, and must load and stream under Electron 30's Node 20.16 (research R10)", type: TECHNICAL}
    - {id: C5, description: "Never send a parameter the target model rejects: no temperature/top_p/top_k; output_config.effort only to models that accept it; fallbacks only to claude-opus-5-5 and claude-sonnet-5-5", type: TECHNICAL}
    - {id: C6, description: "Tests run under npm test (node:test, plain Node) with the SDK mocked. No live API call in the suite", type: TECHNICAL}
  decisions:
    - {id: D1, decision: "Same model-list contract as Gemini: the selected LLM model may be a comma-separated list of Claude IDs, tried in order with cooldowns", rationale: "The stored value already passes through modelStateService and the factory unchanged (gemini-failover spec, clarifications); users already know the Gemini CSV"}
    - {id: D2, decision: "Move the provider-neutral half of geminiModelRotator (parseModelList, pickModel, markFailed, markSucceeded, resetHealth) to modelHealth.js; geminiModelRotator re-exports it. Anthropic gets its own error classifier, anthropicErrors.js", rationale: "Those five functions never inspect an error, and model IDs of the two providers cannot collide, so one cooldown registry serves both. Gemini's exports and tests stay as they are (research R4)"}
    - {id: D3, decision: "The failover loop lives in anthropic.js, modelled on gemini.js: attempt loop, first-text timeout, request deadline, second round, cancellation, logs, sentinels. No hedged requests", rationale: "Hedging answers a Flash-Lite stall pattern and doubles cost (research R5). One engine for both providers is deferred until the Anthropic path has run in real sessions"}
    - {id: D4, decision: "The SDK never retries (maxRetries: 0); its timeout (time until response headers) is 15 s. The loop fails over at once, and when every model has failed fast it gives them one more round after 2 s, within the request deadline", rationale: "The SDK waits out the server's retry-after inside the attempt: up to 59 s and not cancellable in 0.56.0, with no cap in 0.133.0. That would hold a real-time answer hostage. With the waits in our loop, every wait is under our timers and behaves the same on any SDK version (research R12)"}
    - {id: D5, decision: "No sampling parameters. Thinking keeps each model's default; depth is set with output_config.effort (default low, ANTHROPIC_EFFORT overrides), sent only to models that accept it, and max_tokens has a floor of 4096 on those models", rationale: "claude-opus-5-5, claude-sonnet-5-5 and claude-haiku-5-5 reject a non-default temperature with a 400, and every lane passes 0.7. Thinking counts toward max_tokens, so Live Answer's 900 could end inside thinking with no text (research R6)"}
    - {id: D6, decision: "Read responses by block type (join the text blocks) and branch on stop_reason before using the text", rationale: "With thinking on, content[0] can be a thinking block; refusal and max_tokens arrive as HTTP 200 (research R6, R7)"}
    - {id: D7, decision: "Refusals: server-side fallbacks ('default' form, beta server-side-fallback-2026-07-01) on claude-opus-5-5 and claude-sonnet-5-5, on by default (ANTHROPIC_SERVER_FALLBACK=off disables); client-side failover to the next model in the list for every model", rationale: "Anthropic recommends opting in on these models; claude-haiku-5-5 has no server-side fallback, so the list covers it (research R7)"}
    - {id: D8, decision: "Key validation lists models (GET /v1/models, limit 1) through the SDK", rationale: "Free, names no model, so it cannot break the next time a model retires. Today's check calls a retired model (research R1, R9)"}
    - {id: D9, decision: "Presets become claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5. Any ID or list starting with 'claude-' maps to Anthropic and can be typed in Settings, as 'gemini-' does for Gemini", rationale: "The only preset today, claude-3-5-sonnet-20241022, retired on 2025-10-28; there is no way to pick a current model without a code change (research R1)"}
    - {id: D10, decision: "Timeouts: first text within 20 s (Haiku family) or 45 s (others); an answer must start within 60 s for the whole request; once text streams, 30 s without a stream event aborts the attempt. Each one has an env override", rationale: "Mirrors Gemini's first-chunk timeout and request deadline. The SDK's timeout stops counting when headers arrive, so a body that goes silent is otherwise unbounded (research R3)"}
    - {id: D11, decision: "Upgrade @anthropic-ai/sdk to ^0.133.0 as the first task, in its own commit, before any provider change; verified by loading it and streaming a canned response under Electron's Node 20.16", rationale: "User decision 2026-10-11. The rewrite and its fake SDK are then written against the version that ships: error type on every APIError (0.81.0), released abort listeners (0.73.0, 0.115.0), current models and parameters known to the SDK. No advisory against either version (research R10)"}

# CRITICAL REQUIREMENTS - Must verify during implementation
# These survive context compaction and generate T-VERIFY tasks
critical_requirements:
  type: feature-major    # bugfix | feature-minor | feature-major | config | documentation | refactoring
  portal: app            # superadmin | admin | app | public | none
  ui_changes: minor      # none | minor | moderate | major
---

# Feature Specification: Anthropic Provider Resilience

**Feature Branch**: `2026-10-11-anthropic-provider-resilience`
**Created**: 2026-10-11
**Status**: Draft
**Input**: User request (2026-10-11): "Analyze all the capabilities and features of the gemini.js provider file. Is anthropic.js as resilient as gemini.js? Bring up the differences and what could be implemented on the anthropic.js side to be even more prod ready. I want to start using the Anthropic models instead of Gemini. If changes are beneficial, create a plan following the specs folder pattern."

---

## System Context

**Systems**: Framework-internal. The Glass Electron main process: the AI factory and its providers, `modelStateService`, and the Settings view in the renderer.
**Databases**: None changed. The selected model is stored, as today, in `provider_settings.selected_llm_model` (one string, possibly a CSV).
**Integrations**: Anthropic Messages API through `@anthropic-ai/sdk`, already a dependency, upgraded from 0.56.0 to 0.133.0 by this spec (FR-023).
**Key Architecture**: Three lanes call the LLM through `src/features/common/ai/factory.js`. Ask streams (`askService.js:315`), Live Answer streams (`summaryService.js:380`, `maxTokens: 900`), and Live Insights calls `chat()` (`summaryService.js:813`, `maxTokens: 1024`). All three pass `temperature: 0.7`. Streaming providers return a `Response` whose body is SSE in the OpenAI delta shape, plus three control lines that Gemini introduced and the consumers already handle (`askStreamState.js:46-58`, `summaryService.js:270-271`): `_reset` (discard the partial answer, another model is being tried), `_final_model`, and `[DONE]`. An error raised through the stream may carry `userMessage`, which the consumers show instead of `message` (`askService.js:386`, `summaryService.js:650`).

`gemini.js` wraps this contract in a failover loop (research R2). `anthropic.js` has none of it, and it fails before reaching a model today (research R1).

---

## Clarifications

### Session 2026-10-11

- Q: Is `anthropic.js` as resilient as `gemini.js`? → A: No. It has no model list, no failover, no cooldowns, no timeouts of its own, no cancellation and no attempt logs. It also cannot work with current models at all: the only preset and the default are a retired model, every request sends a `temperature` the current models reject, and key validation calls a retired model. Details in research R1 and R2.
- Q: Should the failover engine be shared with Gemini? → A: Not in this spec. `anthropic.js` gets its own loop modelled on Gemini's, and only the cooldown registry is shared (D2, D3). Unifying the engines is follow-up work once the Anthropic path has run in real sessions.
- Q: Should the SDK be upgraded to the latest version? → A: Yes (user, 2026-10-11). It is the first task, on its own, before any provider change (D11, research R10).
- Q: Should the SDK retry inside an attempt? → A: No. Assessing the upgrade showed the SDK waits out `retry-after` inside the attempt, with a 59 s cap that cannot be cancelled in 0.56.0 and no cap in 0.133.0. Retries move into the loop: immediate failover, then one more round after 2 s (D4, research R12). Approved with the upgrade (user, 2026-10-11).

**Deferred (default chosen, not blocking)**:
- Which model list to use for interviews. Default: the presets are listed Opus 5.5, Sonnet 5.5, Haiku 5.5, and the user types the list in Settings. `quickstart.md` §1 lists the trade-offs.
- Effort per lane (Ask vs Live Answer vs Live Insights). Default: one effort for every lane, `low`, overridable with `ANTHROPIC_EFFORT`.

---

## User Scenarios & Testing *(mandatory)*

### Primary User Story
The user saves an Anthropic key and types `claude-haiku-5-5,claude-sonnet-5-5` as the Anthropic LLM model list in Settings. During a call, Live Answer streams answers from Claude Haiku 5.5. When Haiku returns 529 (overloaded), the panel shows "Trying claude-sonnet-5-5…", and the answer arrives from Sonnet. The log shows one line per attempt and a request summary. When the user asks a new question in Ask before the previous answer finishes, the previous HTTP request is aborted and stops generating tokens.

### Acceptance Scenarios
1. **Given** a valid Anthropic key, **When** the user saves it in Settings, **Then** it is accepted without calling any model, and an invalid key shows "Invalid Anthropic API key".
2. **Given** the model `claude-opus-5-5`, `claude-sonnet-5-5` or `claude-haiku-5-5`, **When** Ask, Live Answer or Live Insights runs, **Then** the request carries no `temperature`, and the answer text appears.
3. **Given** a list of two models and a 529 or 429 on the first, **When** a streaming request runs, **Then** the consumer receives one `_reset` naming the second model, the answer from the second, `_final_model` = second, and `[DONE]`. The first model is skipped by the next request until its cooldown ends.
4. **Given** the first model sends no text within its first-text timeout, **When** a streaming request runs, **Then** that attempt is aborted, `_reset` carries `reason: 'timeout'`, and the next model is tried with what is left of the 60 s deadline.
5. **Given** an error on a request that is wrong for every model (400, 401, 403), **When** it happens, **Then** no other model is tried and the error shows the model and the server's reason.
6. **Given** the consumer cancels the stream (new Ask question, Live Answer replaced), **When** a request is in flight or failover is waiting, **Then** the HTTP request is aborted, no other model is tried, and no stream error is raised.
7. **Given** a model with thinking on and a caller `maxTokens` of 900, **When** Live Answer runs, **Then** the request sends `max_tokens` ≥ 4096 and `output_config.effort` `low`.
8. **Given** every model in the list fails, **When** the request ends, **Then** the error's `userMessage` reads "All Claude models failed (N attempts). Last: <model> — <reason>".
9. **Given** the model typed in Settings is `claude-3-5-sonnet-20241022` (retired), **When** a request runs, **Then** it fails over if another model is listed, and otherwise the user sees "<model> is not available to this API key (retired or not enabled)…".
10. **Given** a single model that returns 529, **When** a streaming request runs, **Then** the SDK does not retry. The stream sends `_reset` with `reason: 'retry'`, waits 2 s, and tries the model once more. If that fails too, the error reads "All Claude models failed (2 attempts, 2 rounds) …".

### Edge Cases
- The model refuses (`stop_reason: refusal`) after partial text, with another model listed: `_reset` with `reason: 'refusal'`, and the next model answers. On the last model, the error names the refusal.
- A stream `error` event (overloaded) arrives after text started: treated like Gemini's mid-stream 503. `_reset`, then the next model.
- `stop_reason: max_tokens` with no text: a failure ("used its whole token budget before answering"). With text: success, logged `stop=max_tokens`.
- Server-side fallback switches models mid-answer: the text continues, `_final_model` names the model that finished, and no `_reset` is sent.
- The list mixes providers (`claude-sonnet-5-5,gemini-3-flash-preview`): rejected by the Settings validator, as Gemini's validator does today.
- The SDK aborts quietly: an aborted stream ends the iteration without throwing, so a timeout is detected from the attempt's own flag, not from an exception.

See `contracts/EDGE_CASES.md` for the full list.

## Requirements *(mandatory)*

### Functional Requirements

**Model selection and key**
- **FR-001**: `factory.js` MUST list `claude-opus-5-5`, `claude-sonnet-5-5` and `claude-haiku-5-5` as Anthropic LLM presets and no retired model. The default model in `anthropic.js` MUST be `claude-opus-5-5`.
- **FR-002**: A model ID or CSV whose first entry starts with `claude-` MUST map to the `anthropic` provider in `modelStateService.getProviderForModel` and in `SettingsView.getProviderForModel`. `getAvailableModels` MUST show a stored custom Anthropic value as "(custom)", as it does for Gemini.
- **FR-003**: Settings MUST offer an "Anthropic LLM Model ID" input under the Anthropic key, with the same CSV normalization as Gemini's (split on `,`, trim, drop empties) and a validator that rejects any entry not starting with `claude-`, naming the entry.
- **FR-004**: `AnthropicProvider.validateApiKey` MUST call `client.models.list({ limit: 1 })` through the SDK. 2xx means valid. 401 MUST return "Invalid Anthropic API key." Other statuses return the server's message. A network failure returns "A network error occurred during validation." The `sk-ant-` prefix check stays.

**Request building**
- **FR-005**: Requests MUST NOT carry `temperature`, `top_p` or `top_k`, whatever the caller passes.
- **FR-006**: `output_config.effort` MUST be sent only to models that accept it (Claude 5 family and later, `claude-opus-4-5` through `claude-opus-4-8`, `claude-sonnet-4-6`). Its value comes from `opts.effort`, else `ANTHROPIC_EFFORT`, else `low`. A value that is not one of `low|medium|high|xhigh|max` is ignored.
- **FR-007**: On those same models, `max_tokens` MUST be at least 4096 (`ANTHROPIC_MIN_MAX_TOKENS` overrides the floor). Without a caller value, the default is 16000 for streaming and 8192 otherwise.
- **FR-008**: Messages MUST map as today (system → `system`; text and `image_url` data URLs → `text` and base64 `image` blocks with the MIME type from the data URL), plus two fixes. Consecutive messages with the same role are merged into one (the API requires alternating roles). `generateContent(parts)` MUST NOT promote a string containing "You are" to the system prompt.
- **FR-009**: Requests to `claude-opus-5-5` and `claude-sonnet-5-5` MUST go through `client.beta.messages.create` with `betas: ['server-side-fallback-2026-07-01']` and `fallbacks: 'default'`, unless `ANTHROPIC_SERVER_FALLBACK=off`. No other model gets `fallbacks`. If the API rejects the beta (a 400 whose message names `anthropic-beta` or `fallbacks`), the provider MUST resend the same attempt once without it, stop sending it for the rest of the process, and log that once.

**Failover and stream**
- **FR-010**: Streaming and non-streaming calls MUST try the list in order through the shared health registry: skip a model in cooldown; when every model is cooling down, try the one that recovers first.
- **FR-011**: Errors MUST be classified by `anthropicErrors.classify(err)` into `transient`, `unavailable`, `refusal`, `fatal-request` or `fatal-auth` (table in `data-model.md`). `transient` cools the model down (retry-after, else 60 s, clamped 5 s–5 min) and fails over. `unavailable` cools it down for 5 min and fails over. `refusal` fails over without a cooldown. `fatal-*` ends the request at once.
- **FR-012**: Before moving to the next model, the stream MUST send `{ _reset: true, next_model, reason }`, where `reason` is one of `transient`, `timeout`, `unavailable` or `refusal`, or `retry` before a second round (FR-018). It is sent only when another attempt follows. On success the stream MUST send `{ _final_model }` and then `[DONE]`.
- **FR-013**: An attempt with no text after `firstTextTimeoutMs(model)` (20 s for the Haiku family, 45 s otherwise; `ANTHROPIC_FIRST_TEXT_TIMEOUT_MS` overrides) MUST be aborted and treated as transient with a 10 s cooldown. The whole request MUST stop trying new attempts once `requestDeadlineMs()` (60 s; `ANTHROPIC_REQUEST_DEADLINE_MS`, 0 disables) passes without an answer started. Each attempt's timeout is cut to what is left of it. An answer that is streaming is never cut by the deadline.
- **FR-014**: Once text streams, an attempt with no stream event for `idleTimeoutMs()` (30 s; `ANTHROPIC_IDLE_TIMEOUT_MS`, 0 disables) MUST be aborted and treated as transient.
- **FR-015**: On `message_stop`, the attempt MUST stop reading and close the connection. `stop_reason` from `message_delta` MUST be recorded. `refusal` is handled per FR-011. `max_tokens` with no text is a failure; with text it is a success.
- **FR-016**: A `fallback` content block (server-side fallback) MUST NOT trigger `_reset`. The model it switches to MUST be the one reported in `_final_model` and in the log.
- **FR-017**: Cancelling the returned stream MUST abort every in-flight SDK request through its `AbortSignal`, stop failover, and raise no stream error. Every enqueue MUST be guarded against a closed controller.
- **FR-018**: Every SDK call MUST pass `maxRetries: 0` and `timeout: 15000`. When every model of the first round has failed, the models whose failure was transient and fast MUST get one more round after 2 s, announced with `_reset` `reason: 'retry'`. "Fast" excludes timeouts, `unavailable`, `refusal`, and a 429 whose `retry-after` is longer than the 2 s wait. The round is skipped when the request deadline leaves less than the wait. Cancelling during the wait stops it, with no new attempt and no error.

**Errors and logs**
- **FR-019**: The error raised at the end MUST carry `userMessage`: `<model> — <reason>` for fatal errors; `All Claude models failed (<n> attempts[, 2 rounds]). Last: <model> — <reason>` when the list is exhausted; `No answer within <s> (<n> attempts). Last: …` when the deadline is hit; and for `unavailable`, `<model> is not available to this API key (retired or not enabled). Pick a current model in Settings.` Reasons are the server's message with SDK noise removed, at most 160 characters.
- **FR-020**: Each attempt MUST log one line, `[Anthropic Provider] attempt i/n <stream|once> model=… outcome=…`, with these fields when present: `status`, `ttft`, `last`, `total`, `chunks`, `stop`, `tokens=in:…,out:…,cache_read:…`, `fallback=<from>→<to>` and `request_id`. Each request MUST log a summary line `request … answered_by=… attempts=… total=…` and `cancelled` when cancelled. No log line contains prompt or answer text (C3).

**Non-streaming**
- **FR-021**: `chat()` and `generateContent()` MUST use the same list, classification, request building, second round and stop-reason rules. They MUST join the text blocks and return `_modelUsed`, as Gemini's `callWithFailover` does.

**SDK**
- **FR-023**: `package.json` MUST depend on `@anthropic-ai/sdk` `^0.133.0`, with the lockfile updated in the same commit. Under Electron's Node (`ELECTRON_RUN_AS_NODE=1`), the SDK MUST load with `require`, build a client, and stream a canned SSE response through a custom `fetch`. The existing suite MUST pass with only this change.

**Shared registry**
- **FR-022**: `modelHealth.js` MUST export `parseModelList`, `pickModel`, `markFailed`, `markSucceeded` and `resetHealth` with today's behavior. `geminiModelRotator.js` MUST re-export them and keep `classifyError` and `parseRetryAfter`. `geminiModelRotator.test.js` and `gemini.test.js` pass unchanged.

### Success Criteria
- **SC-001**: With a valid key, Ask (with a screenshot), Live Answer and Live Insights each return an answer on `claude-haiku-5-5`, `claude-sonnet-5-5` and `claude-opus-5-5` (manual, quickstart §3).
- **SC-002**: `npm test` passes, with the new Anthropic tests and the existing suite, including `gemini.test.js` and `geminiModelRotator.test.js` with no change to either file.
- **SC-003**: A scripted 529 on the first of two models gives exactly one `_reset`, the second model's text, `_final_model` set to the second model, and `[DONE]` (automated).
- **SC-004**: Cancelling the stream aborts the in-flight request's signal within one event-loop turn (automated).
- **SC-005**: No request body built by the provider contains `temperature`, `top_p` or `top_k` (automated, every model in the presets).
- **SC-006**: Time to first token for Live Answer on the chosen list is measured over 20 answers in a real session and recorded in `research.md` (p50, p95). This is a report, not a gate. It informs the default list.

### Key Entities *(include if feature involves data)*
- **Model list**: the stored `selected_llm_model` string, parsed by `parseModelList`.
- **Health entry**: `{ cooldownUntil }` per model ID in the shared registry.
- **Error kind**: output of `anthropicErrors.classify`.
- **Attempt stats**: what one attempt records for its log line.
- **Request params**: the body the provider sends, built by a pure function.

See `data-model.md`.

### External Dependencies & Risk Assessment *(mandatory)*

| Dependency | Type | Risk Level | Quota/Limits | Fallback Behavior |
|------------|------|------------|--------------|-------------------|
| Anthropic Messages API | SDK/HTTP streaming | MED | Per-model rate limits (429); overloads (529); safety refusals (HTTP 200) | Next model in the list, then one more round; clear `userMessage` when all fail |
| `@anthropic-ai/sdk` 0.56.0 → 0.133.0 | Library upgrade (0.x, 77 minor versions) | MED | Runtime JS 0.2 → 1.3 MB; two new dependencies | Upgrade lands alone and is checked under Electron's Node first (FR-023); revert is one commit (research R10) |
| Server-side fallback beta (`server-side-fallback-2026-07-01`) | API beta | LOW | Opus 5.5 and Sonnet 5.5 on the Claude API only | `ANTHROPIC_SERVER_FALLBACK=off`; client-side failover still applies |

**HIGH-RISK Dependency Checklist**:
- [x] Quota-limited, paid API → mocked in every test; the manual checks in `quickstart.md` cost a few cents and need the user's key.
- [x] Retirements → key validation no longer names a model; `unavailable` errors tell the user to pick a current model.

### Test Strategy *(mandatory)*

The provider is tested the way `gemini.test.js` tests Gemini: `Module._load` intercepts `@anthropic-ai/sdk` and returns a fake client whose `messages.create` / `beta.messages.create` replay scripted event sequences and errors, and record the params and the signal they received. Classification and request building are pure and table-tested.

**Test Type Classification**:
| FR | Primary Test Type | Reason |
|----|-------------------|--------|
| FR-001, FR-002 | Unit | Presets and prefix mapping (pure factory helper) |
| FR-003 | Manual | Settings view (renderer) |
| FR-004 | Unit (mocked SDK) | 200, 401, network error |
| FR-005–FR-009 | Unit (table) | `buildRequest` per model |
| FR-010–FR-018 | Integration (mocked SDK stream) | Failover, sentinels, timeouts, cancel, retries options |
| FR-011 | Unit (table) | `classify` over SDK error shapes |
| FR-019, FR-020 | Integration | `userMessage` text, log lines, no text in logs |
| FR-021 | Integration (mocked SDK) | Non-streaming failover and text join |
| FR-022 | Existing tests | Rotator tests pass unchanged |
| FR-023 | Smoke (Electron's Node) + existing suite | The upgrade alone, before any provider change |
| SC-001, SC-006 | Manual (live key) | Real API |

**Distribution Estimate**:
- Feature type: [x] Backend logic with a small settings UI change
- Unit: ~45% | Integration: ~45% | Contract: 0% | E2E/Manual: ~10%

**HIGH-RISK API Warning**:
- [x] Feature calls a quota-limited API → the suite never calls it; manual checks only, with the user's approval.

**Estimated Test Count**: ~50–60 test cases across 5 new test files.

### Error Handling & Recovery *(mandatory if feature can fail)*

**Error Scenarios**:
| Error Scenario | Type | User Message | Recovery Action |
|----------------|------|--------------|-----------------|
| 429 rate limit | Transient | "Trying <next>…" during failover; on the last model "All Claude models failed … rate_limit" | Cooldown from `retry-after`, next model; second round only if `retry-after` ≤ 2 s |
| 529 overloaded / 5xx / network | Transient | "Trying <next>…" | Next model; one more round after 2 s |
| Stream `error` event after text | Transient | Partial discarded, "Trying <next>…" | Next model |
| No text before first-text timeout | Transient | "Trying <next>…" / "No answer within 60s …" | Next model, 10 s cooldown |
| 404 model not available | Unavailable | "<model> is not available to this API key …" | 5 min cooldown, next model |
| `stop_reason: refusal` | Refusal | "Trying <next>…" / "<model> declined to answer" | Next model, no cooldown |
| 400 / 413 / 422 | Fatal request | "<model> — <server reason>" | None (bug or bad input) |
| 401 / 403 / 402 | Fatal auth | "<model> — <server reason>" | None (fix key or billing) |
| Consumer cancels | Expected | None | Abort in-flight request, stop |

**Error/Rescue Registry**:
| Method/Codepath | What Can Go Wrong | Exception Class | Rescued? | Rescue Action | User Sees |
|-----------------|-------------------|-----------------|----------|---------------|-----------|
| `streamChat` attempt | API error before stream | `Anthropic.APIError` subclasses | Y | Classify → failover or surface | `_reset` or `userMessage` |
| `streamChat` attempt | `error` event mid-stream | `APIError` (status undefined) | Y | Classify by `error.error.type` | `_reset` or `userMessage` |
| `streamChat` attempt | Our timeout | Quiet SDK abort (no throw) | Y | Detected by attempt flag | `_reset` or `userMessage` |
| `chat` / `generateContent` | same as above | same | Y | Same classification | thrown error with `userMessage` |
| `validateApiKey` | 401 / network | `AuthenticationError` / `APIConnectionError` | Y | `{ success: false, error }` | Settings message |

**Failure Modes Registry**:
| Codepath | Failure Mode | Rescued? | Test? | User Sees? | Logged? |
|----------|-------------|----------|-------|------------|---------|
| stream attempt | transient | Y | Y | retrying status | attempt line |
| stream attempt | timeout | Y | Y | retrying status | attempt line |
| stream attempt | refusal | Y | Y | retrying status / error | attempt line |
| stream | all models fail | Y | Y | `userMessage` | attempt + request lines |
| stream | cancel | Y | Y | nothing | request line `cancelled` |

*No row has Rescued=N.*

**Multi-Phase Operations**: None. Each request is independent; the registry only holds cooldown timestamps in memory.

### UI/Design Reference *(mandatory)*

**Feature Classification**:
- [x] **Minor UI** (< 3 components, existing patterns only)

**Design Reference**:
- Settings (`src/ui/settings/SettingsView.js`, provider key list around `:1338`): an "Anthropic LLM Model ID" text input, help line and "Save Anthropic Models" button under the Anthropic key, copying the Gemini block (no STT input: Anthropic has no STT). The Ask and Live Answer views are unchanged; they already show "Trying <model>…" and the answering model.

### Permissions & Access Control *(mandatory)*

**Portal Placement**: [x] Application Portal (local Electron app).
**User Roles Affected**: [x] Local desktop user (single actor).
**Data Scoping**: [x] User-scoped. Prompts, transcript excerpts and screenshots go to Anthropic when the user selects an Anthropic model, the same data path Gemini uses today. The API key stays in the local settings DB.

### Architecture Context *(mandatory if feature has business logic)*

```
src/features/common/ai/
  factory.js                 EDIT  presets; inferProviderFromModelId('claude-…' | 'gemini-…')
  __tests__/factory.test.js  NEW
  providers/
    modelHealth.js           NEW   parseModelList, pickModel, markFailed, markSucceeded, resetHealth
    geminiModelRotator.js    EDIT  re-exports modelHealth; keeps classifyError, parseRetryAfter
    anthropicErrors.js       NEW   classify, retryAfterMs, shortErrorMessage, refusal/unavailable errors
    anthropic.js             REWRITE  validateApiKey (models.list), buildRequest (pure),
                                      createLLM (failover), createStreamingLLM (failover stream)
    __tests__/anthropic.test.js, anthropicErrors.test.js, anthropicRequest.test.js,
              modelHealth.test.js                                   NEW
package.json, package-lock.json                     EDIT  @anthropic-ai/sdk ^0.133.0 (first task, own commit)
src/features/common/services/modelStateService.js   EDIT  claude- prefix (via factory helper), custom list
src/ui/settings/SettingsView.js                     EDIT  Anthropic model input + validator
docs/…                                              EDIT  provider docs and diagrams (T-DOC-GATE)
```

---

## Out of Scope / Future Work

- One failover engine shared by Gemini and Anthropic. Revisit once the Anthropic attempt logs from real sessions are in.
- Hedged requests for Anthropic. Add them only if the logs show requests that are accepted and then stall.
- Trimming the SDK's source maps and TypeScript sources from the installer (about 15 MB uncompressed of the 18 MB package).
- Prompt caching. Every lane puts the changing transcript inside the system prompt, so the cached prefix would change on every call. It needs a prompt builder change first.
- Per-lane model list and per-lane effort.
- Speech-to-text: Anthropic has none. STT stays on Gemini, Deepgram, OpenAI or Whisper.
- Amazon Bedrock, Google Vertex AI and Microsoft Foundry endpoints.

---

## Review Checklist (Gate)

- [x] No [NEEDS CLARIFICATION] markers remain (session 2026-10-11; three items deferred with defaults)
- [x] Requirements are testable
- [x] Test strategy defined (mocked SDK, pure tables, manual live checks)
- [x] Portal placement selected
- [x] Permissions defined (single local user)
- [x] Data sensitivity classified (same data path as Gemini)
- [x] External APIs identified (Anthropic Messages API, one beta)
- [x] Error handling defined
- [x] UI complexity classified (Minor)
- [x] Deprecation decision made: the retired preset is removed; nothing else deprecated
- [ ] Bug evidence captured: N/A (`feature-major`), though R1 documents why the current file cannot work

---

## Next Steps

- The user picks the model list for interviews (quickstart §1) and approves the plan.
- Implementation starts at T005 (SDK upgrade, alone), then T010 (tests first). Manual checks (T-VERIFY-MANUAL) need the user's key and a live session.

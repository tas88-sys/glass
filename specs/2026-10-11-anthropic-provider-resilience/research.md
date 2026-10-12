# Phase 0 Research: Anthropic Provider Resilience

**Spec**: `2026-10-11-anthropic-provider-resilience`
**Date**: 2026-10-11

Findings come from reading the repo, the installed SDK (`node_modules/@anthropic-ai/sdk`, 0.56.0), the latest SDK package (0.133.0, unpacked from npm for reading only: changelog and source), and Anthropic's model and error reference (cached 2026-10-06). Nothing here was checked against the live API; the live checks are T-VERIFY-MANUAL. 0.133.0 was run in T005 (the Electron load test) and, with the finished provider, against a local fake API (R13).

---

## R1: Why `anthropic.js` cannot work today

**Finding**: Every Anthropic path fails before a current model answers. There are four independent causes.

| # | Cause | Evidence | Effect |
|---|-------|----------|--------|
| 1 | Key validation calls a retired model | `anthropic.js:18` sends `claude-3-haiku-20240307` (deprecated, retirement date 2026-04-19, now past). `anthropic.js:24` accepts only `ok` or `400` | A retired model returns `404 not_found_error`, which this check reads as a bad key, so a valid key cannot be saved |
| 2 | The only preset and the default are retired | `factory.js:56` and `anthropic.js:71,198`: `claude-3-5-sonnet-20241022`, retired 2025-10-28 | 404 on every request |
| 3 | No way to choose another model | `modelStateService.js:307` and `SettingsView.js:962` map only `gemini-` IDs to a provider; `getAvailableModels` accepts custom IDs only for Gemini (`modelStateService.js:363`) | A current Claude ID cannot be selected without a code change |
| 4 | `temperature` sent on every request | `anthropic.js:107,174,269`. Every lane passes 0.7 (`askService.js:318`, `summaryService.js:383,816`) | `claude-opus-5-5` has no sampling parameters; `claude-sonnet-5-5` and `claude-haiku-5-5` reject any non-default value. All three return 400 |

Two more defects show up once those are fixed:
- `response.content[0].text` (`anthropic.js:114,180`). On current models thinking is on by default, so `content[0]` can be a `thinking` block. `chat()` would then return `undefined`, and Live Insights would parse `undefined`.
- The stream has no `cancel()` and no `AbortSignal` (`anthropic.js:257-308`). When Ask or Live Answer cancels the reader, the HTTP request keeps generating (and billing) until the model finishes. The next `controller.enqueue` then throws `ERR_INVALID_STATE`, which the catch logs as a "Streaming error". Gemini guards against this (`gemini.js:669-675`).

---

## R2: What `gemini.js` does (capability inventory)

| # | Capability | Where | What it buys |
|---|-----------|-------|--------------|
| 1 | Ordered model list (CSV) | `parseModelList`, `createLLM`/`createStreamingLLM` | Several models per lane, tried in priority order |
| 2 | Health registry with cooldowns | `geminiModelRotator.js` (`pickModel`, `markFailed`, `markSucceeded`) | A failing model is skipped by later requests for `retry-after` (else 60 s, clamped 5 s–5 min); when all are cooling, the one that recovers first is tried anyway |
| 3 | Three-tier error classification | `classifyError`: status → `errorDetails` reason → message heuristics; unknown = transient (fail-open) | 429/5xx/network fail over; 400 and 401/403 surface at once |
| 4 | `retry-after` parsing | `parseRetryAfter`: `RetryInfo.retryDelay`, then the header (seconds or HTTP date) | The cooldown follows the server's own hint |
| 5 | Non-streaming failover | `callWithFailover` | `chat()` and `generateContent()` fail over and return `_modelUsed` |
| 6 | Streaming failover with `_reset` | `streamChat` loop, `_reset {next_model, reason}` | The UI discards a partial answer and shows "Trying <model>…" |
| 7 | First-chunk timeout per model | `firstChunkTimeoutMs`: 25 s for Lite, 60 s otherwise; env override | A request that was accepted and then went silent is abandoned |
| 8 | Hedged request | `raceFirstChunk`: Flash-Lite only, a second parallel request after 10 s; first chunk wins | Covers Flash-Lite's per-request stalls |
| 9 | Request deadline | 60 s until an answer starts; attempts cut to what is left; env override | The user never waits more than about a minute for nothing |
| 10 | Second round | When all models fail fast (not 429, not timeout), wait 3 s and retry them once, `_reset reason: 'retry'` | Rides out brief 503 bursts |
| 11 | Short timeout cooldown | 10 s after a first-chunk timeout instead of 60 s | A stall is per request, not per model |
| 12 | Finish-reason close | Stop reading at `finishReason` | Does not wait seconds for the server to close the connection |
| 13 | Cancellation | `ReadableStream.cancel()` aborts every in-flight request and the wait between rounds; `track()` | Abandoned answers stop billing; no failover after the user moved on |
| 14 | Safe enqueue | `safeEnqueue` checks `desiredSize` and catches | No `ERR_INVALID_STATE` after cancel |
| 15 | Unhandled-rejection guard | `result.response?.catch?.(() => {})` | The SDK's unused aggregate promise cannot crash the process |
| 16 | Diagnostics | `logAttempt` (model, outcome, status, hedge, ttft, last, total, chunks, finish, tokens incl. thoughts), `logRequest` | Failover cost is visible without logging text |
| 17 | User-facing errors | `userMessage` on the stream error: fatal, all failed, deadline | Ask and Live Answer show a short reason |
| 18 | `_final_model` | Sent before `[DONE]` | The UI shows which model answered |
| 19 | Key validation without spending tokens | `GET /v1beta/models` | Validation does not depend on a model |
| 20 | Tests | `gemini.test.js` (~45 cases), `geminiModelRotator.test.js` | Every behavior above is pinned |

Gemini-specific behavior that does not transfer: the plain-text system-instruction rewrite (`responseMimeType`, stripping "JSON" phrases) and the hard-coded `image/png` MIME type.

`anthropic.js` has rows 19 (with a broken model, R1) and part of 6 (it sends `[DONE]`), and nothing else.

---

## R3: What the SDK (0.56.0) already does

Read in `node_modules/@anthropic-ai/sdk`:

- **Retries** (`client.js:350-370`): 408, 409, 429 and every 5xx (so 529 too), plus connection errors. An `x-should-retry` header overrides the status. `maxRetries` defaults to 2.
- **Backoff** (`client.js:372-411`): `retry-after-ms`, then `retry-after` (seconds or HTTP date), used only when it is under 60 s. Otherwise 0.5 s × 2ⁿ, at most 8 s, with up to 25% jitter.
- **Timeout** (`client.js:324-348`): the default is 10 min, and it covers only `fetch` until the response headers arrive. On a stream the headers come at once, so **a stream body that goes silent is not bounded by the SDK**.
- **Stream errors** (`core/streaming.js:62-63`): an SSE `error` event (for example `overloaded_error` after text started) is thrown as `APIError` with `status` undefined and the body in `err.error` (`{type: 'error', error: {type, message}}`). It is **not retried**.
- **Pings** (`core/streaming.js:59-60`): `ping` events are swallowed and never reach the caller. An idle timer can see only content events.
- **Abort**: `options.signal` aborts the fetch and the body. An abort ends the async iteration **without throwing** (`isAbortError` → return), so a timeout we trigger must be detected from our own flag.
- **Request id**: `APIError.requestID` from the `request-id` header (`core/error.js:14`).

**Consequence**: Mid-stream errors, silent streams and cancellation are ours to handle (D3, D10, FR-014, FR-017). The SDK's own retries look like Gemini's second round, but they wait inside the attempt for as long as the server's `retry-after` asks, so the plan turns them off (R12).

What changes in 0.133.0 for the points above (read in the unpacked package):
- Same retry statuses and the same quiet return on abort (`core/streaming.js`, `client.js:708-741`).
- The stream `error` event now sets `err.type` from the body (`core/streaming.js:122-125`), and every `APIError` carries `type` (0.81.0).
- The wait before a retry can be cancelled through `signal` (0.126.0), and the 60 s cap on `retry-after` is gone (`client.js:744-772`; see R12).

---

## R4: Share the cooldown registry or copy it?

**Decision**: Move `parseModelList`, `pickModel`, `markFailed`, `markSucceeded` and `resetHealth` to `modelHealth.js`. `geminiModelRotator.js` re-exports them.

**Evidence**: Those functions never inspect an error. The registry is keyed by model ID, and `gemini-…` and `claude-…` IDs cannot collide. `geminiModelRotator.test.js` imports the rotator and calls its exports; re-exported functions satisfy it unchanged, and `resetHealth` clears the one shared map.

**Alternatives considered**: Import the Gemini rotator from `anthropic.js` (misleading name, couples the providers). Copy the 60 lines (two registries, two places to fix).

---

## R5: Which Gemini behaviors to port

| Gemini capability (R2 #) | Port? | Reason |
|-----------------------|-------|--------|
| 1–6, 9, 10, 12–14, 16–18 | Yes | Provider-neutral; the consumers already depend on 6, 17, 18 |
| 7 First-chunk timeout | Yes, as first-**text** timeout | Anthropic sends `message_start` at once, so "first chunk" says nothing; the first `text_delta` means the answer started. Haiku family 20 s (thinks little at `low`), others 45 s |
| 8 Hedging | No | Built for a Flash-Lite stall pattern; doubles cost; no evidence of the same pattern on Anthropic |
| 10 Second round | Yes, with a 2 s wait | Replaces the SDK's retries, which wait inside the attempt (R12). A 429 joins the round only when its `retry-after` fits in the wait |
| 11 Short timeout cooldown | Yes | Same reasoning |
| 15 Rejection guard | Not needed | We iterate the stream directly; there is no unused aggregate promise |
| New: idle timeout | Yes | R3: nothing bounds a silent body once text started |
| New: SDK retries off | Yes | `maxRetries: 0` on every call, so every wait is under our timers (D4, R12) |

---

## R6: Thinking, effort, sampling and `max_tokens` on current models

From Anthropic's model reference:
- **Sampling**: `claude-opus-5-5` has no `temperature`/`top_p`/`top_k` (400). `claude-sonnet-5-5` and `claude-haiku-5-5` accept only defaults (`temperature` 1); any other value returns 400. Older 4.x models accept them. **Decision**: never send them (D5). Prompts already shape the output.
- **Thinking**: `claude-opus-5-5` thinks always; `disabled` returns 400. On `claude-sonnet-5-5` and `claude-haiku-5-5`, thinking is on by default. Anthropic's advice for less thinking is a lower effort, not `disabled`. **Decision**: leave `thinking` unset everywhere.
- **Effort**: `output_config.effort` (`low` … `max`). The default is `medium` on Opus 5.5 and Haiku 5.5 and `high` on Sonnet 5.5. It returns an error on Haiku 4.5 and Sonnet 4.5. **Decision**: send `low` by default, only to models that accept it (FR-006). Every Glass lane has someone waiting on the answer.
- **`max_tokens`**: thinking tokens count toward it. A small cap can end with `stop_reason: max_tokens` after a thinking block and before any text. Live Answer passes 900. **Decision**: floor 4096 on thinking-capable models (FR-007). Answer length stays a prompt instruction, as today.
- **Thinking display** defaults to omitted. Thinking blocks stream with empty text, so the wait before the first text is silent apart from pings. The first-text timeout must allow for it (R5).

---

## R7: Refusals and server-side fallback

- On current models a policy decline is HTTP 200 with `stop_reason: refusal`, before any output or mid-stream. Anthropic's guidance is to discard partial output in that case.
- **Server-side fallback** (beta): `fallbacks: 'default'` with `anthropic-beta: server-side-fallback-2026-07-01`. On a decline the API runs a fallback model inside the same request. On a stream, a `fallback` content block marks the switch and the text continues. Anthropic recommends opting in by default for `claude-opus-5-5` and `claude-sonnet-5-5`. `claude-haiku-5-5` has no server-side fallback (a list returns 400).
- **Decision**: opt in on Opus 5.5 and Sonnet 5.5 (D7, FR-009), with `ANTHROPIC_SERVER_FALLBACK=off` to disable. A final `refusal` (any model) is a per-model failure, and the next model in the list is tried (FR-011).
- **Risk**: the beta is newer than SDK 0.56.0. Both versions send `betas` as the `anthropic-beta` header and pass `fallbacks` in the body (0.56.0: `resources/beta/messages/messages.js:28-43`); 0.133.0 also types it (changelog 0.115.0: "add server-side fallbacks default option"). T-VERIFY-MANUAL confirms it against the live API.

---

## R8: Error taxonomy

Applying Gemini's `classifyError` to Anthropic errors would give the wrong answer in three places:

| Anthropic error | Gemini `classifyError` | Right handling |
|-----------------|-------------------------|----------------|
| 529 `overloaded_error` | Not in its status list; falls through to fail-open `transient` | `transient` (explicitly) |
| 404 `not_found_error` (retired or not enabled for the key) | fail-open `transient`, 60 s cooldown | `unavailable`: 5 min cooldown, a message that tells the user to pick another model |
| Stream `error` event (`status` undefined) | fail-open `transient` (right by accident) | `transient` by `err.error.error.type` (`overloaded_error`, `api_error`, `rate_limit_error`) |
| 402 `billing_error` | fail-open `transient` | `fatal-auth` |
| 413 `request_too_large` | fail-open `transient` | `fatal-request` |

**Decision**: a separate `anthropicErrors.classify` (FR-011, table in `data-model.md`). Unknown errors stay fail-open `transient`, as in Gemini.

---

## R9: Key validation

**Decision**: `client.models.list({ limit: 1 })` (`resources/models.js:32`). `GET /v1/models` costs nothing and names no model. The SDK raises `AuthenticationError` on 401 and `APIConnectionError` on network failure. This replaces today's raw `fetch` (C4).

---

## R10: Upgrade the SDK from 0.56.0 to 0.133.0?

**Decision**: Yes, as the first task, alone in its own commit, before any provider change (D11, FR-023). User decision 2026-10-11.

**Not required**: 0.56.0 would work. `messages.create` posts the body as given (`resources/messages/messages.js:16-29`), so `output_config` reaches the API although 0.56.0 does not type it. `beta.messages.create` turns `betas` into the `anthropic-beta` header (`resources/beta/messages/messages.js:28-43`). `models.list` exists. We read raw stream events, so new block types (`thinking` with empty text, `fallback`) need no SDK support.

**Why upgrade anyway** (changelog of 0.133.0, released 2026-10-09):

| Version | Change | Use here |
|---------|--------|----------|
| 0.73.0, 0.115.0 | Abort-signal listeners released when requests settle; no more leaks | Every attempt passes a signal (FR-017) |
| 0.81.0 | `type` on every `APIError`; set from the body on stream `error` events | Simpler, sturdier `classify` (data-model) |
| 0.126.0 | The wait before a retry stops as soon as the request is aborted | Moot with `maxRetries: 0` (R12), but removes a trap if retries are ever turned back on |
| 0.103.0 – 0.133.0 | Current models, `output_config`, `fallbacks` (0.115.0), `stop_details`, refusal categories; warnings for deprecated models | Editor hints only (plain JS), plus a runtime warning when a deprecated model is named |
| 77 minor versions | Staying this far behind makes every later change harder | — |

**Costs and checks**:
- **Size**: runtime `.js` goes from 0.2 MB to 1.3 MB, and the package from 3 MB to 18 MB on disk (source maps, typings and TypeScript sources). Two new dependencies arrive. `standardwebhooks` is loaded with the beta namespace at client construction (`resources/beta/beta.js:18` → `webhooks.js:5`). `json-schema-to-ts` is not required by any runtime `.js`; it serves the typings. `zod` is an optional peer and is not needed. Trimming the extra files from the installer is out of scope.
- **Breaking changes**: possible in any 0.x release. The removals in the changelog (retired model types in 0.116.0 and earlier, `OutputFormat` exports in 0.72.1, `betas` deprecated on GA methods in 0.129.0) do not touch what Glass uses: the client constructor, `messages.create({stream})`, `beta.messages.create`, `models.list`, and the error classes. `require('@anthropic-ai/sdk').Anthropic` is still exported (`index.js:6`), and the package is still `type: commonjs`.
- **Node 20.16 (Electron 30.5.1)**: a search of the runtime `.js` for Node 22+ APIs found only `promiseWithResolvers`, which is the SDK's own fallback for `Promise.withResolvers`. The package declares no `engines`. A load test under Electron's Node is still required (FR-023, T005).
- **Security**: `npm audit` (2026-10-11) reports no advisory against `@anthropic-ai/sdk` or its new dependencies.
- **Rollback**: one commit (`package.json` + lockfile).

---

## R11: Latency for Live Answer

There are no measurements yet. What is known: Live Answer streams with `maxTokens: 900` and needs the first words fast. Haiku is Anthropic's model for latency-sensitive work. At `low` effort the model may skip thinking on simple requests. SC-006 measures time to first token over 20 real answers, and the default list is chosen from that. Until then, `quickstart.md` §1 describes the trade-off and leaves the choice to the user.

---

## R12: Where do retries live?

**Decision**: In the loop, not the SDK. Every SDK call passes `maxRetries: 0`. A transient failure moves to the next model at once. When every model has failed, the ones that failed fast get one more round after 2 s, within the request deadline (D4, FR-018).

**Evidence**: The SDK retries inside the attempt and first waits for what the server's `retry-after` (or `retry-after-ms`) asks:
- **0.56.0** (`client.js:372-400`): it honours values under 60 s and uses its own backoff above that. The wait is a plain `setTimeout` (`internal/utils/sleep.js:5`), so aborting the request does not end it. A 429 with `retry-after: 40` holds the attempt 40 s, and our first-text timer cannot cut it short.
- **0.133.0** (`client.js:744-772`): it honours any value a timer can hold (up to about 24 days). The wait now ends on abort (0.126.0), but without our own abort it lasts as long as the server says.

For a real-time answer, the right reaction to "retry in 40 s" is to try another model now, not to wait inside this one.

**Rules for the second round** (same shape as Gemini's `retryableNextRound`, `gemini.js:211-215`):
- Joins: transient HTTP and stream errors (5xx, 529, network), and a 429 whose `retry-after` is at most the 2 s wait.
- Stays out: timeouts (they already cost 20–45 s), `unavailable`, `refusal`, and a 429 with a longer `retry-after`.
- Skipped when the deadline leaves less than the wait. Announced with `_reset` `reason: 'retry'`. A cancel during the wait stops it.
- The wait is 2 s, where Gemini's is 3 s: the SDK's default first backoff is 0.5–1 s, and Live Answer is latency-bound.

**Alternative considered**: keep SDK retries at 1 or 2 per attempt (the first draft of D4). Rejected for the reason above. It also made the behavior depend on the SDK version.

---

## R13: Non-streaming calls and the SDK timeout (found in implementation)

**Finding**: The SDK's `timeout` covers only the wait for response headers (R3). A non-streaming Messages response sends its headers when the whole answer is written. With `timeout: 15000` (FR-018), any `chat()` call that thinks and writes for longer than 15 s would end in `APIConnectionTimeoutError`, fail over, and probably time out again. Live Insights calls `chat()` with thinking on.

**Decision**: Every Messages call streams (D12).
- `chat()` and `generateContent()` run the same loop as `streamChat` (`runWithFailover`) and join the text deltas.
- A failed attempt's partial text is dropped before the next attempt.
- They keep their return shapes, plus `_modelUsed`, and they get the first-text, idle and deadline timeouts too.
- `buildRequest` takes `mode` (`stream` | `once`) instead of `stream`. It picks only the default `max_tokens` (16000 or 8192), and `params.stream` is always `true`.

**Alternative considered**: A longer SDK timeout for non-streaming calls (60 s or more). That is one more number to tune, and a stalled call would still hold Live Insights for the whole wait with no sign of progress.

**Also settled in implementation**:
- **429 in the second round.** A 429 joins the second round only when the server's own retry hint is at most the 2 s wait. `retryAfterMs` clamps to at least 5 s for cooldowns, so the rule reads the unclamped header through `retryAfterHeaderMs`. A 429 without the header stays out, as Gemini's do.
- **Request ids.** Every attempt reads the request id through `withResponse()`, so timeouts and successes log `request_id` too, not only errors.
- **Real SDK check.** The provider was run with the real SDK 0.133.0 against a local HTTP server that played the Messages API, under Node 24.17 and under Electron 30.5.1 (Node 20.16). Checked:
  - failover on a 529, with exactly one call per model, so the SDK did not retry;
  - the beta header and `fallbacks` on Sonnet 5.5;
  - the connection closed by the client after `message_stop`;
  - cancel closing the HTTP connection;
  - `chat()` failover and text join;
  - `models.list` validation;
  - request ids in the logs, with no answer text.

---

## Summary of Decisions

| # | Decision |
|---|----------|
| R1 | Fix the four blockers (validation, presets, prefix mapping, sampling) before any resilience work |
| R2 | 20 Gemini capabilities inventoried; Anthropic has about 1.5 of them |
| R3 | Mid-stream errors, silent streams and cancellation are ours; the SDK's retries wait inside the attempt |
| R4 | Shared `modelHealth.js`; Gemini re-exports it |
| R5 | Port everything except hedging; add idle timeout; SDK retries off |
| R6 | No sampling params; effort `low` where accepted; `max_tokens` floor 4096 |
| R7 | Server-side fallback on Opus/Sonnet 5.5; client-side failover on refusal for all |
| R8 | Own error classifier with an `unavailable` kind |
| R9 | Validate with `models.list` |
| R10 | Upgrade the SDK to 0.133.0 first, alone, with a load test under Electron's Node |
| R11 | Measure TTFT in a real session before choosing the default list |
| R12 | `maxRetries: 0`; immediate failover, then one more round after 2 s within the deadline |
| R13 | Every call streams, the non-streaming lanes included; a 429 joins round 2 only on its unclamped `retry-after` |

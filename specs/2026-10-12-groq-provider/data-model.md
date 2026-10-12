# Phase 1 Data Model: Groq Provider

**Spec**: `2026-10-12-groq-provider`
**Date**: 2026-10-12

## Overview

There are no database changes.
- A `groq` row in `provider_settings` needs no migration: the provider column is free text.
- The model list is the existing `selected_llm_model` string.
- The health registry and attempt stats live in memory in the main process.

Types are formalized in `contracts/groq-provider.contracts.d.ts`.

## Entities

### Model list (stored, unchanged column)

| Field | Type | Notes |
|-------|------|-------|
| `provider_settings.selected_llm_model` | string | One ID or a CSV, such as `openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b`. Settings normalizes it (trim, drop empties), and `parseModelList` parses it. The first entry decides the provider: `vendor/model` → `groq` (after presets and installed Ollama models). |

### Model traits (`groq.js`, static table)

| Match | `reasoning` | `vision` | `maxOutput` |
|-------|-------------|----------|-------------|
| `openai/gpt-oss-…` (incl. `-safeguard-`) | `gpt-oss` | false | 65,536 |
| `qwen/qwen3.8-27b` | `qwen3` | **true** | 16,384 |
| other `qwen/qwen3…` | `qwen3` | false | none |
| anything else | `null` | false | none |

Unknown models get no reasoning fields and no images. This is the safe default: a field the model does not know returns 400.

### Health entry (`modelHealth.js`, shared, unchanged)

| Field | Type | Notes |
|-------|------|-------|
| key | model ID | `openai/…`, `qwen/…` never collide with `claude-…` or `gemini-…` |
| `cooldownUntil` | epoch ms | Present ⇔ cooling down; `markSucceeded` deletes the entry |

Cooldowns used by the Groq provider:

| Kind | Cooldown |
|------|----------|
| `transient` (HTTP or stream error) | `retryAfterMs(err)`: `retry-after-ms`, then `retry-after` (seconds or HTTP date), else 60 s; clamped 5 s – 5 min |
| `transient` (first-text or idle timeout, `EMPTY_MAX_TOKENS`, `STREAM_ERROR`, HTTP 422) | 10 s |
| `unavailable` | 5 min |
| `too-large` | none: the next, smaller request may fit |

### Error kind (`groqErrors.classify(err)`)

Read order:
1. Our own codes.
2. The Groq error `code` from the body. That is `err.error.error.code` for HTTP errors (the SDK keeps the whole body) and `err.error.code` for stream errors (the SDK keeps the inner object). `errorBody(err)` returns whichever is present.
3. HTTP `status`.
4. The body `type`.
5. The SDK class.
6. Fail-open.

| Input | Kind |
|-------|------|
| `code: 'FIRST_TEXT_TIMEOUT'`, `'IDLE_TIMEOUT'`, `'EMPTY_MAX_TOKENS'`, `'STREAM_ERROR'` | `transient` |
| body code starting `model_` (`model_not_found`, `model_decommissioned`, model permission codes) | `unavailable`, whatever the status |
| status 413 | `too-large` |
| status 404 | `unavailable` |
| status 408, 409, 422, 429, 498, and ≥ 500 | `transient` |
| status 400, 424 | `fatal-request` |
| status 401, 403 | `fatal-auth` |
| status undefined, body code or type `rate_limit_exceeded`, `server_error`, `service_unavailable`, `overloaded`, `internal_error` | `transient` |
| status undefined, body type `invalid_request_error` | `fatal-request` |
| `APIConnectionError` / `APIConnectionTimeoutError` | `transient` |
| anything else | `transient` (fail-open) |

Helpers:
- **`shortErrorMessage(err)`**: the body's `message` if present. Otherwise `err.message` with a leading `NNN ` and a JSON envelope removed (the SDK formats HTTP errors as `"<status> {json}"`). At most 160 characters.
- **`tooLargeNumbers(err)`**: `{ limit, requested }` parsed from `Limit (\d+), Requested (\d+)` in the server message, else `null`.
- **`retryAfterHeaderMs(err)`**: the server's hint, unclamped, or `null`.
- **`retryAfterMs(err)`**: that hint, else 60 s, clamped to 5 s – 5 min.
- **`errorCode(err)`**: the body code, for the log.

### Request params (`buildRequest`, pure)

Input: `{ modelId, messages, maxTokens?, temperature?, effort?, mode, env }`.
Output: `{ params, imagesSent, imagesDropped }`.

| Field | Rule |
|-------|------|
| `model` | `modelId` |
| `messages` | Glass messages mapped (table below); roles and order kept |
| `stream` | Always `true`: `chat()` and `generateContent()` stream internally too |
| `max_completion_tokens` | `maxTokens` → `GROQ_MAX_TOKENS` → 2048; plus `GROQ_REASONING_TOKENS` (1024) when the model reasons at the resolved effort; capped at `maxOutput` |
| `temperature` | Caller value when finite and in [0, 2]; else omitted |
| `reasoning_effort` | `gpt-oss`: `effort` → `GROQ_REASONING_EFFORT` → `low`, one of `low|medium|high`. `qwen3`: same sources → `none`, one of `none|default|low|medium|high`. Otherwise omitted. Invalid values are ignored |
| `include_reasoning` | `false` for `gpt-oss`; otherwise omitted |
| `reasoning_format` | `'hidden'` for `qwen3` when effort ≠ `none`; otherwise omitted |
| `max_tokens`, `top_p`, `logprobs`, `logit_bias`, `top_logprobs`, `n`, `stream_options`, `service_tier`, `tools`, `response_format`, `messages[].name` | Never |

"Reasons at the resolved effort": always for `gpt-oss`, and for `qwen3` when the effort is not `none`.

Content mapping:

| Glass part | Chat-completions part |
|------------|-----------------------|
| `string` (non-empty) | message `content` string (a message with only strings stays a string) |
| `{ type: 'text', text }` (non-empty) | `{ type: 'text', text }` |
| `{ type: 'image_url', image_url: { url } }` | kept as is when `vision`, at most 3 per request; otherwise dropped and counted |
| `{ inlineData: { mimeType, data } }` (`generateContent`) | `{ type: 'image_url', image_url: { url: 'data:<mimeType or image/jpeg>;base64,<data>' } }`, same vision rule |
| empty text, `null`, unknown | dropped |

A message whose content ends up empty is dropped.

### Attempt order (`orderForImages`, pure)

| Request | Order |
|---------|-------|
| No image part | the list as given |
| At least one image part | the models with `vision` (list order), then the rest (list order) |

### SDK call options (every chat-completions and models call)

| Option | Value | Why |
|--------|-------|-----|
| `maxRetries` | `0` | The SDK would wait out `retry-after` inside the attempt, uncancellable, uncapped (research R4) |
| `timeout` | `15000` | Time until response headers only; the body is bounded by our timers |
| `signal` | the attempt's `AbortController.signal` | Cancel, first-text, idle and deadline aborts |

### Rounds

| Field | Value |
|-------|-------|
| `MAX_ROUNDS` | 2 |
| `RETRY_ROUND_DELAY_MS` | 2000 (`opts.retryRoundDelayMs` overrides, for tests) |
| Joins round 2 | Kind `transient` from an HTTP or stream error that is not 422 and has no provider code. A 429 (or a stream `rate_limit_exceeded`) joins only when `retryAfterHeaderMs(err)` ≤ the delay |
| Stays out | Timeouts, `EMPTY_MAX_TOKENS`, `STREAM_ERROR`, 422, `unavailable`, `too-large`, a 429 with a longer `retry-after` or none |
| Skipped | When no model joins, or the request deadline leaves ≤ the delay |
| Announced | `_reset` with `reason: 'retry'` and `next_model` = first model of the round |

### Attempt stats (one per attempt, for the log line)

| Field | Set when |
|-------|----------|
| `startedAt` | attempt starts |
| `firstTextAt`, `lastTextAt`, `chunks` | content deltas arrive (the idle timer restarts on every chunk once text started) |
| `finishReason` | first chunk with `choices[0].finish_reason` |
| `usage` | `x_groq.usage`, else `chunk.usage` (prompt, completion, reasoning, cached, `queue_time`) |
| `servedBy` | `chunk.model` |
| `requestId` | `x_groq.id`, else the `x-request-id` response header |
| `tpmLeft` | `x-ratelimit-remaining-tokens` response header |
| `imagesSent`, `imagesDropped`, `effort` | from `buildRequest` |
| `streamError` | `x_groq.error` (logged as `outcome=transient`, the string is not logged; it may echo content) |
| `timedOut` | first-text or idle timer fired |
| `aborted` | consumer cancelled or stopped reading |

### Stream protocol (unchanged, C1)

| Line | When |
|------|------|
| `data: {"choices":[{"delta":{"content":"…"}}]}` | each content delta |
| `data: {"_reset":true,"next_model":"…","reason":"transient|timeout|unavailable|too-large|retry"}` | before the next attempt, only if one follows |
| `data: {"_final_model":"…"}` | after a successful attempt |
| `data: [DONE]` | last line on success |
| stream error with `userMessage` | fatal error, list exhausted, or deadline |

## State transitions (one streaming request)

```
start ──► order list (images?) ──► pick model ──► attempt
attempt ──text…finish_reason──► success ──► _final_model, [DONE], close
attempt ──transient/timeout/unavailable/too-large──► markFailed? ──► models left and deadline not hit? ──► _reset ──► pick model
                                                                         └─ no ──► round 1 and fast failures and time for the wait?
                                                                                     ├─ yes ──► _reset(retry) ──► wait 2 s ──► round 2
                                                                                     └─ no ──► error(userMessage)
attempt ──fatal-request/fatal-auth──► error(userMessage)
any state ──consumer cancel──► abort in-flight, log "cancelled", end (no error)
```

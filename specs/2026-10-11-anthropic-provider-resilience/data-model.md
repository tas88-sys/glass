# Phase 1 Data Model: Anthropic Provider Resilience

**Spec**: `2026-10-11-anthropic-provider-resilience`
**Date**: 2026-10-11

## Overview

There are no database changes. The model list is the existing `selected_llm_model` string. The health registry and attempt stats live in memory in the main process. Types are formalized in `contracts/anthropic-provider.contracts.d.ts`.

## Entities

### Model list (stored, unchanged column)

| Field | Type | Notes |
|-------|------|-------|
| `provider_settings.selected_llm_model` | string | One ID or a CSV, such as `claude-haiku-5-5,claude-sonnet-5-5`. Normalized by Settings (trim, drop empties). Parsed by `parseModelList`. The first entry decides the provider (`claude-` → `anthropic`). |

### Health entry (`modelHealth.js`, shared by Gemini and Anthropic)

| Field | Type | Notes |
|-------|------|-------|
| key | model ID | `gemini-…` and `claude-…` never collide |
| `cooldownUntil` | epoch ms | Present ⇔ cooling down; `markSucceeded` deletes the entry |

Cooldowns used by the Anthropic provider:

| Kind | Cooldown |
|------|----------|
| `transient` (HTTP or stream error) | `retryAfterMs(err)` → `retry-after-ms`, then `retry-after` (seconds or HTTP date), else 60 s; clamped 5 s – 5 min |
| `transient` (first-text or idle timeout, or `max_tokens` reached with no text) | 10 s |
| `unavailable` | 5 min |
| `refusal` | none (the next request may use the same model) |

### Error kind (`anthropicErrors.classify(err)`)

Inspection order: our own codes → HTTP `status` → error type (`err.type`, which SDK 0.81.0 and later set on every `APIError`, including stream `error` events; else `err.error.error.type`) → SDK class → fail-open.

| Input | Kind |
|-------|------|
| `code: 'FIRST_TEXT_TIMEOUT'` or `'IDLE_TIMEOUT'` | `transient` |
| `code: 'REFUSAL'` | `refusal` |
| `code: 'EMPTY_MAX_TOKENS'` (stopped at `max_tokens` with no text) | `transient` |
| status 408, 409, 429, 500, 502, 503, 504, 529 | `transient` |
| status 404 | `unavailable` |
| status 400, 413, 422 | `fatal-request` |
| status 401, 402, 403 | `fatal-auth` |
| status undefined, type in `overloaded_error`, `api_error`, `rate_limit_error`, `timeout_error` | `transient` |
| status undefined, type = `invalid_request_error` | `fatal-request` |
| `APIConnectionError` / `APIConnectionTimeoutError` | `transient` |
| anything else | `transient` (fail-open, as Gemini) |

`shortErrorMessage(err)`: `err.error.error.message` if present, else `err.message` with the leading status and any JSON envelope removed; at most 160 characters.

### Request params (`buildRequest`, pure)

Input: `{ modelId, messages, maxTokens?, effort?, stream, env }`. Output: `{ method: 'messages' | 'beta', params }`.

| Field | Rule |
|-------|------|
| `model` | `modelId` |
| `system` | Text of the `system` message(s), joined with a blank line; omitted when empty |
| `messages` | Non-system messages mapped to Anthropic blocks; consecutive same-role messages merged |
| `max_tokens` | Caller value, else 16000 (stream) or 8192; raised to the floor (4096, `ANTHROPIC_MIN_MAX_TOKENS`) when `acceptsEffort(modelId)` |
| `output_config.effort` | Only when `acceptsEffort(modelId)`. `effort` → `ANTHROPIC_EFFORT` → `low`; invalid values ignored |
| `temperature`, `top_p`, `top_k` | Never |
| `thinking` | Never (model default) |
| `stream` | `true` for `streamChat` |
| `betas`, `fallbacks` | `['server-side-fallback-2026-07-01']`, `'default'` when `modelId` is `claude-opus-5-5` or `claude-sonnet-5-5` and `ANTHROPIC_SERVER_FALLBACK` ≠ `off`; then `method` is `beta` |

`acceptsEffort(modelId)`: the family number after `claude-(fable|mythos|opus|sonnet|haiku)-` is ≥ 5, or the ID is `claude-opus-4-5` … `claude-opus-4-8` or `claude-sonnet-4-6` (any suffix).

Content mapping:

| Glass part | Anthropic block |
|------------|-----------------|
| `string` | `{ type: 'text', text }` |
| `{ type: 'text', text }` | `{ type: 'text', text }` |
| `{ type: 'image_url', image_url: { url: 'data:<mime>;base64,<b64>' } }` | `{ type: 'image', source: { type: 'base64', media_type: <mime or image/jpeg>, data: <b64> } }` |
| `{ inlineData: { mimeType, data } }` (`generateContent`) | `{ type: 'image', source: { type: 'base64', media_type: mimeType, data } }` |

### SDK call options (every Messages and Models call)

| Option | Value | Why |
|--------|-------|-----|
| `maxRetries` | `0` | The SDK would wait out `retry-after` inside the attempt (research R12) |
| `timeout` | `15000` | Time until response headers only; the body is bounded by our timers |
| `signal` | the attempt's `AbortController.signal` | Cancel, first-text, idle and deadline aborts |

### Rounds

| Field | Value |
|-------|-------|
| `MAX_ROUNDS` | 2 |
| `RETRY_ROUND_DELAY_MS` | 2000 (`opts.retryRoundDelayMs` overrides, for tests) |
| Joins round 2 | Kind `transient` from an HTTP or stream error (not a timeout, not `EMPTY_MAX_TOKENS`); a 429 only when `retryAfterMs(err)` ≤ the delay |
| Stays out | Timeouts, `EMPTY_MAX_TOKENS`, `unavailable`, `refusal`, a 429 with a longer `retry-after` |
| Skipped | When no model joins, or the request deadline leaves ≤ the delay |
| Announced | `_reset` with `reason: 'retry'` and `next_model` = first model of the round |

### Attempt stats (one per attempt, for the log line)

| Field | Set when |
|-------|----------|
| `startedAt` | attempt starts |
| `firstTextAt`, `lastEventAt`, `chunks` | text deltas arrive |
| `stopReason` | `message_delta.delta.stop_reason` |
| `usage` | `message_start.message.usage` (input, cache) merged with `message_delta.usage` (output) |
| `servedBy` | `message_start.message.model`, replaced by `fallback` block `to.model` |
| `fallbackFrom` | `fallback` block `from.model` |
| `timedOut` | first-text or idle timer fired |
| `aborted` | consumer cancelled or stopped reading |
| `requestId` | `err.requestID` on errors |

### Stream protocol (unchanged, C1)

| Line | When |
|------|------|
| `data: {"choices":[{"delta":{"content":"…"}}]}` | each `text_delta` |
| `data: {"_reset":true,"next_model":"…","reason":"transient|timeout|unavailable|refusal|retry"}` | before the next attempt, only if one follows (`retry` = second round) |
| `data: {"_final_model":"…"}` | after a successful attempt (the model that finished, after any server-side fallback) |
| `data: [DONE]` | last line on success |
| stream error with `userMessage` | fatal error, list exhausted, or deadline |

## State transitions (one streaming request)

```
start ──► pick model ──► attempt
attempt ──text…message_stop──► success ──► _final_model, [DONE], close
attempt ──transient/timeout/unavailable/refusal──► markFailed? ──► models left and deadline not hit? ──► _reset ──► pick model
                                                                         └─ no ──► round 1 and fast failures and time for the wait?
                                                                                     ├─ yes ──► _reset(retry) ──► wait 2 s ──► round 2
                                                                                     └─ no ──► error(userMessage)
attempt ──fatal-request/fatal-auth──► error(userMessage)
any state ──consumer cancel──► abort in-flight, log "cancelled", end (no error)
```

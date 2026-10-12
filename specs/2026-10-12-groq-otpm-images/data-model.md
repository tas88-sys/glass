# Phase 1 Data Model: Groq Output Limit and Screenshots

**Spec**: `2026-10-12-groq-otpm-images`
**Date**: 2026-10-12

## Overview

There are no database or settings changes. What changes is one constant, one error kind, the shape of one helper's result, one per-request option and two log fields. Types are formalized in `contracts/groq-otpm-images.contracts.d.ts`.

## Entities

### Groq request cap (`groq.js`, `completionBudget`)

`max_completion_tokens` = the caller's cap, else `GROQ_MAX_TOKENS`, else `DEFAULT_MAX_TOKENS`. A model that reasons gets the reasoning allowance on top (`GROQ_REASONING_TOKENS`, default 1,024). The total is capped at the model's maximum.

| Caller | Cap passed | Before | After |
|--------|-----------|--------|-------|
| Ask (any mode) | none | 2,048 on Qwen at `none`; 3,072 on gpt-oss | **16,384** on Qwen; **17,408** on gpt-oss |
| Live Answer | 900 | 900 / 1,924 | unchanged |
| Live Insights | 1,024 | 1,024 / 2,048 | unchanged |
| An unknown model, no cap | none | 2,048 | 16,384 |

Model maximums: gpt-oss 65,536; `qwen/qwen3.8-27b` 16,384; unknown models no cap.

### Error kind `too-large` (`groqErrors.classify`)

| Trigger | Before | After |
|---------|--------|-------|
| 413 "Request too large … (TPM): Limit L, Requested R" | too-large | too-large |
| 429 "Request too large … (OTPM): Limit L, Requested R" | transient (60 s cooldown, or the retry hint) | **too-large** |
| 429 "Rate limit reached … Limit L, Used U, Requested R" | transient | transient |
| 429 with no message | transient | transient |

A `too-large` failure has no cooldown, does not join the second round, and resets with `reason: 'too-large'`.

### `tooLargeNumbers` result

| Field | Type | Notes |
|-------|------|-------|
| `limit` | number | L, from "Limit L, Requested R" |
| `requested` | number | R, Groq's own figure: for OTPM it is the expected output, not the declared cap |
| `output` | boolean | **new**: true when the message says "(OTPM)" |

`null` when the message has no adjacent "Limit L, Requested R" (a rate-limit message has "Used" between them).

### `visionOnly` (per request)

| Where | Type | Notes |
|-------|------|-------|
| `providerChain.decideTurn` → segment options | `true` or absent | Set when the request has an image and a later segment whose provider has a key sees images |
| `groq.createLLM` / `createStreamingLLM` → `runWithFailover` | boolean, optional | With an image: keep only the models whose `modelTraits().vision` is true. Without an image: ignored |
| `gemini.js`, `anthropic.js` | — | Ignored (every model sees images) |

`visionOnly` is never sent to an SDK.

### Provider error `NO_VISION_MODEL`

| Field | Value |
|-------|-------|
| `code` | `'NO_VISION_MODEL'` |
| `message` | `no model in the list sees images` |
| `userMessage` | `No Groq model in the list sees images.` |

Thrown by `runWithFailover` before any request, when `visionOnly` and an image leave no model. The chain logs the segment as failed and moves on.

### Attempt log fields (`logAttempt`)

| Field | When | Example |
|-------|------|---------|
| `limit=L requested=R` | the error carries "Limit L, Requested R" (413 TPM or 429 OTPM) | `limit=1000 requested=1168` |

Existing fields are unchanged. `error=` stays cut at 160 characters.

### Messages (`describeFailure`, too-large)

| Case | `userMessage` part |
|------|--------------------|
| OTPM (`output: true`) | `MODEL — asks for up to R output tokens; this key allows L per minute.` |
| TPM | `MODEL — request needs R tokens; this key allows L per minute. This request alone is over the limit: shorten the context or use a higher Groq tier.` (unchanged) |
| no numbers | `MODEL — <server message>` (unchanged) |

## Routing of an Ask with a screenshot

The list is `gpt-oss-120b, gpt-oss-20b, qwen3.8-27b` (Groq), then Gemini.

| Groq segment | Later segment with a key that sees images | `visionOnly` | Qwen | Who answers | Image |
|--------------|-------------------------------------------|--------------|------|-------------|-------|
| has Qwen | yes (Gemini) | true | accepts | Qwen | sent |
| has Qwen | yes (Gemini) | true | refused (OTPM) or fails | Gemini (after `_reset reason: 'provider'`) | sent |
| has Qwen | no (Groq only, or Gemini without a key) | absent | refused | gpt-oss | **dropped** (as before) |
| no Qwen | — (Gemini runs first) | never set | — | Gemini; Groq only if Gemini fails | sent; dropped if Groq answers (as before) |

With an image, the chain runs the segments that see images first (`orderSegments`, unchanged). A Groq segment without Qwen does not see images, so it always comes after every segment that does, and no later segment can set `visionOnly` on it. `NO_VISION_MODEL` is therefore a guard for a direct caller of `groq.js` that passes `visionOnly`. Through the chain it is not reached.

## State

No state is kept between requests. A refused Qwen is not cooled down and is tried again on the next screenshot Ask (D7).

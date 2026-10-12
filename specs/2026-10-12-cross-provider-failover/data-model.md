# Phase 1 Data Model: Cross-Provider Failover

**Spec**: `2026-10-12-cross-provider-failover`
**Date**: 2026-10-12

## Overview

There are no database changes.
- The mixed list is the existing `selected_llm_model` string of the first entry's provider.
- Other providers' keys are read from their own `provider_settings` rows, as stored today.
- Segments, plans and the cooldown registry live in memory in the main process, per request (segments, plan) or per process (registry).

Types are formalized in `contracts/cross-provider-failover.contracts.d.ts`.

## Entities

### Model list (stored, unchanged column)

| Field | Type | Notes |
|-------|------|-------|
| `provider_settings.selected_llm_model` | string | One ID or a CSV that may name several providers, e.g. `openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b,gemini-3.5-flash-lite,gemini-3.1-flash-lite`. Stored in the row of the first entry's provider, which is the active LLM provider. Settings normalizes it (trim, drop empties). |

### Segment (`factory.splitByProvider`, per request)

| Field | Type | Notes |
|-------|------|-------|
| `provider` | `'anthropic' \| 'gemini' \| 'groq'` (or the active provider when splitting does not apply) | From `inferProviderFromModelId(id)`; an ID with none joins the current segment |
| `models` | string[] | Non-empty, in list order |

| List (active provider) | Result |
|------------------------|--------|
| `''` | `[]` |
| `a/x,a/y` (groq) | `[{groq,[a/x,a/y]}]` |
| `a/x,gemini-y` (groq) | `[{groq,[a/x]},{gemini,[gemini-y]}]` |
| `gemini-y,foo` (gemini) | `[{gemini,[gemini-y,foo]}]` |
| `a/x,gemini-y,b/z` (groq) | `[{groq,[a/x]},{gemini,[gemini-y]},{groq,[b/z]}]` |
| `gpt-4.1,gemini-y` (openai) | `[{openai,[gpt-4.1,gemini-y]}]`: splitting applies only to anthropic, gemini and groq |

A result with one segment (or none) takes today's path (FR-002).

### Keys map (`getCurrentModelInfo('llm').keys`)

| Field | Type | Notes |
|-------|------|-------|
| `keys[provider]` | string \| null | For every provider among the list's segments. The active provider's key comes from the active row; others from `providerSettingsRepository.getByProvider(p)` (decrypted). `null` when no row or no key |

The factory removes `keys` from the options before any provider call. Each segment gets `apiKey: keys[provider]` only. When `keys` does not name the active provider (a caller that does not pass `keys`), the active provider's key is `opts.apiKey`.

### Chain adapter (`providerChain.js`, static per provider)

| Provider | `createStreamingLLM` / `createLLM` | `requestDeadlineMs()` default | `seesImages(models)` | `firstModel(models, messages)` |
|----------|-----------------------------------|-------------------------------|----------------------|--------------------------------|
| `groq` | `providers/groq` | 45 s (`GROQ_REQUEST_DEADLINE_MS`) | some model has `modelTraits(id).vision` | `pickModel(orderForImages(models, messages))` |
| `gemini` | `providers/gemini` | 60 s (`GEMINI_REQUEST_DEADLINE_MS`) | true | `pickModel(models)` |
| `anthropic` | `providers/anthropic` | 60 s (`ANTHROPIC_REQUEST_DEADLINE_MS`) | true | `pickModel(models)` |

`requestDeadlineMs()` is each provider's exported function, so the provider's env override is respected. `null` (disabled) counts as no limit.

### Segment plan entry (`orderSegments`, `skipReason`, `segmentTiming`; per request, decided when the segment's turn comes)

| Field | Type | Notes |
|-------|------|-------|
| `segment` | Segment | |
| `skip` | `null \| 'no-key' \| 'cooling' \| 'deadline'` | Rules below |
| `requestDeadlineMs` | number \| undefined | Passed to the provider; omitted when no limit applies |

**Order.** When the request carries an image, image-capable segments first (stable), then the others. Otherwise list order.

**Skip rules**, applied in order when a segment's turn comes:
1. **`no-key`**: `keys[provider]` is empty.
2. **`cooling`**: every model of the segment `isCoolingDown`, and some later segment that is not `no-key` has a model that is not cooling down.
3. **`deadline`**: a later segment can still run, and the computed deadline (below) is ≤ 0.

**"A later segment can still run"**: some later segment is not `no-key`.

**Deadline** (no answer text forwarded yet; `left` = chain deadline − elapsed, or ∞ when the chain deadline is disabled):

| Case | `requestDeadlineMs` |
|------|---------------------|
| Later segment can run | `min(providerDeadline, left − 15 000)` |
| Last runnable segment | `min(providerDeadline, left)` |
| Answer text already forwarded | `providerDeadline` (the provider's own; option omitted) |
| Both infinite | omitted |

When `left ≤ 0` and no answer has started, no segment starts: the chain ends with the deadline message.

### Segment outcome (log only)

| Outcome | Meaning |
|---------|---------|
| `ok` | The segment's stream reached `[DONE]` (or its `chat`/`generateContent` resolved) |
| `failed` | Its stream errored, ended without `[DONE]`, or its call threw |
| `cancelled` | The consumer cancelled while it ran |
| `skipped-no-key` / `skipped-cooling` / `skipped-deadline` | Not called (skip rules) |

### Health entry (`modelHealth.js`, shared)

| Field | Type | Notes |
|-------|------|-------|
| key | model ID | `openai/…`, `qwen/…`, `gemini-…`, `claude-…` never collide |
| `cooldownUntil` | epoch ms | Present ⇔ cooling down until then |

New read-only query: `isCoolingDown(id)` ⇔ an entry exists and `cooldownUntil > Date.now()`. The providers keep writing the entries exactly as today.

## Stream protocol (consumer view)

```
segment 1 runs ──► its deltas, its _reset{reason: transient|timeout|…}, … ─┐
   fails ─────────► _reset{ next_model: <segment 2's first model>, reason: 'provider' }
segment 2 runs ──► its deltas … _final_model{<model that answered>} ──► [DONE]
```

Failure of every segment errors the stream with the last segment's error. Its `userMessage` follows FR-013.

## State transitions (one chain request)

```
          ┌──────────────── next segment ◄────────────────┐
          ▼                                                │
 [plan] ─► turn(i) ─► skip? ──yes──► log skipped-* ────────┤
                        │no                                 │
                        ▼                                   │
                 run segment i ──fails──► _reset(provider) ─┘ (if another can run)
                        │ok                     │none left / deadline
                        ▼                       ▼
              _final_model, [DONE]      error(userMessage FR-013)
 cancel at any point ──► cancel running reader ──► stop, no error
```

# Gemini Failover Design

Date: 2026-05-26
Status: Design (validated through `/workflow-brainstorm`)
Author: thiagosoeiro

## Problem

The Gemini API returns transient errors (429 rate limits, 503 overloads, 500/504, network timeouts) frequently enough to disrupt normal usage. Different models have different quotas and degradation patterns, so a single hardcoded model leaves the app at the mercy of whichever model is currently degraded.

Goal: when the configured Gemini model fails transiently, try the next model in a user-supplied priority list. Surface the actually-used model on every response. Do not change any behavior when the user only configures one model.

## Decisions (from brainstorm)

| Decision | Choice | Rationale |
|---|---|---|
| Rotation philosophy | Sticky primary + failover | Quality consistency over preemptive quota spread |
| Cooldown policy | Honor `Retry-After` header / `retryDelay` field; default 60s; clamp `[5s, 300s]` | Accurate when API tells us, sane fallback otherwise |
| STT strategy | Single model, no failover | STT is a persistent live session; rotation has no clean semantics there |
| Mid-stream error handling | Abandon partial output, restart from scratch with next model | Cleaner UX than splicing two model outputs together |
| Active-model display | Per-response footer (`answered by: <model>`) | Per-response provenance; no header clutter |

## Architecture

### Components

1. **`src/features/common/ai/providers/geminiModelRotator.js`** *(new)* — owns the in-memory health registry. Exports `pickModel(list)`, `markFailed(modelId, retryAfterMs)`, `markSucceeded(modelId)`, `classifyError(err)`, `parseRetryAfter(err)`, `parseModelList(csv)`.
2. **`src/features/common/ai/providers/gemini.js`** *(edit)* — `createLLM` and `createStreamingLLM` wrap their inner Gemini SDK calls in a failover loop driven by the rotator. `createSTT` reads only the first model.
3. **`src/features/settings/settingsService.js`** *(edit)* — CSV parsing/validation for `selectedLlmModel` when provider is `gemini`. Reject empty list. Trim entries. STT field strips after first comma.
4. **`src/ui/settings/SettingsView.js`** *(edit)* — help text under the Gemini LLM Model ID input.
5. **`src/features/ask/askService.js`** *(edit)* — extend the SSE consumer at line 407-432 to recognize two new JSON shapes inside `data:` payloads: `{ "_reset": true, "next_model": "..." }` and `{ "_final_model": "..." }`.
6. **Ask response UI** *(edit)* — render `_modelUsed` in a small footer below the response. (File TBD when wiring up; the renderer that consumes `state.currentResponse` is the touchpoint.)

### State

Lives in-memory in `geminiModelRotator.js`:

```js
// Map<modelId, { cooldownUntil: number /* epoch ms */, lastError?: string }>
const health = new Map();
```

No persistence. On app restart, all models start healthy. Cooldowns are short-lived (≤300s clamped) so this loses nothing meaningful across restarts.

### Selection algorithm

```js
function pickModel(modelList) {
  const now = Date.now();
  for (const id of modelList) {
    const entry = health.get(id);
    if (!entry || entry.cooldownUntil <= now) return id;
  }
  // All cooling down — pick soonest-recovering and try anyway.
  return modelList
    .map(id => ({ id, until: health.get(id)?.cooldownUntil ?? 0 }))
    .sort((a, b) => a.until - b.until)[0].id;
}
```

Sticky primary is implicit: the loop returns the *first* healthy model in declared order.

### Error classification

| Class | Triggers | Action |
|---|---|---|
| `transient` | HTTP 429, 500, 502, 503, 504; network/timeout errors; SDK error codes `RESOURCE_EXHAUSTED`, `UNAVAILABLE`, `DEADLINE_EXCEEDED` | Cooldown current model, try next |
| `fatal-request` | HTTP 400; SDK `INVALID_ARGUMENT` (bad model name, malformed payload) | Surface immediately — next model will also fail. This catches typos in the CSV. |
| `fatal-auth` | HTTP 401, 403; SDK `PERMISSION_DENIED`, `API_KEY_INVALID` | Surface immediately — API key is shared across models |

The Gemini SDK throws errors with `status`, `errorDetails`, and sometimes a wrapped HTTP `Response`. `classifyError` inspects these in order: explicit `status` code → `errorDetails[].@type` containing `ErrorInfo` → message-text heuristics as a last resort.

### Cooldown

`parseRetryAfter(err)` tries, in order:

1. `err.errorDetails?.find(d => d['@type']?.includes('RetryInfo'))?.retryDelay` — e.g. `"37s"` → 37000ms
2. HTTP `Retry-After` response header (seconds or HTTP-date format)
3. Default: 60000ms

Result is clamped to `[5000, 300000]` ms so a misconfigured backend can't lock the app out for an hour.

## Failover behavior

### Non-streaming LLM (`createLLM`)

```js
async function callWithFailover(modelList, doCall) {
  let remaining = [...modelList];
  let lastErr;
  while (remaining.length > 0) {
    const modelId = rotator.pickModel(remaining);
    try {
      const result = await doCall(modelId);
      rotator.markSucceeded(modelId);
      return { ...result, _modelUsed: modelId };
    } catch (err) {
      lastErr = err;
      const kind = rotator.classifyError(err);
      if (kind !== 'transient') throw err;
      rotator.markFailed(modelId, rotator.parseRetryAfter(err));
      remaining = remaining.filter(m => m !== modelId);
    }
  }
  throw lastErr;
}
```

`generateContent` and `chat` both go through this. The non-streaming response object gains a `_modelUsed` field.

### Streaming LLM (`createStreamingLLM`)

The outer `ReadableStream` performs the failover loop. On each transient failure, it emits a sentinel JSON to the consumer telling it to discard accumulated output, then starts fresh with the next model.

Replaces the existing stream body (lines 243-319 of `gemini.js`):

```js
const stream = new ReadableStream({
  async start(controller) {
    const safeEnqueue = (chunk) => {
      if (controller.desiredSize === null) return false;
      try { controller.enqueue(chunk); return true; } catch { return false; }
    };
    const encode = (obj) => new TextEncoder().encode(`data: ${JSON.stringify(obj)}\n\n`);
    const encodeDone = () => new TextEncoder().encode("data: [DONE]\n\n");

    let remaining = parseModelList(modelCsv);
    let lastErr;
    let succeededModel = null;

    while (remaining.length > 0) {
      const modelId = rotator.pickModel(remaining);
      try {
        await streamOneAttempt({ modelId, messages, safeEnqueue });
        succeededModel = modelId;
        rotator.markSucceeded(modelId);
        break;
      } catch (err) {
        lastErr = err;
        const kind = rotator.classifyError(err);
        if (kind !== 'transient') { controller.error(err); return; }
        rotator.markFailed(modelId, rotator.parseRetryAfter(err));
        remaining = remaining.filter(m => m !== modelId);
        if (remaining.length > 0) {
          safeEnqueue(encode({ _reset: true, next_model: remaining[0], reason: 'transient' }));
        }
      }
    }

    if (!succeededModel) { controller.error(lastErr); return; }
    safeEnqueue(encode({ _final_model: succeededModel }));
    safeEnqueue(encodeDone());
    try { controller.close(); } catch {}
  }
});
```

`streamOneAttempt` is the existing per-model streaming logic, extracted into a helper. It throws on error (including mid-stream) so the outer loop can catch and decide whether to fail over.

The `safeEnqueue` guard against `desiredSize === null` (from the existing fix at line 248) is preserved — consumer cancellation still cleanly exits the loop.

### SSE consumer changes in `askService.js`

The parser at line 407-432 currently handles only `{ choices: [{ delta: { content } }] }` shapes. Extend it to branch on the new sentinel fields *before* the existing content path:

```js
const json = JSON.parse(data);

if (json._reset) {
  fullResponse = '';
  this.state.currentResponse = '';
  this._broadcastState();
  continue;
}
if (json._final_model) {
  this.state.responseModel = json._final_model;
  this._broadcastState();
  continue;
}

const token = json.choices?.[0]?.delta?.content || '';
// ...existing path
```

The leading underscore on `_reset` and `_final_model` keeps them visually distinct from upstream OpenAI-shape fields and unlikely to collide if Gemini's SDK schema evolves.

### STT (`createSTT`)

No change to failover behavior. CSV parsing applied so a user who pastes a list doesn't break the session connect:

```js
const firstModel = parseModelList(modelCsv)[0] || 'gemini-live-2.5-flash-preview';
```

## UI changes

### Settings panel

Under the Gemini LLM Model ID input, add help text:

> Comma-separated list for failover. Models are tried in priority order; transient errors (429/503) skip to the next. Example: `gemini-3-pro,gemini-2.5-flash,gemini-2.5-flash-lite`

The input itself remains free-text — no UI control change. Validation happens in `settingsService.js`: trim, split on `,`, drop empties. Reject empty result.

### Per-response footer

The Ask response renderer reads `state.responseModel` (set when the `_final_model` sentinel arrives) and renders a muted footer below the response body:

```
─────
answered by: gemini-2.5-flash
```

If at least one `_reset` event fired during the response, append a marker so the user can tell failover happened:

```
answered by: gemini-2.5-flash (fallback)
```

Tracking this requires a boolean in `state.responseHadFallback`, flipped to `true` whenever `_reset` is handled in the SSE consumer.

## Edge cases

| Case | Behavior |
|---|---|
| Single model in CSV (no commas) | List of length 1; failover loop runs once; identical to current behavior |
| All models in cooldown | `pickModel` returns soonest-to-recover and tries it; if it 429s again, that error is surfaced |
| Whitespace in CSV (`" gpt , , gemini-pro "`) | Trimmed, empties dropped → `["gpt","gemini-pro"]` |
| Invalid model ID (typo) | First call returns 400 `INVALID_ARGUMENT` → `fatal-request` → surfaces immediately. Important: we do NOT silently skip, otherwise typos go undetected forever |
| Invalid API key | `fatal-auth` → surface immediately; same key applies to all models |
| Consumer cancels mid-stream (new request races old one) | Existing `desiredSize === null` guard makes `safeEnqueue` return false; outer loop sees zero successful chunks, eventually exits when the stream is closed by the consumer side |
| Same model listed twice in CSV | `remaining.filter(m => m !== modelId)` removes all instances on failure — duplicate entries effectively collapse to one |
| Mid-stream failover after substantial output (e.g. 95% done) | Re-rolls entire response with next model. Wasteful, but acceptable since we only land here when the primary actually errored |
| Concurrent requests | In-memory `Map` is safe (Node is single-threaded). Two concurrent requests reading the same cooldown state behave correctly |

## Testing

### Unit tests for `geminiModelRotator.js`

- `pickModel([])` → throws
- `pickModel(['a','b','c'])` with all healthy → returns `'a'`
- `pickModel(['a','b','c'])` after `markFailed('a', 60000)` → returns `'b'`
- `pickModel(['a','b','c'])` with all cooled down at different times → returns the one with soonest expiry
- `classifyError` for: SDK error with `status: 429`; SDK error with `status: 400`; raw HTTP `Response` with `status: 503`; network `TypeError`; `AbortError`
- `parseRetryAfter` for: `errorDetails` with `retryDelay: "37s"`; HTTP header `Retry-After: 45`; HTTP header with HTTP-date; missing both (→ 60000)
- `parseRetryAfter` clamping: input `1000` → `5000`; input `999999` → `300000`
- `parseModelList`: `"a,b,c"` → `["a","b","c"]`; `" a , , b "` → `["a","b"]`; `""` → `[]`

### Failover loop integration tests

Mock the Gemini SDK to return scripted responses:

- Success on first model → returns response with `_modelUsed === 'modelA'`, no cooldowns recorded
- 429 on first, success on second → second model's response returned, first model cooled down per Retry-After, `_modelUsed === 'modelB'`
- 429 on all → throws the last error
- 400 on first → throws immediately, second model never called

### Streaming integration test

Mock the SDK to return a stream that emits 2 chunks then errors with 503:

- Verify a `_reset` sentinel was emitted to the consumer
- Verify the second model's full output was streamed cleanly
- Verify `_final_model` sentinel was emitted with the second model's ID
- Verify `[DONE]` was emitted last

### Manual smoke test

Before considering the feature done:

1. Set Gemini LLM Model ID to `gemini-does-not-exist,gemini-2.5-flash`. Send a request. **Expect:** immediate surfaced error from the first model (validates `fatal-request` handling, prevents typos slipping through unnoticed).
2. Set to `gemini-2.5-flash`. Send a request. **Expect:** identical behavior to before this feature (validates single-model backward compatibility).
3. Set to `gemini-2.5-flash,gemini-2.5-flash-lite`. Send a request and observe response footer shows `answered by: gemini-2.5-flash`. (Harder to test failover without engineering a 429, but at minimum verify the happy-path footer renders.)

## Files touched

```
NEW   src/features/common/ai/providers/geminiModelRotator.js
NEW   src/features/common/ai/providers/__tests__/geminiModelRotator.test.js
EDIT  src/features/common/ai/providers/gemini.js
EDIT  src/features/settings/settingsService.js
EDIT  src/ui/settings/SettingsView.js
EDIT  src/features/ask/askService.js
EDIT  <Ask response renderer>      (TBD — locate during implementation)
EDIT  CHANGELOG.md
```

## Out of scope / future work

- **Quality-aware routing** (track latency / success rate per model and pick the healthiest). Overkill for a personal tool; revisit only if usage patterns demand it.
- **Failover for other providers** (OpenAI, Anthropic). Same pattern would apply but is not requested. The rotator module is provider-agnostic by accident — could be lifted later.
- **Persistent cooldowns across app restarts.** Cooldowns are ≤300s so not worth the persistence overhead.
- **User-configurable cooldown defaults / clamps.** Constants in the rotator module; can promote to settings if needed.
- **STT failover.** Punted because STT is a long-lived session, not a request. Would require a separate design for session-reconnect semantics.
- **Round-robin or tier-based rotation** (the other two options from the brainstorm). Can be added later as an alternative `pickModel` strategy without disturbing the loop.

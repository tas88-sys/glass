---
critical_requirements:
  type: feature-major
  portal: app
  ui_changes: minor
---

# Gemini Failover — Implementation Spec

**Source design:** `specs/2026-05-26-gemini-failover-design/2026-05-26-gemini-failover-design.md`
**Source brief:** `specs/2026-05-26-gemini-failover-design/prompt.md`
**Date:** 2026-05-26
**Status:** Awaiting user approval before implementation.

---

## Confidence statement

The design was validated through `/workflow-brainstorm` and codifies five locked decisions (rotation philosophy, cooldown policy, STT strategy, mid-stream handling, active-model display). All referenced file paths exist and the line ranges quoted in the design (gemini.js 243-319, askService.js 407-432) align with the current code (gemini.js: 337 lines, askService.js: 478 lines).

Residual risks that this spec cannot eliminate before code lands:

- ~~The exact "Ask response renderer" that consumes `state.currentResponse` for the per-response footer is marked TBD in the design.~~ Resolved in /clarify session: renderer is `src/ui/ask/AskView.js` (Lit element). State propagation reuses the existing `ask:stateUpdate` IPC channel — no new websocket or state-bridge plumbing required.
- The `_reset` sentinel relies on the SSE consumer in `askService.js` resetting both `fullResponse` and `this.state.currentResponse` before the broadcast fires. If any downstream state subscriber has its own accumulator (e.g., transcript persistence), it could double-record. Test §11 covers this.
- Gemini SDK error shape stability — `classifyError` walks `status` → `errorDetails[]` → message text. A future SDK version that changes error envelope could regress classification accuracy. The fail-open default (treat unknown as `transient`) keeps the loop safe but could mask real bugs.

These three risks are inherent to (a) UI plumbing not yet mapped, (b) SSE consumer reuse, and (c) external SDK behavior, and are the reason the test plan in §11 exists.

---

## Clarifications

### Session 2026-05-26

The full design document (`2026-05-26-gemini-failover-design.md`) was produced under `/workflow-brainstorm` and explicitly locks five decisions in its "Decisions (from brainstorm)" table. Those decisions are binding for this spec and should NOT be re-litigated during `/plan` or implementation. Recording residual implementation-gap auto-resolutions here so they survive the spec → plan → implement chain:

- Q: [IMPL GAP] Where is the "Ask response renderer" that consumes `state.currentResponse` and must render the `answered by: <model>` footer? → A: [AUTO] `src/ui/ask/AskView.js`. Confirmed by `Grep` on `currentResponse|responseModel|ask:stateUpdate` across `src/` and `pickleglass_web/` — only `src/preload.js`, `src/features/ask/askService.js`, `src/ui/ask/AskView.js`, and `src/ui/app/PickleGlassApp.js` reference these; `pickleglass_web/` has zero hits. The renderer is a Lit element (`AskView extends LitElement`) with `currentResponse` already declared as a reactive property. To render the footer, add two new reactive properties on `AskView`: `responseModel: { type: String }` and `responseHadFallback: { type: Boolean }`. The state propagation path is unchanged: `askService._broadcastState()` pushes `this.state` via `askWindow.webContents.send('ask:stateUpdate', this.state)`, and the existing IPC listener in `preload.js`/`PickleGlassApp.js` already forwards the state object to `AskView`. No new IPC channel required.
- Q: [IMPL GAP] Should `markSucceeded` clear the cooldown entry entirely, or just timestamp it as healthy? → A: [AUTO] Clear entirely. `markSucceeded(modelId)` does `health.delete(modelId)`. Reasoning: the only reason to retain a healed entry would be to track success metrics, which is explicitly out of scope (see "Quality-aware routing" in the design's out-of-scope list). Cleanest state representation: present in `health` ⇔ currently cooling down.
- Q: [IMPL GAP] What happens when `parseModelList` receives `null` or `undefined` (provider misconfigured)? → A: [AUTO] Return `[]`. Callers (the failover loop, STT) check `length > 0` and throw a clear error message if empty. This is friendlier than throwing inside `parseModelList` itself, which would crash earlier in settings load.
- Q: [IMPL GAP] What happens if `controller.error(err)` is called after `controller.close()` (race between mid-stream failure and stream closure)? → A: [AUTO] Wrap both terminal calls in `try { ... } catch {}`. The existing fix at line 248 already uses this pattern for `controller.close()`. Apply the same to `controller.error()`. The `safeEnqueue` guard (preserved per design) ensures `desiredSize === null` cancellations don't reach `controller.error()` in the first place, but defense in depth costs us one `try/catch`.
- Q: [IMPL GAP] Should the rotator be a singleton module or instantiable? → A: [AUTO] Singleton (module-level `const health = new Map()`). The Gemini provider is itself effectively a singleton inside the Electron process — there's exactly one app, one shared rate-limit budget against the Gemini API. Multiple rotators would partition the cooldown view across requests and defeat the point. If the rotator is ever lifted to be provider-agnostic (out-of-scope item), it can grow a factory then.
- Q: [IMPL GAP] When `_reset` fires in the SSE consumer and resets `this.state.currentResponse = ''`, will any UI subscriber observe a flash of empty content followed by the new content? → A: [AUTO] Acceptable. The SSE consumer broadcasts state on each delta token anyway (line 425-ish of askService.js); the `_reset` broadcast is just one more state push with an empty string. The renderer will repaint with no content for a single frame, then accumulate again. This is the intended UX — the user SHOULD see the response start over because the first model failed mid-stream. If the visual flash is jarring, follow-up work can add a 100ms throttle on the reset-driven empty render, but that's not a v1 concern.
- Q: [IMPL GAP] How is the rotator's in-memory state observed in tests? Do we need a `__resetHealthForTests()` export? → A: [AUTO] Yes. Add `resetHealth()` to the module exports, called by Jest `beforeEach`. This avoids the temptation to mock `Date.now()` for cooldown expiry across tests, which is more fragile. The export is fenced off by a `// @internal — test helper` comment so it doesn't get adopted as production API.
- Q: [IMPL GAP] The existing front-end validator at `SettingsView.js:751-755` rejects any value not starting with `gemini-`. A CSV like `"gpt-4,gemini-2.5-flash"` would pass the current single-string `startsWith('gemini-')` check by accident. How should the validator handle the new CSV format? → A: [AUTO] Update `handleSaveGeminiModels` in `SettingsView.js` to split on `,`, trim each entry, drop empties, and require every entry to start with `gemini-`. On failure, alert the offending token (`"Invalid Gemini LLM model ID: \"gpt-4\". Must start with \"gemini-\"."`). This preserves typo protection while allowing the new CSV semantics. The deeper validation (parsing, deduplication, settings persistence) still lives in `settingsService.js` per §3; the front-end check is a friendly first-pass guard, not the authoritative validator.
- Q: [IMPL GAP] `askService.js:247-251` calls `modelStateService.getCurrentModelInfo('llm')` and passes `modelInfo.model` to `createStreamingLLM` as a single string. The CSV is stored in `selected_llm_model` (one DB column). Does `getCurrentModelInfo` need to be aware of CSV semantics, or does the raw CSV string pass through unchanged? → A: [AUTO] Raw CSV passes through unchanged. `modelStateService.js:377-388` returns `model: activeSetting.selected_llm_model` opaquely. The provider-specific `createStreamingLLM` in `gemini.js` is responsible for calling `parseModelList(model)` itself. The factory layer (`src/features/common/ai/factory.js:128-138`) calls `sanitizeModelId` which does `replace(/-glass$/, '')` — for a Gemini CSV this regex won't match (Gemini IDs don't end in `-glass`), so the CSV passes through `sanitizeModelId` untouched. No edits to `modelStateService` or `factory.js` required.
- Q: [IMPL GAP] The non-streaming `createLLM` returns `{ response: { text: () => ... } }` from `generateContent` and `{ content, raw }` from `chat`. Spec §3 says it gains a `_modelUsed` field — at what level (top-level vs nested), and is any caller actually using it? → A: [AUTO] Top-level on the outer object: `{ response: {...}, _modelUsed }` for `generateContent` and `{ content, raw, _modelUsed }` for `chat`. The Ask flow only consumes the streaming path (`createStreamingLLM`), so `_modelUsed` on the non-streaming objects is currently unused by any UI but is still set for symmetry and future-proofing. No new consumer is required by this spec; the field exists for parity with the streaming `_final_model` sentinel and so that direct test invocations of `createLLM` can assert which model satisfied the request.
- Q: [IMPL GAP] `selected_llm_model` is a SQLite column already holding a single model ID; will storing a CSV string in it cause a schema or type-validation problem? → A: [AUTO] No. The column is plain TEXT (no length constraint, no format validation at the DB layer). The CSV string is bounded by the front-end input width and the practical limit of how many Gemini models a user would list (well under 1KB). No migration, no schema change. The existing repository methods (`providerSettingsRepository.setSelectedModel` etc.) treat the value as opaque.

### Coverage residuals

- **Scope:** clear (locked five decisions; out-of-scope explicitly enumerated in §9).
- **Data:** clear (no DB schema changes; `selectedLlmModel` value already string, just gets CSV semantics layered on).
- **UX:** clear — per-response footer chosen over header badge; `(fallback)` marker chosen as the failover signal.
- **Edge cases:** clear — single model, all-cooling, whitespace, invalid model ID typo, invalid API key, consumer cancel, duplicate entries, mid-stream very-late failure, concurrent requests all explicitly covered in §7.
- **Test plan:** clear — unit, integration, streaming, and manual smoke tests all enumerated in §11.

---

## System Context

Framework-internal / personal project — no Cover Whale system involved. This is the `glass` Electron application repo. The change is entirely local to the Electron main process AI provider layer and the renderer's Ask flow. No external CW systems (V1 PHP, V2 K8s, Solartis, SambaSafety, etc.) are touched.

Affected modules:

- **AI providers layer** (`src/features/common/ai/providers/`) — new rotator module, edits to `gemini.js`.
- **Settings layer** (`src/features/settings/settingsService.js`, `src/ui/settings/SettingsView.js`) — CSV parsing, validation, help text.
- **Ask flow** (`src/features/ask/askService.js`) — SSE consumer extension for `_reset` / `_final_model` sentinels.
- **Ask response renderer** (`src/ui/ask/AskView.js` — confirmed) — footer rendering. Lit element; add reactive properties and update the existing template.

---

## 1. Goal

When the configured Gemini model fails transiently (HTTP 408, 429, 500, 502, 503, 504; network/timeout; SDK codes `RESOURCE_EXHAUSTED`, `UNAVAILABLE`, `DEADLINE_EXCEEDED`), the app tries the next model in a user-supplied comma-separated priority list. The actually-used model is surfaced on every response. Single-model configurations behave identically to today.

The five locked decisions from `/workflow-brainstorm`:

| Decision | Choice | Rationale |
|---|---|---|
| Rotation philosophy | Sticky primary + failover | Quality consistency over preemptive quota spread |
| Cooldown policy | Honor `Retry-After` / `retryDelay`; default 60s; clamp `[5s, 300s]` | Accurate when API tells us; sane fallback otherwise |
| STT strategy | Single model, no failover | STT is a persistent live session; rotation has no clean semantics |
| Mid-stream error handling | Abandon partial output, restart from scratch with next model | Cleaner UX than splicing two model outputs |
| Active-model display | Per-response footer (`answered by: <model>`) | Per-response provenance; no header clutter |

---

## 2. Architecture

### Components

| # | File | Status | Responsibility |
|---|------|--------|----------------|
| 1 | `src/features/common/ai/providers/geminiModelRotator.js` | NEW | In-memory health registry. Exports: `pickModel(list)`, `markFailed(modelId, retryAfterMs)`, `markSucceeded(modelId)`, `classifyError(err)`, `parseRetryAfter(err)`, `parseModelList(csv)`, `resetHealth()` (test-only) |
| 2 | `src/features/common/ai/providers/gemini.js` | EDIT | `createLLM` and `createStreamingLLM` wrap inner SDK calls in failover loop driven by rotator. `createSTT` reads only the first model |
| 3 | `src/features/settings/settingsService.js` | EDIT | CSV parsing/validation for `selectedLlmModel` when provider is `gemini`. Reject empty list. Trim entries. STT strips after first comma |
| 4 | `src/ui/settings/SettingsView.js` | EDIT | Help text under the Gemini LLM Model ID input |
| 5 | `src/features/ask/askService.js` | EDIT | Extend SSE consumer at line 407-432 to recognize `{ "_reset": true, "next_model": "..." }` and `{ "_final_model": "..." }` |
| 6 | `src/ui/ask/AskView.js` | EDIT | Add `responseModel` and `responseHadFallback` reactive properties; render `answered by: <model>` (with optional `(fallback)` marker) in a muted footer below the response body. State arrives via the existing `ask:stateUpdate` IPC channel — no new plumbing required. |

### State

```js
// src/features/common/ai/providers/geminiModelRotator.js
// Map<modelId, { cooldownUntil: number /* epoch ms */, lastError?: string }>
const health = new Map();
```

In-memory only. No persistence. On app restart all models start healthy. Cooldowns ≤300s clamped so restart loses nothing meaningful.

### Selection algorithm

```js
function pickModel(modelList) {
  if (modelList.length === 0) throw new Error('pickModel: empty model list');
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

Sticky primary is implicit: the loop returns the first healthy model in declared order.

### Error classification

| Class | Triggers | Action |
|---|---|---|
| `transient` | HTTP 408, 429, 500, 502, 503, 504; network/timeout errors; SDK codes `RESOURCE_EXHAUSTED`, `UNAVAILABLE`, `DEADLINE_EXCEEDED` | Cooldown current model, try next |
| `fatal-request` | HTTP 400; SDK `INVALID_ARGUMENT` (bad model name, malformed payload) | Surface immediately — catches typos in the CSV |
| `fatal-auth` | HTTP 401, 403; SDK `PERMISSION_DENIED`, `API_KEY_INVALID` | Surface immediately — API key shared across models |

`classifyError` inspection order: explicit `status` code → `errorDetails[].@type` containing `ErrorInfo` → message-text heuristics. Unknown errors default to `transient` (fail-open).

### Cooldown

`parseRetryAfter(err)` tries in order:

1. `err.errorDetails?.find(d => d['@type']?.includes('RetryInfo'))?.retryDelay` — e.g. `"37s"` → 37000ms
2. HTTP `Retry-After` response header (seconds or HTTP-date format)
3. Default: 60000ms

Result clamped to `[5000, 300000]` ms so a misconfigured backend can't lock the app out for an hour.

---

## 3. Failover behavior

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

Outer `ReadableStream` performs the failover loop. On each transient failure, emit a sentinel JSON to the consumer telling it to discard accumulated output, then start fresh with the next model.

Replaces existing stream body (lines 243-319 of `gemini.js`):

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
        if (kind !== 'transient') {
          try { controller.error(err); } catch {}
          return;
        }
        rotator.markFailed(modelId, rotator.parseRetryAfter(err));
        remaining = remaining.filter(m => m !== modelId);
        if (remaining.length > 0) {
          safeEnqueue(encode({ _reset: true, next_model: remaining[0], reason: 'transient' }));
        }
      }
    }

    if (!succeededModel) {
      try { controller.error(lastErr); } catch {}
      return;
    }
    safeEnqueue(encode({ _final_model: succeededModel }));
    safeEnqueue(encodeDone());
    try { controller.close(); } catch {}
  }
});
```

`streamOneAttempt` is the existing per-model streaming logic, extracted into a helper. It throws on error (including mid-stream) so the outer loop can catch and decide whether to fail over.

The `safeEnqueue` guard against `desiredSize === null` (from the existing fix at line 248) is preserved — consumer cancellation still cleanly exits the loop. Per the impl-gap resolution above, `controller.error()` is also wrapped in `try/catch` for defense in depth.

### SSE consumer changes in `askService.js`

The parser at line 407-432 currently handles only `{ choices: [{ delta: { content } }] }` shapes. Extend to branch on the new sentinel fields BEFORE the existing content path:

```js
const json = JSON.parse(data);

if (json._reset) {
  fullResponse = '';
  this.state.currentResponse = '';
  this.state.responseHadFallback = true;
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

---

## 4. UI changes

### Settings panel

Under the Gemini LLM Model ID input, add help text:

> Comma-separated list for failover. Models are tried in priority order; transient errors (429/503) skip to the next. Example: `gemini-3-pro,gemini-2.5-flash,gemini-2.5-flash-lite`

Input remains free-text. Validation happens in `settingsService.js`: trim, split on `,`, drop empties. Reject empty result.

### Per-response footer

The Ask response renderer reads `state.responseModel` (set when the `_final_model` sentinel arrives) and renders a muted footer below the response body:

```
─────
answered by: gemini-2.5-flash
```

If at least one `_reset` event fired during the response, append a marker:

```
answered by: gemini-2.5-flash (fallback)
```

This requires `state.responseHadFallback` to be a boolean flipped to `true` whenever `_reset` is handled (see snippet above).

### Portal placement

The change touches the **app** (Electron renderer). No admin/superadmin/public portal impact.

---

## 5. Edge cases

| Case | Behavior |
|---|---|
| Single model in CSV (no commas) | List of length 1; failover loop runs once; identical to current behavior |
| All models in cooldown | `pickModel` returns soonest-to-recover and tries it; if it 429s again, that error is surfaced |
| Whitespace in CSV (`" gpt , , gemini-pro "`) | Trimmed, empties dropped → `["gpt","gemini-pro"]` |
| Invalid model ID (typo) | First call returns 400 `INVALID_ARGUMENT` → `fatal-request` → surfaces immediately. We do NOT silently skip, otherwise typos go undetected forever |
| Invalid API key | `fatal-auth` → surface immediately; same key applies to all models |
| Consumer cancels mid-stream (new request races old one) | Existing `desiredSize === null` guard makes `safeEnqueue` return false; outer loop sees zero successful chunks, eventually exits when the stream is closed by the consumer side |
| Same model listed twice in CSV | `remaining.filter(m => m !== modelId)` removes all instances on failure — duplicate entries effectively collapse to one |
| Mid-stream failover after substantial output (e.g. 95% done) | Re-rolls entire response with next model. Wasteful, but acceptable since we only land here when the primary actually errored |
| Concurrent requests | In-memory `Map` is safe (Node single-threaded). Two concurrent requests reading the same cooldown state behave correctly |
| `parseModelList(null)` / `parseModelList(undefined)` | Returns `[]`. Caller throws clear error if empty |
| `markSucceeded(modelId)` on a model never marked failed | No-op (`health.delete` is safe on absent key) |
| `controller.error()` called after `controller.close()` | Wrapped in `try/catch` per impl-gap resolution above |

---

## 6. Testing

### 6.1 Unit tests — `geminiModelRotator.js`

Create `src/features/common/ai/providers/__tests__/geminiModelRotator.test.js`. Use Jest. `resetHealth()` is called in `beforeEach`.

- `pickModel([])` → throws `Error('pickModel: empty model list')`
- `pickModel(['a','b','c'])` with all healthy → returns `'a'`
- `pickModel(['a','b','c'])` after `markFailed('a', 60000)` → returns `'b'`
- `pickModel(['a','b','c'])` with all cooled down at different times → returns the one with soonest expiry
- `classifyError` for: SDK error with `status: 429`; SDK error with `status: 400`; raw HTTP `Response` with `status: 503`; network `TypeError`; `AbortError`
- `parseRetryAfter` for: `errorDetails` with `retryDelay: "37s"`; HTTP header `Retry-After: 45`; HTTP header with HTTP-date; missing both (→ 60000)
- `parseRetryAfter` clamping: input `1000` → `5000`; input `999999` → `300000`
- `parseModelList`: `"a,b,c"` → `["a","b","c"]`; `" a , , b "` → `["a","b"]`; `""` → `[]`; `null` → `[]`; `undefined` → `[]`
- `markSucceeded` clears entry: `markFailed('a', 60000)` then `markSucceeded('a')` → `pickModel(['a'])` returns `'a'` immediately (no cooldown)

### 6.2 Failover loop integration tests

Mock the Gemini SDK to return scripted responses:

- Success on first model → returns response with `_modelUsed === 'modelA'`, no cooldowns recorded
- 429 on first, success on second → second model's response returned, first model cooled down per Retry-After, `_modelUsed === 'modelB'`
- 429 on all → throws the last error
- 400 on first → throws immediately, second model never called
- 401 on first → throws immediately, second model never called

### 6.3 Streaming integration test

Mock the SDK to return a stream that emits 2 chunks then errors with 503:

- Verify a `_reset` sentinel was emitted to the consumer
- Verify the second model's full output was streamed cleanly
- Verify `_final_model` sentinel was emitted with the second model's ID
- Verify `[DONE]` was emitted last
- Verify `controller.error()` is NOT called when failover succeeds
- Verify `controller.error()` IS called wrapped in try/catch when all models fail

### 6.4 SSE consumer test in `askService.js`

Feed a synthetic SSE stream to the consumer parser:

- Stream containing `_reset` → `fullResponse` and `state.currentResponse` reset to `''`; `state.responseHadFallback` set to `true`; broadcast fires
- Stream containing `_final_model` → `state.responseModel` set; broadcast fires
- Stream containing a normal token after `_reset` → token appears in `fullResponse` (not concatenated with pre-reset content)

### 6.5 Manual smoke test

Before considering the feature done:

1. Set Gemini LLM Model ID to `gemini-does-not-exist,gemini-2.5-flash`. Send a request. **Expect:** immediate surfaced error from the first model (validates `fatal-request` handling, prevents typos slipping through unnoticed).
2. Set to `gemini-2.5-flash`. Send a request. **Expect:** identical behavior to before this feature (validates single-model backward compatibility).
3. Set to `gemini-2.5-flash,gemini-2.5-flash-lite`. Send a request and observe response footer shows `answered by: gemini-2.5-flash`. (Harder to test failover without engineering a 429, but at minimum verify the happy-path footer renders.)
4. Set to a clearly-throttled model first (or use a model in the user's known-throttled list), confirm `(fallback)` marker renders on the footer.

---

## 7. Files touched

```
NEW   src/features/common/ai/providers/geminiModelRotator.js
NEW   src/features/common/ai/providers/__tests__/geminiModelRotator.test.js
EDIT  src/features/common/ai/providers/gemini.js
EDIT  src/features/settings/settingsService.js
EDIT  src/ui/settings/SettingsView.js
EDIT  src/features/ask/askService.js
EDIT  src/ui/ask/AskView.js                                 (Ask response renderer — confirmed)
EDIT  CHANGELOG.md
```

---

## 8. Out of scope / future work

- **Quality-aware routing** (track latency / success rate per model and pick the healthiest). Overkill for a personal tool; revisit only if usage patterns demand it.
- **Failover for other providers** (OpenAI, Anthropic). Same pattern would apply but not requested. The rotator module is provider-agnostic by accident — could be lifted later.
- **Persistent cooldowns across app restarts.** Cooldowns are ≤300s so not worth persistence overhead.
- **User-configurable cooldown defaults / clamps.** Constants in the rotator module; can promote to settings if needed.
- **STT failover.** Punted because STT is a long-lived session, not a request. Would require a separate design for session-reconnect semantics.
- **Round-robin or tier-based rotation** (the other two options from the brainstorm). Can be added later as an alternative `pickModel` strategy without disturbing the loop.

---

## 9. UI/Design Reference

UI changes are minor:

1. Settings panel: one paragraph of help text under an existing input. No new control.
2. Ask response: one footer line below the response body (`answered by: <model>` or `answered by: <model> (fallback)`). Muted color, small font. Renders only when `state.responseModel` is set.

No new windows, no new pages, no new flows. The header (393px wide, recently widened per commit `525dcb1`) is untouched.

---

## 10. Acceptance criteria

The feature is considered done when:

1. Unit tests (§6.1) all pass.
2. Integration tests (§6.2, §6.3, §6.4) all pass.
3. Manual smoke tests (§6.5) all pass, including the `(fallback)` marker check.
4. With a single-model CSV, behavior is byte-identical to pre-feature behavior on the happy path (validated by smoke test #2).
5. With a multi-model CSV and a deliberately-broken first model, the request succeeds with the second model and the footer shows `(fallback)`.
6. The `CHANGELOG.md` is updated with a "Gemini Failover" entry under the next version.

---

## 11. Next phase

Run `/plan` to generate the implementation plan with task ordering, parallelization opportunities, and dependency graph.

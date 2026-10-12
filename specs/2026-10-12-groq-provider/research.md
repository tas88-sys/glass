# Phase 0 Research: Groq Provider

**Spec**: `2026-10-12-groq-provider`
**Date**: 2026-10-12

## Sources

- **The repo.**
- **Groq's docs**, read 2026-10-12. Pages: overview, models, deprecations, rate-limits, errors, reasoning, vision, openai, prompt-caching, service-tiers, libraries, api-reference, and the model pages for `openai/gpt-oss-20b`, `qwen/qwen3.8-27b` and `minimaxai/minimax-m2.7`.
- **`groq-sdk` 1.6.0**, unpacked from npm for reading only: `src/`, `CHANGELOG.md`, `README.md`.
- **Secondary sources on rate-limit accounting** (R5), cited with their dates. The live checks contradicted them.
- **Live calls on 2026-10-12** through the Composio GroqCloud connection. Its key ("composio-myapp") belongs to the user's Groq organization: the calls appear in that organization's console logs.
  - `models.list`;
  - seven non-streaming chat completions, which cost fractions of a cent.
- **The user's GroqCloud console**, read in the browser on 2026-10-12: Settings → Limits, Dashboard → Logs, Billing → Plans.

Nothing streaming was checked live. T006 does that.

---

## R1: What Glass has for Groq today

**Finding**: nothing. No provider file, no factory entry, no dependency. A new provider touches:

| Place | Today | Needed |
|-------|-------|--------|
| `factory.js` `PROVIDERS` | 7 entries, no `groq` | `groq` entry (name, handler, presets, `sttModels: []`) |
| `factory.js` `getProviderClass` | `classNameMap` without `groq` | `groq: 'GroqProvider'` |
| `factory.js` `inferProviderFromModelId` | `claude-` → anthropic, `gemini-` → gemini | `vendor/model` → groq (R2) |
| `modelStateService.getProviderForModel` (`:286-311`) | presets → installed Ollama → inferred gemini (llm, stt) / anthropic (llm) | inferred groq (llm) |
| `modelStateService.getAvailableModels` (`:363`) | custom value branch for gemini and anthropic | add groq |
| `settingsService.removeApiKey` (`:368`) | hard-coded `['openai','anthropic','gemini','ollama','whisper']` | add `groq`, or the Groq key survives "remove all keys" |
| `SettingsView` | `apiKeys` init (`:518`); `getProviderForModel` (`:983`); Anthropic model block (`:1392`) | `groq` key; slash rule after the Ollama check; Groq model block |
| `ApiKeyHeader` | provider list from `getProviderConfig` (`:431-455`); footer (`:2070`) | nothing for the list (data-driven); footer text |
| `provider_settings` table | `provider TEXT NOT NULL`, no enum (`schema.js:92`) | nothing |

The consumers (`askService`, `askStreamState`, `summaryService`) speak the provider-neutral protocol and need nothing (C1). They do not branch on `_reset.reason` (`askStreamState.js:46-54`, `summaryService.js:270,426-441`), so a new reason, `too-large`, is safe.

---

## R2: Groq models (2026-10-12)

**Live `models.list` on the Composio key** returns 11 active models. The chat-capable ones:

| ID | Owner | Input | Context | Max output | Price in / out per 1M (cached in) | Features |
|----|-------|-------|---------|-----------|-----------------------------------|----------|
| `openai/gpt-oss-120b` | OpenAI | text | 131,072 | 65,536 | $0.15 / $0.60 ($0.075) | tools, json, structured, reasoning |
| `openai/gpt-oss-20b` | OpenAI | text | 131,072 | 65,536 | $0.075 / $0.30 ($0.0375) | tools, json, structured, reasoning |
| `qwen/qwen3.8-27b` | Alibaba | text, **image** | 131,072 | 16,384 | $0.80 / $4.00 ($0.40) | tools, json, reasoning |
| `openai/gpt-oss-safeguard-20b` | OpenAI | text | 131,072 | 65,536 | as 20b | safety classifier, not a chat model |
| `allam-2-7b` | SDAIA | text | 4,096 | 4,096 | — | 4K context: too small for Glass prompts |

The rest are audio or classifiers: `whisper-large-v3`, `whisper-large-v3-turbo`, `canopylabs/orpheus-*`, `meta-llama/llama-prompt-guard-2-*`.

**From the docs:**
- **Speed:** `gpt-oss-20b` ~1000 tok/s, `gpt-oss-120b` ~500, `qwen3.8-27b` ~450.
- **Status:** `qwen/qwen3.8-27b` is **Preview** ("intended for evaluation purposes only"). The gpt-oss models are Production.
- **`minimaxai/minimax-m2.7`** is Preview and Enterprise-only, and not on the key.
- **Every chat model lists `temperature`** in `supported_sampling_parameters`.

**Deprecations** (docs, deprecations page; "for free and developer-tier usage"):

| Model | Shutdown | Replacement |
|-------|----------|-------------|
| `llama-3.1-8b-instant` | 2026-08-16 | `openai/gpt-oss-20b` |
| `llama-3.3-70b-versatile` | 2026-08-16 | `openai/gpt-oss-120b` or `qwen/qwen3.6-27b` |
| `qwen/qwen3.6-27b` | 2026-09-14 | `qwen/qwen3.8-27b` |
| `qwen/qwen3-32b`, `meta-llama/llama-4-scout-17b-16e-instruct` | 2026-07-17 | `openai/gpt-oss-120b` |
| `moonshotai/kimi-k2-instruct-0905` | 2026-04-15 | `openai/gpt-oss-120b` |
| `groq/compound`, `groq/compound-mini` | 2026-09-21 | — |

The models page still lists the two Llama models as Production, priced "Contact Sales". They are gone from the live list.

**Decisions:**
- **Presets.** The three chat models in the first table, in quality order (D10).
- **Provider mapping.** Every current chat ID is `vendor/model`, so a slash maps an ID to Groq (D2). The only un-namespaced chat IDs are retired for the tiers Glass users have. A user who types one is told to add the vendor prefix (E40).
- **Churn.** Groq retired 10 models in 2026, 7 of them chat models (deprecations table above, plus `meta-llama/llama-4-maverick-17b-128e-instruct` and `meta-llama/llama-guard-4-12b`). Nothing in the provider may name a model outside the presets, and key validation names none (R9).

---

## R3: Which SDK

| Option | For | Against |
|--------|-----|---------|
| **`groq-sdk` ^1.6.0** (chosen) | Official (Groq, Apache-2.0, `github:groq/groq-typescript`). Stainless-generated, same shape as `@anthropic-ai/sdk`: client options `maxRetries`/`timeout`, per-call `signal`, `withResponse()`, typed `APIError` subclasses, async-iterable stream. Groq fields typed (`x_groq`, `reasoning_effort`, `include_reasoning`, `reasoning_format`, `service_tier`). **No dependencies**, CommonJS (`type: commonjs`, `require('groq-sdk')` works), ~2 MB on disk. 1.6.0 released 2026-08-25. | One more package |
| `openai` 4.104.0 (already a dependency) with `baseURL` | No new package. Groq's docs use it in their examples | Three majors behind (latest 7.32.0). Couples the Groq path to the OpenAI provider's upgrade schedule. Its error parsing reads `body.error`, while Groq's stream errors and `x_groq.error` are Groq-specific. Untyped for Groq fields |
| Raw `fetch` + SSE parsing | No package | Re-implements what the SDK does. Against C4's spirit, and the Anthropic spec removed raw fetch for the same reason |

**Node 20.16 (Electron 30.5.1)**: the README requires "Node.js 20 LTS or later". The only grep hits for Node 22+ APIs are guarded platform detection (`navigator.product`, `navigator.userAgent`). A load-and-stream test under Electron's Node is still required (FR-023, T005), as for Anthropic.

**Security**: run `npm audit` in T005 and record the result in the task evidence.

---

## R4: What `groq-sdk` 1.6.0 does (read in the source)

- **Retries** (`src/client.ts:561-582`): 408, 409, 429 and every status ≥ 500, plus connection errors and timeouts; `x-should-retry` overrides. `maxRetries` defaults to 2.
- **Retry wait** (`client.ts:584-621`): `retry-after-ms`, then `retry-after` (seconds or HTTP date), **with no cap**, else 0.5 s × 2ⁿ (max 8 s, jitter ≤ 25%).
  - The wait is a plain `setTimeout` (`internal/utils/sleep.ts`), so aborting the request does not end it.
  - A 429 with `retry-after: 40` holds the attempt for 40 s.
  - **Consequence: `maxRetries: 0`** (D4), exactly as in Anthropic research R12.
- **Timeout** (`client.ts:530-558`): default 60 s. It covers `fetch` until the response headers arrive. **A body that goes silent is not bounded by the SDK** (FR-015, FR-016).
- **Errors** (`core/error.ts`):
  - `APIError.generate` maps 400/401/403/404/409/422/429/≥500 to subclasses; any other status (413, 424, 498) is a plain `APIError`.
  - For an HTTP error, `err.error` is the **whole JSON body**, `{ error: { message, type, code } }`, and `err.message` is `"<status> <JSON of the body>"`.
  - There is **no `err.type`** and **no `requestID`**, unlike Anthropic SDK 0.81+. The classifier reads the type and code from the body.
- **Stream** (`core/streaming.ts:37-103`):
  - A `data: {"error": …}` event throws `APIError(undefined, data.error, …)`. Here `err.error` is the **inner** object `{ message, type, code }`, so the classifier must read both shapes.
  - On abort, the iterator **returns without throwing** (`isAbortError` → return), so a timeout we trigger must be read from our own flag, as in Anthropic.
  - **After `data: [DONE]` the iterator keeps reading until the server closes the connection** (`if (done) continue`). If the server keeps it open, the iteration hangs after the last token. The attempt therefore stops at the chunk with `finish_reason` and aborts the connection (FR-017), Gemini's and Anthropic's lesson again.
- **Chunk type** (`resources/chat/completions.ts:353-460, 960-1015`):
  - `choices[0].delta.content`, `delta.reasoning`, `finish_reason` (`stop|length|tool_calls|function_call|null`).
  - `x_groq.id`: "Sent only in the first and final chunk".
  - `x_groq.usage`, `x_groq.seed`: final chunk.
  - **`x_groq.error`**: "An error string indicating why a stream was stopped early".
- **Usage** (`resources/completions.ts`): `prompt_tokens`, `completion_tokens`, `total_tokens`, `queue_time`, `prompt_time`, `completion_time`, `total_time`, `prompt_tokens_details.cached_tokens`, `completion_tokens_details.reasoning_tokens`.
- **Base URL**: `GROQ_BASE_URL` env, else `https://api.groq.com`. Glass passes nothing, so a user env var would redirect the client. This is documented (quickstart), not guarded.
- **`withResponse()`**: returns `{ data, response }`. Request id and rate-limit headers come from `response.headers`.

---

## R5: Rate limits, and how Groq counts a request

**Docs** (rate-limits page):
- Limits apply per model, at organization level.
- The per-model numbers are only in the console (`/settings/limits`).
- `retry-after` comes in seconds, on 429 only.
- These headers are always sent: `x-ratelimit-limit-requests` (RPD), `x-ratelimit-limit-tokens` (TPM), `x-ratelimit-remaining-requests`, `x-ratelimit-remaining-tokens` and `x-ratelimit-reset-*` (formatted like `7.66s`).

**The user's organization** (GroqCloud console, read 2026-10-12):
- **Billing → Plans**: "Free — Current Plan". The Developer plan shows "Developer tier upgrades are temporarily unavailable due to high demand." Secondary sources date the pause to about August 2026 and give no reopening date.
- **Settings → Limits**: organization limits, with no project overrides ("No project limits set").

  | Model | RPM | RPD | TPM | TPD |
  |-------|-----|-----|-----|-----|
  | `openai/gpt-oss-120b` | 30 | 1K | 8K | 200K |
  | `openai/gpt-oss-20b` | 30 | 1K | 8K | 200K |
  | `qwen/qwen3.8-27b` | 30 | 1K | 8K | 200K |
  | `openai/gpt-oss-safeguard-20b` | 3 | 1K | 2K | 200K |
  | `allam-2-7b` | 30 | 7K | 6K | 500K |

  The limits are listed per model, so each model in the list brings its own budget.

**Is the declared `max_completion_tokens` metered? No, not on this organization today.**
- **Secondary sources say yes.**
  - Inference APIs (verified 2026-09-16): 413 "Request too large … TPM: Limit 8000, Requested …", "leave room for the completion, which also counts".
  - dev.to (2026-09-02): "prompt: 20 tokens, max_tokens: 8192 → 413 … Requested 8271".
- **Live checks say no.** All ran on the user's 8K-TPM organization, and all calls appear in its console logs:
  - `openai/gpt-oss-20b`, 78-token prompt, `max_completion_tokens` 9,000 and then 60,000 → both 200 (`req_01m4q3mnyyexms7j0xy4q9kwb7`, `req_01m4q3n3m7ec8bjrg3x2b5sz1a`).
  - `openai/gpt-oss-120b`, 60,000 → 200 (`req_01m4q4vzyherrbp7rg7dqzr36p`).
  - `qwen/qwen3.8-27b`, 16,000 → 200 (`req_01m4q4w1z4ev6v87v11ggbzzw1`).
- **The parameter does reach Groq.** The same call with `max_completion_tokens` 5 ended `finish_reason: length` with 5 completion tokens (`req_01m4q4vfm6esq8zs8yz14zhcnp`).
- **The sources may be right about the deprecated `max_tokens`**, which they used. Glass never sends it (FR-006).

**What still counts** is the tokens actually used, prompt plus completion, within each model's per-minute and per-day budget. A single prompt larger than 8K is refused with 413 (`too-large`), so the handling stays.

**Unverified:**
- Whether a request near the TPM edge is refused on its prompt alone, or on prompt plus expected output.
- Whether the per-minute window is shared across models; one secondary source suggests it is.

T006 prints the `x-ratelimit-*` headers, and T-VERIFY-MANUAL check 9 reads `tpm_left` across two models.

**What a Glass request uses:**

| Lane | System prompt | Other input | Output | Tokens used per call |
|------|---------------|-------------|--------|----------------------|
| Live Answer | `pickle_glass_analysis`, 9,746 chars, about 2.4K tokens | Career block up to 9,000 chars (~2.3K tokens), plus 30 transcript turns | answer ≤ 900 + reasoning (tens to hundreds at `low`) | about 6–8K |
| Live Insights | transcript-based prompt | — | ≤ 1,024 + reasoning | a few K |
| Ask | `pickle_glass`, about 0.6K tokens | a screenshot (2,048 tokens on Qwen) and the question | ≤ 2,048 | about 3–5K |

**What the Free plan carries:**

| Budget | One model | `openai/gpt-oss-120b` + `openai/gpt-oss-20b` |
|--------|-----------|----------------------------------------------|
| Live Answers per minute (8K TPM) | about 1 | about 2 |
| Live Answers per day (200K TPD) | about 25–30 | about 50–60, shared with Live Insights |

Ask with a screenshot draws on Qwen's separate budget.

An interview with a question every 1–2 minutes fits the per-minute budget through failover. A second answer in the same minute moves to 20B. A long interview, or two interviews in one day, can exhaust the daily budget, and then every model answers 429 until the next day.

**Decisions:**
- **Budget (D5, FR-009).** The declared budget is no constraint, so the reasoning allowance is 1024, which leaves the caller's cap for the answer.
- **413 → `too-large`** (FR-013, FR-020): next model, no cooldown, no second round, and a message with the numbers.
- **Logging (FR-021).** Every attempt logs `tpm_left`.
- **Quickstart §1** states the user's limits and what they carry.
- **Follow-up.** Cross-provider lists (Groq first, then Claude or Gemini) are the first follow-up. They are what keeps a long interview answering when the Free budget runs out.

---

## R6: Reasoning

From the docs (reasoning page, API reference, SDK types) and the live calls:

| Family | `reasoning_effort` | Default | Reasoning text | Counts toward `max_completion_tokens` |
|--------|--------------------|---------|----------------|---------------------------------------|
| `openai/gpt-oss-*` | `low`, `medium`, `high` | `medium` (SDK docstring) | Returned by default in `message.reasoning` / `delta.reasoning`; `include_reasoning: false` turns it off. `reasoning_format` is not supported | **Yes.** Live: 48 of 58, 33 of 43 and 43 of 53 completion tokens were reasoning, for the word "ok" |
| `qwen/qwen3.8-27b` | `none`, `default`, `low`, `medium`, `high` (`high` = native `xhigh`) | "The default setting returns no reasoning tokens on Groq" (docs). The live check agrees: 2 completion tokens, no `reasoning` field | `reasoning_format` `hidden` or `parsed`; `raw` (the documented default) would put `<think>` in the content | Yes, when it reasons |
| others | — | — | — | — |

Rules from the API reference:
- `include_reasoning` and `reasoning_format` are mutually exclusive.
- An effort a model does not accept returns 400.
- `max_completion_tokens` defaults to 1024 when unset, which "may be too low for complex reasoning".

**Decisions** (D6, FR-008, FR-009):
- `gpt-oss`: effort `low`, `include_reasoning: false`. The reasoning is never on the wire, so it cannot leak into logs (C3), and the stream carries only content.
- `qwen3`: effort `none` (instruct mode: no thinking, fastest first token). Any other effort adds `reasoning_format: 'hidden'`.
- A 1024-token reasoning allowance on top of the caller's cap whenever the model reasons.
- `finish_reason: length` with no text is a failure (`EMPTY_MAX_TOKENS`) that moves on to the next model.

The reasoning page's advice to avoid system prompts is general (it dates from the DeepSeek-R1 era). Glass lanes depend on the system prompt and keep it. The live check sent a system prompt to `gpt-oss-20b` and got the expected answer. T-VERIFY-MANUAL watches for degraded answers.

---

## R7: Images

**Docs**:
- Only `qwen/qwen3.8-27b` accepts images ("Text, images"); every gpt-oss model is "Text only".
- Up to 3 images per request.
- 20 MB per request for an image URL; base64 data URLs are accepted, with no separate limit stated.
- Each image counts as 2,048 input tokens.

**Glass**: Ask attaches one JPEG screenshot as `image_url` with a data URL (`askService.js:309-312`). `askService._isMultimodalError` (`:494-506`) retries text-only, but only for synchronous `streamChat` failures, and streaming providers report errors through the body. So the provider must not send an image to a text-only model: the 400 would be `fatal-request` and end the request.

**Decision** (D8, FR-010, FR-011):
- Requests with images try the image-capable models first, in list order.
- Text-only models follow, with the images removed and the count logged (`images=dropped:N`).
- Without images, the list order stands.

So one list serves every lane: Live Answer goes to gpt-oss, and Ask with a screenshot goes to Qwen.

---

## R8: Error taxonomy

From the errors page, the API reference, R4 and R5:

| Groq error | Shape | Kind |
|------------|-------|------|
| 429 `rate_limit_exceeded` (RPM, TPM, RPD, TPD) | HTTP, `retry-after` seconds | `transient` (cooldown = `retry-after`, clamped 5 s–5 min) |
| 413 `rate_limit_exceeded`, type `tokens`, "Request too large … TPM: Limit L, Requested R" | HTTP, plain `APIError` | `too-large` (new kind) |
| 413 without that code (body too big, for example an image) | HTTP | `too-large` |
| 498 flex capacity exceeded | HTTP, plain `APIError` | `transient` (Glass does not send `flex`, so this is defensive) |
| 500, 502, 503 and other ≥ 500 | HTTP, `InternalServerError` | `transient` |
| 422 "semantic errors or model hallucinations … retry" | HTTP | `transient`, 10 s cooldown, no second round |
| 404 `model_not_found` ("does not exist or you do not have access to it") | HTTP | `unavailable` |
| 400 `model_decommissioned` | HTTP, `BadRequestError` | `unavailable`: the code is checked before the status |
| 403 with a `model_…` code (model blocked for the org or project) | HTTP | `unavailable` |
| 400 other (`invalid_request_error`) | HTTP | `fatal-request` |
| 424 failed dependency (Remote MCP) | HTTP | `fatal-request` |
| 401 `invalid_api_key`, 403 other | HTTP | `fatal-auth` |
| Mid-stream `{"error": {type, code, message}}` | `APIError`, status undefined | by `code`/`type`: rate-limit, server and overload → `transient`; `invalid_request_error` → `fatal-request` |
| `x_groq.error` string in a chunk | Provider code `STREAM_ERROR` | `transient` |
| `APIConnectionError`, `APIConnectionTimeoutError` | SDK | `transient` |
| Unknown | — | `transient` (fail-open, as Gemini and Anthropic) |

**Unverified:**
- The codes `model_not_found`, `model_decommissioned` and the `model_…` permission codes come from earlier Groq responses, not from this release's docs.
- The 403 permission code name.
- Whether Groq sends `retry-after-ms`.

The classifier matches `code` by prefix (`model_`) and falls back to the status, so a renamed code degrades to the status rule. T-VERIFY-MANUAL checks 6 and 7 hit `model_not_found` live.

---

## R9: Key validation

**Decision**: `client.models.list()` (`resources/models.js:17`, `GET /openai/v1/models`). It costs nothing and names no model. Keys start with `gsk_`. The SDK raises `AuthenticationError` on 401 and `APIConnectionError` on a network failure.

---

## R10: Which Anthropic behaviors to port

| Anthropic capability | Port? | Groq form |
|----------------------|-------|-----------|
| Ordered list, shared cooldown registry | Yes | `modelHealth.js` unchanged |
| Own classifier | Yes | `groqErrors.js`: no `refusal` kind (Groq has no refusal stop reason); new `too-large` kind |
| `_reset` / `_final_model` / `[DONE]` / `userMessage` | Yes | "All Groq models failed …" |
| First-text timeout, request deadline, idle timeout | Yes | 15 s / 45 s / 15 s (R11) |
| Second round after 2 s, 429 only on its unclamped `retry-after` | Yes | Same rule |
| `maxRetries: 0`, `timeout: 15000`, signal on every call | Yes | R4 |
| Stop at the end marker and close the connection | Yes | First chunk with `finish_reason` (R4: the SDK would wait past `[DONE]`) |
| Every call streams | Yes | R13 |
| Cancellation, `track`, `safeEnqueue` | Yes | Same |
| Attempt and request logs | Yes | Groq fields: `code`, `queue`, `tpm_left`, `images`, `effort` |
| Effort only where accepted; `max_tokens` floor 4096 | **Inverted** | Effort per family (R6); no floor, a small allowance (R5) |
| No sampling parameters | **No** | `temperature` passes through (R2) |
| Server-side refusal fallback beta | No | Groq has nothing like it |
| Consecutive same-role merge; system prompt split out | No | Chat completions accept both as they are |
| New: image routing | Yes | R7 |
| New: `x_groq.error`, `too-large` | Yes | R4, R5 |

---

## R11: Timeouts

**Live**:
- `queue_time` was 0.08–0.20 s on `gpt-oss-20b`, 0.15 s on `gpt-oss-120b`, and 0.34–1.51 s on `qwen3.8-27b` (preview).
- The console logs' TTFT, short prompts, non-streaming:
  - `gpt-oss-20b`: 0.09, 0.10 and 0.21 s.
  - `gpt-oss-120b`: 0.22 and 0.33 s. These are two earlier calls with no API key name, probably the Playground.
  - `qwen3.8-27b`: 1.51 s.
- `total_time` was 0.05–0.08 s for a few tokens.
- At the stated 500–1000 tok/s, a 900-token Live Answer streams in 1–2 s once started.

**Decision** (D11):
- First text: 15 s. Ten times the Qwen queue seen, and generous for gpt-oss at `low` effort, which reasons for tens to hundreds of tokens.
- Deadline: 45 s. It leaves room for three attempts that stall.
- Idle: 15 s.
- All three can be changed through env (`GROQ_*`).
- SC-006 checks the defaults against real `ttft` and `queue`.

---

## R12: Where retries live

Same decision and reasons as Anthropic R12: the loop owns them, not the SDK (R4).
- Immediate failover, then one more round after 2 s for fast transient failures.
- A 429 joins only when its own `retry-after` ≤ 2 s.
- Groq's `retry-after` for a TPM 429 is often a few seconds (`x-ratelimit-reset-tokens` formatted like `7.66s`), so most 429s will not join. The next model, with its own bucket, is the better bet.

---

## R13: Every call streams

Same finding and decision as Anthropic R13. The SDK timeout ends at the response headers (R4). A non-streaming completion sends its headers when the answer is written, so `chat()` would be cut at 15 s. `chat()` and `generateContent()` run the same loop and join the text (D12).

---

## R14: Which model for Glass (recommendation; SC-006 confirms)

| Lane | Needs | Recommended | Why |
|------|-------|-------------|-----|
| Live Answer | First words fast, sound answers, about 6K prompt tokens, no image | `openai/gpt-oss-120b` | Best quality on Groq for chat; ~500 tok/s; `low` effort reasons briefly; queue ~0.1 s; $0.15 / $0.60, a few cents per interview hour |
| Live Answer failover | Separate rate-limit bucket, same speed class | `openai/gpt-oss-20b` | ~1000 tok/s, half the price, weaker answers |
| Ask (screenshot) | Image input | `qwen/qwen3.8-27b` | The only vision model; `none` effort; preview, 5× the price of 120B, queue 1.5 s seen |
| Ask (text only), Live Insights | Quality | `openai/gpt-oss-120b` | Same list, list order |

**One list for Settings**: `openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b`.
- Live Answer and Live Insights use 120B, then 20B.
- An Ask with a screenshot uses Qwen (D8), then 120B without the image.

The user's key is on the Free plan (R5). The list carries about two Live Answers a minute and 50–60 a day. Groq is the fast first choice; for a long interview, another provider behind it is what keeps answers coming once the daily budget is spent. That needs cross-provider lists (Out of Scope, first follow-up).

**TTFT measurement (SC-006)**: to be recorded here after T-VERIFY-MANUAL, as p50 and p95 of `ttft`, with `queue` and `tpm_left`, over 20 Live Answers.

---

## R15: Prompt caching

**Docs**:
- Automatic, prefix-based caching on the gpt-oss models only.
- A 50% discount on cached input.
- Expires after about 2 hours unused.
- The minimum cacheable prefix is 128–1024 tokens.

The cached count is in `usage.prompt_tokens_details.cached_tokens`.

Glass lanes start with a fixed system prompt. Live Answer's first ~2.4K tokens are the same on every call until the career block. Caching therefore helps without any change, and it is logged as `cached:` (FR-021). No code beyond the log field.

---

## R16: Speech-to-text

Groq serves `whisper-large-v3` and `whisper-large-v3-turbo` through `/audio/transcriptions`, which transcribes a whole file per request. Glass's STT contract is a real-time session (`sendRealtimeInput`, used by Gemini Live, Deepgram and OpenAI Realtime). Building STT on Groq would mean chunking audio into files, a different design. **Out of scope.** `groq.js` exports a `createSTT` placeholder that warns, as `anthropic.js` does, and `sttModels` is empty.

---

## R17: To verify live (T006 probe, T-VERIFY-MANUAL)

| # | Question | Where it matters | How |
|---|----------|------------------|-----|
| V1 | Does the final streamed chunk carry `finish_reason` and `x_groq.usage` together? Does the connection close after `[DONE]`? | FR-017 | T006 prints the chunk keys and timing |
| V2 | Is `x_groq.id` in the first chunk; is the `x-request-id` header sent? | FR-021 | T006 |
| V3 | With `include_reasoning: false`, do any `delta.reasoning` chunks arrive? | C3, FR-017 | T006 |
| V4 | Is the per-minute window per model, and is a request near the edge refused on its prompt alone? Declared budget: answered, it is not metered (R5) | R5 | T006 prints `x-ratelimit-*`; quickstart §4 check 9 |
| V5 | Error codes for an unknown or retired model | R8 | quickstart §4 checks 6–7 |
| V6 | Does `reasoning_effort: 'none'` on `qwen/qwen3.8-27b` stream content straight away? | D6 | T006 |

---

## R18: Real SDK check (found in implementation)

`groq.js` ran with the real `groq-sdk` 1.6.0 against a local HTTP server that played the Groq API. `GROQ_BASE_URL` pointed the SDK at it. It ran under Node 24.17 and under Electron 30.5.1 (Node 20.16), and all 7 checks passed on both:
- **Failover.** A 503 on the first model failed over with exactly one call per model, with `x-stainless-retry-count: 0`, so the SDK did not retry.
- **Request fields.** The request carried `include_reasoning: false`, `reasoning_effort: 'low'` and the Bearer key.
- **Connection close.** The server kept the connection open after `[DONE]`, and the client closed it at `finish_reason`.
- **Images.** A request with an image went first to `qwen/qwen3.8-27b`, with the image and `reasoning_effort: 'none'`.
- **Cancel** closed the HTTP connection.
- **413.** A 413 on the only model gave the user message with the numbers.
- **`chat()`** failed over and joined the text.
- **Key validation.** `models.list()` sent `GET /openai/v1/models`.
- **Logs.** The lines carried `request_id`, from `x_groq.id` or `x-request-id`, and `tpm_left`, with no answer text.

The live probe (T006) still decides R17 V1–V6 against the real API.

---

## Summary of Decisions

| # | Decision |
|---|----------|
| R1 | New provider; nine registration points; consumers untouched |
| R2 | Presets `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `qwen/qwen3.8-27b`; slash → Groq |
| R3 | `groq-sdk` ^1.6.0, added first and alone |
| R4 | `maxRetries: 0`; quiet abort; stop at `finish_reason` (the SDK reads past `[DONE]`); two error-body shapes |
| R5 | Free plan (8K TPM, 200K TPD per model; upgrades closed); declared budget not metered (live); `too-large` kind; `tpm_left` logged; cross-provider lists next |
| R6 | gpt-oss `low` + `include_reasoning: false`; qwen `none` (+ `hidden` otherwise); 1024-token allowance |
| R7 | Image-capable models first for image requests; images dropped for text-only models |
| R8 | Own classifier: `transient`, `unavailable`, `too-large`, `fatal-request`, `fatal-auth` |
| R9 | Validate with `models.list`, `gsk_` prefix |
| R10 | Port the Anthropic loop; invert the token rule; no refusal fallback |
| R11 | 15 s first text, 45 s deadline, 15 s idle |
| R12–R13 | Retries in the loop; every call streams |
| R14 | `openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b` |
| R15 | Prompt caching is automatic; log cached tokens |
| R16 | No STT |
| R17 | Six live checks before calling it done |
| R18 | The provider ran with the real SDK against a local fake API under Node and Electron: 7/7 |

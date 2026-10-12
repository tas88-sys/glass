---
# Context Optimization Metadata
# Purpose: Enable efficient partial reads (~200 tokens vs ~2500 for full file)
meta:
  spec_id: 2026-10-12-groq-provider
  spec_name: groq-provider
  status: in-progress    # draft | in-progress | approved | completed
  phase: implement          # specify | clarify | plan | tasks | preflight | feature-start | implement | verify
  created: 2026-10-12
  updated: 2026-10-12

# Quick Reference (for checkpoint resume)
summary:
  goals:
    - {id: G1, description: "Groq models work in every LLM lane (Ask, Live Answer, Live Insights) through a new 'groq' provider: key saved in Settings and onboarding, model list typed in Settings", priority: HIGH}
    - {id: G2, description: "The Groq path is as resilient as the Anthropic path (PR #13): ordered model list with cooldowns, failover on transient errors, timeouts that bound a stalled request, cancellation that stops the HTTP request, a short error the user can read, one log line per attempt", priority: HIGH}
    - {id: G3, description: "Gemini, Anthropic, OpenAI, Ollama and Whisper behave exactly as today", priority: HIGH}
  constraints:
    - {id: C1, description: "The SSE protocol the consumers read (_reset, _final_model, [DONE], err.userMessage) is reused as is. askService.js, askStreamState.js and summaryService.js are not edited", type: TECHNICAL}
    - {id: C2, description: "gemini.js, anthropic.js, anthropicErrors.js, geminiModelRotator.js, modelHealth.js and their tests are not edited. modelHealth.js is reused as is", type: SCOPE}
    - {id: C3, description: "Never log prompt, answer or reasoning text (existing invariant). Logs carry model, outcome, status, error code, timings, token counts, rate-limit headroom and request id only", type: SECURITY}
    - {id: C4, description: "Every Groq API call goes through the official groq-sdk, key validation included. The SDK (^1.6.0, no dependencies) is added as the first task, on its own, and must load and stream under Electron 30's Node 20.16 (research R3)", type: TECHNICAL}
    - {id: C5, description: "Never send a parameter the target model rejects: no logprobs/logit_bias/top_logprobs/messages[].name/n; reasoning_effort only to reasoning families and only with a value that family accepts; reasoning_format and include_reasoning never together; images only to models that accept them", type: TECHNICAL}
    - {id: C6, description: "Tests run under npm test (node:test, plain Node) with the SDK mocked. No live API call in the suite", type: TECHNICAL}
    - {id: C7, description: "The user's Groq organization is on the Free plan, and Developer upgrades are closed: 30 RPM, 1K RPD, 8K TPM and 200K TPD per model (console, 2026-10-12, research R5). A 413 'request too large' (one prompt over the model's TPM) and a 429 are handled per model, never as a fatal error, and every attempt logs the token headroom left", type: TECHNICAL}
  decisions:
    - {id: D1, decision: "Same model-list contract as Gemini and Anthropic: the selected LLM model may be a comma-separated list of Groq IDs, tried in order with cooldowns", rationale: "The stored value already passes through modelStateService and the factory unchanged; users already know the CSV"}
    - {id: D2, decision: "A model ID or CSV whose first entry has the form '<vendor>/<model>' (contains '/', not 'claude-…' or 'gemini-…') maps to Groq. Installed Ollama models are matched first, as today", rationale: "Every current Groq chat model is namespaced (openai/gpt-oss-120b, qwen/qwen3.8-27b); the two un-namespaced Llama IDs are retired for free and developer tiers (research R2). No other provider in Glass uses a slash"}
    - {id: D3, decision: "groq.js gets its own failover loop modelled line by line on anthropic.js (runAttempt, runWithFailover, waitOrAbort, logAttempt, logRequest, track/untrack, safeEnqueue). Groq gets its own classifier, groqErrors.js. No shared engine in this spec", rationale: "Same choice and reasons as the Anthropic spec D3: anthropic.js has not run in real sessions yet (its T-VERIFY-MANUAL is pending), and extracting a shared engine now means editing it (C2). Extraction is the named follow-up once both have live logs"}
    - {id: D4, decision: "The SDK never retries (maxRetries: 0); its timeout (time until response headers) is 15 s. The loop fails over at once, and when every model has failed fast it gives them one more round after 2 s, within the request deadline", rationale: "groq-sdk waits out the server's retry-after inside the attempt with an uncancellable setTimeout and no cap (research R4), the same trap as Anthropic SDK 0.56.0"}
    - {id: D5, decision: "max_completion_tokens = caller cap (else GROQ_MAX_TOKENS, else 2048) plus a reasoning allowance (GROQ_REASONING_TOKENS, default 1024) when the model reasons at the chosen effort, capped at the model's maximum. No 4096 floor as in Anthropic", rationale: "Reasoning tokens count toward max_completion_tokens: a 5-token cap on gpt-oss-20b ended with finish_reason length and no text (live check R6). The allowance keeps a caller's 900 for the answer itself. The declared value is not metered against TPM (live: 60,000 declared on an 8K-TPM org returned 200, R5), so a generous allowance costs nothing; only the tokens actually used count"}
    - {id: D6, decision: "Reasoning per family. gpt-oss: reasoning_effort low (GROQ_REASONING_EFFORT overrides; low|medium|high), include_reasoning false. qwen3: reasoning_effort none (none|default|low|medium|high), plus reasoning_format hidden when not none. Any other model: no reasoning field", rationale: "Every lane has someone waiting. gpt-oss returns its reasoning text by default (live check), which Glass never shows and must never log. qwen3.8's instruct mode answers with no thinking at all (research R6)"}
    - {id: D7, decision: "temperature is passed through when the caller gives a number in [0, 2]; no other sampling parameter is sent", rationale: "Every current Groq chat model lists temperature as supported (live models.list, R2); the lanes pass 0.7, which is also qwen3.8's recommended instruct-mode value"}
    - {id: D8, decision: "Image routing: when the request carries an image, models that accept images are tried first (in list order), then text-only models with the images removed and counted in the log. Without images the list order is kept", rationale: "Only qwen/qwen3.8-27b accepts images (R7). A text-only model returns 400 on an image part, which would end the request. Ask already falls back to text-only on multimodal errors (askService._isMultimodalError), so dropping the image is the app's existing intent"}
    - {id: D9, decision: "Key validation lists models (GET /openai/v1/models) through the SDK; the key must start with gsk_", rationale: "Free, names no model, so a deprecation cannot break it (R9)"}
    - {id: D10, decision: "Presets: openai/gpt-oss-120b, openai/gpt-oss-20b, qwen/qwen3.8-27b. Default model openai/gpt-oss-120b. No STT model", rationale: "The three chat models active on the user's key on 2026-10-12 (live models.list). Groq's Whisper is batch-only and Glass needs real-time STT (R16)"}
    - {id: D11, decision: "Timeouts: first text within 15 s; an answer must start within 45 s for the whole request; once text streams, 15 s without a chunk aborts the attempt. Each has an env override", rationale: "Groq answers in well under a second when healthy (live queue_time 0.08–1.5 s, 500–1000 tok/s). A 15 s silence means queueing or a stall, and another model is the better bet (R11)"}
    - {id: D12, decision: "chat() and generateContent() stream internally through the same loop as streamChat and join the text", rationale: "Same as Anthropic D12: the SDK timeout covers only the wait for headers, and a non-streaming response sends them at the end (R13)"}
    - {id: D13, decision: "Add groq-sdk ^1.6.0 as the first task, in its own commit, before any provider code; verified by loading it and streaming a canned response under Electron's Node 20.16", rationale: "Mirrors Anthropic T005. groq-sdk 1.6.0 (2026-08-25) has no dependencies and declares Node 20 LTS or later (R3)"}

# CRITICAL REQUIREMENTS - Must verify during implementation
# These survive context compaction and generate T-VERIFY tasks
critical_requirements:
  type: feature-major    # bugfix | feature-minor | feature-major | config | documentation | refactoring
  portal: app            # superadmin | admin | app | public | none
  ui_changes: minor      # none | minor | moderate | major
---

# Feature Specification: Groq Provider

**Feature Branch**: `2026-10-12-groq-provider`
**Created**: 2026-10-12
**Status**: In progress
**Input**: User request (2026-10-12): "The plan now is to do exactly what was implemented in the last PR, following the same steps, criteria and structure, but to implement a new provider: groq.com. Create the plan for it. If in doubt about supported models, documentation, API or payload: composio.dev or https://console.groq.com/docs/overview. Also tell me the best model to use in the app for the live interview, Ask, etc." (translated from Portuguese)

---

## System Context

**Systems**: Framework-internal. The Glass Electron main process: the AI factory and a new provider, `modelStateService`, `settingsService`, and the Settings and onboarding views in the renderer.
**Databases**: None changed. `provider_settings` already keys rows by a free-text `provider` (no enum, `src/features/common/config/schema.js:92`), so a `groq` row needs no migration. The selected model is stored, as today, in `selected_llm_model` (one string, possibly a CSV).
**Integrations**: Groq chat completions (`POST /openai/v1/chat/completions`) and models (`GET /openai/v1/models`) through `groq-sdk`, a new dependency (FR-023).
**Key Architecture**: Same three lanes as the Anthropic spec. Ask streams (`askService.js:315`, no `maxTokens`, a JPEG screenshot as an `image_url` data URL). Live Answer streams (`summaryService.js:380`, `maxTokens: 900`). Live Insights calls `chat()` (`summaryService.js:813`, `maxTokens: 1024`). All pass `temperature: 0.7`. Streaming providers return a `Response` whose body is SSE in the OpenAI delta shape plus `_reset`, `_final_model` and `[DONE]`. The consumers do not read `_reset.reason` beyond passing it along (`summaryService.js:270`), so a new reason value is safe. Settings and onboarding list providers from `PROVIDERS` (`SettingsView.js:1296`, `ApiKeyHeader.js:431-455`), so a new entry appears in both without view changes beyond the model input.

Glass has no Groq code today (research R1).

---

## Clarifications

### Session 2026-10-12

- Q: Same structure as PR #13? → A: Yes. Same spec set, same order (SDK first and alone, tests before each module, pure pieces, loops, wiring, docs, live checks), same resilience contract and the same consumer protocol.
- Q: Which SDK? → A: The official `groq-sdk` (D13, research R3). The `openai` package already in Glass would also reach Groq through `baseURL`, but it is three majors behind (4.104 against 7.32), parses Groq's stream errors differently, and would tie the Groq path to the OpenAI provider's upgrade schedule.
- Q: Share the failover engine with Anthropic now? → A: Not in this spec (D3). It would edit `anthropic.js` before that code has run live.
- Q: Which model for interviews and Ask? → A: Research R14: `openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b`. Screenshots route to Qwen (D8). Confirmed by the TTFT measurement (SC-006).
- Q: Can the user's key carry a whole interview? → A: Only just. The organization is on the Free plan (console, 2026-10-12), and Developer upgrades are "temporarily unavailable due to high demand". Each model has its own budget of 8K tokens per minute and 200K per day. Cached tokens do not count against the limits, and the app's fixed ~2.4K-token prompt prefix is cached after the first call. That leaves about 3.5K per Live Answer and 2.5K per Live Insights. A one-hour interview uses about 115–390K tokens, typically ~240K, of the 400K a day the two text models share. So one interview of about an hour fits: 120B runs out after 40–50 minutes in the typical case and 20B answers the rest. Two interviews in one day probably do not fit. Per minute, two answers fit on 120B, and a third call in that minute moves to 20B. Research R5 has the arithmetic.

  The live checks also showed that the declared `max_completion_tokens` is not metered. That contradicts the secondary sources. Only the tokens actually used count.

**Deferred (default chosen, not blocking)**:
- Mixing providers in one list (Groq first, then Claude or Gemini). Default: not in this spec; the Settings validator keeps lists single-provider. With the Free plan's 8K TPM and 200K TPD per model, this is what lets a long interview survive the budget running out, so it is the first follow-up.
- Per-lane model list and effort. Default: one list and one effort for every lane.

---

## User Scenarios & Testing *(mandatory)*

### Primary User Story
The user saves a Groq key (`gsk_…`) and types `openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b` as the Groq LLM model list in Settings. During a call, Live Answer streams from GPT-OSS 120B within about a second. When 120B returns 429, the panel shows "Trying openai/gpt-oss-20b…", and the answer arrives from 20B. An Ask with a screenshot goes to Qwen 3.8, the only model in the list that can see it. The log shows one line per attempt, with time in queue and remaining token budget. Asking a new question before the previous answer finishes aborts the previous HTTP request.

### Acceptance Scenarios
1. **Given** a valid Groq key, **When** the user saves it, **Then** it is accepted without calling any model, and an invalid key shows "Invalid Groq API key."
2. **Given** each preset, **When** Ask, Live Answer or Live Insights runs, **Then** the answer text appears, the request carries `stream: true` and `max_completion_tokens`, and no reasoning text is forwarded or logged.
3. **Given** a list of two models and a 429 or 503 on the first, **When** a streaming request runs, **Then** the consumer receives one `_reset` naming the second model, the answer from the second, `_final_model` = second, and `[DONE]`.
4. **Given** an Ask with a screenshot and the list `openai/gpt-oss-120b,qwen/qwen3.8-27b`, **When** it runs, **Then** Qwen is tried first with the image; if Qwen fails, GPT-OSS 120B answers without the image, and the log says `images=dropped:1`.
5. **Given** a 413 "Request too large … on tokens per minute (TPM): Limit 8000, Requested 9400", **When** it happens on the first of two models, **Then** the second is tried at once with no cooldown on the first. On the last model the user reads "<model> — request needs 9400 tokens; this key allows 8000 per minute. This request alone is over the limit: shorten the context or use a higher Groq tier."
6. **Given** a request that is wrong for every model (400) or a bad key (401), **When** it happens, **Then** no other model is tried and the error shows the model and the server's reason.
7. **Given** the consumer cancels (new Ask, Live Answer replaced), **When** a request is in flight or failover is waiting, **Then** the HTTP request is aborted, no other model is tried, and no stream error is raised.
8. **Given** a decommissioned or unknown model typed in Settings, **When** a request runs, **Then** it fails over if another model is listed, and otherwise the user sees "<model> is not available to this API key (decommissioned, blocked or not found). Pick a current model in Settings."
9. **Given** a single model that returns 503 twice, **When** a streaming request runs, **Then** the SDK does not retry; the stream sends `_reset` with `reason: 'retry'`, waits 2 s, tries once more, then reads "All Groq models failed (2 attempts, 2 rounds) …".

### Edge Cases
- A chunk carries `x_groq.error` (the stream was stopped early): transient, `_reset`, next model.
- A mid-stream `data: {"error": …}`: the SDK throws an `APIError` with no status; classified by its `type`/`code`.
- `finish_reason: length` with no text: a failure ("used its whole token budget before answering"), failover. With text: success, logged `stop=length`.
- The SDK keeps reading after `[DONE]` until the server closes the connection (research R4): the attempt stops at the chunk with `finish_reason` and aborts the connection.
- An installed Ollama model named `namespace/model`: still maps to Ollama (installed names are matched first).

See `contracts/EDGE_CASES.md` for the full list.

## Requirements *(mandatory)*

### Functional Requirements

**Provider, model selection and key**
- **FR-001**: `factory.js` MUST register `groq` (`name: 'Groq'`, handler `./providers/groq`) with LLM presets `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `qwen/qwen3.8-27b`, and `sttModels: []`. `getProviderClass('groq')` MUST return `GroqProvider`. The default model in `groq.js` MUST be `openai/gpt-oss-120b`. No preset is a model retired for free or developer tiers (`llama-3.1-8b-instant`, `llama-3.3-70b-versatile`, `qwen/qwen3-32b`, `qwen/qwen3.6-27b`, `meta-llama/llama-4-*`, `moonshotai/*`, `groq/compound*`).
- **FR-002**: `inferProviderFromModelId` MUST return `'groq'` when the first CSV entry contains `/`, has no whitespace, and does not start with `claude-` or `gemini-`. Its existing results are unchanged. `modelStateService.getProviderForModel` MUST return `groq` for such IDs for `llm` only, after the preset and installed-Ollama checks. `getAvailableModels` MUST show a stored custom Groq value as "(custom)", as for Gemini and Anthropic. `SettingsView.getProviderForModel` MUST apply the same rule after its Ollama check.
- **FR-003**: Settings MUST offer a "Groq LLM Model ID" input, help line and "Save Groq Models" button under the Groq key. The CSV is normalized as Gemini's is (split on `,`, trim, drop empties). The validator MUST reject any entry without `/` or starting with `claude-` or `gemini-`, naming the entry.
- **FR-004**: `GroqProvider.validateApiKey` MUST check the `gsk_` prefix, then call `client.models.list()` through the SDK (`maxRetries: 0`, `timeout: 15000`). 2xx means valid. 401 MUST return "Invalid Groq API key." Other statuses return the server's message. A network failure returns "A network error occurred during validation." It never throws.
- **FR-005**: `settingsService.removeApiKey` MUST remove the Groq key with the others. `SettingsView`'s `apiKeys` state MUST include `groq`. The onboarding footer MUST name Groq among the key sources.

**Request building (pure `buildRequest`)**
- **FR-006**: Every request MUST carry `model`, `messages`, `stream: true` and `max_completion_tokens`. It MUST NOT carry `max_tokens`, `logprobs`, `logit_bias`, `top_logprobs`, `n`, `top_p`, `stream_options`, `service_tier`, `tools`, `response_format`, or a `name` on any message.
- **FR-007**: `temperature` MUST be sent when the caller passes a finite number in [0, 2], and omitted otherwise.
- **FR-008**: Reasoning MUST follow `modelTraits(modelId).reasoning`:
  - `gpt-oss` (`openai/gpt-oss-…`): `reasoning_effort` from `opts.effort`, else `GROQ_REASONING_EFFORT`, else `low` (accepted: `low|medium|high`), and `include_reasoning: false`.
  - `qwen3` (`qwen/qwen3…`): `reasoning_effort` from the same sources, else `none` (accepted: `none|default|low|medium|high`); when it is not `none`, `reasoning_format: 'hidden'`. `include_reasoning` is never sent.
  - any other model: no `reasoning_effort`, `reasoning_format` or `include_reasoning`.
  A value the family does not accept is ignored.
- **FR-009**: `max_completion_tokens` MUST be the caller's `maxTokens` (else `GROQ_MAX_TOKENS`, else 2048), plus `GROQ_REASONING_TOKENS` (default 1024) when the model reasons at the resolved effort (`gpt-oss` always, `qwen3` when not `none`), capped at the model's maximum output (65,536 for `gpt-oss`, 16,384 for `qwen/qwen3.8-27b`; no cap for unknown models).
- **FR-010**: Messages MUST map Glass shapes to chat-completions shapes. Roles `system`, `user` and `assistant` keep their order. A string or text part stays text, and empty text is dropped. An `image_url` part is kept only when `modelTraits(modelId).vision`, at most 3 per request (the first 3), and the rest are dropped and counted. `generateContent(parts)` maps strings to text parts and `inlineData` to `image_url` data URLs, all in one user message, with no "You are" promotion. Content with no image left is sent as one string (text parts joined with a newline). A message with no content left is dropped.
- **FR-011**: When the request carries at least one image, the attempt order MUST put the models that accept images first (in list order), then the others. Without images the order is the list's.

**Failover and stream**
- **FR-012**: Streaming and non-streaming calls MUST try the list through the shared health registry (`modelHealth.js`, unchanged): skip a model in cooldown; when every model is cooling down, try the one that recovers first.
- **FR-013**: Errors MUST be classified by `groqErrors.classify(err)` into `transient`, `unavailable`, `too-large`, `fatal-request` or `fatal-auth` (table in `data-model.md`).
  - `transient` cools the model down (retry-after, else 60 s, clamped 5 s–5 min; 10 s for the provider's own timeouts, `EMPTY_MAX_TOKENS` and 422) and fails over.
  - `unavailable` cools it down for 5 min and fails over.
  - `too-large` fails over with no cooldown.
  - `fatal-*` ends the request at once.
- **FR-014**: Before moving to the next model, the stream MUST send `{ _reset: true, next_model, reason }`, where `reason` is one of `transient`, `timeout`, `unavailable` or `too-large`, or `retry` before a second round. It is sent only when another attempt follows. On success the stream MUST send `{ _final_model }` and then `[DONE]`.
- **FR-015**: An attempt with no text after `firstTextTimeoutMs()` (15 s; `GROQ_FIRST_TEXT_TIMEOUT_MS` overrides) MUST be aborted and treated as transient with a 10 s cooldown. The request MUST stop trying new attempts once `requestDeadlineMs()` (45 s; `GROQ_REQUEST_DEADLINE_MS`, 0 disables) passes with no answer started. Each attempt's timeout is cut to what is left of the deadline. An answer that is streaming is never cut by the deadline.
- **FR-016**: Once text streams, an attempt with no chunk for `idleTimeoutMs()` (15 s; `GROQ_IDLE_TIMEOUT_MS`, 0 disables) MUST be aborted and treated as transient.
- **FR-017**: Chunk handling:
  - The text is `choices[0].delta.content`. `delta.reasoning` is ignored: never forwarded, never logged.
  - At the first chunk with a `choices[0].finish_reason`, the attempt MUST record it, record `usage` from `x_groq.usage` (else `chunk.usage`), stop reading and close the connection.
  - `length` with no text is a failure (`EMPTY_MAX_TOKENS`); with text it is a success.
  - A chunk with `x_groq.error` is a transient failure (`STREAM_ERROR`).
  - A stream that ends with no `finish_reason` is a transient failure.
- **FR-018**: Cancelling the returned stream MUST abort every in-flight SDK request through its `AbortSignal`, stop failover, and raise no stream error. Every enqueue MUST be guarded against a closed controller.
- **FR-019**: Every SDK call MUST pass `maxRetries: 0` and `timeout: 15000`.
  - When every model of the first round has failed, the models whose failure was transient and fast MUST get one more round after 2 s, announced with `_reset` `reason: 'retry'`.
  - "Fast" excludes timeouts, `EMPTY_MAX_TOKENS`, `STREAM_ERROR`, 422, `unavailable`, `too-large`, and a 429 whose `retry-after` is longer than the 2 s wait.
  - The round is skipped when the deadline leaves less than the wait. A cancel during the wait stops it.

**Errors and logs**
- **FR-020**: The error raised at the end MUST carry `userMessage`:
  - fatal errors: `<model> — <reason>`;
  - list exhausted: `All Groq models failed (<n> attempts[, 2 rounds]). Last: <model> — <reason>`;
  - deadline hit: `No answer within <s> (<n> attempts). Last: …`;
  - `unavailable`: `<model> is not available to this API key (decommissioned, blocked or not found). Pick a current model in Settings.`;
  - `too-large`: `<model> — request needs <R> tokens; this key allows <L> per minute. This request alone is over the limit: shorten the context or use a higher Groq tier.` When the numbers cannot be read, it shows the server's reason instead.
  The `unavailable` and `too-large` texts stand alone after a single attempt and follow `Last:` otherwise. Reasons are the server's message with SDK noise removed, at most 160 characters.
- **FR-021**: Each attempt MUST log one line, `[Groq Provider] attempt i/n <stream|once> model=… outcome=…`, with these fields when present: `status`, `code`, `ttft`, `last`, `total`, `chunks`, `stop`, `effort`, `images=sent:N` or `images=dropped:N`, `tokens=in:…,out:…,reasoning:…,cached:…`, `queue=<ms>`, `tpm_left` (from `x-ratelimit-remaining-tokens`), `served_by` when the chunks name another model, and `request_id` (`x_groq.id`, else the `x-request-id` header). Each request MUST log a summary line `request … answered_by=… attempts=… total=…`, plus `order=vision-first` when image routing changed the order and `cancelled` when cancelled. No log line contains prompt, answer or reasoning text (C3).

**Non-streaming**
- **FR-022**: `chat()` and `generateContent()` MUST use the same list, image routing, classification, request building, second round and finish rules. They MUST join the text and return `_modelUsed`. They stream internally (D12). A failed attempt's partial text is dropped.

**SDK**
- **FR-023**: `package.json` MUST depend on `groq-sdk` `^1.6.0`, with the lockfile updated in the same commit. Under Electron's Node (`ELECTRON_RUN_AS_NODE=1`), the SDK MUST load with `require` and build a client. It MUST stream a canned SSE response through a custom `fetch`, raise `RateLimitError` (status 429) on a 429 and an `APIError` with no status on a mid-stream `{"error": …}`, and end the iteration quietly on abort. The existing suite MUST pass with only this change.

**Unchanged**
- **FR-024**: `modelHealth.js`, `anthropic.js`, `anthropicErrors.js`, `gemini.js`, `geminiModelRotator.js` and their tests MUST NOT change. `inferProviderFromModelId` keeps every existing result, so the existing `factory.test.js` assertions pass unedited.

### Success Criteria
- **SC-001**: With a valid key, the following each return an answer on `openai/gpt-oss-120b`, `openai/gpt-oss-20b` and `qwen/qwen3.8-27b`: Ask (with a screenshot, which routes to Qwen), Live Answer and Live Insights. Checked by hand, quickstart §3.
- **SC-002**: `npm test` passes, with the new Groq tests and the whole existing suite unchanged.
- **SC-003**: A scripted 429 on the first of two models gives exactly one `_reset`, the second model's text, `_final_model` set to the second model, and `[DONE]` (automated).
- **SC-004**: Cancelling the stream aborts the in-flight request's signal within one event-loop turn (automated).
- **SC-005**: No request body built by the provider contains a forbidden field (FR-006), reasoning fields outside their family (FR-008), or an image for a text-only model (FR-010) (automated, every preset plus an unknown model).
- **SC-006**: Time to first token for Live Answer on the chosen list is measured over 20 answers in a real session and recorded in `research.md` R14 (p50, p95), with `queue` and `tpm_left` from the same lines. This is a report, not a gate.

### Key Entities *(include if feature involves data)*
- **Model list**: the stored `selected_llm_model` string, parsed by `parseModelList`.
- **Model traits**: `{ reasoning: 'gpt-oss' | 'qwen3' | null, vision, maxOutput }` per model ID, from a static table.
- **Health entry**: `{ cooldownUntil }` per model ID in the shared registry (unchanged).
- **Error kind**: output of `groqErrors.classify`.
- **Attempt stats**: what one attempt records for its log line.
- **Request params**: the body the provider sends, built by a pure function.

See `data-model.md`.

### External Dependencies & Risk Assessment *(mandatory)*

| Dependency | Type | Risk Level | Quota/Limits | Fallback Behavior |
|------------|------|------------|--------------|-------------------|
| Groq chat completions | SDK/HTTP streaming | **HIGH** | The user's org is on the Free plan, per model: 30 RPM, 1K RPD, 8K TPM, 200K TPD (console, 2026-10-12). Developer upgrades are closed. Only tokens actually used are metered (R5) | Next model (each has its own bucket), then one more round; `too-large` and rate-limit `userMessage`s name the limit |
| `groq-sdk` ^1.6.0 (new) | Library, 0 dependencies, ~2 MB on disk | LOW | — | Added alone and checked under Electron's Node first (FR-023); revert is one commit |
| `qwen/qwen3.8-27b` (preview) | Model | MED | Preview: "for evaluation purposes only"; queue time 1.5 s in the live check | Only Ask with screenshots relies on it; text-only models answer without the image (D8) |

**HIGH-RISK Dependency Checklist**:
- [x] Quota-limited, paid API → mocked in every test; the manual checks cost fractions of a cent.
- [x] Model churn (Groq retired 10 models in 2026, 7 of them chat models, R2) → key validation names no model; `unavailable` errors tell the user to pick a current model; presets are only the three active chat models.
- [x] Free-plan TPM and TPD → failover across models with separate budgets, `too-large` handled per model, `tpm_left` logged on every attempt. A budget that runs out mid-interview is not solved here; cross-provider lists are the follow-up.

### Test Strategy *(mandatory)*

The provider is tested the way `anthropic.test.js` tests Anthropic. `Module._load` intercepts `groq-sdk` and returns a fake client whose `chat.completions.create` replays scripted chunk sequences and errors. The fake records the params and the signal it received, and re-exports the real SDK error classes. Classification and request building are pure and table-tested.

**Test Type Classification**:
| FR | Primary Test Type | Reason |
|----|-------------------|--------|
| FR-001, FR-002 | Unit | Presets and prefix mapping (pure factory helper) |
| FR-003, FR-005 | Manual + build | Settings and onboarding views (renderer); `settingsService` list checked by grep |
| FR-004 | Unit (mocked SDK) | 200, 401, network error, prefix |
| FR-006–FR-011 | Unit (table) | `buildRequest`, `modelTraits`, `orderForImages` |
| FR-012–FR-019 | Integration (mocked SDK stream) | Failover, sentinels, timeouts, cancel, rounds, finish rules |
| FR-013 | Unit (table) | `classify` over real SDK error shapes |
| FR-020, FR-021 | Integration | `userMessage` text, log fields, no text in logs |
| FR-022 | Integration (mocked SDK) | Non-streaming failover and text join |
| FR-023 | Smoke (Electron's Node) + existing suite | The dependency alone, before any provider code |
| FR-024 | Existing tests + diff guard | Nothing else changes |
| SC-001, SC-006 | Manual (live key) | Real API |

**Distribution Estimate**:
- Feature type: [x] Backend logic with a small settings UI change
- Unit: ~45% | Integration: ~45% | Contract: 0% | E2E/Manual: ~10%

**HIGH-RISK API Warning**:
- [x] Feature calls a quota-limited API → the suite never calls it; manual checks only, with the user's approval.

**Estimated Test Count**: ~130–150 test cases across 3 new test files plus additions to `factory.test.js`. The Anthropic spec estimated 50–60 and shipped 180.

### Error Handling & Recovery *(mandatory if feature can fail)*

**Error Scenarios**:
| Error Scenario | Type | User Message | Recovery Action |
|----------------|------|--------------|-----------------|
| 429 rate limit (RPM/TPM/RPD/TPD) | Transient | "Trying <next>…"; on the last model "All Groq models failed … <server reason>" | Cooldown from `retry-after`, next model; second round only if `retry-after` ≤ 2 s |
| 413 request larger than TPM | Too large | "Trying <next>…" / "request needs R tokens; this key allows L per minute …" | Next model, no cooldown, no second round |
| 5xx / 498 / network | Transient | "Trying <next>…" | Next model; one more round after 2 s |
| `x_groq.error` or `{"error"}` mid-stream | Transient | Partial discarded, "Trying <next>…" | Next model |
| No text before first-text timeout | Transient | "Trying <next>…" / "No answer within 45s …" | Next model, 10 s cooldown |
| 422 | Transient | "Trying <next>…" | Next model, 10 s cooldown, no second round |
| 404, or code `model_not_found` / `model_decommissioned` / `model_…` | Unavailable | "<model> is not available to this API key …" | 5 min cooldown, next model |
| 400 / 424 | Fatal request | "<model> — <server reason>" | None (bug or bad input) |
| 401 / 403 | Fatal auth | "<model> — <server reason>" | None (fix key or permissions) |
| Consumer cancels | Expected | None | Abort in-flight request, stop |

**Error/Rescue Registry**:
| Method/Codepath | What Can Go Wrong | Exception Class | Rescued? | Rescue Action | User Sees |
|-----------------|-------------------|-----------------|----------|---------------|-----------|
| `streamChat` attempt | API error before stream | `Groq.APIError` subclasses | Y | Classify → failover or surface | `_reset` or `userMessage` |
| `streamChat` attempt | `{"error"}` mid-stream | `APIError` (status undefined) | Y | Classify by `error.type` / `error.code` | `_reset` or `userMessage` |
| `streamChat` attempt | `x_groq.error` chunk | Provider error `STREAM_ERROR` | Y | Transient | `_reset` or `userMessage` |
| `streamChat` attempt | Our timeout | Quiet SDK abort (no throw) | Y | Detected by attempt flag | `_reset` or `userMessage` |
| `chat` / `generateContent` | same as above | same | Y | Same classification | thrown error with `userMessage` |
| `validateApiKey` | 401 / network | `AuthenticationError` / `APIConnectionError` | Y | `{ success: false, error }` | Settings message |

**Failure Modes Registry**:
| Codepath | Failure Mode | Rescued? | Test? | User Sees? | Logged? |
|----------|-------------|----------|-------|------------|---------|
| stream attempt | transient | Y | Y | retrying status | attempt line |
| stream attempt | timeout | Y | Y | retrying status | attempt line |
| stream attempt | too-large | Y | Y | retrying status / error | attempt line |
| stream | all models fail | Y | Y | `userMessage` | attempt + request lines |
| stream | cancel | Y | Y | nothing | request line `cancelled` |

*No row has Rescued=N.*

**Multi-Phase Operations**: None. Each request is independent; the registry only holds cooldown timestamps in memory.

### UI/Design Reference *(mandatory)*

**Feature Classification**:
- [x] **Minor UI** (< 3 components, existing patterns only)

**Design Reference**:
- Settings (`src/ui/settings/SettingsView.js`, provider key list at `:1296`): a "Groq LLM Model ID" input, help line (example `openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b`) and "Save Groq Models" button under the Groq key, copying the Anthropic block (`:1392-1404`). No STT input.
- Onboarding (`src/ui/app/ApiKeyHeader.js`): Groq appears in the LLM provider list from `PROVIDERS`; it is LLM-only like Anthropic, so the STT provider stays a separate choice (`:573`). The footer (`:2070`) names Groq.
- Ask and Live Answer views are unchanged; they already show "Trying <model>…" and the answering model.

### Permissions & Access Control *(mandatory)*

**Portal Placement**: [x] Application Portal (local Electron app).
**User Roles Affected**: [x] Local desktop user (single actor).
**Data Scoping**: [x] User-scoped. When the user selects a Groq model, prompts, transcript excerpts, career context and screenshots go to Groq, the same data path Gemini and Anthropic use. The API key stays in the local settings DB.

### Architecture Context *(mandatory if feature has business logic)*

```
src/features/common/ai/
  factory.js                 EDIT  'groq' entry; getProviderClass map; inferProviderFromModelId('vendor/model')
  __tests__/factory.test.js  EDIT  add Groq cases (existing assertions unchanged)
  providers/
    modelHealth.js           REUSE (unchanged)
    groqErrors.js            NEW   classify, retryAfterMs, retryAfterHeaderMs, shortErrorMessage, tooLargeNumbers
    groq.js                  NEW   GroqProvider.validateApiKey (models.list), modelTraits, buildRequest (pure),
                                   orderForImages, createLLM (failover), createStreamingLLM (failover stream)
    __tests__/groq.test.js, groqErrors.test.js, groqRequest.test.js     NEW
package.json, package-lock.json                     EDIT  groq-sdk ^1.6.0 (first task, own commit)
scripts/smoke-groq-sdk.js                           NEW   load + stream a canned SSE response under Electron's Node
scripts/probe-groq-stream.js                        NEW   one live streamed request, prints chunk shape only (T006, needs a key)
src/features/common/services/modelStateService.js   EDIT  groq in getProviderForModel (llm) and the custom-list branch
src/features/settings/settingsService.js            EDIT  'groq' in removeApiKey's provider list
src/ui/settings/SettingsView.js                     EDIT  Groq model input + validator; apiKeys.groq; slash rule
src/ui/app/ApiKeyHeader.js                          EDIT  footer text only
docs/…                                              EDIT  provider docs and diagrams (T-DOC-GATE)
```

---

## Out of Scope / Future Work

- **Cross-provider lists** (for example `openai/gpt-oss-120b,claude-haiku-5-5`). This is the real answer to a free-tier key running out mid-interview. It needs a provider-aware loop.
- **A shared failover engine for Anthropic and Groq.** Revisit once both have attempt logs from real sessions. The same goes for the retry-after parsing duplicated in `anthropicErrors.js` and `groqErrors.js`.
- **Model traits from the live catalog.** `models.list` returns `input_modalities` and `max_completion_tokens`, which could replace the static table.
- **Proactive token budgeting**, meaning trimming the transcript so a request fits the key's TPM. The `413` path covers it reactively.
- **Service tiers.** `flex` (best effort, 498 at capacity) and `performance` (enterprise).
- **Batch, the Responses API, Compound, browser search and tools.**
- **Speech-to-text with Groq Whisper.** It is batch-only, and Glass needs real-time STT.
- **Per-lane model list and effort.**

---

## Review Checklist (Gate)

- [x] No [NEEDS CLARIFICATION] markers remain (session 2026-10-12; two items deferred with defaults)
- [x] Requirements are testable
- [x] Test strategy defined (mocked SDK, pure tables, manual live checks)
- [x] Portal placement selected
- [x] Permissions defined (single local user)
- [x] Data sensitivity classified (same data path as Gemini and Anthropic)
- [x] External APIs identified (Groq chat completions and models)
- [x] Error handling defined
- [x] UI complexity classified (Minor)
- [x] Deprecation decision made: nothing deprecated; no retired Groq model is offered
- [ ] Bug evidence captured: N/A (`feature-major`)

---

## Next Steps

- The user approves the plan and the model list (quickstart §2), and decides whether T006 may spend fractions of a cent on one live streamed request.
- With a Free-plan key (C7), decide whether cross-provider lists are the next spec.
- Implemented on the branch through T-DOC-GATE, and T006 is done (tasks.json has the evidence). What remains:
  - the rest of T-VERIFY-MANUAL: quickstart §4 checks 3, 6–12, and the SC-006 latency numbers, which need Live Answer on system audio. Checks 1, 2, 4 and 5 passed in the first app session (research R19);
  - T-FINAL.

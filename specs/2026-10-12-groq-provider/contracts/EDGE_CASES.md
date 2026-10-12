# Edge Cases: Groq Provider

**Spec**: `2026-10-12-groq-provider`

| # | Situation | Expected behavior | Covered by |
|---|-----------|-------------------|-----------|
| E1 | Key validation against a valid key | `models.list()` succeeds; no chat call; `{ success: true }` | FR-004 |
| E2 | Key validation returns 401 | `{ success: false, error: 'Invalid Groq API key.' }` | FR-004 |
| E3 | Key validation has no network | `{ success: false, error: 'A network error occurred during validation.' }` | FR-004 |
| E4 | Key without the `gsk_` prefix | Format error; no SDK call | FR-004 |
| E5 | Caller passes `temperature: 0.7` | Sent as 0.7 | FR-007 |
| E6 | Caller passes `temperature: 3`, `NaN` or a string | Omitted | FR-007 |
| E7 | `openai/gpt-oss-120b`, no effort | `reasoning_effort: 'low'`, `include_reasoning: false`, no `reasoning_format` | FR-008 |
| E8 | `qwen/qwen3.8-27b`, no effort | `reasoning_effort: 'none'`; no `reasoning_format`, no `include_reasoning` | FR-008 |
| E9 | `qwen/qwen3.8-27b` with `GROQ_REASONING_EFFORT=medium` | `reasoning_effort: 'medium'`, `reasoning_format: 'hidden'` | FR-008 |
| E10 | `GROQ_REASONING_EFFORT=none` on a gpt-oss model | Ignored (not in its set); `low` sent | FR-008 |
| E11 | Unknown model `acme/foo-1` | No reasoning field of any kind; `max_completion_tokens` uncapped; images dropped | FR-008, FR-009, FR-010 |
| E12 | Live Answer `maxTokens: 900` on gpt-oss | `max_completion_tokens: 1924` (900 + 1024) | FR-009 |
| E13 | Live Answer `maxTokens: 900` on Qwen at `none` | `max_completion_tokens: 900` | FR-009 |
| E14 | `maxTokens: 20000` on `qwen/qwen3.8-27b` at `medium` | Capped at 16,384 | FR-009 |
| E15 | No caller cap, `GROQ_MAX_TOKENS` unset | 2048 (+ 1024 when reasoning) | FR-009 |
| E16 | Ask with a screenshot on `openai/gpt-oss-120b` alone | Image dropped; text sent; log `images=dropped:1`; the answer comes from the text | FR-010 |
| E17 | Ask with a screenshot, list `openai/gpt-oss-120b,qwen/qwen3.8-27b` | Qwen tried first with the image; 120B only if Qwen fails, without the image | FR-011 |
| E18 | Five images on Qwen | First three sent, two dropped, log `images=sent:3` and `dropped:2` | FR-010 |
| E19 | `generateContent(['You are a…', {inlineData}])` | One user message: text part + `image_url` data URL (on a vision model); no system message | FR-010 |
| E20 | A message whose only content is an image, on a text-only model | Message dropped | FR-010 |
| E21 | Every model in the list is cooling down | The one that recovers first is tried anyway | FR-012 |
| E22 | 429 before the stream opens on model 1 of 2 | Every SDK call has `maxRetries: 0`, `timeout: 15000` and a signal; `_reset {next_model: m2, reason: 'transient'}` at once; m2 answers | FR-013, FR-014, FR-019, SC-003 |
| E23 | 503 on the only model, twice | `_reset {reason: 'retry'}`, a 2 s wait, one more attempt; then "All Groq models failed (2 attempts, 2 rounds). Last: …" | FR-019, FR-020 |
| E24 | 429 with `retry-after: 30` on every model | No second round; error at once with the server's reason | FR-019 |
| E25 | 429 with `retry-after: 1` on the only model | Joins the second round; tried again after 2 s | FR-019 |
| E26 | 413 "… TPM: Limit 8000, Requested 9400" on model 1 of 2 | No cooldown; `_reset reason: 'too-large'`; m2 tried at once | FR-013, FR-014 |
| E27 | 413 on the only model | "<model> — request needs 9400 tokens; this key allows 8000 per minute. This request alone is over the limit: shorten the context or use a higher Groq tier." No second round | FR-020 |
| E28 | 413 without readable numbers (body too large) | `too-large`; the message shows the server's reason | FR-020 |
| E29 | 404 `model_not_found` on model 1 of 2 | 5 min cooldown; `_reset reason: 'unavailable'`; m2 answers | FR-013 |
| E30 | 400 `model_decommissioned` on the only model | `unavailable`: "<model> is not available to this API key (decommissioned, blocked or not found). Pick a current model in Settings." | FR-013, FR-020 |
| E31 | 403 with a `model_…` code (blocked for the project) | `unavailable`, failover | FR-013 |
| E32 | 400 `invalid_request_error` on model 1 of 2 | Error at once; m2 never called | FR-013 |
| E33 | 401 / 403 without a model code | Error at once; no other model | FR-013 |
| E34 | 422 on model 1 of 2 | Transient, 10 s cooldown, m2 tried; 422 does not join a second round | FR-013, FR-019 |
| E35 | 498 (flex capacity) | Transient; failover | FR-013 |
| E36 | Mid-stream `{"error":{"type":"server_error"}}` after some text, model 1 of 2 | `_reset` (partial discarded by the consumer); m2 answers | FR-013, FR-017 |
| E37 | Chunk with `x_groq.error` | `STREAM_ERROR`, transient, 10 s cooldown, failover; the string is not logged | FR-017, FR-021 |
| E38 | No text within the first-text timeout | Attempt aborted; the SDK iteration ends quietly; detected by the attempt flag; `_reset reason: 'timeout'`; 10 s cooldown | FR-015 |
| E39 | The deadline leaves less than the next attempt's timeout | That attempt's timeout is cut to what is left | FR-015 |
| E40 | User types `llama-3.3-70b-versatile` (no slash) in Settings | Rejected by the validator, naming it; help text says Groq IDs are `vendor/model` | FR-003 |
| E41 | Deadline reached with models left | No more attempts; "No answer within 45s (n attempts). Last: …" | FR-015, FR-020 |
| E42 | Answer streaming at 44 s, continues past 45 s | Not cut | FR-015 |
| E43 | Text started, then 15 s without any chunk | Attempt aborted, transient; `_reset` if a model remains | FR-016 |
| E44 | Chunk with `finish_reason: 'stop'`, connection kept open (the SDK would keep reading past `[DONE]`) | Reading stops at that chunk; connection aborted; success | FR-017 |
| E45 | `finish_reason: 'length'`, no text | `EMPTY_MAX_TOKENS`, 10 s cooldown, failover | FR-017 |
| E46 | `finish_reason: 'length'` with text | Success; logged `stop=length` | FR-017 |
| E47 | Stream ends without any `finish_reason` and without an error | Transient (`stream ended before finish_reason`), failover | FR-017 |
| E48 | `delta.reasoning` chunks arrive anyway | Ignored; not forwarded, not logged, do not count as first text; they do reset the idle timer once text started | FR-017, C3 |
| E49 | Consumer cancels during an attempt | In-flight signal aborted; no failover; no stream error; request log `cancelled` | FR-018, SC-004 |
| E50 | Consumer cancels after text arrived | Same; `answered_by` names the model; model kept healthy | FR-018, FR-021 |
| E51 | Consumer cancels during the wait between rounds | No new attempt, no stream error; request log `cancelled` | FR-018, FR-019 |
| E52 | Enqueue after the consumer cancelled | Guarded; nothing thrown | FR-018 |
| E53 | `chat()` whose answer takes longer than 15 s | Not cut: the call streams, so the SDK timeout ends at the headers | FR-022, D12 |
| E54 | Response headers never arrive | The first-text timer aborts the request; counted as a first-text timeout | FR-015 |
| E55 | Settings list `openai/gpt-oss-120b, ,qwen/qwen3.8-27b` | Saved as `openai/gpt-oss-120b,qwen/qwen3.8-27b` | FR-003 |
| E56 | Settings list containing `claude-haiku-5-5` or `gemini-3-flash-preview` | Rejected, naming that entry | FR-003 |
| E57 | Installed Ollama model `library/model:tag` selected | Maps to Ollama, not Groq (installed names are matched first) | FR-002 |
| E58 | A Gemini or Anthropic request while Groq models are cooling down | Unaffected; separate IDs in the shared registry | FR-024, G3 |
| E59 | "Remove all API keys" in Settings | The Groq key is removed too | FR-005 |
| E60 | `GROQ_BASE_URL` set in the user's environment | The SDK uses it (documented in the quickstart); Glass does not override it | R4 |
| E61 | Every log line of a request with text, reasoning and a system prompt | None contains the scripted answer, reasoning or prompt text | FR-021, C3 |

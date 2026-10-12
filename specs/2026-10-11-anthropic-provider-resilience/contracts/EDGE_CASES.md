# Edge Cases: Anthropic Provider Resilience

**Spec**: `2026-10-11-anthropic-provider-resilience`

| # | Situation | Expected behavior | Covered by |
|---|-----------|-------------------|-----------|
| E1 | Key validation against a valid key | `models.list({limit:1})` succeeds; no Messages call; `{ success: true }` | FR-004 |
| E2 | Key validation returns 401 | `{ success: false, error: 'Invalid Anthropic API key.' }` | FR-004 |
| E3 | Key validation has no network | `{ success: false, error: 'A network error occurred during validation.' }` | FR-004 |
| E4 | Caller passes `temperature: 0.7` (every lane does) | Not in the request body | FR-005, SC-005 |
| E5 | `claude-haiku-4-5` in the list | No `output_config`, no `max_tokens` floor (it rejects `effort`) | FR-006, FR-007 |
| E6 | `ANTHROPIC_EFFORT=extreme` | Ignored; `low` sent | FR-006 |
| E7 | Live Answer `maxTokens: 900` on a 5.x model | `max_tokens: 4096` | FR-007 |
| E8 | Two consecutive `user` messages | Merged into one user message with both contents in order | FR-008 |
| E9 | `generateContent(['You are a…', 'question'])` | Both strings are user text; no `system` | FR-008 |
| E10 | Image data URL without a MIME type | `media_type: 'image/jpeg'` | FR-008 |
| E11 | `claude-sonnet-5-5` with `ANTHROPIC_SERVER_FALLBACK` unset | `beta.messages.create` with `betas` and `fallbacks: 'default'` | FR-009 |
| E12 | `claude-haiku-5-5` | `messages.create`, no `fallbacks` | FR-009, C5 |
| E13 | Every model in the list is cooling down | The one that recovers first is tried anyway | FR-010 |
| E14 | 529 before the stream opens on model 1 of 2 | Every SDK call has `maxRetries: 0`, `timeout: 15000` and a signal; `_reset {next_model: m2, reason: 'transient'}` at once; m2 answers | FR-011, FR-012, FR-018, SC-003 |
| E15 | 529 on the only model, twice | `_reset {reason: 'retry'}`, a 2 s wait, one more attempt; then "All Claude models failed (2 attempts, 2 rounds). Last: …" | FR-018, FR-019 |
| E16 | 429 with `retry-after: 30` | Model cooled down 30 s | FR-011 |
| E17 | Stream `error` event (`overloaded_error`) after some text, model 1 of 2 | `_reset` (partial discarded by the consumer); m2 answers | FR-011, FR-012 |
| E18 | 404 on model 1 of 2 | 5 min cooldown; `_reset reason: 'unavailable'`; m2 answers | FR-011 |
| E19 | 404 on the only model | `userMessage` "<model> is not available to this API key (retired or not enabled). Pick a current model in Settings." | FR-019 |
| E20 | 400 on model 1 of 2 | Error at once; m2 never called | FR-011 |
| E21 | 401 / 403 / 402 | Error at once; no other model | FR-011 |
| E22 | No text within the first-text timeout | Attempt aborted; the SDK iteration ends quietly; detected by the attempt flag; `_reset reason: 'timeout'`; 10 s cooldown | FR-013 |
| E23 | The deadline leaves less than the next model's timeout | That attempt's timeout is cut to what is left | FR-013 |
| E24 | Deadline reached with models left | No more attempts; "No answer within 60s (n attempts). Last: …" | FR-013, FR-019 |
| E25 | Answer streaming at 59 s, continues past 60 s | Not cut | FR-013 |
| E26 | Text started, then 30 s without any event | Attempt aborted, transient; `_reset` if a model remains | FR-014 |
| E27 | `message_stop` arrives but the connection stays open | Reading stops; connection aborted; success | FR-015 |
| E28 | `stop_reason: refusal` with partial text, model 1 of 2 | `_reset reason: 'refusal'`; no cooldown; m2 answers | FR-011, FR-015 |
| E29 | `stop_reason: refusal` on the last model | Error "<model> declined to answer"; the partial text already shown stays under the error (consumers keep it, as for any mid-stream error) | FR-019 |
| E30 | `stop_reason: max_tokens`, no text | Failure (`EMPTY_MAX_TOKENS`, 10 s cooldown), failover | FR-015 |
| E31 | `stop_reason: max_tokens` with text | Success; logged `stop=max_tokens` | FR-015 |
| E32 | Server-side fallback block mid-stream | No `_reset`; text continues; `_final_model` = `to.model`; log `fallback=from→to` | FR-016 |
| E33 | Consumer cancels during an attempt | In-flight signal aborted; no failover; no stream error; request log `cancelled` | FR-017, SC-004 |
| E34 | Consumer cancels after text arrived | Same; `answered_by` names the model; model kept healthy | FR-017, FR-020 |
| E35 | Enqueue after the consumer cancelled | Guarded; nothing thrown | FR-017 |
| E36 | Response with `thinking` block first, then text (non-streaming) | Text blocks joined; thinking ignored | FR-021 |
| E37 | Settings list `claude-haiku-5-5, ,claude-sonnet-5-5` | Saved as `claude-haiku-5-5,claude-sonnet-5-5` | FR-003 |
| E38 | Settings list containing `gemini-3-flash-preview` | Rejected, naming that entry | FR-003 |
| E39 | Stored retired `claude-3-5-sonnet-20241022` after upgrade | Shown as "(custom)" in the model list; requests fail per E19 until the user picks another | FR-002, FR-019 |
| E40 | Gemini request while Anthropic models are cooling down | Unaffected; separate IDs in the shared registry | FR-022, G3 |
| E41 | The server-side fallback beta is rejected (400 naming `anthropic-beta` or `fallbacks`) | Same attempt resent once without it; never sent again in this process; one log line | FR-009 |
| E42 | 429 with `retry-after: 30` on every model | No second round (the wait would not cover it); error at once with the server's rate-limit reason | FR-018, FR-019 |
| E43 | 429 with `retry-after: 1` on the only model | Joins the second round; tried again after 2 s | FR-018 |
| E44 | Every model failed fast, but the deadline leaves less than 2 s | No second round; "No answer within 60s …" | FR-013, FR-018 |
| E45 | Consumer cancels during the wait between rounds | No new attempt, no stream error; request log `cancelled` | FR-017, FR-018 |

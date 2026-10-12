# Edge Cases: Cross-Provider Failover

**Spec**: `2026-10-12-cross-provider-failover`

| # | Situation | Expected behavior | Covered by |
|---|-----------|-------------------|-----------|
| E1 | List of one provider (`openai/gpt-oss-120b,openai/gpt-oss-20b`) | One segment; the factory calls `groq.createStreamingLLM` once with today's options minus `keys`; no `[LLM Chain]` line | FR-002, SC-005 |
| E2 | `keys` passed with a single-provider list | Stripped; the provider never receives a `keys` field | FR-002, C4 |
| E3 | `keys` missing (`undefined`) with a mixed list | The first provider's key falls back to `opts.apiKey`; the other providers' segments are `skipped-no-key` | FR-007, FR-009 |
| E4 | Empty or whitespace list | `splitByProvider` → `[]`; the factory takes today's path (the provider applies its default model) | FR-001 |
| E5 | `' openai/gpt-oss-120b , gemini-3.5-flash-lite '` | Trimmed: `groq[openai/gpt-oss-120b]`, `gemini[gemini-3.5-flash-lite]` | FR-001 |
| E6 | `gemini-3.5-flash-lite,custom-model` | One Gemini segment holding both (today's behavior) | FR-001 |
| E7 | First ID has no inferable provider: active provider `gemini`, list `foo,gemini-y` | One Gemini segment `[foo, gemini-y]` | FR-001 |
| E8 | Interleaved `a/x,gemini-y,b/z` | Three segments; each runs with its own rules; two switches possible | FR-001, FR-011 |
| E9 | Active provider `openai` or `ollama` | Never split; today's path | FR-001, G3 |
| E10 | First segment answers | Its deltas, `_final_model` and `[DONE]` pass through; the later segments are never created | FR-008 |
| E11 | First segment's stream errors before any text | `_reset { next_model: <segment 2 first model>, reason: 'provider' }`, then segment 2 | FR-011 |
| E12 | First segment streams text, then errors | Same `_reset`; the consumer discards the partial answer | FR-011 |
| E13 | Segment stream ends without `[DONE]` and without an error | Segment failure; next segment | FR-011 |
| E14 | Segment `streamChat` throws synchronously or rejects | Segment failure; next segment | FR-011 |
| E15 | Segment emits its own `_reset`s (Groq model to model) | Passed through unchanged, before any chain `_reset` | FR-008 |
| E16 | Groq 429 on every model (daily budget spent) | Groq fails in one pass (no second round, hint > 0 s); chain moves to Gemini | FR-011, SC-003, R2 |
| E17 | Next request while every Groq model cools down | `skipped-cooling`; no Groq request; no `_reset`; Gemini answers | FR-007, D5 |
| E18 | Some Groq models cooling, one not (Qwen) | Groq segment runs; the provider picks the healthy model | FR-007 |
| E19 | Every segment cooling down | None skipped for cooling; each runs in order and tries its soonest-recovering model | FR-007, D5 |
| E20 | Last segment fully cooling, first one too | First is not skipped for cooling (no later segment has a healthy model) | FR-007 |
| E21 | Gemini key removed after the list was saved | Gemini segment `skipped-no-key`; if Groq fails, the user reads Groq's own message (one segment ran) | FR-007, FR-013, D6 |
| E22 | Groq 401 (key revoked) on a mixed list | Moves to Gemini | D4, FR-011 |
| E23 | Groq 400 or 413 too-large on a mixed list | Moves to Gemini | D4 |
| E24 | Ask with a screenshot; Groq segment has no vision model | Gemini segment first with the image; request line `order=images-first` | FR-007, D8 |
| E25 | Ask with a screenshot; Groq segment includes `qwen/qwen3.8-27b` | No reorder; Groq routes the image to Qwen itself | FR-007, R9 |
| E26 | `generateContent` with `inlineData` | Counts as an image for ordering | FR-007, FR-014 |
| E27 | Next segment is Groq and the request has an image | `next_model` is Groq's vision model (its `orderForImages` first) | FR-011 |
| E28 | Chain deadline 60 s, Groq stalls to its 45 s deadline | Gemini starts with ≤ 15 s; its first-chunk timeout is cut to that | FR-009, FR-010, R8 |
| E29 | Chain deadline passes with no answer and a segment left | No further segment; "No answer within 60s (groq → gemini). Last: …" | FR-010, FR-013 |
| E30 | Non-last segment's computed deadline ≤ 0 (little time left) | `skipped-deadline`; the later segment runs with what is left | FR-009 |
| E31 | `LLM_CHAIN_DEADLINE_MS=0` | No chain deadline; segments keep their own; reserve not applied | FR-010 |
| E32 | Provider deadline disabled by env (`GROQ_REQUEST_DEADLINE_MS=0`) | Treated as no limit; the chain's remaining time applies | FR-009 |
| E33 | Text was forwarded, then the segment failed | The next segment runs with no chain deadline | FR-010 |
| E34 | Non-last segment | Called with no `retryRoundDelayMs`: the provider keeps its own wait before its second round (2 s Groq/Anthropic, 3 s Gemini) | FR-009, D7 |
| E35 | Last runnable segment | Same: no `retryRoundDelayMs` | FR-009 |
| E36 | Each segment's options | `apiKey` = its own provider's key; `model` = its models joined; no `keys` field | FR-009, C4 |
| E37 | Consumer cancels during segment 1 | Segment 1's reader cancelled → its request aborted; segment 2 never created; no error | FR-012, SC-004 |
| E38 | Consumer cancels between segments (after the `_reset`) | Nothing more starts; no error | FR-012 |
| E39 | Enqueue after the consumer cancelled | Guarded; no `ERR_INVALID_STATE` | FR-012 |
| E40 | Every segment fails, two ran | "All providers failed (groq → gemini). Last: <Gemini's userMessage>" | FR-013 |
| E41 | Only one segment ran (others skipped) and failed | Its own `userMessage`, unchanged | FR-013 |
| E42 | Last segment error has no `userMessage` | Its `message` is used after "Last:" | FR-013 |
| E43 | `chat()` on a mixed list, Groq fails | Gemini's `chat()` result returned unchanged (`content`, `raw`, `_modelUsed`) | FR-014 |
| E44 | `chat()`, every segment fails | Throws the FR-013 error | FR-014 |
| E45 | Logs | One segment line per segment and one request line; model IDs and provider messages only; no text, no key | FR-015, C3, C4 |
| E46 | Settings: Groq field `openai/gpt-oss-120b,gemini-3.5-flash-lite` with a Gemini key | Saved; stored in the Groq row; shown as "(custom)" | FR-005, FR-006 |
| E47 | Settings: Groq field `openai/gpt-oss-120b,claude-haiku-5-5` without an Anthropic key | Refused: names `claude-haiku-5-5` and the missing Anthropic key | FR-005 |
| E48 | Settings: Groq field starting with `gemini-3.5-flash-lite` | Refused: the first entry must be a Groq model | FR-005 |
| E49 | Settings: Gemini field `gemini-3.5-flash-lite,openai/gpt-oss-120b` with a Groq key | Saved; Gemini first, Groq as fallback | FR-005 |
| E50 | Settings: a later entry that is an installed Ollama name with `/` | Refused: Ollama cannot be a segment | FR-005, R6 |
| E51 | Settings: a later entry with no known prefix (`gpt-4.1`) | Refused, naming it | FR-005 |
| E52 | Removing the first provider's key | Today's auto-selection picks another model; the mixed list is no longer active | FR-006 |
| E53 | `getCurrentModelInfo('llm')` with a single-provider list | `keys` = `{ [provider]: apiKey }` | FR-003 |
| E54 | `getCurrentModelInfo('stt')` | Unchanged (no `keys`) | FR-003 |
| E55 | Live Insights (`chat`) and Live Answer (`streamChat`) on the same mixed list at once | Independent chains; both read the shared registry | FR-007 |

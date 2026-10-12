# Research: Model Catalog

**Spec**: `2026-10-12-model-catalog`
**Date**: 2026-10-12

## Summary

| ID | Question | Answer |
|---|---|---|
| R1 | Does Groq's models API say what a model can do? | Yes: `input_modalities`, `max_completion_tokens`, `supported_features` (probed live) |
| R2 | Does Gemini's? | Partly: `outputTokenLimit`, `thinking`; no input modalities |
| R3 | Does Anthropic's? | Yes: `capabilities.image_input`, `.thinking`, `.effort` levels, `max_tokens`, `lifecycle`; nothing for the server-side fallback beta |
| R4 | Where did the code decide by model name? | Groq `MODEL_TRAITS`, the chain's adapters, Anthropic `acceptsEffort` / `SERVER_FALLBACK_MODELS`, the prefix rule in three places |
| R5 | Can the Groq reasoning fields be read from the API? | No: only that a model reasons |
| R6 | Can the key's output limit be read before a request? | No: only the refusal reveals it |
| R7 | Where to store the catalog | SQLite, new table, created by `schema.js` |
| R8 | How to test the table under Node | `node:sqlite` (the app's `better-sqlite3` is built for Electron) |

---

## R1. Groq models API (live, 2026-10-12)

`GET https://api.groq.com/openai/v1/models` with the user's key (read only, no tokens). Each item has `id`, `active`, `context_window`, `max_completion_tokens`, `input_modalities`, `output_modalities`, `supported_features`, `supported_sampling_parameters`, `pricing`, and more. For the presets:

| Model | `input_modalities` | `max_completion_tokens` | `supported_features` |
|---|---|---|---|
| `openai/gpt-oss-120b` | `["text"]` | 65,536 | tools, json_mode, structured_outputs, reasoning |
| `openai/gpt-oss-20b` | `["text"]` | 65,536 | tools, json_mode, structured_outputs, reasoning |
| `qwen/qwen3.8-27b` | `["text","image"]` | 16,384 | tools, json_mode, reasoning |
| `whisper-large-v3` | `["audio"]` | 448 | (none) |

The values match the old `MODEL_TRAITS` table exactly, so moving to the API changes no behavior for the presets. The recorded response (four models) is the fixture `src/features/common/ai/__tests__/fixtures/groq-models.json`.

groq-sdk 1.6 returns these fields as is from `client.models.list()` (checked live through `listModels`: 11 models, Qwen `vision: true`). `client.models.retrieve('typo/does-not-exist')` is a 404, which `getModel` reads as "no such model".

**Correction recorded:** earlier in the session (before this spec) the answer to the user said the Groq API does not report which models see images. That was wrong; this probe shows it does.

## R2. Gemini models API (documentation)

`ai.google.dev/api/models` (read 2026-10-12), Model resource: `name`, `baseModelId`, `version`, `displayName`, `description`, `inputTokenLimit`, `outputTokenLimit`, `supportedGenerationMethods`, `thinking`, `temperature`, `maxTemperature`, `topP`, `topK`. **No field describes input modalities.** The catalog keeps `vision: null` and the provider default applies (every Gemini chat model reads images); an override covers the exception. The list pages with `pageToken`; models without `generateContent` (embeddings) are left out. The key goes in the `x-goog-api-key` header (the old validation call puts it in the URL; that call is unchanged).

No Gemini key was readable outside the app (encrypted in SQLite), so the Gemini side was not probed live; `listModels` and `getModel` are tested with a mocked `fetch`.

## R3. Anthropic Models API (SDK types and documentation)

`@anthropic-ai/sdk` 0.133 `resources/models.d.ts`, `ModelInfo`: `id`, `display_name`, `created_at`, `lifecycle` (`active` / `deprecated` / `retired`), `line`, `max_input_tokens`, `max_tokens`, `capabilities` (`ModelCapabilities | null`). `ModelCapabilities` has `image_input`, `pdf_input`, `structured_outputs`, `thinking` (with `types.adaptive` / `types.enabled`), `effort` (`supported` plus `low`, `medium`, `high`, `max`, `xhigh`, each a `{ supported }` or null), `batch`, `citations`, `code_execution`, `context_management`, `server_tools`. The claude-api skill's model catalog shows the same shape.

- Effort levels are the keys of `capabilities.effort` marked supported. Haiku 4.5 and Sonnet 4.5 have `effort.supported: false` (they reject effort with a 400, which `acceptsEffort` used to encode by regex).
- Nothing reports the server-side fallback beta, so it is learned from the refusal (spec D8).
- `retrieve(modelID, params, options)` takes an alias.

No Anthropic key was readable outside the app, so the shape was not probed live. The fixture `fixtures/anthropic-models.json` follows the SDK types, with values from the model catalog, and says so in its `_source` field. The manual check (quickstart §4) confirms it live when a Claude model is in the list.

## R4. Rules by model name before this spec

From a sweep of `src/` (2026-10-12):

| Where | Rule | Now |
|---|---|---|
| `groq.js` `MODEL_TRAITS` | vision, max output, reasoning family by regex | catalog; family stays as the dialect (R5) |
| `providerChain.js` adapters | Groq: `modelTraits().vision`; Gemini, Anthropic: always | catalog for all three |
| `anthropic.js` `acceptsEffort` | effort and thinking floor by family and version | `capabilities.effort` levels |
| `anthropic.js` `SERVER_FALLBACK_MODELS` | beta only for Opus and Sonnet 5.5 | every model until refused (D8) |
| `anthropic.js` / `gemini.js` | images always sent; caps not bound to the model | catalog vision; caps bound to the model max |
| `factory.inferProviderFromModelId` | provider by prefix | catalog first, prefix last |
| `SettingsView.js` | copies of the prefix rule and of `splitByProvider` | main process through IPC |
| `modelStateService.js:364` | hard-coded `['gemini','anthropic','groq']` | `CATALOG_PROVIDERS` |

Left as they are (future-work item 8): Gemini `isLiteModel` and Claude Haiku timeouts (latency tuning, env-overridable), OpenAI and Ollama.

## R5. Groq reasoning fields

`supported_features: ["reasoning"]` says a model reasons. It does not say which request fields it takes: gpt-oss takes `reasoning_effort` (`low`/`medium`/`high`) and `include_reasoning`; Qwen 3 takes `reasoning_effort` (`none`/`default`/…) and `reasoning_format`. A field a model does not know is a 400. So the family table stays, named for what it is (`REASONING_DIALECTS`), and applies only when the catalog does not say the model does not reason. A reasoning model of no known family gets no field and reasons at its own default, as before.

## R6. The key's output limit

The per-minute limits belong to the key (organization and tier), not the model, and no models API reports them. Groq reveals the output limit only by refusing, before generating: `429 … (OTPM): Limit 1000, Requested R` (groq-provider R20). Probes: 1,000 declared accepted, 1,001 refused; 2,048 → Requested 1,679; 16,384 → Requested 1,131–1,168. Every declared cap over the limit tried so far was refused, so "declared cap over L" is the skip rule. The limit can change with the tier, hence the 24 h expiry and the reset when the key changes.

Live check after the change (2026-10-12, user's key, image request with `visionOnly`): first request → Qwen refused (`limit=1000 requested=1131`), limit stored; second request → `skip model=qwen/qwen3.8-27b reason=key-output-limit limit=1000 requested=16384`, no Groq request, `KEY_OUTPUT_LIMIT`.

## R7. Storage

`provider_settings` already holds keys and lists in SQLite. `sqliteClient.synchronizeSchema` creates a table missing from the database and adds missing columns (`sqliteClient.js:126`, `:168`), so a new entry in `schema.js` needs no migration. Rows are small (one per provider and model, ~25 in all); every change is one upsert.

## R8. Testing the table

`better-sqlite3` in `node_modules` is built for Electron's ABI (`NODE_MODULE_VERSION 123`) and does not load under Node 24. Node 24 ships `node:sqlite` (`DatabaseSync`), whose `prepare().get/all/run` match. The repository takes a `getDb` function, so the test builds the table from `schema.js` in an in-memory `node:sqlite` database.

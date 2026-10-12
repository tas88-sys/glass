# Data Model: Model Catalog

**Spec**: `2026-10-12-model-catalog`

## Table `model_catalog` (SQLite, `schema.js`)

One row per provider and model ID. `NULL` means "unknown" for a reported value and "automatic" for an override. Booleans are `INTEGER` 0/1.

| Column | Type | Written by | Meaning |
|---|---|---|---|
| `provider` | TEXT, PK part | catalog | `anthropic` / `gemini` / `groq` |
| `model_id` | TEXT, PK part | catalog | The ID as typed (an alias stays an alias) |
| `listed` | INTEGER | refresh / lookup | 1 the provider has it; 0 it said it has not; NULL unknown (never asked, or missing from the latest list) |
| `vision` | INTEGER | refresh / lookup | Sees images (Groq `input_modalities`, Anthropic `capabilities.image_input`; Gemini always NULL) |
| `max_output` | INTEGER | refresh / lookup | Output maximum (Groq `max_completion_tokens`, Anthropic `max_tokens`, Gemini `outputTokenLimit`) |
| `reasoning` | INTEGER | refresh / lookup | Reasons (Groq `supported_features`; Anthropic and Gemini `thinking`) |
| `effort_levels` | TEXT (JSON array) | refresh / lookup | Anthropic effort levels marked supported; `[]` none; NULL not reported |
| `thinking` | INTEGER | refresh / lookup | Anthropic `capabilities.thinking`, Gemini `thinking` |
| `server_fallback` | INTEGER | Anthropic provider | 0 once the API refused the fallback beta for the model; NULL untried |
| `override_vision` | INTEGER | Settings | User override; NULL automatic |
| `override_max_output` | INTEGER | Settings | User override; NULL automatic |
| `override_reasoning` | INTEGER | Settings | User override; NULL automatic |
| `key_output_limit` | INTEGER | Groq provider | Output tokens per minute the key allows on the model (from a 429 OTPM) |
| `key_limit_at` | INTEGER (epoch ms) | Groq provider | When it was learned; ignored after 24 h |
| `fetched_at` | INTEGER (epoch ms) | refresh / lookup | Last API answer for the row |
| `updated_at` | INTEGER (epoch ms) | catalog | Last write |

A refresh rewrites only the reported columns and `listed` / `fetched_at`; overrides, `server_fallback` and the key limit are kept.

## In memory (`modelCatalog.js`)

- `rows`: `Map<"provider\0modelId", Row>`; `Row` is the table row in camelCase with `override: { vision, maxOutput, reasoning }` and `effortLevels: string[] | null`.
- `listedAt`: `Map<provider, epoch ms>` of the last full list read in this process (not saved: every start reads the lists again).
- `inflight`: one promise per provider (list) and per provider+ID (lookup).

## Capabilities (`capabilities(provider, id)`)

| Field | Resolution | Used by |
|---|---|---|
| `vision` | override → API → provider default (Groq false; Gemini, Anthropic true) | every provider (images), the chain (`seesImages`, `visionOnly`) |
| `maxOutput` | override → API → null | caps in the three providers |
| `reasoning` | override → API → null | Groq: `false` turns the dialect off |
| `effortLevels` | API | Anthropic effort |
| `thinking` | API | Anthropic floor (with `effortLevels`) |
| `serverFallback` | learned | Anthropic beta |
| `keyOutputLimit` | learned, 24 h | Groq skip |
| `listed` | API | `providerOf`, Settings warnings |
| `source.{vision,maxOutput,reasoning}` | `override` / `api` / `default` / `unknown` | Settings |

## List plan (`modelStateService.planModelList({ list, fieldProvider })`)

`{ segments: [{ provider, models }], models: [snapshot + { providerSource: 'catalog' | 'prefix', hasKey }], missingKeys: string[] }`. Settings validates with it (the first segment must be the field's provider; a later provider needs a key) and renders the capability lines.

## State transitions of a row

```
(none) --list has it--> listed=1
(none) --lookup 404--> listed=0, fetched_at=now  --after 24 h--> looked up again
listed=1 --a later list lacks it--> listed=NULL --lookup--> listed=1 (alias) | listed=0
any --Settings override--> override_* set (kept by every refresh)
any --Groq 429 OTPM--> key_output_limit=L, key_limit_at=now --24 h or new key--> ignored / cleared
any --Anthropic 400 on the beta, resend accepted--> server_fallback=0
```

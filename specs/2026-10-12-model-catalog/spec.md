---
# Context Optimization Metadata
# Purpose: Enable efficient partial reads (~200 tokens vs ~2500 for full file)
meta:
  spec_id: 2026-10-12-model-catalog
  spec_name: model-catalog
  status: in-progress    # draft | in-progress | approved | completed
  phase: verify          # specify | clarify | plan | tasks | preflight | feature-start | implement | verify
  created: 2026-10-12
  updated: 2026-10-12

# Quick Reference (for checkpoint resume)
summary:
  goals:
    - {id: G1, description: "What a Groq, Gemini or Anthropic model can do (sees images, output maximum, reasons, Anthropic effort levels) comes from its provider's models API, not from a table keyed by model name. A new model works once its provider lists it, with no code change", priority: HIGH}
    - {id: G2, description: "The provider of a model ID is the one whose models list has it. The prefix rule (claude- / gemini- / vendor/model) is only the last resort, and the renderer keeps no copy of it", priority: HIGH}
    - {id: G3, description: "The user can see and override, in Settings, what each model of the active list can do; the override is kept and wins over the API", priority: HIGH}
    - {id: G4, description: "No Ask answer is cut to fit a limit. A refusal on the key's output limit is learned, so the next request over it skips that model with no call; a smaller cap (Live Answer) still uses it", priority: HIGH}
    - {id: G5, description: "Requests never wait long on the catalog: reads are synchronous; a model it does not know waits at most 2 s, then the provider default applies", priority: MEDIUM}
  constraints:
    - {id: C1, description: "Scope: the three providers with a models API and a place in the chain (Groq, Gemini, Anthropic). OpenAI and Ollama, and the per-name timeout tuning, are out (future-work item 8)", type: SCOPE}
    - {id: C2, description: "The SSE protocol the consumers read (_reset, _final_model, [DONE], err.userMessage) is unchanged. askService.js and summaryService.js are not edited", type: SCOPE}
    - {id: C3, description: "An answer is never shrunk to fit a limit (carried over from 2026-10-12-groq-otpm-images C2)", type: SCOPE}
    - {id: C4, description: "Never log prompt, answer or reasoning text, and never put a key in a URL or a log. Gemini's models list sends the key in a header", type: SECURITY}
    - {id: C5, description: "npm test makes no live call: the catalog has no fetchers unless the app configures them, and tests seed it. Live probes are run by hand and read model lists only", type: TECHNICAL}
    - {id: C6, description: "Same branch and PR as 2026-10-12-groq-otpm-images (#17): the work touches the same code and that PR is still open (user, 2026-10-12)", type: PROCESS}
  decisions:
    - {id: D1, decision: "One module, modelCatalog.js, resolves each field: the user's override, else what the provider's models API reported, else a provider default (Groq: no images; Gemini and Anthropic: images)", rationale: "The APIs report almost everything (research R1-R3). The defaults are one rule per provider, not per model, and the safe one for Groq (an image to a text-only model is a 400)"}
    - {id: D2, decision: "The catalog lives in a new SQLite table, model_catalog, loaded into memory at startup; every read is synchronous", rationale: "The app already keeps keys and lists in SQLite (provider_settings); schema.js creates new tables and columns on its own. Synchronous reads keep the factory and the chain plan synchronous"}
    - {id: D3, decision: "The override is set in Settings (user, 2026-10-12), not in a JSON file or .env", rationale: "The user chose it. It also works in a packaged app, where .env is not read"}
    - {id: D4, decision: "The lists are read at startup and when a key is saved (background), when a list is saved (up to 5 s), and when a request names an unknown model (ensureKnown, up to 2 s). A list over 24 h old is read again in the background. A failed read keeps what is known", rationale: "Save is where the user expects feedback; a request must not stall. Lists change rarely"}
    - {id: D5, decision: "The provider of an ID comes from the catalog; when several providers list it, the Settings field (or the run it continues) decides; the prefix is the last resort, logged once", rationale: "User request (2026-10-12): 'how will the app know which provider the model belongs to?'. The prefix rule breaks for IDs without the expected shape (research R4)"}
    - {id: D6, decision: "Groq's reasoning dialect stays a table by family (REASONING_DIALECTS), applied only when the catalog does not say the model does not reason", rationale: "The API says that a model reasons, not which fields it takes (include_reasoning vs reasoning_format), and a field a model does not know is a 400 (research R5). It is request format, not a capability"}
    - {id: D7, decision: "A Groq 429 OTPM stores the key's output limit per model (24 h; cleared when the key changes). A request whose declared cap is over it skips that model with no call", rationale: "Supersedes groq-otpm-images D7 (no memory). User question (2026-10-12): how does the app know a model will not cut the answer? The limit is per key and no models API reports it; only the refusal does (research R6)"}
    - {id: D8, decision: "Anthropic's server-side fallback beta is sent to every model. A 400 on it is resent once without the beta; when that is accepted, the catalog marks the model (kept across restarts)", rationale: "Replaces the SERVER_FALLBACK_MODELS list. No capability field reports the beta (research R3); learning it from the refusal needs no list. Resending any 400 once avoids depending on the error text"}
    - {id: D9, decision: "Every provider follows visionOnly and sends no image to a model the catalog says does not see one; caps never go over the model maximum", rationale: "With Gemini and Anthropic no longer 'always see images', a model set otherwise must be handled the same way Groq's text-only models are"}

# CRITICAL REQUIREMENTS - Must verify during implementation
# These survive context compaction and generate T-VERIFY tasks
critical_requirements:
  type: feature-major    # bugfix | feature-minor | feature-major | config | documentation | refactoring
  portal: app            # superadmin | admin | app | public | none
  ui_changes: moderate   # none | minor | moderate | major
---

# Feature Specification: Model Catalog

**Feature Branch**: `2026-10-12-groq-otpm-images` (same PR as the OTPM fix, #17)
**Created**: 2026-10-12
**Status**: Implemented; manual check pending (T-VERIFY-MANUAL)
**Input**: User request (2026-10-12, translated from Portuguese):
- "How does the app know which models have vision or not? Is that hardcoded? If I change the models in the future, will the app break?"
- "I want this to be dynamic and parametrizable, regardless of the model and the provider. We need to improve this implementation somehow. Create a /plan for it. Hardcoded variables are not a professional implementation."
- On the override: "Settings screen". On scope: "Groq, Gemini and Anthropic".
- "And how will the app know which provider the model belongs to?" Then: "yes" (include it).
- "Even if a model has vision, how will the app know the model serves the request and does not risk cutting the answer like the Groq models?"
- "Keep it on this same branch, since the work is related and the PR is still open."

---

## System Context

**Systems**: Framework-internal, Electron main process (the providers, the chain, the factory, `modelStateService`) and the Settings renderer.
**Databases**: The app's SQLite database (`better-sqlite3`), new table `model_catalog`.
**Integrations**: The models APIs of Groq (`GET /openai/v1/models`, `/models/{id}`), Anthropic (`GET /v1/models`, `/v1/models/{id}`) and Gemini (`GET v1beta/models`, `/models/{id}`). Each was already called, only to validate a key.
**Key Architecture**:
- Before this spec, what a model can do was fixed in code:
  - `groq.js` `MODEL_TRAITS`: a regex per ID gave vision, output maximum and reasoning family. A Qwen 3.9 would have been treated as text-only.
  - `providerChain.js`: Gemini and Anthropic adapters returned `seesImages: () => true`.
  - `anthropic.js`: `acceptsEffort` (a regex on family and version) and `SERVER_FALLBACK_MODELS` (Opus and Sonnet 5.5).
  - `factory.inferProviderFromModelId`: the provider from the ID's prefix, copied in `SettingsView.js` (`chainProviderOf`, `modelListOrder`, `getProviderForModel`) and used by `modelStateService.getProviderForModel`.
- The cross-provider chain (`ARCHITECTURE.md` §10.4) and `visionOnly` (spec `2026-10-12-groq-otpm-images`) route an Ask screenshot; both read "sees images" per model.

---

## Clarifications

### Session 2026-10-12

- Q: Where does the override live? → A: The Settings screen (the user rejected a second source; `.env` is not read in a packaged app).
- Q: Which providers? → A: Groq, Gemini and Anthropic.
- Q: Where is what the API reported saved? → A: The app's SQLite database, not `.env` (the user asked; `.env` is configuration the user writes).
- Q: Does the provider of an ID also come from the catalog? → A: Yes.
- Q: How is an answer not cut? → A: Capability (models API) and the key's limit (learned from the refusal) are separate; the declared cap is always the full one; a request over a learned limit skips the model.
- Q: Branch? → A: The same one as PR #17.

**Deferred (default chosen, not blocking)**:
- OpenAI and Ollama catalogs, per-model timeouts, and an "answer cut" notice in Ask: future-work item 8.

---

## User Scenarios & Testing *(mandatory)*

### Primary User Story

The user replaces `qwen/qwen3.8-27b` with a newer Groq vision model in the Groq field and saves. Settings shows, under the list, that the new model sees images, its output maximum and that it reasons, each read from Groq's API. The next Ask with a screenshot reaches that model, or Gemini when Groq refuses it, with no code change.

### Acceptance Scenarios

1. **Given** Groq's API lists a model with `input_modalities` including `image`, **When** a list naming it is saved, **Then** the catalog marks it as seeing images and an Ask screenshot is sent to it.
2. **Given** a model ID with no slash that only Groq lists (e.g. `allam-2-7b`), **When** a Groq list names it after a Groq model, **Then** it runs in the Groq segment.
3. **Given** an ID no provider has, **When** the list is saved, **Then** Settings shows "Groq has no model with this ID" and the request uses the provider defaults.
4. **Given** the user sets "Sees images: No" on a Gemini model, **When** an Ask with a screenshot runs on a list that has a later provider that sees images, **Then** that Gemini model is not tried, and the override survives a refresh.
5. **Given** Qwen was refused with a 429 OTPM (Limit 1000), **When** the next Ask with a screenshot runs, **Then** Qwen is skipped with no Groq request and the next provider answers with the image; **And When** Live Answer (cap 900) runs, **Then** Qwen answers.
6. **Given** the Anthropic API refuses the server-side fallback beta for a model, **When** the request is resent without it and accepted, **Then** that model is never sent the beta again, after a restart too.
7. **Given** no network at startup, **When** the app starts, **Then** the saved catalog is used and requests run.

### Edge Cases

See `contracts/EDGE_CASES.md` (E1–E30).

---

## Requirements *(mandatory)*

### Functional Requirements

**Catalog (`modelCatalog.js`, `repositories/modelCatalog`, `schema.js`)**
- **FR-001**: `capabilities(provider, id)` MUST resolve `vision`, `maxOutput` and `reasoning` as override, else reported, else `PROVIDER_DEFAULTS` (Groq `vision: false`; Gemini and Anthropic `vision: true`), and say the source of each (`override` / `api` / `default` / `unknown`). It MUST also return `effortLevels`, `thinking`, `serverFallback`, `keyOutputLimit` and `listed`.
- **FR-002**: Every read MUST be synchronous, from memory. `load()` MUST fill memory from the `model_catalog` table; a failed read MUST leave the catalog empty without throwing.
- **FR-003**: `refresh(provider, key)` MUST read the provider's whole list, at most once at a time per provider, and keep it 24 h unless `force`. A failure MUST keep what is known. A listed model the new list lacks MUST become unknown (looked up again).
- **FR-004**: `ensureKnown(provider, key, ids, { timeoutMs = 2000 })` MUST return at once when every ID is known (a stale list is read in the background), else read the list and look up each still-unknown ID, waiting at most `timeoutMs`. An ID the provider lacks MUST be recorded as missing and not looked up again within 24 h. Without fetchers it MUST do nothing.
- **FR-005**: `setOverride` MUST accept `vision` / `reasoning` (boolean or null) and `maxOutput` (positive integer or null) and reject anything else; a refresh MUST NOT erase an override.
- **FR-006**: `recordKeyOutputLimit` / `keyOutputLimit` / `clearKeyLimits` MUST keep a per-model limit that expires after 24 h. `markServerFallback` MUST keep a per-model flag. Both MUST be saved.
- **FR-007**: `providerOf(id, context)` MUST return the provider whose list has the ID; with several, `context` when it is one of them, else the first; null when none.

**Providers**
- **FR-008**: Groq, Anthropic and Gemini MUST export `listModels(apiKey)` and `getModel(apiKey, id)` (null on 404) returning normalized entries; Anthropic MUST leave out retired models; Gemini MUST keep `generateContent` models, strip `models/`, report `vision: null`, and send the key in `x-goog-api-key`.
- **FR-009**: Groq `modelTraits` MUST read `vision` and `maxOutput` from the catalog; the reasoning dialect MUST apply unless the catalog says `reasoning: false`; a model of no known family gets no reasoning field.
- **FR-010**: Groq MUST record the limit of a 429 OTPM, and skip, with no call, a model whose declared cap (`declaredMaxTokens`) is over the learned limit; when every candidate is skipped it MUST throw `KEY_OUTPUT_LIMIT` with the output-token message.
- **FR-011**: Anthropic MUST send `output_config.effort` only to a model with effort levels, choosing among them; apply the 4096 floor when the model thinks or is unknown; never exceed the model's `max_tokens`; drop images for a model that does not see them; and follow `visionOnly`.
- **FR-012**: Anthropic MUST send the fallback beta unless the catalog says the model refused it. A 400 on the beta method MUST be resent once without it; only when that is accepted is the model marked.
- **FR-013**: Gemini MUST cap `maxOutputTokens` at the model's `outputTokenLimit`, order models that see images first, drop images for one that does not, and follow `visionOnly` (`NO_VISION_MODEL` when none is left).
- **FR-014**: Each provider's `createLLM` / `createStreamingLLM` MUST call `ensureKnown` for its list before running.

**Chain, factory and main process**
- **FR-015**: The chain's adapters MUST read `seesImages` and the first model from the catalog, and the chain MUST call each segment's `ensureKnown` (with a key) before the plan.
- **FR-016**: `inferProviderFromModelId(id, context)` MUST use `providerOf` first and the prefix last (logged once per ID); `splitByProvider` MUST pass the current run as context.
- **FR-017**: `modelStateService` MUST configure and load the catalog at startup and refresh every provider with a key in the background; refresh (force) and clear the key limits when a key is saved; clear them when a key is removed; learn a saved list's models before resolving it (5 s at most); and pass the Settings field as context.
- **FR-018**: IPC MUST offer `model:get-catalog`, `model:plan-model-list`, `model:set-capability-override`, `model:refresh-catalog`; `model:set-selected-model` MUST take `fieldProvider`. `getSelectedModels` MUST name the active rows' providers, `getAvailableModels` MUST tag each entry with its provider, and `getProviderConfig` MUST mark the catalog providers.

**Settings (`SettingsView.js`)**
- **FR-019**: Under the field holding the active list, Settings MUST show one line per model (provider, what it can do with the source, warnings) with **Edit** (overrides) and **Refresh**.
- **FR-020**: Settings MUST validate and lay out a list through `model:plan-model-list` and MUST NOT keep its own prefix rule.

### Success Criteria

- **SC-001**: A Groq model the API reports as seeing images gets the screenshot with no code change (test and live probe).
- **SC-002**: `npm test` passes; the new tests fail on the base commit (worktree check).
- **SC-003**: Live, with the user's Groq key: the catalog reports Qwen `vision: true, maxOutput: 16384` and gpt-oss `vision: false, 65536`, all `source: api`; a 429 OTPM is learned and the next screenshot request skips Qwen with no call.
- **SC-004** (manual, app): Settings shows the capabilities under the active list; a wrong ID shows the warning; an override is saved; an Ask with a screenshot behaves as in PR #17 with Qwen skipped after the first refusal.

### Key Entities

- **Catalog row** (`model_catalog`): see `data-model.md`.
- **Capabilities** (`capabilities()` result) and **list plan** (`planModelList()` result): see `data-model.md` and `contracts/`.

### External Dependencies & Risk Assessment *(mandatory)*

| Dependency | Type | Risk Level | Quota/Limits | Fallback Behavior |
|---|---|---|---|---|
| Groq models API | API (existing, now read) | LOW | Not metered as tokens | The saved catalog; else the defaults (no image, no cap) |
| Anthropic Models API | API (existing, now read) | LOW | Not metered as tokens | The saved catalog; else no effort, the thinking floor, images |
| Gemini models.list | API (existing, now read) | LOW | Not metered as tokens | The saved catalog; else images, cap 65,536 |
| SQLite | Local | LOW | — | A failed read or write is logged; the catalog works from memory |

**HIGH-RISK Dependency Checklist**: none HIGH. The Anthropic capability shape was not probed live (no readable key); it is taken from the SDK 0.133 types (research R3) and covered by a fixture in that shape.

### Test Strategy *(mandatory)*

| FR | Primary Test Type | Reason |
|---|---|---|
| FR-001–FR-007 | Unit (`modelCatalog.test.js`, `node:sqlite` for the table) | Pure module, injectable store, fetchers and clock |
| FR-008 | Unit (normalization on a recorded Groq response and an SDK-shaped Anthropic fixture; fetch mocked for Gemini) | Shape |
| FR-009–FR-014 | Unit (fake SDKs) | Failover loops |
| FR-015, FR-016 | Unit + integration (real providers, fake SDKs) | Chain and factory |
| FR-017, FR-018 | Unit (`modelStateService.catalog.test.js`, fake repositories) | Main-process wiring |
| FR-019, FR-020 | Manual (app); renderer build and module parse | No renderer test harness in the repo |
| SC-003 | Live probe | Real API |

**Estimated Test Count**: about 70 new cases across 9 test files, and the existing provider tests moved from the name tables to a seeded catalog.

### Error Handling & Recovery

| Error Scenario | Type | User Message | Recovery Action |
|---|---|---|---|
| A models API fails (network, 5xx) | Provider | none | The saved catalog is used; read again later |
| An ID no provider has | Config | Settings: "<provider> has no model with this ID" | The user fixes the list |
| Every Groq candidate over the learned key limit | Provider limit | "MODEL — asks for up to R output tokens; this key allows L per minute." | The chain moves to the next provider; the limit expires in 24 h or with a new key |
| `visionOnly` and no model of the provider sees images | Config / guard | "No <Provider> model in the list sees images." | The chain moves on |
| A bad override value | Input | "Could not change MODEL: …" | None needed |

# Implementation Plan: Model Catalog

**Spec**: `2026-10-12-model-catalog` | **Branch**: `2026-10-12-groq-otpm-images` (PR #17) | **Date**: 2026-10-12
**Approved plan**: the plan-mode plan of 2026-10-12 (`~/.claude/plans/iridescent-mapping-meteor.md`), approved by the user after the clarifications in `spec.md`.

## Summary

Replace every capability rule keyed by model name (Groq, Gemini, Anthropic) with a catalog filled from each provider's models API, kept in SQLite, overridable in Settings, and also used to tell which provider an ID belongs to. Learn the two limits no API reports (Groq's key output limit, Anthropic's fallback beta) from the refusals.

## Technical Context

- Node 24 / Electron, CommonJS; tests `node:test` (`npm test`).
- `better-sqlite3` in the app; `node:sqlite` in the tests (research R8).
- groq-sdk 1.6, @anthropic-ai/sdk 0.133, Gemini over `fetch`.
- Renderer: Lit, bundled by `build.js` (esbuild).

## Design

1. **`modelCatalog.js`** (new, `src/features/common/ai/`): singleton like `modelHealth`; `configure({ store, fetchers, now })`, `load`, `capabilities`, `seesImages`, `orderForImages`, `providersListing`, `providerOf`, `notePrefixProvider`, `isKnown`, `keyOutputLimit`, `snapshot`, `refresh`, `ensureKnown`, `setOverride`, `clearOverrides`, `markServerFallback`, `recordKeyOutputLimit`, `clearKeyLimits`, and the test helpers `seed` and `resetCatalog`. With no `configure`, there is no store and no fetcher (tests make no call).
2. **Table** `model_catalog` in `schema.js`; repository `repositories/modelCatalog/` (`createRepository(getDb)`, `getAll`, `upsert`, `remove`).
3. **Providers**: `listModels` / `getModel` / `normalizeModel` in each; Groq traits from the catalog plus `REASONING_DIALECTS`; `declaredMaxTokens` and the key-limit skip; Anthropic `effortLevels`, floor, cap, images, `visionOnly`, per-model beta; Gemini cap, images, `visionOnly` (`planModels`). Each `createLLM` / `createStreamingLLM` calls `ensureKnown`.
4. **Chain**: `adapterFor(id, load)` builds the three adapters from the catalog; `ensureCatalog` before the plan.
5. **Factory**: `providerFromPrefix` (last resort) and `inferProviderFromModelId(id, context)`.
6. **Main process**: `modelStateService` (`_initializeCatalog`, `refreshCatalog`, `_learnModelList`, `planModelList`, `getCatalog`, `setCapabilityOverride`; key save/remove; `fieldProvider`; providers on selected and available models; `catalog` flag in the provider config); IPC in `featureBridge.js` and `preload.js`.
7. **Settings**: `saveModelList` / async `checkModelList` through IPC; `activeListPlan`; `renderModelCapabilities` with Edit and Refresh; `getProviderForModel` from the main process's data; the listener on `model-state:updated`.
8. **Docs**: `ARCHITECTURE.md` §9.1 (new), §9, §10.1–10.4, §11; diagram 18 (new), 10, 15, 16, 17; diagrams README; `README.md`; `LIVE_INSIGHTS_AND_ASK.md`; `CHANGELOG.md`; `future-work.md` item 8; this spec folder.

## Order of work

Code first, tests right after each part, in this order: catalog and table (with its tests), Groq, Anthropic, Gemini, chain and factory, main process (with its test), Settings, docs. Most provider tests were rewritten after the provider changed, to seed the catalog instead of relying on the name tables. To make up for it, task T-BASE runs the new and changed tests against the base commit in a temporary worktree: they fail there (record in `tasks.json`).

## Constitution / pattern check

- No new provider loop: the catalog feeds the existing failover loops.
- Reads stay synchronous, so the factory and the chain plan keep their shape.
- No secret in logs or URLs (Gemini key in a header).
- The SSE protocol and the consumers are unchanged.

## Risks

| Risk | Mitigation |
|---|---|
| Anthropic's capability shape differs from the SDK types | Fixture in the SDK shape; `normalizeModel` treats anything missing as unknown; manual check with a Claude model |
| The Anthropic beta 400 resend doubles a real 400 | Only one resend; nothing is recorded unless it is accepted |
| A list read at startup slows the start | It runs in the background; requests use the saved catalog |
| Cold catalog (first start offline) | Provider defaults: Groq no images, Gemini and Anthropic images; Anthropic no effort but the floor |
| Skip rule wrongly skips a request Groq would accept | Every probe over the limit was refused (research R6); the limit expires in 24 h and is cleared with a new key |

## Verification

1. `npm test` (1163 at the end of implementation).
2. Worktree check on the base commit (T-BASE).
3. Live probes with the Groq key (research R1, R6).
4. `node build.js` and a module parse of `SettingsView.js`.
5. Mermaid render of the changed diagrams (mmdc 12.0.0).
6. Manual check in the app (quickstart §4).

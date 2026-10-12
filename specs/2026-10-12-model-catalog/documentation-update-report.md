# Documentation Update Report: Model Catalog

**Spec**: `2026-10-12-model-catalog`
**Date**: 2026-10-12
**Scope**: docs affected by this spec's code changes (T024, T-DOC-GATE)
**Method**: by hand. The documentation-reconciliation agent is not installed on this machine. I searched the live docs (`*.md`, `*.mmd` outside `specs/` and `node_modules/`) for:
- every description of what a model can do by name ("MODEL_TRAITS", "modelTraits", "acceptsEffort", "SERVER_FALLBACK_MODELS", "only Qwen 3.8 sees", "always see images", "sees images", "Opus and Sonnet 5.5");
- every description of the provider of an ID ("inferProviderFromModelId", "prefix", "vendor/model", "chainProviderOf");
- line references into the files this spec edits (`factory.js`, `groq.js`, `anthropic.js`, `gemini.js`, `providerChain.js`, `modelStateService.js`). Each was compared with the current code.

**Status: PASS**

## Updated

| Doc | Change |
|-----|--------|
| `ARCHITECTURE.md` §9 | Diagram: the catalog node. Text: `PROVIDERS` are presets; `getProviderForModel` / `inferProviderFromModelId` use the catalog first and the prefix last; the provider table's Groq row. |
| `ARCHITECTURE.md` §9.1 (new) | The catalog: diagram, resolution order, what each API reports (table), learned values, the provider of an ID, storage and refresh, Settings, what stays in code, IPC. |
| `ARCHITECTURE.md` §10.1 | New bullet: `maxOutputTokens` bound to `outputTokenLimit`, the default vision, images dropped, `visionOnly`. |
| `ARCHITECTURE.md` §10.2 | Requests: effort levels and the floor from the catalog, the cap at `max_tokens`, images, `visionOnly`. Server-side fallback: every model until refused, the 400 resend, the per-model mark. |
| `ARCHITECTURE.md` §10.3 | Presets line; diagram (catalog lookup, key-limit skip, OTPM kept); requests (catalog fields, `REASONING_DIALECTS`); the learned key output limit; key validation feeds the catalog. |
| `ARCHITECTURE.md` §10.4 | The provider of an ID; the chain's `ensureCatalog`; the screenshot row of the failure table; Images (any model the catalog says sees images; every provider follows `visionOnly`). |
| `ARCHITECTURE.md` §11 | The `model_catalog` table in the schema block. |
| `docs/diagrams/18-model-catalog.mmd` (new) | Sources, learned values, the table, refresh triggers, readers. |
| `docs/diagrams/10`, `15`, `16`, `17` | Provider of an ID; Anthropic request and per-model beta; Groq catalog lookup and key-limit skip; chain `ensureKnown` and catalog-based `seesImages`. |
| `docs/diagrams/README.md` | Rows 10, 15, 16, 17 and the new row 18. |
| `docs/LIVE_INSIGHTS_AND_ASK.md` | §4.6 Groq and chain paragraphs (catalog, kept limit), Anthropic paragraph (effort and max from the Models API). |
| `README.md` | Provider paragraph: capabilities and provider from the models APIs, shown and overridable in Settings. |
| `CHANGELOG.md` | `[Unreleased]` entry. |
| `docs/future-work.md` | Item 6: the limit is now kept. New item 8: what the catalog leaves out, and three unrelated findings of the sweep. |

All five changed or new Mermaid files and the three changed `ARCHITECTURE.md` blocks render with `@mermaid-js/mermaid-cli` 12.0.0 (`mmdc`); each SVG contains the word "catalog".

### Line references this spec moved

- `factory.js`: `PROVIDERS` `:22-110` → `:23-111`; `createSTT` / `createLLM` / `createStreamingLLM` `:169-216` → `:189-236`; `sanitizeModelId` `:165-167` → `:185`; `takeKeys` `:159` → `:179`; `splitByProvider` `:140` → `:160` (also in §10.4); `inferProviderFromModelId` `:121` → `:139`; the Ollama and Whisper entries `:85`, `:90-101` → `:86`, `:91-102`.
- `modelStateService.js`: `_autoSelectAvailableModels` → `:235`; `getProviderForModel` → `:390`; `getCurrentModelInfo` → `:498`; `_keysForModelList` → `:519`; `areProvidersConfigured` `:438-456` / `:459-477` → `:580-598`; the Ollama warm-up `:343-345` → `:461-463`; `getAvailableModels` `:361-363` → `:481-483`.
- `gemini.js` (97 lines added at the top): `:38-40` → `:135-137`; `:86-103` → `:183-200`; `:143-147` → `:240-244`; `:162-169` → `:259-266`; `:178` → `:275`; `:200-201` → `:297-298`; `:211-215` → `:308-312`; `:234-237` → `:331-334`; `:644-647` → `:753-756`; `:663-804` → `:772-921`.
- `anthropic.js`: `runWithFailover` `:546-664` → `:621-754`; `SDK_MAX_RETRIES` `:215` → `:269`; `RETRY_ROUND_DELAY_MS` `:286` → `:373`; `joinsNextRound` `:369` → `:445`; `buildRequest` `:135` → `:186`; `acceptsEffort` `:28` → `effortLevels` `:32`.
- `groq.js`: `runWithFailover` `:539-671` → `:608-769`; `buildRequest` `:160` → `:187`; `modelTraits` `:22` → `:28`; `SDK_MAX_RETRIES` `:242` → `:282`; `joinsNextRound` `:390` → `:459`; `orderForImages` `:139` → `:166`; `firstTextTimeoutMs` `:205` → `:245`.
- `providerChain.js`: `decideTurn` `:237` → `:248`.
- `docs/AUDIO_AND_STT.md`: its `factory.js` and `modelStateService.js` references, and `gemini.js:38-40`, moved as above.

## Checked, no change needed

- `docs/AUDIO_AND_STT.md` §3 (provider matrix): lists providers and presets; STT is out of scope.
- `docs/diagrams/05-ask-vision-sequence.mmd`: provider-agnostic.
- `docs/diagrams/11-gemini-failover.mmd`: the failover loop; the cap and images are request details covered in §10.1.
- `CONTRIBUTING.md`, `docs/DESIGN_PATTERNS.md`, `docs/GEMINI_503_PEAK_HOURS.md`, `docs/runbook/*`, `docs/proctoring-detection-coverage.md`, `docs/refactor-plan.md`: they do not describe model capabilities or the provider of an ID.

## Found, not fixed (history)

- `specs/2026-10-12-groq-otpm-images/spec.md` D7 ("no per-model memory of the refusal") and `specs/2026-10-12-groq-provider/` (the `MODEL_TRAITS` table) record those features' decisions as made. This spec's D7 and research R4 record the change.
- Older `CHANGELOG.md` entries are history.

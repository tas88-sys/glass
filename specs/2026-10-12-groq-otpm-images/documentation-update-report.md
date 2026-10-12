# Documentation Update Report: Groq Output Limit and Screenshots

**Spec**: `2026-10-12-groq-otpm-images`
**Date**: 2026-10-12
**Scope**: docs affected by the branch's code changes (T018, T-DOC-GATE)
**Method**: by hand. The documentation-reconciliation agent is not installed on this machine. I searched the live docs (`*.md`, `*.mmd` outside `specs/` and `node_modules/`) for:
- every description of Groq's cap, its error kinds and image routing ("Qwen", "qwen3", "sees images", "images=dropped", "too-large", "413", "2048", "GROQ_MAX_TOKENS", "OTPM", "vision");
- every description of the chain's image handling ("images first", "images-first", "see images");
- line references into the files this branch edits (`groq.js`, `groqErrors.js`, `providerChain.js`). Each was compared with the current code.

**Status: PASS**

## Updated

| Doc | Change |
|-----|--------|
| `ARCHITECTURE.md` §10.3 (Groq) | Diagram: `visionOnly` on the image step, and a "too-large 413 or 429 OTPM" edge. Text: the default cap 16,384 and why; the OTPM exception to "the declared value is not metered"; `visionOnly` and `NO_VISION_MODEL` in the images bullet; the too-large row of the error table with the 429; rate limits: the 7K / 1K split, Qwen's enforcement and its estimate, what fits (Live Answer) and what does not (Ask, Live Insights); diagnostics: `limit=` / `requested=`; the `GROQ_MAX_TOKENS` row (16384) |
| `ARCHITECTURE.md` §10.4 (lists across providers) | Diagram: `visionOnly` on the plan step. Text: the chain adds one option, `visionOnly`. Failure table: the OTPM 429 next to the 413, and a row for a screenshot with a later provider that sees images. Cooldown list: none for the OTPM 429. Images: when `visionOnly` is set, the Groq-only fallback, and why (future-work item 6) |
| `docs/diagrams/16-groq-failover.mmd` | The image step names `visionOnly` and `NO_VISION_MODEL`; the too-large edge adds the 429 OTPM and the log fields; the final messages add the output-token one |
| `docs/diagrams/17-cross-provider-chain.mmd` | The plan step names `visionOnly`; the failure edge lists OTPM |
| `docs/diagrams/README.md` | Rows 16 and 17 mention the 429 on the output limit and `visionOnly` |
| `docs/LIVE_INSIGHTS_AND_ASK.md` | The Groq paragraph: the 429 on Qwen's output limit, Ask's 16,384 cap, and the image rule's exception. The chain paragraph: no blind answer while a later provider sees the screenshot |
| `README.md` | The provider paragraph: an Ask screenshot reaches a model that sees it |
| `CHANGELOG.md` | `[Unreleased]` entry for the branch |
| `docs/future-work.md` | Item 6 marked done, with what was found, what changed, the Groq-only notice still open, and its acceptance |
| `specs/2026-10-12-groq-provider/research.md` | New R20 with the live probes and the decisions, on the provider's own record (the code comments in `groq.js` and `groqErrors.js` cite it), and its row in the summary |

All four changed Mermaid diagrams render with `@mermaid-js/mermaid-cli` 12.0.0 (`mmdc`): diagrams 16 and 17 and the two `ARCHITECTURE.md` blocks. Each SVG contains the new `visionOnly` label.

### Line references this branch moved

`groq.js` gained lines before most of the functions `ARCHITECTURE.md` §10.3 cites, and `groqErrors.js` before `classify`. Seven references were shifted to the current lines:
- `runWithFailover` `groq.js:527-648` → `:539-671`;
- `SDK_MAX_RETRIES` `:236` → `:242`;
- `joinsNextRound` `:381` → `:390`;
- `buildRequest` `groq.js:154` → `:160`;
- `orderForImages` `:133` → `:139`;
- `classify` `:62` → `:68`;
- `firstTextTimeoutMs` `:199` → `:205`.

`modelTraits` (`:22`) and `factory.js:140` did not move. The new reference `providerChain.js:237` (`decideTurn`) was checked against the file. No other live doc cites these three files by line.

## Checked, no change needed

- `docs/AUDIO_AND_STT.md` §3 (provider matrix): lists the Groq models; nothing about caps or routing.
- `docs/diagrams/05-ask-vision-sequence.mmd`: provider-agnostic. Its "text-only retry" is `askService._isMultimodalError`, which this branch does not touch.
- `docs/diagrams/10-provider-factory-and-model-state.mmd`: the Groq row lists models only.
- `ARCHITECTURE.md` §9 provider table ("only Qwen 3.8 sees images"): still true.
- `docs/LIVE_INSIGHTS_AND_ASK.md` payload table (`status: 'retrying'` on each `_reset`, "too-large" included): the reasons are unchanged.
- `CONTRIBUTING.md`, `docs/DESIGN_PATTERNS.md`, `docs/GEMINI_503_PEAK_HOURS.md`, `docs/runbook/*`, `docs/proctoring-detection-coverage.md`, `docs/refactor-plan.md`: they do not describe Groq's cap or image routing.

## Found, not fixed (history)

- `specs/2026-10-12-groq-provider/` (spec FR-009, data-model, plan, quickstart) still states the 2048 default and "the declared `max_completion_tokens` is not metered". Those files record that feature's decisions as made. R20 in the same folder records the change. The older entries of `CHANGELOG.md` are history too.
- `specs/2026-10-12-cross-provider-failover/spec.md` C2 says `groq.js` and `groqErrors.js` are not edited. That constraint was for that branch.

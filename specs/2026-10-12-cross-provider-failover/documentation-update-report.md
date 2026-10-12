# Documentation Update Report: Cross-Provider Failover

**Spec**: `2026-10-12-cross-provider-failover`
**Date**: 2026-10-12
**Scope**: docs affected by the branch's code changes (T025, T-DOC-GATE)
**Method**: by hand. The documentation-reconciliation agent is not installed on this machine. I searched the live docs (`*.md`, `*.mmd` outside `specs/` and `node_modules/`) for:
- every failover section ("failover", "Trying", "All … models failed");
- the `#10-…` anchor;
- line references into `factory.js`, `modelHealth.js`, `modelStateService.js`, `askService.js`, `summaryService.js` and `SettingsView.js`, the files this branch edits. Each one was compared with `main`.

**Status: PASS**

## Updated

| Doc | Change |
|-----|--------|
| `ARCHITECTURE.md` | §9 diagram (keys, the chain) and bullets: `takeKeys` / `splitByProvider` routing, `getCurrentModelInfo` `keys`, the first entry deciding a list's provider; provider table notes. §10 renamed "Failover: Gemini, Anthropic, Groq and across providers" (TOC and anchor). §10.1 registry bullet names the chain's `isCoolingDown`. New §10.4 Lists across providers: flowchart (renders with `mmdc`), segments, composition, stream protocol, error policy, skips, time and reserve, images, keys, cancel, messages, non-streaming, log lines, `LLM_CHAIN_DEADLINE_MS`, data note. File map row. Line references refreshed: `factory.js` (§9, §12), `modelStateService.js` (§0, §9), `modelHealth.js` (§10.1) |
| `docs/diagrams/17-cross-provider-chain.mmd` | New. Renders with `@mermaid-js/mermaid-cli`; no `call` node ID |
| `docs/diagrams/10-provider-factory-and-model-state.mmd` | `keys` in `getCurrentModelInfo`, the factory removing them, `splitByProvider` routing to `providerChain.js`, the chain reading the registry. Renders |
| `docs/diagrams/README.md` | Row 10 wording, new row 17 |
| `docs/LIVE_INSIGHTS_AND_ASK.md` | §4.3 status table: the chain's `_reset` and `All providers failed (groq → gemini)`. §4.6 renamed "Failover (Gemini, Anthropic, Groq, across providers) and debugging", with a paragraph on mixed lists |
| `docs/AUDIO_AND_STT.md` | §5: the chain is LLM-only like the rest of failover. Line references refreshed (`factory.js`, `modelStateService.js`) |
| `docs/runbook/AUDIO_TROUBLESHOOTING.md` | Line references refreshed (`modelStateService.js`, `factory.js`) |
| `README.md` | A paragraph under the provider list with the recommended mixed list; ARCHITECTURE pointer |
| `CHANGELOG.md` | `[Unreleased]` entry for the branch |
| Spec folder | `research.md` R16 (what the real providers showed under the chain) |

## Checked, no change needed

- `docs/GEMINI_503_PEAK_HOURS.md` links to `#101-gemini`, which is unchanged.
- `ARCHITECTURE.md` §10.1–10.3 describe the providers, which are unchanged. Their line references into `gemini.js`, `anthropic.js` and `groq.js` still hold.
- `docs/diagrams/05-ask-vision-sequence.mmd` says `_reset` wipes the partial answer, which also covers the chain's `_reset`.
- `docs/AUDIO_AND_STT.md` references `modelStateService.js:378` and `:286`, and `ARCHITECTURE.md` references `modelStateService.js:343-345` and `:361-363`. All sit above this branch's edit, so they did not move.
- `docs/AUDIO_AND_STT.md` provider matrix: it is about STT, and `ARCHITECTURE.md` §9 carries the LLM notes.
- `CHANGELOG.md` older entries and older specs: history, left as written.

## Found, not fixed (out of scope)

- Line references into `askService.js` and `summaryService.js` in `README.md`, `ARCHITECTURE.md` and `docs/LIVE_INSIGHTS_AND_ASK.md` were already off on `main`: they point at other code than they describe, e.g. `summaryService.js:807` is prompt text. This branch adds one line to `askService.js` and two to `summaryService.js`. These references were left for a separate pass.
- `docs/diagrams/11-gemini-failover.mmd` and its copy in `ARCHITECTURE.md` §10.1 still use `call` as a node ID, which current Mermaid rejects (found in the Anthropic spec).

## Added after review (2026-10-12)

The user asked whether Claude can go in the middle of the list. The answer is now in the docs:
- Order is priority, and any position after the first entry works, more than once. The first entry decides the field.
- Where to put Claude Haiku 5.5 and what it costs.
- How position interacts with the 60 s deadline and the 15 s reserve: a first provider that stalls to its deadline skips the middle one. This was checked over fake providers with an injected clock.

Updated: `ARCHITECTURE.md` §10.4 (intro, Time, a new "Order and position" bullet), `specs/…/quickstart.md` §2, `specs/…/research.md` R13, `docs/LIVE_INSIGHTS_AND_ASK.md` §4.6, `README.md`, `CHANGELOG.md`.

Not changed: the Settings help line still says "You can end the list with another provider's models". That is true but incomplete, and it is UI copy, not a doc.

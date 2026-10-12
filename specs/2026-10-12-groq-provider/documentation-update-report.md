# Documentation Update Report: Groq Provider

**Spec**: `2026-10-12-groq-provider`
**Date**: 2026-10-12
**Scope**: docs affected by the branch's code changes (T025, T-DOC-GATE)
**Method**: by hand. The documentation-reconciliation agent is not installed on this machine. I searched the live docs (`*.md`, `*.mmd` outside `specs/` and `node_modules/`) for:
- provider lists (OpenAI · Gemini · Anthropic …);
- "Gemini and Anthropic" wording;
- the `#10-…` anchor;
- line references into `factory.js`, `modelStateService.js`, `settingsService.js`, `SettingsView.js` and `ApiKeyHeader.js`, the files this branch edits.

**Status: PASS**

## Updated

| Doc | Change |
|-----|--------|
| `ARCHITECTURE.md` | Topology provider list. §9: Groq registry node, provider table row, the `vendor/model` → Groq rule, LLM-only gate. Line references refreshed (`factory.js`, `modelStateService.js`). §10 renamed "Gemini, Anthropic and Groq failover" (TOC and anchor). New §10.3 Groq: flowchart, request rules, stream reading, error kinds and cooldowns, timeouts, rate limits, key validation, log fields, env table. §12 local-AI line references refreshed. File map row |
| `docs/diagrams/16-groq-failover.mmd` | New. Renders with `@mermaid-js/mermaid-cli` |
| `docs/diagrams/10-provider-factory-and-model-state.mmd` | Groq entry, the `vendor/model` rule, Groq model-list input, shared registry wording. Renders |
| `docs/diagrams/01-system-topology.mmd` | Groq in both provider lists. Renders |
| `docs/diagrams/README.md` | Row 10 wording, new row 16 |
| `docs/LIVE_INSIGHTS_AND_ASK.md` | §4.3 status table names Groq `_reset` reasons and `All Groq models failed`; §4.6 renamed "Failover (Gemini, Anthropic, Groq) and debugging", with a Groq paragraph |
| `docs/AUDIO_AND_STT.md` | Provider matrix row; LLM-provider list in the Deepgram caveat. Line references refreshed (`factory.js`, `modelStateService.js`, `SettingsView.js`) |
| `docs/runbook/AUDIO_TROUBLESHOOTING.md` | Line references refreshed (`modelStateService.js`, `factory.js`) |
| `README.md` | Provider line with the Groq key link; ARCHITECTURE pointer; Ask streaming providers |
| `CHANGELOG.md` | `[Unreleased]` entry for the branch |
| Spec folder | Implementation findings: data-model content mapping (text-only content is one string), FR-021 `served_by` |

## Checked, no change needed

- `docs/GEMINI_503_PEAK_HOURS.md` links to `#101-gemini`, which is unchanged.
- `ARCHITECTURE.md` §10.1 and §10.2 describe Gemini and Anthropic, which are unchanged. Their line references into `gemini.js` and `anthropic.js` still hold.
- `docs/LIVE_INSIGHTS_AND_ASK.md` (`settingsService.js:217`) and `ARCHITECTURE.md` (`settingsService.js:207`) are not shifted. The `removeApiKey` edit keeps the line count.
- `CHANGELOG.md` older entries and older specs: history, left as written.

## Found, not fixed (out of scope)

- `docs/diagrams/11-gemini-failover.mmd` and its copy in `ARCHITECTURE.md` §10.1 still use `call` as a node ID, which current Mermaid rejects. This was found in the Anthropic spec and is left for a separate fix.
- Some line references in `docs/AUDIO_AND_STT.md` and `ARCHITECTURE.md` predate this branch and point into files it does not edit. They were not audited.

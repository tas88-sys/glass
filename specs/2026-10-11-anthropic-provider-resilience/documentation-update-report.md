# Documentation Update Report: Anthropic Provider Resilience

**Spec**: `2026-10-11-anthropic-provider-resilience`
**Date**: 2026-10-11
**Scope**: docs affected by the branch's code changes (T025, T-DOC-GATE)
**Method**: by hand. The documentation-reconciliation agent is not installed on this machine. I searched the live docs (`*.md`, `*.mmd` outside `specs/` and `node_modules/`) for:
- the retired model (`claude-3`);
- Anthropic and Claude mentions;
- the moved registry (`geminiModelRotator.js` line references);
- `factory.js` and `modelStateService.js` line references;
- the `#10-gemini-failover` anchor;
- Gemini-only wording about failover.

**Status: PASS**

## Updated

| Doc | Change |
|-----|--------|
| `ARCHITECTURE.md` | §9: registry node, Anthropic table row (new presets, CSV failover), and how `getProviderForModel` maps `claude-` / `gemini-` IDs. §10 is renamed "Gemini and Anthropic failover", with §10.1 Gemini and a new §10.2 Anthropic (flowchart, request rules, error kinds and cooldowns, timeouts, cancellation, key validation, log fields, env table). Line references refreshed (`factory.js`, `geminiModelRotator.js`, `modelHealth.js`). File map row added. TOC updated |
| `docs/diagrams/15-anthropic-failover.mmd` | New. Renders with `@mermaid-js/mermaid-cli` |
| `docs/diagrams/10-provider-factory-and-model-state.mmd` | New presets, the prefix rule, the shared `modelHealth.js`. Renders |
| `docs/diagrams/README.md` | Rows 10 and 15 |
| `docs/LIVE_INSIGHTS_AND_ASK.md` | §4.3 status table names Anthropic `_reset` and `All Claude models failed`; §4.6 renamed "Failover (Gemini, Anthropic) and debugging", with an Anthropic paragraph |
| `docs/AUDIO_AND_STT.md` | Provider matrix row; `factory.js` line references |
| `docs/GEMINI_503_PEAK_HOURS.md` | Link to the renamed section (`#101-gemini`) |
| `README.md` | Provider line and the ARCHITECTURE pointer |
| `CHANGELOG.md` | `[Unreleased]` entry for the branch |
| Spec folder | Implementation findings: research R13, D12, FR-019 and FR-021 wording, data model, contracts (type-check PASS), EDGE_CASES E46–E49, quickstart check 10, plan risks |

## Checked, no change needed

- `docs/diagrams/01-system-topology.mmd`: lists Anthropic among the providers, which is still true.
- `ARCHITECTURE.md` §7 and §16 ("No STT failover"): still true. Anthropic has no STT.
- `CHANGELOG.md` older entries and older specs: history, left as written.

## Found, not fixed (out of scope)

- `docs/diagrams/11-gemini-failover.mmd` and its copy in `ARCHITECTURE.md` §10.1 use `call` as a node ID. Current Mermaid treats `call` as a keyword, so both fail to parse in `mmdc`. The fix is a rename, in a separate change.

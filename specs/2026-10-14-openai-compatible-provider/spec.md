---
# Context Optimization Metadata
# Purpose: Enable efficient partial reads (~200 tokens vs ~2500 for full file)
meta:
  spec_id: 2026-10-14-openai-compatible-provider
  spec_name: openai-compatible-provider
  status: in-progress    # draft | in-progress | approved | completed
  phase: verify          # specify | clarify | plan | tasks | preflight | feature-start | implement | verify
  created: 2026-10-14
  updated: 2026-10-14

# Quick Reference (for checkpoint resume)
summary:
  goals:
    - {id: G1, description: "One more LLM provider, 'openai-compatible': any OpenAI chat-completions server at a base URL typed in Settings (OpenRouter, SambaNova, Mistral, a local OmniRoute), in every LLM lane (Ask, Live Answer, Live Insights)", priority: HIGH}
    - {id: G2, description: "Its failover is as resilient as Groq's (ordered list, cooldowns, second round, first-text/idle/request timeouts, cancellation down to the HTTP request, one log line per attempt), and it joins mixed lists through the cross-provider chain", priority: HIGH}
    - {id: G3, description: "Measure, before relying on it, what a gateway (OmniRoute) adds to the time to first token against calling the provider directly", priority: HIGH}
    - {id: G4, description: "Groq, Gemini, Anthropic, OpenAI, Ollama and Whisper behave exactly as today", priority: HIGH}
  constraints:
    - {id: C1, description: "The SSE protocol the consumers read (_reset, _final_model, [DONE], err.userMessage) is reused as is. askService.js, askStreamState.js and summaryService.js are not edited", type: TECHNICAL}
    - {id: C2, description: "No new dependency (the openai SDK is already one) and no database migration", type: TECHNICAL}
    - {id: C3, description: "Never log prompt, answer or reasoning text, nor the key. The endpoint's host may be logged", type: SECURITY}
    - {id: C4, description: "The endpoint never receives another provider's key, nor OpenAI's settings from the environment (OPENAI_API_KEY, OPENAI_ORG_ID, OPENAI_PROJECT_ID)", type: SECURITY}
    - {id: C5, description: "A key never travels over plain http to another machine: the base URL is https, or http on localhost only", type: SECURITY}
    - {id: C6, description: "Tests run under npm test with every SDK mocked. The only live call is the opt-in latency probe", type: TECHNICAL}
  decisions:
    - {id: D1, decision: "A generic OpenAI-compatible provider, not an OmniRoute integration. OmniRoute is one possible endpoint; the same code reaches OpenRouter, SambaNova or Mistral directly", rationale: "Research R1: OmniRoute is a whole server (not an embeddable library), its free 'Claude/GPT' relies on OAuth reuse and client impersonation that breaks several providers' terms, and its internal fallback would hide failures from the app's own chain. A generic provider keeps every option open and the app's failover in charge"}
    - {id: D2, decision: "The base URL and the key are saved as one credential string '<base URL>\\n<key>' in the provider's api_key column", rationale: "Every path that carries a key (provider_settings, encryption, getAllApiKeys, the chain's keys map, the catalog fetchers) carries this one unchanged. A base_url column would need a migration and new plumbing in five places (C2)"}
    - {id: D3, decision: "One endpoint at a time", rationale: "Several endpoints need several credentials per provider ID, which the key model does not have. A gateway (OmniRoute) behind the one endpoint aggregates many, if the user wants that"}
    - {id: D4, decision: "Failover copies groq.js's loop; differences: 400/422 fail over to the next model (Groq ends the request), only 401/403 end it; 402 and 404 cool the model 5 min; no reasoning fields are sent", rationale: "Behind an aggregator each model may be served by a different upstream: one model's refusal says little about the next. Each server names its reasoning fields its own way; a field a model does not know is a 400"}
    - {id: D5, decision: "Cooldowns are kept under 'openai-compatible:<id>' in the shared registry; the chain asks each adapter whether a model cools down", rationale: "OpenRouter and OmniRoute use Groq's 'vendor/model' IDs. With shared keys, Groq's daily-limit 429 on openai/gpt-oss-120b would also block the endpoint's copy, the very fallback the user set up"}
    - {id: D6, decision: "An ID no catalog lists stays in an OpenAI-compatible field or run, unless it is a claude-/gemini- ID", rationale: "The endpoint's IDs have no prefix of their own, and 'vendor/model' is as much OpenRouter's shape as Groq's. Without this rule an unlisted OpenRouter ID typed after the endpoint's models would start a Groq run"}
    - {id: D7, decision: "No preset model (llmModels: []), so onboarding does not offer the provider. It is set in Settings", rationale: "Onboarding asks for one key; this provider needs a base URL and the endpoint's own model IDs"}
    - {id: D8, decision: "Default output cap 8,192 (Groq: 16,384); first-text timeout 20 s (Groq: 15 s)", rationale: "An endpoint that does not report a model's output limit may refuse a larger cap. A gateway may try upstreams of its own before the first token"}

critical_requirements:
  type: feature-major
  portal: app
  ui_changes: minor
---

# Feature Specification: OpenAI-compatible Provider

**Feature Branch**: `2026-10-14-openai-compatible-provider`
**Created**: 2026-10-14
**Status**: In progress (implemented and measured; `free-stack` works in OmniRoute, Glass's Settings not saved yet)
**Input**: User request (2026-10-14), after a review of OmniRoute (research R1): implement the generic OpenAI-compatible provider and a proof of concept that measures OmniRoute's time to first token (translated from Portuguese).

---

## System Context

**Systems**: The Glass Electron main process (a new provider module and its error classifier; the factory, the model catalog, the cross-provider chain and `modelStateService` learn it) and the Settings view in the renderer.
**Databases**: None changed. The credential is the provider's `provider_settings.api_key` row; its models are rows of `model_catalog` under provider `openai-compatible`.
**Integrations**: Any OpenAI chat-completions server: `GET {base}/models`, `GET {base}/models/{id}`, `POST {base}/chat/completions` (streamed).

---

## Requirements

- **FR-001** Settings shows an OpenAI-compatible block: Base URL, API Key (may be empty), Save/Clear, LLM Model ID (comma-separated list) and Save. Save checks the URL (C5) and lists the endpoint's models; a refused key, a missing `/models` and an unreachable host each get their own message.
- **FR-002** The endpoint's models list feeds the catalog: vision, output maximum and reasoning from the fields Groq, OpenRouter and OmniRoute use (`normalizeModel`). Not reported → text only, no cap, no reasoning.
- **FR-003** Streaming and non-streaming calls fail over across the list as in D4, announce each switch with `_reset`, end with `_final_model` and `[DONE]`, and fail with one short `userMessage`.
- **FR-004** A list may mix the endpoint's models with Groq, Gemini and Anthropic models in either direction (cross-provider chain); each provider gets only its own key (C4) and its own cooldowns (D5).
- **FR-005** A saved credential whose URL is not valid fails the request with a message to save it again; creating the LLM never throws.
- **FR-006** `scripts/probe-openai-compatible-ttft.js` measures headers, ttft and total time of the same request on several endpoints, alternating their order, and prints p50/p90 per target and the ttft difference against the first (G3).
- **FR-007** The live eval reads `OPENAI_COMPATIBLE_BASE_URL` and `OPENAI_COMPATIBLE_API_KEY` from `.env`.

## Verification

| Check | Result |
|---|---|
| `npm test` | 1483 pass, 0 fail (1433 before; +50: provider, errors, factory, chain, integration) |
| App: Settings shows the block (CDP screenshot of the real window, renderer rebuilt) | Done 2026-10-14: three fields, Save/Clear, model Save; the active-list note names the Groq field |
| Probe, Groq direct (2 runs, 2026-10-14) | Works: ttft 681 / 898 ms; an absent local gateway fails fast with "Connection error." (research R2) |
| Probe, Groq direct vs. via OmniRoute (6 runs, 2026-10-14) | Done: ttft p50 558 vs. 637 ms, **+79 ms** through OmniRoute. With its default settings OmniRoute hides a 429 by waiting up to ~9 s (research R2) |
| `free-stack` through OmniRoute (2026-10-14) | Done: 4/4, ttft p50 618 ms (Cohere). Failover to Cloudflare checked with Cohere inactive (research R2) |

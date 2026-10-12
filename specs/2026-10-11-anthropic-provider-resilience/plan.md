---
# Context Optimization Metadata
# Purpose: Enable efficient partial reads (~200 tokens vs ~2500 for full file)
meta:
  spec_id: 2026-10-11-anthropic-provider-resilience
  spec_name: anthropic-provider-resilience
  phase: plan
  updated: 2026-10-11

# Quick Reference (for checkpoint resume)
summary:
  tech_stack: [JavaScript (CommonJS, main process), Lit 2.7.4 (renderer), Electron 30 / Node 20.16, node:test]
  external_deps: ["@anthropic-ai/sdk 0.56.0 (installed, unchanged)"]
  test_strategy: {unit: 45, integration: 45, contract: 0, e2e_manual: 10}
  deployment: immediate  # ships with the next Glass desktop build; Gemini users see no change
---

# Implementation Plan: Anthropic Provider Resilience

**Branch**: `2026-10-11-anthropic-provider-resilience` | **Date**: 2026-10-11 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/2026-10-11-anthropic-provider-resilience/spec.md`

## Execution Flow (/plan command scope)

```
1. Load spec → Fill Technical Context → Constitution Check          ✓
2. Phase 0.1: Research + Testing Strategy (MANDATORY)               ✓
3. Phase 0.2: Permissions (single local user → trivial)            ✓ (N/A documented)
4. Phase 0.3: Integration Analysis (MANDATORY)                      ✓
5. Phase 0.4: Design Pre-flight (Minor UI → skip)                   ⏭ skipped
6. Phase 0.5: Infrastructure (env vars)                             ✓
7. Phase 0.6: Error/Rescue Mapping                                  ✓
8. Phase 0.7: Implementation Timeline Risks (MANDATORY)             ✓
9. Phase 1: Design & Contracts → data-model.md, contracts/, quickstart.md  ✓
10. Plan Phase 2 approach                                           ✓
```

> SpecKit is not installed on this machine, so this set was written by hand in the format of the previous specs. `preflight-report.md` is not generated.

## Summary

Make Claude usable in Glass, and as resilient as the Gemini path.

**Technical approach:**
- Fix the four blockers (research R1). Validate keys with `models.list`. Replace the retired preset with Opus 5.5, Sonnet 5.5 and Haiku 5.5. Map `claude-…` IDs and lists to Anthropic, with a Settings input like Gemini's. Stop sending `temperature`.
- Rewrite `anthropic.js` around a pure `buildRequest` (effort only where accepted, a `max_tokens` floor for thinking, server-side refusal fallback on Opus/Sonnet 5.5).
- Add a failover loop modelled on `gemini.js`: ordered list, shared cooldown registry, `_reset`/`_final_model`, first-text timeout, request deadline, idle timeout, cancellation that aborts the HTTP request, `userMessage`, attempt logs.
- Add an Anthropic error classifier, `anthropicErrors.js`.
- Move the provider-neutral half of the Gemini rotator to `modelHealth.js`. Gemini re-exports it unchanged.

The consumers (Ask, Live Answer, Live Insights) are not edited. They already speak the protocol.

## Technical Context

**Language/Version**: JavaScript (CommonJS in main, ES modules bundled by esbuild in renderer); Electron 30 (Node 20.16).
**Primary Dependencies**: `@anthropic-ai/sdk` 0.56.0 (installed). No new dependency.
**Storage**: None new. In-memory cooldown registry (existing, now shared).
**Testing**: `node --test` via `npm test`. `Module._load` intercepts `@anthropic-ai/sdk` (the pattern in `gemini.test.js`). Manual live checks with the user's key.
**Target Platform**: Electron desktop (Windows primary; macOS must not break).
**Performance Goals**:
- Failover adds no wait beyond the SDK's own backoff (≤ ~0.5 s with `maxRetries: 1`).
- Cancellation aborts the HTTP request within one event-loop turn.
- Time to first token is measured, not gated (SC-006).
**Constraints**: spec C1–C6.
**Scale/Scope**:
- New: `modelHealth.js`, `anthropicErrors.js`, and 5 test files.
- Rewritten: `anthropic.js` (~330 → ~550 lines).
- Edited: `geminiModelRotator.js` (re-export), `factory.js`, `modelStateService.js`, `SettingsView.js`, and docs.
**System Context**: Framework-internal (spec System Context).
**Architecture Docs Read**:
- `ARCHITECTURE.md` (provider table, `:543-576`);
- `docs/diagrams/10-provider-factory-and-model-state.mmd`, `11-gemini-failover.mmd`;
- `docs/GEMINI_503_PEAK_HOURS.md`;
- `specs/2026-05-26-gemini-failover-design/spec.md` (locked decisions, CSV pass-through).

## Constitution Check
*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Assessment | Status |
|-----------|------------|--------|
| I. Test-First Development | Each module has a test task before its implementation task (T010/T011 …). The stream loop's tests are written against the mocked SDK first. | PASS |
| II. Specification-Driven Development | User request → research (gemini.js inventory, SDK reading) → spec → this plan → tasks.json | PASS |
| III. Verification Before Completion | Automated: SC-002..SC-005. Manual: SC-001 and SC-006 with a live key (quickstart §3). | PASS |
| IV. Skills Before Action | Anthropic API facts (models, sampling, effort, refusals, errors) were taken from the `claude-api` skill reference, and SDK behavior from the installed source. | PASS |
| V. Code Review Compliance | Pure request builder and classifier; one failover loop; no text in logs (C3). | PASS |

### AI & Machine Learning *(applicable)*

**Does this feature involve AI/ML?** [x] **Yes**: LLM provider integration.

| Aspect | Approach |
|--------|----------|
| Model choice | User-configured list. Presets are the current Opus, Sonnet and Haiku. The interview default is decided from measured TTFT (SC-006) |
| Failure posture | Every failure ends in a readable `userMessage`, or in the next model. Never a silent empty answer |
| Safety refusals | Handled as a per-model outcome (server-side fallback where offered, then the list) |
| Cost control | Cancellation aborts generation. SDK retries are capped per attempt. Effort defaults to `low` |
| Data | Same data path as Gemini today (prompt, transcript excerpt, screenshot) |

## Project Structure

### Documentation (this feature)
```
specs/2026-10-11-anthropic-provider-resilience/
├── spec.md
├── research.md
├── plan.md                 # this file
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── anthropic-provider.contracts.d.ts
│   ├── EDGE_CASES.md
│   └── tsconfig.json
├── tasks.json
└── acceptance-tests.yaml
```

### Source Code (repository root)
```
src/features/common/ai/providers/
├── modelHealth.js            NEW   moved from geminiModelRotator (no behavior change)
├── geminiModelRotator.js     EDIT  re-exports modelHealth; keeps classifyError, parseRetryAfter
├── anthropicErrors.js        NEW   classify, retryAfterMs, shortErrorMessage
├── anthropic.js              REWRITE
└── __tests__/
    ├── modelHealth.test.js       NEW  provider-neutral registry; Gemini re-export identity
    ├── anthropicErrors.test.js   NEW
    ├── anthropicRequest.test.js  NEW  buildRequest, acceptsEffort, timeouts, validateApiKey
    └── anthropic.test.js         NEW  streaming + non-streaming failover (mocked SDK)
src/features/common/ai/factory.js                   EDIT  presets; inferProviderFromModelId
src/features/common/ai/__tests__/factory.test.js    NEW   presets, prefix mapping
src/features/common/services/modelStateService.js   EDIT  use inferProviderFromModelId; custom Anthropic list
src/ui/settings/SettingsView.js                     EDIT  Anthropic model input + validator
ARCHITECTURE.md, README.md, docs/AUDIO_AND_STT.md,
docs/diagrams/10-…, docs/diagrams/15-anthropic-failover.mmd (NEW), CHANGELOG.md   EDIT (T-DOC-GATE)
```

**Structure Decision**: The failover loop stays inside `anthropic.js`, as Gemini's stays inside `gemini.js` (spec D3). Only provider-neutral state moves to a shared module. A shared engine is follow-up work.

## Phase 0.1: Research & Testing Strategy

### Production Log & Error Evidence
**Skip condition met**: `feature-major`. Research R1 documents, from the code, why the current provider cannot work. No production logs exist: Anthropic has not been usable.

### Research

Consolidated in [research.md](./research.md):

| # | Question | Decision |
|---|----------|----------|
| R1 | Why does Anthropic fail today? | Retired validation model, retired preset, no `claude-` mapping, `temperature` rejected; also `content[0]` and no cancel |
| R2 | What does Gemini do? | 20 capabilities; Anthropic has about 1.5 |
| R3 | What does the SDK give? | Retries before the stream; nothing for mid-stream errors, silent bodies, cancel |
| R4 | Share the registry? | Yes, `modelHealth.js` |
| R5 | What to port? | All but hedging and the second round; add idle timeout and per-attempt retries |
| R6 | Thinking/effort/sampling | No sampling; effort `low` where accepted; `max_tokens` floor 4096 |
| R7 | Refusals | Server-side fallback on Opus/Sonnet 5.5; list failover for all |
| R8 | Error taxonomy | Own classifier with `unavailable` |
| R9 | Key validation | `models.list` |
| R10 | SDK version | Stay on 0.56.0 |
| R11 | Latency | Measure in a real session (SC-006) |

### Testing Strategy

| Check | Output |
|-------|--------|
| External APIs | Anthropic Messages and Models APIs, mocked in every test |
| Test types | Unit (classifier, request builder, factory), integration (stream and non-stream loops against a scripted fake SDK), manual (quickstart §3, live key) |
| Mocking strategy | Intercept `@anthropic-ai/sdk` with `Module._load` (as `gemini.test.js` does). The fake re-exports the **real** SDK error classes (required before the interceptor is installed), so `status`, `error`, `requestID` and `instanceof` match production. The fake stream is an async iterator of scripted events. It honours `signal`, and like the real SDK it **ends without throwing** on abort. |

**Testing Summary**:
```
Feature type: Backend logic + small settings UI
Quota risks: None in tests (mocked); manual checks spend a few cents with the user's key
Estimated tests: ~50–60 cases across 5 files
Distribution: Unit ~45%, Integration ~45%, Manual ~10%
```

**GATE**: The quota-limited API is never called by the suite. PASS.

## Phase 0.2: Permissions Design

Single local user; no roles. N/A.

## Phase 0.3: Integration Analysis

### Codebase Pattern Discovery

| Pattern Area | Finding | Use |
|--------------|---------|-----|
| Failover loop | `gemini.js:442-815` (`streamChat`): `track()`, `inFlight`, `safeEnqueue`, `logAttempt`/`logRequest`, `timeLeft()` | Same structure in `anthropic.js`, without `raceFirstChunk` |
| Non-stream failover | `gemini.js:249-278` `callWithFailover` | Same shape, Anthropic classifier |
| Env tuning | `GEMINI_FIRST_CHUNK_TIMEOUT_MS`, `GEMINI_HEDGE_DELAY_MS`, `GEMINI_REQUEST_DEADLINE_MS` read per call | `ANTHROPIC_*` read per call (data-model) |
| Provider prefix | `modelStateService.js:307`, `SettingsView.js:962` (`gemini-`) | Shared `inferProviderFromModelId` in `factory.js` (main); the renderer keeps its own copy (it has no `require`) |
| Custom model in list | `modelStateService.js:363-369` (Gemini only) | Same branch for Anthropic |
| Settings CSV input | `SettingsView.js:745-783` `handleSaveGeminiModels`, `:1338-1358` | Copy for Anthropic, LLM only |
| SDK mock | `gemini.test.js:28-60` `Module._load` override + cache clear | Same for `@anthropic-ai/sdk` |

### Code Interconnectedness Gate

| Pattern Needed | Evidence | Decision |
|----------------|----------|----------|
| Cooldown registry | `geminiModelRotator.js:14-78` | EXTRACT to `modelHealth.js`, re-export |
| Error classification | `geminiModelRotator.classifyError` | NEW for Anthropic (research R8); Gemini's unchanged |
| SSE protocol | `askStreamState.js`, `summaryService.parseLiveAnswerSseLine` | REUSE unchanged (C1) |
| Multimodal retry in Ask | `askService._isMultimodalError` (`:494`) catches only synchronous `streamChat` errors | Unaffected: `streamChat` resolves at once and errors flow through the body, as with Gemini |

### Contract Validation

`contracts/anthropic-provider.contracts.d.ts` was type-checked with `npx -p typescript@5.4.5 tsc -p contracts/tsconfig.json`: **PASS** (2026-10-11).

## Phase 0.4: Design Pre-flight

**Skipped**: Minor UI (one input, help line and button, copied from the Gemini block).

## Phase 0.5: Infrastructure & Migrations

| Item | Detail |
|------|--------|
| Env vars (all optional) | `ANTHROPIC_EFFORT` (`low`), `ANTHROPIC_MIN_MAX_TOKENS` (4096), `ANTHROPIC_FIRST_TEXT_TIMEOUT_MS` (20 s Haiku / 45 s), `ANTHROPIC_REQUEST_DEADLINE_MS` (60 s; 0 disables), `ANTHROPIC_IDLE_TIMEOUT_MS` (30 s; 0 disables), `ANTHROPIC_SERVER_FALLBACK` (`off` disables). Documented in T025 |
| Dependency | None new. `@anthropic-ai/sdk` stays at 0.56.0 |
| DB migrations | None. A stored retired ID shows as "(custom)" and fails with a clear message (E39) |
| Rollout | Ships with the next build. Users on Gemini see no change |
| Rollback | Revert the branch. No data to migrate back |

## Phase 0.6: Error/Rescue Mapping

See spec § Error Handling and `data-model.md` (error kinds, cooldowns). Rule: **`streamChat` never rejects and never throws to the consumer**. Every failure becomes `_reset` plus the next model, or a stream error carrying `userMessage`. `chat()` and `generateContent()` throw an error with `userMessage`. `validateApiKey` never throws.

## Phase 0.7: Implementation Timeline Risks

| Phase | Anticipated Blocker | Resolution | Add to Task Context? |
|-------|--------------------|------------|---------------------|
| Core | An aborted SDK stream ends the `for await` quietly, so a timeout looks like a normal end with no `message_stop` | Every attempt keeps `timedOut`/`aborted` flags and checks them after the loop; no `message_stop` and no flag = transient error (`stream ended early`) | Y (T018/T019) |
| Core | Fake SDK too lenient: tests pass, production differs | The fake uses the real SDK error classes and the real quiet-abort behavior; one test feeds a raw stream `error` body through `APIError` | Y (T018) |
| Core | Idle timer fires during silent thinking (pings are invisible) | Idle timer starts only after the first text delta; before that the first-text timeout governs | Y (T018/T019) |
| Core | SDK retries stack on top of failover and blow the deadline | `maxRetries` 1 when a model remains; the SDK `timeout` is 15 s; the deadline check runs before each attempt | Y (T019) |
| Core | Server-side fallback beta rejected for this org → every Opus/Sonnet call 400s | Detect a 400 naming `anthropic-beta`/`fallbacks`, resend once without, disable for the process (FR-009, E41) | Y (T018/T019) |
| Core | Mid-stream server fallback misread as failure | A `fallback` block is not an error and sends no `_reset`; only the final `stop_reason` counts | Y (T018) |
| Shared | Moving rotator functions changes Gemini behavior | Pure move plus re-export; `gemini.test.js` and `geminiModelRotator.test.js` must pass unedited (AT-NEG-001) | Y (T010/T011) |
| Wiring | `modelStateService` cannot load under `npm test` (better-sqlite3 ABI, previous spec R2) | Prefix logic lives in `factory.js` (pure) and is tested there; `modelStateService` only calls it | Y (T022/T023) |
| UI | Renderer cannot `require` the factory | `SettingsView` keeps a two-line copy of the prefix rule; manual check + `npm run build:renderer` | Y (T024) |
| Verify | `npm run lint` cannot run (eslint not installed) | `node --check` on changed main-process files + `npm run build:renderer` | Y (T-FINAL) |
| Verify | Live checks cost money and need the user's key | Manual tasks only, run by or with the user | Y (T-VERIFY-MANUAL) |

## Prior Lessons Applied

| Lesson | Applied How |
|--------|-------------|
| Enqueue after cancel throws `ERR_INVALID_STATE` (`gemini.js:669-675`) | `safeEnqueue` from day one (FR-017) |
| Server keeps the connection open after the last chunk (`fix/gemini-stream-end-and-retry`) | Stop at `message_stop` (FR-015) |
| A request can be accepted and then stall (`feat/gemini-hedged-requests`) | First-text timeout + deadline + idle timeout (FR-013, FR-014) |
| Unknown errors should not stop failover (gemini-failover spec) | Fail-open `transient` for unknown errors (data-model) |
| Peak-hour 503 bursts (`docs/GEMINI_503_PEAK_HOURS.md`) | A model list across Anthropic tiers, which have separate rate limits |

## Phase 1: Design & Contracts

1. **[data-model.md](./data-model.md)** covers the model list, health entry and cooldowns, error kinds, request params, content mapping, attempt stats, stream protocol and state transitions.
2. **[contracts/anthropic-provider.contracts.d.ts](./contracts/anthropic-provider.contracts.d.ts)** gives the module surfaces of `modelHealth`, `anthropicErrors`, `anthropic` and the factory additions. Type-checked: PASS.
3. **[contracts/EDGE_CASES.md](./contracts/EDGE_CASES.md)** lists 41 edge cases mapped to FRs.
4. **[quickstart.md](./quickstart.md)** covers setup, automated checks and 9 manual checks mapped to FRs and SCs.

## Phase 2: Task Planning Approach

Strategy: tests before implementation for each module. The shared registry move comes first (lowest risk, guards Gemini). Then the pure pieces (classifier, request builder), then the loops, then wiring and UI, then docs and the live checks.

| Group | Tasks | Gate |
|-------|-------|------|
| Shared registry | T010–T011 | none |
| Pure core | T012–T015 | T011 |
| Key validation | T016–T017 | T015 |
| Stream loop | T018–T019 | T013, T015 |
| Non-stream loop | T020–T021 | T019 |
| Model selection | T022–T024 | T017 |
| Docs | T025, T-DOC-GATE | T021, T024 |
| Verify | T-VERIFY-MANUAL, T-FINAL | T-DOC-GATE |

## Progress Tracking

| Phase | Status | Skip If |
|-------|--------|---------|
| 0.1 Research + Testing | [x] Complete | Never |
| 0.2 Permissions | [x] Complete (N/A) | No roles |
| 0.3 Integration | [x] Complete | Never |
| 0.4 Design Pre-flight | [x] Skipped (Minor UI) | Minor UI |
| 0.5 Infrastructure | [x] Complete | - |
| 0.6 Error/Rescue Mapping | [x] Complete | - |
| 0.7 Timeline Risks | [x] Complete | Never |
| 1 Design & Contracts | [x] Complete | - |
| 2 Task Planning | [x] tasks.json generated | - |

**Gates**: Constitution Check PASS · No NEEDS CLARIFICATION (three items deferred with defaults) · Contracts tsc PASS · Bugfix gate N/A

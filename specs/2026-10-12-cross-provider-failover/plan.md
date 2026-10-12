---
# Context Optimization Metadata
# Purpose: Enable efficient partial reads (~200 tokens vs ~2500 for full file)
meta:
  spec_id: 2026-10-12-cross-provider-failover
  spec_name: cross-provider-failover
  phase: plan
  updated: 2026-10-12

# Quick Reference (for checkpoint resume)
summary:
  tech_stack: [JavaScript (CommonJS, main process), Lit 2.7.4 (renderer), Electron 30 / Node 20.16, node:test]
  external_deps: []   # no new dependency
  test_strategy: {unit: 40, integration: 50, contract: 0, e2e_manual: 10}
  deployment: immediate  # ships with the next Glass desktop build; single-provider lists see no change
---

# Implementation Plan: Cross-Provider Failover

**Branch**: `2026-10-12-cross-provider-failover` | **Date**: 2026-10-12 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/2026-10-12-cross-provider-failover/spec.md`

## Execution Flow (/plan command scope)

```
1. Load spec → Fill Technical Context → Constitution Check          ✓
2. Phase 0.1: Research + Testing Strategy (MANDATORY)               ✓
3. Phase 0.2: Permissions (single local user → trivial)            ✓ (N/A documented)
4. Phase 0.3: Integration Analysis (MANDATORY)                      ✓
5. Phase 0.4: Design Pre-flight (Minor UI → skip)                   ⏭ skipped
6. Phase 0.5: Infrastructure (env var only)                         ✓
7. Phase 0.6: Error/Rescue Mapping                                  ✓
8. Phase 0.7: Implementation Timeline Risks (MANDATORY)             ✓
9. Phase 1: Design & Contracts → data-model.md, contracts/, quickstart.md  ✓
10. Plan Phase 2 approach                                           ✓
```

> SpecKit is not installed on this machine, so this set was written by hand in the format of `2026-10-11-anthropic-provider-resilience` and `2026-10-12-groq-provider`. `preflight-report.md` is not generated.

## Summary

Let one model list name several providers, so that when Groq's free budget runs out mid-interview, Gemini (or Claude) answers instead of an error.

**Technical approach:**
- **Segments.** `factory.splitByProvider` cuts the stored list into runs of one provider's IDs, using the existing prefix rule. A list with one run takes today's path untouched.
- **Composition, not a new engine.** A new `providerChain.js` calls each provider's public `createStreamingLLM` / `createLLM` with its own sub-list and key, reads its SSE stream, passes the events through, and moves on when it fails. The providers keep every rule they have and are not edited.
- **Skip what just failed.** One read-only query in the shared registry, `modelHealth.isCoolingDown`, lets the chain skip a provider whose models are all cooling down, so a spent Groq costs no time after the first failure.
- **Time.** A 60 s chain deadline for an answer to start and a 15 s reserve for the fallback. Each provider keeps its own wait before its second round (changed after review; first built with no wait).
- **Images.** Image-capable segments go first for a screenshot.
- **Keys.** `getCurrentModelInfo('llm')` returns the keys of every provider the list names. The three LLM call sites pass them; the factory strips them before any provider call.
- **Settings.** Each model field accepts other providers' IDs after its first entry, when their key is saved.

## Technical Context

**Language/Version**: JavaScript (CommonJS in main, ES modules bundled by esbuild in renderer); Electron 30 (Node 20.16).
**Primary Dependencies**: none new.
**Storage**: none new. The list stays in `provider_settings.selected_llm_model`; the cooldown registry stays in memory.
**Testing**: `node --test` via `npm test`. Fake providers for the chain; the real providers with `Module._load`-mocked SDKs for the integration file (the pattern of `groq.test.js`, `gemini.test.js`, `anthropic.test.js`). Manual live checks with the user's keys.
**Target Platform**: Electron desktop (Windows primary; macOS must not break).
**Performance Goals**:
- A single-provider list adds no work beyond one split of the list.
- A switch adds no wait beyond the failed segment's own attempts and rounds.
- A skipped segment costs no request.
- Cancellation reaches the running provider within one event-loop turn.

**Constraints**: spec C1–C7.
**Scale/Scope**:
- New: `providerChain.js` (~350 lines), 2 test files (~60–80 cases).
- Edited: `factory.js` (split + routing, ~40 lines), `modelHealth.js` (one function), `modelStateService.js` (keys, ~15 lines), `askService.js` (1 line), `summaryService.js` (2 lines), `SettingsView.js` (three validators, help lines), `factory.test.js` and `modelHealth.test.js` (additions), docs.

**System Context**: Framework-internal (spec System Context).
**Architecture Docs Read**:
- `ARCHITECTURE.md` §9 (provider abstraction) and §10.1–10.3 (Gemini, Anthropic and Groq failover);
- `docs/diagrams/10-provider-factory-and-model-state.mmd`, `11-gemini-failover.mmd`, `15-anthropic-failover.mmd`, `16-groq-failover.mmd`;
- `specs/2026-10-12-groq-provider/*`, especially R5 (budget), R19 (first session) and the deferred item on mixed lists.

## Constitution Check
*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Assessment | Status |
|-----------|------------|--------|
| I. Test-First Development | Each module has a test task before its implementation task (T010/T011 …). The chain is tested against fake providers first, then over the real ones | PASS |
| II. Specification-Driven Development | User request → research (code, local key presence, Groq and Gemini limits, real 429 examples) → spec → this plan → tasks.json | PASS |
| III. Verification Before Completion | Automated: SC-002..SC-005. Manual: SC-001 and SC-006 with the live keys (quickstart §4) | PASS |
| IV. Skills Before Action | Limits read in the user's Groq console and AI Studio; real daily-limit 429 bodies from two public reports, marked as such (R2); Claude prices from the bundled API reference | PASS |
| V. Code Review Compliance | Pure planning functions; one composition module; providers untouched; no text or keys in logs (C3, C4) | PASS |

### AI & Machine Learning *(applicable)*

**Does this feature involve AI/ML?** [x] **Yes**: LLM provider routing.

| Aspect | Approach |
|--------|----------|
| Model choice | User-configured list across providers; recommendation in research R13 |
| Failure posture | Every failure ends in an answer from a later provider or in a readable `userMessage`; never a silent empty answer |
| Rate limits | Each provider keeps its own handling; a provider whose models all cool down is skipped (R7) |
| Cost control | The fallback is free (Gemini free tier) by default; the optional Claude Haiku 5.5 costs about US$0.10–0.15 per full hour (R3). Cancellation still aborts generation |
| Data | The same request may go to a second provider the user configured (spec Data Scoping) |

## Project Structure

### Documentation (this feature)
```
specs/2026-10-12-cross-provider-failover/
├── spec.md
├── research.md
├── plan.md                 # this file
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── cross-provider-failover.contracts.d.ts
│   ├── EDGE_CASES.md
│   └── tsconfig.json
├── tasks.json
└── acceptance-tests.yaml
```

### Source Code (repository root)
```
src/features/common/ai/
├── factory.js                          EDIT  splitByProvider; createLLM/createStreamingLLM strip keys, route ≥2 segments
├── providerChain.js                    NEW   adapters, hasImages, orderSegments, skipReason, segmentTiming, failureMessage,
│                                             chainDeadlineMs, createChainStreamingLLM, createChainLLM
├── __tests__/factory.test.js           EDIT  split and routing cases (existing assertions unchanged)
├── __tests__/providerChain.test.js              NEW  pure tables + stream/once paths over fake providers
├── __tests__/providerChain.integration.test.js  NEW  real groq.js, gemini.js, anthropic.js; SDKs mocked
└── providers/
    ├── modelHealth.js                  EDIT  isCoolingDown (read-only)
    └── __tests__/modelHealth.test.js   EDIT  isCoolingDown cases (additions only)
src/features/common/services/modelStateService.js   EDIT  getCurrentModelInfo('llm') adds keys
src/features/ask/askService.js                      EDIT  keys: modelInfo.keys
src/features/listen/summary/summaryService.js       EDIT  keys: modelInfo.keys (Live Answer, Live Insights)
src/ui/settings/SettingsView.js                     EDIT  mixed-list validators; help lines
ARCHITECTURE.md, docs/LIVE_INSIGHTS_AND_ASK.md, docs/diagrams/10-…, docs/diagrams/17-cross-provider-chain.mmd (NEW),
docs/diagrams/README.md, README.md, CHANGELOG.md     EDIT (T-DOC-GATE)
```

**Structure Decision**: The chain is a separate module composed over the providers' public interface (spec D3, research R4). It sits beside `factory.js`, not under `providers/`, because it is not a provider: it never calls an SDK. A shared failover engine stays future work.

## Phase 0.1: Research & Testing Strategy

### Production Log & Error Evidence
**Skip condition met**: `feature-major`; no production logs of a spent budget exist yet. The design rests on two real daily-limit 429 bodies (research R2) and the providers' existing, tested behavior. Check 12 (quickstart) records the first real one.

### Research

Consolidated in [research.md](./research.md):

| # | Question | Decision |
|---|----------|----------|
| R1 | What happens today? | One provider per request; "All Groq models failed" until the budget refills |
| R2 | What does a spent Groq look like? | 429 TPD, "try again in" minutes; transient, 5 min cooldown, no second round; continuous refill |
| R3 | Who takes over? | Gemini Flash-Lite (key saved; 15 RPM, 500 RPD each); Claude Haiku 5.5 optional |
| R4 | Where does the loop live? | Composition over the public interface; providers unchanged |
| R5 | How do keys reach the chain? | `getCurrentModelInfo` returns `keys`; three one-line call-site edits |
| R6 | How is the list cut? | Consecutive runs by prefix; only anthropic, gemini, groq |
| R7 | How is a spent provider skipped? | `isCoolingDown`; skip a fully cooling segment while a later one can run |
| R8 | Time limits | 60 s chain deadline; 15 s reserve; each provider keeps its own round wait |
| R9 | Images | Image-capable segments first |
| R10 | Which failures move on? | All; only cancel stops |
| R11 | Stream | Pass-through plus one `_reset` `reason: 'provider'` |
| R12 | Settings | Mixed list in the first provider's field |
| R13 | Recommended list | Groq ×3, then Gemini Flash-Lite ×2 (+ Claude Haiku optional) |
| R15 | To verify live | Four checks, one opportunistic |

### Testing Strategy

| Check | Output |
|-------|--------|
| External APIs | Groq, Gemini, Anthropic; mocked in every test |
| Test types | Unit (split, plan, timing, messages, registry query, factory routing), integration (chain over fake providers; chain over the real providers with mocked SDKs), manual (quickstart §4, live keys) |
| Mocking strategy | **Fake providers** expose `createStreamingLLM(opts)` / `createLLM(opts)`. They record the options (key, model, deadline). They return scripted SSE `Response`s: deltas, `_reset`, `_final_model`, `[DONE]`, an error with `userMessage`, an error after text, an end without `[DONE]`, a hang that records `cancel()`. **Real providers**: `Module._load` intercepts `groq-sdk`, `@google/generative-ai` (+ `@google/genai`) and `@anthropic-ai/sdk`, as each provider's own test does, so the provider code under test is the shipping code. `modelHealth.resetHealth()` before each test |

**Testing Summary**:
```
Feature type: Backend logic + small settings UI
Quota risks: None in tests (mocked); manual checks spend fractions of a cent and a few free-tier requests
Estimated tests: ~70–90 cases across 2 new files + factory and modelHealth additions
Distribution: Unit ~40%, Integration ~50%, Manual ~10%
```

**GATE**: The quota-limited APIs are never called by the suite. PASS.

## Phase 0.2: Permissions Design

Single local user; no roles. N/A.

## Phase 0.3: Integration Analysis

### Codebase Pattern Discovery

| Pattern Area | Finding | Use |
|--------------|---------|-----|
| Provider entry points | `groq.js:674,720`, `anthropic.js:690,732`, `gemini.js:283,442`: `createLLM` / `createStreamingLLM` accept `requestDeadlineMs` and `retryRoundDelayMs` | The chain passes them per segment (FR-009) |
| Provider deadlines | `groq.requestDeadlineMs()`, `anthropic.requestDeadlineMs()`, `gemini.requestDeadlineMs()` are exported and env-aware | Adapter `requestDeadlineMs` |
| Image traits | `groq.modelTraits`, `groq.orderForImages` exported | Adapter `seesImages`, `firstModel` |
| Stream wrapper | `groq.js:720-780` (`inFlight`, `cancel()`, `safeEnqueue`, `_final_model`, `[DONE]`) | Same shape for the chain's own stream |
| SSE parsing | `summaryService.parseLiveAnswerSseLine` (`:258-272`); `askService` reader loop | The chain buffers by `\n\n` and parses `data:` lines the same way |
| Non-stream wrapper | `groq.js:674-708` (`chat`, `generateContent`) | Chain `createChainLLM` tries segment instances in turn |
| Logs | `groq.js` `logAttempt` / `logRequest` | `[LLM Chain]` segment and request lines (FR-015) |
| Env tuning | `optionalTimeoutMs` (`groq.js:205`) | `chainDeadlineMs(env)` |
| Prefix rule | `factory.inferProviderFromModelId` (`:119`) | `splitByProvider` builds on it |
| Renderer copy of the rule | `SettingsView.getProviderForModel` (`:1011-1031`) | The validators reuse its tests per entry |
| Settings CSV handlers | `handleSaveGeminiModels` (`:745`), `handleSaveAnthropicModels` (`:785`), `handleSaveGroqModels` (`:813`) | Same normalization; new per-entry rule (FR-005) |
| SDK mocks | `gemini.test.js:28-50`, `groq.test.js:87-92`, `anthropic.test.js:71-80` | Combined in the integration file |

### Code Interconnectedness Gate

| Pattern Needed | Evidence | Decision |
|----------------|----------|----------|
| Cooldown registry | `modelHealth.js` (shared by all three) | EXTEND with one read-only query (FR-016); nothing else changes |
| Failover per provider | The three loops | REUSE through their public interface (D3) |
| SSE protocol | `askStreamState.js`, `summaryService.parseLiveAnswerSseLine` | REUSE unchanged (C1); `reason: 'provider'` is a new value consumers pass along without branching |
| Key storage | `providerSettingsRepository.getByProvider` | REUSE for the keys map |
| Settings per-provider fields | `SettingsView.js:1385-1456` | REUSE; only validators and help text change |

### Contract Validation

`contracts/cross-provider-failover.contracts.d.ts` was type-checked with `npx -p typescript@5.4.5 tsc -p contracts/tsconfig.json`: **PASS** (2026-10-12).

## Phase 0.4: Design Pre-flight

**Skipped**: Minor UI (validators and one help sentence per field).

## Phase 0.5: Infrastructure & Migrations

| Item | Detail |
|------|--------|
| Env vars (optional) | `LLM_CHAIN_DEADLINE_MS` (60 s; 0 disables). Documented in T025 |
| Dependency | None |
| DB migrations | None |
| Rollout | Ships with the next build. Users with single-provider lists see no change |
| Rollback | Revert the branch. A stored mixed list then goes whole to its first provider, which fails the IDs it does not know and moves to its own next model (quickstart §5) |

## Phase 0.6: Error/Rescue Mapping

See spec § Error Handling and `data-model.md`. The rules match the providers':
- **The chain's `streamChat` never rejects and never throws to the consumer.** Every failure becomes `_reset` plus the next segment, or a stream error carrying `userMessage`.
- `chat()` and `generateContent()` throw an error with `userMessage`.
- A segment that throws synchronously while being created counts as a failed segment.

## Phase 0.7: Implementation Timeline Risks

| Phase | Anticipated Blocker | Resolution | Add to Task Context? |
|-------|--------------------|------------|---------------------|
| Core | SSE events split across chunks, or several in one chunk | Buffer bytes with a `TextDecoder` (stream mode) and cut on `\n\n`. Tests feed events split mid-JSON and several per chunk | Y (T014/T015) |
| Core | A provider closes its stream without `[DONE]` (bug or cancel race) | Counts as a failure (FR-011); test E13 | Y (T014) |
| Core | Cancelling the chain while a segment's `streamChat` promise is still pending | Keep the pending promise; when it resolves after cancel, cancel its body at once; never start the next segment | Y (T014/T015) |
| Core | `reader.cancel()` on a provider stream that already errored | Wrapped in try/catch; a cancel never raises | Y (T015) |
| Core | Passing `retryRoundDelayMs: 0` changes a provider's rounds in ways its tests never ran | All three loops already take `retryRoundDelayMs` and compare `timeLeft() <= delay`; 0 is a valid value. The integration file ran a Groq second round at 0. Superseded after review: the chain no longer passes it (T026) | Y (T018) |
| Integration | Mocking three SDKs in one file collides with the providers' own tests | Each test file is its own process under `node --test`; the integration file clears the provider modules from `require.cache` before loading them, as `groq.test.js` does | Y (T018) |
| Wiring | `modelStateService` cannot load under `npm test` (better-sqlite3 ABI) | The key-map rule is `splitByProvider` (pure, tested in the factory); `modelStateService` only loops over it and reads rows. `node --check` plus manual check 4 | Y (T021) |
| Wiring | Consumer tests stub `getCurrentModelInfo` without `keys` | `keys: undefined` is valid; E3 covers it; `liveAnswer*.test.js` stay unedited | Y (T021) |
| UI | The renderer cannot `require` the factory; Ollama names can contain `/` | Per-entry check in the renderer: `claude-` → anthropic, `gemini-` → gemini, `vendor/model` not an installed Ollama name → groq; anything else refused. `npm run build:renderer` + manual checks 1–2 | Y (T022) |
| Verify | Forcing a Groq failure live without spending its budget | An unknown first model (404 → `unavailable`, 5 min cooldown) and `GROQ_FIRST_TEXT_TIMEOUT_MS=1` (quickstart checks 4, 7) | Y (T-VERIFY-MANUAL) |
| Verify | The real daily-limit 429 cannot be produced on demand | Check 12 is opportunistic; the design does not depend on the message text (any 429 is transient) | N |
| Verify | `liveAnswer.test.js` flakes under the parallel suite (pre-existing) | Rerun; not an assertion failure | N |
| Verify | `npm run lint` cannot run (eslint not installed) | `node --check` on changed main-process files + `npm run build:renderer` | Y (T-FINAL) |

## Prior Lessons Applied

| Lesson | Applied How |
|--------|-------------|
| Enqueue after cancel throws `ERR_INVALID_STATE` (`gemini.js:669-675`) | `safeEnqueue` in the chain stream (FR-012) |
| A cancel must reach the HTTP request (Groq FR-018) | The chain cancels the segment's reader, which runs the provider's own `cancel()` |
| A deadline must never cut a streaming answer (Gemini, Anthropic, Groq) | The chain deadline applies only until the first delta (FR-010) |
| Fakes too lenient pass while production differs (Groq T018) | An integration file runs the real providers over mocked SDKs (SC-003) |
| `factory.test.js` assertions must stay (Groq AT-NEG-007) | Additions only, guarded again |
| A `call` node ID breaks current Mermaid (Anthropic T025) | Diagram 17 avoids it |

## Phase 1: Design & Contracts

1. **[data-model.md](./data-model.md)** covers:
   - the model list, segments and the keys map;
   - the chain adapter table;
   - plan entries, skip rules and deadlines;
   - segment outcomes, the stream protocol and the state transitions.
2. **[contracts/cross-provider-failover.contracts.d.ts](./contracts/cross-provider-failover.contracts.d.ts)** gives the surfaces of the factory additions, `modelHealth.isCoolingDown`, `getCurrentModelInfo`'s `keys` and `providerChain`. Type-checked: PASS.
3. **[contracts/EDGE_CASES.md](./contracts/EDGE_CASES.md)** lists 55 edge cases mapped to FRs.
4. **[quickstart.md](./quickstart.md)** covers both providers' limits, the list, env, automated checks and 12 manual checks.

## Phase 2: Task Planning Approach

Tests before implementation for each piece, as in the last two specs:
1. The registry query.
2. The pure plan.
3. The stream path.
4. The non-stream path.
5. The integration over real providers.
6. Then wiring (factory, `modelStateService`, call sites), Settings, docs and the live checks.

There is no SDK task (T005) and no live probe (T006): nothing new is called. The provider behavior the chain relies on is already tested, and the live checks use the app.

| Group | Tasks | Gate |
|-------|-------|------|
| Registry | T010–T011 | none |
| Pure plan | T012–T013 | T011 |
| Stream chain | T014–T015 | T013 |
| Non-stream chain | T016–T017 | T015 |
| Real providers | T018–T019 | T017 |
| Wiring | T020–T021 | T019 |
| Settings | T022 | T021 |
| Docs | T025, T-DOC-GATE | T022 |
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

**Gates**: Constitution Check PASS · No NEEDS CLARIFICATION (two items deferred with defaults) · Contracts tsc PASS · Bugfix gate N/A

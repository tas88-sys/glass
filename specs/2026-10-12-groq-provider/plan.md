---
# Context Optimization Metadata
# Purpose: Enable efficient partial reads (~200 tokens vs ~2500 for full file)
meta:
  spec_id: 2026-10-12-groq-provider
  spec_name: groq-provider
  phase: plan
  updated: 2026-10-12

# Quick Reference (for checkpoint resume)
summary:
  tech_stack: [JavaScript (CommonJS, main process), Lit 2.7.4 (renderer), Electron 30 / Node 20.16, node:test]
  external_deps: ["groq-sdk ^1.6.0 (new, 0 dependencies; first task, own commit)"]
  test_strategy: {unit: 45, integration: 45, contract: 0, e2e_manual: 10}
  deployment: immediate  # ships with the next Glass desktop build; users of other providers see no change
---

# Implementation Plan: Groq Provider

**Branch**: `2026-10-12-groq-provider` | **Date**: 2026-10-12 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/2026-10-12-groq-provider/spec.md`

## Execution Flow (/plan command scope)

```
1. Load spec → Fill Technical Context → Constitution Check          ✓
2. Phase 0.1: Research + Testing Strategy (MANDATORY)               ✓
3. Phase 0.2: Permissions (single local user → trivial)            ✓ (N/A documented)
4. Phase 0.3: Integration Analysis (MANDATORY)                      ✓
5. Phase 0.4: Design Pre-flight (Minor UI → skip)                   ⏭ skipped
6. Phase 0.5: Infrastructure (env vars, dependency)                 ✓
7. Phase 0.6: Error/Rescue Mapping                                  ✓
8. Phase 0.7: Implementation Timeline Risks (MANDATORY)             ✓
9. Phase 1: Design & Contracts → data-model.md, contracts/, quickstart.md  ✓
10. Plan Phase 2 approach                                           ✓
```

> SpecKit is not installed on this machine, so this set was written by hand in the format of `2026-10-11-anthropic-provider-resilience`. `preflight-report.md` is not generated.

## Summary

Add Groq as a provider, as resilient as the Anthropic path from PR #13, following the same steps.

**Technical approach:**
- **SDK first.** First, alone: add `groq-sdk` ^1.6.0 (no dependencies), with a load-and-stream test under Electron's Node 20.16 (research R3). Then, optionally with the user's key, one live streamed probe that settles the chunk-shape questions before the loop is written (T006, research R17).
- **Selection.** Register `groq` in the factory with three presets (`openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `qwen/qwen3.8-27b`). Map `vendor/model` IDs to Groq, and add a Settings input like Anthropic's.
- **Request builder.** Write `groq.js` around a pure `buildRequest`:
  - reasoning per family;
  - the caller's token cap plus a reasoning allowance, since reasoning counts toward `max_completion_tokens`;
  - images only to the vision model;
  - `temperature` passed through.
- **Failover loop.** Copy the failover loop from `anthropic.js` and adapt it to chat-completion chunks:
  - stop at `finish_reason`, because the SDK reads past `[DONE]`;
  - treat `x_groq.error` as a failure;
  - image-capable models first for image requests;
  - a `too-large` outcome for the 413 TPM refusal.
- **Classifier.** Add a Groq error classifier, `groqErrors.js`.
- **Shared registry.** Reuse `modelHealth.js` unchanged.

The consumers (Ask, Live Answer, Live Insights) are not edited. They already speak the protocol.

## Technical Context

**Language/Version**: JavaScript (CommonJS in main, ES modules bundled by esbuild in renderer); Electron 30 (Node 20.16).
**Primary Dependencies**: `groq-sdk` ^1.6.0 (new; no transitive dependencies).
**Storage**: None new. In-memory cooldown registry (existing, shared).
**Testing**: `node --test` via `npm test`. `Module._load` intercepts `groq-sdk` (the pattern in `anthropic.test.js` and `gemini.test.js`). Manual live checks with the user's key.
**Target Platform**: Electron desktop (Windows primary; macOS must not break).
**Performance Goals**:
- Failover to the next model adds no wait. The only deliberate wait is the 2 s before a second round.
- Cancellation aborts the HTTP request within one event-loop turn.
- Time to first token is measured, not gated (SC-006). The live check showed queue times of 0.08–0.2 s (gpt-oss) and 1.5 s (Qwen).

**Constraints**: spec C1–C7.
**Scale/Scope**:
- New: `groq.js` (~600 lines, modelled on the 805-line `anthropic.js` minus the refusal and beta paths), `groqErrors.js` (~150), 3 test files, `scripts/smoke-groq-sdk.js`, `scripts/probe-groq-stream.js`.
- Edited: `package.json` and lockfile, `factory.js`, `factory.test.js` (additions only), `modelStateService.js`, `settingsService.js`, `SettingsView.js`, `ApiKeyHeader.js` (footer), and docs.

**System Context**: Framework-internal (spec System Context).
**Architecture Docs Read**:
- `ARCHITECTURE.md` §9 (provider table) and §10.2 (Anthropic failover);
- `docs/diagrams/10-provider-factory-and-model-state.mmd`, `15-anthropic-failover.mmd`;
- `specs/2026-10-11-anthropic-provider-resilience/*` (the template and its implementation findings R13, D12, E46–E49).

## Constitution Check
*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Assessment | Status |
|-----------|------------|--------|
| I. Test-First Development | Each module has a test task before its implementation task (T012/T013 …). The loop tests are written against the mocked SDK first. | PASS |
| II. Specification-Driven Development | User request → research (Groq docs, SDK source, live calls) → spec → this plan → tasks.json | PASS |
| III. Verification Before Completion | Automated: SC-002..SC-005. Manual: SC-001 and SC-006 with a live key (quickstart §4). | PASS |
| IV. Skills Before Action | Groq facts come from Groq's docs (2026-10-12), the `groq-sdk` 1.6.0 source and live calls through Composio's GroqCloud connection. Rate-limit accounting comes from secondary sources, marked as such (R5). | PASS |
| V. Code Review Compliance | Pure request builder and classifier; one failover loop; no text in logs (C3). | PASS |

### AI & Machine Learning *(applicable)*

**Does this feature involve AI/ML?** [x] **Yes**: LLM provider integration.

| Aspect | Approach |
|--------|----------|
| Model choice | User-configured list. Presets are the three active chat models; recommendation in research R14, confirmed by measured TTFT (SC-006) |
| Failure posture | Every failure ends in a readable `userMessage`, or in the next model. Never a silent empty answer |
| Rate limits | The user's org is on the Free plan: 8K TPM and 200K TPD per model (research R5). Each model has its own budget, so the list spreads load. `tpm_left` is logged. Cross-provider lists are the follow-up for a budget that runs out |
| Cost control | Cancellation aborts generation. The SDK never retries; at most one extra round. Reasoning effort is low or none. Prompt caching is automatic on gpt-oss |
| Data | Same data path as Gemini and Anthropic today (prompt, transcript excerpt, career context, screenshot) |

## Project Structure

### Documentation (this feature)
```
specs/2026-10-12-groq-provider/
├── spec.md
├── research.md
├── plan.md                 # this file
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── groq-provider.contracts.d.ts
│   ├── EDGE_CASES.md
│   └── tsconfig.json
├── tasks.json
└── acceptance-tests.yaml
```

### Source Code (repository root)
```
src/features/common/ai/providers/
├── modelHealth.js            REUSE (unchanged)
├── groqErrors.js             NEW   classify, retryAfterMs, retryAfterHeaderMs, shortErrorMessage, tooLargeNumbers, errorCode
├── groq.js                   NEW   GroqProvider, modelTraits, buildRequest, orderForImages, timeouts, createLLM, createStreamingLLM, createSTT (placeholder)
└── __tests__/
    ├── groqErrors.test.js    NEW  real groq-sdk error classes, both body shapes
    ├── groqRequest.test.js   NEW  buildRequest, modelTraits, orderForImages, timeouts, validateApiKey
    └── groq.test.js          NEW  streaming + non-streaming failover (mocked SDK)
package.json, package-lock.json                     EDIT  groq-sdk ^1.6.0 (T005, own commit)
scripts/smoke-groq-sdk.js                           NEW   load + stream a canned SSE response (run under Electron's Node)
scripts/probe-groq-stream.js                        NEW   one live streamed request; prints keys, timings, headers; never text (T006)
src/features/common/ai/factory.js                   EDIT  groq entry; classNameMap; inferProviderFromModelId slash rule
src/features/common/ai/__tests__/factory.test.js    EDIT  Groq cases added; existing assertions untouched
src/features/common/services/modelStateService.js   EDIT  groq (llm) in getProviderForModel; custom-list branch
src/features/settings/settingsService.js            EDIT  'groq' in removeApiKey
src/ui/settings/SettingsView.js                     EDIT  apiKeys.groq; slash rule after Ollama; Groq model input + validator
src/ui/app/ApiKeyHeader.js                          EDIT  footer names Groq
ARCHITECTURE.md, README.md, docs/AUDIO_AND_STT.md, docs/LIVE_INSIGHTS_AND_ASK.md,
docs/diagrams/10-…, docs/diagrams/16-groq-failover.mmd (NEW), docs/diagrams/README.md, CHANGELOG.md   EDIT (T-DOC-GATE)
```

**Structure Decision**: The failover loop lives inside `groq.js`, as Anthropic's lives inside `anthropic.js` (spec D3). Only `modelHealth.js` is shared. A shared engine is follow-up work. It is the natural next step once both loops have live logs, and it will remove about 300 duplicated lines.

## Phase 0.1: Research & Testing Strategy

### Production Log & Error Evidence
**Skip condition met**: `feature-major`, new provider; no production logs exist. Four live API calls (research R2, R5, R6) stand in for logs on the questions that shape the design.

### Research

Consolidated in [research.md](./research.md):

| # | Question | Decision |
|---|----------|----------|
| R1 | What exists today? | Nothing; nine registration points; consumers untouched |
| R2 | Which models? | `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `qwen/qwen3.8-27b` (live list); slash → Groq |
| R3 | Which SDK? | `groq-sdk` ^1.6.0, first and alone |
| R4 | What does the SDK do? | Uncapped, uncancellable retry waits; quiet abort; reads past `[DONE]`; two error-body shapes |
| R5 | Rate limits | Free plan, 8K TPM and 200K TPD per model; declared budget not metered (live); one ~1 h interview fits (~240K typical of 400K), two a day probably not; `too-large`; `tpm_left` |
| R6 | Reasoning | gpt-oss `low` + `include_reasoning: false`; Qwen `none`; 1024 allowance |
| R7 | Images | Vision model first; images dropped for text-only models |
| R8 | Error taxonomy | Own classifier with `too-large` and `model_` codes |
| R9 | Key validation | `models.list`, `gsk_` |
| R10 | What to port | The Anthropic loop, minus refusal and beta; token rule inverted |
| R11 | Timeouts | 15 s / 45 s / 15 s |
| R12–R13 | Retries, streaming | In the loop; every call streams |
| R14 | Recommended list | `openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b` |
| R15–R16 | Caching, STT | Automatic; cached tokens free against rate limits; shared 2.4K prefix; no STT |
| R17 | Open questions | Six live checks (T006, T-VERIFY-MANUAL) |

### Testing Strategy

| Check | Output |
|-------|--------|
| External APIs | Groq chat completions and models, mocked in every test |
| Test types | Unit (classifier, request builder, traits, ordering, factory), integration (stream and non-stream loops against a scripted fake SDK), manual (quickstart §4, live key) |
| Mocking strategy | Intercept `groq-sdk` with `Module._load`, as `anthropic.test.js` does. The fake re-exports the **real** `groq-sdk` error classes (required before the interceptor is installed), so `status`, `error` and `instanceof` match production. HTTP errors are built with `APIError.generate(status, { error: {…} }, undefined, headers)` (whole body). Stream errors use `new APIError(undefined, {…}, undefined, headers)` (inner object). The fake stream is an async iterator of scripted chunks. It honours `signal` and, like the real SDK, **ends without throwing** on abort. It can also **hang after the last chunk** to prove the attempt stops at `finish_reason`. `withResponse()` returns `{ data, response }` with scripted headers |

**Testing Summary**:
```
Feature type: Backend logic + small settings UI
Quota risks: None in tests (mocked); manual checks spend fractions of a cent with the user's key
Estimated tests: ~130–150 cases across 3 new files + factory additions
Distribution: Unit ~45%, Integration ~45%, Manual ~10%
```

**GATE**: The quota-limited API is never called by the suite. PASS.

## Phase 0.2: Permissions Design

Single local user; no roles. N/A.

## Phase 0.3: Integration Analysis

### Codebase Pattern Discovery

| Pattern Area | Finding | Use |
|--------------|---------|-----|
| Failover loop | `anthropic.js:546-664` `runWithFailover` (rounds, deadline, `timeLeft`, `endCancelled`, `userMessage`) | Same structure in `groq.js`; reasons and messages per spec FR-014, FR-020 |
| One attempt | `anthropic.js:441-525` `runAttempt` (timers, quiet-abort flags, `finally` abort, `track/untrack`) | Same structure; chunk handling per FR-017 |
| Opening the stream | `anthropic.js:408-430` `openStream` with `withResponse()` | Simpler: no beta retry; read `x-request-id` and `x-ratelimit-remaining-tokens` from `response.headers` |
| Second round rule | `anthropic.js:369-376` `joinsNextRound` | Same; also excludes 422 and `too-large` |
| Streaming wrapper | `anthropic.js:732-792` (`inFlight`, `cancel()`, `safeEnqueue`, `_final_model`, `[DONE]`) | Copy |
| Non-stream wrapper | `anthropic.js:690-717` (`complete`, sink that drops partial text on reset) | Copy, plus `orderForImages` for `generateContent` parts |
| Logs | `anthropic.js:333-359` `logAttempt` / `logRequest` | Same shape, Groq fields (FR-021) |
| Env tuning | `envNumber`, `optionalTimeoutMs` (`anthropic.js:36-41, 184-188`) | Same helpers, `GROQ_*` names |
| Classifier | `anthropicErrors.js` (status → type → fail-open; header parsing; envelope stripping) | Same layout; Groq body shapes, codes and `too-large` |
| Provider prefix | `factory.js` `inferProviderFromModelId`; `SettingsView.js:983-997` copy | Add the slash rule after `claude-`/`gemini-`; in the renderer, after an Ollama-name check |
| Custom model in list | `modelStateService.js:363` (gemini, anthropic) | Add `groq` |
| Settings CSV input | `SettingsView.js:785-808` `handleSaveAnthropicModels`, `:1392-1404` | Copy for Groq, with the slash validator |
| SDK mock | `anthropic.test.js` `Module._load` override and cache clear | Same for `groq-sdk` |
| Smoke script | `scripts/smoke-anthropic-sdk.js` | Same checks for `groq-sdk` |

### Code Interconnectedness Gate

| Pattern Needed | Evidence | Decision |
|----------------|----------|----------|
| Cooldown registry | `modelHealth.js` | REUSE unchanged (C2) |
| Error classification | `anthropicErrors.js` | NEW `groqErrors.js` (body shapes and kinds differ; research R8). Header parsing duplicated on purpose, so `anthropicErrors.js` stays untouched; extract later (spec Out of Scope) |
| SSE protocol | `askStreamState.js`, `summaryService.parseLiveAnswerSseLine` | REUSE unchanged (C1) |
| Multimodal retry in Ask | `askService._isMultimodalError` (`:494`) catches only synchronous errors | Not reachable with streaming providers. The provider never sends an image to a text-only model instead (D8) |
| Provider list in the UI | `SettingsView.js:1296`, `ApiKeyHeader.js:431-455` | Data-driven; no change beyond the model block and the footer |

### Contract Validation

`contracts/groq-provider.contracts.d.ts` was type-checked with `npx -p typescript@5.4.5 tsc -p contracts/tsconfig.json`: **PASS** (2026-10-12).

## Phase 0.4: Design Pre-flight

**Skipped**: Minor UI (one input, help line and button, copied from the Anthropic block; one footer word).

## Phase 0.5: Infrastructure & Migrations

| Item | Detail |
|------|--------|
| Env vars (all optional) | `GROQ_REASONING_EFFORT` (gpt-oss `low`, Qwen `none`), `GROQ_MAX_TOKENS` (2048), `GROQ_REASONING_TOKENS` (1024), `GROQ_FIRST_TEXT_TIMEOUT_MS` (15 s), `GROQ_REQUEST_DEADLINE_MS` (45 s; 0 disables), `GROQ_IDLE_TIMEOUT_MS` (15 s; 0 disables). Documented in T025 |
| Dependency | `groq-sdk` ^1.6.0 in T005, its own commit; `npm install` runs the existing `postinstall` (native rebuild for Electron). About 2 MB on disk, no transitive packages |
| DB migrations | None. `provider_settings.provider` is free text |
| Rollout | Ships with the next build. Users on other providers see no change |
| Rollback | Revert the branch. A leftover `groq` settings row is harmless |

## Phase 0.6: Error/Rescue Mapping

See spec § Error Handling and `data-model.md` (error kinds, cooldowns). The rules are the same as Anthropic's:
- **`streamChat` never rejects and never throws to the consumer.** Every failure becomes `_reset` plus the next model, or a stream error carrying `userMessage`.
- `chat()` and `generateContent()` throw an error with `userMessage`.
- `validateApiKey` never throws.

## Phase 0.7: Implementation Timeline Risks

| Phase | Anticipated Blocker | Resolution | Add to Task Context? |
|-------|--------------------|------------|---------------------|
| SDK | `groq-sdk` fails to load or stream under Electron's Node 20.16 (`npm test` runs plain Node 24 and would not notice) | T005 runs `scripts/smoke-groq-sdk.js` with `ELECTRON_RUN_AS_NODE=1` before any other task. If it fails, stop and report. The fallback is the `openai` 4.104 package with `baseURL` (research R3), which needs a spec change | Y (T005) |
| Core | The SDK keeps reading after `[DONE]` until the server closes the connection, so the attempt would hang after the last token | Stop at the first chunk with `finish_reason` and abort. A test feeds a fake stream that never ends after that chunk | Y (T018/T019) |
| Core | Usage may arrive in a chunk after the one with `finish_reason` (OpenAI's `include_usage` shape) and be missed | T006 checks it live (V1). If usage comes later, wait up to 250 ms for it after `finish_reason`, then abort. The answer is complete either way | Y (T006, T019) |
| Core | An aborted SDK stream ends the `for await` quietly, so a timeout looks like a normal end with no `finish_reason` | Same as Anthropic: `timedOut`/`aborted` flags checked after the loop. No `finish_reason` and no flag means transient | Y (T018/T019) |
| Core | Fake SDK too lenient: tests pass, production differs | The fake uses the real `groq-sdk` error classes, both body shapes, the quiet abort and a hang after the last chunk | Y (T018) |
| Core | Error codes (`model_not_found`, `model_decommissioned`, permission codes) are not in this release's docs | Match the `model_` prefix and fall back to the status. Live checks 6–7 confirm | Y (T012/T013) |
| Core | Secondary sources say the declared budget is metered against TPM; the live checks on the user's org say it is not (research R5). Groq could change this | Handled either way: a 413 is `too-large`, which never cools down and never retries, and the message shows Groq's own numbers | N |
| Verify | The Free plan's 200K tokens per model per day can run out during T-VERIFY-MANUAL (20 Live Answers alone use about 140K on one model) | Run check 9 on a fresh day, before the other checks; the other checks use Ask with short prompts | Y (T-VERIFY-MANUAL) |
| Core | `include_reasoning: false` still sends `delta.reasoning` | Ignored by the chunk handler and never logged; T006 checks it (V3) | Y (T019) |
| Core | Image routing reorders the list, which surprises a reader of the logs | `attempt i/n` lines name the model; the request line logs `order=vision-first` when it applied | Y (T019) |
| Shared | Editing `factory.js` changes Claude or Gemini mapping | The slash rule runs after the existing prefix checks; existing `factory.test.js` assertions stay unedited (AT-NEG-001) | Y (T022/T023) |
| Wiring | `modelStateService` cannot load under `npm test` (better-sqlite3 ABI) | Prefix logic stays in `factory.js` (pure, tested). `modelStateService` only calls it (same as Anthropic T023) | Y (T022/T023) |
| UI | The renderer cannot `require` the factory, and Ollama names can contain `/` | `SettingsView` keeps its copy of the rule, checks `this.ollamaModels` first, then applies the slash rule. Manual check + `npm run build:renderer` | Y (T024) |
| Verify | `npm run lint` cannot run (eslint not installed) | `node --check` on changed main-process files + `npm run build:renderer` | Y (T-FINAL) |
| Verify | `liveAnswer.test.js` flakes under the parallel suite ("Unable to deserialize cloned data"), seen on `main` | Pre-existing; rerun the suite. It is not an assertion failure | N |
| Verify | Live checks cost money and need the user's key | Manual tasks only, run by or with the user | Y (T-VERIFY-MANUAL) |

## Prior Lessons Applied

| Lesson | Applied How |
|--------|-------------|
| The SDK waits out `retry-after` inside the attempt (Anthropic R12) | `maxRetries: 0` from day one; `groq-sdk` has the same uncancellable wait (R4) |
| A non-streaming call is cut by a headers-only timeout (Anthropic R13) | Every call streams from day one (D12) |
| A 429 joins round 2 only on its unclamped hint (Anthropic R13) | `retryAfterHeaderMs` from day one |
| Enqueue after cancel throws `ERR_INVALID_STATE` (`gemini.js:669-675`) | `safeEnqueue` (FR-018) |
| The server keeps the connection open after the last chunk (`fix/gemini-stream-end-and-retry`) | Stop at `finish_reason` (FR-017); worse here, since the SDK itself reads past `[DONE]` |
| A request can be accepted and then stall (`feat/gemini-hedged-requests`) | First-text timeout + deadline + idle timeout (FR-015, FR-016) |
| Unknown errors should not stop failover | Fail-open `transient` (data-model) |
| A retired preset made the whole provider unusable (Anthropic R1) | Presets are only models active on a live key today; validation names no model; `unavailable` tells the user what to do |
| A `call` node ID breaks current Mermaid (Anthropic T025) | The new diagram 16 avoids it |

## Phase 1: Design & Contracts

1. **[data-model.md](./data-model.md)** covers:
   - the model list and model traits;
   - the health entry and cooldowns;
   - error kinds and request params;
   - content mapping and attempt order;
   - SDK options, rounds and attempt stats;
   - the stream protocol and state transitions.
2. **[contracts/groq-provider.contracts.d.ts](./contracts/groq-provider.contracts.d.ts)** gives the module surfaces of `groqErrors`, `groq` and the factory additions. Type-checked: PASS.
3. **[contracts/EDGE_CASES.md](./contracts/EDGE_CASES.md)** lists 61 edge cases mapped to FRs.
4. **[quickstart.md](./quickstart.md)** covers limits, the model list, env, automated checks, the live probe and 12 manual checks mapped to FRs and SCs.

## Phase 2: Task Planning Approach

Strategy, as in the Anthropic spec:
1. The SDK comes first and alone, so everything after it is written against the version that ships.
2. An optional live probe (T006) settles the chunk-shape questions while only a script exists.
3. Then tests before implementation for each module: the pure pieces (classifier, request builder), then the loops, then wiring and UI, then docs and the live checks.

T010–T011 are not used: there is no shared-registry move this time.

| Group | Tasks | Gate |
|-------|-------|------|
| SDK | T005 | none (stop the plan and report if the Electron load test fails) |
| Live probe | T006 | T005 + user approval (one request on the user's key) |
| Pure core | T012–T015 | T005 |
| Key validation | T016–T017 | T015 |
| Stream loop | T018–T019 | T013, T015 (and T006's findings when it ran) |
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

**Gates**: Constitution Check PASS · No NEEDS CLARIFICATION (two items deferred with defaults) · Contracts tsc PASS · Bugfix gate N/A

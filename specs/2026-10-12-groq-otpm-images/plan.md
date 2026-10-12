---
# Context Optimization Metadata
# Purpose: Enable efficient partial reads (~200 tokens vs ~2500 for full file)
meta:
  spec_id: 2026-10-12-groq-otpm-images
  spec_name: groq-otpm-images
  phase: verify
  updated: 2026-10-12

# Quick Reference (for checkpoint resume)
summary:
  tech_stack: [JavaScript (CommonJS, main process), groq-sdk ^1.6.0, Electron 30 / Node 20.16, node:test]
  external_deps: []   # no new dependency
  test_strategy: {unit: 80, integration: 10, contract: 0, e2e_manual: 10}
  deployment: immediate  # ships with the next Glass desktop build
---

# Implementation Plan: Groq Output Limit and Screenshots

**Branch**: `2026-10-12-groq-otpm-images` | **Date**: 2026-10-12 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/2026-10-12-groq-otpm-images/spec.md`

## Execution Flow (/plan command scope)

```
1. Load spec → Fill Technical Context → Constitution Check          ✓
2. Phase 0.1: Research + Testing Strategy (MANDATORY)               ✓ (bug evidence + live probes)
3. Phase 0.2: Permissions (single local user → trivial)            ✓ (N/A documented)
4. Phase 0.3: Integration Analysis (MANDATORY)                      ✓
5. Phase 0.4: Design Pre-flight (no UI → skip)                      ⏭ skipped
6. Phase 0.5: Infrastructure (no env var, no migration)             ✓
7. Phase 0.6: Error/Rescue Mapping                                  ✓
8. Phase 0.7: Implementation Timeline Risks (MANDATORY)             ✓
9. Phase 1: Design & Contracts → data-model.md, contracts/, quickstart.md  ✓
10. Plan Phase 2 approach                                           ✓
```

> SpecKit is not installed on this machine, so this set was written by hand in the format of `2026-10-12-live-features-toggle` and its predecessors. `preflight-report.md` is not generated.
>
> **Order of work.** The fix was planned in Claude Code's plan mode, approved by the user, implemented and tested first. This folder was written afterwards, at the user's request, to put the feature on record in the project's format. `tasks.json` records the tasks as they were done, including where a test came after its implementation.

## Summary

On the user's key, Groq refuses Qwen, its only model that sees images, whenever a request may produce more than 1,000 output tokens. Ask asked for 2,048, so every Ask with a screenshot fell to gpt-oss without the image, and Gemini, next in the list, was never tried. The same 2,048 default also cut long code and system design answers on gpt-oss.

**Technical approach:**
- **A cap that fits Ask.** Groq's default for a caller without a cap (only Ask) goes to 16,384. The declared value is not metered on gpt-oss.
- **The refusal read for what it is.** A 429 "Request too large" is `too-large`: no cooldown, no second round. The numbers go into the log, and the message names output tokens.
- **No blind answer when someone can see.** The chain passes `visionOnly` to a segment when a later segment with a key sees images. Groq then tries only its vision models, and fails rather than drop the image, so the next provider answers with it.
- **Nothing shrinks.** No retry with a smaller cap (C2).

## Technical Context

**Language/Version**: JavaScript (CommonJS); Electron 30 (Node 20.16). The suite runs on the machine's Node (24).
**Primary Dependencies**: none new (`groq-sdk` ^1.6.0, existing).
**Storage**: none.
**Testing**: `node --test` via `npm test`:
- `groqErrors.test.js` and `groqRequest.test.js`: pure;
- `groq.test.js`: a scripted fake SDK that re-exports the real error classes;
- `providerChain.test.js`: fake providers;
- `providerChain.integration.test.js`: the real providers with fake SDKs.

Live probes run by hand on the user's key (research R3, R7).
**Target Platform**: Electron desktop (Windows primary; macOS must not break).
**Performance Goals**:
- A screenshot Ask on a key with the output limit costs one refused Groq request (0.2–0.6 s) before the next provider starts.
- No change for requests without an image.

**Constraints**: spec C1–C5.
**Scale/Scope**: `groqErrors.js` (+23 / −5), `groq.js` (+34 / −9), `providerChain.js` (+23 / −11), 5 test files (+155 / −9), docs.

**System Context**: Framework-internal (spec System Context).
**Architecture Docs Read**:
- `ARCHITECTURE.md` §10.3 (Groq), §10.4 (lists across providers);
- `docs/LIVE_INSIGHTS_AND_ASK.md` (the Groq and chain paragraphs);
- `specs/2026-10-12-groq-provider/` (spec, research R5, R17, R19);
- `specs/2026-10-12-cross-provider-failover/` (spec, data-model);
- `docs/future-work.md` item 6.

## Constitution Check
*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Assessment | Status |
|-----------|------------|--------|
| I. Test-First Development | The tests were written right after each implementation step, not before (see the note above and `tasks.json`). Two checks make up for it: the new tests fail on `main` (16 failures, research R8), and the bug was reproduced live before the change (R3) and checked live after it (R7) | PASS with a recorded exception |
| II. Specification-Driven Development | Item 6 → live verification → plan approved by the user → implementation → this spec set | PASS |
| III. Verification Before Completion | Automated: SC-001, SC-002. Live: SC-003. Manual: SC-004 (pending) | PASS (SC-004 pending) |
| IV. Skills Before Action | Groq's docs were read first (R2). What they leave open was measured on the user's key (R3) | PASS |
| V. Code Review Compliance | No change to the lanes; the provider's loop is unchanged apart from one filter; no text in logs (C3) | PASS |

### AI & Machine Learning *(applicable)*

**Does this feature involve AI/ML?** [x] **Yes**: it decides which model gets an Ask with a screenshot, and how much it may write.

| Aspect | Approach |
|--------|----------|
| Model choice | Unchanged list and order; a text-only Groq model is skipped for a screenshot only when a later provider sees images |
| Failure posture | A refused vision model leads to the next provider, never to a blind answer while one can see |
| Rate limits | The refusal is not a rate limit: no cooldown. The declared cap does not count against TPM (R3) |
| Cost control | One refused request per screenshot Ask on a key with the limit; it spends no tokens |
| Data | The screenshot goes only to providers the user listed |

## Project Structure

### Documentation (this feature)
```
specs/2026-10-12-groq-otpm-images/
├── spec.md
├── research.md
├── plan.md                 # this file
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── groq-otpm-images.contracts.d.ts
│   ├── EDGE_CASES.md
│   └── tsconfig.json
├── tasks.json
├── acceptance-tests.yaml
└── documentation-update-report.md
```

### Source Code (repository root)
```
src/features/common/ai/
├── providerChain.js                                  EDIT  withImages from planRequest; visionOnly in decideTurn; laterSeesImages
├── __tests__/providerChain.test.js                   EDIT  visionOnly per segment, stream and once (additions only)
├── __tests__/providerChain.integration.test.js       EDIT  the user's list, OTPM refusal → Gemini with the image (addition)
└── providers/
    ├── groq.js                                       EDIT  DEFAULT_MAX_TOKENS 16,384; visionOnly; OTPM message; limit/requested logged
    ├── groqErrors.js                                 EDIT  429 "Request too large" → too-large; tooLargeNumbers().output
    └── __tests__/
        ├── groq.test.js                              EDIT  OTPM failover, visionOnly, the default in one assertion
        ├── groqErrors.test.js                        EDIT  OTPM cases; tooLargeNumbers shape
        └── groqRequest.test.js                       EDIT  the default cap
ARCHITECTURE.md, README.md, CHANGELOG.md, docs/LIVE_INSIGHTS_AND_ASK.md,
docs/diagrams/16-groq-failover.mmd, docs/diagrams/17-cross-provider-chain.mmd,
docs/diagrams/README.md, docs/future-work.md,
specs/2026-10-12-groq-provider/research.md            EDIT  (T-DOC-GATE)
```

**Structure Decision**: The decision ("a later provider sees this image") is made where the plan of the request is: `providerChain.decideTurn`. It is applied where the models are known: `groq.runWithFailover`. Neither file takes on the other's job (research R6).

## Phase 0.1: Research & Testing Strategy

### Production Log & Error Evidence
**Bugfix: evidence captured.**
- The app log line with `req_01m4re6ap2esf9e0enz933ewmw` (research R1).
- The live probes reproduced the refusal (R3).
- The 2048 cut follows from a measured 4,204-token answer against a 3,072 cap (R3, R4).

### Research

Consolidated in [research.md](./research.md):

| # | Question | Decision |
|---|----------|----------|
| R1 | What happened? | Qwen refused on OTPM, read as transient; gpt-oss answered the screenshot blind; Gemini never tried |
| R2 | What does Groq document? | That OTPM exists; not how it is enforced |
| R3 | How is it enforced? | Qwen: expected output over 1,000 refused before running. gpt-oss: not held to it. Declared cap: not in TPM |
| R4 | How long are Ask answers? | System design 4,204, code 864 on an easy problem; the 3,072 cap cut the first |
| R5 | Which fix? | Raise the default, read the 429 as too-large, `visionOnly`; no smaller-cap retry |
| R6 | Where does `visionOnly` live? | Decided in the chain, applied in Groq, ignored elsewhere |
| R7 | Does it work live? | Yes for Groq; the Gemini step is covered by the integration test and the app check |
| R8 | Do the tests catch the bug? | 16 failures on `main` |

### Testing Strategy

| Check | Output |
|-------|--------|
| External APIs | None in the suite. Live probes by hand: about ten Groq requests, most refused before running |
| Test types | Unit (classification, request, failover with a fake SDK, chain with fake providers), integration (chain over the real providers with fake SDKs), live probe, manual app check |
| Mocking strategy | `groq.test.js`'s fake SDK (`Module._load` interceptor, real error classes, scripted streams); `providerChain.test.js`'s `fakeProvider` (records `opts`); `providerChain.integration.test.js`'s fake Groq, Gemini and Anthropic SDKs |

**Testing Summary**:
```
Feature type: Backend logic, no UI
Quota risks: none in tests; the probes spent a few hundred tokens
Estimated tests: 15 new cases, 6 changed assertions
Distribution: Unit ~80%, Integration ~10%, Manual ~10%
```

**GATE**: No quota-limited API is called by the suite. PASS.

## Phase 0.2: Permissions Design

Single local user; no roles. N/A.

## Phase 0.3: Integration Analysis

### Codebase Pattern Discovery

| Pattern Area | Finding | Use |
|--------------|---------|-----|
| Error kinds | `classify` (`groqErrors.js:68`): provider code → `model_` code → status → body type | One more status rule, before the 429 → transient rule |
| Too-large handling | `cooldownFor` (`groq.js:406`) returns null for too-large; `joinsNextRound` keeps it out of round 2; `describeFailure` (`:413`) reads `tooLargeNumbers` | Reused as is; one more message branch |
| Image routing | `orderForImages`, `modelTraits().vision`, `hasImages` (`groq.js`) | The `visionOnly` filter uses the same traits |
| Per-request options | `decideTurn` builds `options` from the caller's opts, the key, the models and `requestDeadlineMs` (`providerChain.js:237`) | `visionOnly` added the same way |
| Adapter capability | `DEFAULT_ADAPTERS[*].seesImages` (`providerChain.js`), already used by `orderSegments` | `laterSeesImages` reuses it |
| Provider-thrown codes | `providerError(code, message)` in `groq.js` (`FIRST_TEXT_TIMEOUT`, `STREAM_ERROR`, …) | `NO_VISION_MODEL` |
| Attempt log | `logAttempt` (`groq.js:342`) | `limit=` / `requested=` fields |

### Code Interconnectedness Gate

| Pattern Needed | Evidence | Decision |
|----------------|----------|----------|
| Error classification | `groqErrors.classify` | EXTEND (one rule) |
| Request cap | `completionBudget` | REUSE; change the constant |
| Image routing | `orderForImages`, `modelTraits` | REUSE; filter on top |
| Chain plan | `planRequest`, `decideTurn` | EXTEND (one return field, one option) |
| Consumers (`askService`, `summaryService`) | the SSE protocol | UNCHANGED (C1) |

### Contract Validation

`contracts/groq-otpm-images.contracts.d.ts` was type-checked with `npx -p typescript@5.4.5 tsc -p specs/2026-10-12-groq-otpm-images/contracts/tsconfig.json`: **PASS** (2026-10-12).

## Phase 0.4: Design Pre-flight

**Skipped**: no UI change.

## Phase 0.5: Infrastructure & Migrations

| Item | Detail |
|------|--------|
| Env vars | None new. `GROQ_MAX_TOKENS` still overrides the default (now 16,384) |
| Dependency | None |
| DB migrations | None |
| Rollout | Ships with the next build |
| Rollback | Revert the branch; or set `GROQ_MAX_TOKENS=2048` in `.env` for the old cap alone (quickstart §5) |

## Phase 0.6: Error/Rescue Mapping

See spec § Error Handling and `data-model.md`. The rules:
- **A refusal before running is not a rate limit.** No cooldown, no second round. The next model of the list tries.
- **No blind answer while someone can see.** With `visionOnly`, the segment fails instead, and the chain's `_reset reason: 'provider'` announces the next provider.
- **Without a provider that can see, today's fallback stays.** A blind answer beats none.

## Phase 0.7: Implementation Timeline Risks

| Phase | Anticipated Blocker | Resolution | Add to Task Context? |
|-------|--------------------|------------|---------------------|
| Core | A 429 "Rate limit reached … Limit 8000, Used 5454, Requested 4212" also has "Limit" and "Requested" | Match "Request too large" for the kind, and "Limit L, Requested R" (adjacent) for the numbers; a test pins that a rate limit stays transient and yields no numbers | Y (T010) |
| Core | Raising the default could make the TPM check refuse requests | The probes show the declared cap is not counted ("Requested 4212" for 12,000 declared; groq-provider R5: 60,000 → 200) | Y (T012) |
| Core | `visionOnly` must not leak into the SDK request | It is read in `runWithFailover` only; `buildRequest` never sees it | Y (T013) |
| Chain | A later provider without a key must not trigger `visionOnly` (the image would then be dropped for nothing) | `laterSeesImages` requires a key; a test pins it | Y (T014) |
| Chain | Gemini or Anthropic could pass an unknown option on | Gemini's `...config` is unused; Anthropic destructures only what it knows; the integration test runs the real `gemini.js` with the option present on the Groq segment only | Y (T015) |
| Verify | The live check needs the Gemini key, which is encrypted in the app | Not decrypted outside the app; the integration test and the app check cover it | Y (T-VERIFY-MANUAL) |
| Verify | A timing test in `groq.test.js` (`elapsed < 140ms`) failed once under the full suite | Unrelated to this change (no image, no option); passed in every rerun | N |
| Verify | `npm run lint` cannot run (eslint not installed) | `node --check` on the changed files | Y (T-FINAL) |

## Prior Lessons Applied

| Lesson | Applied How |
|--------|-------------|
| `591f971`: Ask answers must not truncate mid-output | The Groq default rises to 16,384 (D1); no smaller-cap retry (D4) |
| groq-provider R5: the declared cap is not metered | Re-measured before relying on it (R3) |
| A fake too lenient passes while production differs | The integration test runs the real `groq.js` and `gemini.js`; the live probe runs the real `groq.js` |
| A log cut at 160 characters hid the numbers | `limit=` / `requested=` as fields (D6) |
| Existing tests must stay | Only the assertions that pin the old default or the old shape changed (C5); the chain tests only gained lines |

## Phase 1: Design & Contracts

1. **[data-model.md](./data-model.md)**: the cap, the error kind, the `tooLargeNumbers` result, `visionOnly`, the log fields, and the routing table.
2. **[contracts/groq-otpm-images.contracts.d.ts](./contracts/groq-otpm-images.contracts.d.ts)**: the changed surfaces of `groqErrors.js`, `groq.js` and `providerChain.js`. Type-checked: PASS.
3. **[contracts/EDGE_CASES.md](./contracts/EDGE_CASES.md)**: 27 edge cases mapped to FRs.
4. **[quickstart.md](./quickstart.md)**: what changed, automated checks, the live probe and the app checks.

## Phase 2: Task Planning Approach

As done:
1. The classification.
2. The provider: cap, message, log, `visionOnly`.
3. The chain.
4. The live probe.
5. Docs.
6. The regression check on `main`, when this folder was written.
7. Then the app check.

| Group | Tasks | Gate |
|-------|-------|------|
| Classification | T010–T011 | none |
| Provider | T012–T013 | T011 |
| Chain | T014–T015 | T013 |
| Live probe | T016 | T015 |
| Regression check | T017 | T015 |
| Docs | T018, T-DOC-GATE | T016 |
| Verify | T-VERIFY-MANUAL, T-FINAL | T-DOC-GATE |

## Progress Tracking

| Phase | Status | Skip If |
|-------|--------|---------|
| 0.1 Research + Testing | [x] Complete | Never |
| 0.2 Permissions | [x] Complete (N/A) | No roles |
| 0.3 Integration | [x] Complete | Never |
| 0.4 Design Pre-flight | [x] Skipped (no UI) | No UI |
| 0.5 Infrastructure | [x] Complete | - |
| 0.6 Error/Rescue Mapping | [x] Complete | - |
| 0.7 Timeline Risks | [x] Complete | Never |
| 1 Design & Contracts | [x] Complete | - |
| 2 Task Planning | [x] tasks.json written (as done) | - |

**Gates**: Constitution Check PASS (test-first exception recorded) · No NEEDS CLARIFICATION · Contracts tsc PASS · Bugfix gate: evidence captured (R1, R3)

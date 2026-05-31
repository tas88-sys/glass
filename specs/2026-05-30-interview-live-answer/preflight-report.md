# Preflight Report: Spec 2026-05-30-interview-live-answer

**Generated**: 2026-05-31
**Status**: WARN
**Artifacts checked**: spec.md, plan.md, tasks.json, acceptance-tests.yaml, data-model.md, contracts/live-answer.contracts.d.ts, contracts/EDGE_CASES.md, quickstart.md

## Summary

| Category | Critical | Warning | Info | Status |
|----------|----------|---------|------|--------|
| Schema Drift | 0 | 0 | 1 | PASS |
| Interface Assumptions | 0 | 0 | 2 | PASS |
| Dependency Chain | 0 | 1 | 0 | WARN |
| Enum/Value Mismatches | 0 | 0 | 1 | PASS |
| Operator Readability | 0 | 2 | 0 | WARN |
| Invariant Claims | 0 | 0 | 2 | PASS |
| **Total** | **0** | **3** | **6** | **WARN** |

## Findings

### Critical (0)

No critical findings. All interface references, enum values, dependency-chain claims, schema references, and invariant claims verified against live code.

---

### Warnings (3)

#### [dependency_chain] SC-007 body-extraction regex fragile against nested braces in resetConversationHistory

- **Artifact**: acceptance-tests.yaml -> structural_checks.SC-007.command
- **Expected**: After implementation adds resetLiveAnswer() and guard blocks, inner braces at 4-space indentation will short-circuit the regex, producing false results.
- **Found**: The SC-007 regex assumes the first 4-space-indented closing brace terminates the method body. Live resetConversationHistory (lines 52-57) has no nested braces today but implementation will add them.
- **Fix**: Replace with: grep -A 15 resetConversationHistory src/features/listen/summary/summaryService.js | grep -q resetLiveAnswer && echo RESET_FOLDED. The invariant is correct; this is a verification-script robustness issue only.

#### [readability] MST-SAFETY-001 gives no concrete mechanism for observing the shared-screen exclusion

- **Artifact**: acceptance-tests.yaml -> manual_smoke_tests.MST-SAFETY-001
- **Expected**: A specific observation method so the operator can confirm the content-protected listen window is excluded from a screen share.
- **Found**: Expected field says the answer must not appear on the shared screen but gives no tooling guidance for simultaneously observing the shared screen.
- **Fix**: Add to expected: Verify using a second device or a Zoom/Meet in-meeting preview on a second monitor. Alternatively use OBS Studio to preview the screen-capture feed -- content-protected windows appear as opaque black rectangles.

#### [readability] TG-003 FR-012 late-timer-race assertion leaves green/red boundary under-specified

- **Artifact**: acceptance-tests.yaml -> test_gates.TG-003.assertions (late-timer-race entry)
- **Expected**: The assertion must name both the absence of a sendToRenderer call AND clean function resolution.
- **Found**: Current text: debounce callback with empty conversationHistory -> bail, no emit. A test catching a thrown error before sendToRenderer also satisfies no emit, masking the bug.
- **Fix**: Expand to three sub-criteria: (a) sendToRenderer spy count zero, (b) callback resolves without throwing, (c) this.inFlight is false after callback returns.

---

### Informational (6)

#### [schema_drift] In-memory-only confirmed -- no database schema introduced (C8)

- **Artifact**: spec.md Databases: N/A; data-model.md
- **Expected**: No SQLite migration. summaryRepository.saveSummary not extended for live answers.
- **Found**: Confirmed. saveSummary is inside makeOutlineAndRequests only (summaryService.js:154-165). No validation.sql created.
- **Fix**: No action.

#### [interface_assumption] getSystemPrompt false third arg confirmed no-op for pickle_glass_analysis (searchUsage empty at promptTemplates.js:395)

- **Artifact**: spec.md FR-006 note
- **Expected**: searchUsage for pickle_glass_analysis is an empty string, so omitting it produces identical output regardless of the googleSearchEnabled flag.
- **Found**: Spec note accurate. Existing summary lane call at summaryService.js:93 uses identical invocation.
- **Fix**: No action.

#### [interface_assumption] SummaryView line citations accurate; plan error-registry has cosmetic 2-line offset for DOMPurify fallback

- **Artifact**: plan.md Phase 0.6 error registry
- **Expected**: DOMPurify.removed guard at SummaryView.js:390; textContent at :392; innerHTML at :397.
- **Found**: All verified. The plan cites :390-393 which correctly covers the guard block. No implementation impact.
- **Fix**: No action.

#### [enum_mismatch] Speaker labels confirmed exact; live-answer-update channel absent from src/ (correctly NEW); summary-update intact

- **Artifact**: spec.md FR-001, FR-013
- **Expected**: sttService.js:82 emits literal Me (mic); :109 emits Them (system audio). summaryService.js:39 stores lowercase. live-answer-update must not already exist.
- **Found**: All confirmed. Grep of src/ for live-answer-update returns zero matches (correctly new). summary-update at preload.js:210-212 and summaryService.js:312 only. No collision.
- **Fix**: No action.

#### [invariant_violation] FR-017 CLOSED set pre-verified intact (implementation not yet started)

- **Artifact**: spec.md FR-017; acceptance-tests.yaml NA-002
- **Expected**: SummaryView.js, promptTemplates.js, askService.js, featureBridge.js, listenService.js absent from implementation diff.
- **Found**: Git status shows only two spec-directory files staged. No source files modified.
- **Fix**: No action. NA-002 must be re-verified after implementation completes.

#### [invariant_violation] D4 verified: listenService.js:146 and :247 call resetConversationHistory; Stop does not destroy window (FR-012 guard load-bearing)

- **Artifact**: spec.md D4; FR-012
- **Expected**: listenService.js:146 calls resetConversationHistory in initializeNewSession; :247 in closeSession. Stop path does not destroy the listen window.
- **Found**: Both confirmed at exact cited lines. Stop at :72-78 calls closeSession (hides, does not destroy). isDestroyed() alone cannot guard a late timer. FR-012 bail on empty history is load-bearing.
- **Fix**: No action. D4 and FR-012 verified.

---

## Key Verification Citations

| Claim | File | Lines | Status |
|-------|------|-------|--------|
| createStreamingLLM(provider, opts) two-arg signature | src/features/common/ai/factory.js | 128-139 | VERIFIED |
| createStreamingLLM exported | src/features/common/ai/factory.js | 183 | VERIFIED |
| summaryService.js imports createLLM ONLY (createStreamingLLM MUST be added) | src/features/listen/summary/summaryService.js | 3 | VERIFIED -- ADD IMPORT |
| addConversationTurn sole hook triggerAnalysisIfNeeded at :45 | src/features/listen/summary/summaryService.js | 38-46 | VERIFIED |
| resetConversationHistory at :52 | src/features/listen/summary/summaryService.js | 52-57 | VERIFIED |
| formatConversationForPrompt at :65 | src/features/listen/summary/summaryService.js | 65-68 | VERIFIED |
| sendToRenderer listen window isDestroyed guard at :29 | src/features/listen/summary/summaryService.js | 29-36 | VERIFIED |
| getSystemPrompt(pickle_glass_analysis,empty,false).replace at :93 | src/features/listen/summary/summaryService.js | 93-94 | VERIFIED |
| pickle_glass_analysis profile key | src/features/common/prompts/promptTemplates.js | 238 | VERIFIED |
| Native passive phrase at :388 | src/features/common/prompts/promptTemplates.js | 388 | VERIFIED |
| _processStream SSE sentinels [DONE]/_reset/_final_model/delta.content | src/features/ask/askService.js | 401-474 | VERIFIED |
| AbortController + signal.aborted swallow | src/features/ask/askService.js | 233-236, 452-454 | VERIFIED |
| Two-arg createStreamingLLM call in askService | src/features/ask/askService.js | 308-314 | VERIFIED |
| getCurrentModelInfo(llm) returns {provider, model, apiKey} | src/features/common/services/modelStateService.js | 377-389 | VERIFIED |
| Speaker Me (mic :82) Them (system audio :109) | src/features/listen/stt/sttService.js | 82, 109 | VERIFIED |
| COMPLETION_DEBOUNCE_MS = 2000 | src/features/listen/stt/sttService.js | 6 | VERIFIED |
| summaryView namespace preload.js:205; summary-update at :210-212 | src/preload.js | 204-213 | VERIFIED |
| summary-view at ListenView.js:681; reset block at :467-469 | src/ui/listen/ListenView.js | 465-469, 681-684 | VERIFIED |
| SummaryView loadLibraries if(!window.marked) guard at :293 | src/ui/listen/summary/SummaryView.js | 293 | VERIFIED |
| SummaryView renderMarkdownContent DOMPurify + innerHTML at :375-397 | src/ui/listen/summary/SummaryView.js | 375-397 | VERIFIED |
| Plain-text fallback when libs absent at :359-360 | src/ui/listen/summary/SummaryView.js | 359-360 | VERIFIED |
| listen.setContentProtection at :507 | src/window/windowManager.js | 507 | VERIFIED |
| contentProtection: true default at settingsService.js:217 | src/features/settings/settingsService.js | 217 | VERIFIED |
| npm test = node --test src/**/__tests__/**/*.test.js | package.json | 15 | VERIFIED |
| processSseLines standalone pattern | src/features/ask/__tests__/askService-sse.test.js | 31-65 | VERIFIED |
| listenService.js:146 resetConversationHistory session start | src/features/listen/listenService.js | 146 | VERIFIED |
| listenService.js:247 resetConversationHistory session close | src/features/listen/listenService.js | 247 | VERIFIED |
| summary-update emitted via sendToRenderer | src/features/listen/summary/summaryService.js | 312 | VERIFIED |
| live-answer-update: 0 occurrences in src/ (correctly NEW) | src/ (grep) | n/a | VERIFIED |

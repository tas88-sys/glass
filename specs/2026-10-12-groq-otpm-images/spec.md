---
# Context Optimization Metadata
# Purpose: Enable efficient partial reads (~200 tokens vs ~2500 for full file)
meta:
  spec_id: 2026-10-12-groq-otpm-images
  spec_name: groq-otpm-images
  status: in-progress    # draft | in-progress | approved | completed
  phase: verify          # specify | clarify | plan | tasks | preflight | feature-start | implement | verify
  created: 2026-10-12
  updated: 2026-10-12

# Quick Reference (for checkpoint resume)
summary:
  goals:
    - {id: G1, description: "An Ask screenshot reaches a model that sees it. When Qwen (Groq's only vision model) is refused and a later provider in the list sees images, that provider answers with the image; no Groq text-only model answers it blind", priority: HIGH}
    - {id: G2, description: "An Ask answer on Groq is not cut by Glass's own cap. A code or system design answer (4,204 output tokens measured) ends with finish_reason stop", priority: HIGH}
    - {id: G3, description: "Qwen's output-token refusal (429 'Request too large … (OTPM)') is read as too-large: no cooldown, no second round, the numbers in the log, and a message that names output tokens", priority: MEDIUM}
    - {id: G4, description: "Everything else behaves as today: Live Answer, Live Insights, requests without an image, and lists with no later provider that sees images", priority: HIGH}
  constraints:
    - {id: C1, description: "askService.js, askStreamState.js, summaryService.js, factory.js, gemini.js, anthropic.js and modelHealth.js are not edited. The SSE protocol the consumers read (_reset, _final_model, [DONE], err.userMessage) is unchanged", type: SCOPE}
    - {id: C2, description: "An answer is never shrunk to fit a limit. No retry with a smaller cap (user, 2026-10-12: code and system design answers can be long and must not be cut in the middle)", type: SCOPE}
    - {id: C3, description: "Never log prompt, answer or reasoning text (existing invariant). The new log fields are numbers and model IDs", type: SECURITY}
    - {id: C4, description: "Tests run under npm test with fake SDKs; the suite makes no live call. Live probes are run by hand and spend a few hundred tokens at most", type: TECHNICAL}
    - {id: C5, description: "Existing tests change only where they pin the old default cap (2048 / 3072) or the old shape of tooLargeNumbers; every other change to them is an addition", type: TECHNICAL}
  decisions:
    - {id: D1, decision: "groq.js DEFAULT_MAX_TOKENS goes from 2048 to 16,384. Only Ask calls Groq without a cap (Live Answer passes 900, Live Insights 1024). GROQ_MAX_TOKENS still overrides it", rationale: "A real system design answer is 4,204 output tokens and a code answer to an easy problem 864 (research R3). 2048 + 1024 for gpt-oss's reasoning cut the first one. The declared value is not metered on gpt-oss (R3; groq-provider R5). 16,384 is Qwen's maximum and the order of Anthropic's 16,000"}
    - {id: D2, decision: "groqErrors.classify reads a 429 whose message says 'Request too large' as too-large, like the 413 on TPM. tooLargeNumbers also returns output: true when the message says (OTPM)", rationale: "Groq refuses before running a request whose expected output (from max_completion_tokens) is over the model's output tokens per minute. Waiting does not help, and a request with a smaller cap (Live Answer's 900) still fits, so a 60 s cooldown was wrong (R2)"}
    - {id: D3, decision: "providerChain.decideTurn passes visionOnly: true to a segment when the request has an image and a later segment with a key sees images. groq.js then keeps only its models that see images; when they fail, or the list has none (NO_VISION_MODEL, no request sent), the segment fails and the chain moves on with the image", rationale: "The chain knows what comes later; the provider knows which of its models see images. A blind answer has no value when another provider can see the screenshot, and in code mode the screenshot is the problem statement (R4, R5)"}
    - {id: D4, decision: "No retry of Qwen with the limit as the cap (the first idea in future-work item 6)", rationale: "It cuts code and system design answers at 1,000 tokens (C2, R5)"}
    - {id: D5, decision: "A list with no later provider that sees images keeps today's fallback: a Groq text-only model answers without the image (images=dropped:N)", rationale: "An answer without the image beats no answer when nothing in the list can see it. A notice in the Ask window is deferred (future-work item 6)"}
    - {id: D6, decision: "The attempt log line adds limit=L requested=R for a too-large refusal. The user message for an OTPM refusal is 'MODEL — asks for up to R output tokens; this key allows L per minute.'", rationale: "error= is cut at 160 characters and Groq's numbers come later in the message. The TPM message's advice ('shorten the context') does not apply to an output limit"}
    - {id: D7, decision: "No per-model memory of the refusal: every screenshot Ask tries Qwen again (one refused request, 0.2–0.6 s)", rationale: "The refusal is cheap and needs no state. If the key's limit is raised (a paid tier), Qwen answers again with no change"}

# CRITICAL REQUIREMENTS - Must verify during implementation
# These survive context compaction and generate T-VERIFY tasks
critical_requirements:
  type: bugfix    # bugfix | feature-minor | feature-major | config | documentation | refactoring
  portal: app            # superadmin | admin | app | public | none
  ui_changes: none      # none | minor | moderate | major
---

# Feature Specification: Groq Output Limit and Screenshots

**Feature Branch**: `2026-10-12-groq-otpm-images`
**Created**: 2026-10-12
**Status**: Implemented; manual check pending (T-VERIFY-MANUAL)
**Input**: User request (2026-10-12): "Let's make a /plan to check whether item 6 really makes sense. If it does, let's fix it with your suggested fixes. Remember that for Ask Code and Ask System Design the answers can be long, and it makes no sense to cut them in the middle, agree?" Then: "If it really is the best solution, go ahead." Then: "Although it is ready, I want you to prepare it and put it in the project's pattern. Create a folder inside specs, at least with the files, just so this feature is recorded." (translated from Portuguese)

---

## System Context

**Systems**: Framework-internal. The Groq provider (`groq.js`, `groqErrors.js`) and the cross-provider chain (`providerChain.js`), both in the Electron main process. Ask is the lane that changes behavior; it is not edited.
**Databases**: None.
**Integrations**: Groq's chat completions API (existing). Gemini and Anthropic are reached only through the chain, as today.
**Key Architecture**:
- Ask builds one request with the mode's system prompt, the question and a screenshot, and calls `createStreamingLLM` with no `maxTokens` (`askService.js:315`).
- The user's list is `openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b,gemini-3.5-flash-lite,gemini-3.1-flash-lite`. The factory cuts it into a Groq segment and a Gemini segment, and `providerChain.js` runs them in turn (`ARCHITECTURE.md` §10.4).
- With an image, the chain puts the segments that see images first, and Groq puts Qwen first inside its segment (`orderForImages`). Groq's text-only models get the request without the image.
- Groq answers stream, and `max_completion_tokens` is the caller's cap, else `GROQ_MAX_TOKENS`, else 2048, plus 1024 on models that reason (`completionBudget`).

On 2026-10-12 Groq began refusing Qwen on this key with a 429 on output tokens per minute. Every Ask with a screenshot was then answered by gpt-oss without the image, and Gemini was never tried (research R1).

---

## Clarifications

### Session 2026-10-12

- Q: Does item 6 make sense? → A: Partly. The refusal is real and current (live probes, R3). Its "To watch" was wrong: gpt-oss is not held to the 1K output limit. And it missed a larger problem: the 2048 default already cut long Ask answers on gpt-oss.
- Q (user): Code and system design answers can be long; cutting them makes no sense, agree? → A: Yes. That rules out the item's proposed fix, a retry of Qwen with a 1,000-token cap (D4, C2).
- Q: Then where should the screenshot go? → A: To the next provider that sees images (Gemini in the user's list), with no cap below the answer's size (D1, D3).
- Q: And a list with Groq only? → A: Today's fallback stays: gpt-oss answers without the image (D5). A notice is deferred.
- Q: A spec folder for a change that is already done? → A: Yes, at the user's request, in the format of the earlier specs, so the decisions and the evidence are on record. `tasks.json` records what was done and what is left.

**Deferred (default chosen, not blocking)**:
- A notice in the Ask window when the screenshot did not reach a model (Groq-only lists). Default: none, as today. Recorded in `docs/future-work.md` item 6.
- Remembering a model's output limit to skip it for larger requests. Default: no memory (D7).

---

## User Scenarios & Testing *(mandatory)*

### Primary User Story
In a coding interview the user presses Ask in Code mode with the problem on screen. The list starts with three Groq models, then two Gemini models. Groq refuses Qwen in about 0.2 s, because the key allows Qwen 1,000 output tokens a minute and Ask asks for 16,384. The Ask window shows "Trying gemini-3.5-flash-lite…", and Gemini answers from the screenshot with all five sections: clarifying questions, reasoning, solution, time complexity and space complexity. Before this change, gpt-oss answered without the screenshot, from the typed text alone.

### Acceptance Scenarios
1. **Given** the user's list and an Ask with a screenshot, **When** Qwen is refused on output tokens, **Then** gpt-oss is not called, Gemini receives the image and answers, and Qwen is not cooled down.
2. **Given** the same list and Qwen accepting the request (a key without the output limit), **When** Ask runs, **Then** Qwen answers with the image, as before.
3. **Given** an Ask without a screenshot in System Design mode on gpt-oss, **When** the answer is 4,204 tokens, **Then** it streams to the end (`stop=stop`), not cut at 3,072.
4. **Given** a Groq-only list and an Ask with a screenshot, **When** Qwen is refused, **Then** gpt-oss answers without the image (`images=dropped:1`), as today.
5. **Given** a Groq list with no vision model followed by Gemini, **When** Ask has a screenshot, **Then** Gemini runs first (images-first order, as before) and answers with the image; Groq is not called. A direct caller of `groq.js` that passes `visionOnly` with no vision model gets `NO_VISION_MODEL` and no request.
6. **Given** Live Answer (cap 900) on the same list, **When** a question arrives, **Then** nothing changes: the request has no image, and Qwen accepts a 900 cap.
7. **Given** Qwen refused on output tokens as the only model, **When** the request fails, **Then** the user reads "qwen/qwen3.8-27b — asks for up to R output tokens; this key allows 1000 per minute." and the log line carries `limit=1000 requested=R`.

### Edge Cases
- A 429 "Rate limit reached …" (a real per-minute limit) stays transient, with the server's cooldown.
- A 429 whose message has no numbers reads as too-large only if it says "Request too large".
- `visionOnly` without an image changes nothing.
- A later provider that sees images but has no key does not set `visionOnly`.
- Qwen cooling down for another reason while `visionOnly` applies: Groq tries it (`pickModel` picks the soonest to recover) or the chain skips the segment, as today.

See `contracts/EDGE_CASES.md` for the full list.

## Requirements *(mandatory)*

### Functional Requirements

**Error classification (`groqErrors.js`)**
- **FR-001**: `classify(err)` MUST return `'too-large'` for an HTTP 429 whose message contains "Request too large", before the 429 → transient rule. A 413 stays too-large. Any other 429 stays transient.
- **FR-002**: `tooLargeNumbers(err)` MUST return `{ limit, requested, output }`, where `output` is true when the message contains "(OTPM)". The result stays `null` when the message has no "Limit L, Requested R".

**Groq provider (`groq.js`)**
- **FR-003**: `DEFAULT_MAX_TOKENS` MUST be 16,384. `max_completion_tokens` stays the caller's cap, else `GROQ_MAX_TOKENS`, else the default, plus the reasoning allowance on models that reason, capped at the model's maximum.
- **FR-004**: `describeFailure` MUST return `MODEL — asks for up to R output tokens; this key allows L per minute.` for a too-large failure with `output: true`. The TPM message stays as it is.
- **FR-005**: `logAttempt` MUST add `limit=L requested=R` when `tooLargeNumbers(err)` reads them.
- **FR-006**: `createLLM` and `createStreamingLLM` MUST accept `visionOnly` and pass it to `runWithFailover`.
- **FR-007**: With `visionOnly` and an image in the request, `runWithFailover` MUST keep only the models that see images, in the order `orderForImages` gave. When none is left it MUST log one line and throw `NO_VISION_MODEL` with `userMessage` "No Groq model in the list sees images.", before any request. Without an image, `visionOnly` MUST change nothing.

**Chain (`providerChain.js`)**
- **FR-008**: `planRequest` MUST return `withImages`. `decideTurn` MUST set `options.visionOnly = true` when `withImages` is true and a later segment whose provider has a key sees images (`adapter.seesImages`). Otherwise the option MUST be absent. This holds for the stream and the non-stream path.
- **FR-009**: The chain MUST NOT change anything else: segment order, skips, timing, resets and messages stay as today.

**Unchanged**
- **FR-010**: `askService.js`, `askStreamState.js`, `summaryService.js`, `factory.js`, `gemini.js`, `anthropic.js`, `anthropicErrors.js` and `modelHealth.js` MUST NOT change. Gemini and Anthropic ignore `visionOnly`.

### Success Criteria
- **SC-001**: An integration test over the real `groq.js` and `gemini.js` with fake SDKs: an Ask-shaped request with a screenshot on the user's list, Qwen refused with the live OTPM message → Gemini answers with the image, gpt-oss is never called, Qwen is not cooling down, and the request declares 16,384 (automated).
- **SC-002**: `npm test` passes; the new and changed tests fail on `main` (automated, T013).
- **SC-003**: Live probe with the real `groq.js` and the user's Groq list: with `visionOnly`, one attempt on Qwen, `outcome=too-large … limit=1000`, no gpt-oss call; without it, gpt-oss answers with `images=dropped:1` (done, research R7).
- **SC-004**: In the app, an Ask with a screenshot in System Design mode is answered by Gemini with the image, uncut (manual, T-VERIFY-MANUAL).

### Key Entities *(include if feature involves data)*
- **Groq request cap**: `max_completion_tokens`, from the caller's cap or the default.
- **Error kind `too-large`**: now also a 429 on output tokens.
- **`tooLargeNumbers` result**: `{ limit, requested, output }`.
- **`visionOnly`**: a per-request option the chain gives a segment.

See `data-model.md`.

### External Dependencies & Risk Assessment *(mandatory)*

| Dependency | Type | Risk Level | Quota/Limits | Fallback Behavior |
|------------|------|------------|--------------|-------------------|
| Groq chat completions | API (existing) | MEDIUM | Free plan: 8K TPM and 200K TPD per model; Qwen 1K output tokens per minute on this key (R3) | Qwen refused → the next provider that sees images; gpt-oss for requests without an image |
| Gemini, Anthropic | API (existing, through the chain) | LOW | Their own | Unchanged |

**HIGH-RISK Dependency Checklist**:
- [x] The suite calls no API (fake SDKs).
- [x] The live probes ran by hand: about ten Groq requests, most of them refused before running (a refusal spends no tokens).

### Test Strategy *(mandatory)*

The classification and the request cap are table-tested. The provider's failover is tested against the scripted fake SDK of `groq.test.js`. The chain's option is tested with fake providers (`providerChain.test.js`) and end to end over the real providers with fake SDKs (`providerChain.integration.test.js`). The live behavior was probed by hand on the user's key.

**Test Type Classification**:
| FR | Primary Test Type | Reason |
|----|-------------------|--------|
| FR-001, FR-002 | Unit (table) | Pure |
| FR-003 | Unit (`buildRequest`) | Pure |
| FR-004–FR-007 | Unit (fake SDK) | Failover loop |
| FR-008, FR-009 | Unit (fake providers) + integration (real providers, fake SDKs) | Chain |
| FR-010 | Diff guards | Nothing else changes |
| SC-003 | Live probe (manual) | Real refusal |
| SC-004 | Manual (app) | Real Gemini key |

**Distribution Estimate**:
- Feature type: [x] Backend logic, no UI
- Unit: ~80% | Integration: ~10% | Contract: 0% | E2E/Manual: ~10%

**HIGH-RISK API Warning**:
- [x] None in the suite.

**Estimated Test Count**: 15 new cases and 6 changed assertions across 5 existing test files.

### Error Handling & Recovery *(mandatory if feature can fail)*

**Error Scenarios**:
| Error Scenario | Type | User Message | Recovery Action |
|----------------|------|--------------|-----------------|
| Qwen refused on output tokens, a later provider sees images | Provider limit | "Trying gemini-3.5-flash-lite…" | The next provider answers with the image |
| Qwen refused, Groq-only list | Provider limit | none (a fallback answer) | gpt-oss answers without the image |
| Qwen refused and it is the only model | Provider limit | "qwen/qwen3.8-27b — asks for up to R output tokens; this key allows L per minute." | None; the user changes the list or the key |
| `visionOnly` and no vision model in the list (a direct caller; the chain never does this, see data-model) | Config | "No Groq model in the list sees images." | None needed: a guard, no request is sent |

**Error/Rescue Registry**:
| Method/Codepath | What Can Go Wrong | Exception Class | Rescued? | Rescue Action | User Sees |
|-----------------|-------------------|-----------------|----------|---------------|-----------|
| `runAttempt` | 429 OTPM | groq-sdk `RateLimitError` (status 429) | Y | `too-large`, next model, no cooldown | the next model's answer |
| `runWithFailover` | `visionOnly` leaves no model (guard; not reached through the chain) | `Error` with code `NO_VISION_MODEL` | Y | thrown before any request; a chain would move on | the message, or the next provider's answer |
| `runWithFailover` | every vision model refused | last error with `userMessage` | Y (by the chain) | next segment | the next provider's answer |

**Failure Modes Registry**:
| Codepath | Failure Mode | Rescued? | Test? | User Sees? | Logged? |
|----------|-------------|----------|-------|------------|---------|
| classify | OTPM 429 read as a rate limit | Y | Y | — | yes |
| visionOnly | text-only model answers blind | Y | Y | — | `images=dropped` absent |
| default cap | long answer cut | Y | Y | — | `stop=length` absent |

*No row has Rescued=N.*

**Multi-Phase Operations**: None.

### UI/Design Reference *(mandatory)*

**Feature Classification**:
- [x] **No UI change.** The Ask window already shows "Trying <model>…" on a `_reset`.

### Permissions & Access Control *(mandatory)*

**Portal Placement**: [x] Application Portal (local Electron app).
**User Roles Affected**: [x] Local desktop user (single actor).
**Data Scoping**: [x] The screenshot goes to the same providers the user listed, in the same order; it is never sent to a provider the list does not name. A Groq text-only model no longer receives the question for a screenshot Ask when a later provider sees images.

### Architecture Context *(mandatory if feature has business logic)*

```
src/features/common/ai/
  providerChain.js                                   EDIT  planRequest returns withImages; decideTurn sets visionOnly; laterSeesImages
  providers/groq.js                                  EDIT  DEFAULT_MAX_TOKENS 16,384; visionOnly; OTPM message; limit/requested in the log
  providers/groqErrors.js                            EDIT  429 "Request too large" → too-large; tooLargeNumbers().output
  providers/__tests__/groqErrors.test.js             EDIT  OTPM cases; tooLargeNumbers shape
  providers/__tests__/groqRequest.test.js            EDIT  the default cap
  providers/__tests__/groq.test.js                   EDIT  OTPM failover; visionOnly
  __tests__/providerChain.test.js                    EDIT  visionOnly per segment (additions only)
  __tests__/providerChain.integration.test.js        EDIT  the user's list end to end (additions only)
docs/…, README.md, CHANGELOG.md, ARCHITECTURE.md     EDIT  (T-DOC-GATE)
specs/2026-10-12-groq-provider/research.md           EDIT  R20 (the live probes, on the provider's own record)
```

---

## Out of Scope / Future Work

- **A notice when the screenshot was not used** (Groq-only lists). `docs/future-work.md` item 6.
- **A per-mode cap in Ask.** Not needed: the Groq default now fits every mode, and Gemini (65,536) and Anthropic (16,000) keep their own.
- **Remembering a model's output limit** (D7).
- **Live Insights on Qwen.** Its 1,024 cap is over Qwen's 1,000. Qwen is its third model, so the change makes the refusal cost no cooldown, and nothing more.

---

## Review Checklist (Gate)

- [x] No [NEEDS CLARIFICATION] markers remain (session 2026-10-12)
- [x] Requirements are testable
- [x] Test strategy defined (tables, fake SDK, fake providers, integration over real providers, live probe, app check)
- [x] Portal placement selected
- [x] Permissions defined (single local user)
- [x] Data sensitivity classified (the screenshot goes only to listed providers)
- [x] External APIs identified (Groq, existing)
- [x] Error handling defined
- [x] UI complexity classified (none)
- [x] Deprecation decision made: nothing deprecated
- [x] Bug evidence captured: the log of 2026-10-12 and the live probes (research R1, R3)

---

## Next Steps

- T-VERIFY-MANUAL: in the app, an Ask with a screenshot in System Design mode (quickstart §4).
- Then T-FINAL, and a commit and PR when the user asks.

---
# Context Optimization Metadata
# Purpose: Enable efficient partial reads (~200 tokens vs ~2500 for full file)
meta:
  spec_id: 2026-10-12-cross-provider-failover
  spec_name: cross-provider-failover
  status: draft    # draft | in-progress | approved | completed
  phase: plan          # specify | clarify | plan | tasks | preflight | feature-start | implement | verify
  created: 2026-10-12
  updated: 2026-10-12

# Quick Reference (for checkpoint resume)
summary:
  goals:
    - {id: G1, description: "One LLM model list may mix providers (Groq, then Gemini or Claude). When every model of one provider fails, the next provider's models answer, in Ask, Live Answer and Live Insights, with no action from the user", priority: HIGH}
    - {id: G2, description: "A provider whose budget is spent costs no time once it has failed: while all its models cool down it is skipped without a request", priority: HIGH}
    - {id: G3, description: "A single-provider list behaves exactly as today, through the same provider call with the same options", priority: HIGH}
  constraints:
    - {id: C1, description: "The SSE protocol the consumers read (_reset, _final_model, [DONE], err.userMessage) is reused as is. askStreamState.js is not edited. askService.js and summaryService.js only gain 'keys: modelInfo.keys' on their three LLM calls", type: TECHNICAL}
    - {id: C2, description: "groq.js, groqErrors.js, anthropic.js, anthropicErrors.js, gemini.js, geminiModelRotator.js and their tests are not edited. modelHealth.js gains one read-only function; its existing exports, behavior and tests are unchanged", type: SCOPE}
    - {id: C3, description: "Never log prompt, answer or reasoning text (existing invariant). Chain logs carry provider, model IDs, outcome, timings and the providers' own short error messages only", type: SECURITY}
    - {id: C4, description: "A provider only ever receives its own API key. Keys are never logged and never passed to a provider in another field", type: SECURITY}
    - {id: C5, description: "No new dependency and no database migration. The mixed list is stored where a list is stored today (selected_llm_model of the first entry's provider)", type: TECHNICAL}
    - {id: C6, description: "Tests run under npm test (node:test, plain Node) with every SDK mocked. No live API call in the suite", type: TECHNICAL}
    - {id: C7, description: "The user's accounts on 2026-10-12: Groq Free plan (30 RPM, 1K RPD, 8K TPM, 200K TPD per model); Gemini project on the free tier (gemini-3.5-flash-lite and gemini-3.1-flash-lite: 15 RPM, 250K TPM, 500 RPD each; RPD resets at midnight Pacific); no Anthropic key saved in the app (research R3)", type: TECHNICAL}
  decisions:
    - {id: D1, decision: "The mixed list is typed in the existing model field of its first provider (e.g. the Groq field holds 'openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b,gemini-3.5-flash-lite,gemini-3.1-flash-lite'). The first entry decides the active provider, as today. No new field, no new column", rationale: "The stored string already flows from Settings to the factory unchanged (selected_llm_model). A separate 'fallback' field would need storage, a migration and a second place to look (research R12)"}
    - {id: D2, decision: "The list is cut into segments: runs of consecutive IDs whose provider (inferProviderFromModelId) is the same. An ID with no inferable provider joins the current segment. Splitting applies only when the active provider is anthropic, gemini or groq; a list with one segment takes today's path", rationale: "Each segment is a list its provider already knows how to fail over. Unknown IDs keep today's behavior (the provider tries them). OpenAI, Ollama and Whisper are unaffected (G3, research R6)"}
    - {id: D3, decision: "A new module, providerChain.js, composes the providers' public createStreamingLLM and createLLM. It reads each segment's SSE stream and passes its events through. No provider internals are shared or edited", rationale: "All three providers already speak the same protocol to the consumers. Composition keeps each provider's tuned rules (cooldowns, rounds, timeouts, image routing) and leaves their code and tests untouched (C2). A shared failover engine is a separate refactor (research R4)"}
    - {id: D4, decision: "Every failure of a segment moves on to the next segment: transient, unavailable, too-large, fatal-request and fatal-auth alike. Only a cancel stops the chain", rationale: "Keys, limits and request rules differ per provider. A Groq 401, 400 or exhausted budget says nothing about Gemini, and during an interview an answer from the next provider beats an error (research R10)"}
    - {id: D5, decision: "A segment whose every model is cooling down in the shared registry is skipped without a request while a later segment has a model that is not cooling down. If every remaining segment is cooling down they run in order (the providers then try their soonest-recovering model, as today)", rationale: "Groq's daily-limit 429 asks for minutes ('Please try again in 6m11s'); the registry keeps the models out for up to 5 min. Skipping turns the 3 wasted 429s per request into none until a cooldown ends (research R7)"}
    - {id: D6, decision: "A segment whose provider has no saved key is skipped and logged. Settings refuses to save a list naming a provider without a key", rationale: "The key may be removed after the list was saved; the rest of the chain must still work"}
    - {id: D7, decision: "Chain deadline: an answer must start within LLM_CHAIN_DEADLINE_MS (60 s; 0 disables) across all segments. Each segment gets requestDeadlineMs = min(its provider's own deadline, time left minus 15 s when a later segment can run). Segments other than the last get retryRoundDelayMs 0. Once answer text has been forwarded, no chain deadline applies", rationale: "Without it a stalled Groq (45 s) plus Gemini (60 s) could take 105 s. The 15 s reserve leaves the fallback time to answer. The 2–3 s wait before a provider's second round is wasted when another provider is ready (research R8)"}
    - {id: D8, decision: "When the request carries an image, segments that can see images go before those that cannot (stable order). A Groq segment sees images when one of its models does (qwen/qwen3.8-27b); Gemini and Anthropic segments always do", rationale: "Today a Groq list without a vision model answers a screenshot question blind (images dropped). With a mixed list the screenshot should reach a model that sees it (research R9)"}
    - {id: D9, decision: "modelStateService.getCurrentModelInfo('llm') adds keys: { [provider]: key | null } for every provider named in the list. The three LLM calls pass keys: modelInfo.keys. The factory strips keys from the options before any provider call", rationale: "The factory has no access to the settings DB, and a hidden key resolver would couple it to modelStateService. Three explicit one-line edits are easier to test and review (research R5)"}
    - {id: D10, decision: "Switching segments sends { _reset: true, next_model, reason: 'provider' }. next_model is the first model the next segment will try", rationale: "Consumers already show 'Trying <model>…' and mark the answer '(fallback)'. They do not branch on reason (askStreamState.js:46-54, summaryService.js:270), so a new value is safe (research R11)"}
    - {id: D11, decision: "When every segment fails: one segment ran → its own userMessage; more → 'All providers failed (groq → gemini). Last: <last segment's userMessage>'; chain deadline → 'No answer within 60s (groq → gemini). Last: …'", rationale: "Same shape as the providers' own messages; the last provider's reason is the one the user can act on, the full trail is in the log"}
    - {id: D12, decision: "Recommended list: openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b,gemini-3.5-flash-lite,gemini-3.1-flash-lite. Optionally ',claude-haiku-5-5' at the end once an Anthropic key with credit is saved", rationale: "Uses only keys the user already has. Groq carries ~600K tokens a day across three models; the two Flash-Lite models add 1,000 requests a day, several interviews' worth. Gemini's free tier can return 503 at peak hours, which a paid Claude Haiku 5.5 at the end covers for about US$0.10–0.15 per hour even if it answered a whole interview (research R3, R13)"}

# CRITICAL REQUIREMENTS - Must verify during implementation
# These survive context compaction and generate T-VERIFY tasks
critical_requirements:
  type: feature-major    # bugfix | feature-minor | feature-major | config | documentation | refactoring
  portal: app            # superadmin | admin | app | public | none
  ui_changes: minor      # none | minor | moderate | major
---

# Feature Specification: Cross-Provider Failover

**Feature Branch**: `2026-10-12-cross-provider-failover`
**Created**: 2026-10-12
**Status**: Draft
**Input**: User request (2026-10-12): "Following the same pattern as the last two features, let's make a plan for this improvement you suggested: 'When the quota runs out, there is no automatic provider switch. Live Answer shows "All Groq models failed … rate limit" until the quota renews the next day. The way out is the list that mixes providers (Groq → Claude or Gemini), which I left as the next spec.'" (translated from Portuguese)

---

## System Context

**Systems**: Framework-internal. The Glass Electron main process: the AI factory, a new composition module, `modelStateService`, the three LLM call sites, and the Settings view in the renderer.
**Databases**: None changed. The mixed list is the existing `provider_settings.selected_llm_model` string of the first entry's provider. Other providers' keys are read from their own rows, as Settings already stores them.
**Integrations**: None new. The chain calls the existing Groq, Gemini and Anthropic providers through their public `createStreamingLLM` and `createLLM`.
**Key Architecture**: Three lanes call the LLM. Ask streams (`askService.js:315`), Live Answer streams (`summaryService.js:380`) and Live Insights calls `chat()` (`summaryService.js:813`). Each resolves `{ provider, model, apiKey }` from `modelStateService.getCurrentModelInfo('llm')` (`:378-390`) and calls the factory (`factory.js:145`, `:158`), which hands the whole list to one provider. Each provider fails over within its own list, against the shared cooldown registry (`modelHealth.js`), and speaks the same SSE protocol to the consumers: content deltas, `_reset`, `_final_model`, `[DONE]`, and an error carrying `userMessage`. Settings has one model field per provider; each validator accepts only that provider's IDs (`SettingsView.js:745`, `:785`, `:813`).

Today a Groq list that runs out of budget ends in "All Groq models failed … rate limit" for every request until Groq's daily budget refills (research R1, R2).

---

## Clarifications

### Session 2026-10-12

- Q: Same structure as PR #13 and #14? → A: Yes. Same spec set and order: pure pieces with tests first, then the stream and non-stream paths, then an integration test over the real providers, then wiring, Settings, docs and live checks. There is no SDK step: no dependency is added.
- Q: Where does the cross-provider loop live? → A: In a new composition module over the providers' public interface (D3). The providers are not edited.
- Q: Which provider takes over from Groq? → A: Gemini Flash-Lite, because its key is already saved and its free tier carries an interview's worth of requests. Claude Haiku 5.5 is the optional, paid last resort (D12, research R3). The app has no Anthropic key today.
- Q: Does a fatal error (bad key, 400) move to the next provider? → A: Yes (D4). Inside one provider it ends the request because every model shares the key and the request rules; across providers neither is shared.
- Q: How does the user type it? → A: In the existing field of the first provider, as one comma-separated list (D1).

**Deferred (default chosen, not blocking)**:
- Honoring a daily-limit retry hint longer than 5 min. Default: the registry clamp stays at 5 min, so a spent Groq model is probed again every 5 min (a ~0.2 s 429). Out of scope.
- Switching before the budget runs out (reading `x-ratelimit-remaining-tokens`). Default: reactive only.

---

## User Scenarios & Testing *(mandatory)*

### Primary User Story
The user types `openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b,gemini-3.5-flash-lite,gemini-3.1-flash-lite` in the Groq model field and saves it. During a long interview Live Answer streams from GPT-OSS 120B. Forty minutes in, Groq's daily budget runs out: the next question shows "Trying openai/gpt-oss-20b…", "Trying qwen/qwen3.8-27b…", "Trying gemini-3.5-flash-lite…" for a fraction of a second, and the answer arrives from Gemini, marked as a fallback. The questions after that go straight to Gemini, with no Groq request, until a Groq cooldown ends; then one quick probe tells whether Groq has budget again.

### Acceptance Scenarios
1. **Given** a list that names one provider, **When** any lane runs, **Then** the factory calls that provider once with today's options and no chain line is logged.
2. **Given** the recommended list and a 429 on every Groq model, **When** Live Answer runs, **Then** the consumer receives Groq's own `_reset`s, one `_reset` with `reason: 'provider'` naming `gemini-3.5-flash-lite`, Gemini's text, `_final_model: 'gemini-3.5-flash-lite'` and `[DONE]`.
3. **Given** the Groq models are cooling down from that failure, **When** the next request runs within their cooldown, **Then** no Groq request is made, the log shows `outcome=skipped-cooling`, and Gemini answers with no `_reset`.
4. **Given** a Groq 401 or 400 on a mixed list, **When** a request runs, **Then** the chain moves to Gemini (D4).
5. **Given** an Ask with a screenshot and the list `openai/gpt-oss-120b,openai/gpt-oss-20b,gemini-3.5-flash-lite` (no Groq vision model), **When** it runs, **Then** Gemini is tried first with the image, and Groq only after it.
6. **Given** a mixed list whose second provider's key was removed, **When** the first provider fails, **Then** the log shows `outcome=skipped-no-key` and the user reads the first provider's own message.
7. **Given** every segment fails, **When** the request ends, **Then** the user reads "All providers failed (groq → gemini). Last: <Gemini's message>".
8. **Given** the consumer cancels during any segment or the switch, **When** it happens, **Then** the in-flight request is aborted, no other segment starts, and no error is raised.
9. **Given** Settings, **When** the user saves a Groq list ending in `claude-haiku-5-5` without an Anthropic key, **Then** the save is refused, naming the entry and the missing key. A list whose first entry belongs to another provider is refused in that field.

### Edge Cases
- A segment emits text and then fails: the chain's `_reset` makes the consumer discard the partial answer.
- Groq's TPD bucket refills continuously, so a probe after the cooldown may succeed: Groq answers again until the next 429 (research R2).
- A provider's stream ends without `[DONE]` and without an error: a segment failure.
- Interleaved lists (`groq, gemini, groq`): three segments, each with its own rules.
- `LLM_CHAIN_DEADLINE_MS=0`: each segment keeps its own deadline only.

See `contracts/EDGE_CASES.md` for the full list.

## Requirements *(mandatory)*

### Functional Requirements

**Selection, keys and Settings**
- **FR-001**: `factory.splitByProvider(modelCsv, firstProvider)` MUST return the list's segments `{ provider, models[] }` in order:
  - an ID's provider is `inferProviderFromModelId(id)`; when that is null, the ID joins the current segment (the first segment's provider is `firstProvider`);
  - consecutive IDs of one provider form one segment;
  - when `firstProvider` is not `anthropic`, `gemini` or `groq`, the result is one segment with the whole list;
  - entries are trimmed and empties dropped; an empty list gives `[]`.
- **FR-002**: `factory.createStreamingLLM` and `createLLM` MUST remove `keys` from the options before calling any provider. With one segment (or none) they MUST call the provider exactly as today. With two or more they MUST return the chain (FR-008 onward).
- **FR-003**: `modelStateService.getCurrentModelInfo('llm')` MUST add `keys`, mapping every provider among the list's segments to its saved key or `null` (the active provider's key from the active row). The `stt` result is unchanged.
- **FR-004**: The Ask stream (`askService.js:315`), the Live Answer stream (`summaryService.js:380`) and the Live Insights call (`summaryService.js:813`) MUST pass `keys: modelInfo.keys`. Nothing else in the consumers changes.
- **FR-005**: The Gemini, Anthropic and Groq model fields in Settings MUST accept a mixed list:
  - the first entry MUST belong to the field's provider (today's rule for that provider);
  - a later entry MAY be another provider's ID (`claude-…`, `gemini-…`, or `vendor/model` when it is not an installed Ollama model) only if that provider's key is saved; otherwise the save is refused, naming the entry and the provider whose key is missing;
  - normalization is today's (split on `,`, trim, drop empties);
  - each help line gains one sentence and an example of a list ending in another provider's models.
- **FR-006**: `getProviderForModel`, `setSelectedModel` and `getAvailableModels` keep their behavior: the first entry decides the provider, and the list is stored in that provider's row and shown as "(custom)".

**Chain plan (pure)**
- **FR-007**: The plan MUST:
  - put image-capable segments first, in list order, when the request carries an image (an `image_url` part or an `inlineData` part). A Groq segment is image-capable when `modelTraits(id).vision` holds for one of its models; Gemini and Anthropic segments always are. Without an image the list order is kept;
  - skip a segment whose provider has no key (`skipped-no-key`);
  - skip a segment whose every model is cooling down (`modelHealth.isCoolingDown`) while a later segment, not skipped for a key, has a model that is not (`skipped-cooling`). This is decided when the segment's turn comes.

**Chain stream**
- **FR-008**: `streamChat(messages)` MUST resolve at once with a `Response` whose body is SSE. For the running segment it MUST pass through every content delta, `_reset` and `_final_model` unchanged, and on that segment's `[DONE]` send `[DONE]` and close.
- **FR-009**: Each segment MUST be called with the caller's options minus `keys`, plus:
  - `apiKey`: that provider's key only (C4): `keys[provider]`, or `opts.apiKey` for the active provider when `keys` does not name it;
  - `model`: its models joined with `,`;
  - `requestDeadlineMs`: the smaller of its provider's `requestDeadlineMs()` (null = none) and the chain time left, less 15 s when a later segment can still run. Omitted when neither applies;
  - `retryRoundDelayMs: 0` when a later segment can still run.
  A non-last segment whose computed deadline is ≤ 0 is skipped (`skipped-deadline`).
- **FR-010**: The chain deadline is `chainDeadlineMs()` (60 s; `LLM_CHAIN_DEADLINE_MS` overrides, 0 disables). It applies until the first content delta is forwarded. When it passes with no answer started, no further segment starts.
- **FR-011**: A segment fails when its stream errors, ends without `[DONE]`, or `streamChat` rejects or throws. If another segment can run, the chain MUST send `{ _reset: true, next_model, reason: 'provider' }` and start it. `next_model` is the first model that segment will try: `modelHealth.pickModel` over its models, with a Groq segment's models ordered by `orderForImages` first.
- **FR-012**: Cancelling the chain stream MUST cancel the running segment's reader (the provider then aborts its in-flight request), start no other segment, and raise no error. Every enqueue MUST be guarded against a closed controller.
- **FR-013**: When no segment answers, the stream MUST error with the last segment error, whose `userMessage` is:
  - one segment ran: that segment's own `userMessage`, unchanged;
  - two or more ran: `All providers failed (<p1> → <p2> …). Last: <last userMessage>`;
  - the chain deadline passed: `No answer within <s> (<p1> → …). Last: <last userMessage>`.
  Provider names are the provider IDs that ran, in order.

**Chain non-streaming**
- **FR-014**: `chat(messages)` and `generateContent(parts)` MUST follow the same plan, skip, key and timing rules, calling each segment's `createLLM(...)` method of the same name. The first success's result is returned unchanged (`content` / `response`, `raw`, `_modelUsed`). Failure throws the FR-013 error.

**Logs**
- **FR-015**: Each segment whose turn comes (run or skipped) MUST log one line; segments never reached log nothing. The line is `[LLM Chain] segment i/n <stream|once> provider=… models=<ids> outcome=<ok|failed|cancelled|skipped-no-key|skipped-cooling|skipped-deadline>`, with `total=<ms>` when it ran, `answered_by=<model>` on ok, and `error="<userMessage>"` on failure. Each request MUST log `[LLM Chain] request <stream|once> answered_by=<model|none> provider=<id|none> segments_run=<n> total=<ms>`, plus `order=images-first` when image ordering changed the plan and `cancelled` when cancelled. No line contains prompt, answer or reasoning text, or a key (C3, C4).

**Registry**
- **FR-016**: `modelHealth.isCoolingDown(modelId)` MUST return whether the model has a cooldown entry that has not ended. It reads only. Every existing export and behavior stays as is.

**Unchanged**
- **FR-017**: The providers, their classifiers, the Gemini rotator and their tests MUST NOT change (C2). `askStreamState.js` MUST NOT change. `factory.test.js` and `modelHealth.test.js` only gain lines.

### Success Criteria
- **SC-001**: With the recommended list, Ask (with and without a screenshot), Live Answer and Live Insights answer from Groq. When Groq is forced to fail (an unknown first model, or `GROQ_FIRST_TEXT_TIMEOUT_MS=1`), they answer from Gemini, and the next request within the cooldown skips Groq. Checked by hand, quickstart §4.
- **SC-002**: `npm test` passes, with the new chain tests and the whole existing suite unchanged.
- **SC-003**: With the real `groq.js` and `gemini.js` over mocked SDKs, a 429 on every Groq model gives the consumer exactly one `reason: 'provider'` `_reset`, Gemini's text, `_final_model` set to the Gemini model, and `[DONE]` (automated).
- **SC-004**: Cancelling the chain stream aborts the running segment's in-flight request within one event-loop turn, and no later segment is created (automated).
- **SC-005**: For a single-provider list, the provider's factory function receives the same options object as today minus `keys`, and no chain code runs (automated).
- **SC-006**: The cost of a switch is measured in a real session: the `total` of the failed Groq segment on the first request after Groq runs out (or is forced to fail), and the number of Groq requests on the requests that follow within the cooldown (expected 0). Recorded in `research.md` R15. A report, not a gate.

### Key Entities *(include if feature involves data)*
- **Model list**: the stored `selected_llm_model` string, now possibly naming several providers.
- **Segment**: `{ provider, models[] }`, a run of one provider's IDs.
- **Keys map**: `{ [provider]: key | null }` for the providers a list names.
- **Segment plan entry**: a segment plus its skip reason, deadline and round delay.
- **Health entry**: `{ cooldownUntil }` per model ID in the shared registry (read by the chain).

See `data-model.md`.

### External Dependencies & Risk Assessment *(mandatory)*

| Dependency | Type | Risk Level | Quota/Limits | Fallback Behavior |
|------------|------|------------|--------------|-------------------|
| Groq (existing provider) | HTTP streaming | **HIGH** | Free plan, per model: 30 RPM, 1K RPD, 8K TPM, 200K TPD | Its own model failover, then the next segment |
| Gemini (existing provider) | HTTP streaming | MED | Free tier: Flash-Lite 15 RPM, 250K TPM, 500 RPD per model; 503 possible at peak hours (`docs/GEMINI_503_PEAK_HOURS.md`) | Its own failover, then the next segment, if any |
| Anthropic (existing provider, optional) | HTTP streaming | LOW | Paid; no key saved today | Last resort when the user adds it |

**HIGH-RISK Dependency Checklist**:
- [x] Quota-limited APIs → mocked in every test; manual checks spend fractions of a cent and some free-tier requests.
- [x] A budget that runs out mid-interview → this feature; the spent provider is skipped while it cools down.
- [x] Free-tier fallback that can 503 → the optional paid last segment (D12).

### Test Strategy *(mandatory)*

The pure planning functions are table-tested. The chain is tested against fake providers whose streams are scripted (success, error, error after text, end without `[DONE]`, hang until cancelled), recording the options and keys each received. An integration file loads the real `groq.js`, `gemini.js` and `anthropic.js` with their SDKs mocked through `Module._load`, the pattern of their own tests, so the protocol is checked end to end.

**Test Type Classification**:
| FR | Primary Test Type | Reason |
|----|-------------------|--------|
| FR-001, FR-002 | Unit (factory additions) | Pure split; routing with stubbed provider handlers |
| FR-003, FR-004 | Unit where loadable + grep + manual | `modelStateService` cannot load under `npm test` (better-sqlite3 ABI); key-map logic kept in a pure helper |
| FR-005, FR-006 | Manual + build | Settings view (renderer) |
| FR-007, FR-009, FR-010 | Unit (table) | Plan, skip and timing are pure |
| FR-008, FR-011–FR-013, FR-015 | Integration (fake providers) | Pass-through, switch, cancel, messages, logs |
| FR-014 | Integration (fake providers) | Non-stream path |
| FR-016 | Unit (additions to `modelHealth.test.js`) | Read-only query |
| FR-017 | Diff guards | Nothing else changes |
| SC-003 | Integration (real providers, mocked SDKs) | Protocol across providers |
| SC-001, SC-006 | Manual (live keys) | Real APIs |

**Distribution Estimate**:
- Feature type: [x] Backend logic with a small settings UI change
- Unit: ~40% | Integration: ~50% | Contract: 0% | E2E/Manual: ~10%

**HIGH-RISK API Warning**:
- [x] Feature calls quota-limited APIs → the suite never calls them; manual checks only.

**Estimated Test Count**: ~70–90 cases across 2 new test files plus additions to `factory.test.js` and `modelHealth.test.js`.

### Error Handling & Recovery *(mandatory if feature can fail)*

**Error Scenarios**:
| Error Scenario | Type | User Message | Recovery Action |
|----------------|------|--------------|-----------------|
| Every model of a segment fails (any kind) | Segment failure | "Trying <first model of next segment>…" | Next segment |
| Segment fails after streaming text | Segment failure | Partial answer discarded, "Trying …" | Next segment |
| Segment's models all cooling down | Expected | None | Skipped, no request |
| Segment's provider has no key | Config | None (log) | Skipped |
| Every segment fails | Final | "All providers failed (groq → gemini). Last: …" | None; the user can add a provider |
| Chain deadline passes | Final | "No answer within 60s (groq → gemini). Last: …" | None |
| Consumer cancels | Expected | None | Running segment cancelled, chain stops |

**Error/Rescue Registry**:
| Method/Codepath | What Can Go Wrong | Exception Class | Rescued? | Rescue Action | User Sees |
|-----------------|-------------------|-----------------|----------|---------------|-----------|
| chain `streamChat` | segment `streamChat` throws or rejects | any | Y | Segment failure | `_reset` or `userMessage` |
| chain `streamChat` | segment stream errors | provider error with `userMessage` | Y | Segment failure | `_reset` or `userMessage` |
| chain `streamChat` | segment stream ends without `[DONE]` | none (chain creates one) | Y | Segment failure | `_reset` or `userMessage` |
| chain `chat` / `generateContent` | segment throws | provider error | Y | Next segment | thrown error with `userMessage` |
| `getCurrentModelInfo` | a named provider has no row | none | Y | `keys[p] = null` | segment skipped |

**Failure Modes Registry**:
| Codepath | Failure Mode | Rescued? | Test? | User Sees? | Logged? |
|----------|-------------|----------|-------|------------|---------|
| chain stream | segment fails | Y | Y | retrying status | segment line |
| chain stream | all fail | Y | Y | `userMessage` | segment + request lines |
| chain stream | cancel | Y | Y | nothing | request line `cancelled` |
| chain plan | no key / cooling / deadline | Y | Y | nothing | segment line `skipped-*` |

*No row has Rescued=N.*

**Multi-Phase Operations**: None. Each request is independent; the registry holds cooldown timestamps in memory.

### UI/Design Reference *(mandatory)*

**Feature Classification**:
- [x] **Minor UI** (< 3 components, existing patterns only)

**Design Reference**:
- Settings (`src/ui/settings/SettingsView.js`): the three model fields keep their layout. Their validators (`:745`, `:785`, `:813`) accept other providers' IDs after the first entry (FR-005). Each help line gains: "You can end the list with another provider's models whose key is saved; they answer when every model before them fails." Example under the Groq field: `openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b,gemini-3.5-flash-lite`.
- Ask and Live Answer views are unchanged: they already show "Trying <model>…" and "answered by: <model> (fallback)".

### Permissions & Access Control *(mandatory)*

**Portal Placement**: [x] Application Portal (local Electron app).
**User Roles Affected**: [x] Local desktop user (single actor).
**Data Scoping**: [x] User-scoped. When the chain falls back, the same request (prompt, transcript excerpt, career context, screenshot) goes to the next provider, a provider the user configured. Gemini's free tier is an unpaid service, which Google's Gemini API terms allow it to use to improve its products; the user already sends this data to Gemini when it is selected. Keys stay in the local settings DB and each provider sees only its own.

### Architecture Context *(mandatory if feature has business logic)*

```
src/features/common/ai/
  factory.js                   EDIT  splitByProvider (pure); createLLM/createStreamingLLM strip keys and route ≥2 segments to the chain
  providerChain.js             NEW   adapters, hasImages, orderSegments, skipReason, segmentTiming, failureMessage, chainDeadlineMs (pure); createChainStreamingLLM, createChainLLM
  __tests__/factory.test.js    EDIT  split and routing cases (existing assertions unchanged)
  __tests__/providerChain.test.js              NEW  plan, timing, stream and non-stream paths over fake providers
  __tests__/providerChain.integration.test.js  NEW  real groq.js, gemini.js, anthropic.js with mocked SDKs
  providers/
    modelHealth.js             EDIT  isCoolingDown (read-only, additive)
    __tests__/modelHealth.test.js  EDIT  isCoolingDown cases (additions only)
    groq.js, gemini.js, anthropic.js, *Errors.js, geminiModelRotator.js   UNCHANGED
src/features/common/services/modelStateService.js   EDIT  getCurrentModelInfo('llm') adds keys
src/features/ask/askService.js                      EDIT  keys: modelInfo.keys (one line)
src/features/listen/summary/summaryService.js       EDIT  keys: modelInfo.keys (two lines)
src/ui/settings/SettingsView.js                     EDIT  mixed-list validators and help lines
docs/…                                              EDIT  ARCHITECTURE §10.4, diagram 17, CHANGELOG (T-DOC-GATE)
```

---

## Out of Scope / Future Work

- **Longer cooldowns for daily limits.** Groq's daily 429 asks for minutes; the registry clamps every cooldown at 5 min, so a spent model is probed again every 5 min (one fast 429).
- **Proactive switching** from `x-ratelimit-remaining-tokens` or a remaining-TPD estimate.
- **OpenAI and Ollama as segments.** Their IDs have no prefix rule, and Ollama names need the installed-model lookup. A local Ollama last resort would answer offline.
- **A separate "fallback" field** or a per-provider "then try" setting.
- **Per-lane lists** (e.g. Live Answer on Groq, Ask on Gemini).
- **A shared failover engine** for the three providers.
- **Cross-provider STT fallback.**

---

## Review Checklist (Gate)

- [x] No [NEEDS CLARIFICATION] markers remain (session 2026-10-12; two items deferred with defaults)
- [x] Requirements are testable
- [x] Test strategy defined (pure tables, fake providers, real providers over mocked SDKs, manual live checks)
- [x] Portal placement selected
- [x] Permissions defined (single local user)
- [x] Data sensitivity classified (same data, to providers the user configured; Gemini free-tier terms noted)
- [x] External APIs identified (existing Groq, Gemini, Anthropic)
- [x] Error handling defined
- [x] UI complexity classified (Minor)
- [x] Deprecation decision made: nothing deprecated
- [ ] Bug evidence captured: N/A (`feature-major`)

---

## Next Steps

- The user approves the plan and the recommended list (quickstart §2), and decides whether to add an Anthropic key for the optional last segment.
- Then: branch `2026-10-12-cross-provider-failover`, tasks in `tasks.json` order, through T-DOC-GATE; then T-VERIFY-MANUAL with the live keys and T-FINAL.

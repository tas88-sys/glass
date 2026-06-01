---
# Context Optimization Metadata
# Purpose: Enable efficient partial reads (~200 tokens vs ~2500 for full file)
meta:
  spec_id: 2026-06-01-interview-live-answer-readability
  spec_name: interview-live-answer-readability
  status: draft
  phase: clarify
  created: 2026-06-01
  updated: 2026-06-01

# Quick Reference (for checkpoint resume)
summary:
  goals:
    - {id: G1, description: "READABILITY — make the streamed Live Answer easy to scan: reinforce a scannable bullet-point structure via the INJECTED user message (not the closed template), so the model returns real markdown bullets instead of dense run-on text with inline ' - ' separators", priority: HIGH}
    - {id: G2, description: "QUESTION LABEL — the history entry's Q: label shows only the interrogative span, not the entire (often long, filler-laden) them: turn, via a new pure extractQuestion(text) helper", priority: HIGH}
    - {id: G3, description: "Both changes are purely additive and in-memory only — the shipped Live Answer lane (specs/2026-05-30-interview-live-answer/) keeps behaving identically; no regression to the summary lane", priority: HIGH}
  constraints:
    - {id: C1, description: "Bullet structure is reinforced ONLY via the injected user message in makeLiveAnswer (summaryService.js:256-259). promptTemplates.js is CLOSED (original FR-006/FR-017) and MUST NOT be modified — it already requests headline+bullets at promptTemplates.js:252-258", type: TECHNICAL}
    - {id: C2, description: "extractQuestion(text) is a PURE, directly unit-testable helper that REUSES the same question signals as isLikelyQuestion (CLAUSE_LEAD_RE, LEAD_STRIP_RE, CONTENT_CUE_RE, EMBEDDED_Q_RE at summaryService.js:38-56); it falls back to the full text when no clean interrogative span is found", type: TECHNICAL}
    - {id: C3, description: "In-memory only — C8 of the original spec still holds; neither change persists anything to the session DB (no summaryRepository / config-DB writes)", type: TECHNICAL}
    - {id: C4, description: "Keep the original FR-018/C6 convention: pure helper + thin orchestrator; tests use the Node built-in runner (require('node:test') + require('node:assert/strict')) per package.json:15 — NOT Jest", type: TECHNICAL}
    - {id: C5, description: "CLOSED set stays closed: promptTemplates.js, the summary lane (makeOutlineAndRequests / triggerAnalysisIfNeeded), the summary-update channel, and SummaryView.js MUST NOT be modified", type: TECHNICAL}
  decisions:
    - {id: D1, decision: "Bullet reinforcement lives in the injected user message string, NOT the prompt template", rationale: "promptTemplates.js is the closed pickle_glass_analysis profile (original FR-006/FR-017); the injected user message is the only open surface that can reinforce the already-requested headline+bullets structure"}
    - {id: D2, decision: "extractQuestion is a sibling pure helper next to isLikelyQuestion, exported the same way (module.exports.extractQuestion at the bottom of summaryService.js)", rationale: "Matches the FR-018/C6 pure-helper + thin-orchestrator convention; reuses the existing signal regexes; directly unit-testable via node:test"}
    - {id: D3, decision: "extractQuestion is wired in at the single call site summaryService.js:451 — `question: extractQuestion(text)` replaces `question: text`", rationale: "The cleaner value flows straight to the renderer's Q: label (LiveAnswerView.js:148-149,345) with NO renderer/UI change"}
    - {id: D4, decision: "Bullets are ALWAYS-ON for v1 — no bullet-vs-prose toggle. The injected user message unconditionally reinforces the headline+bullets structure; prose mode is NOT exposed", rationale: "[LOCKED with user 2026-06-01] Directly solves 'make it easier to understand' with the smallest change; the app has no preference store wired to the answer lane (config is env-var only, C3/C8 forbid DB persistence). A prose switch is deferred to future work"}

# CRITICAL REQUIREMENTS - Must verify during implementation
# These survive context compaction and generate T-VERIFY tasks
critical_requirements:
  type: feature-minor
  portal: app
  ui_changes: minor
---

# Feature Specification: Interview Live Answer — Readability (Bullet Format + Question Label)

**Feature Branch**: `2026-06-01-interview-live-answer-readability`
**Created**: 2026-06-01
**Status**: Draft
**Input**: User description: "interview-live-answer-readability — Two additive improvements to the already-shipped Interview Live Answer lane (see specs/2026-05-30-interview-live-answer/). (1) READABILITY: make the streamed answer easier to scan — the pickle_glass_analysis template already requests a 'headline + bullets' structure (promptTemplates.js:252-258) but it is a CLOSED file (FR-006/FR-017 of the original spec) and the injected user message in summaryService.makeLiveAnswer (summaryService.js:257 'Answer the interviewer's most recent question directly and concisely') does not reinforce that structure, so the model returns dense run-on text with inline ' - ' separators that marked cannot turn into real bullet lists. Reinforce a scannable bullet-point format via the injected user message (NOT the closed template), and make bullet vs. prose a user option. (2) QUESTION LABEL: the history entry's Q: label shows the ENTIRE them: turn instead of just the question — summaryService.js:451 passes `question: text` where text is the whole (often long, filler-laden) interviewer turn. Add a pure, unit-testable helper extractQuestion(text) that isolates the interrogative span (the sentence/clause carrying the question signal, reusing the same signals as isLikelyQuestion) and pass that as the question label, falling back to the full text when no clean question span is found. Both changes are additive and in-memory only (C8 holds); keep the FR-018/C6 pure-helper + thin-orchestrator + node:test convention; promptTemplates.js, the summary lane, and the summary-update channel stay untouched."

---

## ⚡ Quick Guidelines
- ✅ Focus on WHAT users need and WHY
- ❌ Avoid HOW to implement (no tech stack, APIs, code structure)
- 👥 Written for business stakeholders, not developers

> **Note on this spec's depth**: This is a focused, additive follow-on to the shipped **Interview Live Answer Lane** (`specs/2026-05-30-interview-live-answer/`). Because every integration point already exists in live code and the original spec locked an explicit CLOSED set, the requirements below carry implementation-level citations so `/plan` and `/implement` do not re-derive a wrong surface (e.g. editing the closed `promptTemplates.js`). The two improvements are independent and small; the load-bearing constraints are *where* the bullet reinforcement may live (the injected user message, not the template) and *how* the question label is extracted (a pure helper reusing the existing signals).

### Relationship to the original spec
- **Parent spec**: `specs/2026-05-30-interview-live-answer/spec.md` (the shipped Live Answer lane, including its 2026-06-01 newest-first history amendment).
- **Inherited constraints that still hold**: C7 (reuse `pickle_glass_analysis` UNCHANGED; `promptTemplates.js` stays closed), C8 (in-memory only; no DB persistence), C6/FR-018 (pure helpers + thin orchestrator; node:test, not Jest), FR-017 (purely additive; summary lane / `summary-update` / `SummaryView.js` / `askService.js` / `featureBridge.js` / `listenService.js` untouched).
- **What this spec changes**: only the **injected user message** string and the **question label value** in `summaryService.js`, plus a **new pure helper** and its **unit tests**. Nothing in the parent spec's locked decisions (D1–D4) or corrections (C1–C8) is re-litigated.

---

## System Context

**Systems**: Framework-internal — the `glass` Electron interview-assistant app. **No Cover Whale system involved.**
**Databases**: N/A — both changes are in-memory only; nothing is persisted to the session DB (the original spec's C8 holds; the `bullet_json` summary-lane column in `config/schema.js:57` belongs to the closed summary lane and is NOT touched).
**Integrations**: The existing LLM provider via the model-state config + streaming factory (one of OpenAI / Gemini / Anthropic / `openai-glass` / Ollama, selected by `modelStateService.getCurrentModelInfo('llm')`). No new integration; the answer is still produced by the same `makeLiveAnswer` streaming orchestrator (`summaryService.js:239`).
**Key Architecture**: The Live Answer lane is `summaryService.triggerAnswerIfNeeded → makeLiveAnswer` streaming a `pickle_glass_analysis` answer over the `live-answer-update` IPC channel into `<live-answer-view>` (a newest-first in-session history). (1) The streamed answer's *content shape* is influenced only by the system prompt (closed template) plus the **injected user message** (`summaryService.js:256-259`). (2) Each history entry's `Q:` label is the `question` field carried on `live-answer-update`; it is currently set to the raw `them:` turn at the single call site `summaryService.js:451` and rendered verbatim at `LiveAnswerView.js:345` behind a CSS `content: 'Q: '` prefix (`LiveAnswerView.js:148-149`).
**Documentation**: cw-documentation is not applicable (framework-internal change), and was unavailable at `~/coverwhale/cw-documentation/` during specification. Architecture is documented in-repo at `ARCHITECTURE.md`, the parent spec's `./design.md`, and `docs/LIVE_INSIGHTS_AND_ASK.md`.

*Framework-internal, no CW system involved.*

---

## Clarifications

### Session 2026-06-01

- **Q: How is "bullet vs. prose" exposed as a user option?** The codebase has **no existing user-preference store** for the answer lane — `summaryService` reads runtime config only via environment variables (e.g. `LIVE_ANSWER_DEBUG`, `summaryService.js:11`), and the original spec's FR-005 expressed its one optional knob (min-interval) as "configurable but OFF for v1." There is no settings UI seam wired to the answer lane, and the session/config DB is closed by C3/C8. → **A: [LOCKED D4] Bullets are ALWAYS-ON for v1 — NO toggle.** The injected user message unconditionally reinforces the headline+bullets structure; prose mode is not exposed. This is the smallest change that directly satisfies the readability goal and adds no config surface. A prose switch (env var or in-app control) is explicitly deferred to future work.
- **Q: Does the question label change require any renderer/UI edit?** → **A: No.** `LiveAnswerView.js:345` already renders `${a.question}` and the `Q: ` prefix is pure CSS (`LiveAnswerView.js:148-149`). Passing a cleaner `question` value at `summaryService.js:451` is sufficient; the view is untouched. (Recorded so `/plan` does not scope a UI change.)
- **Q: Does reinforcing bullets require editing the prompt template?** → **A: No (LOCKED D1).** `pickle_glass_analysis` (`promptTemplates.js:252-258`) ALREADY requests "Short headline answer (≤6 words) + Main points (1–2 bullets ≤15 words) + Sub-details." The template is CLOSED (original FR-006/FR-017). The fix reinforces that *existing* structure from the open **injected user message** only.

---

## User Scenarios & Testing *(mandatory)*

### Primary User Story

A candidate is in a live interview using the shipped Live Answer lane. Today, when the interviewer asks a question, the streamed answer often arrives as one dense run-on paragraph with inline " - " separators — hard to scan at a glance mid-interview — even though the underlying prompt asks for a headline plus bullets. Separately, the small "Q:" label above each answer in the history shows the **entire** interviewer turn (e.g. "Yeah so, um, I guess what I really wanted to ask, and take your time here, is how does garbage collection actually work in Go?") instead of just the question, making the history noisy and slow to skim.

With this change: (1) the streamed answer renders as a short headline plus real markdown bullet points the candidate can scan instantly, and (2) each history entry's "Q:" label shows just the question ("how does garbage collection actually work in Go?"), so the candidate can glance back over what was asked. Both improvements are additive — nothing else about the lane (triggering, PASSIVE suppression, newest-first history, the summary lane) changes.

### Acceptance Scenarios

1. **Given** the bullet format is always-on (v1) and the interviewer asks a multi-part technical question, **When** the answer streams in, **Then** it renders as a short headline followed by real markdown bullet list items (rendered by `marked` as `<ul><li>`), not a single run-on paragraph with inline " - " separators.
2. **Given** a question with a single, simple answer ("Is Go statically typed?"), **When** the answer streams in, **Then** it leads with the short headline answer and does NOT invent filler bullets to pad a trivial response (bullets appear only when there are real supporting points) — the always-on reinforcement structures real content, it does not fabricate it.
3. **Given** an interviewer turn that contains a clear question wrapped in filler ("Okay so, um, the thing I wanted to ask is — how would you design a rate limiter?"), **When** the answer is produced, **Then** the history entry's `Q:` label shows only the interrogative span ("how would you design a rate limiter?"), not the full filler-laden turn.
4. **Given** an interviewer turn that carries a question SIGNAL but has no cleanly isolatable interrogative span (e.g. a bare imperative cue "Walk me through your last project." with no wh-clause), **When** `extractQuestion` runs, **Then** it falls back to the full turn text as the label (never empty, never throws).
5. **Given** a turn whose question span is the whole sentence already (a clean "What is a closure?"), **When** `extractQuestion` runs, **Then** the label equals that sentence (no truncation or mangling).
6. **Given** the original Live Answer behaviors, **When** these two changes are applied, **Then** triggering/gating (`shouldTriggerAnswer`, `isLikelyQuestion`), PASSIVE suppression (`parseAnswerOrPassive`), the newest-first history, the de-dup/abort logic, and the summary lane all behave identically (purely additive — FR-017 of the parent spec still holds).
7. **Given** the model emits the PASSIVE sentinel for a non-question turn, **When** the bullet reinforcement is in the injected user message, **Then** PASSIVE suppression still fires unchanged (the bullet instruction never overrides the EXACT-`PASSIVE` directive; the panel holds the last answer).

### Edge Cases

- **Empty / whitespace / non-string turn passed to `extractQuestion`**: returns the input's safe fallback (empty string in → empty string out; non-string in → empty string), never throws — mirrors the defensive guards in `isLikelyQuestion` (`summaryService.js:59-61`).
- **Multiple questions in one turn** ("What's your name? And where are you based?"): `extractQuestion` returns a clean, non-empty interrogative span. Which clause is the by-design choice (first vs last) and MUST be pinned in tests; the parent lane already answers the most-recent question, so the label SHOULD prefer the last/most-recent interrogative clause for consistency.
- **Question signal is a cue, not a `?`** ("compare a process and a thread"): no `?` to anchor on; `extractQuestion` isolates the cue-bearing clause or falls back to the full text — never empty.
- **Bullet instruction vs. a genuinely one-line answer** ("Yes — Go is statically typed."): the headline-first structure still allows a short answer; the reinforcement asks for bullets *when there are supporting points*, it does not pad a trivial answer into fake bullets.
- **Answer already short / no supporting points**: the always-on bullet reinforcement asks for a headline plus bullets *when there are supporting points*; a one-line answer leads with the headline and is not padded into fake bullets (it never overrides correctness for the sake of structure).

---

## Requirements *(mandatory)*

### Functional Requirements

#### Improvement 1 — Readability (scannable bullet format)

- **FR-001**: The system MUST reinforce a scannable, bullet-point answer structure (a short headline followed by markdown bullet list items) by amending the **injected user message** in `makeLiveAnswer` (`summaryService.js:256-259`) — and ONLY there. The reinforcement MUST produce real markdown bullets (lines beginning with `- ` / `* ` on their own line) that the renderer's `marked` parser turns into an actual `<ul><li>` list, replacing today's dense run-on text with inline " - " separators.
- **FR-002** *(C1 — HIGH)*: The system MUST NOT modify `promptTemplates.js`. The `pickle_glass_analysis` template (`promptTemplates.js:238`, structure block `:252-258`) already requests "Short headline answer (≤6 words) + Main points (1–2 bullets ≤15 words) + Sub-details" and remains CLOSED per the parent spec's FR-006/FR-017. The bullet reinforcement is purely a restatement of that structure in the open injected user message.
- **FR-003**: The amended injected user message MUST preserve the existing PASSIVE directive in effect: if the transcript ends with no question directed at the candidate, the model's **entire** reply MUST still be exactly `PASSIVE`. The bullet instruction MUST be additive to — never a replacement of — the "reply EXACTLY: PASSIVE" directive (`summaryService.js:258`), so streaming-aware PASSIVE suppression (`parseAnswerOrPassive`, original FR-010) is unaffected.
- **FR-004** *(D4 — LOCKED)*: For v1 the bullet structure MUST be **always-on** — there is NO bullet-vs-prose toggle. The injected user message (FR-001) unconditionally reinforces the headline+bullets structure for every answer; prose mode is NOT exposed. This adds no configuration surface and honors C3/C8 (no DB persistence). *(A prose switch — env var like `LIVE_ANSWER_FORMAT=prose` mirroring `LIVE_ANSWER_DEBUG` at `summaryService.js:11`, or an in-app control — is explicitly deferred to future work; see Out of Scope.)*
- **FR-005**: The bullet reinforcement MUST NOT change the streaming mechanics, the two-arg `createStreamingLLM` call (original C1/FR-008), `maxTokens`, temperature, or the SSE consumption loop (`summaryService.js:280-379`). It changes only the *content* of the user message in the `messages` array (`summaryService.js:252-260`).

#### Improvement 2 — Question label (interrogative-span extraction)

- **FR-006** *(C2 — HIGH)*: The system MUST add a pure, directly unit-testable helper `extractQuestion(text)` that isolates the interrogative span (the sentence/clause carrying the question signal) from an interviewer turn. It MUST REUSE the same question signals already used by `isLikelyQuestion` (`summaryService.js:58-80`): the leading wh-word/auxiliary pattern `CLAUSE_LEAD_RE` (`:38`), the discourse-marker peeler `LEAD_STRIP_RE` (`:41`), the imperative/interview cue pattern `CONTENT_CUE_RE` (`:44`), and the embedded-question pattern `EMBEDDED_Q_RE` (`:55`). It MUST NOT introduce a new, divergent set of question signals.
- **FR-007**: `extractQuestion(text)` MUST fall back to the **full input text** (trimmed) when no clean interrogative span is found, and MUST return a safe empty string for empty/whitespace/non-string input — never `null`/`undefined`, never throw. It MUST be a pure function (no I/O, no service state) like the sibling helpers `isLikelyQuestion` / `normalizePassive` / `parseAnswerOrPassive` / `shouldTriggerAnswer` / `normalizeTail`.
- **FR-008** *(D3)*: The system MUST pass the extracted span as the history entry's question label by changing the single call site `summaryService.js:451` from `question: text` to `question: extractQuestion(text)`. No other call site, channel, or renderer code changes — the cleaner value flows to `LiveAnswerView.js:345` (rendered behind the CSS `Q: ` prefix at `:148-149`) with no UI edit.
- **FR-009**: `extractQuestion` MUST be exported from `summaryService.js` the same way as the existing pure helpers (`module.exports.extractQuestion = extractQuestion;`, alongside `:793-798`) so it is importable by the node:test suite without instantiating the service.

#### Independence & non-regression (inherited)

- **FR-010**: Both changes MUST be purely additive. `promptTemplates.js`, `makeOutlineAndRequests`, `triggerAnalysisIfNeeded`, the `summary-update` channel, `SummaryView.js`, `askService.js`, `featureBridge.js`, and `listenService.js` MUST NOT be modified (the parent spec's FR-017 / CLOSED set continues to hold). If the two changes were reverted, the Live Answer lane MUST behave exactly as it does today.
- **FR-011**: The changes MUST be in-memory only (parent C8). Neither the injected-message change nor the question-label change writes to the session DB, `summaryRepository`, or any config table.

#### Testability (inherited convention)

- **FR-012** *(C4 / parent C6/FR-018 — MED)*: `extractQuestion` MUST be covered by direct unit tests in the existing suite `src/features/listen/summary/__tests__/liveAnswer.test.js` using the Node built-in runner (`require('node:test')` + `require('node:assert/strict')`) per `package.json:15` (`node --test src/**/__tests__/**/*.test.js`) — **NOT Jest**. Tests MUST cover: a clean wh-question, a cue-only turn (fallback to full text), a filler-wrapped question (span isolated), multiple questions in one turn, and the empty/non-string guards. `makeLiveAnswer` remains a thin orchestrator; the bullet-format change is exercised via the existing mocked-stream integration tests (no live provider call) — at minimum a non-regression assertion that PASSIVE suppression and lane independence still hold with the amended message.

### Key Entities *(include if feature involves data)*

- **Injected user message** (transient, in-memory): the `{ role: 'user', content: ... }` element of the `messages` array passed to `createStreamingLLM(...).streamChat(messages)` in `makeLiveAnswer` (`summaryService.js:252-260`). This spec amends its `content` string (unconditionally — always-on bullet reinforcement, D4) and nothing else in the array.
- **Question label** (transient, in-memory): the `question` field on each `live-answer-update` payload and on each renderer history entry `{ id, question, text, ts }` (`LiveAnswerView.js:169,345`). This spec changes the *value* assigned at `summaryService.js:451` (from the raw turn to `extractQuestion(text)`); the field, channel, and renderer are unchanged.
- **`extractQuestion(text)`** (new pure helper): input is an interviewer turn string; output is the isolated interrogative span, or the trimmed full text when none is cleanly found, or `''` for empty/non-string input. No state, no I/O.

### External Dependencies & Risk Assessment *(mandatory)*

**External Dependencies**:
| Dependency | Type | Risk Level | Quota/Limits | Fallback Behavior |
|------------|------|------------|--------------|-------------------|
| Configured LLM provider (via `modelStateService` + `createStreamingLLM`) — already integrated by the parent feature | SDK/HTTP streaming | LOW | Unchanged by this spec — same per-question call volume, same `maxTokens=900`; the injected-message wording change does not increase call count or token budget | Unchanged — heuristic + PASSIVE + de-dup still cap call volume; no-model still no-ops cleanly (parent spec) |

**HIGH-RISK Dependency Checklist**: Not applicable — no new dependency is introduced. The LLM provider was already integrated and risk-assessed (MED) by the parent spec; this spec does not change *how* or *how often* it is called, only the wording of one user message and the value of one label. Net new risk is LOW.

**Cost note**: Neither change affects call frequency or token budget. The bullet instruction adds a few tokens to the (already small) injected user message; `maxTokens` is unchanged.

### Test Strategy *(mandatory)*

This follow-on's testable core is the new pure helper `extractQuestion`; the bullet-format change is a prompt-wording change verified by non-regression against the existing mocked-stream integration tests. Tests use the Node built-in runner only (FR-012 / parent FR-018), and the LLM is mocked (no live provider calls).

**Test Type Classification**:
| FR | Primary Test Type | Reason |
|----|-------------------|--------|
| FR-006 / FR-007 (extractQuestion) | Unit | Pure function truth-table: clean wh-question, cue-only fallback, filler-wrapped isolation, multi-question pick, empty/non-string guards |
| FR-008 (label wiring) | Unit/Integration | Assert the call site passes `extractQuestion(text)` (e.g. via the existing mocked-trigger integration harness asserting the emitted `question` field) |
| FR-001 / FR-003 / FR-004 (always-on bullet reinforcement + PASSIVE preserved) | Integration (mocked stream) | With the amended (always-on bullets) injected message: PASSIVE sentinel still suppresses (the bullet instruction never overrides EXACT-`PASSIVE`); a normal answer still streams/emits |
| FR-010 (independence) | Integration (mocked stream) | `summary-update` still fires on its 5-turn cadence; summary lane output unchanged |

**Distribution Estimate**:
- Feature type: [x] Mixed (a pure-logic helper + a prompt-wording change in the streaming shell)
- Unit: ~70% | Integration: ~25% | Contract: ~0% | E2E: ~0% | Static/Manual: ~5%
- Justification: The high-value new logic (`extractQuestion`) is pure and exhaustively unit-tested. The bullet-format change is wording-only and covered by non-regression assertions on the existing mocked-stream integration tests; the actual rendered-bullets appearance is verified by manual check (no automated Electron-renderer harness in this repo).

**HIGH-RISK API Warning**:
- [ ] Feature calls a quota-limited HIGH-RISK API → **No.** The LLM provider is mocked in all tests; no live provider calls are made.

**Estimated Test Count**: ~6–9 new/changed tests — ~5–6 `extractQuestion` unit cases plus ~1–3 integration assertions (label value emitted; PASSIVE-still-suppresses and lane-independence under the amended message). Existing parent-spec tests MUST continue to pass unchanged.

### Error Handling & Recovery *(mandatory if feature can fail)*

**Error Scenarios**:
| Error Scenario | Type | User Message | Recovery Action |
|----------------|------|--------------|-----------------|
| `extractQuestion` receives empty / non-string input | Permanent (guarded) | None (label simply empty or full-text) | Return `''` (non-string) or trimmed text; never throw |
| `extractQuestion` finds no clean interrogative span | Expected | None (label = full turn, as today) | Fall back to the full trimmed text |
| Model ignores bullet instruction and returns prose | Expected/Benign | None (answer still renders, just as prose) | No recovery needed — content still valid markdown; renderer handles either shape |
| Model returns PASSIVE under the amended message | Expected | None (silent — panel holds last answer) | Unchanged PASSIVE suppression (FR-003); bullet instruction never overrides the EXACT-PASSIVE directive |

**Error/Rescue Registry**:
| Method/Codepath | What Can Go Wrong | Exception Class | Rescued? | Rescue Action | User Sees |
|-----------------|-------------------|-----------------|----------|---------------|-----------|
| `extractQuestion(text)` | empty / non-string / no-span input | TypeError (guarded against) | Y | Defensive guards return `''` or trimmed full text | Clean label or full-turn label |
| `makeLiveAnswer` (amended message) | model returns PASSIVE / prose instead of bullets | — (not an error) | N/A | None — both are valid outputs | Bullets, prose, or held-last on PASSIVE |

*Note: This spec introduces no new throw sites. `extractQuestion` is total (defined for all inputs). The parent spec's stream-error/abort/no-model handling is unchanged.*

**Failure Modes Registry**:
| Codepath | Failure Mode | Rescued? | Test? | User Sees? | Logged? |
|----------|-------------|----------|-------|------------|---------|
| `extractQuestion` (no span) | fall back to full text | Y | Y (unit) | full-turn label | optional |
| `extractQuestion` (empty/non-string) | return `''` | Y | Y (unit) | empty label | optional |
| amended message → PASSIVE | suppress, hold last | Y | Y (integration) | last answer | optional |

*No row has `Rescued=N + Test=N + User Sees=Silent` — no critical gap.*

**Multi-Phase Operations**: Not applicable — a wording change plus a pure helper; no multi-step transaction.

**Resumability**:
- [ ] Operation can resume from last checkpoint? → No — answers remain transient (inherited).
- [ ] Backup/snapshot prevents data loss? → N/A (in-memory only, C3/C8).
- [x] Idempotency guaranteed? → `extractQuestion` is a pure function (same input → same output); the parent lane's de-dup is unchanged.

### UI/Design Reference *(mandatory)*

**Feature Classification**:
- [ ] Backend-only
- [x] **Minor UI** (no new components or layout; the streamed answer's content becomes scannable bullets via the existing `marked` renderer, and the existing `Q:` label receives a cleaner value — no `LiveAnswerView`/`ListenView` structural change) → Design reference optional
- [ ] Moderate UI
- [ ] Major UI

**Design Reference**:
- Figma/Mockup Source: Not applicable — no new component. The visual surface is the **existing** `<live-answer-view>` (`src/ui/listen/summary/LiveAnswerView.js`); improvement 1 makes its `.answer-body` render real `<ul><li>` markdown (already supported by the `marked`/`DOMPurify` path), and improvement 2 feeds its `.answer-question` label (`:345`, CSS `Q: ` prefix at `:148-149`) a cleaner string. No new view-mode, toggle, or layout.
- Design Component Name(s): `LiveAnswerView` (`<live-answer-view>`) — **read-only reference; not modified by this spec.**
- Mockup covers ALL functional requirements above: [x] Yes (no new UI surface; the requirements are a prompt-wording change + a label-value change rendered by existing components).

**Component Inventory Preview**:
```
Reused (unchanged):
- <live-answer-view> .answer-body: already renders sanitized markdown via marked/DOMPurify → will now show real <ul><li> bullets
- <live-answer-view> .answer-question (CSS "Q: " prefix): already renders ${a.question} → will now show the extracted span

New components: NONE (no renderer/UI files are modified)
```

### Permissions & Access Control *(mandatory)*

**Portal Placement**:
- [ ] Admin Portal
- [x] **Application Portal** — the `glass` desktop app overlay itself (same classification as the parent spec; there is no web portal).
- [ ] Public Portal

**Rationale for placement**: `glass` is a single-user local Electron application; this change lives entirely in the local process (a prompt-wording change and a pure helper). No server routes, roles, or multi-tenant scoping.

**Cross-Portal Considerations**: Not applicable — single Electron app, no cross-portal imports or routes.

**User Roles Affected**: Not applicable — single local user; no role system.

**Access Requirements**: Not applicable — no server-enforced capabilities.

**Data Scoping**:
- [x] User-scoped (single local user; conversation history and answers remain in-memory in the local process — C3/C8).

**Enforcement Strategy (screen-share safety — inherited, still load-bearing)**:
*This change adds no API/permission layer, but the parent spec's safety invariant continues to apply unchanged:*
- The Live Answer panel renders inside the **content-protected `listen` window** (`windowManager.js:507`; default `contentProtection: true` at `settingsService.js:217`). This spec does not touch window creation or content protection; the answer (now bulleted) and the cleaner `Q:` label still render only in the content-protected window. **The implementation MUST NOT render the answer in any non-content-protected window and MUST NOT disable content protection.**

### Architecture Context *(mandatory if feature has business logic)*

**Service Modules Required**:
| Service Name | Category | Responsibility | Reusable From |
|--------------|----------|----------------|---------------|
| `summaryService` (extended) | Business/Orchestration | NEW: pure helper `extractQuestion(text)` (reusing the existing signal regexes); amended injected user message in `makeLiveAnswer` (always-on bullet reinforcement, D4); change the question-label value at the `triggerAnswerIfNeeded` debounce call site | Fed by `listenService` (unchanged) |

**Architecture Validation**:
- [x] Additive-only: a new pure helper hangs off the existing helper block; the injected-message and label changes are in-place value edits at known lines; the summary lane is untouched (FR-010 / parent FR-017).
- [x] Reuses the existing question signals (`CLAUSE_LEAD_RE` / `LEAD_STRIP_RE` / `CONTENT_CUE_RE` / `EMBEDDED_Q_RE`) — no divergent heuristic (C2/FR-006).
- [x] Reuses the existing prompt (`pickle_glass_analysis`) and streaming path; `promptTemplates.js` stays closed (C1/C5/FR-002).
- [x] Pure logic separated from I/O for unit testing (C4 / parent C6/FR-018).
- [x] No renderer/UI edit — the cleaner label flows to the existing `<live-answer-view>` (D3/FR-008).

**Existing Services/Code to Reuse** *(prevents duplication)*:
| Existing Code | Location | Can Reuse For |
|------------------|----------|---------------|
| Question-signal regexes `CLAUSE_LEAD_RE` / `LEAD_STRIP_RE` / `CONTENT_CUE_RE` / `EMBEDDED_Q_RE` | `summaryService.js:38,41,44,55` | Implement `extractQuestion` by reusing the SAME signals as `isLikelyQuestion` (FR-006) |
| `isLikelyQuestion` defensive guards + clause-splitting pattern | `summaryService.js:58-80` (esp. `:69` `split(/[.!?;,\n]+/)` + `:71-72` peel loop) | Model `extractQuestion`'s clause iteration + empty/non-string guards on the same shape |
| Pure-helper export convention | `summaryService.js:793-798` | Export `extractQuestion` for the node:test suite |
| Injected user message array | `summaryService.js:252-260` | Amend the `user` message `content` (always-on bullet reinforcement, D4) — FR-001/FR-004 |
| Question-label call site | `summaryService.js:451` (`question: text`) | Change to `question: extractQuestion(text)` — FR-008 |
| Closed template structure block (read-only reference) | `promptTemplates.js:252-258` | Mirror its "headline + bullets" wording in the injected message WITHOUT editing the template — FR-002 |
| Renderer label + body (read-only reference) | `LiveAnswerView.js:148-149,345` | Confirm no UI edit needed (cleaner `question` value flows straight in) |
| `LIVE_ANSWER_DEBUG` env-var pattern | `summaryService.js:11` | Reference pattern ONLY for a FUTURE prose toggle (deferred per D4) — not added in v1 |
| Existing node:test suite | `src/features/listen/summary/__tests__/liveAnswer.test.js` | Add `extractQuestion` unit cases + non-regression integration assertions — FR-012 |

**Files**:
- **Additive/in-place edits**: `src/features/listen/summary/summaryService.js` (new pure helper `extractQuestion` + its export; amended injected user message in `makeLiveAnswer` with always-on bullet reinforcement (D4); change `question: text` → `question: extractQuestion(text)` at `:451`).
- **Test edits**: `src/features/listen/summary/__tests__/liveAnswer.test.js` (new `describe('extractQuestion', ...)` block + integration non-regression assertions).
- **Closed/untouched**: `promptTemplates.js`, `makeOutlineAndRequests`, the `summary-update` channel, `SummaryView.js`, `askService.js`, `featureBridge.js`, `listenService.js`, `LiveAnswerView.js`, `ListenView.js`, `preload.js` (the renderer/IPC plumbing from the parent spec needs no change).

---

## Out of Scope / Future Work

- **Prose mode + format toggle**: v1 is bullets-always (D4). Re-exposing a prose fallback — whether via an env var (`LIVE_ANSWER_FORMAT=prose`, mirroring `LIVE_ANSWER_DEBUG`) or a proper in-app settings control — is future work (consistent with how the parent FR-005 deferred a UI for its min-interval knob).
- **Template-level structure tuning**: any change to the `pickle_glass_analysis` headline/bullet wording itself belongs in a separate spec that re-opens `promptTemplates.js` — explicitly out of scope here (C1/C5).
- **Smarter multi-question handling**: richer parsing (e.g. answering and labelling several questions from one turn separately) is out of scope; `extractQuestion` returns a single span.
- **Persisting the cleaned question label / bulleted answer cross-session**: still gated by C3/C8 (in-memory only); cross-session DB persistence remains the parent spec's future work.

---

## Review Checklist (Gate)

- [x] No [NEEDS CLARIFICATION] markers remain — the sole open question (bullet-vs-prose surface/default) was resolved with the user on 2026-06-01 as bullets-always, no toggle (D4). All requirements are pinned to cited code.
- [x] Requirements are testable (each FR maps to a unit/integration test or an explicit non-regression/manual rationale)
- [x] Test strategy defined (Node built-in runner; LLM mocked; `extractQuestion` unit tests + mocked-stream non-regression)
- [x] Portal placement selected (Application Portal — the local Electron app surface)
- [x] Permissions defined — N/A for roles; the load-bearing constraint is the inherited content-protection screen-share guarantee
- [x] Data sensitivity classified — in-memory transcript/answer/label, single local user, not persisted (C3/C8); no Confidential/Restricted handling
- [x] External APIs identified (LLM provider — unchanged by this spec, LOW net-new risk, mocked in tests)
- [x] Error handling defined (`extractQuestion` total/guarded; PASSIVE preserved; prose-vs-bullets both valid)
- [x] UI complexity classified (Minor — no new components; existing renderer shows bullets + cleaner label)
- [x] Deprecation decision made — N/A; purely additive, deprecates nothing (FR-010)
- [x] Bug evidence — N/A; `critical_requirements.type` is `feature-minor`, not `bugfix` (the run-on-text symptom is documented in the Primary User Story and parent-spec context)

---

## Next Steps

- Review and refine this spec: `specs/2026-06-01-interview-live-answer-readability/spec.md`
- Clarification complete (Session 2026-06-01 — bullet-vs-prose resolved as bullets-always/no-toggle, D4). No open questions remain.
- Run `/plan` next.

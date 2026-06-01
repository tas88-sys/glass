# Phase 1 Data Model: Interview Live Answer — Readability

**Spec**: `specs/2026-06-01-interview-live-answer-readability/spec.md`
**Date**: 2026-06-01

> **No persistent data model.** Both changes are in-memory only (parent C8 / FR-011). Nothing is written to the session DB, `summaryRepository`, or any config table. There are no migrations, no schema changes, and no new tables/columns. The `bullet_json` column at `config/schema.js:57` belongs to the CLOSED summary lane and is explicitly NOT touched. The "entities" below are transient runtime values that already exist; this spec changes the *content/value* of two of them and adds one pure helper.

---

## E1. Injected user message (transient, in-memory) — *value amended*

The `{ role: 'user', content: string }` element of the `messages` array passed to `createStreamingLLM(...).streamChat(messages)` in `makeLiveAnswer` (`summaryService.js:252-260`).

| Field | Type | Today | After this spec |
|-------|------|-------|-----------------|
| `role` | `'user'` | unchanged | unchanged |
| `content` | `string` | "Answer the interviewer's most recent question directly and concisely. If there is no clear question or nothing useful to answer, reply EXACTLY: PASSIVE" | **amended**: adds an always-on instruction to format the answer as a short headline followed by markdown bullet points (`- `/`* ` on their own lines) *when there are supporting points*, while **preserving verbatim** the "reply EXACTLY: PASSIVE" directive (FR-003) |

**Invariants**:
- The EXACT-`PASSIVE` directive MUST remain (additive, never replaced) so `parseAnswerOrPassive` still suppresses non-questions (FR-003).
- The bullet instruction MUST NOT fabricate bullets for trivial answers (it asks for bullets *when there are supporting points* — Acceptance Scenario 2; Edge Cases "genuinely one-line answer").
- The rest of the `messages` array (the `system` prompt), `temperature: 0.7`, `maxTokens: 900`, the two-arg `createStreamingLLM` call, and the SSE loop are UNCHANGED (FR-005).

**Validation**: exercised via the existing mocked-stream integration tests — PASSIVE still suppresses, a normal answer still streams (FR-001/FR-003/FR-004).

---

## E2. Question label (transient, in-memory) — *value changed at one source*

The `question` field carried on each `live-answer-update` IPC payload and on each renderer history entry `{ id, question, text, ts }`.

| Field | Type | Today | After this spec |
|-------|------|-------|-----------------|
| `question` | `string` | the **raw** `them:` turn (`question: text` at `summaryService.js:451`) | the isolated interrogative span (`question: extractQuestion(text)`); falls back to the trimmed full turn when no clean span is found; `''` for empty/non-string |

**Flow (unchanged plumbing)**: set once at `summaryService.js:451` → rides on `live-answer-update` (`summaryService.js:344,357,377`) → rendered verbatim as `${a.question}` behind a pure-CSS `Q: ` prefix (`LiveAnswerView.js:148-149,345`). **No channel, payload-shape, or renderer change** (FR-008) — only the assigned value changes.

**Invariants**:
- Same field name, same channel, same payload shape, same renderer (D3/FR-008).
- Empty turn → empty label (renderer already guards: `${a.question ? ... : ''}` at `LiveAnswerView.js:345`).

---

## E3. `extractQuestion(text)` — NEW pure helper (no state, no I/O)

A sibling of `isLikelyQuestion` / `normalizePassive` / `parseAnswerOrPassive` / `shouldTriggerAnswer` / `normalizeTail`. Reuses the SAME question signals (`CLAUSE_LEAD_RE` `:38`, `LEAD_STRIP_RE` `:41`, `CONTENT_CUE_RE` `:44`, `EMBEDDED_Q_RE` `:55`) — MUST NOT introduce a divergent signal set (C2/FR-006).

**Signature**: `extractQuestion(text: string): string`

**Contract truth-table** (the authoritative behavior spec for the unit tests — FR-006/FR-007/FR-012):

| # | Input `text` | Output | Rule |
|---|--------------|--------|------|
| T1 | `"how does garbage collection actually work in Go?"` (clean wh-question, whole sentence) | the same sentence (trimmed), unmangled | clean span == whole input → return it (Acceptance Scenario 5) |
| T2 | `"Okay so, um, the thing I wanted to ask is — how would you design a rate limiter?"` (filler-wrapped) | `"how would you design a rate limiter?"` | split into clauses, peel `LEAD_STRIP_RE`, return the signal-bearing clause (Acceptance Scenario 3) |
| T3 | `"Walk me through your last project."` (bare imperative cue, no wh-clause) | the full trimmed turn | cue present but no isolatable wh-span → fall back to full text (Acceptance Scenario 4) |
| T4 | `"compare a process and a thread"` (cue, no `?`) | the cue-bearing clause, else full text | no `?` anchor; isolate cue clause or fall back; never empty (Edge Case "cue, not a `?`") |
| T5 | `"What's your name? And where are you based?"` (multiple questions) | `"where are you based?"` (LAST interrogative clause) | prefer the most-recent signal-bearing clause (RD5; lane answers the most-recent question) — **pinned in tests** |
| T6 | `""` / `"   "` (empty / whitespace) | `""` | empty/whitespace guard → `''` (Edge Case; mirrors `:60-61`) |
| T7 | `null` / `undefined` / non-string | `""` | non-string guard → `''` (mirrors `:59`); never throws |
| T8 | `"Yes — Go is statically typed."` (declarative, no signal) | the full trimmed text | no question signal → fall back to full text (total function) |

**Invariants**:
- **Total**: defined for every input; never `null`/`undefined`; never throws (FR-007).
- **Pure**: no I/O, no service state, deterministic (same input → same output) (FR-007; idempotency).
- **Non-empty for non-empty input**: a non-empty string in always yields a non-empty string out (span or full-text fallback).
- **Signal reuse**: uses only the four existing regexes + the existing clause-split/peel shape (`:69-73`); no new heuristic (C2/FR-006).
- **Multi-question pick is LAST clause** and MUST be pinned by test T5 (Edge Case "Multiple questions in one turn").

**Export**: `module.exports.extractQuestion = extractQuestion;` appended after `summaryService.js:798`, matching the existing pure-helper export block (FR-009).

---

## State transitions

None. `extractQuestion` is stateless. The injected message and label values have no lifecycle beyond a single answer's request/render (transient, in-memory; the parent lane's de-dup/abort/newest-first behavior is unchanged).

## Relationships

```
triggerAnswerIfNeeded (debounce, :420-464)
   └─ question label source: question: extractQuestion(text)   [E2 — :451]   ← NEW value
        └─ makeLiveAnswer(texts, signal, { id, question })      [:239]
             ├─ messages[1].content  [E1 — :256-259]            ← amended (always-on bullets, PASSIVE preserved)
             └─ live-answer-update { id, question, answer, ts } [:344,357,377]
                  └─ <live-answer-view>  ${a.question} / ${a.text}  [LiveAnswerView.js:345-346]  (CLOSED — no edit)

extractQuestion(text)  [E3 — pure helper, new]
   reuses → CLAUSE_LEAD_RE(:38) LEAD_STRIP_RE(:41) CONTENT_CUE_RE(:44) EMBEDDED_Q_RE(:55)
   mirrors → clause split/peel (:69-73), guards (:59-61)
   exported → module.exports.extractQuestion (after :798)
```

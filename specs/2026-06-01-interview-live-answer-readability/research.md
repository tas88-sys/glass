# Phase 0 Research: Interview Live Answer — Readability (Bullet Format + Question Label)

**Spec**: `specs/2026-06-01-interview-live-answer-readability/spec.md`
**Branch**: `2026-06-01-interview-live-answer-readability` (mainline `main`)
**Date**: 2026-06-01

This is a focused, additive follow-on to the shipped Live Answer lane (`specs/2026-05-30-interview-live-answer/`). Every integration point already exists in live code; the parent spec locked an explicit CLOSED set. Research below confirms the exact surfaces with pasted code evidence so `/plan` and `/implement` do not re-derive a wrong surface (e.g. editing the closed `promptTemplates.js`).

---

## Production Log & Error Evidence

**Skip condition met.** Spec front-matter is `critical_requirements.type: feature-minor` (NOT `bugfix`), and the input contains **no Cover Whale 12-digit `display_id`** (no `submission #<id>`, `display_id:`, `/transportation/<id>`, etc.). The `debug-cw` / SigNoz production-log gate does not apply to this framework-internal Electron change. No production logs to search; no Sentry project; no `config/logging.php` channel (this is not the PHP monolith).

`PREMISE L1: not-applicable — feature-minor, framework-internal glass Electron app, no CW display_id; the run-on-text symptom is a UX observation documented in the Primary User Story, not a production exception.`

---

## R1. Where the answer's content shape is decided (Improvement 1)

**Decision**: Reinforce the headline+bullets structure ONLY in the **injected user message** at `summaryService.js:256-259`. Do NOT touch `promptTemplates.js`.

**Evidence** — `summaryService.js:252-260` (the `messages` array passed to `createStreamingLLM(...).streamChat`):

```js
const messages = [
    { role: 'system', content: systemPrompt },          // <- closed pickle_glass_analysis template
    {
        role: 'user',
        content:
            'Answer the interviewer\'s most recent question directly and concisely. ' +
            'If there is no clear question or nothing useful to answer, reply EXACTLY: PASSIVE',
    },                                                   // <- THE ONLY OPEN SURFACE (this spec amends content)
];
```

**Evidence** — the closed template ALREADY requests the structure (`promptTemplates.js:252-258`, read-only reference):

```
<question_response_structure>
Always start with the direct answer, then provide supporting details following the response format:
- **Short headline answer** (≤6 words) - the actual answer to the question
- **Main points** (1-2 bullets with ≤15 words each) - core supporting details
- **Sub-details** - examples, metrics, specifics under each main point
- **Extended explanation** - additional context and details as needed
</question_response_structure>
```

**Rationale**: The template is CLOSED by the parent spec's FR-006/FR-017 (C1/C5 here). The system prompt already asks for headline+bullets, but the **injected user message does not reinforce it** — so the model frequently returns one dense run-on paragraph with inline " - " separators that `marked` cannot turn into a real `<ul><li>` list. Restating the structure in the open user message (the one surface this spec is allowed to edit) closes the gap with the smallest possible change. The amended message MUST keep the existing EXACT-`PASSIVE` directive intact and additive (FR-003) so streaming-aware PASSIVE suppression (`parseAnswerOrPassive`) is unaffected.

**Alternatives considered & rejected**:
- *Edit `promptTemplates.js` to strengthen the bullet wording* — REJECTED. Violates C1/C5/FR-002; the parent spec locked `pickle_glass_analysis` as CLOSED. The template is shared with the summary lane's analysis profile; editing it risks regressing the closed summary lane.
- *Post-process the streamed text into bullets in the renderer* — REJECTED. `LiveAnswerView.js` is in the CLOSED set (FR-010); a renderer transform would be a structural UI change and could mangle valid prose answers. The prompt-side reinforcement lets the model produce real markdown the existing `marked`/`DOMPurify` path already renders.
- *Add a `LIVE_ANSWER_FORMAT` env toggle now* — REJECTED for v1 (D4 LOCKED). No preference store is wired to the answer lane; bullets-always is the smallest change. Deferred to future work (Out of Scope).

**Rendering confirmation** — `.answer-body` is parsed by `marked` then sanitized by `DOMPurify` (`LiveAnswerView.js:300-325`), so real `- `/`* ` markdown lines become `<ul><li>` with no renderer edit. The `${a.text}` body and `${a.question}` label render verbatim (`LiveAnswerView.js:345-346`).

---

## R2. How the question label is currently set, and why a pure helper is the fix (Improvement 2)

**Decision**: Add a pure helper `extractQuestion(text)` that isolates the interrogative span by REUSING the existing question signals, and wire it at the single call site `summaryService.js:451` (`question: text` → `question: extractQuestion(text)`).

**Evidence** — the only call site that sets the label (`summaryService.js:451`):

```js
await this.makeLiveAnswer(this.conversationHistory, signal, { id: answerId, question: text });
```

`text` is the **whole** interviewer turn. It rides verbatim on every `live-answer-update` payload (`summaryService.js:344,357,377`) as the `question` field, then renders behind a pure-CSS `Q: ` prefix (`LiveAnswerView.js:148-149`) via `${a.question}` (`LiveAnswerView.js:345`). So a filler-laden turn ("Yeah so, um, I guess what I really wanted to ask … is how does garbage collection actually work in Go?") shows in full as the `Q:` label — noisy and slow to skim.

**Evidence** — the signals to REUSE already exist (`summaryService.js:38,41,44,55`):

| Regex | Line | Role |
|-------|------|------|
| `CLAUSE_LEAD_RE` | `:38` | wh-word / yes-no auxiliary leading a clause |
| `LEAD_STRIP_RE` | `:41` | peels leading discourse markers/fillers (`so`, `okay`, `um`, …) |
| `CONTENT_CUE_RE` | `:44` | imperative/interview cues (`tell me`, `compare`, `design`, …) |
| `EMBEDDED_Q_RE` | `:55` | indirect/embedded question (`the question is what …`) |

**Evidence** — the clause-splitting + peel pattern to mirror (`summaryService.js:69-73`, inside `isLikelyQuestion`):

```js
for (const clause of trimmed.split(/[.!?;,\n]+/)) {
    let c = clause.trim();
    let prev;
    do { prev = c; c = c.replace(LEAD_STRIP_RE, '').trim(); } while (c !== prev);
    if (CLAUSE_LEAD_RE.test(c)) return true;
}
```

`extractQuestion` reuses this clause iteration to *select* the interrogative clause (rather than returning a boolean): split into clauses, peel leading discourse markers, and return the clause that carries a signal (`?`, `CLAUSE_LEAD_RE` after peel, `CONTENT_CUE_RE`, or `EMBEDDED_Q_RE`); prefer the **last/most-recent** signal-bearing clause (consistency with the lane answering the most recent question — Edge Case "Multiple questions in one turn"); fall back to the trimmed full text when no clean span is found; return `''` for empty/non-string input.

**Evidence** — the defensive-guard shape to mirror (`summaryService.js:59-61`):

```js
function isLikelyQuestion(text) {
    if (typeof text !== 'string') return false;
    const trimmed = text.trim();
    if (trimmed.length === 0) return false;
```

`extractQuestion` mirrors these guards but returns `''` (string) instead of `false`, keeping it total (defined for all inputs, never throws — FR-007).

**Evidence** — the export convention to follow (`summaryService.js:792-798`):

```js
// Export pure helpers for unit testing (FR-018/C6).
module.exports.isLikelyQuestion = isLikelyQuestion;
module.exports.normalizePassive = normalizePassive;
module.exports.parseAnswerOrPassive = parseAnswerOrPassive;
module.exports.shouldTriggerAnswer = shouldTriggerAnswer;
module.exports.normalizeTail = normalizeTail;
module.exports.parseLiveAnswerSseLine = parseLiveAnswerSseLine;
```

`extractQuestion` is exported the same way (`module.exports.extractQuestion = extractQuestion;`) so the node:test suite imports it without instantiating the service.

**Rationale**: Reusing the existing signals (C2/FR-006) guarantees the label's notion of "what is the question" can never diverge from the lane's trigger gate (`isLikelyQuestion`). A divergent regex set would risk the label isolating a span the gate didn't consider a question (or vice-versa). The pure-helper + thin-orchestrator convention (parent C6/FR-018) keeps it directly unit-testable under `node:test`.

**Alternatives considered & rejected**:
- *Introduce an NLP/sentence-segmentation dependency* — REJECTED. Over-engineered for a label; adds a dependency and a divergent notion of "question". The existing regex signals already encode the lane's question definition.
- *Change the label at the renderer (truncate in `LiveAnswerView.js`)* — REJECTED. `LiveAnswerView.js` is CLOSED (FR-010); truncation is not extraction (it would clip mid-word and still show filler). The clean fix is feeding a better value at the single source.

---

## R3. Independence & non-regression (inherited)

**Decision**: Both changes are purely additive; the parent spec's CLOSED set holds.

**Evidence** — the baseline test suite is GREEN before any change:

```
$ node --test src/features/listen/summary/__tests__/liveAnswer.test.js
# tests 65
# suites 11
# pass 65
# fail 0
```

**CLOSED set (MUST NOT modify)** — `promptTemplates.js`, `makeOutlineAndRequests`, `triggerAnalysisIfNeeded`, the `summary-update` channel, `SummaryView.js`, `askService.js`, `featureBridge.js`, `listenService.js`, `LiveAnswerView.js`, `ListenView.js`, `preload.js`. If the two changes were reverted, the lane MUST behave exactly as today (FR-010 / parent FR-017).

**In-memory only (parent C8 / FR-011)**: neither change writes to the session DB, `summaryRepository`, or any config table. The `bullet_json` column in `config/schema.js:57` belongs to the CLOSED summary lane and is NOT touched.

**Rationale**: The change set is two in-place value edits (injected message string; one label argument) plus one new pure helper and its export. Nothing in the streaming mechanics, gating, PASSIVE suppression, de-dup/abort, or newest-first history is altered.

---

## R4. Testing strategy & runner

**Decision**: All tests use the Node built-in runner (`node --test`), NOT Jest. New `extractQuestion` unit cases + non-regression integration assertions go in the existing suite `src/features/listen/summary/__tests__/liveAnswer.test.js`.

**Evidence** — `package.json:15`:

```json
"test": "node --test src/**/__tests__/**/*.test.js",
```

**Evidence** — the existing suite's pure-helper test shape (`liveAnswer.test.js:223-227`, mirror for `extractQuestion`):

```js
describe('isLikelyQuestion (balanced, quota-aware question gate)', () => {
  let isLikelyQuestion;
  before(() => {
    ({ isLikelyQuestion } = require('../summaryService'));
  });
```

**Evidence** — the integration harness for non-regression (`liveAnswer.test.js:45-63`): a test-only subclass overrides `makeLiveAnswer` and captures `sendToRenderer`, so PASSIVE-suppress / lane-independence are exercised with NO live provider call (`liveAnswer.test.js:559` PASSIVE-suppress, `:611` lane-independence already exist and MUST still pass).

See **Testing Strategy** section in `plan.md` and the FR→test matrix in `spec.md`. No live provider calls; LLM is mocked everywhere.

---

## Consolidated Decisions

| ID | Decision | Rationale | Evidence |
|----|----------|-----------|----------|
| RD1 | Reinforce bullets in the injected user message (`summaryService.js:256-259`) only | Template is CLOSED (C1/C5); user message is the only open content surface | `summaryService.js:252-260`, `promptTemplates.js:252-258` |
| RD2 | Bullets always-on for v1, no toggle (D4) | Smallest change; no preference store wired to the lane; honors C3/C8 | spec Clarifications 2026-06-01 |
| RD3 | Keep EXACT-`PASSIVE` directive intact + additive (FR-003) | Streaming PASSIVE suppression (`parseAnswerOrPassive`) must be unaffected | `summaryService.js:258,288-379` |
| RD4 | New pure helper `extractQuestion(text)` reusing existing signals | Cannot diverge from the lane's question gate; directly unit-testable | `summaryService.js:38,41,44,55,69-73` |
| RD5 | Prefer the LAST signal-bearing clause for multi-question turns | Lane answers the most-recent question; label should match | spec Edge Cases |
| RD6 | Total/guarded helper: `''` for empty/non-string, full text fallback | Never throws, never null/undefined (FR-007) | mirrors `summaryService.js:59-61` |
| RD7 | Wire at single call site `:451`; export like the other helpers | One source of truth; importable by node:test (FR-008/FR-009) | `summaryService.js:451,792-798` |
| RD8 | Node built-in runner; LLM mocked; extend existing suite | Parent C6/FR-018 + `package.json:15`; reuse the integration subclass seam | `package.json:15`, `liveAnswer.test.js:45-63,223-227` |

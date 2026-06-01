# Preflight Report: Spec 2026-06-01-interview-live-answer-readability — Interview Live Answer — Readability (Bullet Format + Question Label)

**Generated**: 2026-06-01
**Status**: PASS
**Artifacts checked**: tasks.json, acceptance-tests.yaml, spec.md, plan.md, data-model.md, contracts/extractQuestion.contract.d.ts

## Summary

| Category | Critical | Warning | Info | Status |
|----------|----------|---------|------|--------|
| Schema Drift | 0 | 0 | 0 | PASS |
| Interface Assumptions | 0 | 0 | 0 | PASS |
| Dependency Chain | 0 | 0 | 0 | PASS |
| Enum/Value Mismatches | 0 | 0 | 0 | PASS |
| Operator Readability | 0 | 0 | 1 | PASS |
| Invariant Claims | 0 | 0 | 0 | PASS |
| **Total** | **0** | **0** | **1** | **PASS** |

## Findings

### Critical (0)

None.

### Warnings (0)

None.

### Informational (1)

#### [readability] SC-003 signal-regex check has a false-negative blind spot for non-`_RE`-named helper regexes

- **Artifact**: acceptance-tests.yaml -> structural_checks.SC-003.command
- **Expected**: SC-003 would detect any new regex used as a question signal in extractQuestion, whether or not it uses a `_RE` suffix convention
- **Found**: The check uses `const\s+[A-Z][A-Z0-9_]*_RE\b` to grep for new `*_RE` constants — it would pass silently if a divergent signal regex were introduced under a different name (e.g. `SPLIT_PAT`, `CUE_PATTERN`). The check cannot distinguish a legitimate clause-split helper from a new question-signal regex if the naming convention is not followed.
- **Fix**: Observation only — the four existing signals (`CLAUSE_LEAD_RE`, `LEAD_STRIP_RE`, `CONTENT_CUE_RE`, `EMBEDDED_Q_RE`) all follow the `_RE` suffix convention, and the task constraint note explicitly requires reusing them. The code-review gate (T-FINAL `code-review` check) provides the human-review backstop. No change to the acceptance test is required.

## Verification Notes

### Schema Drift
No database tables, columns, or relations are referenced in any artifact. `_references.tables: []` and `database_changes: false` are explicit. The `bullet_json` column is in the CLOSED summary lane and is not touched. No ORM schema reads were needed.

### Interface Assumptions
All referenced code surfaces verified against the live codebase:
- `createStreamingLLM(provider, opts)` — two-arg signature confirmed at `src/features/common/ai/factory.js:128`
- `getSystemPrompt('pickle_glass_analysis', '', false)` — confirmed at `src/features/common/prompts/promptBuilder.js:15`
- `promptTemplates.js:238` `pickle_glass_analysis` key — confirmed present
- `summaryService.js:451` `{ id: answerId, question: text }` call site — confirmed
- Export block at `summaryService.js:792-798` — confirmed (6 pure helpers exported; `extractQuestion` slot is ready to append)
- `LiveAnswerView.js:148-149` CSS `Q:` prefix — confirmed
- `LiveAnswerView.js:345` `${a.question}` render — confirmed
- `preload.js` `onSummaryUpdate` at line 210 — confirmed
- Integration test describe blocks at `:559` (PASSIVE-suppress) and `:611` (lane-independence) — confirmed
- `liveAnswer.test.js` uses `require('node:test')` and `require('node:assert/strict')` — confirmed

### Dependency Chain
Zero infrastructure changes. No EventBridge rules, CDK stacks, ECS task definitions, IAM policies, or SSM parameters planned. `_references.ecs_tasks: []` and `_references.routes: []`.

### Enum/Value Mismatches
All magic strings and sentinel values verified:
- `'reply EXACTLY: PASSIVE'` — present verbatim at `summaryService.js:258`
- `norm === 'PASSIVE'` detection in `parseAnswerOrPassive` — confirmed at line 121
- `live-answer-update` IPC channel — confirmed in `summaryService.js` and `preload.js:215`
- `summary-update` channel — confirmed at `preload.js:210`
- `temperature: 0.7` and `maxTokens: 900` — confirmed at lines 274-275

### Operator Readability
All 10 structural checks (SC-001 to SC-010), 7 negative assertions (NA-001 to NA-007), 4 test gates (TG-001 to TG-004), and 5 manual smoke tests (MST-001 to MST-SAFETY-001) were evaluated. All have clear descriptions, unambiguous pass/fail semantics, and actionable `on_failure` blocks. One info-level observation logged above (SC-003 false-negative blind spot — non-blocking).

### Invariant Claims
FR-003 is the primary preservation anchor (`preserve`, backtick token `summaryService.js:258`). Code at line 258 confirmed: `'If there is no clear question or nothing useful to answer, reply EXACTLY: PASSIVE'`. The spec's new artifact (bullet reinforcement in the injected message) is additive to this line; the preservation claim is accurate and the implementation constraint (T-P3.2 exit criteria) enforces it. `parseAnswerOrPassive` examines model output, not input messages — the preservation claim for this function is structurally sound. Zero mismatches.

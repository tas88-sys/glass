---
# Context Optimization Metadata
meta:
  spec_id: 2026-06-01-interview-live-answer-readability
  spec_name: interview-live-answer-readability
  phase: plan
  updated: 2026-06-01

summary:
  tech_stack: [JavaScript, Node.js (CommonJS), Electron, Lit (renderer), node:test]
  external_deps: [Configured LLM provider via modelStateService + createStreamingLLM (unchanged by this spec)]
  test_strategy: {unit: 70, integration: 25, contract: 0, e2e: 0, static_manual: 5}
  deployment: immediate
---

# Implementation Plan: Interview Live Answer — Readability (Bullet Format + Question Label)

**Branch**: `2026-06-01-interview-live-answer-readability` (mainline `main`) | **Date**: 2026-06-01 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/2026-06-01-interview-live-answer-readability/spec.md`

## Execution Flow (/plan command scope)

```
1. Load spec → Fill Technical Context → Constitution Check        ✔
2. Phase 0.1: Research + Testing Strategy (MANDATORY)             ✔ → research.md
3. Phase 0.2: Permissions (no roles/permissions in spec)         ⊘ SKIPPED
4. Phase 0.3: Integration Analysis (MANDATORY)                   ✔ + contracts/ tsc 0 errors
5. Phase 0.4: Design Pre-flight (Minor UI)                       ⊘ SKIPPED
6. Phase 0.5: Infrastructure (no env/migrations/deprecations)    ⊘ SKIPPED
7. Phase 0.6: Error/Rescue Mapping (service module w/ errors)    ✔
8. Phase 0.7: Implementation Timeline Risks (MANDATORY)          ✔
8b. Phase 0.7.5: Memory Re-Retrieval                             ✔ → Prior Lessons Applied
9. Phase 1: Design & Contracts → data-model.md, contracts/, quickstart.md  ✔
10. Plan Phase 2 approach (DO NOT create tasks.md)               ✔
11. STOP - Ready for /tasks command                              ✔
```

## Summary

Two additive, in-memory improvements to the shipped Live Answer lane (`specs/2026-05-30-interview-live-answer/`):

1. **Readability** — reinforce a scannable headline+bullets structure by amending ONLY the **injected user message** in `makeLiveAnswer` (`summaryService.js:256-259`), so the model returns real markdown bullets (rendered as `<ul><li>` by the existing `marked`/`DOMPurify` path) instead of dense run-on text with inline " - " separators. Bullets are **always-on** for v1 (D4 LOCKED — no toggle). The closed `pickle_glass_analysis` template already asks for headline+bullets (`promptTemplates.js:252-258`); this restates that structure on the only open content surface, and preserves the EXACT-`PASSIVE` directive verbatim (FR-003).
2. **Question label** — add a pure, total helper `extractQuestion(text)` that isolates the interrogative span by REUSING the existing question signals (`CLAUSE_LEAD_RE`/`LEAD_STRIP_RE`/`CONTENT_CUE_RE`/`EMBEDDED_Q_RE` at `summaryService.js:38,41,44,55`), wired at the single call site `summaryService.js:451` (`question: text` → `question: extractQuestion(text)`). The cleaner value flows verbatim to `<live-answer-view>`'s `Q:` label with no renderer edit (D3/FR-008).

**Technical approach**: three in-place edits in `summaryService.js` (amend message string; add+export pure helper; change one label argument) plus unit + non-regression tests in the existing `node:test` suite. Nothing else changes; the parent spec's CLOSED set holds (FR-010) and everything is in-memory (FR-011).

## Technical Context

**Language/Version**: JavaScript (Node.js 18+ / observed v22.12.0), CommonJS modules; Electron main process + Lit renderer.
**Primary Dependencies**: `electron`, `lit` (renderer web components), `marked` + `DOMPurify` (renderer markdown render — unchanged), the configured LLM provider via `modelStateService` + `createStreamingLLM` (unchanged).
**Storage**: N/A — in-memory only (parent C8 / FR-011). No DB, no migrations, no `summaryRepository`/config-table writes.
**Testing**: Node built-in runner — `node --test src/**/__tests__/**/*.test.js` (`package.json:15`). NOT Jest (parent C6/FR-018 / C4 here).
**Target Platform**: `glass` Electron desktop app (single local user).
**Project Type**: single (Electron app; existing `src/` tree).
**Performance Goals**: Unchanged — same per-question call volume, same `maxTokens=900`, same temperature 0.7. The bullet instruction adds a few tokens to one user message; no extra calls.
**Constraints**: Additive-only; CLOSED set (`promptTemplates.js`, summary lane, `summary-update`, `SummaryView.js`, `askService.js`, `featureBridge.js`, `listenService.js`, `LiveAnswerView.js`, `ListenView.js`, `preload.js`) untouched; in-memory only; bullets always-on (no toggle, D4); reuse existing question signals (no divergent heuristic); content-protected window only (inherited safety invariant).
**Scale/Scope**: 3 in-place edits + 1 new pure helper + ~6–9 tests, all in `summaryService.js` and its `__tests__/liveAnswer.test.js`.
**System Context**: Framework-internal — the `glass` Electron interview-assistant app. **No Cover Whale system involved.** No CW database; no CW integration.
**Architecture Docs Read**: `cw-documentation` is N/A (framework-internal; was unavailable at `~/coverwhale/cw-documentation/` during specification — confirmed not present). In-repo architecture consulted: the parent spec `specs/2026-05-30-interview-live-answer/spec.md` + `design.md`, and the live code surfaces enumerated in `research.md` (R1–R4). No `doc-search` system hit applies (no CW system named in the spec's System Context).

## Constitution Check
*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Test-First (NON-NEGOTIABLE) | PASS (planned) | TDD order pinned in `quickstart.md`: `extractQuestion` unit tests (T1–T8) authored RED before implementation; full suite green before commit. Baseline is 65/65 green. |
| II. Specification-Driven | PASS | `/specify` → `/clarify` (Session 2026-06-01) → `/plan` (this). `/tasks` next, then `/preflight` → (mainline `/implement`). |
| III. Verification Before Completion | PASS | Evidence pasted: baseline `# pass 65 # fail 0`; `tsc --noEmit` exit 0. /tasks will carry T-VERIFY gates. |
| IV. AI/ML (XAI) | N/A — see below | |
| V. Code Review Compliance | PASS (planned) | Additive, reuses existing patterns/signals, total/guarded helper, tests added — routed through review before commit. |

### AI & Machine Learning (Constitution Principle IV)

**Does this feature involve AI/ML?**
- [x] **No** — Skip this section.

*Rationale*: The feature does not add or modify an AI decision/model. It restates an already-requested output **format** in one user-message string and cleans a display **label** via a deterministic regex helper. The LLM call itself (provider, model, `maxTokens`, temperature, streaming) is unchanged from the parent feature, which already carried its own assessment. No new model output is interpreted, scored, or surfaced as a decision; `extractQuestion` is pure string logic, not ML. XAI transparency requirements do not attach to a prompt-wording + label-formatting change.

## Project Structure

### Documentation (this feature)
```
specs/2026-06-01-interview-live-answer-readability/
├── plan.md              # This file (/plan output)
├── spec.md              # Feature spec (input)
├── research.md          # Phase 0 output ✔
├── data-model.md        # Phase 1 output ✔ (transient entities + extractQuestion truth-table)
├── quickstart.md        # Phase 1 output ✔
├── contracts/           # Phase 1 output ✔
│   ├── extractQuestion.contract.d.ts
│   ├── extractQuestion.usage.ts
│   └── tsconfig.json    # tsc --noEmit -> 0 errors
└── tasks.md             # Phase 2 output (/tasks — NOT created by /plan)
```

### Source Code (repository root)
```
src/features/listen/summary/
├── summaryService.js                     # ALL THREE production edits live here:
│   ├── :38,41,44,55  CLAUSE_LEAD_RE / LEAD_STRIP_RE / CONTENT_CUE_RE / EMBEDDED_Q_RE  (REUSE — read-only)
│   ├── :58-80        isLikelyQuestion (clause split/peel :69-73, guards :59-61)        (mirror — read-only)
│   ├── ~:80          + extractQuestion(text)   NEW pure helper                          (EDIT — add)
│   ├── :256-259      injected user message content                                      (EDIT — amend)
│   ├── :451          question: text -> question: extractQuestion(text)                  (EDIT — change)
│   └── :798          + module.exports.extractQuestion = extractQuestion;                (EDIT — export)
└── __tests__/liveAnswer.test.js          # + describe('extractQuestion') T1–T8; + non-regression assertions

# CLOSED — DO NOT MODIFY (FR-010):
src/features/common/prompts/promptTemplates.js     (:238 pickle_glass_analysis; structure :252-258 — read-only reference)
src/ui/listen/summary/LiveAnswerView.js            (:148-149 CSS Q:; :345-346 render — read-only reference)
src/ui/listen/summary/SummaryView.js, ListenView.js
src/features/listen/summary  (makeOutlineAndRequests, triggerAnalysisIfNeeded, summary-update channel)
src/features/ask/askService.js, src/bridge/featureBridge.js, src/features/listen/listenService.js, preload
+ any DB/repository/config-schema file (in-memory only — FR-011)
```

**Structure Decision**: Single Electron project; no new directories or files in `src/`. All production logic is concentrated in the existing `summaryService.js`; tests extend the existing `liveAnswer.test.js`. The CLOSED set is enumerated above so the implementer never edits a forbidden surface.

## Phase 0.1: Research & Testing Strategy
*Status: COMPLETE → `research.md`*

### Production Log & Error Evidence

**Skip condition MET.** `critical_requirements.type: feature-minor` (NOT `bugfix`) AND no CW 12-digit `display_id` anywhere in the spec (no `submission #<id>`, `display_id:`, `/transportation/<id>`, etc. per `debug-cw` patterns). This is a framework-internal Electron change — no SigNoz/Sentry project, no `config/logging.php` channel applies. `debug-cw` is **correctly not invoked**.

`PREMISE L1: not-applicable — feature-minor, framework-internal glass Electron app, no CW display_id. The run-on-text symptom is a UX observation in the Primary User Story, not a production exception.` (Full premise in `research.md`.)

### Research

Consolidated in `research.md` (R1–R4, decisions RD1–RD8) with pasted code evidence:
- **R1** — bullet reinforcement belongs in the injected user message (`:256-259`) only; `promptTemplates.js:252-258` already requests the structure; rendering confirmed via `marked`/`DOMPurify` (`LiveAnswerView.js:300-325`).
- **R2** — `extractQuestion` reuses the four signal regexes + the clause-split/peel shape (`:69-73`) + guard shape (`:59-61`); wired at `:451`; exported after `:798`.
- **R3** — independence/non-regression; baseline suite green (65/65); CLOSED set + in-memory invariants restated.
- **R4** — Node built-in runner (`package.json:15`); existing pure-helper test shape + integration subclass seam to extend.

### Testing Strategy

| Check | Output |
|-------|--------|
| External APIs | Configured LLM provider (via `modelStateService` + `createStreamingLLM`) — **mocked in all tests**, no live calls → Risk: **LOW** (unchanged by this spec) |
| Test types | Unit (pure `extractQuestion` truth-table) + Integration (mocked-stream non-regression: PASSIVE-suppress, lane-independence, emitted `question` value) |
| E2E permitted? | No automated E2E (no Electron-renderer harness in this repo). The rendered-bullets appearance is a documented manual smoke check (`quickstart.md`). Not blocked by a HIGH-RISK API — the provider is mocked. |
| Mocking strategy | `createStreamingLLM` is replaced via the test-only `SummaryService` subclass seam that overrides `makeLiveAnswer` and captures `sendToRenderer` (`liveAnswer.test.js:45-63`); `extractQuestion` is pure → tested directly via `require('../summaryService')`. |

**Testing Summary**:
```
Feature type: Mixed (pure-logic helper + prompt-wording change in the streaming shell)
Quota risks: None — LLM mocked everywhere; no live provider calls
Estimated tests: ~6–9 new/changed (≈5–6 extractQuestion unit cases T1–T8 + 1–3 integration assertions); 65 baseline must stay green
Distribution: Unit ~70%, Contract ~0% (1 tsc gate, not a runtime test), Integration ~25%, E2E 0%, Static/Manual ~5%
```

**GATE**: No HIGH-RISK API in the test path (provider mocked) → E2E not forbidden but not used (no renderer harness). PASS.

## Phase 0.2: Permissions Design
*Status: SKIPPED — no roles/permissions.*

The spec's Permissions & Access Control section is N/A for roles: `glass` is a single-user local Electron app with no server routes, RBAC, or multi-tenant scoping. The **one** load-bearing access constraint is inherited and unchanged: the Live Answer panel renders only inside the **content-protected `listen` window** (`windowManager.js:507`, `contentProtection: true` at `settingsService.js:217`). This spec touches neither window creation nor content protection; it is restated as a non-regression invariant in `quickstart.md` and Phase 0.7 below (the bulleted answer + cleaner `Q:` label MUST NOT render in any non-content-protected window, and content protection MUST NOT be disabled).

## Phase 0.3: Integration Analysis
*Status: COMPLETE.*

### Codebase Pattern Discovery

| Pattern Area | Finding |
|--------------|---------|
| Pure-helper convention | Free functions at module top, exported at bottom via `module.exports.<name> = <name>` for `node:test` (`summaryService.js:792-798`). `extractQuestion` follows this exactly. |
| Defensive guards | `if (typeof text !== 'string') return <falsy>; const trimmed = text.trim(); if (!trimmed.length) return <falsy>;` (`:59-61`). `extractQuestion` mirrors it, returning `''`. |
| Question signals | Four shared regexes (`:38,41,44,55`) + clause split `/[.!?;,\n]+/` and discourse-marker peel loop (`:69-73`). REUSED, not re-derived. |
| Injected message shape | `messages = [{role:'system',...},{role:'user',content:...}]` (`:252-260`); only `content` of the user element is open to edit. |
| Label flow | `question` set once (`:451`) → rides on `live-answer-update` (`:344,357,377`) → `${a.question}` verbatim (`LiveAnswerView.js:345`). |
| Renderer markdown | `.answer-body` → `marked(text)` → `DOMPurify.sanitize` → `innerHTML` (`LiveAnswerView.js:300-325`); real `- ` lines become `<ul><li>` with no edit. |
| Test runner | `node --test` (`package.json:15`); `describe`/`it` + `before(() => ({ x } = require('../summaryService')))` (`liveAnswer.test.js:223-227`). |

### Data Contracts

| Entity | DB Format | "API"/IPC Format | UI Format |
|--------|-----------|------------------|-----------|
| Injected user message | N/A (transient) | `{role:'user', content:string}` (shape unchanged; content amended) | N/A |
| Question label | N/A (transient) | `question:string` on `live-answer-update` (value changed only) | `${a.question}` behind CSS `Q: ` prefix |
| `extractQuestion` | N/A | `(text:unknown)=>string` (pure) | feeds the label value |

### Code Interconnectedness Gate

| Pattern Needed | LSP/grep Result | Decision |
|----------------|-----------------|----------|
| Question signals for span isolation | `CLAUSE_LEAD_RE`/`LEAD_STRIP_RE`/`CONTENT_CUE_RE`/`EMBEDDED_Q_RE` defined at `summaryService.js:38,41,44,55`; used by `isLikelyQuestion` (`:63-73`) | **REUSE** (in-module; C2/FR-006 mandates same signals — zero duplication) |
| Clause split + peel | `trimmed.split(/[.!?;,\n]+/)` + `do{…replace(LEAD_STRIP_RE,'')…}while` (`:69-73`) | **REUSE shape** for clause selection |
| Empty/non-string guards | `:59-61` | **REUSE shape** (return `''`) |
| Pure-helper export | `module.exports.* = *` block (`:792-798`) | **EXTEND** (append `extractQuestion`) |
| Markdown render of bullets | `marked`+`DOMPurify` already wired (`LiveAnswerView.js:300-325`) | **REUSE** (no renderer edit) |
| Test harness (integration) | injectable `SummaryService` subclass seam (`liveAnswer.test.js:45-63`) | **REUSE** for non-regression assertions |

**Evidence**: line-cited above and pasted in `research.md`. The only NEW symbol is `extractQuestion`; everything else is reuse/extend. No DUPLICATE.

### Contract Validation

```bash
$ cd specs/2026-06-01-interview-live-answer-readability/contracts && npx tsc --noEmit -p tsconfig.json
EXIT=0     # (tsc prints nothing + exit 0 == Found 0 errors)
```

Contract files: `extractQuestion.contract.d.ts` (typed total contract for the new helper + read-only shapes for the injected message and `live-answer-update` payload), `extractQuestion.usage.ts` (exercises the contract incl. non-string guards), `tsconfig.json` (`strict`, `noEmit`).

**GATE**: LSP/grep reuse evidence pasted, contracts type-check (0 errors) → PASS.

## Phase 0.4: Design Pre-flight
*Status: SKIPPED — Minor UI.*

Spec UI classification is **Minor UI** (no new components/layout). No Figma. The visual surface is the **existing** `<live-answer-view>`: improvement 1 makes `.answer-body` render real `<ul><li>` (already supported by the `marked`/`DOMPurify` path), improvement 2 feeds `.answer-question` (CSS `Q: ` prefix) a cleaner string. No new view-mode, toggle, or layout; no design tokens introduced. Per the template skip condition (Backend-only/Minor UI), no `component-inventory.md` is produced.

## Phase 0.5: Infrastructure & Migrations
*Status: SKIPPED — no infra/migrations/deprecations.*

No env vars added (bullets always-on, D4 — a future `LIVE_ANSWER_FORMAT` env toggle is explicitly Out of Scope). No migrations (in-memory only — FR-011; the `bullet_json` column at `config/schema.js:57` is the CLOSED summary lane's and is not touched). No deprecations (purely additive — FR-010 deprecates nothing). No SSM, no deployment-order or rollout concerns beyond a normal app build/restart.

## Phase 0.6: Error/Rescue Mapping
*Status: COMPLETE — `summaryService` is a service module with error handling.*

This spec introduces **no new throw site**. `extractQuestion` is total (defined for all inputs). The parent lane's stream-error/abort/no-model handling is unchanged.

**Error/Rescue Registry**:
| Method/Codepath | What Can Go Wrong | Exception Class | Rescued? | Rescue Action | User Sees |
|-----------------|-------------------|-----------------|----------|---------------|-----------|
| `extractQuestion(text)` | empty / whitespace / non-string input | TypeError (guarded against — never thrown) | Y | Guards mirror `:59-61`: non-string→`''`, empty→`''` | Empty `Q:` label (renderer already guards `${a.question ? … : ''}`) |
| `extractQuestion(text)` | no clean interrogative span found | — (not an error) | N/A | Fall back to trimmed full text | Full-turn `Q:` label (as today) |
| `makeLiveAnswer` (amended message) | model returns PASSIVE under the new message | — (not an error) | N/A | Unchanged streaming PASSIVE suppression (`parseAnswerOrPassive`, `:288-379`); bullet instruction never overrides EXACT-`PASSIVE` (FR-003) | Panel holds last answer (silent) |
| `makeLiveAnswer` (amended message) | model returns prose instead of bullets | — (not an error) | N/A | None — prose is still valid markdown; `marked` renders it | Answer as prose (benign) |
| `makeLiveAnswer` stream error / abort / no-model | (inherited, unchanged) | Error | Y (parent) | Parent handling: abort swallowed (`:453-455`), stream error logged w/o answer text (`:457-459`), no-model throws before stream (`:264-266`) | Last answer retained / configuration error |

**Failure Modes Registry**:
| Codepath | Failure Mode | Rescued? | Test? | User Sees? | Logged? |
|----------|-------------|----------|-------|------------|---------|
| `extractQuestion` (no span) | fall back to full text | Y | Y (unit T3/T4/T8) | full-turn label | optional |
| `extractQuestion` (empty/non-string) | return `''` | Y | Y (unit T6/T7) | empty label | optional |
| amended message → PASSIVE | suppress, hold last | Y | Y (integration, `:559`) | last answer | optional (gated `laDebug`) |
| amended message → prose | render as prose | N/A (valid) | Y (integration non-regression) | prose answer | n/a |

**GATE**: Zero rows with `Rescued=N + Test=N + User Sees=Silent`. PASS — no critical silent-failure gap (`extractQuestion` is total + tested; PASSIVE path is rescued + tested).

## Phase 0.7: Implementation Timeline Risks
*Status: COMPLETE.*

| Phase | Anticipated Blocker | Resolution | Add to Task Context? |
|-------|--------------------|------------|---------------------|
| Foundations (helper) | Where to place `extractQuestion` and how to import the four regexes in a pure function | They are module-scope consts (`:38,41,44,55`) — define `extractQuestion` in the same module (near `isLikelyQuestion`, ~`:80`); no import needed. REUSE the clause split `/[.!?;,\n]+/` + peel loop (`:69-73`). | Y — task: implement helper |
| Foundations (helper) | Multi-question pick ambiguity (first vs last clause) | LOCKED RD5: prefer the **LAST** signal-bearing clause (lane answers the most-recent question). MUST be pinned by unit test T5. | Y — task: implement helper + T5 |
| Core logic (message) | Accidentally dropping/altering the EXACT-`PASSIVE` directive while editing the user message | FR-003: the bullet instruction is **additive**; keep "reply EXACTLY: PASSIVE" verbatim. Verified by the existing PASSIVE-suppress integration test (`:559`) still passing. | Y — task: amend message |
| Core logic (message) | Over-instructing the model to fabricate bullets for trivial answers | FR-001/Acceptance Scenario 2: phrase as "headline, then bullets **when there are supporting points**" — do not force bullets on one-line answers. | Y — task: amend message |
| Integration (wiring) | Touching a CLOSED file (`promptTemplates.js`, `LiveAnswerView.js`, summary lane) | FR-010 CLOSED set is enumerated in `plan.md`/`quickstart.md`. The only edits are 3 lines in `summaryService.js` + tests. Renderer needs NO change (D3 confirmed: `${a.question}` at `LiveAnswerView.js:345`). | Y — task: wire `:451` |
| Polish/tests | Forgetting the export → node:test can't import the helper | FR-009: append `module.exports.extractQuestion = extractQuestion;` after `:798`. Mirror `before(() => ({ extractQuestion } = require('../summaryService')))` (`:223-227`). | Y — task: tests |
| Polish/tests | Bullet appearance is not automatically verifiable (no renderer harness) | Documented manual smoke check in `quickstart.md`; automated coverage is the integration non-regression (PASSIVE/lane-independence/emitted-`question`). | Y — task: manual verify note |
| Cross-cutting | Rendering answer outside the content-protected window | Inherited safety invariant (Phase 0.2). This spec touches no window code; restate: MUST NOT render in a non-content-protected window, MUST NOT disable content protection. | Y — task context note |

## Decision Drivers

- **Smallest additive change** that satisfies both readability goals without re-opening any CLOSED file (parent FR-006/FR-017).
- **No divergent question heuristic** — the label's notion of "question" MUST equal the lane's gate (`isLikelyQuestion`), so `extractQuestion` reuses the same four signals (C2/FR-006).
- **In-memory only** — no config/DB surface (C3/C8/FR-011); bullets always-on, no preference store (D4).
- **PASSIVE invariant preserved** — the bullet instruction never overrides the EXACT-`PASSIVE` directive (FR-003).
- **Test-first** — pure helper exhaustively unit-tested (T1–T8); prompt-wording change covered by non-regression on the existing mocked-stream suite (parent C6/FR-018).

## Prior Lessons Applied

| Confidence | Lesson | Source | Applied How |
|------------|--------|--------|-------------|
| 0.80 | speckit-home-not-installed-locally: SpecKit commands in the glass repo fail `cw_assert_preconditions` because `~/.claude/specify` isn't installed — workaround `CW_SPECIFY_HOME=<repo>/.specify` (type: project) | `speckit-home-not-installed-locally.md` | Already applied to run this `/plan`: set `CW_SPECIFY_HOME=<repo>/.specify` for `setup-plan.sh` and `update-agent-context.sh`; `/tasks` and `/preflight` must do the same. Also heed the note that `update-agent-context.sh` is best-effort — it parsed the template plan and emitted a placeholder `CLAUDE.md`; do not treat that file as authoritative. |

*Phase 0.7.5 retrieval ran inline (not forked) against the richer plan-side surface (spec Overview + this plan's Summary/Technical Context) over `~/.claude/projects/C--Users-thiago-soeiro-Documents-repos-glass-glass/memory/` using the locked confidence components (threshold 0.55, top 5). Three other same-repo entries were scored and dropped below 0.55 as topically unrelated to a prompt-wording + pure-helper change: `stt-session-not-active-is-stopstart-race` (STT capture race / Deepgram reconnect) and `glass-prs-target-fork-not-upstream` (a `gh pr create` workflow lesson, not relevant at plan time) — neither shares the bullet-format / `extractQuestion` / `summaryService` Live Answer surface. Fail-open honored (FR-008): the memory dir exists and parsed cleanly.*

## Phase 1: Design & Contracts
*Status: COMPLETE.*

- **`data-model.md`** ✔ — no persistent model; three transient entities (E1 injected user message, E2 question label, E3 `extractQuestion`) with the authoritative `extractQuestion` truth-table (T1–T8) and invariants.
- **`contracts/`** ✔ — `extractQuestion.contract.d.ts` + `extractQuestion.usage.ts` + `tsconfig.json`; `tsc --noEmit` → 0 errors.
- **`quickstart.md`** ✔ — exact 3 edits + tests, TDD order, run commands, baseline (65/65), manual smoke check, definition of done.
- **Failing tests** — to be authored in `/implement` per TDD (RED first): the `extractQuestion` unit block (T1–T8) and the emitted-`question`/PASSIVE-preserved integration assertions. (Tests are written before the implementation per Constitution I; this plan pins their content via the truth-table.)
- **Agent file** — `update-agent-context.sh claude` ran best-effort (workaround `CW_SPECIFY_HOME`/`SPECIFY_FEATURE`); it parsed the template plan and produced only a placeholder `CLAUDE.md` (no useful tech extracted at copy-time). Non-blocking per the `speckit-home-not-installed-locally` lesson.

**Constitution re-check after design**: still PASS — no AI/ML surface added; additive-only; tests pinned; contracts validated; CLOSED set intact.

## Phase 2: Task Planning Approach
*Executed by /tasks command, NOT /plan.*

**Strategy**: Generate from Phase 1 docs (truth-table T1–T8, the 3 edit sites, the non-regression targets), constrained by the Phase 0.1 testing estimate (~6–9 tests, unit-heavy).

| From | Task Type | Order |
|------|-----------|-------|
| `data-model.md §E3` truth-table | Unit tests for `extractQuestion` (RED) [P] | 1st |
| `extractQuestion` contract | Implement + export the pure helper (GREEN) | 2nd |
| `summaryService.js:451` | Wire `question: extractQuestion(text)` | 3rd |
| `summaryService.js:256-259` | Amend injected user message (always-on bullets; preserve PASSIVE) | 4th |
| Acceptance Scenarios 1/3/6/7 | Integration non-regression: emitted `question` value; PASSIVE-suppress (`:559`) + lane-independence (`:611`) still green | 5th |
| `quickstart.md` smoke check | Manual verify (bullets render, clean `Q:`, PASSIVE holds, content-protected window) + T-VERIFY (unit/full-suite) | last |

**Constraints**: No E2E (no renderer harness); LLM mocked in every test (no live provider call); tests precede implementation (Constitution I); CLOSED-set files never edited.

**Estimated tasks**: ~7–9 (1 unit-test cluster, 1 helper-impl, 1 export, 1 wire, 1 message-amend, 1–3 integration assertions, 1 manual-verify/T-VERIFY).

## Progress Tracking

| Phase | Status | Skip If |
|-------|--------|---------|
| 0.1 Research + Testing | [x] COMPLETE | Never |
| 0.2 Permissions | [⊘] SKIPPED | No roles in spec ✓ |
| 0.3 Integration | [x] COMPLETE | Never |
| 0.4 Design Pre-flight | [⊘] SKIPPED | Backend-only/Minor UI ✓ (Minor UI) |
| 0.5 Infrastructure | [⊘] SKIPPED | No env/migrations/deprecations ✓ |
| 0.6 Error/Rescue Mapping | [x] COMPLETE | No service modules or no error handling |
| 0.7 Timeline Risks | [x] COMPLETE | Never |
| 0.7.5 Memory Re-Retrieval | [x] COMPLETE | (fail-open) |
| 1 Design & Contracts | [x] COMPLETE | - |
| 2 Task Planning | [x] APPROACH DOCUMENTED (tasks.md by /tasks) | - |

**Gates**: Constitution Check PASS (initial + post-design). All NEEDS CLARIFICATION resolved (Session 2026-06-01 — bullets-always/no-toggle, D4). Contract `tsc --noEmit` 0 errors. Baseline suite 65/65 green.

---
*Based on Constitution v2.1.1*

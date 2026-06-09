---
# Context Optimization Metadata
# Purpose: Enable efficient partial reads (~200 tokens vs ~2500 for full file)
meta:
  spec_id: 2026-06-08-listen-transcript-text-selection
  spec_name: listen-transcript-text-selection
  phase: plan            # Current phase in SpecKit workflow
  updated: 2026-06-08     # ISO date of last update

# Quick Reference (for checkpoint resume)
summary:
  tech_stack: [JavaScript (ES modules), Lit 2.7.4, Electron]
  external_deps: []      # none — internal CSS-only UI change
  test_strategy: {unit: 0, contract: 0, e2e_manual: 5}
  deployment: immediate  # ships with the next Glass desktop build
---

# Implementation Plan: Listen-Mode Transcript Free Text Selection

**Branch**: `2026-06-08-listen-transcript-text-selection` | **Date**: 2026-06-08 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/2026-06-08-listen-transcript-text-selection/spec.md`

## Execution Flow (/plan command scope)

```
1. Load spec → Fill Technical Context → Constitution Check          ✓
2. Phase 0.1: Research + Testing Strategy (MANDATORY)               ✓
3. Phase 0.2: Permissions (no server-side roles → trivial)         ✓ (N/A documented)
4. Phase 0.3: Integration Analysis (MANDATORY)                      ✓
5. Phase 0.4: Design Pre-flight (Minor UI → skip)                   ⏭ skipped
6. Phase 0.5: Infrastructure (no infra → skip)                      ⏭ skipped
7. Phase 0.6: Error/Rescue Mapping (no service modules → skip)      ⏭ skipped
8. Phase 0.7: Implementation Timeline Risks (MANDATORY)             ✓
9. Phase 1: Design & Contracts → data-model.md, contracts/, quickstart.md  ✓
10. Plan Phase 2 approach (DO NOT create tasks.md)                  ✓
11. STOP - Ready for /tasks command
```

**Note**: /plan stops at step 9. /tasks creates tasks.md, then implementation begins.

## Summary

Enable free mouse click-and-drag text selection within the listen-mode transcript so the
user can highlight and copy any portion of the transcript — matching the behavior the Ask
panel already provides — without being limited to the all-or-nothing "Copy transcript" button.

**Technical approach** (from research): The transcript is rendered by the `SttView` Lit
component (`src/ui/listen/stt/SttView.js`), which has its own Shadow DOM and is nested inside
`ListenView` as `<stt-view>`. `ListenView`'s `* { user-select: none; }` rule
(`ListenView.js:35`) computes a value that — because `user-select` is an **inherited** CSS
property — crosses the `<stt-view>` shadow-host boundary and renders transcript text
unselectable. The fix is a single scoped override placed **inside SttView's own `static
styles`**: `.transcription-container, .transcription-container * { user-select: text
!important; cursor: text !important; }`. This is byte-for-byte the same pattern AskView
(`AskView.js:105-108`) and ListenView's insights container (`ListenView.js:39-42`) already
use to defeat the same `user-select: none` rule. No JS, no new state, no CW backend.

## Technical Context

**Language/Version**: JavaScript (ES modules); Lit 2.7.4 (`assets/lit-core-2.7.4.min.js`)
**Primary Dependencies**: Lit (`LitElement`, `css`, `html`); Electron renderer (overlay window)
**Storage**: N/A — no persisted data; transcript lives in component state (`this.sttMessages`)
**Testing**: Manual / interactive verification in the running Glass app (no automated framework engaged for a CSS rule)
**Target Platform**: Electron desktop overlay (Glass app), cross-platform (macOS / Windows)
**Project Type**: single (Electron app with a Lit-based renderer UI under `src/ui/`)
**Performance Goals**: N/A — static CSS, no runtime cost
**Constraints**: Must not regress overlay window drag-to-move, click-through, or auto-scroll; change scoped strictly to the transcript content wrapper
**Scale/Scope**: 1 component (`SttView`), 1 CSS rule block (~4 lines) added to `static styles`
**System Context**: Framework-internal. No Cover Whale system, database, or integration is involved — this is a Glass desktop overlay UI-only change (per spec System Context). No `cw-documentation` paths apply because no CW system is cited.
**Architecture Docs Read**: None required — System Context cites no CW systems; all evidence is in-repo source (`SttView.js`, `AskView.js`, `ListenView.js`, `content.html`).

## Constitution Check
*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Assessment | Status |
|-----------|------------|--------|
| I. Test-First Development | Spec classifies this as 100% manual/E2E: a `user-select` CSS rule has no logic to unit-test (Test Strategy §). The TDD "Red" gate is satisfied by a documented failing manual scenario (transcript text is not selectable today) → apply override → manual "Green" (text selects). No automated test is meaningful or required; this mirrors how AskView/ListenView selection is validated. | PASS (justified deviation) |
| II. Specification-Driven Development | Following `/specify` → `/clarify` (session 2026-06-08) → `/plan` (this) → `/tasks`. No artifacts hand-authored. | PASS |
| III. Verification Before Completion | Quickstart defines explicit run-the-app verification steps with observable outcomes (select text, Cmd/Ctrl+C, paste). | PASS |
| IV. Skills Before Action | Memory-retrieval invoked inline (Phase 0.7.5). No AI/ML in feature → XAI section N/A. UI is Minor → design skills not required. Architecture decision is "mirror an existing locked pattern" → no heavy arch skill required. | PASS |
| V. Code Review Compliance | Single scoped CSS addition mirroring two existing in-repo precedents; no security surface, no new error paths. | PASS |

### AI & Machine Learning (Constitution Principle IV) *(if applicable)*

**Does this feature involve AI/ML?**
- [x] **No** - Skip this section

(The transcript content originates from STT upstream, but this feature changes only CSS
text-selectability of already-rendered text — it introduces no AI decision, inference, or output.)

## Project Structure

### Documentation (this feature)
```
specs/2026-06-08-listen-transcript-text-selection/
├── plan.md              # This file (/plan command output)
├── research.md          # Phase 0 output (/plan command)
├── data-model.md        # Phase 1 output (/plan command)
├── quickstart.md        # Phase 1 output (/plan command)
├── contracts/           # Phase 1 output (/plan command) — README documenting "no contracts"
└── tasks.md             # Phase 2 output (/tasks command - NOT created by /plan)
```

### Source Code (repository root)
```
src/ui/
├── listen/
│   ├── ListenView.js          # Host component; owns the `* { user-select: none }` rule (:35)
│   │                          # and the insights-container override precedent (:39-42);
│   │                          # owns the "Copy transcript" button (handleCopy :606-617)
│   └── stt/
│       └── SttView.js         # ← THE ONLY FILE CHANGED. Lit element, own Shadow DOM.
│                              #   static styles (:4-79) gets the scoped selection override.
│                              #   render() (:206) → .transcription-container (:212)
├── ask/
│   └── AskView.js             # Reference precedent only (:105-108) — NOT modified
└── app/
    └── content.html           # Host page — verified to contain no user-select rule (:87-89)
```

**Structure Decision**: Single Electron app with a Lit renderer UI under `src/ui/`. The entire
implementation is one CSS rule block added to `SttView.js`'s existing `static styles` template.
The override MUST live in `SttView`'s styles (not `ListenView`'s) because the blocking value is
*inherited into* SttView's shadow tree across the `<stt-view>` host boundary; an override in the
parent's shadow scope would not reach SttView's encapsulated content. No other files change.

## Phase 0.1: Research & Testing Strategy
*MANDATORY - Always execute this phase*

### Production Log & Error Evidence
*REQUIRED if spec front-matter `critical_requirements.type: bugfix` OR spec contains a CW-context 12-digit `display_id`*

**Skip condition met**: Spec front-matter is `critical_requirements.type: feature-minor` (NOT bugfix),
and the spec contains **no** Cover Whale 12-digit `display_id` (System Context: "Framework-internal,
no CW system involved"). The `debug-cw` / SigNoz production-log gate **does not apply**. No production
log search is performed because there is no production CW codepath, submission, or error to investigate —
this is a client-side CSS rendering behavior in the local Glass desktop overlay.

`PREMISE L1: not-applicable — feature-minor, zero CW display_ids, no production backend codepath touched. Gate skipped per documented skip condition.`

### Research

Research consolidated in [research.md](./research.md). Summary of decisions:

| # | Question | Decision | Rationale (evidence) |
|---|----------|----------|----------------------|
| R1 | What blocks selection today? | `ListenView`'s `* { user-select: none; }` (`ListenView.js:35`) inherits across the `<stt-view>` shadow-host boundary into SttView content. SttView itself has **no** `user-select` rule (`SttView.js:4-79`) and `content.html` has none (`:87-89`). | Verified by reading all three files. `user-select` is an inherited CSS property, so the parent shadow tree's computed value reaches the nested host element and inherits into the child shadow content. |
| R2 | What override re-enables it? | `.transcription-container, .transcription-container * { user-select: text !important; cursor: text !important; }` placed in `SttView`'s `static styles`. | Identical to AskView (`AskView.js:105-108`, `.response-container …`) and ListenView insights (`ListenView.js:39-42`, `.insights-container …`). Reusing the locked, proven pattern. |
| R3 | Where must the override live? | Inside `SttView.static styles` — NOT ListenView's. | Shadow-DOM encapsulation: a rule in ListenView's stylesheet cannot target SttView's encapsulated `.transcription-container`. The override must defeat the *inherited* value from inside SttView's own scope. |
| R4 | Does it regress the "Copy transcript" button? | No. | `ListenView.handleCopy()` (`:606-617`) calls `sttView.getTranscriptText()` (`SttView.js:191-193`), which maps over `this.sttMessages` JS state — wholly independent of DOM text selection or `user-select`. |
| R5 | Does it regress window drag / click-through? | No, when scoped to `.transcription-container` only. | The override does not touch `:host`, the overlay frame, or any draggable region; it changes only the transcript content wrapper. Edge case acknowledged in spec ("selection scoped to transcript content only"). |

### Testing Strategy

| Check | Output |
|-------|--------|
| External APIs | None → Risk: **LOW** (none) |
| Test types | Manual / E2E (visual interaction) only |
| E2E permitted? | Yes — no HIGH-RISK external APIs; manual interactive verification is the authoritative validation |
| Mocking strategy | None needed — no dependencies to mock |

**Testing Summary**:
```
Feature type: Frontend-heavy (CSS-only presentation change)
Quota risks: None
Estimated tests: 0 automated; ~5 manual verification steps (one per acceptance scenario)
Distribution: Unit 0%, Contract 0%, Integration 0%, E2E/Manual 100%
```

**Justification for 100% manual**: A scoped `user-select` / `cursor` CSS override has no
branching logic. Correctness is a rendered-DOM mouse-interaction behavior (drag-select, copy,
cursor style) confirmed by running the app — exactly how the equivalent AskView/ListenView
selection rules are validated. Per Constitution I, the "Red" state is the documented current
inability to select transcript text; "Green" is the manual confirmation after the override.

**GATE**: No HIGH-RISK APIs → E2E/manual permitted. PASS.

**Output**: research.md, Testing Strategy documented.

## Phase 0.2: Permissions Design
*CONDITIONAL*

The spec has a Permissions & Access Control section, but it documents the **trivial** case:
a single local desktop user, no server-side roles, no API surface, no permission gate. This is
a client-side CSS behavior available to whoever runs the Glass app locally. There is no
resource to gate, no dual-layer (API + UI) enforcement to design.

| Resource | Actions | Enforcement | Data Scope |
|----------|---------|-------------|------------|
| Transcript text (already rendered) | select, copy | None — client-side only, no server/API | User-scoped (the local user's own session) |

**GATE**: No multi-tenant/role enforcement applies → documented as N/A → proceed.

## Phase 0.3: Integration Analysis
*MANDATORY - Always execute this phase*

### Codebase Pattern Discovery

| Pattern Area | Finding |
|--------------|---------|
| Selection-enable CSS pattern | `user-select: text !important; cursor: text !important;` scoped to a container + its descendants. Used in AskView (`.response-container, .response-container *`, `AskView.js:105-108`) and ListenView (`.insights-container, .insights-container *, .markdown-content`, `ListenView.js:39-42`). |
| Selection-block CSS pattern | `* { … user-select: none; }` declared per-component in both `AskView.js:98-102` and `ListenView.js:32-36`. |
| Component encapsulation | Lit `LitElement` + Shadow DOM per component. `SttView` is `<stt-view>` nested in `ListenView` (`ListenView.js:721`). Styles are encapsulated; inheritance crosses host boundaries for inherited properties. |
| Transcript text export | `SttView.getTranscriptText()` maps `this.sttMessages` to `${speaker}: ${text}` joined by newline (`SttView.js:191-193`) — state-driven, DOM-selection-independent. |

### Data Contracts

No data contracts change. No DB, no API, no serialization format is touched. The component's
`sttMessages` array shape (`{ speaker, text }`) is unchanged. (See data-model.md.)

| Entity | DB Format | API Format | UI Format |
|--------|-----------|------------|-----------|
| Transcript message | N/A (not persisted) | N/A (no API) | `.stt-message.{me\|them}` bubble in `.transcription-container` |

### Code Interconnectedness Gate

Reuse decision (line evidence read and confirmed inline during planning):

| Pattern Needed | Evidence | Decision |
|----------------|----------|----------|
| Selection-enable CSS override | `AskView.js:105-108` and `ListenView.js:39-42` already implement the exact `user-select: text !important; cursor: text !important;` pattern against the same `user-select: none` blocker. | **REUSE** the pattern verbatim, applied to `SttView`'s `.transcription-container`. No new abstraction; mirror existing precedent. |
| Copy-transcript path | `ListenView.handleCopy()` → `SttView.getTranscriptText()` reads JS state. | **No change** — confirmed independent of `user-select`; FR-003 cannot regress. |

**Evidence**: Source lines read and confirmed during planning — `SttView.js:4-79,191-193,206-218`;
`AskView.js:98-108`; `ListenView.js:32-42,606-617`. No new interfaces introduced.

### Contract Validation (if new interfaces)

**Not applicable** — no new TypeScript/JS interfaces, no `contracts/*.ts` to type-check. The
`contracts/` directory contains a README documenting that this CSS-only change defines no
programmatic contract. (See contracts/README.md.)

**GATE**: Reuse verified with line evidence; no contracts to validate → proceed.

**Output**: Integration analysis documented, code reuse verified (REUSE existing pattern).

## Phase 0.4: Design Pre-flight
*CONDITIONAL - Skipped*

**Skip condition met**: Spec UI classification is **Minor UI** (`< 3 components, existing patterns only`).
No mockup required; reuses the existing selection-enabled appearance already present in the Ask panel.
No new visual design, no design tokens introduced, no component gaps. → Skipped.

## Phase 0.5: Infrastructure & Migrations
*CONDITIONAL - Skipped*

**Skip condition met**: No environment variables, no SSM, no database migrations, no deprecations.
The "Copy transcript" button is **retained** (nothing deprecated). → Skipped.

**Rollout**: Immediate — ships with the next Glass desktop build (no feature flag, no staged rollout
needed for a scoped CSS rule).

## Phase 0.6: Error/Rescue Mapping
*CONDITIONAL - Skipped*

**Skip condition met**: No service modules and no Error Handling / Error-Rescue Registry section in
the spec. A static `user-select` CSS rule has no runtime failure mode, no exceptions, no rescue path.
The spec's Review Checklist explicitly marks "Error handling defined" as N/A. → Skipped.

## Phase 0.7: Implementation Timeline Risks
*MANDATORY - Always execute this phase*

| Phase | Anticipated Blocker | Resolution | Add to Task Context? |
|-------|--------------------|------------|---------------------|
| Foundations | Implementer may try to add the override to `ListenView.js` (the file that declares the blocking rule) and find selection still broken. | The override MUST go in `SttView.js`'s `static styles`, because the value is *inherited into* SttView's encapsulated shadow tree — a parent-scope rule cannot reach `.transcription-container`. State this explicitly. | **Y** — implementation task. |
| Core | Implementer may scope the override too broadly (e.g. `:host` or `*`) and accidentally make non-content chrome selectable, or too narrowly (only `.stt-message`) and miss cross-bubble drag. | Use `.transcription-container, .transcription-container *` — matches AskView's `.response-container, .response-container *` shape and covers cross-bubble selection (edge case in spec). | **Y** — implementation task. |
| Integration | Worry that enabling selection regresses the "Copy transcript" button or window drag/click-through. | `getTranscriptText()` reads JS state (`SttView.js:191-193`), independent of selection — Copy cannot regress. The override is scoped to `.transcription-container` only; it does not touch the draggable frame or `:host`. Verify both in quickstart. | **Y** — verification task. |
| Polish/Tests | Streaming auto-scroll may interrupt an in-progress selection. | Spec accepts this for a one-off improvement; selection of already-rendered (finalized) text must work reliably. Do NOT attempt to suppress auto-scroll-during-selection — out of scope. | **Y** — note in verification task as accepted limitation; relates to the STT streaming lifecycle (see Prior Lessons Applied). |

**Output**: Timeline risks documented; four task-context fields flagged for /tasks.

## Prior Lessons Applied

| Confidence | Lesson | Source | Applied How |
|------------|--------|--------|-------------|
| 0.75 | stt-session-not-active-is-stopstart-race: Glass "STT session not active" errors are a Stop/Start capture-lifecycle race, not a Deepgram drop (type: project) | `stt-session-not-active-is-stopstart-race.md` | Same STT subsystem — `SttView` renders the STT transcript this lesson's `SttService` feeds. Informs the Phase 0.7 streaming edge case: the auto-scroll/streaming churn that can interrupt an in-progress selection is driven by this Stop/Start lifecycle, so keep selection scoped to already-finalized rendered text and explicitly do NOT touch the capture/streaming path (stays within the spec's frontend-only, no-STT-logic scope). |

*(Process-tooling memories `speckit-home-not-installed-locally.md` and `glass-prs-target-fork-not-upstream.md` scored below the 0.55 threshold against the feature/technical-approach query — only the bare repo name "glass" overlapped, with no symptom / keyword / name-desc≥2 match — and are excluded per the skill's threshold rule. The speckit-home lesson was nonetheless applied operationally to run this `/plan` via `CW_SPECIFY_HOME=<repo>/.specify`.)*

## Phase 1: Design & Contracts
*Prerequisites: Phases 0.1-0.7 complete (0.4/0.5/0.6 skipped per skip conditions)*

Artifacts generated:

1. **[data-model.md](./data-model.md)** — Documents the single (unchanged) UI entity: the
   transcript message. No new fields, no state transitions, no persistence. The only change is
   the CSS selectability of the already-rendered `.stt-message` text.

2. **[contracts/README.md](./contracts/README.md)** — Documents that this CSS-only change
   defines no programmatic contract (no API endpoint, no new interface). `tsc --noEmit` is N/A.

3. **[quickstart.md](./quickstart.md)** — Step-by-step manual verification mapping each
   acceptance scenario (FR-001…FR-005) to a run-the-app observation.

4. **Agent context update** — `update-agent-context.sh claude` is a best-effort CLAUDE.md
   convenience update; on this machine SpecKit home is not installed (known lesson) so it is
   safely skipped if it errors. No new tech stack is introduced (Lit/Electron already present).

**Output**: data-model.md, contracts/README.md, quickstart.md.

## Phase 2: Task Planning Approach
*Executed by /tasks command, NOT /plan*

**Strategy**: This is a one-file, ~4-line CSS change validated manually. Expect a minimal task set:

| From | Task Type | Order |
|------|-----------|-------|
| Research R2/R3 | Implementation: add scoped `user-select: text !important; cursor: text !important;` override to `SttView.static styles` targeting `.transcription-container, .transcription-container *` | 1st |
| Quickstart / Acceptance Scenarios | Manual verification (T-VERIFY-MANUAL): drag-select within a bubble, cross-bubble drag, Cmd/Ctrl+C copy, cursor style, Copy-transcript button still works, window drag/click-through unaffected | 2nd |

**Constraints**: No automated unit/contract/integration/E2E tasks (Phase 0.1 → 0% automated).
Verification is interactive per quickstart.md. No external-API mocking. Place the implementation
task with the four Phase 0.7 timeline-risk notes embedded in its context.

## Progress Tracking

| Phase | Status | Skip If |
|-------|--------|---------|
| 0.1 Research + Testing | [x] Complete | Never |
| 0.2 Permissions | [x] Complete (trivial/N/A) | No roles in spec |
| 0.3 Integration | [x] Complete | Never |
| 0.4 Design Pre-flight | [x] Skipped (Minor UI) | Backend-only/Minor UI |
| 0.5 Infrastructure | [x] Skipped (no infra) | No env/migrations/deprecations |
| 0.6 Error/Rescue Mapping | [x] Skipped (no service modules) | No service modules or no error handling |
| 0.7 Timeline Risks | [x] Complete | Never |
| 0.7.5 Memory Re-Retrieval | [x] Complete (1 lesson applied) | Never |
| 1 Design & Contracts | [x] Complete | - |
| 2 Task Planning | [x] Approach documented (tasks.md NOT created) | - |

**Gates**: Constitution Check PASS (Phase 0 + re-checked post Phase 1) · All NEEDS CLARIFICATION resolved (none remained) · Clarification gate PASS (session 2026-06-08) · Bugfix/SigNoz gate N/A (feature-minor, no display_id)

---
*Based on Constitution v2.1.1*

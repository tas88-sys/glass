---
# Context Optimization Metadata
# Purpose: Enable efficient partial reads (~200 tokens vs ~2500 for full file)
meta:
  spec_id: 2026-06-08-listen-transcript-text-selection
  spec_name: listen-transcript-text-selection
  status: draft          # draft | in-progress | approved | completed
  phase: tasks           # specify | clarify | plan | tasks | preflight | feature-start | implement | verify
  created: 2026-06-08    # ISO date
  updated: 2026-06-08    # ISO date  (clarify pass: all candidates auto-resolved)

# Quick Reference (for checkpoint resume)
summary:
  goals:
    - {id: G1, description: "Let users freely select any portion of the listen-mode transcript with the mouse so they can copy partial text", priority: HIGH}
  constraints:
    - {id: C1, description: "Frontend-only, scoped to the Glass Electron overlay UI — no JIRA or Cover Whale backend code touched", type: SCOPE}
    - {id: C2, description: "Reuse the existing user-select:text override pattern already used by AskView and ListenView", type: TECHNICAL}
    - {id: C3, description: "Selection must not break the click-through / drag behavior of the overlay window", type: TECHNICAL}
  decisions:
    - {id: D1, decision: "Add a user-select:text + cursor:text override scoped to the .transcription-container (and descendants) in SttView", rationale: "ListenView's '* { user-select: none }' inherits across the <stt-view> shadow-host boundary into SttView, disabling selection; AskView and ListenView already re-enable it for their response containers with 'user-select: text !important'. Mirror that exact pattern for the STT transcript. Evidence: AskView.js:105-108, ListenView.js:35,39-42, SttView.js:12,212."}

# CRITICAL REQUIREMENTS - Must verify during implementation
# These survive context compaction and generate T-VERIFY tasks
critical_requirements:
  type: feature-minor    # bugfix | feature-minor | feature-major | config | documentation | refactoring
  portal: app            # superadmin | admin | app | public | none
  ui_changes: minor      # none | minor | moderate | major
---

# Feature Specification: Listen-Mode Transcript Free Text Selection

**Feature Branch**: `2026-06-08-listen-transcript-text-selection`
**Created**: 2026-06-08
**Status**: Draft
**Input**: User description: "the ask panel allows selecting any text, so I can copy. But the listen mode transcript panel does not. I know there is the Copy transcript button, but that not what I want. I just want to be able to freely select any text with the mouse. not only the full transcript. no need to touch JIRA or any CW related code. This is a one off feature improvement"

---

## System Context

**Systems**: Framework-internal, no CW system involved. This is a change to the Glass desktop app's listen-mode overlay UI only.
**Databases**: N/A
**Integrations**: None — internal UI change.
**Key Architecture**: The listen-mode transcript is rendered by the `SttView` Lit component (`src/ui/listen/stt/SttView.js`), which displays speech-to-text messages as `.stt-message` bubbles inside a `.transcription-container`. `SttView` is a separate Lit element with its own Shadow DOM, nested inside `ListenView` (`ListenView.js:721` `<stt-view>`). `SttView`'s own styles contain no `user-select: none` rule, and the host page (`content.html`) has none either; the only blocking rule is `ListenView`'s `* { user-select: none; }` (`ListenView.js:35`). Because `user-select` is an inherited CSS property, it inherits from the `<stt-view>` host element (which lives in ListenView's shadow tree) down into SttView's shadow content, so transcript text is unselectable by default. The Ask panel (`AskView.js:105-108`) and the live-answer/insights panel (`ListenView.js:39-42`) each defeat this by re-declaring `user-select: text !important; cursor: text !important;` on their response containers. `SttView` has no such override, so its transcript text cannot be selected with the mouse.

---

## Clarifications

### Session 2026-06-08

All clarification candidates were auto-resolved from codebase evidence; no interactive questions were required.

- Q: What exact CSS override should re-enable selection? → A: [AUTO] `user-select: text !important; cursor: text !important;` — the identical pattern AskView and ListenView already use. Evidence: `src/ui/ask/AskView.js:105-108`, `src/ui/listen/ListenView.js:39-42`.
- Q: Which selector/container should the override target in SttView? → A: [AUTO] The `.transcription-container` content wrapper and its descendants (`.transcription-container, .transcription-container *`), mirroring AskView's `.response-container, .response-container *`. It is the sole transcript content wrapper. Evidence: `src/ui/listen/stt/SttView.js:12, 212`.
- Q: Will enabling selection regress the existing "Copy transcript" button? → A: [AUTO] No. The button reads transcript text from JS component state via `sttView.getTranscriptText()`, independent of any DOM text selection or `user-select` rule. Evidence: `src/ui/listen/ListenView.js:606-617`, `src/ui/listen/stt/SttView.js:191-193`.
- Q: What is the precise mechanism blocking selection today? → A: [AUTO] Not a single global rule reaching SttView directly. `SttView` has no `user-select: none` of its own and `content.html` has none; the block is `ListenView`'s `* { user-select: none }` inheriting (CSS `user-select` is inherited) across the `<stt-view>` shadow-host boundary into SttView's shadow content. The scoped `user-select: text !important` override defeats this, identical to how AskView/ListenView re-enable selection. Evidence: `src/ui/listen/ListenView.js:35`, `src/ui/listen/stt/SttView.js:4-79`, `src/ui/app/content.html:87-89`.

---

## User Scenarios & Testing *(mandatory)*

### Primary User Story
While running a live listen/transcription session, a user sees the running transcript in the listen-mode panel. They want to highlight an arbitrary phrase or sentence within the transcript with the mouse (click-and-drag) and copy just that portion — exactly the way they already can in the Ask panel — rather than being limited to the all-or-nothing "Copy transcript" button.

### Acceptance Scenarios
1. **Given** a listen session with transcript messages displayed, **When** the user clicks and drags across part of a transcript bubble, **Then** that text becomes highlighted (visually selected).
2. **Given** text is selected in the transcript panel, **When** the user copies (Cmd/Ctrl+C or context-menu copy), **Then** the selected text is placed on the system clipboard.
3. **Given** the user wants the whole transcript, **When** they use the existing "Copy transcript" button, **Then** that button continues to work unchanged.
4. **Given** the transcript panel shows text, **When** the user moves the mouse over selectable text, **Then** the cursor reflects a text/selection cursor (consistent with the Ask panel behavior).

### Edge Cases
- What happens when a selection spans multiple message bubbles (both "me" and "them")? The user should still be able to drag a selection across them; the copied text should contain the selected runs.
- What happens to selection while new transcript lines stream in and the panel auto-scrolls? Streaming updates may interrupt an in-progress selection; this is acceptable for a one-off improvement, but selection of already-rendered (finalized) text must work reliably.
- Does enabling text selection interfere with the overlay window's drag-to-move or click-through behavior? It must not — selection is scoped to the transcript content only.

## Requirements *(mandatory)*

### Functional Requirements
- **FR-001**: The listen-mode transcript panel MUST allow the user to select arbitrary text within the transcript using mouse click-and-drag.
- **FR-002**: Selected transcript text MUST be copyable to the system clipboard via the platform copy shortcut (Cmd/Ctrl+C) and/or context menu.
- **FR-003**: The existing "Copy transcript" (full-transcript) button MUST continue to function unchanged.
- **FR-004**: The selection cursor over transcript text MUST visually indicate selectability (text cursor), matching the Ask panel's behavior.
- **FR-005**: Enabling selection MUST NOT regress the overlay window's existing behaviors (window dragging, click-through, auto-scroll on new messages).
- **FR-006**: The change MUST be scoped to the listen-mode transcript view (`SttView`); it MUST NOT touch JIRA integration or any Cover Whale backend/business code.

### Key Entities
- **Transcript message**: A single STT line (`.stt-message`) attributed to a speaker ("me" or "them"), rendered inside the `.transcription-container`. The unit whose text must become selectable.

### Test Strategy *(mandatory)*

This is a CSS-only, frontend presentation change with no business logic and no external dependencies. Automated unit testing of a `user-select` CSS rule yields low value; the authoritative validation is manual verification in the running app.

**Test Type Classification**:
| FR | Primary Test Type | Reason |
|----|-------------------|--------|
| FR-001 | Manual / E2E (visual) | Mouse drag-selection is a browser/DOM behavior best confirmed by interaction |
| FR-002 | Manual (visual) | Clipboard copy of selected text confirmed interactively |
| FR-003 | Manual (visual) | Regression check that the Copy button still works |
| FR-004 | Manual (visual) | Cursor style confirmation |
| FR-005 | Manual (visual) | Regression check on window drag / click-through / auto-scroll |

**This Feature**:
- Feature type: [x] Frontend-heavy
- Unit: 0% | Integration: 0% | Contract: 0% | E2E/Manual: 100%
- Justification if deviating from standard ratios: A scoped `user-select`/`cursor` CSS override has no logic to unit-test; correctness is a rendered-DOM interaction validated by running the app and selecting/copying transcript text. This mirrors how the equivalent AskView/ListenView selection rules are validated.

**Estimated Test Count**: 0 automated; ~5 manual verification steps (one per acceptance scenario).

### UI/Design Reference *(mandatory)*

**Feature Classification**:
- [ ] **Backend-only** (no UI changes) → Skip design sections
- [x] **Minor UI** (< 3 components, existing patterns only) → Design reference optional
- [ ] **Moderate UI** (3-7 components, some custom work) → Mockup REQUIRED
- [ ] **Major UI** (8+ components, new views/pages, complex flows) → Mockup + Component Inventory REQUIRED

**Design Reference**:
- Figma/Mockup Source: Not applicable — no new visual design; reuses the existing selection-enabled appearance already present in the Ask panel.
- Design Component Name(s): `SttView` (`src/ui/listen/stt/SttView.js`)
- Mockup covers ALL functional requirements above: [x] Yes — no new layout; only selection/cursor behavior changes.

### Permissions & Access Control *(mandatory)*

**Portal Placement**:
- [ ] **Admin Portal** (`/admin/*`)
- [x] **Application Portal** — the listen-mode overlay is part of the core Glass desktop application surface available to the local user.
- [ ] **Public Portal** (`/`)

**Rationale for placement**: The transcript panel is rendered inside the application's listen-mode overlay. There is no multi-tenant/role concept for this desktop overlay; the feature is available to whoever is running the app locally.

**User Roles Affected**:
- [x] User (local desktop user — the only actor for this overlay)

**Access Requirements**:
| Capability | Roles Allowed | Notes |
|------------|---------------|-------|
| Select & copy transcript text | Local app user | No server-side permission; purely client-side UI behavior |

**Data Scoping**:
- [x] User-scoped (the transcript belongs to the local user's own session)

*Enforcement Strategy / API & UI permission tables: Not applicable — this is a client-side CSS behavior with no API surface and no permission gate.*

---

## Review Checklist (Gate)

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable
- [x] Test strategy defined
- [x] Portal placement selected (if applicable)
- [x] Permissions defined (if roles involved) — trivial: single local user, no gating
- [x] Data sensitivity classified (if handles data) — N/A, no new data; transcript already displayed
- [x] External APIs identified (if integrations) — none
- [x] Error handling defined (if can fail) — N/A, no failure modes for a CSS selection rule
- [x] UI complexity classified (if has UI) — Minor UI
- [x] Deprecation decision made (if replaces something) — nothing deprecated; Copy button retained
- [ ] Bug evidence captured — N/A (`type: feature-minor`, not a bugfix)

---

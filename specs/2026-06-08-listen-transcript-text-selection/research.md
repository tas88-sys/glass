# Phase 0 Research: Listen-Mode Transcript Free Text Selection

**Spec**: `2026-06-08-listen-transcript-text-selection`
**Date**: 2026-06-08

This research consolidates the technical findings that justify the implementation plan. All
findings were verified by reading the in-repo source during planning (no production system,
database, or external API is involved — see plan.md System Context).

---

## R1 — What blocks transcript selection today?

**Decision**: The blocking rule is `ListenView`'s global `* { … user-select: none; }`
(`src/ui/listen/ListenView.js:32-36`, with `user-select: none` at line 35), which reaches
`SttView`'s transcript content via **CSS inheritance across the shadow-host boundary**.

**Rationale / evidence**:
- `SttView` (`src/ui/listen/stt/SttView.js`) is a `LitElement` with its own Shadow DOM. Its
  `static styles` block (`SttView.js:4-79`) defines `.transcription-container`, `.stt-message`,
  scrollbar, and empty-state styles — but contains **no** `user-select` declaration of its own.
- The host page `content.html` (`src/ui/app/content.html:87-89`) likewise contains **no**
  `user-select` rule.
- `SttView` is nested as `<stt-view>` inside `ListenView` (`ListenView.js:721`). Because
  `user-select` is an **inherited** CSS property, the computed `none` value applied to
  ListenView's tree propagates to the `<stt-view>` host element and inherits down into
  SttView's encapsulated shadow content. Shadow-DOM encapsulation blocks *selector matching*
  across boundaries, but it does **not** block inheritance of inherited properties — so
  transcript text computes `user-select: none` and is unselectable.

**Alternatives considered**:
- *"A global rule in content.html reaches SttView directly"* — rejected; verified `content.html`
  has no such rule.
- *"SttView itself sets user-select: none"* — rejected; verified SttView's styles do not.

---

## R2 — What override re-enables selection, and is there precedent?

**Decision**: Add `.transcription-container, .transcription-container * { user-select: text
!important; cursor: text !important; }` to `SttView`'s `static styles`.

**Rationale / evidence** — this is the **exact established pattern** used twice already in the
same codebase to defeat the identical `user-select: none` blocker:
- **AskView** (`src/ui/ask/AskView.js:104-108`):
  ```css
  /* Allow text selection in assistant responses */
  .response-container, .response-container * {
      user-select: text !important;
      cursor: text !important;
  }
  ```
- **ListenView insights** (`src/ui/listen/ListenView.js:38-42`):
  ```css
  /* Allow text selection in insights responses */
  .insights-container, .insights-container *, .markdown-content {
      user-select: text !important;
      cursor: text !important;
  }
  ```
The SttView change mirrors AskView's `<container>, <container> *` shape exactly, substituting
`.transcription-container` (the sole transcript content wrapper, `SttView.js:12, 212`).

**Alternatives considered**:
- *Target only `.stt-message`* — rejected; would miss whitespace/gaps between bubbles and is
  narrower than the proven precedent. `.transcription-container *` covers all descendants and
  matches AskView's shape.
- *Use `user-select: text` without `!important`* — rejected; the blocking `* { user-select:
  none }` would win on specificity/cascade in the same scope. The precedents both use
  `!important`; mirror them.

---

## R3 — Where must the override physically live?

**Decision**: Inside `SttView`'s `static styles` — **not** ListenView's stylesheet.

**Rationale / evidence**: Shadow-DOM style encapsulation means a selector authored in
ListenView's `static styles` can only match elements in ListenView's own shadow tree; it cannot
match `.transcription-container`, which lives inside SttView's separate shadow tree. The only
way to override the *inherited* `user-select: none` value on SttView's content is a rule
authored within SttView's own scope. (This is also why ListenView's insights override at
`:39-42` works — `.insights-container` is in ListenView's own tree — and why that same rule
cannot reach the nested `<stt-view>`.)

---

## R4 — Does enabling selection regress the "Copy transcript" button? (FR-003)

**Decision**: No regression possible.

**Rationale / evidence**:
- `ListenView.handleCopy()` (`ListenView.js:606-617`) builds the clipboard text by calling
  `sttView.getTranscriptText()` when in transcript mode.
- `SttView.getTranscriptText()` (`SttView.js:191-193`) returns
  `this.sttMessages.map(msg => \`${msg.speaker}: ${msg.text}\`).join('\n')` — it reads
  **component state**, not the DOM selection. It is completely independent of any
  `user-select` CSS rule or active text selection.
- Therefore the Copy button's behavior is orthogonal to this change.

---

## R5 — Does enabling selection regress window drag / click-through / auto-scroll? (FR-005)

**Decision**: No regression, because the override is scoped to `.transcription-container` only.

**Rationale / evidence**:
- The override targets only the transcript content wrapper and its descendants. It does not
  modify `:host`, the overlay frame, any `-webkit-app-region: drag` region, or click-through
  configuration.
- Auto-scroll is driven by `SttView.updated()` → `scrollToBottom()` on `sttMessages` change
  (`SttView.js:195-204`), which is unaffected by `user-select`.
- **Accepted limitation** (from spec Edge Cases): when new lines stream in and the panel
  auto-scrolls, an *in-progress* drag-selection may be interrupted. This is acceptable for a
  one-off improvement; selection of already-rendered (finalized) text works reliably. We do NOT
  attempt to suppress auto-scroll-during-selection (out of scope, and it touches the STT
  streaming lifecycle — see plan.md "Prior Lessons Applied").

---

## Summary of Decisions

| ID | Decision | Confidence |
|----|----------|-----------|
| R1 | Blocker = ListenView `* { user-select: none }` inherited across `<stt-view>` shadow boundary | High (source-verified) |
| R2 | Override = `.transcription-container, .transcription-container * { user-select: text !important; cursor: text !important; }` | High (mirrors 2 precedents) |
| R3 | Override lives in `SttView.static styles` | High (shadow-DOM encapsulation) |
| R4 | "Copy transcript" cannot regress (state-driven) | High (source-verified) |
| R5 | Window drag / click-through / auto-scroll unaffected; mid-stream selection interruption is an accepted limitation | High |

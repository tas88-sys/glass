# Quickstart & Manual Verification: Listen-Mode Transcript Free Text Selection

**Spec**: `2026-06-08-listen-transcript-text-selection`
**Date**: 2026-06-08

This feature is validated **interactively in the running Glass app** (0 automated tests — a
scoped `user-select` CSS rule has no logic to unit-test; see plan.md Testing Strategy).

---

## The change (1 file)

In `src/ui/listen/stt/SttView.js`, add to the `static styles` template (alongside the existing
`.transcription-container` rules, before or after them):

```css
/* Allow free text selection of the transcript (mirrors AskView/ListenView) */
.transcription-container, .transcription-container * {
    user-select: text !important;
    cursor: text !important;
}
```

> **Why here and not ListenView?** The blocking `* { user-select: none }` lives in
> `ListenView.js:35` and reaches the transcript by CSS *inheritance* across the `<stt-view>`
> shadow-host boundary. A rule in ListenView's scope cannot match `.transcription-container`
> (it's in SttView's own Shadow DOM). The override must be authored inside SttView. See
> research.md R3.

---

## Run the app

```bash
npm start
```

Begin a listen / transcription session and let a few transcript lines appear (both "me" and
"them" bubbles if possible).

---

## Verification steps (one per acceptance scenario)

| # | FR | Action | Expected result |
|---|----|--------|-----------------|
| 1 | FR-001 | Click and drag the mouse across part of a single transcript bubble. | The text becomes visually highlighted (selected). |
| 2 | FR-001 (edge) | Drag a selection that spans **two** bubbles (a "me" and a "them"). | The selection extends across both; the highlighted runs are selectable. |
| 3 | FR-002 | With text selected, press Cmd+C (macOS) / Ctrl+C (Windows), then paste into a text editor. | The pasted text matches exactly the highlighted transcript portion. |
| 4 | FR-004 | Hover the mouse over transcript text. | The cursor shows the **text/I-beam** cursor (not the default arrow) — same as the Ask panel. |
| 5 | FR-003 | Click the existing **"Copy transcript"** button, then paste. | The **full** transcript is copied (`speaker: text` per line) — button works unchanged. |
| 6 | FR-005 | Try to drag the overlay window by its frame; confirm click-through still behaves; let new lines stream in and confirm auto-scroll still works. | Window drag, click-through, and auto-scroll are all unaffected. |

### Accepted limitation (spec Edge Cases)

While new lines stream in and the panel auto-scrolls, an **in-progress** drag-selection may be
interrupted. This is acceptable for this one-off improvement. Selection of already-rendered
(finalized) text must work reliably — that is what steps 1–3 confirm.

---

## Pass criteria

All six steps observe the Expected result. Steps 1–4 confirm the new selection behavior; steps
5–6 are regression checks (Copy button, window behaviors) that must be unchanged.

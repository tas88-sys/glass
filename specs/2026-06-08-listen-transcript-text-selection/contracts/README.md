# Contracts: Listen-Mode Transcript Free Text Selection

**Spec**: `2026-06-08-listen-transcript-text-selection`

## No programmatic contracts

This feature is a **CSS-only** change to a single Lit component (`SttView`). It defines:

- **No** HTTP/REST/GraphQL endpoint.
- **No** new TypeScript/JavaScript interface, type, or function signature.
- **No** IPC message, event, or serialization format.
- **No** change to any existing public method (`SttView.getTranscriptText()` is unchanged).

Therefore there are no contract files to type-check. The `tsc --noEmit` gate from the plan
template's Phase 0.3 Contract Validation step is **Not Applicable** — there is nothing to
compile.

## What changes instead

A single scoped CSS rule is added to `SttView`'s `static styles`:

```css
.transcription-container, .transcription-container * {
    user-select: text !important;
    cursor: text !important;
}
```

This mirrors the existing, proven precedent in `AskView.js:105-108`
(`.response-container, .response-container *`) and `ListenView.js:39-42`
(`.insights-container, .insights-container *, .markdown-content`).

Validation is therefore **interactive / manual** — see `../quickstart.md`.

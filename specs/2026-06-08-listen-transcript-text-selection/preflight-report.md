# Preflight Report: Spec 2026-06-08-listen-transcript-text-selection — listen-transcript-text-selection

**Generated**: 2026-06-08T00:00:00Z
**Status**: WARN
**Artifacts checked**: tasks.json, acceptance-tests.yaml, spec.md, plan.md, data-model.md, contracts/README.md

## Summary

| Category | Critical | Warning | Info | Status |
|----------|----------|---------|------|--------|
| Schema Drift | 0 | 0 | 0 | PASS |
| Interface Assumptions | 0 | 0 | 0 | PASS |
| Dependency Chain | 0 | 0 | 0 | PASS |
| Enum/Value Mismatches | 0 | 0 | 0 | PASS |
| Operator Readability | 0 | 1 | 0 | WARN |
| Invariant Claims | 0 | 1 | 0 | WARN |
| **Total** | **0** | **2** | **0** | **WARN** |

## Findings

### Critical (0)

None.

### Warnings (2)

#### [readability] AT-CLI-001 regex is dense and may produce ambiguous false-negative if CSS whitespace formatting varies
- **Artifact**: acceptance-tests.yaml -> cli_tests.AT-CLI-001.command
- **Expected**: A check that clearly distinguishes "override absent" from "override present but formatted differently"
- **Found**: A single-line regex `/\.transcription-container,\s*\.transcription-container\s*\*\s*\{[^}]*user-select:\s*text\s*!important;[^}]*cursor:\s*text\s*!important;[^}]*\}/` with no fallback diagnostic output. If the CSS template literal uses different whitespace (e.g., newlines between properties) the regex may not match even though the override is correct, and the operator sees exit code 1 with no explanation distinguishing "override missing" from "override formatted differently."
- **Fix**: Low urgency — the `on_failure` hints in the YAML already guide the operator to check selector and property spelling. No change required before `/feature-start`. Optionally add a second node -e check or a `expected_output_contains` field to disambiguate. The regex as written accommodates `[^}]*` between properties, so different whitespace between the two properties is already handled; however, the properties themselves must appear on the same line as the opening `{` because `[^}]` stops at `}`. If the implementer places the CSS block with each declaration on its own line (standard style), the regex would match. Mark as accepted for this one-file CSS change.

#### [invariant_violation] FR-003 uses "continues to" preservation anchor but has no backtick-quoted identifier to enable code-level verification
- **Artifact**: spec.md -> FR-003
- **Expected**: A backtick-quoted code identifier (e.g., `getTranscriptText()` or `SttView.js:191`) in the FR text, enabling automated code-location verification
- **Found**: FR-003 text: "The existing 'Copy transcript' (full-transcript) button MUST continue to function unchanged." — preservation anchor `continues to` matched but no backtick-quoted identifier present in the FR line.
- **Fix**: FR-007 fallback (extraction-ambiguous path): manual verification is required for this preservation claim. In practice, tasks.json T001 and acceptance-tests.yaml AT-CLI-003 already cover this: AT-CLI-003 verifies `getTranscriptText()` still reads `this.sttMessages`. No blocking action required before `/feature-start`. If desired for traceability, add `` `getTranscriptText()` `` to FR-003 text (e.g., "The existing 'Copy transcript' button, powered by `getTranscriptText()`, MUST continue to function unchanged.").

### Informational (0)

None.

## Codebase Verification Summary

All artifact line-number citations cross-checked against the live codebase:

| Artifact Claim | Source | Verified |
|---------------|--------|---------|
| `AskView.js:105-108` — `.response-container { user-select: text !important; cursor: text !important; }` | `src/ui/ask/AskView.js:105-108` | PASS |
| `ListenView.js:35` — `* { user-select: none; }` | `src/ui/listen/ListenView.js:35` | PASS |
| `ListenView.js:39-42` — `.insights-container … { user-select: text !important; cursor: text !important; }` | `src/ui/listen/ListenView.js:39-42` | PASS |
| `SttView.js:4-79` — `static styles` block | `src/ui/listen/stt/SttView.js:4-79` | PASS |
| `SttView.js:12` — `.transcription-container` defined | `src/ui/listen/stt/SttView.js:12` | PASS |
| `SttView.js:81-83` — `sttMessages: { type: Array }` property | `src/ui/listen/stt/SttView.js:81-82` | PASS (line 82, not 83) |
| `SttView.js:191-193` — `getTranscriptText()` reads `this.sttMessages` | `src/ui/listen/stt/SttView.js:191-193` | PASS |
| `SttView.js:206-218` — render() → `.transcription-container` | `src/ui/listen/stt/SttView.js:206-222` | PASS |
| `ListenView.js:606-617` — `handleCopy()` calls `sttView.getTranscriptText()` | `src/ui/listen/ListenView.js:606-617` | PASS |
| `ListenView.js:721` — `<stt-view>` element | `src/ui/listen/ListenView.js:721` | PASS |
| `SttView.js` has NO existing `user-select` override (claimed by spec) | `src/ui/listen/stt/SttView.js:4-79` | PASS — confirmed absent |

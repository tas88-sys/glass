# Preflight Report: 2026-05-25-ask-mode-shortcuts

**Generated**: 2026-05-25
**Status**: WARN
**Artifacts checked**: tasks.json, acceptance-tests.yaml, spec.md, plan.md, design.md

## Summary

| Category | Critical | Warning | Info | Status |
|----------|----------|---------|------|--------|
| Schema Drift | 0 | 0 | 0 | PASS |
| Interface Assumptions | 0 | 2 | 1 | WARN |
| Dependency Chain | 0 | 0 | 0 | PASS |
| Enum/Value Mismatches | 0 | 0 | 0 | PASS |
| Operator Readability | 0 | 2 | 0 | WARN |
| Invariant Claims | 0 | 1 | 0 | WARN |
| **Total** | **0** | **5** | **1** | **WARN** |

## Findings

### Critical (0)
None.

### Warnings (5)

#### [interface_assumption] W1: cancelHideModePicker IPC type conflict: send vs handle

- **Artifact**: tasks.json T-P2.4 + plan.md section 7 IPC contract table
- **Expected**: Mirror pattern cancel-hide-settings-window uses ipcMain.on in windowBridge.js:16. Plan section 7 marks this channel as direction=send with no reply.
- **Found**: T-P2.4 groups mainHeader:cancelHideModePicker with 5 other new ipcMain.handle handlers in featureBridge.js initialize(). Spec section 7.7 omits this channel entirely.
- **Fix**: Decide before T-P2.4: use ipcMain.on + ipcRenderer.send (matching cancel-hide-settings-window pattern in windowBridge.js) OR ipcMain.handle + ipcRenderer.invoke. Mismatching causes silent drop or runtime error.

#### [interface_assumption] W2: mode-picker.html load pattern diverges from all other feature windows

- **Artifact**: tasks.json T-P3.1 + spec.md section 7.2
- **Expected**: All feature windows load content.html with a query param. Header window uses header.html.
- **Found**: T-P3.4 and spec section 7.2 specify a dedicated src/ui/modePicker/mode-picker.html. commonChildOptions in windowManager.js does not include alwaysOnTop:true which must be overridden for the mode-picker.
- **Fix**: Awareness item for T-P3.1. Verify HTML bootstraps its own Lit module (no view-router from content.html). Verify preload path resolves from windowManager.js __dirname (src/window/), not from the HTML file location.

#### [readability] W3: NA-001 and NA-003 use exit-code-masking || echo pattern

- **Artifact**: acceptance-tests.yaml negative_assertions NA-001, NA-003
- **Expected**: Commands that distinguish clean grep (no match) from broken git invocation.
- **Found**: Both use: git diff main..HEAD -- FILE | grep ... || echo no-changes. The || fallback triggers on both empty grep AND command error, masking failures.
- **Fix**: Ensure expect.manual_review:true is honored. Operators must not auto-trust exit-0 from these checks without visual inspection of the command output.

#### [readability] W4: SC-013 click-ordering check cannot be fully verified by grep alone

- **Artifact**: acceptance-tests.yaml structural_checks SC-013
- **Expected**: A check that verifies await setAskMode appears before closeWindow in the same handler body.
- **Found**: Grep with -B2/-A4 context can false-positive if closeWindow appears nearby in a separate code path (e.g., blur listener) within the 4-line window. The note already acknowledges manual diff inspection is needed.
- **Fix**: Add manual_required:true to the check definition to prevent this check from being treated as automatable.

#### [invariant_violation] W5: spec section 2 E7 preservation claim uses Errata table format not FR-NNN line

- **Artifact**: spec.md section 2 Errata table row E7
- **Expected**: Preservation claims use FR-NNN format with backtick identifier for automated cross-referencing.
- **Found**: E7 records the pickle_glass_analysis preservation claim in an Errata table row. Manual verification confirms accuracy: promptTemplates.js:238 has the profile; tasks T-P1.1 and T-P1.2 do not touch existing keys.
- **Fix**: No action needed before feature-start. Manual review confirms accuracy. Future specs should prefer FR-NNN lines with backtick tokens for preservation claims.

### Informational (1)

#### [interface_assumption] I1: promptBuilder.js:16 interview fallback makes VALID_MODES coerce placement critical

- **Artifact**: spec.md section 8.1 + tasks.json T-P2.1
- **Expected**: getSystemPrompt at promptBuilder.js:16 falls back to profilePrompts.interview for unknown keys. Coerce must happen in askService BEFORE getSystemPrompt is called.
- **Found**: spec section 8.1 and T-P2.1 correctly place the VALID_MODES coerce in askService.sendMessage before calling getSystemPrompt. No code change needed.
- **Fix**: No fix needed. Informational note: the coerce must stay at the askService layer. If placed after getSystemPrompt, a bad askMode silently produces interview-profile TOPICS/QUESTIONS output.

## Status: WARN

0 critical findings, 5 warnings, 1 informational.
Proceed to /feature-start, then /implement.

Key decisions before or during implementation:
1. W1: Resolve cancelHideModePicker IPC type (ipcMain.on vs handle) before T-P2.4.
2. W2: Awareness for T-P3.1 implementer; no artifact change needed.
3. W3, W4: Readability issues; do not block implementation.
4. W5: Manual verification confirms accuracy; no action needed.
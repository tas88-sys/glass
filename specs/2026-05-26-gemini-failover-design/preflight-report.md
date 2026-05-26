# Preflight Report: Spec 2026-05-26-gemini-failover-design — Gemini Failover

**Generated**: 2026-05-26
**Status**: WARN
**Artifacts checked**: spec.md, plan.md, tasks.json, acceptance-tests.yaml

## Summary

| Category | Critical | Warning | Info | Status |
|----------|----------|---------|------|--------|
| Schema Drift | 0 | 0 | 0 | PASS |
| Interface Assumptions | 0 | 2 | 0 | WARN |
| Dependency Chain | 0 | 0 | 0 | PASS |
| Enum/Value Mismatches | 0 | 0 | 0 | PASS |
| Operator Readability | 0 | 1 | 0 | WARN |
| Invariant Claims | 0 | 0 | 0 | PASS |
| **Total** | **0** | **3** | **0** | **WARN** |

## Findings

### Critical (0)

None.

### Warnings (3)

#### [interface_assumption] AskView.onAskStateUpdate destructures specific fields — new fields will be silently dropped until T-P5.RENDERER lands

- **Artifact**: tasks.json -> T-P5.RENDERER.description
- **Expected**: `AskView.js:789-805` `onAskStateUpdate` assigns `this.responseModel = newState.responseModel` and `this.responseHadFallback = newState.responseHadFallback` (per spec §4 and tasks.json T-P5.RENDERER)
- **Found**: Current `AskView.js:789-805` only reads `currentResponse`, `currentQuestion`, `isLoading`, `isStreaming`, `showTextInput` from `newState`. The new fields are not yet destructured. The IPC pass-through in `preload.js:171` forwards the entire state object, so the fields will arrive — but `AskView` will silently ignore them until T-P5.RENDERER is implemented.
- **Fix**: This is expected pre-implementation state (T-P5.RENDERER is the task that wires this). No action needed before `/feature-start`. Document in implementation notes: T-P5.RENDERER must be completed before the footer is visible. Do not merge T-P4.2 without T-P5.RENDERER — the SSE consumer will broadcast `responseModel` and `responseHadFallback` but no renderer will display them, creating invisible state.

---

#### [interface_assumption] factory.js applies sanitizeModelId before CSV reaches gemini.js — streaming path may receive sanitized (potentially altered) CSV

- **Artifact**: spec.md -> "Clarifications / IMPL GAP — sanitizeModelId"
- **Expected**: `factory.js:136` calls `sanitizeModelId(opts.model)` before handing `opts` to `createStreamingLLM` in gemini.js. `sanitizeModelId` does `model.replace(/-glass$/, '')`. For a Gemini CSV like `"gemini-2.5-flash,gemini-2.5-flash-lite"` this regex does not match — so CSV passes through unchanged. The spec's impl-gap analysis is correct for current Gemini model IDs.
- **Found**: The spec correctly states this is safe. However, the claim holds only because current Gemini model IDs don't end in `-glass`. If a future model ID ends in `-glass` (e.g. a hypothetical `gemini-3-glass`), `sanitizeModelId` would strip the suffix from only the LAST entry in the CSV if that entry happened to end in `-glass`. The regex operates on the whole CSV string, not per-entry.
- **Fix**: Low risk for v1 (no current Gemini model ends in `-glass`). For robustness, note in T-P2.1 implementation comment that `parseModelList` must be called AFTER the CSV arrives in `gemini.js` (it already is per spec §3) — and that `sanitizeModelId` in factory.js operates on the whole CSV string. If future models use `-glass` suffix, factory.js's `sanitizeModelId` would need to be CSV-aware. No artifact change required now.

---

#### [readability] SC-006 grep count assertion could confuse operators — stdout_min compared to grep -cE line-count output

- **Artifact**: acceptance-tests.yaml -> structural_checks.SC-006
- **Expected**: `grep -cE "try\s*\{\s*controller\.error"` returns a line count (number of matching lines) as a plain integer string per-file. With two `controller.error()` call sites wrapped in try/catch, the expected count is 2.
- **Found**: `SC-006.expect.stdout_min: "2"` — the acceptance-tests.yaml specifies a minimum of `"2"`. This is semantically correct but the comparison mechanism is not defined. If the acceptance-tester does a simple string comparison of stdout, `"2"` would match. However, `grep -cE` on a file with 2 matching lines outputs `"2\n"` (with trailing newline), which may not match `"2"` depending on the runner's comparison logic. Additionally, if both try/catch blocks appear on the same line (e.g. `try { controller.error(err) } catch {} try { controller.error(err) } catch {}`), grep -cE counts lines not occurrences, so it would return `1` not `2`.
- **Fix**: In SC-006, change the command to count occurrences (not lines) using `grep -oE "try\s*\{[^}]*controller\.error" src/features/common/ai/providers/gemini.js | wc -l` and update `expect.stdout_min: "2"`. Or add a note: "Both controller.error() call sites must be on separate lines for this grep to count 2."

## Informational (0)

None.

---

## Readiness Assessment

**Status: WARN — 0 critical findings, 3 warnings. Implementation can proceed via `/feature-start`.**

All three warnings are pre-implementation observations, not blockers:

1. **Warning 1** (AskView field wiring): Expected state for pre-implementation preflight. T-P5.RENDERER is the task that adds the missing assignments. The task dependency chain in tasks.json already orders T-P4.2 before T-P5.RENDERER correctly.

2. **Warning 2** (sanitizeModelId CSV handling): The spec's analysis is correct for all current model IDs. A code comment in T-P2.1 is the recommended mitigation.

3. **Warning 3** (SC-006 readability): The structural check command may have ambiguous output comparison semantics. Consider fixing the acceptance-tests.yaml SC-006 command before implementation.

The implementation task graph (tasks.json) is correctly ordered and dependency-complete. No spec artifacts require amendment.

# Preflight Report: Spec 2026-05-30-improve-STT-sessions

**Generated**: 2026-05-30
**Status**: WARN
**Artifacts checked**: tasks.json, acceptance-tests.yaml, spec.md, data-model.md, contracts/stt-lifecycle.contracts.ts

## Summary

| Category | Critical | Warning | Info | Status |
|----------|----------|---------|------|--------|
| Schema Drift | 0 | 0 | 0 | PASS |
| Interface Assumptions | 0 | 2 | 0 | WARN |
| Dependency Chain | 0 | 0 | 0 | PASS |
| Enum/Value Mismatches | 0 | 1 | 0 | WARN |
| Operator Readability | 0 | 2 | 0 | WARN |
| Invariant Claims | 0 | 1 | 0 | WARN |
| **Total** | **0** | **6** | **0** | **WARN** |

## Findings

### Critical (0)

None.

### Warnings (6)

#### [interface_assumption] featureBridge.js IPC handlers destructure only {data, mimeType} — generation field will be silently stripped

- **Artifact**: tasks.json -> T-P2.3 / acceptance-tests.yaml -> AT-CLI-006
- **Expected**: src/bridge/featureBridge.js:149 — handler is `async (event, { data, mimeType }) => ...`; any `generation` field on the payload is discarded before reaching listenService. Same at line 150 for `listen:sendSystemAudio`.
- **Found**: FR-2.4 / T-P2.3 / AT-CLI-006 expect the optional `generation` field to be threaded through featureBridge.js (:149/:151) and preload.js (:305-306). preload.js:305 forwards the full object, but featureBridge.js:149 destructures only `{data, mimeType}`, losing `generation` before it reaches listenService.
- **Fix**: When implementing T-P2.3, change featureBridge.js:149 to `async (event, { data, mimeType, generation }) => await listenService.handleSendMicAudioContent(data, mimeType, generation)`. Apply the same change to line 150. Then update `handleSendMicAudioContent`, `listenService.sendMicAudioContent`, and `sttService.sendMicAudioContent` to accept and use the `generation` parameter.

#### [interface_assumption] deepgram.js createSTT has no openTimeoutMs parameter — FR-3.2 reduced timeout cannot be injected

- **Artifact**: contracts/stt-lifecycle.contracts.ts -> ReconnectPolicy / tasks.json T-P3.2
- **Expected**: src/features/common/ai/providers/deepgram.js:63-65 — timeout is hardcoded `10_000`; createSTT does not accept `openTimeoutMs` in its destructured opts.
- **Found**: FR-3.2 / ReconnectPolicy.openTimeoutMs: 5000 / T-P3.2 task requires reducing the Deepgram per-attempt open-timeout to 5000 ms during reconnect. The current createSTT function has no such parameter; the reconnect call site cannot inject it.
- **Fix**: When implementing T-P3.2, add `openTimeoutMs = 10_000` as a default-parameter in deepgram.js `createSTT({ ..., openTimeoutMs = 10_000 })` and replace the hardcoded `10_000` literal. Ensure factory.js `createSTT` passes the option through. The reconnect call site then passes `openTimeoutMs: 5000`.

#### [enum_mismatch] renewSessions reschedule-after-throw bug confirmed: re-arm setTimeout lives inside initializeSttSessions, not in a finally/catch in renewSessions

- **Artifact**: tasks.json -> T-P4.1 / T-P4.2
- **Expected**: sttService.js:483-491 — SESSION_RENEW_INTERVAL_MS re-arm setTimeout lives inside `initializeSttSessions`. renewSessions calls `await this.initializeSttSessions(language)` at line 533. If that throws, the re-arm was never reached. The wrapping catch (in the outer setTimeout callback at line 488-490) only logs — no retry is scheduled.
- **Found**: FR-4.2 / T-P4.1 describe this exact bug (plan: reschedule at :483-491 sits after the throw point). The fix must land in renewSessions. Risk: fixing this inside initializeSttSessions (shared with startup) would alter normal startup behavior — fix must be scoped to the renewSessions call site only.
- **Fix**: When implementing T-P4.1/T-P4.2, add the reschedule in a `finally/catch` wrapping `await this.initializeSttSessions(language)` inside `renewSessions` — not inside `initializeSttSessions` itself. This is consistent with the plan but warrants explicit attention during implementation.

#### [readability] AT-GATE-001 through AT-GATE-005 share identical command — no way to run a single AC in isolation from the manifest

- **Artifact**: acceptance-tests.yaml -> test_gates.AT-GATE-001..005
- **Expected**: Each gate should tell an operator how to re-run only that specific AC.
- **Found**: All five gates specify `command: node --test src/features/listen/stt/__tests__/sttService-lifecycle.test.js` — the full file. There is no per-gate isolation command.
- **Fix**: Add a `note` field to each gate, e.g. `note: "To run only AC-1: node --test --test-name-pattern 'AC-1' src/features/listen/stt/__tests__/sttService-lifecycle.test.js"`. Low urgency — node:test output identifies failing tests by name.

#### [readability] AT-NEG-004 expected_output_contains: [] is ambiguous when the grep command produces output

- **Artifact**: acceptance-tests.yaml -> negative_assertions.AT-NEG-004
- **Expected**: Clear pass condition for a grep that finds the two valid null-assignment lines (constructor + closeSessions) with exit 0 and non-empty output.
- **Found**: AT-NEG-004 sets `expected_output_contains: []` and `manual_verification: true`. The grep command returns the two valid null sites (exit 0, non-empty). An empty `expected_output_contains` with non-empty output is ambiguous — a test runner cannot determine pass/fail automatically.
- **Fix**: Set `expected_output_contains` to the two expected lines, or add `expected_line_count: 2` with a note: "Exactly 2 matches expected (constructor:25-26 + closeSessions:773/777). A 3rd match is a FAIL (new null-site = INV-1 violation)."

#### [invariant_violation] FR-1.2 equates IPC send-handlers with the macOS native-loop guard — but the macOS guard is a fire-and-forget try/catch with no return value

- **Artifact**: spec.md -> FR-1.2
- **Expected**: sttService.js:687-702 macOS native-loop guard: `if (this.theirSttSession) { try { await this.theirSttSession.sendRealtimeInput(payload); } catch (err) { console.error(...); } }` — no return value; it is a fire-and-forget callback inside a `stdout.on('data')` handler.
- **Found**: FR-1.2 states "Behavior must match the existing macOS guard semantics (`sttService.js:687`, `:699`)." The spec contracts define `SendAudioContent` returning `Promise<AudioSendResult>` with `{success: true, dropped: true}` — a return-value contract the macOS native-loop path does not have. An implementer who literally mirrors the macOS structure (try/catch, no return) would violate FR-1.3 (IPC `{success,error}` contract) and fail AT-GATE-001.
- **Fix**: No code change required — T-P1.2 and T-P1.3 task descriptions are correct. Add a clarifying note to FR-1.2 in spec.md: "matches the *intent* of the macOS guard (skip on null, no throw, no spam) not its *structure* — IPC send-handlers must return `AudioSendResult` per FR-1.3 and the `_createHandler` IPC contract."

### Informational (0)

None.

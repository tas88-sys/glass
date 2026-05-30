# Contract Edge Cases — STT Session Robustness

Edge cases the contracts in `stt-lifecycle.contracts.ts` must withstand, mapped to spec §8 and the
FRs/tests. Each row is a behavior the implementation MUST honor; the test column points at the AC.

| # | Edge case | Contract / invariant | Expected behavior | Test |
|---|---|---|---|---|
| E1 | **Late audio chunk after Stop** (renderer still streaming for ~hundreds of ms) | `AudioChunkPayload.generation` + INV-2 | Handler compares generation; stale ⇒ `{success:true, dropped:true}`, counter++. **No throw.** | AC-1, AC-2 |
| E2 | **Null session, chunk arrives** (sessions never came up / between init retries) | `SendAudioContent` resolves; FR-1.1 | Resolve benign, increment counter, throttled summary — never the old `throw new Error('… not active')`. | AC-1 |
| E3 | **Deliberate close (Stop / renewal hand-off)** = `{code:1000, reason:'client'}` | `isDeliberateClose` (D2), VAL-1 | **No reconnect.** This is normal operation; reconnecting would fight every Stop and every 20-min renewal. | AC-4 |
| E4 | **Involuntary drop** = e.g. `{code:1011}` or `{code:1006}` (abnormal) | `ReconnectState`, FR-3.2 | Reconnect that side only, same provider/model/handlers; backoff per `ReconnectPolicy`. | AC-4 |
| E5 | **Reconnect storm** (provider keeps 4xx/handshake-failing) | `ReconnectPolicy.maxAttempts=6` | Stop after 6 attempts → `status:'exhausted'` → visible status + one-click Resume; **no auto-restart**. | AC-8 (manual) |
| E6 | **Dead-but-non-null socket** (drop with no null) | `SttSessionWrapper.readyState`/`isOpen`, FR-3.1 | `isSessionActive()` returns **false** when `readyState !== 1 (OPEN)`, so `startCapture` precheck doesn't stream into a dead socket. | AC-5 |
| E7 | **Renewal partial failure** (one `createSTT` resolves, the other rejects) | FR-4.1 | The resolved socket's `close()` IS called (no leak); renewal retry scheduled (FR-4.2). | AC-3 |
| E8 | **Stop lands during a renewal `await`** | `isClosing` + INV-4 | In-flight renewal aborts; does NOT resurrect session pointers or re-arm timers. | AC-3 (extend) |
| E9 | **Stop during in-flight `startCapture`** (slow getUserMedia/AEC) | `captureToken` + INV-7 | The in-flight start sees a token mismatch before connecting ⇒ tears down what it built, connects nothing. | AC-6 (manual) |
| E10 | **Double Start** (second start before first finished) | INV-5/INV-6/INV-7 | Token advances; prior coroutine self-aborts; no orphaned processor; `stopCapture` later tears down ALL tracked resources. | AC-6 (manual) |
| E11 | **macOS native loop** (sends from main, not via IPC handlers) | INV-3 (already guarded `:687/:699`) | Generation logic must NOT double-guard or break the native path; it already skips-don't-crash. | AC-9 (manual) |
| E12 | **Linux** (mic-only; no `their` channel) | `SttSide` optionality | System-audio FRs inert; reconnect for `their` has no target ⇒ must no-op without crashing. | AC-9 (manual) |
| E13 | **`Done` without a preceding `Stop`** | FR-2.6, header state table | If reachable while capture live, route `Done` through the same teardown; else verified-safe. | manual + verification task |
| E14 | **App quit mid-reconnect / mid-renewal** | `before-quit` (index.js:244) | Teardown still completes cleanly (await guard); no dangling sockets/timers. | manual |
| E15 | **Generation field absent on payload** (older renderer build) | `AudioChunkPayload.generation?` optional | Treated as stale-safe default; never crashes the handler (additive contract). | AC-2 (extend) |
| E16 | **Atomic swap on reconnect success** | VAL-3, FR-3.3 | Assign new pointer first, then close the dead one — no transient null (INV-1), no two live sockets for one side. | AC-4 (extend) |

## Completeness checklist
- [x] Every new/changed shape in `stt-lifecycle.contracts.ts` has ≥1 edge case.
- [x] Every D2-critical path (deliberate vs involuntary close) is covered (E3, E4).
- [x] Every "silent drop" path keeps a visible counter/summary (E1, E2 → FR-0.3).
- [x] Platform regressions (macOS native, Linux mic-only) are listed (E11, E12).
- [x] Resurrection/leak races (renewal, reconnect, quit) are listed (E7, E8, E14, E16).
- [x] `tsc --noEmit --strict` passes on the contracts (exit 0; see quickstart.md §Contract validation).

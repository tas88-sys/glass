# Improve STT Session Robustness — Implementation Spec

**Branch (proposed):** `fix/stt-session-lifecycle`
**Source brief:** `specs/2026-05-30-improve-STT-sessions/prompt.md`
**Date:** 2026-05-30
**Status:** Awaiting user approval before implementation.
**Scope decision (user):** Full resilience, phased. Ship safe fixes now + add instrumentation to confirm the remainder.

---

## Confidence statement

I am **100% confident** in the *mechanism* of the pasted errors and **have direct log evidence** for the root cause:

- The errors `User/Their STT session not active` are the service's own null guards (`sttService.js:552`, `:577`). They fire **only** when `this.mySttSession` / `this.theirSttSession` are `null`.
- Those references are nulled in **exactly two** places: the constructor (`:25-26`) and `closeSessions()` (`:773`, `:777`). `initializeSttSessions()` only ever assigns truthy objects (`:469`). The Deepgram wrapper **never** nulls them on socket drop (`deepgram.js:84-92` only logs).
- The user's follow-up logs contain **`Their STT session closed: client`** and **`My STT session closed: client`** (the `onclose` reason from `ws.close(1000, 'client')`, `deepgram.js:72`) plus **`[SttService] Ignoring message - session already closed`** (fires only when `this.modelInfo === null`, set only in `closeSessions()` `:788`). **This proves the sockets were closed deliberately by the app (a Stop), not dropped by Deepgram/the network.**

**Therefore the confirmed root cause is a Stop/Start *capture-lifecycle race*:** the renderer keeps streaming audio for a few hundred ms after the user presses **Stop**, while the main process has already nulled the sessions. Every late chunk throws and is logged.

What I am **NOT** yet 100% confident about (and why Phase 0 instrumentation exists):
- Whether the **"transcription not working / intermittent"** complaint is *fully* explained by this race (boundary audio loss + orphaned-processor duplicate audio — see §3.3), or whether a **separate** intermittency exists. The pasted logs show **no** server-side drop (`client` close reason), so reconnect-on-drop is **resilience hardening, not a fix for the observed symptom**. Phase 0 will quantify boundary loss and detect orphaned processors before Phases 2–4 land.

---

## 1. Goal / Problem

**Problem (user, verbatim):** "My STT sessions are kind of flaky, several times transcribing not working or intermittent. I'm using Deepgram Nova-3." Accompanied by repeated `User/Their STT session not active` errors.

**Goal:** Make the Listen audio→STT pipeline robust against its own lifecycle transitions so that:
1. Normal **Stop/Start** (and `Done`) no longer produce `session not active` error spam or drop audio into closed sessions.
2. Repeated Stop/Start cycles cannot accumulate **orphaned audio processors** that double-send or send into dead sessions.
3. A genuinely **dropped** socket (network/provider, *not* a deliberate `client` close) self-heals without a manual Stop→Listen, **without** changing provider/model (the no-failover decision stays locked — see §4).
4. The **20-minute renewal** cannot leak sockets or silently lose its own re-scheduling on failure.

**Non-goal:** Cross-provider or cross-model STT failover. Explicitly out of scope per `docs/AUDIO_AND_STT.md §5` and `specs/2026-05-26-gemini-failover-design/spec.md` ("STT → single model, no failover").

---

## 2. Evidence

### 2.1 The error is a null-session guard, not a transport error
```
src/features/listen/stt/sttService.js
551  if (!this.mySttSession) {
552      throw new Error('User STT session not active');     // ← "Error sending user audio"
553  }
576  if (!this.theirSttSession) {
577      throw new Error('Their STT session not active');    // ← "Error sending system audio"
578  }
```
Caught + logged (non-fatal since commit `4882438`) at `sttService.js:71` (`handleSendSystemAudioContent`) and `listenService.js:280` (`_createHandler` wrapping `handleSendMicAudioContent`).

### 2.2 Only two code paths null the references
```
sttService.js:25-26   constructor: this.mySttSession = null; this.theirSttSession = null;
sttService.js:469     [this.mySttSession, this.theirSttSession] = await Promise.all([...])  // truthy only
sttService.js:773,777 closeSessions(): this.mySttSession = null; this.theirSttSession = null;
sttService.js:788     closeSessions(): this.modelInfo = null;
```
`renewSessions()` (`:518-545`) reassigns via `initializeSttSessions`; during its `await Promise.all(...)` the **old** non-null sessions remain assigned, so **renewal never produces a null window.** (Verified.)

### 2.3 The Deepgram wrapper never nulls on drop — proves the error ≠ a drop
```
src/features/common/ai/providers/deepgram.js
70   resolve({
71     sendRealtimeInput: (buf) => ws.send(buf),     // throws "WebSocket is not open" on a dead socket
72     close: () => ws.close(1000, 'client'),        // ← the ONLY source of reason 'client'
73   });
84   ws.on('close', (code, reason) => callbacks.onclose?.({ code, reason: reason.toString() }));
88   ws.on('error', err => { ...; callbacks.onerror?.(err); reject(err); });
```
A real mid-session drop would leave the session **non-null** and throw `WebSocket is not open: readyState 3 (CLOSED)` from `ws.send` — a different message the user never saw.

### 2.4 The smoking gun (user's second log paste)
```
[SttService] Ignoring message - session already closed   ← requires modelInfo===null ⇒ closeSessions() ran
Their STT session closed: client                          ← ws.close(1000,'client') ⇒ deliberate close
Error sending system audio: Error: Their STT session not active   ← renderer still streaming after close
Error sending user audio:  Error: User STT session not active
My STT session closed: client
Error sending system audio: Error: Their STT session not active   (x2)
```
User comment: *"I think they are related to the start/stop listen button action I manually trigger."* — **Confirmed by the evidence.**

### 2.5 The renderer streams with no per-chunk session check
```
src/ui/listen/audioCore/listenCapture.js
331  window.api.listenCapture.sendMicAudioContent({ data: b64, ... });      // mic, unconditional
398  await window.api.listenCapture.sendSystemAudioContent({ data: ..., });  // system, unconditional
520-523  // startCapture checks isSessionActive() ONCE at entry — never again
```
Contrast the **macOS** native loop, which *does* guard every send:
```
sttService.js:687  if (this.theirSttSession) { try { ... } catch (err) { console.error(...) } }  // :699
```
The IPC send path (Windows/Linux mic, Windows system audio) was never given this guard.

### 2.6 Capture start/stop is fire-and-forget and non-idempotent
```
src/ui/listen/audioCore/renderer.js:22-27   on 'change-listen-capture-state': stop→stopCapture(); else→startCapture();  (not awaited)
listenCapture.js:539-540,560-561            startCapture overwrites audioProcessor/systemAudioProcessor globals
                                            WITHOUT disconnecting the previous ones ⇒ orphaned processors
listenService.js:233-235                    closeSession(): send 'stop' (async IPC) THEN await closeSessions() (nulls refs)
```

---

## 3. Root-cause analysis

### 3.1 Confirmed: Stop/Start capture-lifecycle race (HIGH confidence, log-proven)
Sequence on **Stop** (`listenService.closeSession` `:231-255`):
1. `sendToRenderer('change-listen-capture-state', {status:'stop'})` — queued to the Listen renderer (`:233`).
2. `await this.sttService.closeSessions()` — synchronously nulls `mySttSession`/`theirSttSession` (`:773`,`:777`), closes sockets (reason `client`), nulls `modelInfo` (`:788`).
3. For the few hundred ms until the renderer processes `stop` and `stopCapture()` disconnects the ScriptProcessors, `onaudioprocess` keeps firing → `sendMic/SystemAudioContent` → **throws `not active`** per chunk.

This is the burst in §2.4. **Magnitude:** small per single Stop, but the user toggles Start/Stop frequently → repeated bursts.

### 3.2 Confirmed-reachable: orphaned audio processors (HIGH the bug exists; MEDIUM it's firing for this user)
`startCapture` is `async` (awaits `getUserMedia`, `getDisplayMedia`, WASM-AEC load) and **non-cancelable**. Two ways to strand a *running* processor that `stopCapture` will never disconnect:
- **(a) Stop during an in-flight Start:** `stopCapture()` runs while `startCapture()` is still awaiting; `startCapture` then connects its processors *after* the teardown → they run forever into (now or later) null sessions.
- **(b) Double Start:** a second `startCapture` overwrites the `audioProcessor`/`systemAudioProcessor` globals (`:539-540`,`:560-561`) without disconnecting the first → the first processor runs forever; `stopCapture` only ever disconnects the *current* globals.

The header re-enables the button when the **main-process** handler resolves (`listen:changeSessionResult`, `listenService.js:90`), which is **independent** of whether the **Listen renderer's** fire-and-forget `startCapture()` has finished (`renderer.js:27`). So a prompt Stop after Start, or a slow first-run AEC/`getUserMedia`, makes (a) reachable. `isTogglingSession` (`MainHeader.js:626`) only guards the IPC round-trip, not the renderer capture coroutine.

**Consequence — links to "transcription not working":** orphaned processors send **duplicate/stale audio** to the *current* Deepgram socket → garbled/doubled transcripts; and spam `not active` whenever sessions are null. **This is the leading hypothesis for the functional complaint; Phase 0 will confirm.**

### 3.3 `isSessionActive()` is a shallow liveness check (MEDIUM)
```
sttService.js:743-745  isSessionActive() { return !!this.mySttSession && !!this.theirSttSession; }
```
It reports **structural presence, not socket health**. After a real drop, it returns `true`, so `startCapture`'s guard (`listenCapture.js:520`) passes and audio streams into a dead socket. This is the bridge that turns a drop into silent loss.

### 3.4 No reconnect on a genuine drop (HIGH it exists; NOT evidenced for this user)
`onerror`/`onclose` only log (`sttService.js:443-444`,`:452-453`). Already documented (`docs/AUDIO_AND_STT.md §5`, `runbook §4`). **The user's closes are `client` (deliberate) — so this is hardening for flaky networks, not the cause of the pasted logs.** Critically, any reconnect must **exclude code `1000`/reason `client`** or it will fight every Stop and every renewal hand-off.

### 3.5 Renewal robustness (HIGH; mostly leaks + lost protection)
- On renewal failure, `Promise.all` (`:469`) partial success **leaks** the socket that did open; the renew-timer reschedule (`:483-491`) sits *after* the throw point → **future renewals stop being scheduled**, so the session later runs past provider hard-timeouts unprotected.
- A **Stop landing during** the renewal `await` can null + clear timers, after which the in-flight init **resurrects** sessions and re-arms timers `closeSessions` already cleared → ghost sessions/timers.
- The 2 s `SOCKET_OVERLAP_MS` (`:21`,`:536`) is **ineffective** for its stated "no audio dropped" purpose: after reassign, all audio routes to the *new* socket; the old one only drains.

### 3.6 Deepgram keep-alive is a no-op (CERTAIN; LOW impact)
`_sendKeepAlive` acts only for `provider==='openai'` (`:504`). During active capture, continuous 100 ms audio keeps Deepgram's socket alive, so this only matters during a capture stall.

### 3.7 Speculative amplifier — Deepgram concurrency (UNVERIFIED)
Leaked sockets (3.2b, 3.5) accumulate open Deepgram connections; exceeding the project's concurrency cap would make new `createSTT` calls fail → the 10× init retry (`listenService.js:174-194`) exhausts → "STT init failed after retries." **Flagged as a hypothesis for Phase 0, not a conclusion.**

---

## 4. Decisions & assumptions

| # | Decision / assumption | Basis |
|---|---|---|
| D1 | **No STT failover** (no provider/model switching). Reconnect is **same provider, same model, same handlers, same session**. | `docs/AUDIO_AND_STT.md §5`; `specs/2026-05-26-gemini-failover-design`. |
| D2 | Reconnect MUST ignore **code 1000 / reason `client`** closes (deliberate Stop/renewal). | §2.4, §3.4 — those are normal, not failures. |
| D3 | The platform in scope is **Windows native loopback** (user's env) + the shared mic path; fixes are written platform-agnostically and must not regress the macOS `SystemAudioDump` path or Linux mic-only path. | Stack traces; `docs/AUDIO_AND_STT.md §2`. |
| D4 | At **Stop**, dropping late audio chunks is **correct** (audio is unwanted) — but it must be **silent + counted**, not thrown/spam-logged. | §3.1. |
| D5 | This is the user's own fork; commit `4882438` already made the IPC path non-fatal. We build on that, we don't revert it. | git blame. |
| A1 | "Transcription intermittent" is *primarily* the lifecycle race (boundary loss + orphaned duplicate audio). **To be validated in Phase 0**; if Phase 0 surfaces non-`client` closes, Phase 3 reconnect becomes load-bearing rather than hardening. | §3.2, §3.4. |

---

## 5. Scope & phasing

Each phase is **independently shippable** and ordered by (risk-ascending, value-of-evidence-first).

| Phase | Title | Risk | Addresses |
|---|---|---|---|
| **0** | Instrumentation & correlation | Negligible | Confirm 3.2 / 3.5 / 3.7; quantify boundary loss |
| **1** | Stop the spam (guarded send) | Very low | 3.1 symptom (D4) |
| **2** | Robust capture lifecycle | Medium | 3.1 + 3.2 root cause |
| **3** | Deep liveness + same-session reconnect | Medium | 3.3 + 3.4 (D1, D2) |
| **4** | Renewal hardening | Low–Med | 3.5 (+ 3.6) |

**Delivery sequencing (Clarify Q1 → A):** ship **Phase 0 + Phase 1 first**, then a **hard approval gate**. Phases 2–4 are **not pre-committed** — the gate decides them from Phase 0 real-usage logs:
- **Phase 2** is built at the gate (the Stop/Start race §3.1 and orphan bug §3.2 are code-proven; the **idempotent-start fix is the likely first pull-forward** even if the rest of Phase 2 waits).
- **Phase 3 reconnect only if Phase 0 surfaces a non-`client` close** (today's logs show none — §2.4).
- **Phase 4** as renewal evidence warrants.

---

## 6. Functional requirements

### Phase 0 — Instrumentation
- **FR-0.1** Add a single `[stt-lifecycle]`-tagged, timestamped log at each transition: capture `startCapture` begin/end (renderer), `stopCapture` begin/end (renderer), `initializeSttSessions` begin/end, `closeSessions` begin/end, `renewSessions` begin/end, and each socket `open`/`close` with `{code, reason, readyState}`.
- **FR-0.2** Introduce a monotonic **session-generation id** (`this.sessionGeneration++` on each `initializeSttSessions`) and log it on every transition above. (Reused structurally in FR-2.4.)
- **FR-0.3** In `sendMic/SystemAudioContent`, when the session is null, increment a per-channel **dropped-chunk counter** and emit **one** throttled summary line per "gap episode" (e.g. `[stt-lifecycle] dropped 7 mic chunks while session inactive (gen 3→null)`), not one-per-chunk. (This is the seam Phase 1 formalizes.)
- **FR-0.4** Log a one-line warning when `startCapture` connects a processor while a previous processor global was non-null (detects orphan creation 3.2b).
- **FR-0.5** No behavioral change beyond logging. Must be safe to ship alone.

### Phase 1 — Guarded send (stop the spam)
- **FR-1.1** `sendMicAudioContent` / `sendSystemAudioContent` MUST NOT `throw` when the session is null. They return a benign result and drop the chunk, recording it via FR-0.3.
- **FR-1.2** Behavior must match the existing macOS guard semantics (`sttService.js:687`,`:699`): inactive session ⇒ skip, don't crash, don't spam.
- **FR-1.3** The IPC handlers (`handleSendSystemAudioContent` `:65`, `handleSendMicAudioContent` via `_createHandler`) continue to return `{success:false, error}` shape on genuine errors (no regression to commit `4882438`).

### Phase 2 — Robust capture lifecycle (renderer)
- **FR-2.1 (idempotent start):** `startCapture` MUST fully tear down any existing capture (call the Phase-2 teardown) before creating new contexts/processors. No path may leave a connected processor unreferenced.
- **FR-2.2 (track all resources):** Replace the single-global `audioProcessor`/`systemAudioProcessor`/context model with a tracked set so `stopCapture` disconnects/closes **every** processor and context it ever created, including any created by a superseded start.
- **FR-2.3 (cancelable start):** `startCapture` carries a local **capture token**; if `stopCapture` (or a newer `startCapture`) runs while it is awaiting, the in-flight start MUST abort *before connecting* its processors (token mismatch ⇒ tear down what it built, connect nothing).
- **FR-2.4 (generation-stamped audio — main-side backstop):** Audio IPC payloads carry the current capture/session generation; `sendMic/SystemAudioContent` drop any chunk whose generation ≠ the active session generation. Defense-in-depth so a renderer that is briefly behind cannot stream into a new/closed session.
- **FR-2.5 (ordered teardown — Clarify Q5 → A):** `closeSession` makes late audio **inert by generation** (FR-2.4) rather than racing an IPC ack: it bumps the session generation and nulls; any chunk stamped with an older generation is dropped by the handlers. **The renderer `capture-stopped` ack is NOT implemented** (optional future polish — correctness comes from the receiving end, so it does not depend on renderer responsiveness).
- **FR-2.6 (`Done` hygiene):** Verify `Done` (`listenService.js:80-84`) cannot leave capture running; if reachable without a preceding Stop, route it through the same teardown.

### Phase 3 — Liveness + same-session reconnect
- **FR-3.1 (deep liveness):** `isSessionActive()` (and the `startCapture` precheck) MUST consider socket health, not just non-null. Provider session objects expose a readiness/`readyState` probe; Deepgram's wrapper returns one (`ws.readyState === OPEN`).
- **FR-3.2 (reconnect on involuntary drop — Clarify Q2 values):** On `onclose`/`onerror` that is **not** code 1000 / reason `client` (D2), recreate **only the affected side** (`my` or `their`) via `createSTT` with the same provider/model/handlers/config. Backoff **250 ms × 2, cap 4 s, ±20 % jitter** (~0.25/0.5/1/2/4/4 s), **max 6 attempts**; reduce the Deepgram per-attempt open-timeout **10 s → 5 s during reconnect** (`deepgram.js:63`) so a hung attempt can't stall the schedule. On success, swap the reference atomically; on exhaustion → FR-3.4.
- **FR-3.3 (no double pipelines):** Reconnect MUST NOT create overlapping sockets for the same side or leak the dead one.
- **FR-3.4 (status to UI; exhaustion UX — Clarify Q3 → A):** Reconnecting / reconnected states emit `update-status` ("Reconnecting…") so there's no silent dead air. **On exhaustion:** show a visible status with a **one-click "Resume"** that performs Stop→Listen; capture keeps running and any still-live side keeps transcribing (via FR-1.1). **No auto-restart** (avoids restart loops on a persistent fault). Per-channel graceful degrade is deferred to §12.

### Phase 4 — Renewal hardening
- **FR-4.1 (no leak on partial failure):** If `initializeSttSessions` (under renewal) rejects after one `createSTT` resolved, the resolved socket MUST be closed.
- **FR-4.2 (preserve protection):** A failed renewal MUST reschedule itself (retry/backoff) so the keep-alive/renew protection is never silently lost (today the reschedule is skipped on throw — `:483-491`).
- **FR-4.3 (generation guard):** If `closeSessions` runs during a renewal, the in-flight renewal MUST NOT resurrect sessions or re-arm timers (check generation/closed flag before assigning).
- **FR-4.4 (overlap review):** Either make `SOCKET_OVERLAP_MS` actually dual-route during the window, or remove it and document that hand-off is instantaneous (it currently does neither — §3.5).

---

## 7. Architecture / design changes (by file)

- `src/features/listen/stt/sttService.js`
  - `sendMicAudioContent` (`:547`), `sendSystemAudioContent` (`:575`): guard instead of throw (FR-1.1), generation drop (FR-2.4).
  - `isSessionActive` (`:743`): deep liveness (FR-3.1).
  - `closeSessions` (`:747`): generation bump; ordered teardown coordination (FR-2.5, FR-4.3).
  - `initializeSttSessions` (`:152`): assign `sessionGeneration` (FR-0.2); close-on-partial-failure (FR-4.1).
  - `renewSessions` (`:518`): partial-failure cleanup, reschedule, generation guard, overlap decision (FR-4.*).
  - New: per-side reconnect wrapper around the `onclose`/`onerror` callbacks (FR-3.2–3.4).
- `src/features/common/ai/providers/deepgram.js`
  - Expose a liveness probe (e.g. return `readyState`/`isOpen`) for FR-3.1; ensure `onclose` surfaces `{code, reason}` (already does, `:84-86`) for the `client` filter (FR-3.2/D2).
- `src/ui/listen/audioCore/listenCapture.js`
  - Resource tracking + idempotent/cancelable `startCapture` + complete `stopCapture` (FR-2.1–2.3); generation tagging on send (FR-2.4); orphan-detection log (FR-0.4).
- `src/ui/listen/audioCore/renderer.js`
  - Coordinate the fire-and-forget handler (`:17-29`) with capture tokens; optionally emit `capture-stopped` ack (FR-2.5).
- `src/features/listen/listenService.js`
  - `closeSession` (`:231`): ordered teardown / ack (FR-2.5); `initializeSession` finally (`:205-209`) review (don't tell renderer to "start" on init failure path — minor, the renderer self-guards today but it's misleading).
- `src/bridge/featureBridge.js` / `src/preload.js`
  - Any new IPC for the `capture-stopped` ack and generation, if FR-2.5 ack route is chosen.

(Exact signatures + the FR-2.5 route are settled in `/plan`.)

---

## 8. Edge cases

1. **Rapid Stop→Listen→Stop** faster than `startCapture` awaits — covered by FR-2.3 (token abort) + FR-2.4 (generation drop).
2. **First-run AEC/WASM load latency** (long `getAec()`/`getUserMedia`) widening the start window — FR-2.3.
3. **Renewal coincides with Stop** — FR-4.3.
4. **Reconnect storm** (provider returning 4xx/handshake error repeatedly) — FR-3.2 backoff + cap; never reconnect on `client` (D2).
5. **macOS path** uses the native `SystemAudioDump` loop (already guarded) — must not be double-guarded or broken by generation logic (the native loop sends from main, not via the IPC handlers).
6. **Linux** — mic-only; system-audio FRs are inert there. Verify no crash from missing `their` reconnect target.
7. **`Done` without prior `Stop`** — FR-2.6.
8. **App quit during reconnect/renewal** — `before-quit` (`index.js:244`) must still tear down cleanly (await guard).

---

## 9. Risks & tradeoffs

- **Masking real failures (FR-1.1):** silently dropping chunks could hide a genuine "sessions never came up" bug. **Mitigation:** the FR-0.3 throttled counter + FR-3.4 status keep it visible without spam.
- **Capture-core regressions (Phase 2):** `listenCapture.js` is the AEC/mic/loopback heart; refactoring resource handling risks audio regressions that only surface in QA. **Mitigation:** keep the audio-graph wiring identical; change only lifecycle/ownership; manual smoke test per §10.
- **Reconnect correctness (Phase 3):** a wrong reconnect can double-bill audio or create overlapping transcripts. **Mitigation:** FR-3.3 single-pipeline invariant + the `client`-exclusion (D2) + status visibility.
- **Generation plumbing (FR-2.4):** adds a field to the hot audio IPC path (~10/s per channel). Negligible payload cost; the alternative (ack-only) has a timeout-fallback edge. Recommend FR-2.4 as the floor, ack as optional polish.
- **Doing nothing:** the spam stays, audio is lost at every Stop boundary, and a real future network drop (currently not observed) needs a manual restart.

---

## 10. Testing / acceptance

**Harness (corrected — Clarify Q4):** the repo uses the **Node built-in test runner** (`test` script = `node --test src/**/__tests__/**/*.test.js`), **not Jest**, and already has **3** tests — `askService-sse.test.js`, `gemini.test.js`, `geminiModelRotator.test.js`. `askService-sse.test.js` is a *service* test → precedent for stubbing a service's deps (incl. `require('electron')`, which `sttService.js:1` needs). **Policy (Q4 → B):** automate **AC-1 now** (Phase 1) mirroring that precedent; write **AC-2..5 alongside their phases** if the gate approves them; manual AC-6..9 throughout.

**Automated (where feasible — main-process units, `node:test`):**
- AC-1: `sendMic/SystemAudioContent` with null session ⇒ resolves (no throw), increments counter (FR-1.1, FR-0.3).
- AC-2: generation drop — a chunk stamped gen N is ignored when active gen is N+1 (FR-2.4).
- AC-3: `renewSessions` with a mocked partial `createSTT` failure ⇒ the resolved socket's `close()` is called and a renewal retry is scheduled (FR-4.1, FR-4.2).
- AC-4: `onclose({code:1000, reason:'client'})` ⇒ **no** reconnect attempt; `onclose({code:1011})` ⇒ reconnect attempted for that side only (FR-3.2, D2).
- AC-5: `isSessionActive()` returns `false` when a session object exists but its socket `readyState !== OPEN` (FR-3.1).

**Manual smoke (Windows + Deepgram Nova-3 — the user's env):**
- AC-6: Start → speak → **mash Start/Stop 10×** rapidly ⇒ **zero** `session not active` lines; no duplicate/garbled transcript after settling; `[stt-lifecycle]` shows no orphan-creation warnings (FR-2.*).
- AC-7: Single clean Start → 25 min continuous → renewal fires once, transcript continuous, no leak warning (FR-4.*).
- AC-8: Force an involuntary drop (kill network ~5 s mid-session) ⇒ status shows "Reconnecting…", transcript resumes without manual Stop→Listen (FR-3.2). *(If Phase 0 shows the user never hits real drops, AC-8 validates the hardening, not a reported bug.)*
- AC-9 (regression): macOS `SystemAudioDump` path + Linux mic-only path still transcribe (no platform regression — D3).

**Phase 0 exit criteria (informs Phases 2–4):** from real usage logs, confirm (a) the spam correlates with `close: client` Stop events, (b) presence/absence of orphan-creation warnings, (c) presence/absence of any non-`client` close. These decide how load-bearing Phase 3 is.

---

## 11. Files touched (estimate)

| File | Phases | Nature |
|---|---|---|
| `src/features/listen/stt/sttService.js` | 0,1,3,4 | guards, generation, reconnect, renewal |
| `src/ui/listen/audioCore/listenCapture.js` | 0,2 | resource tracking, idempotent/cancelable capture |
| `src/ui/listen/audioCore/renderer.js` | 2 | token coordination, optional ack |
| `src/features/common/ai/providers/deepgram.js` | 3 | liveness probe |
| `src/features/listen/listenService.js` | 2 | ordered teardown, init-finally review |
| `src/bridge/featureBridge.js`, `src/preload.js` | 2 (if ack route) | new IPC for ack/generation |
| `docs/AUDIO_AND_STT.md §5`, `docs/runbook/AUDIO_TROUBLESHOOTING.md §4`, `docs/diagrams/08-stt-session-lifecycle.mmd` | all | update "no reconnect / Stop→Listen" once Phase 3 lands |

---

## 12. Out of scope / future work

- Cross-provider or cross-model STT failover (locked: D1).
- **Per-channel graceful degrade** on reconnect exhaustion — keep the live side, show a "Them/Me channel down" indicator instead of requiring a full Resume (Clarify Q3 option C; cheap once FR-1.1 + FR-3.1 land).
- VAD-gated sending / silence suppression to cut Deepgram cost.
- Deepgram model selection beyond the hardcoded `nova-3` (`deepgram.js:45`; tracked in `docs/AUDIO_AND_STT.md §4`).
- Replacing the renderer `ScriptProcessorNode` with `AudioWorklet` (deprecation; separate perf work).
- A real Deepgram `KeepAlive` message (FR-3.6 territory) — low value while audio flows continuously; revisit only if Phase 0 shows capture-stall idle closes.

---

## Clarifications

### Session 2026-05-30
- Q: Scope/ambition? → **Full resilience, phased** (user).
- Q: Diagnose vs fix? → **Both — ship safe fixes (Phase 0/1) + instrument** (user).
- Q: Are real socket drops in play? → **No** in the evidence provided: closes are `reason: 'client'` (deliberate), tied to the manual Stop/Start button (user-confirmed). Reconnect (Phase 3) is therefore hardening, gated on Phase 0 finding any non-`client` close. (§2.4, §3.4)

#### `/clarify` pass — 5 questions (single-pass; `convergent-recommender` unavailable in env)
- **Q1 — phase sequencing → A:** Ship Phase 0+1 first; **hard gate** after Phase 1; Phases 2–4 decided from Phase 0 evidence (Phase 3 only on a non-`client` close). Idempotent-start is the likely first pull-forward. (§5)
- **Q2 — reconnect values → adopt:** per-side; trigger code≠1000 & reason≠`client`; 250 ms×2, cap 4 s, ±20 % jitter, max 6; per-attempt open-timeout 10 s→5 s; reuse config. (FR-3.2)
- **Q3 — exhaustion UX → A:** visible status + one-click **Resume**; capture keeps running, live side keeps transcribing; no auto-restart. Per-channel degrade → §12. (FR-3.4)
- **Q4 — test strategy → B:** automate **AC-1 now** via `node:test` (mirroring `askService-sse.test.js`), AC-2..5 per-phase, manual AC-6..9 throughout. Corrected the false "first tests in repo" claim — **3 tests already exist; harness is `node:test`, not Jest**. (§10)
- **Q5 — FR-2.5 route → A:** **generation-drop floor** (FR-2.4); renderer ack not implemented (optional polish). (FR-2.5)
- **Remaining open (gate item):** Validate A1 (orphaned-processor duplicate audio as the cause of "transcription not working") with Phase 0 logs before committing Phase 2 beyond the idempotent-start fix.

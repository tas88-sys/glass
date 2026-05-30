# Phase 1 Data Model — Improve STT Session Robustness

**Spec:** `specs/2026-05-30-improve-STT-sessions/spec.md`
**Date:** 2026-05-30

This feature has **no database schema**. The "entities" here are **in-memory runtime state**
(session pointers, generation counters, capture-resource sets, reconnect state) plus the **IPC
message shapes** that cross the renderer↔main boundary. Each entity below lists fields, ownership,
lifecycle/state transitions, validation/invariants, and the FRs it serves.

---

## Entity 1 — `SttService` runtime state (main process)

Owner: `src/features/listen/stt/sttService.js` (singleton via `listenService`).

| Field | Type | Today? | Purpose / FR |
|---|---|---|---|
| `mySttSession` | `{ sendRealtimeInput, close, readyState? } \| null` | yes (`:25`) | Mic ("Me") socket wrapper. |
| `theirSttSession` | same shape `\| null` | yes (`:26`) | System ("Them") socket wrapper. |
| `modelInfo` | `{ provider, model, apiKey } \| null` | yes (`:47`) | Active provider; `null` ⇒ "session already closed". |
| `sessionGeneration` | `number` (monotonic) | **NEW** | Incremented on each `initializeSttSessions`. Stamped on transitions (FR-0.2) and audio chunks (FR-2.4). |
| `droppedChunkCounters` | `{ my: number, their: number }` | **NEW** | Per-channel count of chunks dropped while inactive (FR-0.3). |
| `gapEpisode` | `{ my: {active, count, fromGen}, their: {...} }` | **NEW** | Throttle state so one summary line per gap episode, not per chunk (FR-0.3). |
| `keepAliveInterval` | timer handle `\| null` | yes (`:40`) | 60 s heartbeat (openai only). |
| `sessionRenewTimeout` | timer handle `\| null` | yes (`:41`) | 20-min renewal timer. |
| `reconnectState` | `{ my: ReconnectState, their: ReconnectState }` | **NEW** (Phase 3) | Per-side reconnect bookkeeping (see Entity 4). |
| `isClosing` | `boolean` | **NEW** | Set true at the top of `closeSessions`; checked by in-flight renewal/reconnect to refuse resurrection (FR-4.3). |

### Invariants
- **INV-1:** `mySttSession`/`theirSttSession` are nulled in **exactly** two places — the constructor
  and `closeSessions()`. (Do not introduce a third null site; reconnect swaps atomically, never
  transiently nulls — FR-3.3.)
- **INV-2:** `sessionGeneration` is **strictly increasing** and never reused. A chunk stamped with a
  generation < the current active generation is dropped (FR-2.4).
- **INV-3:** when `modelInfo === null`, all inbound transcript messages are ignored (existing guard
  `:164`/`:306`) and all outbound sends drop-and-count (FR-1.1) — never throw.
- **INV-4:** a renewal or reconnect in flight when `isClosing===true` (or generation has advanced)
  MUST NOT assign session pointers or arm timers (FR-4.3).

### State transitions (single live STT session — NO failover; refines diagram 08)
```
        initializeSttSessions(gen++)            both sockets open
[*] ───────────────────────────────────▶ Initializing ──────────────▶ Active(gen)
                                              │  throws
                                              ▼  (listenService retries ≤10×@300ms)
                                          RetryInit ──exhausted──▶ Failed ──▶ [*]

Active(gen):
   • audio chunk (stamped gen) every 100ms                  → send if gen == active && session live
   • inactive/stale chunk (gen != active OR session null)   → DROP + count (FR-1.1/2.4)  [no throw]
   • every 60s (openai)                                     → keepAlive
   • every 20min                                            → Renewing
   • onclose/onerror, code==1000 && reason=='client'        → (ignore — deliberate)        [D2]
   • onclose/onerror, NOT 1000/'client'                     → Reconnecting(side)            [FR-3.2]

Renewing (gen→gen+1):
   • init fresh sessions; if partial failure → close the one that opened (FR-4.1)
   • on success → swap pointers, re-arm timers, close old after overlap
   • on failure → RESCHEDULE renewal (backoff) so protection persists (FR-4.2)
   • if closeSessions ran meanwhile (isClosing/gen advanced) → ABORT, resurrect nothing (FR-4.3)
   Renewing → Active(gen+1)

Reconnecting(side):   [Phase 3, per-side, same provider/model/handlers/config]
   • createSTT(side); backoff 0.25/0.5/1/2/4/4 s ±20% jitter, max 6; open-timeout 10s→5s
   • success → atomic swap of that side's pointer (no overlap/double pipeline — FR-3.3) → Active
   • exhausted → Degraded(side): emit status + one-click Resume; live side keeps transcribing
                 (FR-1.1 keeps the surviving side spam-free); NO auto-restart (FR-3.4)

Active / Reconnecting / Renewing ── Stop or app-quit ──▶ Closing(isClosing=true, gen++)
Closing: closeSessions() — clear timers, null pointers, modelInfo=null, kill SystemAudioDump
Closing ──▶ [*]
```

---

## Entity 2 — Capture resources (renderer)

Owner: `src/ui/listen/audioCore/listenCapture.js`.

**Today (the bug):** four module-level globals (`audioContext`, `audioProcessor`,
`systemAudioContext`, `systemAudioProcessor`) plus two streams (`mediaStream`, `micMediaStream`).
`startCapture` overwrites the processor/context globals **without disconnecting** the previous ones
(`:538-540`, `:559-561`); `stopCapture` only disconnects the *current* globals (`:574-611`) ⇒
orphaned processors keep firing `onaudioprocess` forever (spec §3.2).

**Phase 2 model:** a single **tracked resource set** that owns every context/processor/stream ever
created within a capture, keyed by a capture token.

| Field | Type | Purpose / FR |
|---|---|---|
| `captureToken` | `number \| symbol` (monotonic) | Identifies the current capture coroutine (FR-2.3). |
| `resources` | `Set<{ kind:'context'\|'processor'\|'stream', ref }>` | Everything `stopCapture` must tear down — including resources from a superseded start (FR-2.1/2.2). |
| `captureGeneration` | `number` | Mirrors `sessionGeneration`; stamped on each outbound chunk (FR-2.4). |

### Invariants
- **INV-5 (idempotent start):** `startCapture` first runs full teardown of any existing capture
  before creating new contexts/processors. No path leaves a connected processor unreferenced (FR-2.1).
- **INV-6 (complete stop):** `stopCapture` disconnects/closes **every** member of `resources`, not
  just "current" globals (FR-2.2).
- **INV-7 (cancelable start):** `startCapture` captures its `captureToken` locally; before connecting
  processors it re-checks the token. If a newer `startCapture`/`stopCapture` advanced the token, it
  tears down what it built and connects **nothing** (FR-2.3).
- **INV-8:** every chunk sent via `sendMic/SystemAudioContent` carries `captureGeneration` (FR-2.4).

### Capture lifecycle (renderer)
```
change-listen-capture-state:start  → startCapture(tokenN)
   getUserMedia/getDisplayMedia/AEC (await…)   ← cancelable window
   token still == N ?  ── no ──▶ teardown built-so-far, connect nothing (FR-2.3)
                       └─ yes ─▶ connect processors, register in resources, stream (stamp genN)
change-listen-capture-state:stop   → stopCapture(): teardown ALL resources, token++ (FR-2.1/2.2)
double start                        → token++ first ⇒ prior coroutine self-aborts (FR-2.3)
```

---

## Entity 3 — Audio IPC message (renderer → main)

| Field | Type | Today? | Note |
|---|---|---|---|
| `data` | base64 string (PCM16/mono/24 kHz) | yes | unchanged |
| `mimeType` | string | yes | unchanged |
| `generation` | number | **NEW (FR-2.4)** | active capture/session generation; **additive & optional** — a payload without it is treated as the stale-safe default and dropped if a generation guard is in force. |

Channels: `listen:sendMicAudio` (`featureBridge.js:149`), `listen:sendSystemAudio` (`:151`).
Bridge fns: `preload.js:305-306`. Result shape (unchanged): `{ success, error?, dropped? }`.

---

## Entity 4 — `ReconnectState` (per side; Phase 3)

| Field | Type | Purpose |
|---|---|---|
| `status` | `'idle'\|'reconnecting'\|'reconnected'\|'exhausted'` | Drives `update-status` UI (FR-3.4). |
| `attempt` | number (0..6) | Current attempt; cap 6 (FR-3.2). |
| `timer` | timer handle \| null | Backoff timer; cleared on success/close. |
| `generationAtStart` | number | Guards against swapping a socket into a session that has since closed/renewed (INV-4). |

### Backoff schedule (locked — Clarify Q2)
`base=250ms`, `×2`, `cap=4000ms`, `±20% jitter` ⇒ ~250 / 500 / 1000 / 2000 / 4000 / 4000 ms;
**max 6 attempts**; Deepgram per-attempt open timeout **5000 ms during reconnect** (vs 10 000 ms
normal, `deepgram.js:63`). Trigger predicate: `!(code === 1000 && reason === 'client')` (D2).

### Validation
- **VAL-1:** never start a reconnect for a side whose close was `{1000,'client'}` (deliberate). 
- **VAL-2:** never run two concurrent reconnects for the same side (FR-3.3); a `reconnecting` status
  is a mutex.
- **VAL-3:** on success, swap is atomic (assign new pointer, then close the dead one) — no transient
  null (INV-1) and no overlapping live sockets (FR-3.3).

---

## Entity 5 — Provider session wrapper contract (extended)

Owner: `src/features/common/ai/providers/deepgram.js` (and, for parity, other providers' `createSTT`).

| Member | Today? | Change |
|---|---|---|
| `sendRealtimeInput(buf)` | yes (`:71`) | unchanged |
| `close()` | yes (`:72`, `ws.close(1000,'client')`) | unchanged — this is the **only** source of reason `client`; the reconnect filter depends on it (D2). |
| `readyState` **or** `isOpen()` | **NEW (FR-3.1)** | Expose `ws.readyState` (or `ws.readyState === OPEN`) so `isSessionActive()` can check socket health, not just non-null. |
| onclose `{code, reason}` | yes (`:84-86`) | unchanged — already surfaces both fields for the filter. |

---

## Header session state machine (context — `src/ui/app/MainHeader.js`)

Not modified by this feature, but documented because FR-2.6 (`Done` hygiene) depends on its
reachable transitions. Verified against code:

| `listenSessionStatus` | Button text (`:430-435`) | Click → IPC (`:633-635`) | Main handler (`listenService.js:56-88`) |
|---|---|---|---|
| `beforeSession` | `Listen` | `sendListenButtonClick('Listen')` | `initializeSession()` (starts capture) |
| `inSession` | `Stop` | `'Stop'` | `closeSession()` (tears down — `:231-255`) |
| `afterSession` | `Done` | `'Done'` | hide window only; **no teardown** (`:80-84`) |

`isTogglingSession` (`:626`,`:630`,`:705`) guards only the IPC round-trip and clears on
`listen:changeSessionResult` (`:556`) — **independent** of the renderer's fire-and-forget
`startCapture()` (this is the §3.2 race seam). In the normal cycle `Done` follows a `Stop` that
already tore down; **FR-2.6 verification** = confirm `afterSession`/`Done` cannot be entered while
capture is still live, and if it can, route `Done` through the same teardown.

---

## Summary of new state (no DB)
- `SttService`: `+sessionGeneration`, `+droppedChunkCounters`, `+gapEpisode`, `+isClosing`,
  `+reconnectState` (Phase 3).
- `listenCapture`: replace 4 globals with `+captureToken`, `+resources`, `+captureGeneration`.
- IPC: `+generation` field on the two audio channels (additive).
- Provider wrapper: `+readyState`/`isOpen()`.
- **Zero** persisted schema changes, env vars, or migrations.

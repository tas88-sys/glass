# Phase 0 Research — Improve STT Session Robustness

**Spec:** `specs/2026-05-30-improve-STT-sessions/spec.md`
**Branch:** `feat/improve-stt-sessions` (spec proposes `fix/stt-session-lifecycle`)
**Date:** 2026-05-30
**Plan owner:** All Phase 0 artifacts populated by `/plan`. `/implement` consumes these; it does not produce them.

This document consolidates the Phase 0.1 research, the production-log evidence premise, the
Phase 0.3 integration analysis, the testing strategy, and the timeline risks. It records the
**decisions, rationale, and alternatives** behind the plan, and surfaces the discrepancies found
when the spec's cited evidence was re-verified against the live code.

---

## 0. Code-evidence re-verification (every cited `file:line` checked against HEAD)

This is a bugfix. Per the constitution (Principle III) and the plan template's Production Log &
Error Evidence gate, the spec's evidence was **independently re-verified against the current
source**, not trusted on its face. Result: **all cited line references are accurate.**

| Spec claim | File:line verified | Verdict |
|---|---|---|
| Throw guards (the logged errors) | `sttService.js:551-552`, `:576-577` | ✅ exact |
| Refs nulled only in constructor + closeSessions | `sttService.js:25-26`, `:773`, `:777` | ✅ exact |
| `modelInfo=null` only in closeSessions | `sttService.js:788` | ✅ exact |
| init assigns truthy only (no null window) | `sttService.js:469` (`Promise.all`) | ✅ exact |
| "Ignoring message - session already closed" needs `modelInfo===null` | `sttService.js:164`, `:306` | ✅ exact |
| Shallow `isSessionActive` (non-null only) | `sttService.js:743-745` | ✅ exact |
| macOS native loop IS guarded per-send | `sttService.js:687`, catch `:699-701` | ✅ exact |
| renewSessions keeps old refs during await | `sttService.js:524-533` | ✅ exact (no null window) |
| renew reschedule sits after throw point | `sttService.js:483-491` (in `initializeSttSessions`) | ✅ exact |
| `SOCKET_OVERLAP_MS` only drains old socket | `sttService.js:21`, `:536-544` | ✅ exact |
| keep-alive is openai-only | `sttService.js:504` | ✅ exact |
| Deepgram close = `ws.close(1000,'client')` (only source of `client`) | `deepgram.js:72` | ✅ exact |
| Deepgram open timeout 10 s | `deepgram.js:63-66` | ✅ exact |
| onclose surfaces `{code, reason}` | `deepgram.js:84-86` | ✅ exact |
| onerror only logs/rejects (no null, no reconnect) | `deepgram.js:88-92` | ✅ exact |
| model hardcoded `nova-3` (ignores `model` opt) | `deepgram.js:45` | ✅ exact |
| Renderer sends are unconditional (no per-chunk guard) | `listenCapture.js:331` (mic), `:398` (system) | ✅ exact |
| `isSessionActive()` checked once at start entry | `listenCapture.js:426`/`:476`/`:520-523` | ✅ exact |
| start overwrites processor globals w/o disconnect ⇒ orphans | `listenCapture.js:538-540`, `:559-561` | ✅ exact |
| `stopCapture` disconnects only current globals | `listenCapture.js:574-611` | ✅ exact |
| Renderer capture-state handler is fire-and-forget | `renderer.js:17-29` (not awaited) | ✅ exact |
| `Done` does not close the session | `listenService.js:80-84` | ✅ exact (only hides + state event) |
| `change-listen-capture-state: start` fired even on init-fail | `listenService.js:205-209` (`finally`) | ✅ exact |
| `_createHandler` returns `{success:false,error}` | `listenService.js:270-291` | ✅ exact |
| IPC stack-trace lines | `featureBridge.js:149` (mic), `:151` (system) | ✅ exact |
| preload bridge fns | `preload.js:305-306`, `:311`, `:321` | ✅ exact |
| No-failover lock (D1 basis) | `gemini-failover-design/spec.md:82`, `:402`; `AUDIO_AND_STT.md §5` | ✅ confirmed |

**Conclusion:** the spec's root-cause mechanism (Stop/Start capture-lifecycle race, log-proven by
the `client` close reason + `Ignoring message` guard) is **sound and fully evidenced**. No claim
was found to be wrong. Two *additional* nuances surfaced (see §3 discrepancies) that refine — not
contradict — the spec.

---

## 1. Production Log & Error Evidence (gate subsection — populated inline)

The plan template requires this subsection populated with pasted evidence or an explicit premise
**before** continuing. The `debug-cw` SigNoz/Sentry path is the standard CW-platform evidence
source. It does **not** apply here, and that is itself the documented premise:

| Source | Query | Findings (inline) |
|--------|-------|-------------------|
| SigNoz (CW production) | `display_id:<id>` | **N/A — no CW display_id exists.** This bug is in the `glass` Electron desktop app (`pickle-glass`), not the Cover Whale platform. There is no CW backend, no `submission #<id>`, no `/transportation/<id>`. The `debug-cw` match patterns do not fire on any token in the spec or prompt. |
| Sentry (CW production) | project + display_id | **N/A** — same reason; this fork ships no Sentry DSN for a CW project. |
| `config/logging.php` channels | domain channel | **N/A** — no Laravel/PHP monolith here; the app is Node/Electron with `console.*` logging only. |
| **Actual evidence source** | User-pasted runtime logs + source re-verification | **Present and pasted in spec §2.1–§2.5 and re-verified in §0 above.** The user's two log pastes contain the `not active` burst, `My/Their STT session closed: client`, and `[SttService] Ignoring message - session already closed` — the exact signature of a deliberate-close-vs-late-audio race. |

**`PREMISE L1`:** *Evidence obtained from the correct source for this codebase.* SigNoz/Sentry are
not the evidence channel for a local Electron app with no CW display_id; the authoritative
evidence is the user's runtime stack traces plus the per-line source re-verification in §0, which
together prove the mechanism at HIGH confidence. **No production-access blocker exists** — the repo
is local and fully readable. The bugfix gate is satisfied by direct source evidence, not a remote
log search that has no applicable target here.

> **Why this is not a gate "TBD":** the gate forbids deferring evidence to `/implement`. Nothing is
> deferred — the evidence is complete now. What is *gated behind Phase 0 instrumentation* is a
> distinct, explicitly-scoped question (is "intermittent transcription" *fully* explained by the
> race, or is there a second cause?), which the spec correctly frames as a hypothesis (A1) to
> confirm with real-usage logs, not as missing root-cause evidence.

---

## 2. Decisions, Rationale, Alternatives (Phase 0.1 Research output)

Each decision below is either inherited from the spec's locked `/clarify` answers (not
re-litigated) or resolved here from the code re-verification.

### D-R1 — Stop the throw, drop-and-count instead (FR-1.1, FR-0.3)
- **Decision:** `sendMic/SystemAudioContent` return a benign result (`{ success: true, dropped: true }`)
  when the session is null, increment a per-channel dropped-chunk counter, and emit one throttled
  summary per gap episode. They MUST NOT throw.
- **Rationale:** the throw is the *only* cause of the user's logged error spam (§0). The macOS
  native loop already uses exactly this skip-don't-crash semantics (`sttService.js:687/:699`); we
  are making the IPC path consistent with the path that never spammed.
- **Alternatives rejected:** (a) silence the logger only — hides a real "sessions never came up"
  failure; the throttled counter (FR-0.3) keeps it visible. (b) per-chunk guard in the renderer
  only — leaves the main process able to throw if a late chunk still arrives; the receiving-end
  guard is the correct floor (matches FR-2.4 defense-in-depth).

### D-R2 — Generation-stamping as the ordering floor, NOT a renderer ack (FR-2.4, FR-2.5; Clarify Q5→A)
- **Decision:** the audio IPC payload carries the capture/session **generation id**; handlers drop
  any chunk whose generation ≠ the active session generation. The renderer `capture-stopped` ack is
  **not** implemented (optional future polish).
- **Rationale:** correctness must live at the **receiving** end. An ack races the IPC round-trip and
  needs a timeout fallback; a generation stamp is a pure value comparison with no timing edge. The
  spec already introduces a monotonic generation for instrumentation (FR-0.2), so FR-2.4 reuses that
  structure — no new concept.
- **Alternatives rejected:** ack-only (timeout-fallback edge, §9 of spec); time-based grace window
  (fragile under slow first-run AEC/`getUserMedia`).

### D-R3 — Reconnect is same-session, per-side, and excludes code 1000/`client` (FR-3.2, D1, D2; Clarify Q2)
- **Decision:** on `onclose`/`onerror` with code ≠ 1000 **and** reason ≠ `client`, recreate **only**
  the affected side via `createSTT` with identical provider/model/handlers/config. Backoff
  250 ms ×2, cap 4 s, ±20 % jitter (~0.25/0.5/1/2/4/4 s), max 6 attempts; Deepgram per-attempt open
  timeout reduced 10 s→5 s **during reconnect** (`deepgram.js:63`). Atomic swap on success;
  exhaustion → FR-3.4.
- **Rationale:** the no-failover decision is locked twice over (`AUDIO_AND_STT.md §5`;
  `gemini-failover-design/spec.md:82,:402`). Same provider/model/handlers is the *only* reconnect
  shape compatible with that lock. The `client`/1000 exclusion is non-negotiable: every Stop and
  every 20-min renewal hand-off closes with exactly `ws.close(1000,'client')` (`deepgram.js:72`), so
  a naive reconnect would fight normal operation (this is the headline lesson in the personal-memory
  entry — see plan `## Prior Lessons Applied`).
- **Alternatives rejected:** cross-provider/cross-model failover (locked out); full-session reconnect
  (both sides) — wastes the still-healthy side and risks double pipelines (FR-3.3).

### D-R4 — Deep liveness probe over non-null check (FR-3.1)
- **Decision:** `isSessionActive()` and the `startCapture` precheck consider socket health. The
  Deepgram wrapper exposes a readiness probe (`ws.readyState === OPEN`).
- **Rationale:** the current shallow check (`sttService.js:743-745`) returns `true` for a dead-but-
  non-null socket, so audio streams into a closed socket = silent loss (spec §3.3). A `readyState`
  probe is the minimal honest signal.
- **Alternatives rejected:** active ping/pong health (Deepgram has no app-level ping in this wrapper;
  during capture, 100 ms audio already keeps it warm — a structural `readyState` check is sufficient).

### D-R5 — Renewal hardening: no-leak, self-reschedule, generation-guarded (FR-4.*)
- **Decision:** (a) if `initializeSttSessions` under renewal rejects after one `createSTT` resolved,
  close the resolved socket; (b) a failed renewal reschedules itself (retry/backoff) so protection
  is never silently lost; (c) a `closeSessions` during a renewal must prevent the in-flight renewal
  from resurrecting sessions/timers (generation/closed-flag check before assign); (d) make
  `SOCKET_OVERLAP_MS` actually dual-route, or remove it and document instantaneous hand-off.
- **Rationale:** today the reschedule sits *after* the throw point (`sttService.js:483-491`), so one
  failed renewal stops all future renewals and the session later runs past provider hard-timeouts
  unprotected (spec §3.5). The overlap constant is currently a no-op for its stated purpose.
- **Alternatives rejected:** leave renewal as-is (silent loss of the 20-min protection is the most
  dangerous latent bug after the spam itself).

### D-R6 — `Done` routed through the same teardown if reachable without Stop (FR-2.6)
- **Decision:** verify `Done` (`listenService.js:80-84`) cannot leave capture running; if it can,
  route it through the Phase-2 teardown.
- **Rationale:** `Done` currently only hides the window and emits `session-state-changed`; it does
  **not** call `closeSession()` (§0). If a user can reach `Done` without a preceding `Stop`, capture
  keeps running into a hidden window.
- **Open verification:** confirm the header state machine's reachable transitions to `Done`
  (`MainHeader.js`) during Phase 0/2; the fix is cheap regardless.

### D-R7 — Phasing & hard gate (Clarify Q1→A)
- **Decision:** ship **Phase 0 + Phase 1 first**, then a hard approval gate. Phases 2–4 are not
  pre-committed; the gate decides them from Phase 0 real-usage logs. The idempotent-start fix
  (FR-2.1) is the likely first pull-forward. **Phase 3 reconnect lands only if Phase 0 surfaces a
  non-`client` close** (today's logs show none).
- **Rationale:** the spam fix (Phase 1) and instrumentation (Phase 0) are negligible/very-low risk
  and immediately valuable; the medium-risk capture-core refactor (Phase 2) and reconnect (Phase 3)
  should be justified by evidence, since reconnect is currently *hardening*, not a fix for an
  observed symptom (spec §2.4, A1).

---

## 3. Discrepancies & refinements found during re-verification

These do **not** contradict the spec; they sharpen it. Carried into Timeline Risks and the test
strategy.

### DISC-1 — The cited test precedent is imprecise (affects AC-1 implementation)
- **Spec §10/Q4 says:** `askService-sse.test.js` is "a *service* test → precedent for stubbing a
  service's deps (incl. `require('electron')`)."
- **Reality (verified):** `askService-sse.test.js` does **not** stub `electron`. It **extracts the
  inner SSE logic into a standalone function that mirrors the real impl** ("This avoids
  Electron/repo coupling" — file header). The *actual* precedent for mocking a `require()` target is
  **`gemini.test.js`**, which overrides `Module._load` to intercept `require('@google/generative-ai')`
  and then requires the real module.
- **Why it matters:** `sttService.js:1` does `const { BrowserWindow } = require('electron')` at module
  top, and also requires `../../common/ai/factory`, `modelStateService`, and lazily
  `../../../window/windowManager`. A direct `require('../sttService')` under `node:test` will throw
  unless `electron` is mocked. **Two viable paths for AC-1..5:**
  1. **`Module._load` interception** (mirror `gemini.test.js`): stub `electron`, `factory`,
     `modelStateService`, then `require` the real `SttService` and unit-test its methods. Highest
     fidelity; recommended for AC-1/2/4/5 which assert on real method behavior.
  2. **Logic extraction** (mirror `askService-sse.test.js`): extract the null-guard/generation/close-
     filter predicates into small pure helpers and test those. Lower coupling; acceptable if (1)
     proves brittle.
- **Resolution:** AC-1 should follow **`gemini.test.js`'s `Module._load` pattern** (the genuine
  precedent), falling back to extraction only if Electron coupling proves unworkable. The spec's
  intent (automate AC-1 now via `node:test`) stands; only the cited example file is corrected.

### DISC-2 — `sttService` has more hidden deps than `electron` alone
- `sendToRenderer` lazily `require('../../../window/windowManager')` and reads `windowPool`. Any
  direct-require test must also neutralize this (the lazy require means it only fires when
  `sendToRenderer` is called — AC-1's null-session path can avoid it, but AC-4 reconnect-status
  assertions will hit it). Mock `windowManager` to a no-op `windowPool.get()` returning a stub with
  `isDestroyed()===false` and a spy `webContents.send`.

### DISC-3 — Double assignment of `audioProcessor` (cosmetic, but note for FR-2.2)
- `setupMicProcessing` self-assigns `audioProcessor = micProcessor` at `listenCapture.js:341` **and**
  returns `{context, processor}` which the caller reassigns at `:539`. The Windows/macOS branches
  thus set the same global twice. Harmless today, but the FR-2.2 "tracked set" refactor must remove
  the in-function global write so ownership lives in exactly one place.

### DISC-4 — System-audio send IS wrapped in try/catch in the renderer; mic send is NOT
- `setupSystemAudioProcessing` wraps `sendSystemAudioContent` in try/catch (`listenCapture.js:397-405`),
  so a thrown main-process error is caught **renderer-side** and logged as "Failed to send system
  audio". `setupMicProcessing` (`:331`) and `setupLinuxMicProcessing` (`:364`) do **not** wrap. This
  means the user's *mic* "not active" lines surface as unhandled IPC-invoke rejections, while *system*
  ones surface both renderer-side and (pre-4882438) main-side. FR-1.1 (stop throwing at the source)
  cleans up **both** uniformly; no renderer change is required for the spam fix.

---

## 4. Testing Strategy (Phase 0.1)

| Check | Output |
|-------|--------|
| External APIs | Deepgram realtime WS (STT). Risk: **MEDIUM** (paid, but per-minute; no destructive side effects). OpenAI/Gemini STT paths exist but user's env is Deepgram. |
| Test types | Unit (main-process predicates via `node:test`), Manual smoke (Windows + Deepgram), Manual regression (macOS/Linux). |
| E2E permitted? | **No automated E2E against live Deepgram.** MEDIUM-risk paid API + a live-socket lifecycle is not deterministically automatable in CI here. AC-6..9 are **manual** smoke tests (matches spec §10). |
| Mocking strategy | `Module._load` interception (per `gemini.test.js`) to stub `electron`, `../../common/ai/factory` (so `createSTT` returns a scripted fake socket with `sendRealtimeInput`/`close`/`readyState`), `modelStateService`, and `../../../window/windowManager`. No real network. |

**Testing Summary**
```
Feature type: Backend-heavy (main-process lifecycle) + Minor UI (Reconnecting…/Resume status)
Quota risks: Deepgram per-minute cost during MANUAL smoke only (AC-6/7/8); zero in automated units
Estimated tests: 5 automated units (AC-1..5) phased with their FRs; 4 manual smoke (AC-6..9)
Distribution: Unit 100% of automated; Contract 0%; Integration 0%; E2E 0% (forbidden — MEDIUM paid API + live socket)
```

**Per-phase automation (Clarify Q4→B):**
- **AC-1 now (Phase 1):** null-session send ⇒ resolves (no throw) + counter increments (FR-1.1, FR-0.3).
- **AC-2..5 alongside their phases if the gate approves them:**
  - AC-2: gen-N chunk ignored when active gen is N+1 (FR-2.4).
  - AC-3: renew partial `createSTT` failure ⇒ resolved socket `close()` called + retry scheduled (FR-4.1/4.2).
  - AC-4: `onclose({1000,'client'})` ⇒ no reconnect; `onclose({1011})` ⇒ reconnect that side only (FR-3.2/D2).
  - AC-5: `isSessionActive()` false when session object exists but `readyState !== OPEN` (FR-3.1).
- **Manual AC-6..9 throughout** (Windows+Deepgram smoke; macOS/Linux regression).

**⚠️ GATE result:** Deepgram is MEDIUM (not HIGH) risk, but a live STT socket lifecycle is not
deterministically CI-automatable → **E2E FORBIDDEN here**; rely on mocked units + manual smoke. PASS.

**Phase 0 exit criteria (informs Phases 2–4):** from real-usage logs confirm (a) spam correlates
with `close: client` Stop events, (b) presence/absence of orphan-creation warnings (FR-0.4),
(c) presence/absence of any non-`client` close. These decide how load-bearing Phase 3 is.

---

## 5. Integration Analysis (Phase 0.3)

### Codebase pattern discovery
| Pattern Area | Finding |
|--------------|---------|
| IPC handler result shape | `{ success: boolean, error?: string }` (`listenService._createHandler` `:278`, `:281`; `handleSendSystemAudioContent` `:69`,`:72`) |
| Logging | `console.log/warn/error` with bracketed tags, e.g. `[SttService]`, `[ListenService]`, `[Renderer]`. Phase 0 adds a new `[stt-lifecycle]` tag (FR-0.1). |
| Provider abstraction | `createSTT(provider, opts)` via `factory.js`; each provider returns `{ sendRealtimeInput, close }` (+ proposed `readyState`/`isOpen` for FR-3.1). |
| Renderer↔main audio | `window.api.listenCapture.sendMic/SystemAudioContent` → `ipcRenderer.invoke('listen:sendMic'|'listen:sendSystemAudio')` → bridge `:149/:151` → service. |
| Capture-state push | main → renderer `change-listen-capture-state {status:'start'|'stop'}` (`listenService.js:208`,`:233`); renderer handler `renderer.js:17-29`. |

### Code reuse / interconnectedness (REUSE / EXTEND / DUPLICATE)
| Pattern needed | Existing | Decision |
|---|---|---|
| Skip-don't-throw on inactive session | macOS native loop `sttService.js:687/:699` | **REUSE** the semantics for the IPC send path (FR-1.1). |
| Monotonic generation id | none today | **CREATE** `this.sessionGeneration` (FR-0.2), reused by FR-2.4. |
| `Module._load` test mock | `gemini.test.js:27-...` | **REUSE/EXTEND** for `sttService` units (DISC-1). |
| Throttled summary logging | none (per-chunk today) | **CREATE** gap-episode throttle (FR-0.3). |
| Close-reason filter | `deepgram.js` already surfaces `{code,reason}` `:84-86` | **REUSE** the surfaced fields for the `client`/1000 exclusion (FR-3.2/D2). |
| Per-side socket recreate | `createSTT` (per side already, `:469-472`) | **EXTEND** — call `createSTT` for one side on involuntary drop (FR-3.2). |

### Data contracts (new/changed IPC)
| Payload | Current | Change |
|---|---|---|
| `listen:sendMicAudio` / `listen:sendSystemAudio` | `{ data, mimeType }` | **+ `generation`** (FR-2.4) — additive, optional; absent ⇒ treated as stale-safe default. |
| (optional) `capture-stopped` ack | — | **Not implemented** (FR-2.5 → A). Documented as future polish only. |
| `update-status` (UI) | string | reuse for `"Reconnecting…"` / reconnected / exhausted-with-Resume (FR-3.4). |

No DB schema changes. No new env vars. No migrations. (Phase 0.5 SKIPPED.)

---

## 6. Open items carried to the gate (not blockers for Phase 0/1)
- **A1 validation:** confirm orphaned-processor duplicate audio is the cause of "transcription not
  working" using Phase 0 logs (FR-0.4 orphan warnings + dropped-chunk episodes) before committing
  Phase 2 beyond the idempotent-start fix.
- **Non-`client` close presence:** gates whether Phase 3 reconnect is load-bearing or pure hardening.
- **`Done` reachability** without a preceding Stop (D-R6 verification in `MainHeader.js`).

# Quickstart — Improve STT Session Robustness

**Spec:** `specs/2026-05-30-improve-STT-sessions/spec.md`
**Plan:** `specs/2026-05-30-improve-STT-sessions/plan.md`
**Target env (user):** Windows + Deepgram **Nova-3**.

How to build, run the automated units, and execute the manual smoke/regression that validates each
phase. Phases ship in order **0 → 1 → [hard gate] → 2 → 3 → 4**; gate decides 2–4 from Phase 0 logs.

---

## 0. Prerequisites

```bash
# from repo root: C:\Users\thiago.soeiro\Documents\repos\glass\glass
npm install
# AEC (Windows/macOS mic echo-cancellation) needs the native submodule:
git submodule update --init   # builds src/ui/listen/audioCore/aec*
```

Settings the app needs to transcribe (both required — `areProvidersConfigured`):
- **STT key:** Deepgram API key → Settings → "Deepgram API Key" → Save → STT model "Nova-3 (General)".
- **LLM key:** any of OpenAI / Gemini / Anthropic / Ollama (Deepgram is STT-only).

---

## 1. Run the app

```bash
npm start          # electron .  (see package.json "start")
```

Open the Listen window; the header pill cycles **Listen → Stop → Done** (`MainHeader.js:430-435`).

---

## 2. Automated units (`node:test`, no network)

The repo uses the **Node built-in test runner** (NOT Jest):

```bash
npm test           # node --test src/**/__tests__/**/*.test.js
# or a single file:
node --test src/features/listen/stt/__tests__/sttService-lifecycle.test.js
```

**Mocking pattern (use `gemini.test.js` as the precedent, NOT `askService-sse.test.js`):** override
`Module._load` to stub `require('electron')`, `require('../../common/ai/factory')` (so `createSTT`
returns a scripted fake `{ sendRealtimeInput, close, readyState }`), `modelStateService`, and
`../../../window/windowManager`, then `require` the real `SttService`. See research.md §3 DISC-1/2.

Automated coverage (phased with their FRs — Clarify Q4→B):
- **AC-1 (Phase 1, now):** null-session `sendMic/SystemAudioContent` ⇒ resolves, no throw, counter++ (FR-1.1/0.3).
- **AC-2 (Phase 2):** chunk stamped gen N ignored when active gen N+1 (FR-2.4).
- **AC-3 (Phase 4):** renew partial `createSTT` failure ⇒ resolved socket `close()` called + retry scheduled (FR-4.1/4.2).
- **AC-4 (Phase 3):** `onclose({1000,'client'})` ⇒ no reconnect; `onclose({1011})` ⇒ reconnect that side only (FR-3.2/D2).
- **AC-5 (Phase 3):** `isSessionActive()` false when session exists but `readyState !== OPEN` (FR-3.1).

---

## 3. Contract validation (Phase 0.3 gate — already green)

```bash
cd specs/2026-05-30-improve-STT-sessions/contracts
npx tsc --noEmit --strict --skipLibCheck stt-lifecycle.contracts.ts
# Expected: no output, exit 0  ("Found 0 errors")
```

---

## 4. Manual smoke / regression (the validation that actually proves the fix)

A live Deepgram socket lifecycle is **not** deterministically CI-automatable (MEDIUM-risk paid API),
so these are manual. Watch the console for the new `[stt-lifecycle]` lines (FR-0.1).

### AC-6 — Stop/Start mashing (FR-2.*) — **the headline test**
1. Start → speak a few seconds.
2. **Mash Start/Stop ~10× rapidly.**
3. **PASS:** **zero** `User/Their STT session not active` lines; after settling, transcript is not
   duplicated/garbled; `[stt-lifecycle]` shows **no** `orphan-processor-detected` warnings (FR-0.4).
   - Phase 1 alone should already kill the *error spam* (FR-1.1). Orphan-free + no-dup requires Phase 2.

### AC-7 — Long session renewal (FR-4.*)
1. Single clean Start → leave running **>20 min** (renewal fires at 20 min; verify >25 min total).
2. **PASS:** `[SttService] Auto-renewing STT sessions…` appears once; transcript stays continuous;
   no leak/partial-failure warning; renewal reschedules if it ever fails.

### AC-8 — Involuntary drop + reconnect (FR-3.2) — **Phase 3 only**
1. Start → mid-session, kill network ~5 s (e.g. toggle Wi-Fi), then restore.
2. **PASS:** status shows **"Reconnecting…"**; transcript resumes **without** a manual Stop→Listen;
   on persistent failure (kill network >~30 s) status shows a one-click **Resume** (no restart loop).
   - *If Phase 0 logs show the user never hits a non-`client` close, AC-8 validates hardening, not a
     reported bug — Phase 3 may be deferred at the gate.*

### AC-9 — Platform regression (D3) — **must not break**
- **macOS:** `SystemAudioDump` path still transcribes "Them" (native loop sends from main, already
  guarded `sttService.js:687/:699`; generation logic must not double-guard it).
- **Linux:** mic-only still transcribes "Me"; no crash from a missing `their` reconnect target.

---

## 5. Phase 0 exit criteria (what the hard gate reads)

From real-usage `[stt-lifecycle]` logs, confirm:
1. The `not active` bursts correlate with `socket:close {reason:'client'}` Stop events (confirms §3.1).
2. Presence/absence of `orphan-processor-detected` warnings (validates A1 / decides Phase 2 depth).
3. Presence/absence of **any non-`client` close** (decides whether Phase 3 reconnect is load-bearing).

**Gate decision:** Phase 2 idempotent-start (FR-2.1) is the likely first pull-forward regardless;
Phase 3 lands only if (3) finds a non-`client` close; Phase 4 as renewal evidence warrants.

---

## 6. Files you'll touch (per phase)

| File | Phases |
|---|---|
| `src/features/listen/stt/sttService.js` | 0,1,3,4 |
| `src/ui/listen/audioCore/listenCapture.js` | 0,2 |
| `src/ui/listen/audioCore/renderer.js` | 2 |
| `src/features/common/ai/providers/deepgram.js` | 3 |
| `src/features/listen/listenService.js` | 2 |
| `src/bridge/featureBridge.js`, `src/preload.js` | 2 (generation field; ack route not implemented) |
| `src/features/listen/stt/__tests__/…` | 1 (AC-1), then per phase |
| `docs/AUDIO_AND_STT.md §5`, `docs/runbook/AUDIO_TROUBLESHOOTING.md §4`, `docs/diagrams/08-stt-session-lifecycle.mmd` | when Phase 3 lands (flip "no reconnect / Stop→Listen") |

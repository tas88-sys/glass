---
# Context Optimization Metadata
meta:
  spec_id: 2026-05-30-improve-STT-sessions
  spec_name: Improve STT Session Robustness
  phase: plan
  updated: 2026-05-30

summary:
  tech_stack: [JavaScript (Node 18+), Electron, ws, "@deepgram/sdk", node:test]
  external_deps: [Deepgram realtime STT WS, OpenAI/Gemini STT (alt providers), WASM/Rust AEC]
  test_strategy: {unit: "node:test (Module._load mock)", contract: "tsc --noEmit", e2e: "none (manual smoke)"}
  deployment: gradual    # Phase 0+1 first, hard gate, then 2-4 per evidence
---

# Implementation Plan: Improve STT Session Robustness

**Branch**: `feat/improve-stt-sessions` (spec proposes `fix/stt-session-lifecycle`) | **Date**: 2026-05-30 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/2026-05-30-improve-STT-sessions/spec.md`

## Execution Flow (/plan command scope)

```
1. Load spec → Fill Technical Context → Constitution Check          ✅
2. Phase 0.1: Research + Testing Strategy (MANDATORY)               ✅ research.md
3. Phase 0.2: Permissions (none in spec)                            ⏭ SKIPPED
4. Phase 0.3: Integration Analysis (MANDATORY)                      ✅ research.md §5 + contracts/
5. Phase 0.4: Design Pre-flight (Minor UI)                          ⏭ SKIPPED
6. Phase 0.5: Infrastructure (no env/migrations/deprecations)       ⏭ SKIPPED
7. Phase 0.6: Error/Rescue Mapping (service modules present)        ✅ below
8. Phase 0.7: Implementation Timeline Risks (MANDATORY)             ✅ below
   Phase 0.7.5: Memory re-retrieval → Prior Lessons Applied         ✅ below
9. Phase 1: Design & Contracts                                      ✅ data-model.md, contracts/, quickstart.md
10. Plan Phase 2 approach (DO NOT create tasks.md)                  ✅ below
11. STOP - Ready for /tasks command                                ✅
```

## Summary

Make the Listen audio→STT pipeline robust against its **own lifecycle transitions**. The user's
`User/Their STT session not active` errors are **null-session throw-guards** (`sttService.js:552`,
`:577`), not transport errors — proven by the `client` close reason and the `Ignoring message`
guard in the user's logs. Confirmed root cause: a **Stop/Start capture-lifecycle race** — the
renderer keeps streaming audio for a few hundred ms after the main process has nulled the sessions,
so every late chunk throws. Two reachable amplifiers: **orphaned audio processors** (non-idempotent,
non-cancelable `startCapture` overwrites globals without disconnecting) and **renewal fragility**
(reschedule sits after the throw point; partial-failure socket leaks).

**Technical approach (phased, evidence-gated):** ship **Phase 0** (instrumentation: `[stt-lifecycle]`
logs + monotonic generation + dropped-chunk counters) and **Phase 1** (guarded send — drop-and-count
instead of throw, mirroring the macOS native loop) first, then a **hard gate**. The gate decides
Phases 2 (robust capture lifecycle: idempotent/cancelable start, tracked resources, generation-
stamped audio), 3 (deep liveness + per-side same-session reconnect that excludes code 1000/`client`),
and 4 (renewal hardening) from real-usage logs. **No STT failover** — same provider/model/handlers,
locked twice (`AUDIO_AND_STT.md §5`; `gemini-failover-design/spec.md:82,:402`).

## Technical Context

**Language/Version**: JavaScript, Node.js 18+ (Electron main + renderer; CommonJS)
**Primary Dependencies**: Electron, `ws`, `@deepgram/sdk` (Deepgram Nova-3 realtime STT), WASM/Rust AEC (`aec.js` + submodule); alt STT providers OpenAI/Gemini/Whisper via `factory.js`
**Storage**: SQLite (`better-sqlite3`) for transcripts — **untouched by this feature** (no schema change)
**Testing**: `node --test` (Node built-in runner); mock via `Module._load` interception (precedent: `gemini.test.js`)
**Target Platform**: Windows (user's env: native loopback + Deepgram Nova-3); must not regress macOS (`SystemAudioDump`) or Linux (mic-only)
**Project Type**: single (Electron desktop app; main process + renderer UI)
**Performance Goals**: zero `not active` spam at Stop/Start; no boundary audio loss beyond intentional drop; renewal never silently stops; reconnect ≤6 attempts (~0.25→4 s backoff)
**Constraints**: NO provider/model failover (locked D1); reconnect MUST exclude code 1000/reason `client` (D2); keep audio-graph wiring identical in Phase 2 (change only lifecycle/ownership); additive IPC only
**Scale/Scope**: ~6 source files; hot audio IPC path ~10 msgs/s/channel; single live session per side
**System Context**: The `glass` (`pickle-glass`) Electron app's **audio/STT subsystem** — `listen` feature. No Cover Whale platform systems, no external DB, no display_id. Integration points: `factory.js` provider registry, `modelStateService`, `windowManager` (IPC to Listen window), `featureBridge`/`preload` IPC.
**Architecture Docs Read**: `docs/AUDIO_AND_STT.md` (§2 per-platform capture, §4 Deepgram, §5 resilience-vs-failover), `docs/runbook/AUDIO_TROUBLESHOOTING.md` (§4 20–30 min drop / no-reconnect), `docs/diagrams/08-stt-session-lifecycle.mmd`, `specs/2026-05-26-gemini-failover-design/spec.md` (locked STT no-failover decision).

## Constitution Check
*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Evidence |
|---|---|---|
| I. Test-First (NON-NEGOTIABLE) | ✅ Planned | AC-1 written **before** the Phase 1 guard change; AC-2..5 authored alongside their FRs (Clarify Q4→B). Tests use `node:test` (the repo's actual runner). |
| II. Specification-Driven | ✅ | `/specify`→`/clarify` (Session 2026-05-30 + 5-question pass)→`/plan` (this). `/tasks`→`/preflight`→`/feature-start`→`/implement` to follow. Artifacts generated by tooling, not hand-authored. |
| III. Verification Before Completion | ✅ | Every cited `file:line` re-verified against HEAD (research.md §0, all ✅). Contracts `tsc --noEmit` exit 0 (pasted in Phase 0.3). |
| IV. Skills Before Action | ✅ | `memory-retrieval` run inline (Phase 0.7.5); `debug-cw` evaluated and correctly N/A (no CW display_id — research.md §1); doc-search via direct reads of cited docs. |
| V. Code Review Compliance | ✅ Planned | Phase 2 capture-core refactor flagged HIGH-touch (§9 risk); keep audio-graph wiring identical, lifecycle/ownership only. |

**Re-check after Phase 1:** ✅ still PASS — no new entities violate principles; no DB/secret/permission surface introduced.

### AI & Machine Learning (Constitution Principle IV)
**Does this feature involve AI/ML?**
- [x] **No (for the XAI-transparency sense)** — STT is third-party speech-to-text (Deepgram/OpenAI/Gemini), not an in-app AI **decision** surface. This feature is **session-lifecycle plumbing** around an external STT socket: no model output is generated, ranked, or recommended by us; no confidence-scored decision is shown to the user. The XAI transparency table (explainability/confidence/rationale/override) targets in-app AI recommendations and does not apply to socket-lifecycle robustness. (The transcript itself is verbatim provider output, already shown to the user as-is.)

## Project Structure

### Documentation (this feature)
```
specs/2026-05-30-improve-STT-sessions/
├── plan.md              # This file (/plan output)
├── research.md          # Phase 0 — decisions, code re-verification, testing strategy ✅
├── data-model.md        # Phase 1 — runtime state + IPC entities (no DB) ✅
├── quickstart.md        # Phase 1 — build/run/validate ✅
├── contracts/
│   ├── stt-lifecycle.contracts.ts   # typed contracts (tsc --noEmit ✅)
│   └── EDGE_CASES.md                # 16 edge cases mapped to FRs/ACs ✅
├── spec.md              # input
├── prompt.md            # source brief
└── tasks.md             # Phase 2 output (/tasks — NOT created by /plan)
```

### Source Code (repository root)
```
src/
├── features/
│   └── listen/
│       ├── stt/
│       │   ├── sttService.js          # guards, generation, reconnect, renewal (Phases 0,1,3,4)
│       │   └── __tests__/             # AC-1 now; AC-2..5 per phase  (NEW dir)
│       └── listenService.js           # ordered teardown, init-finally review (Phase 2)
├── ui/
│   └── listen/audioCore/
│       ├── listenCapture.js           # tracked resources, idempotent/cancelable capture (Phases 0,2)
│       └── renderer.js                # capture-token coordination (Phase 2)
├── features/common/ai/providers/
│   └── deepgram.js                    # liveness probe; onclose already surfaces {code,reason} (Phase 3)
├── bridge/featureBridge.js            # +generation on audio IPC (Phase 2)
└── preload.js                         # +generation passthrough (Phase 2)

docs/   # AUDIO_AND_STT.md §5, runbook §4, diagrams/08 — update when Phase 3 lands
```

**Structure Decision**: Single Electron project (main process services + renderer UI). No
backend/frontend split, no mobile. The feature lives entirely in the existing `listen` feature
module plus the shared provider/bridge/preload seams listed above.

## Phase 0.1: Research & Testing Strategy
*MANDATORY — executed. Full output in [research.md](./research.md).*

### Production Log & Error Evidence
*Gate subsection — populated inline (no TBD).*

| Source | Query | Findings |
|--------|-------|----------|
| SigNoz (CW production) | `display_id:<id>` | **N/A** — this is the `glass` Electron desktop app, **not** the Cover Whale platform. No CW `display_id` exists anywhere in spec/prompt; no `debug-cw` match pattern fires. |
| Sentry (CW production) | project + display_id | **N/A** — no CW Sentry project for this fork. |
| `config/logging.php` | domain channel | **N/A** — no PHP monolith; Node/Electron `console.*` only. |
| **Actual source** | user runtime logs + per-line source re-verification | **Present + verified** — spec §2.1–§2.5 logs (`not active` burst, `…closed: client`, `Ignoring message - session already closed`) re-confirmed against HEAD in research.md §0 (every line ✅). |

**`PREMISE L1`:** Evidence obtained from the correct channel for a local Electron app. SigNoz/Sentry
have **no applicable target** here; the authoritative evidence is the user's runtime stack traces +
the source re-verification (research.md §0), proving the Stop/Start race mechanism at HIGH
confidence. **No production-access blocker** — repo is local and fully readable. Gate satisfied by
direct source evidence; nothing deferred to `/implement`. (The one open question — is "intermittent
transcription" *fully* explained by the race? — is a Phase-0-instrumentation hypothesis A1, not
missing root-cause evidence.)

### Research (decisions — full rationale/alternatives in research.md §2)
- **D-R1** Stop the throw → drop-and-count (FR-1.1/0.3), mirroring macOS guard `:687/:699`.
- **D-R2** Generation-stamping floor, **not** renderer ack (FR-2.4/2.5; Clarify Q5→A).
- **D-R3** Reconnect same-session, per-side, **excludes code 1000/`client`** (FR-3.2; D1/D2; Q2).
- **D-R4** Deep liveness (`readyState`) over non-null (FR-3.1).
- **D-R5** Renewal: no-leak + self-reschedule + generation-guard + overlap decision (FR-4.*).
- **D-R6** `Done` routed through teardown if reachable without Stop (FR-2.6).
- **D-R7** Phase 0+1 first → hard gate → 2–4 per evidence (Q1).

### Testing Strategy
| Check | Output |
|-------|--------|
| External APIs | Deepgram realtime WS → **MEDIUM** (paid per-minute, no destructive writes). |
| Test types | Unit (`node:test`, mocked) + manual smoke/regression. |
| E2E permitted? | **No** — live STT socket lifecycle not deterministically CI-automatable; AC-6..9 manual. |
| Mocking strategy | `Module._load` interception (precedent **`gemini.test.js`**, NOT `askService-sse.test.js` — see research.md DISC-1) to stub `electron`, `factory.createSTT` (scripted fake socket), `modelStateService`, `windowManager`. |

```
Feature type: Backend-heavy (main-process lifecycle) + Minor UI (Reconnecting…/Resume)
Quota risks: Deepgram per-minute during MANUAL smoke only; ZERO in automated units
Estimated tests: 5 automated units (AC-1..5, phased) + 4 manual (AC-6..9)
Distribution: Unit 100% of automated; Contract 0%; Integration 0%; E2E 0% (forbidden)
```

**⚠️ GATE**: Deepgram is MEDIUM (not HIGH) but live-socket lifecycle ⇒ **E2E FORBIDDEN here** →
mocked units + manual smoke. **PASS.**

## Phase 0.2: Permissions Design
**⏭ SKIPPED** — spec has no roles/permissions/access-control surface. Single-user desktop app.

## Phase 0.3: Integration Analysis
*MANDATORY — executed. Full discovery in [research.md](./research.md) §5.*

### Codebase Pattern Discovery
| Pattern Area | Finding |
|--------------|---------|
| IPC result shape | `{ success: boolean, error?: string }` (`listenService._createHandler` `:278/:281`) |
| Logging | bracketed-tag `console.*` (`[SttService]`, `[ListenService]`); NEW `[stt-lifecycle]` tag (FR-0.1) |
| Provider abstraction | `createSTT(provider, opts)` → `{ sendRealtimeInput, close }` (+`readyState` for FR-3.1) |
| Capture-state push | main→renderer `change-listen-capture-state {status}` (`listenService.js:208/:233`); renderer `renderer.js:17-29` |

### Data Contracts
| Entity | renderer→main | main state | UI |
|--------|---------------|------------|-----|
| Audio chunk | `{data, mimeType, +generation?}` (additive FR-2.4) | drop if gen≠active | — |
| Reconnect | — | `ReconnectState` per side (FR-3.2) | `update-status` string (FR-3.4) |

### Code Interconnectedness Gate (REUSE/EXTEND/DUPLICATE)
| Pattern Needed | Existing | Decision |
|----------------|----------|----------|
| Skip-don't-throw on inactive session | macOS loop `sttService.js:687/:699` | **REUSE** semantics (FR-1.1) |
| Monotonic generation | none | **CREATE** `sessionGeneration` (FR-0.2), reused by FR-2.4 |
| `Module._load` test mock | `gemini.test.js` | **REUSE/EXTEND** for sttService units |
| Close-reason filter | `deepgram.js:84-86` surfaces `{code,reason}` | **REUSE** for `client`/1000 exclusion (D2) |
| Per-side socket recreate | `createSTT` (already per-side `:469-472`) | **EXTEND** to one side on drop (FR-3.2) |

**Evidence**: LSP/line-level reads pasted in research.md §0 and §5 (no claims without source).

### Contract Validation
```bash
cd specs/2026-05-30-improve-STT-sessions/contracts && npx tsc --noEmit --strict --skipLibCheck stt-lifecycle.contracts.ts
# → (no output) exit 0  ✅ Found 0 errors
```
**⚠️ GATE**: LSP evidence pasted, contracts type-check (exit 0), EDGE_CASES.md present (16 cases) → **PASS.**

## Phase 0.4: Design Pre-flight
**⏭ SKIPPED** — UI classification **Minor**. The only UI change (FR-3.4) reuses the existing
`update-status` string channel for "Reconnecting…"/"Reconnected" and adds a one-click **Resume**
affordance on exhaustion. No Figma, no new component-library components, no design-token surface.
(If the Resume affordance grows beyond a status-line button at the gate, revisit.)

## Phase 0.5: Infrastructure & Migrations
**⏭ SKIPPED** — no env vars, no SSM, **no DB migrations**, no deprecations. The `generation` IPC
field is additive and backward-compatible. Deployment is app-version (Electron), not server rollout.

## Phase 0.6: Error/Rescue Mapping
*Service modules present → executed.*

**Error/Rescue Registry**
| Method/Codepath | What Can Go Wrong | Exception/Signal | Rescued? | Rescue Action | User Sees |
|-----------------|-------------------|------------------|----------|---------------|-----------|
| `sendMicAudioContent` / `sendSystemAudioContent` (`:547/:575`) | session null/stale (Stop/Start race) | (today) `Error('… not active')` | **Y (FR-1.1)** | drop chunk, counter++, throttled summary — **no throw** | nothing per-chunk; one `[stt-lifecycle] dropped N …` summary |
| `initializeSttSessions` partial (`:469`) | one `createSTT` resolves, other rejects | rejected Promise | **Y (FR-4.1)** | close the resolved socket (no leak); bubble for retry | (init-retry loop ≤10×); status if exhausted |
| `renewSessions` (`:518`) | renewal throws | thrown error | **Y (FR-4.2)** | **reschedule** renewal (backoff) so protection persists | continuous transcript; warn log |
| `renewSessions` + concurrent Stop | resurrection of closed session | logic race | **Y (FR-4.3)** | check `isClosing`/generation before assign → abort | clean stop; no ghost session |
| socket `onclose`/`onerror` involuntary (`deepgram.js:88`) | network/provider drop (non-`client`) | `{code,reason}` event | **Y (FR-3.2)** | per-side reconnect, backoff ≤6, atomic swap | "Reconnecting…" then resumes |
| socket `onclose` deliberate `{1000,'client'}` | Stop / renewal hand-off | event | **Y (D2)** | **ignore** (no reconnect) | normal stop/renewal |
| reconnect exhausted (6 fails) | persistent fault | — | **Y (FR-3.4)** | visible status + one-click Resume; live side keeps transcribing | "… Resume" affordance; no auto-loop |
| `startCapture` canceled mid-await | Stop during slow getUserMedia/AEC | token mismatch | **Y (FR-2.3)** | tear down built-so-far, connect nothing | no orphan; clean stop |

**Failure Modes Registry**
| Codepath | Failure Mode | Rescued? | Test? | User Sees? | Logged? |
|----------|-------------|----------|-------|------------|---------|
| null-session send | late chunk after Stop | Y | Y (AC-1) | throttled summary | Y (`[stt-lifecycle]`) |
| generation drop | stale chunk gen<active | Y | Y (AC-2) | (silent, counted) | Y (summary) |
| renew partial fail | leaked socket | Y | Y (AC-3) | none | Y |
| involuntary drop | non-`client` close | Y | Y (AC-4) | "Reconnecting…" | Y |
| deliberate close | `{1000,'client'}` | Y | Y (AC-4) | normal | Y (existing) |
| dead-but-non-null | `readyState!=OPEN` | Y | Y (AC-5) | (precheck blocks) | Y |
| orphan processor | double Start / Stop-mid-Start | Y | manual AC-6 | no dup transcript | Y (FR-0.4 warn) |
| `Done` w/o Stop | capture left running | Y (FR-2.6) | manual | clean | Y |

**GATE**: Zero rows with `Rescued=N + Test=N + User Sees=Silent`. → **PASS.**

## Phase 0.7: Implementation Timeline Risks
*MANDATORY — executed.*

| Phase | Anticipated Blocker | Resolution | Add to Task Context? |
|-------|--------------------|------------|---------------------|
| Phase 0 (instrument) | Generation id must be the SAME concept Phase 2 reuses (FR-0.2→FR-2.4) — don't invent two. | Introduce `sessionGeneration` once in `SttService`; stamp transitions now, chunks in Phase 2. | **Y** — Phase 0 task |
| Phase 1 (guarded send) | AC-1 test hits `require('electron')` at `sttService.js:1`; the cited precedent (`askService-sse.test.js`) does NOT stub electron — it extracts logic. | Use **`gemini.test.js`'s `Module._load`** pattern; also stub `windowManager` (lazy require in `sendToRenderer`). research.md DISC-1/2. | **Y** — AC-1 task |
| Phase 2 (capture core) | `listenCapture.js` is the AEC/mic/loopback heart; refactor can silently break audio (only shows in QA). `setupMicProcessing` double-assigns `audioProcessor` (`:341` + caller `:539`). | Keep audio-graph wiring **identical**; change only ownership (tracked `resources` set + token). Remove the in-function global write (DISC-3). Manual smoke per quickstart AC-6. | **Y** — Phase 2 tasks |
| Phase 2 (IPC) | Adding `generation` to the hot path (~10/s/channel) — must stay additive so an older renderer build doesn't break. | Field optional; absent ⇒ stale-safe default (E15). No preload/bridge breaking change. | **Y** |
| Phase 3 (reconnect) | A wrong reconnect double-bills audio / creates overlapping transcripts; OR fights every Stop if the `client` filter is missed. | FR-3.3 single-pipeline invariant + **mandatory** `!(1000 && 'client')` filter (D2) + atomic swap (E16). The personal-memory lesson encodes this exact trap. | **Y** — Phase 3 tasks |
| Phase 3 (platform) | Linux has no `their` channel; reconnect target absent. macOS native loop sends from main (not IPC) — generation logic must not double-guard it. | Reconnect for `their` no-ops on Linux (E12); native loop already guarded `:687/:699` (E11). | **Y** |
| Phase 4 (renewal) | The reschedule currently sits AFTER the throw point (`:483-491`) — easy to "fix" by moving the throw and accidentally drop the retry. | Reschedule in a `finally`/`catch` that always re-arms unless `isClosing`; generation-guard the assign (FR-4.3). | **Y** |
| Gate | Deciding 2–4 needs real `[stt-lifecycle]` logs; risk of shipping Phase 3 as "fix" when it's hardening. | Phase 0 exit criteria (quickstart §5): Phase 3 only if a **non-`client`** close appears. | **Y** — gate checklist |

## Prior Lessons Applied
*Phase 0.7.5 — memory-retrieval run **inline** (not forked) against the richer plan-side query
(spec Overview + draft Technical Context/Summary). Scored per the locked confidence components
(symptom-exact 0.85, keyword 0.70, name/desc≥2 0.60, filename-slug 0.55, +0.05/extra source, cap
0.97); threshold 0.55; top 5. Personal memory dir present at
`~/.claude/projects/C--Users-thiago-soeiro-Documents-repos-glass-glass/memory/`.*

| Confidence | Lesson | Source | Applied How |
|------------|--------|--------|-------------|
| 0.97 | `stt-session-not-active-is-stopstart-race`: The `not active` errors are null-guards (`:552/:577`), not a Deepgram drop; close reason `client` (`deepgram.js:72`) proves a deliberate Stop while the renderer kept streaming; root cause = Stop/Start race + non-idempotent `startCapture` orphaning processors; **any reconnect MUST exclude code 1000/reason `client`** or it fights every Stop & renewal (type: project) | `stt-session-not-active-is-stopstart-race.md` | This is the same investigation that produced this spec — reuse its locked conclusion verbatim: do **not** re-derive the cause as a transport drop (research.md §0 re-verifies it instead); build FR-3.2's reconnect with the mandatory `!(1000 && 'client')` filter (D2); treat the orphaned-processor path (FR-2.1–2.3) as a confirmed amplifier, not a guess. |

*(One entry cleared 0.55. The `MEMORY.md` index file was excluded — it is the directory index, not a
typed memory entry, and only points at the same lesson already scored.)*

## Phase 1: Design & Contracts
*Prerequisites: Phases 0.1, 0.3, 0.6, 0.7 complete; 0.2/0.4/0.5 skipped per conditions.*

**Outputs produced:**
1. **[data-model.md](./data-model.md)** — 5 runtime entities (SttService state, capture resources,
   audio IPC msg, ReconnectState, provider wrapper) + header state machine; invariants INV-1..8;
   full state-transition diagram. **No DB schema.**
2. **[contracts/stt-lifecycle.contracts.ts](./contracts/stt-lifecycle.contracts.ts)** — typed
   contracts for the wrapper liveness probe, audio payload `generation`, reconnect policy/state,
   lifecycle log record, UI status. **`tsc --noEmit --strict` exit 0** (Phase 0.3 gate).
3. **[contracts/EDGE_CASES.md](./contracts/EDGE_CASES.md)** — 16 edge cases (E1–E16) mapped to FRs/ACs.
4. **[quickstart.md](./quickstart.md)** — build/run, `node:test` units, contract validation, the
   manual smoke (AC-6..9), and Phase 0 exit criteria.
5. **Agent context** — `CLAUDE.md` refreshed via `update-agent-context.sh claude`.

**Contract tests (fail-first):** AC-1..5 assert the contract shapes/behaviors above and must be
written to fail before the corresponding implementation (Constitution I). AC-1 is in-scope for
Phase 1; AC-2..5 land with their phases (Clarify Q4→B).

**Post-Design Constitution re-check:** ✅ PASS (no new principle violations; no DB/secret/permission).

## Phase 2: Task Planning Approach
*Executed by `/tasks`, NOT `/plan`.*

**Strategy:** generate tasks per phase, in the locked ship order, constrained by the Phase 0.1
testing estimates. The hard gate after Phase 1 is itself a task/checkpoint.

| From | Task Type | Order |
|------|-----------|-------|
| Phase 0 instrumentation FRs (0.1–0.5) | Add `[stt-lifecycle]` logs, `sessionGeneration`, dropped-chunk counters, orphan-detect warn | 1st (ship) |
| AC-1 contract test | Write failing test (null-session send) | 2nd (before FR-1.1) |
| Phase 1 FRs (1.1–1.3) | Guard send (drop-and-count), keep `{success:false}` on genuine errors | 3rd (ship) |
| **HARD GATE** | Review Phase 0 logs vs exit criteria (quickstart §5); decide 2/3/4 | 4th (checkpoint) |
| Phase 2 FRs (2.1–2.6) + AC-2 | Idempotent/cancelable start, tracked resources, gen-stamped audio, `Done` hygiene | 5th (if gated in; idempotent-start likely pull-forward) |
| Phase 3 FRs (3.1–3.4) + AC-4/5 | Liveness probe, per-side reconnect (D2 filter), status/Resume UX | 6th (only if non-`client` close found) |
| Phase 4 FRs (4.1–4.4) + AC-3 | No-leak, self-reschedule, generation-guard, overlap decision | 7th (as evidence warrants) |
| Docs | Flip `AUDIO_AND_STT.md §5` / runbook §4 / diagram 08 "no reconnect" | with Phase 3 |

**Constraints**: E2E forbidden (manual smoke only); mocks (`Module._load`) before tests for the
Deepgram-coupled units; keep Phase 2 audio-graph wiring identical (ownership-only refactor).

## Progress Tracking

| Phase | Status | Skip If |
|-------|--------|---------|
| 0.1 Research + Testing | [x] | Never |
| 0.2 Permissions | [⏭] | No roles in spec ✅ skipped |
| 0.3 Integration | [x] | Never |
| 0.4 Design Pre-flight | [⏭] | Minor UI ✅ skipped |
| 0.5 Infrastructure | [⏭] | No env/migrations/deprecations ✅ skipped |
| 0.6 Error/Rescue Mapping | [x] | (service modules present) |
| 0.7 Timeline Risks | [x] | Never |
| 0.7.5 Memory Re-Retrieval | [x] | (1 lesson @ 0.97 embedded) |
| 1 Design & Contracts | [x] | - |
| 2 Task Planning (approach only) | [x] | - |

**Gates**: Constitution Check **PASS** (pre- and post-Phase 1); All NEEDS CLARIFICATION resolved
(Technical Context fully populated; `/clarify` Session + 5-question pass on record); Production-Log
gate **PASS** (premise L1 populated inline); Contract gate **PASS** (`tsc --noEmit` exit 0);
Error/Rescue gate **PASS** (zero silent-unrescued-untested rows).

---
*Based on Constitution v2.1.1. Ready for `/tasks 2026-05-30-improve-STT-sessions`.*

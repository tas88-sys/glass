# Plan: career router with Jev

Spec: [spec.md](spec.md) · Research: [research.md](research.md) (R18)

## Architecture

```
them turn ──► summaryService.triggerAnswerIfNeeded
                │
                ├─ isLikelyQuestion ──────────────► armAnswer(text)            (sync, as today)
                │
                └─ statement + career.gateUsesJev()
                     └─ career.classifyTurn ──► jevRouter.decide (≤ 700 ms)
                           personal/company and still current ──► armAnswer(text)

armAnswer ──► career.prefetch ──► jevRouter.prefetch (starts or reuses the call)
          │                   └─► embedder.prefetch (+ the anchored text when Jev sees a follow-up)
          └─► 800 ms debounce ──► career.getCareerContext ──► jevRouter.decide (≤ 250 ms more)
                                                                 │
                                    Jev answer ─► mapping (follow-up, floor) ─► route
                                    failure / budget / circuit / low ─► classifyCareerIntent (frozen)
```

## Files

| File | Change |
|---|---|
| `src/features/common/career/jevClient.js` | **New.** `buildRequest`, `parseResponse`, `post` (native fetch, hard timeout that holds even if fetch ignores the signal, `JevError` kinds). The criteria text lives here. |
| `src/features/common/career/jevRouter.js` | **New.** `createJevRouter`: config from env on each use, LRU cache, circuit breaker, mapping, fallback to `classifyCareerIntent`; `decide`, `prefetch`, `gateUsesJev`, `gateTimeoutMs`, `stats`. |
| `src/features/common/career/index.js` | `routeContext` shared by `prefetch`, `classifyTurn` and `resolve`; `resolve` awaits `router.decide`; new `classifyTurn`, `gateUsesJev`, `routerStats`; the result gains `routeSource`, `routeFallback`, `routeConfidence`, `jevMs`; `[career]` lines end with `src=… jev=…ms`. Options `router` and `fetchImpl` for tests. |
| `src/features/common/career/intentRouter.js` | Header only: frozen fallback. No rule changes. |
| `src/features/listen/summary/summaryService.js` | Statement-form gate through `classifyTurn`; `armAnswer` (prefetch with `activeCompany` + debounce); `answerEpoch` bumped on arm, pause and reset. |
| `scripts/eval-career-kb.js` | `--router`, confusion per language, comparison with the regex router, Jev p50/p95, fallbacks, release checks; answer path counted from the route on. |
| `scripts/ask-career-kb.js` | Router from `.env`; prints who decided and the Jev time. |
| `scripts/live-eval/{harness,run,report}.js` | Route source, fallback, Jev time and route wait per item; a warn check on the wait; aggregates. |

## Defaults and why

| Setting | Default | Why |
|---|---|---|
| model | `jev-1.13.0` | fixed version (D3) |
| confidence floor | 0.5 | below it the regex is at least as good a guess; calibrate with the eval |
| gate timeout | 700 ms | a statement-form turn should not wait longer than the debounce it then arms |
| resolve budget | 250 ms | the call started ≥ 800 ms earlier; this only covers the tail |
| request timeout | 1,500 ms | past both waits, so a slow answer still fills the cache |
| circuit | 3 failures / 60 s | one blip is not an outage; a minute keeps the session on regex without retry storms |
| cache | 64 entries | about ten minutes of turns |

## Rollout

1. Merge with Jev off by default for anyone without a key (C1 holds).
2. Owner: get the key, add about 40 fresh holdout questions (half PT, half EN) to the KB repo's
   `glass-eval/questions.jsonl`, and run `node scripts/eval-career-kb.js --router jev`.
3. Tune the criteria or the floor until R-SC-001..004 pass. Rerun `--router regex` to confirm the
   baseline did not move.
4. Live eval with real PT and EN audio: check R-SC-005 in the aggregates (`routeWaitMs`).
5. Put the key in `.env`. `CAREER_ROUTER=regex` is the kill switch.

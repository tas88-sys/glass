# Quickstart & Verification: Anthropic Provider Resilience

**Spec**: `2026-10-11-anthropic-provider-resilience`
**Date**: 2026-10-11

## 1. Choose a model list

In Settings, save the Anthropic API key, then type the list in **Anthropic LLM Model ID**. Models are tried in order. Transient errors, timeouts, models not available to the key, and refusals move to the next one.

| List | When |
|------|------|
| `claude-haiku-5-5,claude-sonnet-5-5` | Live interviews: fastest first answer; Sonnet covers Haiku overloads and refusals |
| `claude-sonnet-5-5,claude-haiku-5-5` | Better answers for Ask (code, screenshots) at some latency cost |
| `claude-opus-5-5,claude-sonnet-5-5` | Highest quality; slowest; thinking cannot be turned off on Opus 5.5 |

These are starting points. Pick the default after measuring time to first token (§3, check 9).

STT stays on another provider (Gemini, Deepgram, OpenAI or Whisper): Anthropic has no speech-to-text.

Optional tuning in `.env` at the repo root (`src/index.js:8` loads it):

```
# depth of thinking: low | medium | high | xhigh | max (default low)
ANTHROPIC_EFFORT=
# floor for max_tokens on models that think (default 4096)
ANTHROPIC_MIN_MAX_TOKENS=
# give up on a model with no text after this long (default 20000 Haiku, 45000 others)
ANTHROPIC_FIRST_TEXT_TIMEOUT_MS=
# give up on the whole request with no answer started after this long (default 60000; 0 disables)
ANTHROPIC_REQUEST_DEADLINE_MS=
# abort a streaming answer silent for this long (default 30000; 0 disables)
ANTHROPIC_IDLE_TIMEOUT_MS=
# server-side refusal fallback on Opus/Sonnet 5.5 (default on; "off" disables)
ANTHROPIC_SERVER_FALLBACK=
```

## 2. Automated checks

```bash
npm test                                   # whole suite, incl. anthropic*.test.js, factory.test.js, gemini*.test.js
node --test src/features/common/ai/providers/__tests__/anthropic.test.js   # the failover loop only
npm run build:renderer                     # Settings view compiles
npx -p typescript@5.4.5 tsc -p specs/2026-10-11-anthropic-provider-resilience/contracts/tsconfig.json
```

## 3. Manual verification (running app, live key)

`npm start`. Each check spends a few cents. Watch the main-process log for `[Anthropic Provider]` lines.

| # | Do | Expect | Covers |
|---|----|--------|--------|
| 1 | Save a valid key; then save `sk-ant-invalid` | First accepted; second shows "Invalid Anthropic API key." | FR-004 |
| 2 | Pick each preset in turn; ask in Ask with a screenshot | An answer each time; the log shows `outcome=ok`, `stop=end_turn`, no 400 | FR-001, FR-005, SC-001 |
| 3 | Start Listen with `claude-haiku-5-5,claude-sonnet-5-5`; let the interviewer ask a question | Live Answer streams; the log line shows `ttft` | SC-001 |
| 4 | Let Live Insights run one cycle | A summary appears (non-streaming path) | FR-021, SC-001 |
| 5 | Set the list to `claude-nonexistent-1,claude-haiku-5-5`; ask in Ask | Brief "Trying claude-haiku-5-5…", then the answer; log `outcome=unavailable status=404` | FR-011, FR-012 |
| 6 | Set the list to `claude-nonexistent-1` only; ask | "claude-nonexistent-1 is not available to this API key (retired or not enabled). Pick a current model in Settings." | FR-019 |
| 7 | Ask a long question, then ask a new one before the first finishes | The first request log ends `cancelled`; no error shown | FR-017 |
| 8 | Set `ANTHROPIC_FIRST_TEXT_TIMEOUT_MS=1` with two models; ask; unset it after | Both attempts log `outcome=timeout`; one `_reset reason=timeout` between them; the error reads "All Claude models failed (2 attempts). Last: … no text after …" | FR-013, FR-019 |
| 9 | Collect 20 Live Answers on the chosen list | Record p50/p95 of `ttft` in `research.md` (R11) | SC-006 |

A refusal and the server-side fallback cannot be triggered on purpose with ordinary content. Their handling is covered by automated tests (E28–E32, E41). The live check is that Opus 5.5 and Sonnet 5.5 requests succeed with the beta header (check 2). If they fail with a 400 naming `anthropic-beta`, the log shows the one-time "server-side fallback disabled" line, and the next request succeeds.

## 4. Rollback

Select a Gemini model in Settings. Nothing else changed for Gemini. To remove the feature, revert the branch; there is no data to migrate.

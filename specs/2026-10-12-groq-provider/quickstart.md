# Quickstart & Verification: Groq Provider

**Spec**: `2026-10-12-groq-provider`
**Date**: 2026-10-12

## 1. Your limits

Read on 2026-10-12 in the console (`console.groq.com/settings/limits`). The organization is on the **Free** plan, and Developer upgrades are "temporarily unavailable due to high demand".

| Model | Requests/min | Requests/day | Tokens/min | Tokens/day |
|-------|--------------|--------------|------------|------------|
| `openai/gpt-oss-120b` | 30 | 1,000 | 8,000 | 200,000 |
| `openai/gpt-oss-20b` | 30 | 1,000 | 8,000 | 200,000 |
| `qwen/qwen3.8-27b` | 30 | 1,000 | 8,000 | 200,000 |

What that means for Glass (research R5):
- **Each model has its own budget.** That is why the recommended list holds two text models.
- **What a call uses.** Cached tokens do not count, and the app's fixed ~2.4K-token prompt is cached after the first call. One Live Answer then uses about 3.5K tokens (2–5K) and one Live Insights about 2.5K.
- **A one-hour interview** uses about 115K (light), 240K (typical) or 390K (heavy) of the 400K a day the two text models share:
  - one interview of about an hour fits; in the typical case 120B runs out after 40–50 minutes and 20B answers the rest;
  - a 90-minute or heavy interview is borderline;
  - two in one day probably do not fit.
- **Per minute:** two Live Answers fit on 120B. A Live Insights in the same minute moves one call to 20B.
- **When the daily budget is spent,** every model answers 429 until it renews. Live Answer shows "All Groq models failed … rate limit", and no other provider takes over.
- **What else spends the budget:** testing the app on the day of an interview draws on the same daily budget, and an interview in Portuguese uses about 20–30% more tokens than in English.
- **Only tokens actually used count.** The declared `max_completion_tokens` is not metered (live check), so `GROQ_MAX_TOKENS` and `GROQ_REASONING_TOKENS` do not affect the limits.
- **Check the budget while you work.** `tpm_left` on each `[Groq Provider]` log line shows the tokens left this minute.

## 2. Choose a model list

In Settings, save the Groq API key (`gsk_…`), then type the list in **Groq LLM Model ID**. Models are tried in order. Transient errors, timeouts, requests too large for a model's limit, and models not available to the key move on to the next one. A request with a screenshot tries the models that can see images first.

| List | When |
|------|------|
| `openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b` | **Recommended.** Live Answer and Live Insights on 120B, with 20B as failover (separate rate-limit bucket); Ask with a screenshot on Qwen 3.8 (the only vision model), then 120B without the image |
| `openai/gpt-oss-20b,openai/gpt-oss-120b,qwen/qwen3.8-27b` | Fastest and cheapest first answer (~1000 tok/s); weaker answers |
| `qwen/qwen3.8-27b,openai/gpt-oss-120b` | Every lane sees images; Qwen is a preview model, 5× the price of 120B, and queued 1.5 s in the live check |

These are starting points. Confirm the choice from §4 check 9 (TTFT).

STT stays on another provider (Gemini, Deepgram, OpenAI or Whisper). Groq's Whisper is batch-only.

Optional tuning in `.env` at the repo root (`src/index.js:8` loads it):

```
# depth of thinking. gpt-oss: low | medium | high (default low). qwen3: none | default | low | medium | high (default none)
GROQ_REASONING_EFFORT=
# answer budget when the caller gives none (default 2048)
GROQ_MAX_TOKENS=
# extra budget for reasoning on models that reason (default 1024)
GROQ_REASONING_TOKENS=
# give up on a model with no text after this long (default 15000)
GROQ_FIRST_TEXT_TIMEOUT_MS=
# give up on the whole request with no answer started after this long (default 45000; 0 disables)
GROQ_REQUEST_DEADLINE_MS=
# abort a streaming answer silent for this long (default 15000; 0 disables)
GROQ_IDLE_TIMEOUT_MS=
```

`GROQ_BASE_URL`, if set in your environment, redirects the SDK. Leave it unset.

## 3. Automated checks

```bash
# SDK loads and streams under Electron's Node 20.16 (T005; plain `npm test` runs a newer Node and would not catch it)
node -e "require('child_process').execFileSync(require('electron'),['scripts/smoke-groq-sdk.js'],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:'inherit'})"
npm test                                   # whole suite, incl. groq*.test.js, factory.test.js, anthropic*, gemini*
node --test src/features/common/ai/providers/__tests__/groq.test.js   # the failover loop only (streaming and chat())
npm run build:renderer                     # Settings and onboarding views compile
npx -p typescript@5.4.5 tsc -p specs/2026-10-12-groq-provider/contracts/tsconfig.json
```

Live probe (T006, needs a key, one tiny request; prints chunk keys, timings and rate-limit headers, never text):

```bash
GROQ_API_KEY=gsk_… node scripts/probe-groq-stream.js
```

## 4. Manual verification (running app, live key)

`npm start`. Each check spends a fraction of a cent (check 10 spends nothing). Watch the main-process log for `[Groq Provider]` lines.

| # | Do | Expect | Covers |
|---|----|--------|--------|
| 1 | Save a valid key; then save `gsk_invalid` | First accepted; second shows "Invalid Groq API key." | FR-004 |
| 2 | Pick each preset in turn; ask in Ask with a screenshot | An answer each time. On gpt-oss: `images=dropped:1`. On Qwen: `images=sent:1`. `outcome=ok`, `stop=stop`, no 400 | FR-001, FR-006–FR-010, SC-001 |
| 3 | Start Listen with the recommended list; let the interviewer ask a question | Live Answer streams from 120B; the log line shows `ttft`, `queue`, `tpm_left`, `effort=low` | SC-001 |
| 4 | Let Live Insights run one cycle | A summary appears (`chat()`, which streams internally); the log line reads `once` | FR-022, SC-001 |
| 5 | With the recommended list, ask in Ask with a screenshot | Qwen answers first (`attempt 1/3 … model=qwen/qwen3.8-27b … images=sent:1`) | FR-011 |
| 6 | Set the list to `acme/nonexistent-1,openai/gpt-oss-20b`; ask | Brief "Trying openai/gpt-oss-20b…", then the answer; log `outcome=unavailable status=404 code=model_not_found` | FR-013, FR-014, R17 V5 |
| 7 | Set the list to `acme/nonexistent-1` only; ask | "acme/nonexistent-1 is not available to this API key (decommissioned, blocked or not found). Pick a current model in Settings." | FR-020 |
| 8 | Ask a long question, then ask a new one before the first finishes | The first request log ends `cancelled`; no error shown | FR-018 |
| 9 | Collect 20 Live Answers on the chosen list | Record p50/p95 of `ttft`, typical `queue` and the lowest `tpm_left` in `research.md` R14 | SC-006, R17 V4 |
| 10 | In Settings, save `openai/gpt-oss-120b, ,qwen/qwen3.8-27b`; reopen Settings; then try `openai/gpt-oss-120b,claude-haiku-5-5`, then `llama-3.3-70b-versatile` | The field shows `openai/gpt-oss-120b,qwen/qwen3.8-27b` and the model list shows it as "(custom)"; the other two are rejected, naming the entry | FR-003, E40, E55, E56 |
| 11 | Set `GROQ_FIRST_TEXT_TIMEOUT_MS=1` with two models; ask; unset it after | Both attempts log `outcome=timeout`; one `_reset reason=timeout` between them; "All Groq models failed (2 attempts). Last: … no text after …" | FR-015, FR-020 |
| 12 | Set the list to `openai/gpt-oss-20b,openai/gpt-oss-120b`; send long Ask questions (no screenshot) back to back until `tpm_left` on 20B nears 0 | 20B logs `outcome=transient status=429 code=rate_limit_exceeded`, then "Trying openai/gpt-oss-120b…" and the answer from 120B; the next request skips 20B while it cools down | FR-013, FR-014, R5, R17 V4 |

## 5. Rollback

Select a model from another provider in Settings. Nothing else changed for the other providers. To remove the feature, revert the branch. The `groq` row in `provider_settings` is harmless and can stay.

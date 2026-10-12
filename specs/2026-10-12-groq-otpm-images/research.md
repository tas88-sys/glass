# Phase 0 Research: Groq Output Limit and Screenshots

**Spec**: `2026-10-12-groq-otpm-images`
**Date**: 2026-10-12

## Sources

- **The repo** at `c03886e` (PR #16 merged): `groq.js`, `groqErrors.js`, `providerChain.js`, `factory.js`, `askService.js`, `summaryService.js`, `promptTemplates.js`, and their tests.
- **`docs/future-work.md` item 6**, written earlier the same day from an app session.
- **The app session log** of 2026-10-12, kept in this conversation's transcript (`[Groq Provider]` lines).
- **The app's settings database** (`pickleglass.db`, `provider_settings`), read-only, for the active list. Key columns were not read.
- **Groq's rate-limits page** (`console.groq.com/docs/rate-limits`, read 2026-10-12 with WebFetch).
- **Live probes** on the user's Groq key from `.env`. The scripts are in the session scratchpad (`otpm-probe.js`, `long-probe.js`, `vision-live.js`). They print status, token counts and headers, never the key or the answer text. The same numbers are on the provider's own record in `specs/2026-10-12-groq-provider/research.md` R20.

---

## R1: The incident (bug evidence)

From the app session of 2026-10-12, an Ask with a screenshot on the list `openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b` (Groq) plus Gemini:

```
[Groq Provider] attempt 1/3 stream model=qwen/qwen3.8-27b outcome=transient status=429 code=rate_limit_exceeded total=593ms effort=none images=sent:1 tpm_left=8000 request_id=req_01m4re6ap2esf9e0enz933ewmw error="Request too large for model `qwen/qwen3.8-27b` in organization `org_…` service tier `on_demand` on output tokens per minute (OTPM): Lim"
[Groq Provider] attempt 2/3 stream model=openai/gpt-oss-120b outcome=ok … images=dropped:1 tokens=in:2128,out:44,reasoning:25 …
```

- Qwen was refused before running (`tpm_left=8000`, untouched), and the refusal was classified `transient`: a 60 s cooldown.
- gpt-oss-120b answered **without the screenshot** (`images=dropped:1`). Nothing in the Ask window said so.
- The Gemini segment, which sees images, was never tried, because Groq answered.
- The limit's numbers were cut off by `error=`'s 160 characters.

Earlier the same day, four Asks with a screenshot had gone to Qwen with the same 2048 cap and succeeded (groq-provider R19). So the output split was new on Groq's side.

The active list, read from `provider_settings`: Groq row, `selected_llm_model` = `openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b,gemini-3.5-flash-lite,gemini-3.1-flash-lite`, `is_active_llm` = 1. An Anthropic key is saved (Haiku 5.5) but Claude is not in the list.

---

## R2: What Groq documents

The rate-limits page says only:
- "some organizations are also subject to separate per-minute limits on input tokens (ITPM) and output tokens (OTPM)";
- "an OTPM limit caps how many completion tokens your organization can generate per minute";
- the Limits page shows the split as "X in / Y out" when the TPM value is hovered.

It does not say whether the declared `max_completion_tokens` is compared with OTPM, what happens when it is over, or which status comes back (it documents 429 only). It lists no output-limit header. The console showed "7K in / 1K out" for both `qwen/qwen3.8-27b` and `openai/gpt-oss-120b` (future-work item 6, read in the earlier session).

So the behavior had to be measured (R3).

---

## R3: Live probes (2026-10-12)

One-word prompt ("Reply with the single word OK."), streamed, unless noted:

| Model | `max_completion_tokens` | Result |
|-------|-------------------------|--------|
| `qwen/qwen3.8-27b` (effort `none`) | 2048 | 429 "… (OTPM): Limit 1000, Requested 1679. The request's expected output tokens exceed the enforced limit; reduce max_tokens …" |
| `qwen/qwen3.8-27b` | 1001 | 429 "Limit 1000, Requested 1001" |
| `qwen/qwen3.8-27b` | 1000 | 200, "OK" |
| `openai/gpt-oss-120b` (effort `low`) | 3072 | 200 |
| `openai/gpt-oss-120b` | 20,000 | 200 |
| `openai/gpt-oss-20b` | 20,000 | 200 |

- **The refusal compares an estimate.** "Requested" is Groq's expected output, derived from the cap: 1,679 for 2,048, 1,001 for 1,001, and 1,168 for 16,384 on a request with a 1×1 image (R7). Every cap over 1,000 tried was refused.
- **No header tells it.** The headers carry only `x-ratelimit-limit-tokens: 8000` and the remaining tokens, untouched by the refusal.
- **gpt-oss is not held to 1K out**, although the console lists the same split. The real `pickle_glass_system_design` prompt ("Design a URL shortener like bit.ly.", no image, effort `low`, 12,000 declared) gave:
  - 4,204 output tokens in one request, `stop`, 9.9 s;
  - 3,841 prompt tokens, 18 reasoning tokens;
  - a one-word request right after was accepted.
- **The declared cap does not count against TPM.** A 12,000-declared request in a spent minute was refused with "Limit 8000, Used 5454, Requested 4212", which is prompt plus an estimate, not the 12,000. This confirms groq-provider R5.

---

## R4: What an Ask answer needs

| Ask mode | Prompt (`promptTemplates.js`) | Measured |
|----------|-------------------------------|----------|
| default (`pickle_glass_analysis`) | short answers | 45–850 output tokens in the app log (groq-provider R19) |
| code (`pickle_glass_code`) | five required sections: clarifying questions, reasoning, solution, time, space | 864 on an easy problem (longest substring without repeating characters); harder problems run longer |
| system_design (`pickle_glass_system_design`) | twelve required sections (0–11), diagrams, a trade-off table, ten probes | 4,204 |
| debug (`pickle_glass_debug`) | five sections | not measured |

Ask passes no `maxTokens` (`askService.js:315`). So on Groq it got the default: 2048, plus 1024 for gpt-oss's reasoning, 3,072 in all. The 4,204-token answer would have stopped at about 3,050 with `finish_reason: length`, silently. The Ask window has no truncation notice.

The project already decided that an Ask answer must not stop mid-way: `591f971`, "raise maxTokens defaults to each provider's API max" (`CHANGELOG.md`). The provider defaults are Gemini 65,536 and Anthropic 16,000 (stream). Groq's 2048 came later, with the Groq provider, and broke that rule for Ask.

---

## R5: Options considered

| Option | Screenshot reaches a model that sees it | Long answers uncut | Cost | Decision |
|--------|------------------------------------------|--------------------|------|----------|
| A. Retry Qwen once with the limit as the cap (item 6's first idea) | yes, on Qwen | **no**: cut at 1,000 tokens | small change in `groq.js` | Rejected (C2) |
| B. A per-mode `maxTokens` from `askService` | no (Qwen still refused) | yes | touches every provider. Gemini and Anthropic count thinking in their cap, so a lower number there is a new risk | Rejected |
| C. Ask the user to put Gemini first in the list | yes | yes, on Gemini | no code, but it also moves every text request off Groq | Rejected: not a fix |
| D. Raise Groq's default cap (only Ask uses it) | no by itself | yes | one constant | **Taken (D1)** |
| E. Read the 429 as `too-large` | — | — | `groqErrors.js` | **Taken (D2)** |
| F. The chain tells Groq when a later provider sees images (`visionOnly`) | yes, on the next provider | yes | small changes in `providerChain.js` and `groq.js` | **Taken (D3)** |
| G. Remember each model's output limit and skip it for larger caps | — | — | per-process state | Rejected for now (D7): a refusal costs 0.2–0.6 s and no tokens |

D, E and F together cover both problems with no change to the lanes.

---

## R6: Where `visionOnly` lives

- **The chain knows what comes later.** `decideTurn` has the ordered segments, the keys and each adapter's `seesImages`. It is the only place that can tell "a later provider will see this image".
- **The provider knows its models.** `groq.js` already has `modelTraits().vision` and `orderForImages`. Filtering `remaining` there keeps the failover, cooldowns, rounds and logs unchanged.
- **Other providers need nothing.** Gemini and Anthropic see images with every model. Gemini's `createStreamingLLM` collects unknown options into an unused `...config`, and Anthropic's destructures only what it knows. So the option is ignored there.
- **A Groq-only list never gets it**: no later segment, so `decideTurn` does not set it.
- **Live Answer and Live Insights never get it**: they send no image.

---

## R7: Checked after the change

With the real `groq.js` and the user's Groq list, on an Ask-shaped request (system prompt, question, 1×1 PNG, no cap):

| Run | Log |
|-----|-----|
| `visionOnly: true` (Gemini after Groq) | `attempt 1/1 stream model=qwen/qwen3.8-27b outcome=too-large status=429 code=rate_limit_exceeded total=219ms effort=none images=sent:1 tpm_left=8000 limit=1000 requested=1168`; then `request stream answered_by=none attempts=1`; the error is "qwen/qwen3.8-27b — asks for up to 1168 output tokens; this key allows 1000 per minute." gpt-oss was not called |
| no `visionOnly` (Groq-only list) | the same refusal, then `model=openai/gpt-oss-120b outcome=ok … images=dropped:1`: today's fallback |

The first try of this probe hit a network outage on the machine: DNS failed, `curl` exit 6. It was repeated once the network was back.

The Gemini step after the refusal was not run live. The Gemini key is stored encrypted in the app's database and was not decrypted outside the app. `providerChain.integration.test.js` covers that step over the real `groq.js` and `gemini.js` with fake SDKs, and quickstart §4 covers it in the app.

---

## R8: Regression check

The five test files of this branch were run against `main`'s code (a temporary worktree at `c03886e`, with the branch's test files copied in): 256 tests, **16 failed**. The failures are the new OTPM, `visionOnly`, default-cap and `tooLargeNumbers` cases. On the branch the whole suite passes: 1111/1111. So the tests catch each of the three problems.

---

## Summary of Decisions

| # | Decision |
|---|----------|
| R1 | Bug confirmed from the app log: Qwen refused on OTPM, gpt-oss answered the screenshot blind, Gemini never tried |
| R2 | Groq documents OTPM but not its rules; measure |
| R3 | Qwen refuses an expected output over 1,000; gpt-oss is not held to it (4,204 in one answer); the declared cap does not count against TPM |
| R4 | Ask needs thousands of tokens in code and system design; the 2048 default cut them |
| R5 | Raise the default (D1), read the 429 as too-large (D2), `visionOnly` from the chain (D3); no smaller-cap retry (D4) |
| R6 | `visionOnly` decided in `decideTurn`, applied in `groq.js`, ignored elsewhere |
| R7 | Live: one refused Qwen attempt, no blind answer with `visionOnly`; the fallback unchanged without it |
| R8 | The new tests fail on `main` (16) and pass on the branch |

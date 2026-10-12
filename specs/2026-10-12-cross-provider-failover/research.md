# Phase 0 Research: Cross-Provider Failover

**Spec**: `2026-10-12-cross-provider-failover`
**Date**: 2026-10-12

## Sources

- **The repo** at `dc71e14` (PR #14 merged): the three providers, the factory, `modelStateService`, the consumers, Settings, and the Groq and Anthropic specs.
- **The app's local settings DB** (`%APPDATA%/Glass/pickleglass.db`), read-only, under Electron's Node. Only which providers have a key and the stored lists were read, never a key value.
- **Groq**: the rate-limits page (no date on the page), and two pages quoting real daily-limit 429s, read through Composio's Exa fetch: a `continuedev/continue` issue (2026-02-28) and a Standard Time help article (2026-04-22).
- **Gemini**: the rate-limits page (last updated 2026-10-09 UTC; WebFetch could not resolve the host, so it was read through Composio's Exa fetch), and the user's **AI Studio rate-limit page** in the browser on 2026-10-12.
- **Anthropic**: model facts and prices from the Claude API reference bundled with Claude Code (`shared/models.md`).
- **The Groq console** limits, as read for PR #14 (2026-10-12, `specs/2026-10-12-groq-provider/research.md` R5).

No live model call was made for this plan.

---

## R1: What Glass does today when a provider runs out

- **One list, one provider.** The selected LLM value is one string, possibly a CSV. Its first entry decides the provider (`inferProviderFromModelId`, `factory.js:119`). The whole string goes to that provider (`factory.js:145`, `:158`).
- **Each provider fails over only within its list.** `groq.js`, `anthropic.js` and `gemini.js` each try their models in order against the shared cooldown registry (`modelHealth.js`), with their own timeouts and a second round.
- **One key per request.** `getCurrentModelInfo('llm')` returns `{ provider, model, apiKey }` for the active row only (`modelStateService.js:378-390`).
- **Settings keeps lists single-provider.** Each validator rejects other providers' IDs:
  - Gemini: `gemini-` only (`SettingsView.js:755-760`);
  - Anthropic: `claude-` only (`:793-798`);
  - Groq: `vendor/model`, not `claude-`/`gemini-` (`:821-826`).
- **The consumers are provider-neutral.** They read content deltas, `_reset` (discard and show "Trying <next_model>…"), `_final_model`, `[DONE]` and `err.userMessage` (`askStreamState.js:46-62`, `summaryService.js:258-272`, `:426-441`, `:645-650`). They do not branch on `_reset.reason`.

So when Groq's daily budget is spent, every request tries the Groq models, gets a 429 from each, and ends in "All Groq models failed … rate limit", while the user has a working Gemini key saved.

---

## R2: What a spent Groq budget looks like

**The limits** (user's organization, Free plan, console 2026-10-12): per model, 30 RPM, 1K RPD, 8K TPM and 200K TPD. The text models share nothing: each has its own budget.

**The daily-limit 429.** Groq's docs show no example body. Two real ones:
- `openai/gpt-oss-20b`, Free plan: "Rate limit reached for model openai/gpt-oss-20b in organization org_… service tier on_demand on tokens per day (TPD): Limit 200,000 · Used 199,336 · Requested 1,524 Please try again in 6m 11.52s." (Standard Time help article, 2026-04-22; the punctuation is the article's rendering.)
- `llama-3.3-70b-versatile`: "… on tokens per day (TPD): Limit 100000, Used 97050, Requested 3619. Please try again in 9m38.016s." (`continuedev/continue#10920`, 2026-02-28.)

**What follows from it:**
- **The wait is minutes, not hours.** Groq computes when enough tokens free up for this request. The budget refills continuously, and does not reset once a day. One article also claims a midnight-UTC reset, but its own example does not show one.
- **The Groq provider classifies it as `transient`** (`groqErrors.js`, status 429). The cooldown comes from `retry-after`, clamped to 5 min by the registry. A spent model is therefore tried again every 5 min.
- **It never joins the second round.** `joinsNextRound` needs a hint ≤ 2 s (`groq.js:381-388`). So a spent Groq list fails in one fast pass, about 0.1–0.3 s per model (the live queue times in PR #14 were 0.08–1.5 s).
- **A probe after the cooldown may succeed** once enough tokens have refilled, and Groq answers again until the next 429. With continuous refill, 200K a day is about 140 tokens a minute, so a ~3.5K Live Answer needs about 25 minutes of refill.

**The per-minute 429** (TPM, `retry-after` of a few seconds) is already handled inside Groq: the next Groq model has its own minute budget. The chain is only reached when every Groq model fails.

---

## R3: Which provider takes over

**Keys saved in the app** (local DB, 2026-10-12; presence only):

| Provider | Key | Stored LLM list | Active |
|----------|-----|-----------------|--------|
| groq | yes | `openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b` | yes |
| gemini | yes | `gemini-3.5-flash-lite,gemini-3.1-flash-lite` | no |
| deepgram | yes (STT) | — | — |
| anthropic | **no** | `claude-haiku-5-5` (left from an earlier selection) | no |

**Gemini: the user's project** (AI Studio → Rate limit, 2026-10-12; "Nível gratuito", i.e. free tier). Each cell reads peak usage over the last 28 days / limit:

| Model | RPM | TPM (input) | RPD |
|-------|-----|-------------|-----|
| Gemini 3.5 Flash Lite | 3 / 15 | 9.39K / 250K | 60 / 500 |
| Gemini 3.1 Flash Lite | 1 / 15 | 5.07K / 250K | 13 / 500 |
| Gemini 3 Flash | 2 / 5 | 5.07K / 250K | 7 / 20 |
| Gemini 3.5–3.8 Flash | 1 / 5 | 2.54K / 250K | 1–2 / 20 |

- Per Google's page: limits apply per project, not per key, and RPD resets at midnight Pacific.
- **What it carries.** A one-hour interview is about 50–60 Live Answers and 20–30 Live Insights (Groq R5), or 70–90 requests at about 1.5 a minute. Flash-Lite allows 15 a minute and 500 a day per model, 1,000 a day across the two. That covers several interviews a day, even if Gemini answered from the start.
- **Flash is not a fallback.** Its 20 requests a day would last about 15 minutes.
- **Risk.** The free tier is the first traffic Google sheds. `docs/GEMINI_503_PEAK_HOURS.md` recorded 503s at all hours on the newest Flash models, while both Flash-Lite models kept answering. Gemini fails over between its two Flash-Lite models, but a peak-hour 503 on both is possible.

**Claude (optional last resort).**
- Claude Haiku 5.5 costs US$0.10 per million input tokens and US$0.50 per million output tokens for prompts up to 100K tokens. It has a 1M context, and its tokenizer counts about 30% more tokens than others (`shared/models.md`).
- `anthropic.js` sends no cache control, so every call pays its full prompt.
- **Even if Claude answered a whole one-hour interview:**
  - Input: about 50 × 7K + 25 × 6K ≈ 500K tokens, about US$0.05.
  - Output, including thinking at effort `low`: about 100K tokens, about US$0.05.
  - Total: about **US$0.10–0.15 an hour**.
- As a last segment it would usually answer a few requests a day at most.
- It needs a key with credit, which is the user's decision.

**Decision (D12)**: Groq, then the two Flash-Lite models, which use keys already saved. Claude Haiku 5.5 is optional at the end, for a paid answer when Gemini's free tier sheds load.

---

## R4: Where the cross-provider loop lives

| Option | What it means | Verdict |
|--------|---------------|---------|
| A. Inside each provider | Each provider would know about the others and their keys | No: three edits of tuned, tested code, and circular knowledge |
| B. A shared failover engine | Extract the three loops into one engine with per-provider adapters, then add cross-provider lists to it | Right long-term, but a refactor of ~2,400 lines that have only partly run live (Anthropic's and Groq's T-VERIFY-MANUAL are pending). Out of scope |
| **C. Composition over the public interface** | A new module calls each provider's `createStreamingLLM` / `createLLM` with its own sub-list and key, reads its SSE stream, and moves on when it errors | **Chosen (D3).** The providers already speak one protocol; nothing in them changes (C2); each keeps its own rules |

**What C costs:**
- **It does not touch provider internals.** It cannot shorten a provider's per-model timeouts. It passes the options every provider already accepts: `requestDeadlineMs` and `retryRoundDelayMs` (`groq.js:674,720`, `anthropic.js:690,732`, `gemini.js:442`).
- **It cannot read a provider's error kind.** It only sees the final error and its `userMessage`. D4 makes that enough, since every failure moves on.
- **It parses SSE.** It reads the segment's body by events (`\n\n`) and forwards each one, as the consumers do.

---

## R5: How the factory gets the other providers' keys

| Option | Verdict |
|--------|---------|
| `getCurrentModelInfo` returns `keys`; the three call sites pass `keys: modelInfo.keys` | **Chosen (D9).** Explicit, testable with stubs, three one-line edits |
| The factory resolves keys itself through a resolver injected by `modelStateService` at startup | Hidden coupling between a pure module and the DB layer. It saves three lines and makes the factory stateful |
| `modelStateService` builds the LLM instance | Moves construction out of the factory for every provider, a much larger change to the consumers |

**Details:**
- **The consumers already pass named fields.** `askService.js:315-321` and `summaryService.js:380-387` and `:813-820` pass `apiKey`, `model`, `temperature`, `maxTokens` and the Portkey pair. Adding `keys` leaves the rest as it is.
- **Today's consumer tests stub `getCurrentModelInfo`** without `keys` (`liveAnswerCareer.test.js:57`). The factory then sees `keys: undefined`, which is valid.
- **The factory strips `keys` before every provider call**, including single-provider lists. A provider never sees another provider's key (C4).
- **No provider reads unknown options today.** OpenAI's and Ollama's `...config` is unused in their LLM functions. Gemini's is unused too (`gemini.js:283,442`). Stripping is hygiene, not a bug fix.
- **Reading the keys costs one extra DB read and decrypt per named provider per request.** `providerSettingsRepository.getByProvider` returns the key decrypted (`sqlite.repository.js:4-14`).

---

## R6: Cutting the list into segments

**Rule (FR-001):** walk the trimmed IDs; an ID's provider is `inferProviderFromModelId(id)`; when that is null (an ID with no known prefix), it joins the current segment. Consecutive IDs of the same provider form one segment.

| List (active provider) | Segments |
|------------------------|----------|
| `openai/gpt-oss-120b,openai/gpt-oss-20b` (groq) | `groq[120b,20b]`, one segment, today's path |
| `openai/gpt-oss-120b,gemini-3.5-flash-lite` (groq) | `groq[120b]`, `gemini[3.5-flash-lite]` |
| `gemini-3.5-flash-lite,custom-model` (gemini) | `gemini[3.5-flash-lite,custom-model]` (today the Gemini provider tries `custom-model`; unchanged) |
| `openai/gpt-oss-120b,gemini-x,openai/gpt-oss-20b` (groq) | three segments, interleaved |
| `gpt-4.1` (openai) | one segment (splitting applies only to anthropic, gemini, groq) |

**Why only those three.** They are the providers with lists, failover and a prefix rule. OpenAI IDs (`gpt-4.1`) and Ollama names have no rule, and the first entry of an Ollama list is matched against installed names by `modelStateService`, not by prefix. Supporting them is follow-up work.

**Interleaving** is allowed, because it costs nothing to support: each segment is a valid list for its provider. Settings does not encourage it.

---

## R7: Skipping a provider that has just failed

**The registry is shared.** All three providers mark and read cooldowns in `modelHealth.js`, keyed by model ID (Gemini through `geminiModelRotator.js`, which re-exports it). Model IDs never collide across providers.

**Today a fully cooling list is tried anyway.** When every model is cooling down, `pickModel` returns the one that recovers first (`modelHealth.js:44-59`). For a spent Groq list, that means one fast 429 per request even while cooling.

**The chain can skip it**, given one read-only query: `isCoolingDown(modelId)`. Today the module exports `parseModelList`, `pickModel`, `markFailed`, `markSucceeded` and `resetHealth`, and none of them tells the caller whether a model is cooling. Adding the query is the only edit to a shared file (C2).

**Cost per request after Groq's daily budget is spent** (recommended list):

| Request | Groq requests | Added wait before Gemini |
|---------|---------------|--------------------------|
| First after the budget runs out | 3 (120B, 20B, Qwen; each a fast 429) | ~0.3–0.9 s |
| Next ones within 5 min | 0 (`skipped-cooling`) | 0 |
| First after a cooldown ends | 1–3 | ~0.1–0.9 s; Groq answers if enough budget has refilled |

**Rule (D5):**
- **Skip** a segment whose every model is cooling down, as long as a later segment has a model that is not.
- **Run them anyway** when every remaining segment is cooling down, so a request is never refused without trying anything.

---

## R8: Time limits across providers

Each provider's own limits (defaults; env overrides exist):

| Provider | First text / first chunk | Request deadline (no answer started) | Idle | Second round after |
|----------|--------------------------|--------------------------------------|------|--------------------|
| Groq | 15 s | 45 s | 15 s | 2 s |
| Anthropic | 20 s Haiku, 45 s others | 60 s | 30 s | 2 s |
| Gemini | 25 s Lite (hedge at 10 s), 60 s others | 60 s | — | 3 s |

**Without a chain limit, the worst case adds up.** A Groq outage that accepts requests and then stalls costs up to 45 s before Gemini starts, and Gemini may then use its own 60 s: 105 s with nothing on screen.

**Chain rules (D7, FR-009, FR-010):**
- **Chain deadline 60 s** for an answer to start, across segments (`LLM_CHAIN_DEADLINE_MS`; 0 disables).
- **Each segment's deadline** is the smaller of its provider's deadline and the time left. While a later segment can run, it is the time left minus **15 s**, kept for the fallback.
  - With the recommended list, Groq gets min(45 s, 60 − 15 s) = 45 s.
  - If Groq stalls to the end, Gemini still gets 15 s. Flash-Lite's 25 s first-chunk timeout is cut to that, and its 10 s hedge still fires.
- **`retryRoundDelayMs: 0` for every segment but the last.**
  - A provider's second round waits 2–3 s for a brief overload to pass. With another provider ready, the wait is waste.
  - At 0 the second round still retries fast transient failures at once. It never retries rate limits: Groq and Anthropic need a hint ≤ the delay, and Gemini excludes 429.
- **Once text has been forwarded, no chain deadline applies**, matching the providers: a long answer is never cut.

**Typical switch cost** (Groq budget spent, first request): 0.3–0.9 s of fast 429s, then Gemini's own time to first token. SC-006 measures it.

---

## R9: Images across providers

**Today.** A Groq list routes a screenshot to its vision model first (`orderForImages`). Without one, the image is dropped and the model answers from text (`images=dropped:1`, Groq D8). Gemini and Claude models all accept images (`gemini.js` maps `image_url`; `anthropic.js:60-78`).

**With a mixed list, image-capable segments go first (D8).** Take `openai/gpt-oss-120b,openai/gpt-oss-20b,gemini-3.5-flash-lite`. Without the reorder, a screenshot question would be answered by gpt-oss without the image while Gemini could see it.

| Segment | Sees images |
|---------|-------------|
| `groq` | when one of its models has `modelTraits(id).vision` (today `qwen/qwen3.8-27b`) |
| `gemini` | yes |
| `anthropic` | yes |

**With the recommended list nothing moves.** Its Groq segment holds Qwen, so Groq stays first and routes the screenshot to Qwen itself.

---

## R10: Which failures move to the next provider

**Inside one provider**, `fatal-auth` (401/403) and `fatal-request` (400) end the request: every model shares the key and the request rules, so trying the next model would fail the same way.

**Across providers, neither is shared:**
- A revoked Groq key, a Groq 400 on a field Gemini never receives, or a Groq `too-large` on an 8K-TPM key: in each case Gemini, with its own key and 250K TPM, can still answer.
- The chain cannot see the provider's error kind anyway (R4).

**Decision (D4):** every segment failure moves on. Only a cancel stops the chain. The trail is in the log: each failed segment line carries its provider's `userMessage`.

---

## R11: Stream composition

**What the chain does with the segment's stream:**
- **It passes the stream through.** Content deltas, the provider's own `_reset`s and `_final_model` reach the consumer unchanged. The chain intercepts `[DONE]` only to close its own stream after forwarding it.
- **At a switch it sends one more `_reset`**, with `reason: 'provider'` and `next_model`. Consumers clear the partial answer, mark it as a fallback and show "Trying <next_model>…" (`askStreamState.js:46-54`; `summaryService.js:426-441`). Several `_reset`s in a row are already normal (one per Groq model).
- **The answering model is reported.** `_final_model` names the model that answered, so the Ask footer reads "answered by: gemini-3.5-flash-lite (fallback)".
- **Errors keep their shape.** Providers error their stream with an `Error` carrying `userMessage`. The chain's final error is the last one, with its `userMessage` rewritten per FR-013.
- **Cancellation goes through the reader.** Cancelling the chain's stream calls `reader.cancel()` on the segment. That runs the provider stream's `cancel()`, which aborts its in-flight request (Groq FR-018; Anthropic and Gemini the same).

---

## R12: How the user types a mixed list

| Option | Verdict |
|--------|---------|
| **Type it in the first provider's existing field** | **Chosen (D1).** No storage change; the string already flows to the factory; the user sees the whole order in one place |
| A separate "If these fail, try" field | Needs a new column or setting, a migration, and a rule for which provider's list comes first |
| A per-provider "fallback provider" dropdown | Hides the model order; still needs storage |

**Settings rules (FR-005):**
- The first entry must belong to the field's provider, so the stored row and the active provider stay consistent with `getProviderForModel`.
- A later entry may name another provider only if its key is saved.
- The other providers' fields show nothing while the list is active, which is today's behavior: a field shows the selection only when it belongs to that provider (`SettingsView.js:1385-1396`).

---

## R13: Recommended list

`openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b,gemini-3.5-flash-lite,gemini-3.1-flash-lite`

| Order | Model | Role |
|-------|-------|------|
| 1 | `openai/gpt-oss-120b` | Best Groq answers, ~0.7 s to first text (R19 of the Groq spec) |
| 2 | `openai/gpt-oss-20b` | Own 200K TPD; takes over on 120B's 429s |
| 3 | `qwen/qwen3.8-27b` | Screenshots first (Groq D8). For text it is a third 200K bucket after the gpt-oss models |
| 4 | `gemini-3.5-flash-lite` | Takes over when Groq is spent: 15 RPM, 500 RPD, free |
| 5 | `gemini-3.1-flash-lite` | Gemini's own failover; another 500 RPD |
| (6) | `claude-haiku-5-5` | Optional, after the user saves an Anthropic key with credit: a paid last resort when the free tier sheds load |

**Capacity:**
- **Groq: 600K tokens a day** across the three models. The two gpt-oss models carry about one typical interview (Groq R5), and Qwen adds roughly another hour of text answers, shared with screenshots.
- **Gemini Flash-Lite: 1,000 requests a day.**
- **Two interviews a day now fit.** The second one moves to Gemini partway through.

**Quality:**
- Flash-Lite answers are weaker than gpt-oss-120b's, but an answer beats "All Groq models failed".
- If quality on the fallback matters more than cost, Claude Haiku 5.5 can go before Gemini.

---

## R14: What stays as is

- **Longer cooldowns for daily limits** (honoring a 6–10 min hint): out of scope. The probe it would save is one fast 429 every 5 min.
- **Proactive switching** from rate-limit headers: out of scope. It needs per-provider header reading, and only Groq logs it today.
- **OpenAI and Ollama segments**: out of scope (R6).
- **The providers' own failover**: unchanged (C2).

---

## R15: To verify live (T-VERIFY-MANUAL)

| # | Question | How |
|---|----------|-----|
| V1 | Does the switch reach the consumers as designed (status, answer, footer)? | Quickstart §4 checks 4–7 with an unknown first Groq model |
| V2 | Is Groq skipped while cooling? | Check 5: `outcome=skipped-cooling`, no `[Groq Provider]` lines |
| V3 | What does the switch cost? (SC-006) | The failed segment's `total` and Gemini's time to first token from the same session |
| V4 | Is the real daily-limit 429 the shape R2 expects? | Opportunistic: when Groq's budget runs out in a real session, record the attempt line (status, code, message) and the chain lines |

### Results

*(to be filled by T-VERIFY-MANUAL)*

---

## Summary of Decisions

| # | Topic | Decision |
|---|-------|----------|
| R1 | Today | One provider per request; Settings keeps lists single-provider; consumers are provider-neutral |
| R2 | Spent Groq budget | Daily 429 with a minutes-long hint; transient, 5-min cooldown, no second round; continuous refill |
| R3 | Fallback provider | Gemini Flash-Lite (key saved, free tier 15 RPM / 500 RPD each); Claude Haiku 5.5 optional, paid |
| R4 | Where the loop lives | Composition over the providers' public interface (`providerChain.js`); providers unchanged |
| R5 | Keys | `getCurrentModelInfo` returns `keys`; three call sites pass them; the factory strips them |
| R6 | Segments | Consecutive runs by prefix; unknown IDs join the current run; only anthropic, gemini, groq |
| R7 | Skipping | `modelHealth.isCoolingDown`; skip a fully cooling segment while a later one can run |
| R8 | Time | Chain deadline 60 s; 15 s reserve for the fallback; no round wait before a fallback |
| R9 | Images | Image-capable segments first when the request has an image |
| R10 | Errors | Every segment failure moves on; only a cancel stops |
| R11 | Stream | Pass-through plus one `_reset` `reason: 'provider'` per switch |
| R12 | Settings | Mixed list in the first provider's field; first entry its own; others need a saved key |
| R13 | List | `openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b,gemini-3.5-flash-lite,gemini-3.1-flash-lite` (+ `claude-haiku-5-5` optional) |

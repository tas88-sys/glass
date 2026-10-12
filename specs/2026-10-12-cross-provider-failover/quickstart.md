# Quickstart & Verification: Cross-Provider Failover

**Spec**: `2026-10-12-cross-provider-failover`
**Date**: 2026-10-12

## 1. What runs out, and what takes over

**Groq** (console, 2026-10-12, Free plan), per model:

| Model | Requests/min | Requests/day | Tokens/min | Tokens/day |
|-------|--------------|--------------|------------|------------|
| `openai/gpt-oss-120b` | 30 | 1,000 | 8,000 | 200,000 |
| `openai/gpt-oss-20b` | 30 | 1,000 | 8,000 | 200,000 |
| `qwen/qwen3.8-27b` | 30 | 1,000 | 8,000 | 200,000 |

**Gemini** (AI Studio, 2026-10-12, free tier), per model; limits apply per project and the daily count resets at midnight Pacific:

| Model | Requests/min | Input tokens/min | Requests/day |
|-------|--------------|------------------|--------------|
| `gemini-3.5-flash-lite` | 15 | 250,000 | 500 |
| `gemini-3.1-flash-lite` | 15 | 250,000 | 500 |
| `gemini-3-flash-preview` (not recommended as fallback) | 5 | 250,000 | 20 |

What that means (research R2, R3, R13):
- **Groq carries about one typical one-hour interview a day** on the two gpt-oss models. Qwen adds a third daily budget for text once they are spent.
- **When Groq is spent**, the first request tries each Groq model once (fast 429s, under a second in all), then Gemini answers. Until a Groq cooldown ends (5 min), the requests after that go straight to Gemini.
- **Groq's daily budget refills continuously.** After a cooldown, one probe tells whether Groq has budget again, and Groq answers again when it does.
- **Two Flash-Lite models give 1,000 requests a day.** That is several interviews' worth, at about 1.5 requests a minute.
- **Gemini's free tier can return 503 at peak hours** (`docs/GEMINI_503_PEAK_HOURS.md`). A paid Claude Haiku 5.5 at the end of the list covers that. It costs about US$0.10–0.15 an hour even if it answered a whole interview, and needs an Anthropic key with credit.

## 2. Choose a list

In Settings, type the whole list in the **first provider's** model field (the Groq field for the lists below) and save. The first entry must be that provider's model; a list that starts with `claude-…` goes in the Anthropic field. Every other provider named must have a saved key.

**Order is priority**, left to right. After the first entry, another provider's models can go in any position, and more than once. Consecutive models of one provider form one block. That provider tries them in the order typed, and the next block runs only when all of them fail.

| List | When |
|------|------|
| `openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b,gemini-3.5-flash-lite,gemini-3.1-flash-lite` | **Recommended.** Uses only keys already saved. Groq first; Gemini when Groq fails or is spent |
| the recommended list + `,claude-haiku-5-5` | After saving an Anthropic key with credit. Claude answers only when Gemini's free tier also fails (e.g. 503 at peak hours), so it costs almost nothing. **Recommended place for Claude** |
| `openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b,claude-haiku-5-5,gemini-3.5-flash-lite,gemini-3.1-flash-lite` | Claude before Gemini, when steady fallback quality matters more than cost. Once Groq is spent it is skipped while it cools down, so Claude answers most requests until Groq's daily budget refills: about US$0.10–0.15 an hour of interview |
| `openai/gpt-oss-120b,claude-haiku-5-5,openai/gpt-oss-20b` | Also valid: three blocks (Groq, Claude, Groq) |

**Time by position.** An answer must start within 60 s across providers, and a block with another behind it keeps 15 s for that one. With three providers, the middle one depends on how Groq failed:
- **Groq spent** (429s, under a second): the middle provider gets about 44 s.
- **Groq stalled** until its 45 s deadline: the middle provider is skipped (`skipped-deadline`), and the last one answers with the 15 s left. With Claude at the end, a stalled Groq therefore goes to Claude; with Claude in the middle, it goes to Gemini.

**Screenshots** reorder the blocks: those that see images go first. Claude and Gemini always do; Groq only when its block has `qwen/qwen3.8-27b`. The lists above all have it, so nothing moves.

Optional tuning in `.env` at the repo root:

```
# give up on starting an answer across all providers after this long (default 60000; 0 disables)
LLM_CHAIN_DEADLINE_MS=
```

The providers' own settings (`GROQ_*`, `ANTHROPIC_*`, `GEMINI_*`) still apply within their segment.

## 3. Automated checks

```bash
npm test                                   # whole suite, incl. providerChain*.test.js, factory.test.js, modelHealth.test.js
node --test src/features/common/ai/__tests__/providerChain.test.js              # plan, timing, stream and chat() over fake providers
node --test src/features/common/ai/__tests__/providerChain.integration.test.js  # real groq.js, gemini.js, anthropic.js over mocked SDKs
npm run build:renderer                     # Settings view compiles
npx -p typescript@5.4.5 tsc -p specs/2026-10-12-cross-provider-failover/contracts/tsconfig.json
```

## 4. Manual verification (running app, live keys)

`npm start`. Watch the main-process log for `[LLM Chain]`, `[Groq Provider]` and `[Gemini Provider]` lines. Each check spends a fraction of a cent on Groq and a few Gemini free-tier requests (checks 1 and 2 spend nothing).

| # | Do | Expect | Covers |
|---|----|--------|--------|
| 1 | In the Groq field, save the recommended list; reopen Settings | The Groq field shows the whole list, with "Active list, tried in this order: Groq (3 models) → Gemini (2 models)" under it; the LLM model list shows it as "(custom)"; the Gemini field is empty and says "Your active LLM list is in the Groq field, and it already uses Gemini models…"; each model field's help has the "Mixing providers" rule | FR-005, FR-006, E46 |
| 2 | In the Groq field, try `openai/gpt-oss-120b,claude-haiku-5-5` (no Anthropic key), then `gemini-3.5-flash-lite,openai/gpt-oss-120b` | First refused, naming `claude-haiku-5-5` and the missing Anthropic key; second refused: the first entry must be a Groq model | FR-005, E47, E48 |
| 3 | With the recommended list, ask in Ask (no screenshot) | Groq answers. `[LLM Chain] segment 1/2 … provider=groq … outcome=ok`, request line `answered_by=openai/gpt-oss-120b provider=groq segments_run=1`. No Gemini request | FR-008, FR-015 |
| 4 | Save `acme/nonexistent-1,gemini-3.5-flash-lite`; ask in Ask | Brief "Trying gemini-3.5-flash-lite…", then the answer; footer "answered by: gemini-3.5-flash-lite (fallback)". Log: Groq `outcome=unavailable`, chain segment 1 `failed`, segment 2 `ok` | FR-011, SC-001, R15 V1 |
| 5 | Within 5 min, ask again | No `[Groq Provider]` line; chain segment 1 `outcome=skipped-cooling`; Gemini answers with no "Trying…" | FR-007, D5, R15 V2 |
| 6 | With the list from check 4, start Listen; let the interviewer's question play on system audio; let Live Insights run one cycle | Live Answer streams from Gemini; Live Insights runs through `once` lines on Gemini | FR-008, FR-014, SC-001 |
| 7 | Restore the recommended list; set `GROQ_FIRST_TEXT_TIMEOUT_MS=1`; restart; ask; unset it after | Three Groq `outcome=timeout` lines, then Gemini answers. Record segment 1's `total` and Gemini's `ttft` | FR-011, SC-006, R15 V3 |
| 8 | Save `openai/gpt-oss-120b,openai/gpt-oss-20b,gemini-3.5-flash-lite` (no Qwen); ask in Ask with a screenshot about something on screen | Gemini is tried first (`order=images-first`) and the answer uses the screenshot | FR-007, D8, E24 |
| 9 | With a mixed list, ask a long question, then a new one before the first finishes | The first request line ends `cancelled`; no error shown | FR-012, SC-004 |
| 10 | Save `acme/nonexistent-1,gemini-nonexistent-1`; ask | "All providers failed (groq → gemini). Last: …" naming the Gemini model | FR-013, E40 |
| 11 | Save the Groq-only list `openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b`; ask | No `[LLM Chain]` line at all; the Groq lines as in PR #14 | FR-002, G3, SC-005 |
| 12 | Opportunistic: when Groq's daily budget really runs out in a session | Record the 429 attempt line (status, code, the "Please try again in …" text) and the chain lines in `research.md` R15 | R15 V4 |

After the checks, save the recommended list again.

## 5. Rollback

Save a single-provider list in any field. Mixed lists then no longer exist, and every request takes today's path. To remove the feature, revert the branch. Stored lists that mix providers would then go whole to the first provider, which fails the IDs it does not know and moves on to its own next model.

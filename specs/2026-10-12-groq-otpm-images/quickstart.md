# Quickstart & Verification: Groq Output Limit and Screenshots

**Spec**: `2026-10-12-groq-otpm-images`
**Date**: 2026-10-12

## 1. What changed

| Situation | Before | After |
|-----------|--------|-------|
| Ask with a screenshot; Groq limits Qwen's output (1K/min); Gemini or Claude follows Groq in the list | gpt-oss answers **without the screenshot**; Gemini is never tried | Qwen is refused in ~0.2 s, then Gemini answers **with the screenshot** ("Trying gemini-3.5-flash-lite…") |
| Same, Groq-only list | gpt-oss answers without the screenshot | the same (nothing in the list can see it) |
| A long Ask answer on gpt-oss (system design ≈ 4.2K tokens) | cut at ~3K tokens (`stop=length`) | complete (`stop=stop`) |
| Qwen's output-limit refusal | read as a rate limit: Qwen cooled down for 60 s | read as too large for this request: no cooldown, so Live Answer (900) still uses Qwen |
| The log of that refusal | the numbers cut off | `limit=1000 requested=R` |
| Live Answer, Live Insights, Ask without a screenshot | — | unchanged |

Nothing to configure. `GROQ_MAX_TOKENS` in `.env` still overrides Ask's Groq cap. Leave it unset: a value at or below 1,000 would let Qwen take screenshots again, but it would cut long answers.

## 2. Which list to use

For screenshots, keep a provider that sees images after Groq. The recommended list does:

`openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b,gemini-3.5-flash-lite,gemini-3.1-flash-lite`

`claude-haiku-5-5` at the end works too: it sees images, and its key is already saved.

## 3. Automated checks

```bash
npm test                                                                   # whole suite (1111 at the time of writing)
node --test src/features/common/ai/providers/__tests__/groqErrors.test.js   # the 429 OTPM is too-large; tooLargeNumbers().output
node --test src/features/common/ai/providers/__tests__/groqRequest.test.js  # the default cap 16,384 (17,408 on gpt-oss)
node --test src/features/common/ai/providers/__tests__/groq.test.js         # OTPM failover, visionOnly, NO_VISION_MODEL
node --test src/features/common/ai/__tests__/providerChain.test.js          # visionOnly per segment
node --test src/features/common/ai/__tests__/providerChain.integration.test.js   # the user's list: Qwen refused → Gemini with the image
npx -p typescript@5.4.5 tsc -p specs/2026-10-12-groq-otpm-images/contracts/tsconfig.json
```

The live probe (research R7) needs `GROQ_API_KEY` in `.env` and spends almost nothing, since a refused request costs no tokens. Run it with the real `groq.js`, the user's Groq list and a 1×1 PNG. Pass `visionOnly: true` and expect one attempt: `model=qwen/qwen3.8-27b outcome=too-large … limit=1000`, and no gpt-oss attempt.

## 4. Manual verification (running app)

`npm start`, with the recommended list in the Groq field and the Gemini key saved. Watch the main-process log for `[Groq Provider]` and `[LLM Chain]` lines.

| # | Do | Expect | Covers |
|---|----|--------|--------|
| 1 | Ask in **System Design** mode, with a design question on screen ("Design a URL shortener") | The window shows "Trying gemini-3.5-flash-lite…", then the full answer through its last section (11. Anticipated Interviewer Probes). Log: `model=qwen/qwen3.8-27b outcome=too-large … limit=1000`, `[LLM Chain] segment 1/2 … provider=groq … outcome=failed`, `segment 2/2 … provider=gemini … outcome=ok`, and no `images=dropped` line | SC-004, G1, G2 |
| 2 | Ask in **Code** mode, with a coding problem on screen | Gemini answers from the screenshot: the clarifying questions name the problem on screen, not a generic one | G1 |
| 3 | Ask in System Design mode, typed question, with Gemini's key removed or the list cut to Groq only | gpt-oss answers (`images=dropped:1`) with all twelve sections; `stop=stop`, not `length` | G2, D5 |
| 4 | Listen with a question on the system audio (Live Answer) | Answers as before. If Qwen serves it, there is no refusal: 900 fits | G4 |

## 5. Rollback

- **The cap alone:** `GROQ_MAX_TOKENS=2048` in `.env` restores the old cap. Long answers will be cut again.
- **Everything:** revert the branch. Screenshots then go to gpt-oss without the image while Groq keeps the output limit.

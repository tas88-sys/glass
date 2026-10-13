# Jev for the career intent router: analysis and the deferred hybrid plan

**Status**: superseded (2026-10-13) by [`spec.md`](spec.md) and [`plan.md`](plan.md). The owner
chose the full switch: Jev routes every turn and the regex router is a frozen fallback. This
analysis is kept for its trade-offs; R18 in [`research.md`](research.md) records the decision.

## Context

`classifyCareerIntent` (`src/features/common/career/intentRouter.js`) routes each interviewer
turn to `personal`, `company`, `ambiguous` or `general` with about 110 English and Portuguese
regexes. It takes under 1 ms, needs no network and logs the cue that fired. Its cost is upkeep:
each phrasing that slips through needs a new regex (research R15, R16, R17; commits such as
"route Portuguese 'um dos seus'…").

**Jev** (TypeSafe AI) is a decision model: it takes a text (`state`) and typed questions
(`choice`, `score`, `noul`) and returns a choice with probabilities. It writes no text.

## Facts checked (as of 2026-10-13)

| Claim (from a search-engine AI summary) | Status |
|---|---|
| $0.042 per 1M input tokens; output free | ✅ Vendor price, repeated by [LiteLLM](https://docs.litellm.ai/blog/typesafe_jev), [eesel](https://www.eesel.ai/blog/typesafe-jev-pricing) and [DataCamp](https://www.datacamp.com/blog/system-one-models-jev). There is no official pricing page (`typesafe.ai/pricing` is a 404), and TypeSafe says it can't prove the price isn't subsidized. |
| 300 tokens ≈ $0.0000126; $1 ≈ 80,000 calls | ✅ The arithmetic is right. |
| "76x to 445x cheaper" | ⚠️ Roughly. It matches TypeSafe's own per-case eval costs: $0.0004 against $0.0304 (Terra) and $0.1761 (Opus 5), so 76x to 440x. Not independent. |
| The example JSON | ❌ Wrong shape. The [API reference](https://docs.typesafe.ai/api) uses `type: "choice" \| "score" \| "noul"` (lowercase), `instructions`, and `criteria` as a map of option → description. Answers come back in `answers.<id>.choice`, `.probabilities` and `.confidence`, not `results`/`selection`. There is no `total_cost_usd`. `score` is a rubric of 2 to 10 levels, not a 0–10 grade. Yes/no is `noul`. |
| "Guarantees the schema shape" | ⚠️ Vendor claim ("0% structured output error"). Plausible, since the output is bounded. |
| "Case studies from the Brazilian community" | ❓ Nothing found. Likely made up by the summary. |

**What the summary leaves out:**
- **Access:** early access behind a waitlist (console.typesafe.ai). Also served by Cloudflare Workers AI and the Vercel AI Gateway.
- **Language:** the [models page](https://docs.typesafe.ai/models) says *"English is the primary training language and where accuracy is currently best"*. Other languages are *"handled but not equally well"*. Half the router's cues and most of its tuning are Portuguese.
- **Accuracy:** in TypeSafe's own eval, Jev agreed with the reference 67.8% of the time, against 67.9% (GPT-5.6 Terra), 74.1% (Sol) and 73.1% (Opus 5). The 4 workflows were written by TypeSafe, and nobody has reproduced the test independently.
- **Latency:** 70–500 ms per the vendor, 0.4 s average in its eval. SC-004 today asks for at most 20 ms at p95 on the answer path.
- **Limits:** 64k tokens per request (32k for `state` plus the longest question), 80 req/s, 100k tokens/s. A choice takes up to 255 options.
- **Privacy:** "Jev is not trained on customer requests or responses". Zero data retention is for enterprise customers only.

## Trade-offs for Glass

**Cost decides nothing.** One `choice` with 4 criteria plus the turn is about 400 tokens, or
$0.000017 per turn. A one-hour interview, with about 150 turns through the gate, costs under
$0.003. The regex router costs nothing.

**For**
- It handles phrasings and STT errors that are not in the tables, which cuts the "miss → new regex" loop.
- It returns probabilities, so a confidence threshold can replace the fixed "first match wins" order.
- The regex tables could stop growing.

**Against**
- **It can only be added, not swapped in.** The answer gate (`hasCareerCue`, `summaryService.js:656`) is synchronous and runs on every segment; it cannot wait on the network. Network errors, 429/529 and timeouts also need a fallback, which would be the regex router. Both implementations stay.
- **Weaker Portuguese**, by the vendor's own docs, exactly where the regexes were tuned most.
- **Latency:** 70–500 ms on the network. It can only be hidden by starting the call when the gate accepts the turn, inside the 800 ms debounce, as the query embedding prefetch already does.
- **Privacy:** the interviewer's turn goes to one more third party. `intentRouter.js` says today that "the turn text never leaves this module". The manifest's names (employers, projects) must not go.
- **Less explainable:** today's log names a cue (`behavioral:pt-uma-vez`); with Jev it would show `jev:personal@0.91`, with no reason.
- **Immature dependency:** early access, a waitlist, and rate limits that change without notice.
- The Jev path can only be unit-tested with a fake `fetch`.
- Research R6 rejected an LLM classifier for latency and quota. Jev answers the quota part, not the latency part.

## Recommendation: don't swap. Measure first, then add Jev as an opt-in tie-breaker.

A straight swap would hurt latency, Portuguese and privacy, with no cost gain. The only possible
gain is accuracy on phrasings the regexes miss, and the existing eval can measure it. Phase 1
happens **only if Phase 0 passes**.

### Phase 0: measurement spike (decides whether it is worth it)

Prerequisites (owner):
1. Jev access (waitlist, or Cloudflare/Vercel) and a `TYPESAFE_API_KEY`.
2. Consent to send the questions in `glass-eval/questions.jsonl` (real interview questions, kept in the KB repo) to TypeSafe.

Steps:
- `scripts/eval-career-kb.js --router regex|jev|hybrid|embed`. Output stays ids, counts and timings only (spec C5).
  - `jev`: the POC router (one `choice` with 4 criteria; the previous question in `state`).
  - `hybrid`: company cues, the follow-up rule and manifest names stay regex; when the regex says `ambiguous` or `general`, Jev decides if its confidence clears a threshold.
  - `embed`: the local semantic fallback R6 already foresaw: nearest prepared question line with the Arctic Embed model that is already loaded. Free, offline, multilingual. If it ties with Jev, it wins for needing no network or third party.
- Full and holdout confusion matrices, split by Portuguese and English. Jev call p50/p95 from Brazil.

**Go criteria** (holdout):
- `hybrid` raises `personal→personal` or lowers `general→personal` by at least 5 points;
- the Portuguese subset does not get worse;
- Jev p95 at most 600 ms, so it fits inside the 800 ms debounce.

If it fails, record the result as R18 in `research.md` and keep the regex router.

### Phase 1: hybrid, opt-in integration (only if Phase 0 passes)

- **`jevRouter.js`** (the POC module, reused): native `fetch` (Node 20.16), no SDK; result cached by text; a stale call aborted when a new segment arrives; `null` on timeout, 4xx/5xx, a malformed body or low confidence.
- **`index.js`**: `prefetch()` also starts the Jev call. `resolve()` runs `classifyCareerIntent` as today; when the route is `ambiguous` or `general` and there is no follow-up cue, it waits for Jev for what is left of a ~150 ms cap after the debounce fires (as the embedding does, R10). A confident Jev route replaces the regex route.
- **`hasCareerCue`** stays 100% regex. **`intentRouter.js`** is unchanged; `stripCuePhrases` is still needed, since Jev writes no text.
- **Config:** `CAREER_ROUTER=hybrid` plus `TYPESAFE_API_KEY`, default `regex`. The flag means "turn text goes to TypeSafe".
- **Sent to TypeSafe:** the turn and the previous question only. Never `entities` or `companyNames`.
- **Log:** `cue=jev:personal@0.91 jev=212ms`. Never the turn text.

Tests:
- `jevRouter.test.js` with a fake `fetchImpl` (request shape, answer parsing, timeout, 429/529, malformed JSON, low confidence, abort).
- Module tests: with the flag off, results are identical to today; with it on, Jev only overrides `ambiguous`/`general`, never `company` or a follow-up.
- The `general` route's prompt stays byte-identical to today's.

Docs: this folder's `spec.md`/`research.md`; `docs/LIVE_INSIGHTS_AND_ASK.md` (router section);
`docs/diagrams/14-career-intent-router.mmd` (a Jev branch after ambiguous/general);
`ARCHITECTURE.md:1298`; and a pointer from the old research R6.

## Verification

- `npm test`: career and summaryService suites green with the flag off.
- `node scripts/eval-career-kb.js --router regex` matches today's numbers; `--router hybrid` reproduces the spike's gain.
- `node scripts/ask-career-kb.js "Me conta de um perrengue que você passou"` with `CAREER_ROUTER=hybrid` prints the route, a `jev:` cue and the latency.
- Live eval (`scripts/live-eval/run.js`) with real PT and EN audio: the `LIVE_ANSWER_DEBUG` log shows Jev returning before the debounce ends, and no answer is delayed.
- Network down (or a bad key) during a session: answers keep flowing on the regex route with no visible error.

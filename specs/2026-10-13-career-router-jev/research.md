# Research: career router with Jev

Follows research R1–R17 of `specs/2026-10-11-live-answer-career-context/research.md`.

## R18: Jev in place of the regex router

**Decision**: Jev routes turns. The regex router is frozen and decides only when Jev cannot.

### Facts checked (2026-10-13, primary sources)

| Claim (from a search-engine AI summary) | Status |
|---|---|
| $0.042 per 1M input tokens, output free | ✅ docs.typesafe.ai/models: "Charged per input token. Output tokens are free." There is no pricing page (`typesafe.ai/pricing` is a 404). |
| 300 tokens ≈ $0.0000126; $1 ≈ 80,000 calls | ✅ The arithmetic is right. |
| "76x to 445x cheaper than LLMs" | ⚠️ From TypeSafe's own eval (per case $0.0004 against $0.0304 and $0.1761). Not independent. |
| The example request and response JSON | ❌ Wrong shape. The API (docs.typesafe.ai/api) uses `type: "choice" \| "score" \| "noul"`, `instructions`, and `criteria` as a map of option → description. Answers come back as `answers.<id>.choice / .probabilities / .confidence` (a `noul` as `answers.<id>.noul`). `usage` has `input_tokens` and `output_tokens` only. |
| "Guarantees the schema shape" | ⚠️ Vendor claim. Plausible, since the output is bounded; the client still validates every field. |
| "Case studies from the Brazilian community" | ❓ Nothing found. |

**What the summary leaves out:**
- Early access with a waitlist (console.typesafe.ai).
- *"English is the primary training language and where accuracy is currently best. Other languages … are handled but not equally well; test on your own content."* (models page).
- 64k tokens per request; 80 requests and 100k tokens per second; `429` and `529` to be retried with backoff.
- Not trained on customer requests; zero data retention for enterprise customers only.
- `jev-latest` and `jev-preview` are aliases that move with each release (today `jev-1.13.0`).
- 70–500 ms per call (vendor).

### Rationale

- **Cost decides nothing.** About 500 input tokens per call, or $0.00002. A one-hour interview costs under $0.01.
- **Upkeep is the gain.** Each miss used to be a new regex. Now it is a measured change to the criteria in `jevClient.js`.
- **Latency is hidden, not removed.** R6 rejected an LLM classifier for seconds of latency and for quota. Jev answers in hundreds of milliseconds, and the call starts when the gate accepts the turn, inside the 800 ms debounce (R10's prefetch pattern). The answer waits at most 250 ms more.
- **The fallback is required.** The network, a 429/529 or a revoked key must not take the notes away mid-interview. The tuned regex router is that fallback, so freezing it costs nothing.
- **Portuguese is the risk.** Most of the eval set (75 of 100) and most of the regex tuning are Portuguese. That is why the release checks compare per language, and why each criterion carries an English and a Portuguese example.
- **Privacy (owner decision).** The turn, the previous question, the interviewer's company and the manifest's names go to TypeSafe. The flag and the key make that explicit; a `CAREER_ROUTER` typo reads as `regex`.

### Alternatives considered

- **Hybrid (regex first, Jev only on `ambiguous`/`general`).** Smaller change and less data sent. Rejected by the owner in favor of the full switch. The earlier analysis is in `hybrid-plan.md`.
- **A local embedding fallback** (nearest prepared question with the Arctic Embed model already loaded). Free and offline. Left for later: it would replace the regex as the fallback, not Jev.
- **SDK (`@typesafe-ai/sdk`).** Its retries do not fit the live budget, and native `fetch` covers the rest.

### Results (2026-10-13, jev-1.13.0, confidence floor 0.5)

The owner's set grew from 100 to 133 items. q101–q133 are new holdout items: 33 real English
interviewer turns taken from the app's own transcripts, deduplicated against the existing items
and labeled before any router ran. A separate synthetic set has 40 items (30 PT, 10 EN), written
by the author of the Jev criteria, so it is biased toward Jev: a signal, not proof.

| Set | Jev | Regex |
|---|---|---|
| New real holdout (33, EN), exact route | 33/33 | 29/33 |
| Synthetic (40), exact route | 40/40 | 35/40 (all 5 misses PT) |
| Old PT items (75, all used to tune the regex), personal → personal | 91.1% | 95.6% |
| Whole real set, general → personal | 0% | 0% |

- Jev call p50/p95: about 280/340 ms from the owner's machine.
- 6 of 133 turns fall below the floor (4.5%), and the regex decides them. With the floor at 0 there is one more miss (q126), so the floor stays at 0.5. The fallback earns its place, so R-SC-004 moves from ≤ 2% to ≤ 5% (owner decision, 2026-10-13).
- **Release checks:** R-SC-001 fails only on Portuguese. All 75 Portuguese items are tuning items for the regex, and no real Portuguese item is fresh, so that comparison favors the regex. R-SC-001 stays as written (owner decision, 2026-10-13): measuring it on the holdout per language would leave Portuguese untested, since the holdout has no Portuguese items yet. Fresh real Portuguese questions are what would settle it.
- **Live eval with Groq, Gemini and Deepgram blocked:** no blocked request was attempted, routes came back 11/12, and the route wait was p95 0.3 ms. It also found company intros being answered, which was fixed in the criteria.

### Superseded

R6's "an LLM classifier is rejected" still holds for generative LLMs. Jev is a decision model with bounded output and sub-second latency, and the latency it does add is hidden inside the debounce.

## R19: what a real session showed, and the gate it led to

**Decision**: the live gate drops acknowledgments locally and asks Jev, in the same call, whether
the turn asks the candidate for something now (`asks`). The interviewer's previous segment goes
with the turn. The criteria name project details as personal. Floor unchanged (0.5).

### The session (2026-10-13)

A 71-minute Portuguese interview with Jev on (deep dive into the candidate's projects, then the
candidate's questions about the company), recorded with `LIVE_ANSWER_DEBUG=1`. 385 segments, 179
from the interviewer. Each interviewer segment was labeled by hand, before any replay:
`y` an answer should appear (43), `n` it should not (115: acknowledgments, fillers, "pardon?",
the interviewer telling something), `e` either (21: a fragment the next segment completes, a
confirmation). The labeled file lives in the KB repo (`glass-eval/sessions/`), never here (C5).

What the log showed:

- 114 answers in 71 minutes, 56 of them on `n` segments. "Aham.", "É.", "1" (the STT's "um")
  and "Boa." armed answers: as statements they went to Jev, and with a previous personal question
  in the window, Jev read them as follow-ups. "Hã?" passed the '?' rule.
- Each answer costs about 5,000 Groq input tokens. Groq answered 429 56 times in the session, most
  in the 20 minutes with about three answers a minute; a wasted answer also replaces the one on screen.
- Below the floor (13% of answers, against 4.5% in the eval) the regex misrouted both ways:
  clarifications about the candidate's own project went general; the interviewer presenting the
  company went personal.

### Replay

`scripts/replay-career-session.js` runs a labeled session through the app's own gate and router
(Jev live, no LLM). It reproduces the session: 115 armed against 114 in the log, 58 follow-ups
against 59.

Calibration session (the one above):

| | Jev before | Jev after | Regex (with the backchannel gate) |
|---|---|---|---|
| Answers armed | 115 | 80 | 77 |
| `y` armed | 41/43 | 42/43 | 36/43 |
| `n` armed (wasted LLM calls) | 56 | 24 | 26 |
| Route errors on armed `y`/`e` | 5/59 | 1/56 | 26/51 |

Without the backchannel gate the regex armed 82 (31 wasted). The thresholds were set on this
session, so it is not evidence for them. Five older sessions are: English, 2026-07, labeled before
any replay (62 `y`, 24 `e`, 165 `n`), two coherent interviews and three whose STT ran in English
on Portuguese speech:

| | Jev before | Jev after | Regex |
|---|---|---|---|
| Answers armed | 115 | 109 | 93 |
| `y` armed | 61/62 | 61/62 | 60/62 |
| `n` armed | 36 | 28 | 18 |
| `n` armed, coherent sessions only | 13 | 7 | 8 |
| Route errors on armed `y`/`e` | 18/79 | 19/81 | 29/75 |

Most route errors on the older sessions are personal against ambiguous on "how do you…" turns,
where the labels themselves are soft. 17 of the 28 wasted come from one wrong-language session:
Jev reads meaning into STT garbage (asks 0.34–0.63) where the regex finds no cue. Known limit; the
STT language is the fix.

### What changed

- **Backchannel gate (local).** A them segment whose words are all acknowledgments, fillers or
  "pardon?" (EN and PT, at most 8 words, "1" included) arms nothing and costs no Jev call. 62 of the
  115 `n` segments, no `y` or `e` among them.
- **`asks` (noul, every call).** A statement-form turn arms when the route is personal or company
  and asks ≥ 0.3 (a regex decision, with no asks, arms on its route as before). A question-form turn
  is still armed at once, and is dropped when the debounce fires if asks < 0.2: before it costs an
  LLM call or replaces the answer on screen. Calibration: on question-form segments the lowest real
  questions scored 0.22 and 0.27, while 8 monologue segments with a rhetorical question scored
  below 0.2; on statement-form segments implicit questions (the interviewer restating what the candidate did and pausing)
  scored 0.34–0.48, and fragments and reactions mostly 0.14–0.29.
- **`interviewer_before`.** The STT cuts one question into segments seconds apart, and Jev saw only
  the last piece. The interviewer's previous segment (≤ 400 chars, when it began ≤ 20 s earlier)
  goes in the state. It is interviewer speech, the same kind of data as the turn (C3 updated).
- **Criteria.** `personal` now names the details of a project the candidate did or described (how
  it worked, numbers, choices, what they meant); `general` is a technical question not about the
  candidate's own work. Route errors on the session went from 7 to 0 with this change alone.

### Eval after the change (133 real items, jev-1.13.0, floor 0.5)

| | Before R19 | After |
|---|---|---|
| personal → personal, all | 94.7% | 96.1% (regex 96.1%) |
| holdout (47) | 95.8% | 100% (regex 95.8%) |
| en (58) | 100% | 100% (regex 96.8%) |
| pt (75, regex tuning items) | 91.1% | 93.3% (regex 95.6%) |
| general → personal | 0% | 0% |
| below the floor | 6 (4.5%) | 9 (6.8%) |
| routing misses | 5 | 6: q090 fixed; q119 and q121 new, both ambiguous items |
| SC-001 (personal → personal ≥ 95%) | FAIL | PASS |

Synthetic set: 40/40, unchanged. Floor 0 was tried: best on the session (43/43 armed, no route
error) but 94.7% on the eval (SC-001 fails, q040 and q090 go wrong), so the floor stays at 0.5.
0.45 and 0.4 lose q090 too. R-SC-004 now fails by two items (6.8% against 5%), every one of them
below the floor, none a service failure.

**R-SC-001 for Portuguese.** The owner kept R-SC-001 as written until fresh real Portuguese
questions existed (R18). The session is that: on its 56 armed `y`/`e` segments (all personal),
Jev routes 55 personal, the regex 25 of 51. The old Portuguese items stay in the eval, and the
replay is the Portuguese check from now on (R-SC-007).

### Cost and latency

`asks` adds about 200 input tokens per call (under US$ 0.00003 a call). Jev p50/p95 in the replays:
300/450 ms. The backchannel gate removes about a third of the calls in a session.

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

## R20: a second transcript of the same session, the candidate's-questions moment, and Jev's variance

**Decision**: the `company` criterion also names the interviewer inviting the candidate's own
questions (about the company, the team, the role or the process). The regex stays frozen. The
session labels were corrected where the second transcript shows what a segment was.

### The second transcript

The owner also recorded the R19 interview with another recorder (Wispr Flow): whole turns with the
speakers named, no timestamps. It lives in the KB repo, never here (C5). Read against the app's own
segments:

- **What the app's STT lost.** Every interviewer question reached the app except the end of one (a
  confirmation question lost in garbled speech). The app's recording started about a minute and a
  half in, after the greetings.
- **Split questions.** About 10 of the roughly 45 interviewer questions reached the app in two or
  three segments. That confirms `interviewer_before` (R19) on evidence not used to design it.
- **Labels.** 6 segments labeled `n` were parts of questions: the first words of one, a disbelieving
  confirmation the candidate answered, a question whose end the STT lost. They are `e` now. Two
  segments swapped `y` and `e`, since the question was in the first one. The corrections were made
  after the R19 replay results were known, by the same rule for both routers, so the numbers below
  give both label sets.

### The miss: "do you have any questions for us?"

The session ends with the interviewer inviting the candidate's questions about the company. Neither
router armed an answer: Jev read it as general with low confidence, so the regex decided, and the
regex found no cue. The KB has sections written for this moment (the candidate's questions for each
company), and on the company route the retrieval ranks them first (checked with `ask-career-kb.js`).
Only the routing was missing. (Correction, R21: that check used the clean English invitation. For the
session's own Portuguese invitation the retrieval did not find those notes; R21 fixes it.)

Offline, with `interviewer_company` set: 6 invented invitations (3 PT, 3 EN, short and long), the
session's own invitation, and 8 controls (2 company questions; 6 others, among them "take your time,
feel free", "feel free to bring another project", the interviewer presenting the company, and "any
questions about the problem before you start coding?"):

| | Invented invitations, company ≥ 0.5 | The session's invitation | Controls kept right |
|---|---|---|---|
| Criterion before | 2/6 | no (general, 0.45) | 8/8 |
| With the invitation clause | 6/6 (confidence 0.93–1.00) | yes (company, 1.00) | 8/8 (one went company at 0.27, below the floor, so the regex decides) |

The interviewer's closing "if you have more questions, feel free", after the candidate's questions,
stays general either way (asks 0.07; labeled `e`).

### Results with the change

- **Eval (133 real items):** routing identical but for q040, a miss before and after (personal →
  general, now → company in one of two runs). Synthetic set: 40/40.
- **The session:** the invitation routes company at 1.00 in both runs and is armed.

  | Corrected labels (43 `y`, 27 `e`, 109 `n`) | `y` armed | `n` armed | Route errors |
  |---|---|---|---|
  | Jev, before the change | 42/43 | 20 | 1 |
  | Jev, with the change, run 1 | 43/43 | 22 | 1 |
  | Jev, with the change, run 2 | 42/43 | 21 | 1 |
  | Regex | 36/43 | 25 | 27 |

  With the R19 labels the same runs read: Jev before 42/43, 24 wasted; after 43/43, 26; regex 36/43, 26.
- **The five validation sessions:** `y` 61/62 and 27 wasted (7 on the coherent sessions), against
  61/62 and 28 (7) before the change.

### Jev is not deterministic

Two replays of the session with the same code and the same inputs differ in 4 of 179 armed
decisions (2%): the probabilities move by up to about 0.05, so turns near asks 0.3, the 0.2 veto or
the 0.5 floor flip. In the evening the eval had 11, 12 and 11 items below the floor over three runs
(8.3–9.0%), against 9 (6.8%) in the morning. The KB also gained notes in between, which changes the
names in the state, so the two causes are not separated. What follows from it:

- Differences of one or two segments or items between single runs are noise.
- A release check near its limit (R-SC-004) needs several runs; it fails in all of them today.

## R21: what the answers were built on, and the invitation's notes

**Decision**: Jev also answers, in the same call, whether the interviewer is inviting the candidate's
questions (`invites`, noul). On the company route with invites ≥ 0.5 the query is the moment's
("your questions to ask the interviewer", in both languages, plus the company), not the turn's
words, and the addendum asks for two or three questions for the candidate to ask.

### Why

The owner asked how good the session's answers had been. The app kept none (now it does: spec
`2026-10-13-live-answer-history`), so `replay-career-session.js --answers --no-llm` rebuilt, for
each armed `y` segment, the notes block the prompt carried, over the KB as it stood at the
interview (its commit before the session: 78 files and 2,512 sections against 79 and 2,539 in the
log). The KB had since gained the session's own transcript and debrief, which the retrieval put in
almost every answer; a rebuild over today's KB would have been contaminated.

What the rebuild showed (the details stay in the KB repo, C5):

- On the deep dive into one project, the specific fact a question asked for (a number, a component,
  a design choice) was in the block for 5 of 21 checked questions. The KB holds most of those facts,
  but spread over many interview-prep notes, with no single note on the project; the retrieval
  brings a different fragment each time. Three facts the interviewer asked for are not in the KB.
- A past interview's transcript filled a block slot in most answers.
- The invitation to ask questions, routed company since R20, still drew no questions-to-ask note:
  its words ("tirar dúvidas que você tiver sobre a empresa, sobre o processo") match other sections.

### The change and its check

- `jevClient`: `questions.invites` (always sent, about 80 tokens). `jevRouter`: decisions carry
  `invites` (null on a regex decision). `index.js`: the invitation query and addendum; the debug
  line shows `cue=…+invite`. The regex router stays frozen.
- Jev live, on the R20 offline set: invites 0.82–0.96 on the 8 invitations, 0.02–0.14 on the
  controls but one ("feel free to bring another project", 0.72), whose route is below the floor, so
  nothing changes there.
- Retrieval for the session's invitation, on the interview's KB and on today's: the candidate's
  general questions-to-ask section, the Q&A bank's reverse questions and the company's own "your
  questions" section are all sent (before: none of them).
- Eval (133): unchanged (96.1%, holdout 100%, 11 below the floor, same misses). Synthetic: 40/40.
  Replays: the session `y` 42/43, 20 wasted, 1 route error; the validation sessions `y` 43/44 and
  18/18, 7 and 0 wasted (within the run-to-run variance of R20).

### Not done

The answers themselves were not rebuilt: the provider's daily token quota ran out after 7, and those
7 used today's KB, so they were discarded. `--resume` with `--kb <the interview's commit>` rebuilds
them when the quota is back.

## R22: questions about the candidate's own setup, and technical turns routed personal

**Decision**: Jev's `personal` criterion adds how the candidate works (the tools, setup and workflow
they use, including how they use AI), with one more example pair. The `general` criterion adds a
question about the code or the solution being worked on in the interview, even when it says "you"
or "your". The frozen regex router gets two cues, `background:your-setup` and its Portuguese twin
`background:pt-seu-setup`, because the live case was decided by the regex: Jev answered below its
confidence floor. Routing on the extracted question instead of the whole turn was measured and not
adopted. Future-work item 13.

### Why

In the 2026-10-29 session a turn about the candidate's AI setup ("your AI setup, your CLAUDE.md,
the skills you usually use") routed general (`regex(low)`: Jev below the floor, no regex cue). No
notes were sent, and the answer described a setup the candidate does not use. Since item 9 that turn
gets no answer (it asks nothing), so the check uses direct questions about the setup. Item 9 also
left the opposite error: two technical turns of the 2026-10-28 session routed personal (a scenario
led by "você conhece algum recurso…", by the regex cue `experience:pt-voce-habito`; and "escalável
pelo quê?", `jev:personal@0.60` in one run).

### The check

A new set of 36 turns, written before any router ran on them and kept in the KB repo (C5):
16 questions about the candidate's setup, tools and AI workflow (personal), and 20 technical or
live-coding turns with the same words ("your setUp method", "o setup do Jest", "what's a CLAUDE.md
for?"), including the two 2026-10-28 shapes (general or ambiguous). The regex cues were written
after reading the 16, so for the regex those count as tuning; the 20, and every Jev figure, are a
test. Jev ran twice before and twice after (its routes vary between runs, R20).

| Check | Before: regex / Jev | After: regex / Jev |
|---|---|---|
| 16 setup questions routed general | 9 / 2, 2 | 4 / 0, 0 |
| 16 setup questions routed personal | 5 / 13, 13 | 11 / 16, 16 |
| Setup note sent (11 questions with one) | 1 / 5, 5 | 3 / 6, 6 |
| 20 technical turns routed personal | 2 / 4, 4 | 2 / 1, 2 |
| Eval (133): confusion matrix | unchanged | unchanged |
| Eval: Jev below the floor | 12, 12 | 14, 14 |
| Synthetic (40): confusion matrix | unchanged | unchanged |

- The two technical turns the regex still routes personal come from older cues
  (`experience:pt-voce-habito`, and "your workflow file" through `background:your-career`): item 5's
  live-coding guard, not this change. Across the 698 recorded interviewer turns and eval questions
  the new cues change one route: the 2026-10-29 setup turn, now personal.
- Replays (`--router jev`, no LLM): on 2026-10-28 the scenario turn routes general (route errors on
  labeled turns 1 → 0); "escalável pelo quê?" stays general. Unlabeled armed turns that moved:
  technical questions to general, two scenario questions about the solution being built from
  ambiguous to general, and two questions on how the candidate steers and reviews an agent's work
  to personal. One hypothetical about an API's rate limits went from `ambiguous@0.59–0.60` (two
  runs) to below the floor in both runs after, where the older regex cue
  `behavioral:example-when-you` routes it personal. A sentence in the criterion saying a scenario
  stays ambiguous did not change it, and was dropped.

### Routing on the extracted question

The router reads the whole turn (`router.decide(turnText)`). Over the 185 interviewer turns of the
recorded sessions whose extracted question differs from the turn, routing on the question alone
fixes the 2026-10-28 scenario turn but takes the labeled route away from 22 turns with the regex
and 14 with Jev (mostly questions about the candidate whose subject is earlier in the turn), and
Jev then routes another labeled general turn personal. Not adopted.

## R23: talk about the code on the screen, routed personal (future-work item 5, live-coding gap)

The older experience cues (`experience:have-you`, `you-past`, `did-you`, `pt-voce-past`,
`pt-voce-habito`, `behavioral:pt-um-momento`) match an interviewer turn about a snippet as well as
one about the candidate: "Have you handled the nil case in this function?" asks about the code, and
the answer was getting notes and the first-person addendum.

**Decision.** In `intentRouter.js`, a guard before the personal cues: a demonstrative before a code
noun ("this function", "that column", "nessa fila", "esse lock") routes general (`code:on-screen`).
"The" alone does not count, since "how did you handle the cache invalidation at X" is about the
candidate. And `behavioral:example-when-you` skips a turn that says "imagine", "suppose" or
"assume", and "when you would": those are hypotheticals.

**Measured with the regex only** (no TypeSafe quota was spent, so Jev is not measured; the guard is
in the fallback that decides when Jev cannot). A set of 60 invented turns written before the change:
36 about the code on the screen (EN and PT) and 24 controls with the same verbs about the candidate.

| Check | Before | After |
|---|---|---|
| 36 live-coding turns routed personal | 26 | 7 |
| 24 control turns routed personal | 24 | 24 |
| Eval (133): confusion matrix | unchanged | unchanged |
| Synthetic (40): confusion matrix | unchanged | unchanged |

- The 7 left have no demonstrative ("the cache before the client", "a conexão no caminho de erro
  aqui"). Catching them needs a bare "the" or "aqui", which would also catch questions about the
  candidate.
- Over the 698 recorded interviewer turns and eval questions, 8 turns change. Five only get the new
  cue name (general before and after). Of the three that change route: the 2026-10-28 scenario turn
  (labeled general) goes from personal to general, one unlabeled technical turn of the same session
  goes from personal to general, and 2026-10-29 #12 (the hypothetical about an API's limits, left
  by item 13) goes from personal to ambiguous, as Jev had it.
- Not measured: Jev on these turns. When Jev decides (confidence at or above 0.5) the guard is not
  in play.

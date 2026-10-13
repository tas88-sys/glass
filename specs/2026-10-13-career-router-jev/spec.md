---
# Context Optimization Metadata
meta:
  spec_id: 2026-10-13-career-router-jev
  spec_name: career-router-jev
  status: in-progress    # draft | in-progress | approved | completed
  phase: verify          # code and unit tests done; R19 (real-session gate) and R20 (candidate's questions) added 2026-10-13
  created: 2026-10-13
  updated: 2026-10-13

summary:
  goals:
    - {id: G1, description: "Jev (TypeSafe AI) routes each interviewer turn (personal, company, ambiguous, general) in place of the regex cue tables, so new phrasings stop needing new regexes", priority: HIGH}
    - {id: G2, description: "Bilingual as today: English and Brazilian Portuguese turns, with speech-to-text errors, route at least as well as with the regex router, per language", priority: HIGH}
    - {id: G3, description: "Production-ready: Live Answer never waits on, breaks on, or loses notes because of Jev. Any Jev failure falls back to the frozen regex router", priority: HIGH}
  constraints:
    - {id: C1, description: "Without TYPESAFE_API_KEY, or with CAREER_ROUTER=regex, routing is exactly today's (same routes, same cues, same synchronous gate, byte-identical prompts). The backchannel gate (FR-014, R19) applies in both modes", type: TECHNICAL}
    - {id: C2, description: "Logs carry route, cue, source, confidence, kinds, statuses and timings only: never the turn text, the manifest's names or the key", type: SECURITY}
    - {id: C3, description: "Sent to TypeSafe (owner decision 2026-10-13): the turn, the interviewer's segment just before it (R19, interviewer speech like the turn), the previous question and its route, the interviewer's company and the manifest's names (candidate_names, note_companies). Nothing else; never the candidate's speech", type: SECURITY}
    - {id: C4, description: "The answer waits for the route at most CAREER_ROUTER_RESOLVE_BUDGET_MS (250 ms) after the 800 ms debounce fires; the gate waits at most CAREER_ROUTER_GATE_TIMEOUT_MS (700 ms) for a statement-form turn", type: TECHNICAL}
    - {id: C5, description: "No personal content enters this public repo: tests use invented fixtures; the eval prints ids and counts only", type: SECURITY}
    - {id: C6, description: "Native fetch only (Electron 30 main runs Node 20), no SDK, no new dependency", type: TECHNICAL}
  decisions:
    - {id: D1, decision: "Jev primary, regex frozen as the fallback", rationale: "Owner decision 2026-10-13. A network router needs a local fallback; the regex router is already tuned and tested, and freezing it stops the upkeep (research R18)"}
    - {id: D2, decision: "The manifest's names go in the state", rationale: "Owner decision 2026-10-13: routes 'tell me about <project>' and 'do you know <company>' without a local name rule"}
    - {id: D3, decision: "Direct API (POST api.typesafe.ai/v1/systemone) with a fixed model version (jev-1.13.0)", rationale: "Owner decision. Aliases (jev-latest) move without notice and would change routes silently"}
    - {id: D4, decision: "Instructions in English, each criterion with one English and one Portuguese example", rationale: "English is Jev's primary training language; other languages are 'handled but not equally well' (docs.typesafe.ai/models). Paired examples anchor the Portuguese phrasings to the same intent"}
    - {id: D5, decision: "One call per turn and context, cached and shared by the gate, the prefetch and the resolve", rationale: "The call starts when the gate accepts the turn, inside the 800 ms debounce, as the query embedding prefetch already does (research R10)"}
    - {id: D6, decision: "No retry on the live path; a circuit breaker instead", rationale: "The budgets leave no time for a retry; three failures in a row mean the service is down, so the regex router takes over for 60 s"}
    - {id: D7, decision: "Superseded calls are not aborted", rationale: "A later non-question segment would otherwise abort the call an armed question still needs; calls cost ~$0.00002 and the cache bounds them"}
    - {id: D8, decision: "One call also asks whether the turn wants an answer now (asks); the live gate uses it both ways", rationale: "R19: a real session armed 56 answers on acknowledgments and monologues; the route alone cannot tell 'Aham' after a personal question from a follow-up. Same call, ~200 more tokens"}
    - {id: D9, decision: "Acknowledgments and fillers are dropped locally, before Jev", rationale: "R19: 62 of 115 no-answer segments in the session were plain backchannels; a word list catches them with no false positive and saves the call"}

critical_requirements:
  type: feature-major
  must_verify:
    - "C1: no key or CAREER_ROUTER=regex → eval-career-kb.js --router regex prints today's routing, recall and checks"
    - "C2: no turn text, name or key in any [career] or [live-answer] line"
    - "G3: every Jev failure kind falls back to the regex router; the answer still gets its notes"
    - "R-SC-001..004 pass on the owner's eval set before Jev ships as the default"
---

# Career router: Jev in place of the regex cue tables

## Problem

`classifyCareerIntent` routes each interviewer turn with about 110 English and Portuguese
regexes. Each phrasing that slips through needs a new regex (research R15, R16, R17 of
`2026-10-11-live-answer-career-context`). Jev is a decision model: it takes a text and typed
questions and returns a choice with probabilities, without writing text. It can route turns
the tables never saw.

## Functional requirements

- **FR-001 Jev is the router.** With `TYPESAFE_API_KEY` set and `CAREER_ROUTER` unset or `jev`,
  every career route (the answer path and the gate for statement-form turns) comes from Jev.
- **FR-002 Request.** One `POST /v1/systemone` per turn and context:
  - `model`: `CAREER_ROUTER_JEV_MODEL`, default `jev-1.13.0`, never an alias;
  - `state`: `turn` (≤ 2,000 chars), `interviewer_before` (the interviewer's previous segment, its
    last 400 chars, when it began ≤ 20 s before the turn; R19), `previous_question` (its last 600
    chars) and `previous_route` when the last personal/company question is inside the 5-minute
    follow-up window, `interviewer_company`, `candidate_names` and `note_companies` (≤ 60 names of
    ≤ 60 chars each);
  - `questions.route`: `choice` over the four routes;
  - `questions.asks`: `noul`, always: does the turn ask the candidate for something to answer now (R19);
  - `questions.follow_up`: `noul`, only when `previous_question` is sent.
- **FR-003 Mapping.**
  - follow-up ≥ 0.5, a previous personal/company question in the window and a route other
    than `company` → the previous route, cue `follow-up` (the previous terms and anchor carry, as today);
  - route confidence < `CAREER_ROUTER_JEV_MIN_CONF` (default 0.5) → the regex decides (`fallback: low`);
  - otherwise the Jev route, cue `jev:<route>@<confidence>`.
- **FR-004 Fallback.** The regex router decides, with the reason, on: the budget running out (`budget`),
  the request timeout (`timeout`, 1,500 ms), 429 (`rate`), 529/503 (`overload`), other HTTP errors
  (`http`), network errors (`net`), a body off the documented shape (`bad-body`), an open circuit
  (`circuit`), 401/403 (`auth`), 400/422 (`validation`). The router never rejects.
- **FR-005 Circuit breaker.** Three counted failures in a row → regex only for 60 s, then one probe
  call; its success closes the circuit. `auth` and `validation` turn Jev off until the app restarts
  and are logged once (status and the 422 field name only).
- **FR-006 Cache.** The last 64 calls are kept by (model, state, follow-up asked). The gate, the
  prefetch and the resolve of one turn share one call; a late answer still fills the cache.
- **FR-007 Gate.** A them turn that `isLikelyQuestion` accepts is armed at once, as today. A them
  turn it rejects asks the router (≤ the gate timeout) and is armed when the route is personal or
  company and Jev's `asks` is at least `CAREER_ROUTER_ASK_MIN` (0.3; a regex decision has no asks
  and arms on its route), unless a newer answer was armed, or the session was reset or paused,
  meanwhile. When the router cannot use Jev (no key, disabled, circuit open), the gate is today's
  synchronous regex gate.
- **FR-008 Resolve budget.** `getCareerContext` waits for the route at most
  `CAREER_ROUTER_RESOLVE_BUDGET_MS`. Scripts pass a longer `routeBudgetMs`.
- **FR-009 Configuration.** `TYPESAFE_API_KEY`, `CAREER_ROUTER` (`jev` | `regex`; any other value
  reads as `regex`), `CAREER_ROUTER_JEV_MODEL`, `CAREER_ROUTER_JEV_MIN_CONF`,
  `CAREER_ROUTER_GATE_TIMEOUT_MS`, `CAREER_ROUTER_RESOLVE_BUDGET_MS`, `CAREER_ROUTER_ASK_MIN` (0.3),
  `CAREER_ROUTER_ASK_VETO` (0.2; 0 turns the drop off), all from `.env`, read on use.
  The key can also be saved in Settings (a `provider_settings` row `typesafe`, encrypted like the
  providers' keys), which wins over `TYPESAFE_API_KEY`. Save checks it with one minimal call:
  401/403 rejects it, any other failure saves it unverified. Alone it does not count as an AI key
  (`hasValidApiKey`). A new key clears an `auth`/`validation` disable without a restart.
- **FR-010 Observability.** `getCareerContext` returns `routeSource`, `routeFallback`,
  `routeConfidence`, `routeAsks`, `jevMs`. The `[career]` line ends with
  `src=jev|regex|regex(<reason>)`, `asks=<0..1>` when Jev answered, and `jev=<ms>`. The gate's
  `[live-answer]` lines name backchannels, the asks and the drops. `routerStats()` returns the
  state and counters.
- **FR-011 Bilingual.** Instructions in English that name both languages and STT errors; each
  criterion carries an English and a Portuguese example.
- **FR-012 Eval.** `eval-career-kb.js --router regex|jev` prints the confusion per language and,
  for `jev`, the comparison with the regex router on the same items, the Jev call p50/p95, the
  fallbacks, and the release checks.
- **FR-013 Drop on the debounce (R19).** With Jev on, when the debounce fires for an armed turn, the
  service waits for the turn's route call (at most the resolve budget; the call the prefetch started)
  and drops the turn when Jev's `asks` is below `CAREER_ROUTER_ASK_VETO`: no context, no LLM call,
  and the answer on screen is not replaced. A failure, a regex decision or no asks never drops. A
  newer armed turn during that wait makes the older callback stop.
- **FR-014 Backchannel gate (R19).** A them segment made only of acknowledgments, fillers or
  "pardon?" (EN and PT word list, at most 8 words; a lone "1" is the STT's "um") arms nothing and
  asks Jev nothing, in both router modes. It does not replace the interviewer's previous segment.
- **FR-015 Session replay (R19).** `scripts/replay-career-session.js --session <file>` replays a
  labeled recorded session (segments with `ask` y/e/n and the expected route) through the app's own
  gate and router, with Jev live and no LLM, and prints armed, missed, wasted, route errors, sources
  and Jev p50/p95: ids and counts only.

## Success criteria

- **R-SC-001** For each language: `personal → personal` with Jev ≥ with the regex router, and
  `general → personal` with Jev ≤ with the regex router.
- **R-SC-002** No company leak (the existing SC-003 stays 0).
- **R-SC-003** Jev call p95 ≤ 600 ms, measured from the owner's machine.
- **R-SC-004** Fallbacks ≤ 5% of the eval items with no injected failure. It was 2% until
  2026-10-13: most fallbacks are low-confidence turns, where the regex decision saves misses (R18).
  Jev is not deterministic (R20): judge it on several runs.
- **R-SC-005** Live: the answer's wait for the route ≤ 50 ms at p95 (live eval), never above 250 ms.
- **R-SC-006** With Jev off, today's results exactly (C1).
- **R-SC-007** On each labeled real session with working STT (replay, FR-015), with the defaults:
  Jev arms at least the regex's `y` segments, wastes no more `n` segments than the regex, and makes
  no more route errors. For Portuguese this replaces the regex-tuning items in R-SC-001 (owner
  decision of R18: fresh real Portuguese questions settle it). 2026-10-13 session: `y` 42/43 against
  36/43, `n` 24 against 26, route errors 1 against 26 (R19). With the labels corrected from a
  second transcript (R20): `y` 43/43 and 42/43 over two runs against 36/43, `n` 22 and 21 against 25,
  route errors 1 against 27.
- The old SC-004 (answer path p95 ≤ 20 ms) now counts from the route on: the route call runs inside the debounce.

## Edge cases

- **E1** A statement-form career turn, then "take your time" before Jev answers: the career turn is still armed.
- **E2** A statement-form turn, then a question that arms at once: the statement's late decision is dropped.
- **E3** Jev says `general` where the regex saw a cue: nothing is injected (Jev is primary).
- **E4** A follow-up the regex misses ("e como isso terminou"): Jev's follow-up carries the previous terms; the anchored embedding is prefetched when Jev answers.
- **E5** A key revoked mid-session: one 401, one log line, regex until restart.
- **E6** A typo in `CAREER_ROUTER`: regex, so turns never leave by mistake.
- **E7** "Hã?" or "Pá. E aí?" from the interviewer: a backchannel; no answer, no Jev call (FR-014).
- **E8** A question the STT splits ("e aí, quando vocês migraram para o Kubernetes," then "ficaram quantos pods?"):
  the second segment goes with the first as `interviewer_before` and arms on its own asks.
- **E9** The interviewer presenting the company with a rhetorical "sabe?": armed by the '?' rule,
  dropped on the debounce when asks < 0.2 (FR-013).
- **E10** STT in the wrong language (garbage text): Jev may read meaning into it and arm answers;
  the fix is the STT language (R19 known limit).
- **E11** "Do you have any questions for us?" / "fica à vontade pra tirar suas dúvidas sobre a empresa":
  company, so the company's notes, which hold the candidate's questions for it, go in (R20). The regex
  router has no cue for it and stays frozen.

## Out of scope

- Replacing `stripCuePhrases` (retrieval queries) or `detectCompany` (both stay local).
- Ask and Live Insights (they do not route career turns).
- An embedding-based fallback for the regex (R18 notes it for later).

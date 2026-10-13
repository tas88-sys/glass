---
# Context Optimization Metadata
meta:
  spec_id: 2026-10-13-career-router-jev
  spec_name: career-router-jev
  status: in-progress    # draft | in-progress | approved | completed
  phase: verify          # code and unit tests done; the release checks need a TypeSafe key
  created: 2026-10-13
  updated: 2026-10-13

summary:
  goals:
    - {id: G1, description: "Jev (TypeSafe AI) routes each interviewer turn (personal, company, ambiguous, general) in place of the regex cue tables, so new phrasings stop needing new regexes", priority: HIGH}
    - {id: G2, description: "Bilingual as today: English and Brazilian Portuguese turns, with speech-to-text errors, route at least as well as with the regex router, per language", priority: HIGH}
    - {id: G3, description: "Production-ready: Live Answer never waits on, breaks on, or loses notes because of Jev. Any Jev failure falls back to the frozen regex router", priority: HIGH}
  constraints:
    - {id: C1, description: "Without TYPESAFE_API_KEY, or with CAREER_ROUTER=regex, behavior is exactly today's (same routes, same cues, same synchronous gate, byte-identical prompts)", type: TECHNICAL}
    - {id: C2, description: "Logs carry route, cue, source, confidence, kinds, statuses and timings only: never the turn text, the manifest's names or the key", type: SECURITY}
    - {id: C3, description: "Sent to TypeSafe (owner decision 2026-10-13): the turn, the previous question and its route, the interviewer's company and the manifest's names (candidate_names, note_companies). Nothing else", type: SECURITY}
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
  - `state`: `turn` (≤ 2,000 chars), `previous_question` (its last 600 chars) and `previous_route`
    when the last personal/company question is inside the 5-minute follow-up window,
    `interviewer_company`, `candidate_names` and `note_companies` (≤ 60 names of ≤ 60 chars each);
  - `questions.route`: `choice` over the four routes;
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
  company, unless a newer answer was armed, or the session was reset or paused, meanwhile. When the
  router cannot use Jev (no key, disabled, circuit open), the gate is today's synchronous regex gate.
- **FR-008 Resolve budget.** `getCareerContext` waits for the route at most
  `CAREER_ROUTER_RESOLVE_BUDGET_MS`. Scripts pass a longer `routeBudgetMs`.
- **FR-009 Configuration.** `TYPESAFE_API_KEY`, `CAREER_ROUTER` (`jev` | `regex`; any other value
  reads as `regex`), `CAREER_ROUTER_JEV_MODEL`, `CAREER_ROUTER_JEV_MIN_CONF`,
  `CAREER_ROUTER_GATE_TIMEOUT_MS`, `CAREER_ROUTER_RESOLVE_BUDGET_MS`, all from `.env`, read on use.
- **FR-010 Observability.** `getCareerContext` returns `routeSource`, `routeFallback`,
  `routeConfidence`, `jevMs`. The `[career]` line ends with `src=jev|regex|regex(<reason>)` and
  `jev=<ms>`. `routerStats()` returns the state and counters.
- **FR-011 Bilingual.** Instructions in English that name both languages and STT errors; each
  criterion carries an English and a Portuguese example.
- **FR-012 Eval.** `eval-career-kb.js --router regex|jev` prints the confusion per language and,
  for `jev`, the comparison with the regex router on the same items, the Jev call p50/p95, the
  fallbacks, and the release checks.

## Success criteria

- **R-SC-001** For each language: `personal → personal` with Jev ≥ with the regex router, and
  `general → personal` with Jev ≤ with the regex router.
- **R-SC-002** No company leak (the existing SC-003 stays 0).
- **R-SC-003** Jev call p95 ≤ 600 ms, measured from the owner's machine.
- **R-SC-004** Fallbacks ≤ 2% of the eval items with no injected failure.
- **R-SC-005** Live: the answer's wait for the route ≤ 50 ms at p95 (live eval), never above 250 ms.
- **R-SC-006** With Jev off, today's results exactly (C1).
- The old SC-004 (answer path p95 ≤ 20 ms) now counts from the route on: the route call runs inside the debounce.

## Edge cases

- **E1** A statement-form career turn, then "take your time" before Jev answers: the career turn is still armed.
- **E2** A statement-form turn, then a question that arms at once: the statement's late decision is dropped.
- **E3** Jev says `general` where the regex saw a cue: nothing is injected (Jev is primary).
- **E4** A follow-up the regex misses ("e como isso terminou"): Jev's follow-up carries the previous terms; the anchored embedding is prefetched when Jev answers.
- **E5** A key revoked mid-session: one 401, one log line, regex until restart.
- **E6** A typo in `CAREER_ROUTER`: regex, so turns never leave by mistake.

## Out of scope

- Replacing `stripCuePhrases` (retrieval queries) or `detectCompany` (both stay local).
- Ask and Live Insights (they do not route career turns).
- An embedding-based fallback for the regex (R18 notes it for later).

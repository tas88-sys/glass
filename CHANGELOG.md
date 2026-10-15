# Changelog

All notable changes to this fork of [pickle-com/glass](https://github.com/pickle-com/glass) are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Fork base: upstream commit `71bc3dc` (*firebase functions node20 migration*, 2025-10-25).

## [Unreleased]

### Multi-monitor step move (spec `2026-10-15-multi-monitor-step-move`)

#### Fixed

- **Ctrl+arrow brings the header back from another monitor.** It used to cross to a monitor on the left but stop at that monitor's right edge, and it never reached a monitor on the right. Upstream bug.
  - The display is now picked by the header's center, not its top-left corner.
  - A step from the edge of a monitor crosses to the adjacent one and lands flush with its near edge.
- **Dragging the header across monitors** no longer leaves it behind the cursor for a whole header width at the border (half at most).

### OpenAI-compatible provider (spec `2026-10-14-openai-compatible-provider`)

#### Added

- **New `openai-compatible` LLM provider** (`providers/openaiCompatible.js`). It talks to any server that speaks the OpenAI chat API at a base URL: OpenRouter, SambaNova, Mistral, or a local gateway such as OmniRoute. It works in Ask, Live Answer and Live Insights.
  - **Settings:** Base URL, API Key (may be empty) and LLM Model ID list. The URL must be https, or http on localhost only.
  - **Storage:** the URL and the key are saved together, encrypted, in the provider's key row. No migration.
- **Failover**, as Groq's, with two differences:
  - a model that refuses the request (400/422) hands it to the next model; only a refused key ends the request;
  - cooldowns are kept per provider, so a Groq model ID spent on Groq still runs on the endpoint.
- **Mixed lists:** the endpoint's models can come before or after Groq, Gemini and Anthropic models.
- **Logs:** each attempt line has `ttft=`, `served_by=` and, behind OmniRoute, `route=` (its `X-OmniRoute-Decision` header).
- **`scripts/probe-openai-compatible-ttft.js`** measures the time to first token of the same request on several endpoints (e.g. Groq direct vs. via OmniRoute), alternating their order.
- **Live eval:** reads `OPENAI_COMPATIBLE_BASE_URL` and `OPENAI_COMPATIBLE_API_KEY` from `.env`.
- **Not done:** OmniRoute itself is not bundled or required. The review of it (free tiers, terms, privacy) is research R1 of the spec.
- **`docs/runbook/OMNIROUTE_SETUP.md`:** how to set up OmniRoute on a new machine as the last, free fallback:
  - the versions it needs and the install;
  - the local-only `.env`;
  - how to start it, outside the repo;
  - the dashboard steps (providers, `free-stack` combo, client key);
  - the Glass settings, the latency check and the pitfalls seen on 2026-10-14.

### Live answers are kept for review (spec `2026-10-13-live-answer-history`)

After a real interview the owner asked how good its 101 answers had been, and they were gone: the panel was their only copy.

- **Every answer is kept in the local DB** (`live_answers`): the interviewer's turn, the answer as the panel showed it, how it ended (answered, PASSIVE, cut off by a newer question, failed), the model that answered, the career route and its notes, the live check's flags and the timings. Local sessions only, never synced, deleted with the session; `LIVE_ANSWER_HISTORY=0` turns it off. This lifts C8 of the original Live Answer spec.
- **`scripts/export-live-answers.js`** writes a session's answers, and optionally its transcript, to a file outside the repo for review.
- **`scripts/replay-career-session.js --answers <file>`** rebuilds the answers of a recorded session with the app's own prompt, notes and LLM chain (`--no-llm`: only the notes each answer would get; `--resume` after a quota stop).

### Career router: Jev in place of the regex cue tables (branch `2026-10-13-jev-router-poc`)

#### Added

- **Jev router** (`src/features/common/career/jevRouter.js`, `jevClient.js`). With `TYPESAFE_API_KEY` in `.env`, Jev (TypeSafe AI) decides the career route of each interviewer turn: personal, company, ambiguous or general. The criteria are in English, with an English and a Portuguese example each, so pt-BR and en-US turns route alike. Spec: `specs/2026-10-13-career-router-jev/`.
  - **Sent to TypeSafe:** the turn, the previous career question, the interviewer's company and the manifest's names.
  - **Model:** fixed at `jev-1.13.0`, since an alias changes routes without notice.
  - **Latency:** the call starts when the gate accepts the turn, inside the 800 ms debounce. The answer then waits at most 250 ms more.
  - **Cost:** about $0.00002 per turn.
- **Fallback:** the regex router decides, and the debug line says why (`src=regex(timeout)`), on a timeout, 429/529, a network error, a malformed answer, low confidence, or an open circuit (three failures in a row → regex only for 60 s). A 401/422 turns Jev off until restart.
- **Gate:** a turn with no question form ("your biggest weakness") waits for Jev, at most 700 ms, before the debounce. Questions never wait.
- **Config:** `CAREER_ROUTER=jev|regex` (the kill switch; a typo reads as `regex`), `CAREER_ROUTER_JEV_MODEL`, `CAREER_ROUTER_JEV_MIN_CONF`, `CAREER_ROUTER_GATE_TIMEOUT_MS`, `CAREER_ROUTER_RESOLVE_BUDGET_MS`.
- **Settings → TypeSafe (Jev) API Key:** the key is saved like the providers' keys (encrypted, Save/Clear) and wins over `TYPESAFE_API_KEY`, so an installed app, which ships no `.env`, can use Jev too. Save checks the key with one minimal call. A TypeSafe key alone does not count as an AI key, and a new key brings Jev back after a 401 without a restart.
- **`scripts/eval-career-kb.js --router regex|jev`:**
  - prints the router confusion per language;
  - with `jev`, compares Jev with the regex router on the same items and reports the Jev call p50/p95 and the fallbacks;
  - adds the release checks R-SC-001..004;
  - `--questions <file>` runs another items file, such as a synthetic set kept apart from the real questions.
- **`ask-career-kb.js` and the live eval** show who decided each route and the Jev time.
- **`npm run eval:live -- --block-providers groq,gemini,deepgram`** (or `LIVE_EVAL_BLOCK_PROVIDERS`) runs the live eval without spending those services' quota:
  - requests to their hosts fail before leaving the machine, and the run reports the count;
  - their models leave the LLM list, and when none is left a local stub answers;
  - the gate, the Jev router, retrieval and the answer lane still run;
  - checks on the answer's words become info, and the Ask phases are skipped.

#### Changed after a real session (spec R19, 2026-10-13)

A 71-minute Portuguese interview with Jev on armed 114 answers, 56 of them on acknowledgments ("Aham.", "Hã?", "1"), fragments and the interviewer's monologue: each one a Groq call (about 5,000 tokens) and a replaced answer on screen; Groq answered 429 56 times. Replayed with the changes below: 80 answers instead of 115, 24 wasted instead of 56, 42 of 43 real questions armed (41 before) and 1 route error instead of 5 (the regex router: 26). Five older English sessions, not used to tune, confirm it with a smaller margin: 28 wasted instead of 36, real questions 61/62 as before.

- **Backchannels never trigger an answer** (`questionGate.js`, `isBackchannel`): an interviewer segment made only of acknowledgments, fillers or "pardon?" (EN and PT) arms nothing and costs no Jev call, in both router modes.
- **Jev also answers "does the turn ask the candidate for something now?"** (`asks`, same call): a statement needs `asks` ≥ 0.3 (`CAREER_ROUTER_ASK_MIN`) to be answered, and a question is dropped when the debounce fires if `asks` < 0.2 (`CAREER_ROUTER_ASK_VETO`; `0` turns it off), before it costs an LLM call or replaces the answer on screen.
- **The interviewer's previous segment goes to Jev** (`interviewer_before`, when it began at most 20 s earlier): the STT cuts one question into pieces. Interviewer speech only.
- **Criteria:** details of a project the candidate did or described count as personal. Eval: personal routed 96.1% (was 94.7%), holdout 100% (was 95.8%), Portuguese 93.3% (was 91.1%).
- **`scripts/replay-career-session.js`** replays a labeled recorded session through the app's gate and router (Jev live, no LLM).
- The question gate moved out of `summaryService.js` into `questionGate.js` (pure, no Electron) so scripts can run it.
- **"Do you have any questions for us?" routes company** (spec R20): the same interview ended with the interviewer inviting the candidate's questions, and no answer came, with either router. With Jev, the company criterion now names that invitation, so the company's notes, where the candidate keeps their questions for it, go in. Invented invitations: 6/6 company (was 2/6); the eval is unchanged.
- **…and the answer is questions to ask** (spec R21): Jev also says, in the same call, whether the interviewer is inviting the candidate's questions (`invites`). Then the notes search looks for the candidate's questions-to-ask sections, not the invitation's own words ("tirar dúvidas sobre o processo" matched other notes), and the answer suggests two or three questions. For the real invitation, the three questions-to-ask sections now go in (none before); the eval is unchanged.

#### Fixed (found by the live eval with Jev)

- **Intros got answers.** A company intro with no question ("Here at <company> we…") was routed `company` by Jev and answered. The criteria now say that personal, company and ambiguous turns ask the candidate something, and that a statement presenting the company or the role is general.

#### Changed

- `intentRouter.js` is frozen: no new cues. A phrasing Jev misses is fixed in the Jev criteria and measured with the eval.
- The eval's answer path now counts from the route on, because the route call runs inside the debounce.
- Without a key, or with `CAREER_ROUTER=regex`, routes, cues, the gate and prompts are exactly as before.

### Fixed (found in a debug session log, 2026-10-13)

- **Ask window: highlight and DOMPurify never loaded.** `AskView` loaded its libraries from `../../assets/`, which resolves to `src/assets` (it does not exist); they are in `src/ui/assets`. Now `../assets/`, as `SummaryView` already does.
- **Log noise:** `[Layout Debug]` and `[Height Adjusted]` (58% of a session's log) print only with `GLASS_LAYOUT_DEBUG=1` (main) or the `LAYOUT_DEBUG` flag (renderer). With Ollama not running, its health check failure logs once per streak, and the local AI state logs only when it changes (it repeated every ~30 s).

### Live eval: a simulated interview with real audio and real models (branch `2026-10-12-live-eval`)

#### Added

- **`npm run eval:live`** (`scripts/live-eval/`) runs Live Answer and Ask end to end with the app's own services (`docs/LIVE_INSIGHTS_AND_ASK.md` §4.9):
  - the interviewer's questions are said by TTS (Gemini, cached outside the repo) into the real STT sessions;
  - each turn then goes through the real question gate, career context and provider chain.
- **Phases:**
  - **A**, an invented interview in pt-BR and en-US;
  - **B**, career-route questions sampled from your notes' eval set;
  - **C**, Ask with a screenshot;
  - **D**, Ask in code mode on a hard problem; the JavaScript answer runs against hidden tests;
  - **E**, Ask in system design mode;
  - **F**, stress: a burst of questions, a long session, Answer off.
- **Results:** each item gets deterministic checks and warnings, and optionally an LLM judge score (`--judge`). The report goes to `%LOCALAPPDATA%\glass-live-eval\`. The exit code is 1 when a check fails.
- **`src/features/ask/askPrompt.js`:** `buildAskMessages`, the Ask messages that `askService.sendMessage` used to build inline. The app and the eval now send the same prompt. A test checks that the messages are byte-identical to the inline code in every mode, with and without a screenshot.
- **STT keyterms** (`src/features/listen/sttKeyterms.js`): Deepgram now gets up to 90 `keyterm` parameters per session, in pt-BR too. They are the career notes' company and entity names, plus a fixed list of technical names (`LINQ`, `gRPC`, `Kafka`, …). The career module exposes the names through `keyterms()`.

#### Fixed (found by the first full run)

- **A Portuguese question without `?` got no answer.** The question gate knew English cues only, so "Me explica a diferença entre…" and "como que você faz para…" were skipped. `isLikelyQuestion` now has Portuguese twins of each signal. `como` counts only before a verb or `você`, so "Como arquiteta, …" is not taken as a question.
- **Portuguese questions sometimes got English answers.** The Live Answer instruction now asks for the answer in the language of the question.
- **A company name the STT misspelled by one letter was not detected.** Names of 7+ letters now match one edit away (two from 11 letters) in a company-context phrase, if the first letter is right.
- **"Do you ensure…" routed general when the STT dropped a leading "How".** A turn that opens on "do you" plus an approach verb now routes ambiguous, like "How do you…".
- **"LINQ" was transcribed as "link".** Fixed by the keyterms above.
- **Eval:** when the router itself routes a career question's script text away from its label, phase B now warns instead of failing. That gap belongs to `scripts/eval-career-kb.js`.

### STT language: Portuguese (Brazil) or English, chosen in Settings

#### Fixed

- **Portuguese was transcribed as English.** `listenService.initializeSession` defaulted the language to `'en'`, so Deepgram always got `language=en`; the UI language never reached the STT sessions.

#### Added

- **Transcription language** setting (`sttLanguage`: `pt-BR` default, or `en-US`) in Settings. It sets the language of both STT sessions (Me and Them) at every Listen start and every 20-min renewal. `sttLanguage.js` maps it to the code each provider expects (Deepgram and Gemini: `pt-BR`; OpenAI: `pt`).
- `buildListenQuery` in the Deepgram provider, tested for the `language` it sends.

### Model catalog: what each model can do comes from the providers' APIs (branch `2026-10-12-groq-otpm-images`)

#### Changed

- **No table keyed by model name decides what a model can do.** `modelCatalog.js` reads each provider's models API and keeps the answer in a new SQLite table, `model_catalog`:
  - Groq: `input_modalities` (sees images), `max_completion_tokens`, `supported_features` (reasons);
  - Anthropic: `capabilities.image_input`, the `capabilities.effort` levels, `capabilities.thinking`, `max_tokens`;
  - Gemini: `outputTokenLimit` and `thinking`. Its list does not say which models see images, so they do by default.
  - It replaces Groq's `MODEL_TRAITS`, Anthropic's `acceptsEffort` regex and `SERVER_FALLBACK_MODELS`, and the chain's rule that Gemini and Anthropic always see images. A new model works once its provider lists it, with no code change.
- **The provider of a model ID** is the one whose models list has it. When several do, the Settings field the list was typed in decides. The `claude-` / `gemini-` / `vendor/model` prefix is only the last resort, logged once per ID. Settings no longer keeps its own copy of the rule.
- **The lists are read** at startup and when a key is saved (both in the background), and when a model list is saved (up to 5 s, so Settings shows the result). A request naming a model the catalog does not know waits at most 2 s for it, then uses the provider default. A failed read keeps what is known.
- **Settings shows what each model of the active list can do**: its provider, whether it sees images, its output maximum and whether it reasons, each marked when it is a default or an override. Warnings appear for an ID the provider does not have, for the key's output limit, and for a maximum under Ask's 16,384. **Edit** sets an override (stored in SQLite, never overwritten by a refresh); **Refresh** reads the lists again.
- **Every provider follows `visionOnly`** (Gemini and Anthropic as well as Groq), and sends no image to a model set not to see one.
- **Output caps never exceed the model maximum** the API reports (Anthropic `max_tokens`, Gemini `maxOutputTokens`, Groq `max_completion_tokens`).

#### Fixed

- **Groq: an Ask screenshot no longer costs a refused Qwen request every time.** The first 429 OTPM stores the key's output limit for the model. Until it expires (24 h) or the key changes, a request whose cap is over it skips that model with no call (`skip … reason=key-output-limit`). Live Answer (900) still runs on Qwen.
- **Anthropic: the server-side fallback beta is no longer limited to Opus and Sonnet 5.5.** It is sent to every model. A 400 on it is resent once without the beta; when that is accepted, the catalog marks the model and does not send it the beta again, across restarts. Before, one refusal turned the beta off for every model until restart.

#### Docs

- `specs/2026-10-12-model-catalog/` holds the spec set: spec, research (live probes, the source of each field), plan, data model, contracts, edge cases, quickstart, tasks and acceptance tests.
- `ARCHITECTURE.md` §9.1 (new) describes the catalog; §9, §10.1–10.4 and §11 point to it. New diagram 18; diagrams 10, 15, 16 and 17 updated.

### Groq: screenshots reach a model that sees them, and Ask answers are not cut (branch `2026-10-12-groq-otpm-images`)

#### Fixed

- **An Ask screenshot is no longer answered blind when Gemini or Claude follows Groq in the list.**
  - On this key Groq limits Qwen, its only model that sees images, to 1,000 output tokens per minute (OTPM). It refuses any request whose cap is over that limit.
  - Qwen therefore refused every Ask. gpt-oss then answered without the screenshot, and Gemini was never tried.
  - Now the chain passes `visionOnly` to a segment when a later one sees images. Groq tries only Qwen and, if it is refused, leaves the request to Gemini with the image.
  - A Groq-only list keeps today's fallback.
- **Long Ask answers on Groq are no longer cut.** The default cap for a caller without one (only Ask) goes from 2,048 to 16,384. A system design answer measured 4,204 tokens, over the 3,072 gpt-oss got. The declared cap is not metered against the per-minute limit.
- **Qwen's OTPM refusal is read as `too-large`, not as a rate limit.**
  - The model gets no 60 s cooldown, so Live Answer (900) can still use it.
  - The log line carries `limit=L requested=R`.
  - The message reads "asks for up to R output tokens; this key allows L per minute".

#### Docs

- `specs/2026-10-12-groq-otpm-images/` holds the spec set for this fix: spec, research (the incident, the live probes, the options), plan, data model, contracts, edge cases, quickstart, tasks and acceptance tests.
- `specs/2026-10-12-groq-provider/research.md` R20 records the live probes: the OTPM refusal, gpt-oss not held to it, and answer sizes per Ask mode.
- `ARCHITECTURE.md` §10.3, §10.4 and diagrams 16 and 17 cover the new default cap, the `too-large` 429 and `visionOnly`.
- `docs/future-work.md` item 6 is marked done. A notice for Groq-only lists (screenshot not sent) is still open.

### Live panels: Live Answer, Live Insights or both (branch `2026-10-12-live-features-toggle`)

#### Added

- **A "Live panels" button in Settings**, below Automatic Updates: Answer + Insights (default) → Answer only → Insights only. It is stored per user like the Ask mode, applies from the next turn of the running session, and a new session starts with it.
- **A lane that is off does no work.** With Answer only, no analysis call is made every 5 turns and no summary is saved for the session. With Insights only, no answer is streamed and no company detection or note prefetch runs. Turning Answer off mid-question stops the answer streaming now and keeps the follow-up and company memory for when it is turned back on.
- **The Listen window shows the panes that run.** With Answer only it is titled "Live answer", its toggle reads "Show Answer", it says "Waiting for a question..." until the first one, and the copy button copies the answers, each under its question. The other two modes keep today's labels.
- `src/features/listen/liveFeatures.js` holds the rule, the cycle and the labels, with no dependencies, so the main process and the renderer bundle load the same file. Two IPC handlers, `settings:getLiveFeatures` and `settings:setLiveFeatures`, and the `listen:liveFeaturesChanged` push.

#### Unchanged

- The transcript, Ask and the default mode behave exactly as before. The Answer + Insights mode makes the same calls and sends the same payloads (a test compares it with a service that never sets the mode).

#### Docs

- `docs/LIVE_INSIGHTS_AND_ASK.md` §3.6 and §4.8, `ARCHITECTURE.md` §8 and diagram 09 describe the setting. Line references that this branch moved were updated in `ARCHITECTURE.md`, `docs/AUDIO_AND_STT.md` and `docs/LIVE_INSIGHTS_AND_ASK.md`.
- `docs/future-work.md` item 7: a Listen-bar toggle, less frequent Live Insights and a per-lane model list.

### Cross-provider failover (branch `2026-10-12-cross-provider-failover`)

#### Added

- **A model list can name several providers.** The Gemini, Anthropic and Groq fields in Settings accept another provider's models after the first entry, in any position, when that provider's key is saved. The order is the priority. For example, the Groq field can hold `openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b,gemini-3.5-flash-lite,gemini-3.1-flash-lite`. When every Groq model fails (a spent daily budget, an outage, a revoked key), Gemini answers in Ask, Live Answer and Live Insights. A list of one provider behaves exactly as before.
- **Settings shows the rule.** Each model field's help explains how to mix providers. The field that holds the active list shows the order it runs in ("Groq (3 models) → Gemini (2 models)") and flags a provider whose key is missing. The other fields say where the active list is.
- **`providerChain.js`** runs the list's segments through each provider's own `createStreamingLLM` / `createLLM`, so each provider keeps its failover, cooldowns, timeouts and image routing:
  - the running segment's events pass through unchanged, and a switch is announced with a `_reset` whose `reason` is `provider` ("Trying gemini-3.5-flash-lite…");
  - the chain switches only when a provider as a whole gives up, after its own failover; then any cause moves on, a bad key included;
  - a provider with no saved key is skipped;
  - a provider whose models all cool down is skipped with no request while a later one is healthy, so a spent Groq costs nothing after its first failure until a cooldown ends;
  - an answer must start within 60 s across providers (`LLM_CHAIN_DEADLINE_MS`; `0` disables). 15 s are kept for a later provider. Each provider keeps its own wait before its second round, so a brief overload still resolves on the first provider;
  - with a screenshot, providers that see images go first;
  - a cancel aborts the running provider's request;
  - when nothing answers, the user reads `All providers failed (groq → gemini). Last: …`;
  - one `[LLM Chain]` log line per provider tried and one per request, with no prompt, answer or key.
- **`modelHealth.isCoolingDown`**, a read-only query of the shared cooldown registry.

#### Changed

- **`getCurrentModelInfo('llm')` also returns `keys`**, the saved key of every provider the list names. Ask, Live Answer and Live Insights pass them to the factory. The factory removes them before any provider call, and each provider receives only its own key.

#### Docs

- `ARCHITECTURE.md` §10 is now "Failover: Gemini, Anthropic, Groq and across providers", with a new §10.4. §9 describes the keys and the routing.
- New `docs/diagrams/17-cross-provider-chain.mmd`. Diagram 10 shows the routing and the keys.
- `docs/LIVE_INSIGHTS_AND_ASK.md` §4.3 and §4.6 and the README describe mixed lists.

### Groq provider (branch `2026-10-12-groq-provider`)

#### Added

- **Groq as an LLM provider** (`groq.js`, through the official `groq-sdk`).
  - Presets: `openai/gpt-oss-120b` (default), `openai/gpt-oss-20b` and `qwen/qwen3.8-27b`.
  - A "Groq LLM Model ID" field in Settings takes a comma-separated list of `vendor/model` IDs, tried in order.
  - Any `vendor/model` ID maps to Groq. Installed Ollama models are matched first.
- **Failover modelled on the Anthropic provider's**, for Ask, Live Answer and Live Insights:
  - cooldowns per model, `_reset` / `_final_model`;
  - a 15 s first-text timeout, a 15 s idle timeout once text streams, and a 45 s deadline for an answer to start;
  - a second round after 2 s for fast failures; the SDK never retries;
  - a short `userMessage`, and one log line per attempt with the tokens left this minute (`tpm_left`) and no prompt, answer or reasoning text.
- **Groq-specific handling:**
  - The attempt stops at `finish_reason` and closes the connection, because groq-sdk reads past `[DONE]` until the server closes it.
  - `x_groq.error` fails the attempt.
  - A 413 "request too large" (one request over the key's per-minute limit) moves to the next model with no cooldown, and the message gives the numbers.
- **Image routing.** Only `qwen/qwen3.8-27b` sees images. An Ask with a screenshot tries it first; text-only models get the question without the image.
- **Reasoning per family.**
  - gpt-oss runs at `low` effort with `include_reasoning: false`, so the reasoning text is never sent back.
  - qwen3 runs in instruct mode (`none`).
  - Reasoning gets 1024 tokens on top of the caller's cap.
- **Error classifier `groqErrors.js`**, which reads both body shapes groq-sdk keeps. Its kinds are `transient`, `unavailable` (404 or a `model_…` code), `too-large`, `fatal-request` and `fatal-auth`.
- **Optional tuning:** `GROQ_REASONING_EFFORT`, `GROQ_MAX_TOKENS`, `GROQ_REASONING_TOKENS`, `GROQ_FIRST_TEXT_TIMEOUT_MS`, `GROQ_REQUEST_DEADLINE_MS`, `GROQ_IDLE_TIMEOUT_MS`.
- **Scripts.** `scripts/smoke-groq-sdk.js` checks that the SDK loads and streams under Electron's Node. `scripts/probe-groq-stream.js` prints the shape of one live streamed answer, with no text.

#### Changed

- **New dependency `groq-sdk` ^1.6.0**, which has no transitive dependencies.
- **"Remove all API keys" removes the Groq key too.** The onboarding footer names Groq.

#### Docs

- `ARCHITECTURE.md` §10 is now "Gemini, Anthropic and Groq failover", with a new §10.3 and the Groq provider rows.
- New `docs/diagrams/16-groq-failover.mmd`. Diagram 10 now shows the Groq entry and the `vendor/model` rule.
- `docs/LIVE_INSIGHTS_AND_ASK.md` §4.6, `docs/AUDIO_AND_STT.md` and the README name Groq.

### Anthropic provider resilience (branch `2026-10-11-anthropic-provider-resilience`)

#### Fixed

- **Claude models work again.** Before, every Anthropic request failed before a model answered:
  - key validation called a retired model and read its 404 as a bad key;
  - the only preset and the default (`claude-3-5-sonnet-20241022`) were retired;
  - no other Claude model could be selected;
  - every lane sent `temperature: 0.7`, which Opus, Sonnet and Haiku 5.5 reject with a 400.
- **`chat()` read `content[0]`**, which is a thinking block on current models. It now joins the text blocks.
- **Abandoned answers kept generating.** Cancelling an Ask or Live Answer stream now aborts the HTTP request.

#### Added

- **Presets `claude-opus-5-5` (default), `claude-sonnet-5-5` and `claude-haiku-5-5`.** An "Anthropic LLM Model ID" field in Settings takes a comma-separated list of `claude-…` IDs, tried in order, as Gemini's does.
- **Failover modelled on Gemini's** (`anthropic.js`), for Ask, Live Answer and Live Insights:
  - cooldowns per model;
  - `_reset` / `_final_model`;
  - a first-text timeout (20 s for Haiku, 45 s for others), a 30 s idle timeout once text streams, and a 60 s deadline for an answer to start;
  - a second round after 2 s for fast failures;
  - a short `userMessage`, and one log line per attempt with no prompt or answer text.
- **The SDK never retries** (`maxRetries: 0`), so no wait happens inside an attempt. No hedged requests.
- **Error classifier `anthropicErrors.js`.** A 404 means the model is not available to the key: 5 min cooldown and a message to pick another model. Refusals move to the next model.
- **Server-side refusal fallback** (`fallbacks: 'default'`) on Opus and Sonnet 5.5. It turns itself off for the session if the API rejects the beta.
- **Requests send no sampling parameters.** `output_config.effort` (`low` by default) goes only to models that accept it, and `max_tokens` is at least 4096 on models that think.
- **Optional tuning:** `ANTHROPIC_EFFORT`, `ANTHROPIC_MIN_MAX_TOKENS`, `ANTHROPIC_FIRST_TEXT_TIMEOUT_MS`, `ANTHROPIC_REQUEST_DEADLINE_MS`, `ANTHROPIC_IDLE_TIMEOUT_MS`, `ANTHROPIC_SERVER_FALLBACK`.
- **`scripts/smoke-anthropic-sdk.js`** checks that the SDK loads and streams under Electron's Node.

#### Changed

- **`@anthropic-ai/sdk` 0.56.0 → 0.133.0.**
- **Key validation lists one model** (free, names no model) instead of calling one.
- **`chat()` and `generateContent()` stream internally.** A non-streaming response sends its headers only when the whole answer is written.
- **The cooldown registry moved from `geminiModelRotator.js` to `modelHealth.js`**, shared by both providers. Gemini re-exports it unchanged.

#### Docs

- `ARCHITECTURE.md` §10 is now "Gemini and Anthropic failover". It has a new §10.2 and the new provider rows.
- New `docs/diagrams/15-anthropic-failover.mmd`. Diagram 10 now shows the `claude-` prefix and the shared registry.
- `docs/LIVE_INSIGHTS_AND_ASK.md` §4.6, `docs/AUDIO_AND_STT.md` and the README name the new presets.

### Live Answer career context (branch `2026-10-11-live-answer-career-context`)

#### Added

- **Personal answers from your notes.** When the interviewer asks about the candidate's own background (behavioral stories, past projects, "why us"), Live Answer answers in first person from a local folder of career notes (`CAREER_KB_PATH`). It shows a muted "from: …" line naming the notes it used. Off by default; with the variable unset, the LLM messages are byte-identical to before.
- **Live check of career answers.** When an answer that used the notes finishes, any number, or employer, project or company name from the manifest, that the notes and the conversation don't contain is listed under it: "⚠ not in your notes: …" (`answerCheck.js`).
- **`src/features/common/career/`**, a provider-agnostic module:
  - markdown chunker (a short intro joins the subsection under it; a split table repeats its header row);
  - deterministic intent router (personal / company / ambiguous / general, English and Portuguese, follow-ups);
  - BM25 index;
  - multilingual embeddings (transformers.js 4.2.0 + `snowflake-arctic-embed-m-v2.0` in an Electron `utilityProcess`) of each chunk's text and of its section title, fused with BM25 by reciprocal rank fusion, one section per note file;
  - company scoping;
  - a context block of up to six notes, 9,000 characters, led by a canonical-facts card.
- **Optional `glass-kb.json` manifest** at the notes root: include/exclude globs, the canonical card, employer names, and per-company prep folders with aliases.
- **`CAREER_KB_COMPANY`** pins the interviewing company. **`CAREER_KB_VECTORS=off`** keeps retrieval keyword-only and never starts the embedding model (~0.7 GB RAM).
- **`scripts/eval-career-kb.js`** reports router accuracy, recall (leave-source-out), company leaks and per-stage latency against `<KB>/glass-eval/questions.jsonl`.
- **`scripts/ask-career-kb.js`** shows what Live Answer would retrieve for a question: the route, the ranked sections with their place in each ranking, and the block. Both scripts read `.env` and reuse the app's vector cache.
- **Tests:** about 310 new `node:test` cases with synthetic fixtures (the real notes never enter the repo).

#### Changed

- **The question gate also accepts statement-form career prompts** ("your biggest weakness") while the career module is ready. With it off, the gate is unchanged.
- **`live-answer-update` answer payloads carry `sources`** (note titles) when career context was injected. Status payloads are unchanged.
- **Packaging:** `onnxruntime-node` is `asarUnpack`'d, and only the target platform's binaries ship. `onnxruntime-web` is excluded.

#### Fixed

- **A replaced answer no longer clears the newer answer's in-flight state.** The debounce callback's `finally` now clears `inFlight`/`inFlightController` only when they still belong to it. Before, a third question could fail to abort the second.

#### Docs

- `docs/LIVE_INSIGHTS_AND_ASK.md`:
  - new §4.7 (career context) and §4.6 (Gemini failover, hedge, 60 s deadline, `LIVE_ANSWER_DEBUG`);
  - §4.1 now describes the current question gate;
  - stale `summaryService.js` line references fixed (also in `ARCHITECTURE.md`).

### Interview Live Answer Lane (branch `feat/stt-interview-question-wiring`)

#### Added

- **Streaming Live Answer lane** — `summaryService.js` gains an additive answer lane beside Live Insights. When the interviewer (`them:`) asks a detectable question, an 800 ms debounced streaming LLM call produces a real-time markdown answer above the existing Live Insights panel. The analysis lane is unaffected (FR-017 lane independence).
- **`live-answer-update` IPC channel** — new main→renderer channel in the `summaryView` preload namespace (`src/preload.js`). Two methods: `onLiveAnswerUpdate(cb)` and `removeAllLiveAnswerUpdateListeners()`. The existing `summary-update` channel is untouched.
- **`<live-answer-view>` Lit element** (`src/ui/listen/summary/LiveAnswerView.js`) — renders a newest-first, in-session **history** of streamed sanitized-markdown answers in the insights pane above `<summary-view>`, each labelled with the interviewer question it answered. Subscribes to `live-answer-update`; tears down on disconnect. `resetAnswer()` clears the history on session reset.
- **Pure helper exports** from `summaryService.js` for unit testing without Electron coupling: `isLikelyQuestion`, `normalizePassive`, `parseAnswerOrPassive`, `shouldTriggerAnswer`, `parseLiveAnswerSseLine`, `normalizeTail`.
- **43 `node:test` tests** in `src/features/listen/summary/__tests__/liveAnswer.test.js` — pure-helper unit tests (TDD RED→GREEN), SSE line parser tests, and six integration scenarios: debounce coalescing (AS-4), de-dup same-tail (AS-6), abort-and-replace (AS-5), PASSIVE suppress hold-last (AS-3), mid-debounce/mid-stream session close (AS-8), lane independence (AS-7). LLM provider mocked throughout.
- **`liveAnswerHistory.js` pure reducer** (`src/ui/listen/summary/liveAnswerHistory.js`) — `applyLiveAnswerUpdate(answers, payload, max)` folds a `live-answer-update` into the newest-first history (coalesce-by-`id`, prepend new, cap the tail). Pure / DOM-free, unit-tested by 10 `node:test` cases in `src/ui/listen/summary/__tests__/liveAnswerHistory.test.js`.

#### Changed

- **Live Answer is now a newest-first history, not a single hold-last panel.** Each interviewer question's answer is kept as its own entry (newest on top, labelled with the question it answered) instead of overwriting the previous one. The lane scrolls and is capped at the 20 most recent answers. History is **in-session only** — held in renderer memory and cleared on Stop / new session (not persisted to the DB; cross-session persistence remains future work, see `docs/future-work.md`).
- **`live-answer-update` payload gained `id` + `question`.** `summaryService.makeLiveAnswer` now stamps each answer with a stable monotonic `id` (constant across one answer's stream — including a Gemini `_reset` restart — and new per question) and the triggering `question` text. The renderer keys its history on `id`: same-`id` deltas update one entry in place (streaming); a new `id` prepends a new entry.
- **Insights-mode window height now counts the Live Answer lane** (`ListenView.adjustWindowHeight`) so a growing answer history isn't clipped by the `overflow:hidden` assistant container.

#### Internal

- `summaryService.js` constructor gains answer-lane state fields: `lastAnsweredTail`, `answerDebounceTimer`, `inFlightController`, `inFlight`, `hadFallback`, `lastAnswerTs`.
- `resetLiveAnswer()` folded into `resetConversationHistory()` — no `listenService.js` edit required; existing reset calls at session start/close already suffice.
- `ListenView.js` imports `LiveAnswerView.js` and places `<live-answer-view>` above `<summary-view>` with `resetAnswer()` wired into the session-reset block.

### Interview Live Answer — Readability (branch `feat/live-answer-readability`)

#### Changed

- **Improved Live Answer readability** — the injected user message in `summaryService.makeLiveAnswer` now unconditionally reinforces a headline + markdown bullet list structure: a short one-sentence headline answer is always requested first, followed by supporting points formatted as real `- ` markdown bullet lines when there are multiple points. Single-line answers are not forced into bullets. The PASSIVE directive (`reply EXACTLY: PASSIVE`) is preserved verbatim and unaffected.
- **History Q: label shows only the extracted question span** — a new pure helper `extractQuestion(text)` in `summaryService.js` isolates the interrogative span from filler-laden interviewer turns (e.g. *"Okay so, um, the thing I wanted to ask is — how would you design a rate limiter?"* → *"how would you design a rate limiter?"*). The helper reuses the four existing question-signal regexes (`CLAUSE_LEAD_RE`/`LEAD_STRIP_RE`/`CONTENT_CUE_RE`/`EMBEDDED_Q_RE`) with no divergent heuristic; for multi-question turns it returns the **last** interrogative clause (most-recent question, RD5), and **leading discourse markers are peeled from that clause** (`LEAD_STRIP_RE`) so a conjunction-led question surfaces bare (e.g. *"What's your name? And where are you based?"* → *"where are you based?"*, not *"And where are you based?"*). Non-string or empty inputs always return `''`; non-empty inputs never return empty (falls back to the full trimmed turn).

#### Internal

- `extractQuestion` is exported from `summaryService.js` alongside the existing pure helpers (FR-009/FR-018). 9 new `node:test` cases in `liveAnswer.test.js`: truth-table T1–T8 (unit) + 1 integration non-regression assertion that the emitted `live-answer-update` `question` field carries the extracted span for a filler-wrapped turn (FR-008).

#### Fixed

- **Question detection is balanced + quota-aware** (live-tested 2026-05-31) — `isLikelyQuestion` triggers on a real question signal (`?` anywhere, an imperative/interview cue, an embedded/indirect question, or a wh-word/auxiliary leading any clause after peeling "okay so…") and skips the interviewer's declarative monologue so a low daily LLM quota isn't spent on non-questions. Catches questions the original `?`-tail/first-word-opener heuristic missed (imperative prompts "Design a cache", conjunction-led "okay so how…", buried/indirect questions) while not firing on every turn. Known by-design gap: cue-less statement-form prompts; PASSIVE remains the backstop for any false trigger.
- **Terse answers no longer dropped** — `makeLiveAnswer` flushes an answer shorter than the ~16-char prefix-buffer threshold when the stream ends, instead of discarding it (e.g. *"42."*, *"Yes, it is."*).
- **Native PASSIVE phrase suppressed mid-stream** — `parseAnswerOrPassive` treats a ≥16-char prefix of the native *"Not sure what you need help…"* phrase as PASSIVE at the buffer decision point (FR-010); previously only the literal `PASSIVE` token / full 42-char phrase suppressed, so the native phrase leaked to the panel.
- **Streamed answer now actually renders as markdown (was raw `**`/`-`).** `LiveAnswerView.loadLibraries` fetched `marked`/`highlight`/`DOMPurify` from `../../../assets/`, which resolved to the repo root (`glass/assets/`), 404'd, and the throw aborted the loader *before* `isLibrariesLoaded` was set — so `marked` never ran and the panel showed raw markdown syntax. Fixed the path to `../assets/` (relative to `content.html` in `src/ui/app/`) and made each library load independent (best-effort `try/catch` per script) so one failure no longer aborts the rest; markdown renders whenever `marked` is present (`highlight` only adds code highlighting, `DOMPurify` gates sanitization).
- **`marked` v4 namespace call fix.** marked v4's UMD build exposes a *namespace object* (`{ parse, setOptions, … }`), not a callable, so `this.marked(text)` threw and the answer silently fell back to plain text. `renderAnswers` now calls `this.marked.parse(text)` when present, falling back to a direct call for builds where `marked` itself is the function.
- **Answer no longer freezes mid-stream.** Binding the answer text as a Lit child (`${a.text}`) *and* overwriting the same node's `innerHTML` in `renderAnswers` corrupted Lit's child reconciliation under per-token streaming, freezing the answer mid-stream (only a full re-render recovered it). `render()` now emits an **empty** `.answer-body` container (no Lit child binding) and `renderAnswers()` owns its content exclusively — Lit owns only the attribute, so the two never conflict.
- **Streaming answer no longer clipped.** `LiveAnswerView.updated` now dispatches a `live-answer-updated` event on every update and `ListenView` re-measures + resizes the listen window on it (mirroring stt-view's `@stt-messages-updated` → `adjustWindowHeightThrottled`). Previously the window was resized only on a view-mode toggle, so a long streaming answer stayed clipped by the `overflow:hidden` assistant container until you toggled away and back.
- **Answers survive the transcript↔insights toggle and never blank.** `render()` emits the empty `.answer-body` container and `renderAnswers()` fills it from `this.answers` (the source of truth) on **every** update — plain text until the markdown libraries load, then sanitized markdown — so a re-show always re-renders from state rather than a destroyed DOM node. Without `DOMPurify` the body falls back to plain text instead of injecting unsanitized LLM markdown via `innerHTML` (XSS guard).
- **Summary lane no longer truncated during recording — independent, window-bounded lane scrolling** (FR-019/FR-020). In insights mode the Live Answer and Summary lanes were two independent scrollers with fixed `max-height` thresholds (`.live-answer-container` 280px, `.insights-container` 600px) stacked in an auto-height (`height:100%`, collapsed) container. The listen window is capped at 700px (`ListenView.adjustWindowHeight` → `Math.min(700, idealHeight)`), so once `top-bar (32) + live-answer (≤280) + summary (≤600)` exceeded the cap, the bottom of the Summary (content after the *Actions* heading) overflowed the OS **window edge with no scrollbar** — the Summary's own `overflow-y:auto` only engaged after *its own* content passed 600px, which happened only when **Stop** appended the *Follow-Ups* section (hence "scroll appears only after Stop"). Fixed by bounding each lane to a flex layout that fits inside the window: the assistant container is now `height:100vh` (a definite height — `height:100%` collapsed against the auto host chain); a non-scrolling `.insights-pane` flex distributor (`ListenView.js`) hands the two lanes a definite height to divide; the Live Answer lane stays compact/pinned (`:host{flex:0 0 auto}`, keeps its ≤280px scroll — `LiveAnswerView.js`) and the Summary lane takes the rest (`:host{flex:1 1 0; min-height:0}` + `.insights-container{flex:1; min-height:0; overflow-y:auto}`, no fixed `max-height` — `SummaryView.js`). The two lanes still scroll **independently**. `adjustWindowHeight` now measures the Live Answer lane's capped host `scrollHeight` plus the Summary's new read-only `SummaryView.getContentHeight()` (the flex-bounded summary host `scrollHeight` would under-report the clipped height), and re-measures on both `live-answer-updated` and the mirrored `summary-updated` event (`a0cb5ae`). The summary-lane data path, the `summary-update` channel, and the `structuredData` shape are unchanged; transcript mode was never affected (one lane, `32 + 600 < 700`).

#### Internal — diagnostics

- Verbose live-answer trace logging gated behind the `LIVE_ANSWER_DEBUG=1` env var (`laDebug()` helper) — silent by default, never logs answer text.

### Documentation

#### Added
- **`docs/AUDIO_AND_STT.md`** — deep reference for the audio + STT subsystem: two-channel `"Me"`/`"Them"` source attribution, per-platform capture matrix (Windows native loopback / macOS `SystemAudioDump` / Linux mic-only), Rust/WASM AEC, the full STT/LLM provider matrix, Deepgram setup + caveats, and STT resilience vs. failover. All claims carry `file:line` references.

#### Fixed
- **README "How It Works" — corrected Windows audio capture.** The audio-sources table claimed system audio was *"macOS only"* and that *"on Windows/Linux only the user's mic is captured."* Windows in fact captures system audio via Electron native loopback (`src/index.js:175-182` + `listenCapture.js:515-566`); only **Linux** is mic-only. Table now lists all three platforms and notes AEC coverage.
- **README "Currently Supporting" list** — added Anthropic Claude (LLM) and Deepgram (STT), which were already wired but undocumented; clarified which providers do LLM vs STT.

### Gemini hedged requests, request deadline + Live Answer status (branch `feat/gemini-hedged-requests`)

On 2026-10-06 between 15:27 and 15:47 BRT, 4 of 16 Ask requests were cancelled after 73–99 s. `gemini-3.5-flash-lite` stalled to the 25 s timeout on 6 of 16 attempts, and 503s took 4–38 s to arrive. The 60 s cooldown after each stall pushed later requests onto worse models. A fresh request to the same model, right after a stall, usually answered in 9–14 s.

#### Added

- **Hedged (parallel) request** in the streaming path (Ask, all modes, and Live Answer):
  - **When:** a Flash-Lite request that has sent nothing after 10 s (`hedgeDelayMs`) gets a second request to the same model.
  - **Who wins:** the first request to send a chunk is streamed, and the other is aborted. The consumer never sees the race.
  - **Deadline:** the attempt's timeout still counts from its start, so the worst case per model is unchanged.
  - **Errors:** an error before the hedge starts fails the attempt at once, as before.
  - **Scope:** Flash-Lite only, because Flash's free tier allows 20 requests a day and thinking models are silent for long stretches by design.
  - **Configuration:** `GEMINI_HEDGE_DELAY_MS` overrides the delay (`0` disables). `createStreamingLLM({ hedgeDelayMs })` takes `null` to disable.
  - **Log:** attempt lines gain `hedge=<ms>` and `winner=first|hedge`, and the request line gains `hedges=N`.
- **Live Answer status line:** the panel shows "Trying <model>…" while the provider fails over, and "No answer — <reason>" when a question gets no answer (all models failed, or an empty response). Previously the panel silently kept the previous answer.
  - `summaryService` sends `status` payloads (`retrying` / `idle` / `error`) on `live-answer-update`.
  - The new pure reducer `applyLiveAnswerStatus` (`liveAnswerHistory.js`) turns them into the line.
  - `parseLiveAnswerSseLine` now returns the `_reset`'s `nextModel` and `reason`.
- **60 s request deadline (streaming):**
  - **Rule:** a request gives up when no answer has started within 60 s, counted across every attempt, hedge and the second round (`REQUEST_DEADLINE_MS`).
  - **How:** each attempt's timeout is shortened to what is left, and the second round is skipped when less time is left than its wait.
  - **Message:** `No answer within 60s (N attempts). Last: <model> — <reason>`.
  - **Long answers:** once any chunk has arrived the deadline no longer applies, so a long answer is never cut.
  - **Configuration:** `GEMINI_REQUEST_DEADLINE_MS` overrides it (`0` disables). `createStreamingLLM({ requestDeadlineMs })` takes `null` to disable.
  - **Why:** with `…,gemini-3-flash-preview` last in the list, the first round alone could take 25 + 25 + 60 s.
- 31 new `node:test` cases:
  - 21 in `gemini.test.js`;
  - 3 in `liveAnswer.test.js`, two of them on the real debounce callback with mock timers;
  - 7 in `liveAnswerHistory.test.js`.

#### Changed

- **Cooldown after a first-chunk timeout:** 60 s → 10 s (`TIMEOUT_COOLDOWN_MS`). 503 and 429 keep `Retry-After` or 60 s.
- **Cancelling a stream** aborts every in-flight request: both sides of a hedged attempt, and the wait between rounds.
- **Lite detection** (`isLiteModel`) matches a `lite` segment anywhere in the ID, not only a `-flash-lite` ending. Suffixed IDs such as `gemini-2.5-flash-lite-preview-06-17` and `gemini-flash-lite-latest` now get the 25 s timeout and the parallel request.
- **All-failed message** pluralizes `attempt` (`(1 attempt)`). The per-attempt timeout error is rounded (`no response after 12.35s`).
- **`docs/diagrams/11-gemini-failover.mmd`** now shows the hedge, the timeout cooldown, the request deadline, and the second round from the previous branch.

### Gemini stream end + retry round (branch `fix/gemini-stream-end-and-retry`)

From the 2026-10-06 log: one Ask answer arrived complete in 16 s but the connection stayed open ~7 s more, so the request was logged `answered_by=none … cancelled` when the window closed. Another request failed on all three models (one first-chunk timeout, two quick 503 "high demand") and had to be resent by hand.

#### Added

- **Second round when every model fails (streaming: Ask and Live Answer)** — the models whose failure was quick and transient (500/502/503/504, network) get one more try after 3 s (`RETRY_ROUND_DELAY_MS`, `MAX_ROUNDS = 2`; `createStreamingLLM({ retryRoundDelayMs })` overrides the wait). First-chunk timeouts (25-60 s each) and 429s (quota) are left out. The round is announced with `_reset` `{ reason: 'retry' }`, so the Ask header shows "Thinking... trying <model>" during the wait, and logged as `all models failed — retry round 2 in 3000ms: …`. Cancelling during the wait stops it. The non-streaming path keeps one round.
- **Attempt log fields** — `last=` (time of the last chunk; `total - last` is how long the connection stayed open after it), `chunks=` and `finish=` (the `finishReason`).
- 6 new `node:test` cases in `gemini.test.js`.

#### Changed

- **All-failed message** — `All Gemini models failed (N attempts[, 2 rounds]). Last: …` (was `(N tried)`).
- **Cancelled after text arrived** — the request line now reads `answered_by=<model> … cancelled` (was `answered_by=none`), and the model is kept healthy.

#### Fixed

- **Complete answer stuck in "streaming" until the server closed the connection** — an attempt now ends at the chunk carrying `finishReason`: it is logged `ok` at once, `_final_model` + `[DONE]` are sent (Ask stops streaming and saves the answer), and the leftover connection is aborted.

### Ask stalled-response fixes (branch `fix/ask-stalled-responses`)

Two Ask requests on 2026-10-06 showed nothing and had to be resent: the log shows `gemini-3.5-flash-lite` accepted them and sent its first chunk only after ~96 s (`outcome=aborted ttft=95741ms`), while the window showed an empty "AI Response". No 503 involved.

#### Added

- **First-chunk timeout per Gemini attempt** — `gemini.js` aborts an attempt that sends nothing within `firstChunkTimeoutMs(modelId)` (25 s for `*-flash-lite`, 60 s for models that think first; `GEMINI_FIRST_CHUNK_TIMEOUT_MS` overrides) and fails over to the next model (`_reset` with `reason: 'timeout'`, log `outcome=timeout`). The request's `AbortSignal` is passed to `generateContentStream`. Only the first chunk is timed.
- **`askStreamState.js`** — pure reducer `applyAskSseEvent` for the Ask SSE stream (no Electron), now used by `askService._processStream`; `askService-sse.test.js` tests it directly instead of a mirrored copy of the loop.
- **"Thinking... trying <model>"** — the Ask header shows which model is being tried after a failover (`state.retryingWith`).
- 14 new `node:test` cases (9 in `gemini.test.js`, 5 in `askService-sse.test.js`).

#### Fixed

- **Ask showed an empty "AI Response" while waiting** — `isLoading` was cleared as soon as the stream object was created; it now stays on (loading dots + "Thinking...") until the first token, and again after a `_reset`.
- **Closing the Ask window or resending did not stop the Gemini request** — the provider stream now has a `cancel()` that aborts the in-flight HTTP request and stops failover; previously the abandoned request kept running (and consuming quota) in the background. Live Answer now cancels its reader as soon as a newer question aborts it, instead of waiting for the next chunk.
- **Errors were never shown** — `ask-response-stream-error` had no listener. `askService` now sets `state.errorMessage` (Gemini errors carry a short `userMessage`, e.g. `All Gemini models failed (3 tried). Last: … — [503 Service Unavailable] The model is overloaded.`), plus `The model returned an empty response.` when a stream ends with no text; the Ask window renders it (as text, not HTML).
- **A replaced request could overwrite the new request's state** — `_processStream` of an aborted request ran its `finally` after the new request had started and reset `isLoading`/`currentResponse`; it now only updates state while its `AbortController` is still the current one.
- Unhandled rejection of the SDK's aggregated `response` promise when a stream errors.

### Gemini model defaults refresh

#### Added

- **Per-attempt Gemini diagnostics log** — `gemini.js` now logs one `[Gemini Provider] attempt i/n` line per model attempt (streaming and non-streaming) with model, outcome (`ok`/`aborted`/`transient`/`fatal-request`/`fatal-auth`), HTTP status, time to first chunk, total time, token usage incl. `thoughtsTokenCount`, and the server's error reason (SDK prefix and request URL stripped), plus a `request … answered_by=… attempts=… total=…ms` summary. Previously transient failures were silent, so the latency cost of failing over through overloaded (503) models was invisible. 4 new `node:test` cases in `gemini.test.js`.

#### Changed

- **Gemini LLM default `gemini-2.5-flash` → `gemini-3-flash-preview`** (`gemini.js` `createLLM`/`createStreamingLLM`, `factory.js` preset). Since 2026-09-18 Google limits 2.5-model access to accounts that already used them. Google recommends 3.8 Flash for new projects, but on a free-tier project every `gemini-3.5/3.6/3.7/3.8-flash` attempt over 7 days returned 503, while `gemini-3-flash-preview` answered. It is a preview (Google suggests migrating to `gemini-3.6-flash`), so revisit once the newer Flash models stop returning 503.
- **Gemini STT default `gemini-live-2.5-flash-preview` → `gemini-3.8-live`** (`gemini.js` `createSTT` default + empty-CSV fallback, `factory.js` preset). The old preview was shut down 2025-12-09; `gemini-3.8-live` is Google's listed replacement.
- **Settings help text** — failover example now `gemini-3-flash-preview,gemini-3.5-flash-lite,gemini-3.1-flash-lite`, the models that actually answered on the free tier (was `gemini-3-pro,…`, an ID that never existed); LLM/STT placeholders now `gemini-3-flash-preview` / `gemini-3.8-live`. `ARCHITECTURE.md`, `docs/AUDIO_AND_STT.md` and diagrams 10/11 updated to match.
- Saved model selections are untouched: a previously stored ID like `gemini-2.5-flash` still resolves to Gemini and shows as `(custom)`.

### Gemini Failover (branch `feat/gemini-failover`)

#### Added
- **CSV model failover for Gemini LLM** — `selectedLlmModel` now accepts a comma-separated priority list (e.g. `gemini-2.5-flash,gemini-2.5-flash-lite`). On transient errors (HTTP 408/429/500/502/503/504, SDK codes `RESOURCE_EXHAUSTED`/`UNAVAILABLE`/`DEADLINE_EXCEEDED`, network/timeout), the current model is cooled down and the next is tried automatically. (`2296a39`)
- **In-memory cooldown registry** (`geminiModelRotator.js`) — singleton `Map` tracking per-model cooldown expiry. Honors `Retry-After` header and SDK `retryDelay` from `RetryInfo`; default 60s; clamped to `[5s, 300s]`. Exports: `pickModel`, `markFailed`, `markSucceeded`, `classifyError`, `parseRetryAfter`, `parseModelList`, `resetHealth`. (`2296a39`)
- **Per-response footer** in `AskView.js` — muted `answered by: <model>` line below the response body when `responseModel` is set. Shows `(fallback)` suffix when at least one failover occurred during the stream. (`2296a39`)
- **Settings help text** under the Gemini LLM Model ID input explaining comma-separated failover format with example. (`2296a39`)
- **New SSE sentinels** emitted by `createStreamingLLM`: `{_reset, next_model, reason}` (tells consumer to discard accumulated output before the next model streams) and `{_final_model}` (records which model completed the response). (`2296a39`)

#### Changed
- **CSV semantics on `selected_llm_model`** — the existing free-text model ID field now accepts a CSV; persisted as opaque TEXT in SQLite (no schema change). Single-model entries behave identically to before. (`2296a39`)
- **Frontend CSV validator** in `SettingsView.js` — `handleSaveGeminiModels` now splits on `,`, trims each entry, drops empties, and validates every non-empty token starts with `gemini-` (previously validated the whole string, which passed `"gpt-4,gemini-2.5-flash"` by accident). Persists the trimmed-rejoin string, not the raw input. (`2296a39`)
- **`createSTT` first-model-only** — `createSTT` extracts only the first CSV entry via `parseModelList(csv)[0]`; no failover for live STT sessions (locked decision #3). (`2296a39`)
- **`controller.error()` wrapped in `try/catch`** in both the fatal-error and all-models-failed branches of `createStreamingLLM` — defense in depth against `ERR_INVALID_STATE` on consumer cancel. (`2296a39`)

#### Internal
- New test files: `geminiModelRotator.test.js` (27 unit assertions covering all 7 exports) and `gemini.test.js` (9 integration cases covering failover loop + streaming sentinels) and `askService-sse.test.js` (6 cases covering `_reset`/`_final_model` handling). (`2296a39`)
- Added `npm run test` script using `node:test` (Node 18+ built-in; no new dev dependencies required). (`2296a39`)

---

### Ask Mode Shortcuts (branch `feat/ask-mode-shortcuts`)

#### Added
- **Ask mode picker** — a `▾` caret next to the Ask pill in the main header opens a dedicated mode-picker `BrowserWindow` with four modes: **Default**, **Code**, **Debug**, **System Design**. The selected mode persists in `electron-store` and reshapes the system prompt sent to the LLM. The header badge updates live to show the active mode (`Ask`, `Ask · Code`, `Ask · Debug`, `Ask · SysDes`). (`f442024`)
- **Three new prompt profiles** in `promptTemplates.js`: `pickle_glass_code`, `pickle_glass_debug`, `pickle_glass_system_design`. The original `pickle_glass_analysis` (Default) is untouched. (`f442024`)
- **`preferredCodeLanguage` setting** — free-text field in Settings (default `go`) injected into the Code profile via a `{{PREFERRED_LANGUAGE}}` token. Falls back to `__INFER_FROM_SCREENSHOT__` when blank. (`f442024`)
- **6 new IPC handlers** in `featureBridge.js` — `mainHeader:getAskMode`, `mainHeader:setAskMode`, `mainHeader:openModePicker`, `mainHeader:cancelHideModePicker`, `modePicker:closeWindow`, `settings:{get,set}PreferredCodeLanguage`. (`f442024`)
- **`mainHeader:askModeChanged` push event** — targeted broadcast from `featureBridge` to the header window so the badge updates immediately on selection (avoids the dead `settings-updated` broadcast). (`f442024`)

#### Changed
- **System Design prompt — section 5 split** into separate **Data Model** (§5) and **High-Level Architecture** (§6); subsequent sections renumbered through §11. (`216f0db`)
- **System Design prompt — added §0 Opening Pitch + restructured §6 into 3 phases** (post-impl refinement). Added §0 Opening Pitch that streams FIRST (read verbatim at interview minute 1, BEFORE clarifying questions; must contain dominant constraint, scale number with DAU or peak QPS, and two highest-stakes ambiguities). Restructured §6 (High-Level Architecture) into three labelled phases — Baseline / 10× Scale / Multi-region — with ONE ASCII diagram (Phase 1 only — Phases 2 and 3 are bullet deltas, NOT new diagrams, for overlay glanceability). Each phase carries its own ≤25-word say-aloud sentence. Added a consolidated **Trade-off Roll-up table** (`Phase | Decision | Chose | Rejected | Why`, 6-10 rows) as the single source of truth for per-decision alternatives. Captures the "draw + narrate + offer two alternatives in each block" signal that separates senior from staff/principal at this interview stage. (uncommitted)
- **System Design prompt — §8 reframed, §10 stripped** (post-impl refinement). §8 renamed from "Scaling, Bottlenecks & Failure Modes" to "Mechanisms & Failure Handling" — the HOW-it-works layer under §6 Phase 2/3 (sharding mechanism, caching mechanism, hot-key handling, component-failure response with user-visible degradation); removed the redundant "what breaks at 10× load" bullet, which Phase 2 now owns. §10 stripped from three to two transition snippets (Opening Pitch moved to §0), renamed to "Mid-Interview Say-Aloud Snippets". Total section count is now 12 (numbered 0-11), aligned with the actual interview-clock flow top-to-bottom. (uncommitted)
- **System Design prompt — output-rule discipline tightened** (post-impl refinement). Per-decision alternatives MUST live in the §6 Roll-up table only — no prose duplication. §5 storage-tech rows now name rationale only. Added an explicit carve-out preserving §7's per-probe `tradeoff` line as operational cost (what you give up by choosing the mechanism), NOT the rejected alternative. Added a §3↔§0 numeric reconciliation rule that catches the most common live-interview slip — stating one scale number aloud, then computing math under a different one. Intro now names the three-signals combo (phased architecture + spoken narration per phase + per-decision alternatives) as the explicit senior↔staff differentiator. (uncommitted)
- **Main header width** bumped `353 → 393px` at both startup (`windowManager.js`) and state transitions (`HeaderController.js`) so the new badge + caret no longer clip the settings gear. (`525dcb1`)
- **Summary follow-up actions** now reject with a user-visible `alert()` when `askMode !== 'default'`, preventing the regression where Listen-summary clicks silently inherited the active Ask mode. (`f442024`)
- `.gitignore` — exclude `.claude/` and `.specify/` to keep session-local tooling out of the repo. (`99900ec`)

#### Fixed
- **Mode-picker window never created on apikey → main transition** — `createFeatureWindows(header)` (no-arg form) hit the default branch which omitted `mode-picker`, so hovering the caret logged `Window 'mode-picker' not found or destroyed`. Added `mode-picker` to the default registration list. (`7aaea03`)
- **Mode-picker closed immediately on hover** — the picker had no hover bridge, so the 200ms hide debounce fired before the mouse reached it. Added `mouseenter`/`mouseleave` host listeners on `ModePickerView` mirroring `SettingsView.handleMouseEnter`/`handleMouseLeave`, calling `cancelHideModePicker` / `closeWindow` respectively. (`7aaea03`)
- **Gemini stream `ERR_INVALID_STATE` enqueue-after-close** — when `AskService` aborted a prior request mid-stream (user fires a new `Ctrl+Enter` before the previous response finishes), the consumer cancelled the stream but the producer's `for await` loop kept enqueueing into a closed controller, crashing the stream and leaving askService wedged so subsequent Ctrl+Enter presses produced no response. Wrapped enqueue/close in a `safeEnqueue` helper guarded by `controller.desiredSize === null`. (`525dcb1`)

---

### Earlier fork work on `main`

#### Documentation
- **`docs: add How It Works section to README`** — documents the verified runtime behavior of Ask and Listen, including the screenshot capture path, STT pipeline, summary cadence, storage schema, and the known gap where Listen transcripts are not passed into Ask queries. (`9e60646`)

#### Changed
- **`raise maxTokens defaults to each provider's API max`** — stops Ask responses from truncating mid-output. Per-provider defaults: Gemini 65536, OpenAI 32768, Anthropic 8192, Ollama −1 (unlimited). `askService` no longer forces 2048 over the per-provider value. (`591f971`)
- **`allow custom Gemini LLM/STT model IDs via free-text input`** — adds text inputs in the Gemini settings card to set arbitrary model IDs (e.g. `gemini-2.5-pro`), stored through the existing `setSelectedModel` pipeline. Auto-selection no longer clobbers the user's choice when Whisper/Ollama go offline but STT/LLM aren't actually using them. (`bc12688`)

#### Fixed
- **`honor custom Gemini STT model and stop crashing on closed sessions`** — `createSTT` in the Gemini provider was destructuring config but hardcoding `gemini-live-2.5-flash-preview`, silently dropping any user-selected STT model. Wired `modelInfo.model` through `sttService` → `sttOptions` → `createSTT`. Also fixed the `listen:sendSystemAudio` IPC handler crashing with *"Cannot read properties of undefined (reading 'success')"* when the STT session was already closed, by routing the call through the existing `handleSendSystemAudioContent` wrapper. (`4882438`)

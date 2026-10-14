# Research: OpenAI-compatible Provider

## R1. OmniRoute as a provider (reviewed 2026-10-14)

Source: the repository [`diegosouzapw/OmniRoute`](https://github.com/diegosouzapw/OmniRoute), cloned at commit `9ecddd1` (2026-10-13, v3.8.52), MIT license. Read: `README.md`, `llm.txt`, `docs/reference/FREE_TIERS.md` (last researched 2026-06-17, partial re-audit 2026-09-02), `docs/security/STEALTH_GUIDE.md`, `docs/security/PUBLIC_CREDS.md`, `open-sse/config/freeModelCatalog.data.ts`, `src/app/api/v1/models/catalog.ts`, `.env.example`.

**What it is.** A self-hosted AI gateway: a Next.js 16 server with SQLite (202 migrations), a dashboard, a 110-tool MCP server, a MITM proxy and its own Electron app. It exposes an OpenAI-compatible endpoint (`http://localhost:20128/v1`) and routes each request to one of 372 providers through "combos" (ordered fallback lists, 19 strategies). The routing engine (`@omniroute/open-sse`) is `"private": true`: it cannot be imported. It needs Node ≥ 22.22; Glass's Electron 30 runs Node 20. So it would always be a separate process the user starts before an interview.

**The free budget.** The headline is "~1.62B tokens/month". By OmniRoute's own breakdown:
- 1.00B is Mistral's free plan, a figure visible only in the account console;
- ~510M comes from resellers of unclear origin (nara 210M, llm7 150M, xkiro 150M);
- 30M is Groq (five per-model 200K-TPD caps), which Glass already uses;
- Cerebras is now a one-time $5 credit that needs a payment method;
- Gemini and Ollama Cloud are "uncapped" but rate-limited, and are not summed.

For Live Answer, which needs fast, free and image-capable models together, little is left beyond what Glass already has.

**Terms.** The "free Claude / GPT" part of the pitch reuses the OAuth logins of subscriptions (Claude Code, Codex, Antigravity, Kiro, Cursor…). OmniRoute presents itself as those official clients: it imitates a browser's TLS fingerprint and each CLI's request signature (`STEALTH_GUIDE.md`), and embeds their public OAuth client IDs, XOR-masked so secret scanners miss them (`PUBLIC_CREDS.md`). Its own catalog records that Antigravity and Kiro forbid third-party proxies. The terms flag is advisory only: *"Providers marked `tos` are still included in routing and combo/fallback by default."* Using a subscription's OAuth through it risks the account.

**Privacy.** Glass sends interview transcripts and career notes.
- OmniRoute stores request and response bodies in its SQLite DB (`CHAT_LOG_TEXT_LIMIT` 64 KB per string by default).
- Several "keyless" providers work by scraping web chat UIs (`duckduckgo-web`, `t3-web`, `muse-spark-web`).
- Only 13 catalog entries (Kilo Gateway's) say whether the provider trains on prompts. Elsewhere the flag is not set, which means "not established", not "does not train".

**Fit with Glass's failover.** Behind OmniRoute, Glass sees one model per ID. A combo fails over inside the gateway while the app's 45 s request deadline runs, and the app's per-model health, image routing (`seesImages`, `visionOnly`) and reasoning settings no longer know which upstream answered. The `X-OmniRoute-Decision` response header names it; the provider logs it (`route=`).

**Defaults that matter.** Prompt compression is off by default (`DEFAULT_COMPRESSION_CONFIG.defaultMode: "off"`), so prompts reach the upstream as sent. Its `/v1/models` items carry `max_output_tokens`, `input_modalities` and `capabilities.{vision,reasoning}`, which `normalizeModel` reads.

**Maintenance.** It ships often: 3.8.38 to 3.8.51 between 2026-06-27 and 2026-09-29.

**Conclusion (D1).** Not a replacement for Groq, Gemini or Anthropic, nor a dependency. A generic OpenAI-compatible provider gives the useful part: a direct path to the few free endpoints that matter, and OmniRoute as an optional endpoint. If the user tries OmniRoute, keep it to:
- the last segment of the chain;
- API-key providers only, with OAuth, web and keyless providers off;
- payload logs off;
- a measured ttft first (R2).

## R2. Time to first token (probe)

`scripts/probe-openai-compatible-ttft.js` sends the same interview-sized request to each target, alternating which goes first:
- a system prompt of about 1.1K tokens, with generic interview guidance and no personal data;
- one question;
- `max_tokens` 300, `temperature` 0.3, streamed.

It records time to headers, time to the first answer text and total time. It never prints prompt or answer text, nor a key.

**2026-10-14, first check of the script** (Windows, home connection; 2 runs; the system prompt was then ~2.2K tokens, before it was cut to ~1.1K):

| Target | Model | Runs ok | headers | ttft | total |
|---|---|---|---|---|---|
| groq-direct (`api.groq.com`) | `openai/gpt-oss-120b` | 2/2 | 680, 336 ms | 898, 681 ms | 1193, 1061 ms |
| omniroute (`localhost:20128`) | `groq/openai/gpt-oss-120b` | 0/2 | — | — | "Connection error." in 3–4 ms (not installed) |

**2026-10-14, the comparison** (OmniRoute 3.8.51 on this machine, its default resilience settings; Groq connected in OmniRoute as `groq-measure` with the same key as the direct target; `--runs 6 --gap-ms 20000`):

| Target | Model | Runs ok | headers p50 | ttft p50 | ttft p90 | ttft min–max | total p50 |
|---|---|---|---|---|---|---|---|
| groq-direct (`api.groq.com`) | `openai/gpt-oss-120b` | 6/6 | 374 ms | 558 ms | 2910 ms | 544–2910 ms | 952 ms |
| groq-via-omniroute (`localhost:20128`) | `groq/openai/gpt-oss-120b` | 6/6 | 445 ms | 637 ms | 2737 ms | 617–2737 ms | 999 ms |

- **OmniRoute adds about 80 ms** to the median time to first token (+71 ms to headers). Each target had one ~2.8 s run; they came on different runs, so they are Groq's own variance, not the gateway's.
- The first try (`--runs 10`, 1.5 s apart) hit Groq's 8K tokens-per-minute limit from run 4 on: both targets share one key and each request carries ~1.4K tokens. From then on the direct target got 429 in ~100 ms, while OmniRoute returned 200 with a ttft of 6.2–8.7 s, headers at ~1 s. **OmniRoute absorbs a 429 by waiting and retrying**, which hides the failure from Glass's own failover (the risk noted in R1). Its resilience settings show why: `waitForCooldown` (on, up to 3 retries and 30 s) and `comboCooldownWait` (on, up to 90 s when every combo target cools down). For Glass, turn both off: a 429 should fail at once so the next model in Glass's list answers.
- Command:
  ```
  node scripts/probe-openai-compatible-ttft.js --runs 6 --gap-ms 20000     --target groq-direct,https://api.groq.com/openai/v1,openai/gpt-oss-120b,GROQ_API_KEY     --target groq-via-omniroute,http://localhost:20128/v1,groq/openai/gpt-oss-120b,OMNIROUTE_API_KEY
  ```
  With one Groq key on both sides, space the runs (`--gap-ms`) or the per-minute limit spoils the comparison.

**2026-10-14, the free providers behind `free-stack`** (`--runs 3`, through OmniRoute). These
figures and the setup notes are in `docs/runbook/OMNIROUTE_SETUP.md`.

| Model | Runs ok | ttft p50 | Note |
|---|---|---|---|
| `cohere/command-a-03-2025` | 3/3 | 582 ms | trial key |
| `cloudflare-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast` | 3/3 | 1210 ms | after the connection got its Account ID |
| `openrouter/google/gemma-4-31b-it:free` | 0/3 | — | 429 `rate_limited` from OpenRouter |
| `openrouter/cohere/north-mini-code:free` | 3/3 | 2585 ms | code model; not used |
| `openrouter/dots-studio/dots-3-note-preview:free` | 0/3 | — | no answer within 300 tokens (reasoning) |
| `free-stack` (priority: Cohere → Cloudflare → OpenRouter Gemma) | 4/4 | 618 ms | all served by Cohere. With Cohere inactive: 2/2 by Cloudflare, 1.2–1.4 s |

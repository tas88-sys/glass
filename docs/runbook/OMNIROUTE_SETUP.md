# OmniRoute setup (free models as Glass's last fallback)

How to rebuild, on a new machine, the setup in place since 2026-10-14. OmniRoute runs on this
machine only and puts several free-tier providers (SambaNova, Mistral, OpenRouter…) behind one
address. Glass reaches it through its **OpenAI-compatible** provider
([`ARCHITECTURE.md` §10.5](../../ARCHITECTURE.md#105-openai-compatible-endpoint)), as the **last**
entry of the model list: Groq answers first, then Gemini, then OmniRoute.

Why this shape, and what OmniRoute's free tiers really are: research R1 in
[`specs/2026-10-14-openai-compatible-provider/research.md`](../../specs/2026-10-14-openai-compatible-provider/research.md).
In short: OmniRoute gives no free tokens of its own. Each free provider needs your own account
and key, entered in OmniRoute's dashboard.

---

## 0. What you need

| Item | Version / note |
|---|---|
| Node.js for OmniRoute | `>=22.22.2 <23` or `>=24 <27` (2026-10-14: Node 24.17). Glass itself builds with Electron's own Node; this Node is only for the `omniroute` command |
| npm | 11.x (2026-10-14: 11.13) |
| OmniRoute | `omniroute@3.8.51` from npm (2026-09-29). 3.8.52 was not published yet on 2026-10-14 |
| Free-tier accounts | The three chosen in [Which free providers](#which-free-providers-triage-of-2026-10-14): Cloudflare Workers AI, OpenRouter, Cohere. One account and one key each, made by hand |
| Disk | ~1,160 npm packages; the install took ~11 min |

## 1. Install

Run it **outside** the Glass repo (see Pitfalls):

```bash
cd %USERPROFILE%
npm install -g omniroute@3.8.51
omniroute --version          # 3.8.51
```

The peer-dependency warnings (`ERESOLVE`, `react@18`) are harmless. With npm 11, if npm says it
blocked install scripts, follow OmniRoute's README and allow the packages it names.

## 2. Make it local-only

OmniRoute's defaults are not safe for this use:
- it listens on `0.0.0.0`, so the whole LAN can reach it;
- `REQUIRE_API_KEY=false`, so anyone who reaches it can spend your providers' keys;
- the packaged `.env` ships a fixed initial password.

Its data folder is `%USERPROFILE%\.omniroute`: the database `storage.sqlite` and an `.env` it
reads **first** (the first file that sets a value wins). Start it once (step 3), so it creates the
folder and its `STORAGE_ENCRYPTION_KEY`. Then append this block to
`%USERPROFILE%\.omniroute\.env` and restart it:

```ini
# Local-only OmniRoute for Glass. This file is read first (first wins).
# Listen on this machine only, never the LAN.
OMNIROUTE_SERVER_HOST=127.0.0.1
HOST=127.0.0.1
# Every /v1 request needs a client API key (created in Dashboard -> Endpoints).
REQUIRE_API_KEY=true
# Empty: the dashboard's onboarding asks for the admin password (no CHANGEME default).
INITIAL_PASSWORD=
# Do not keep request/response bodies (interview transcripts) in the database.
ENABLE_REQUEST_LOGS=false
```

Never edit `…\npm\node_modules\omniroute\.env`: the next `npm install -g` replaces it.

## 3. Start it

**Always from its own folder**:

```bash
cd %USERPROFILE%\.omniroute
omniroute serve --no-open --no-tray --daemon     # background, survives the terminal; drop --daemon to watch the log
```

- Use `--daemon`. A foreground `serve`, for example one started by a Claude Code session, stops
  with that session, and so does the `free-stack` fallback.
- Stopping the foreground task can leave its child `node` still listening on 20128. Use
  `omniroute stop`.
- **Warm-up:** right after a start, OmniRoute answered nothing for about 1–2 minutes. On
  2026-10-14, chat requests timed out at 30 s and `/api/health` took 13 s. Then it answered
  normally (health in 7 ms, `free-stack` ttft ~0.8 s). Start it well before an interview; step 3b
  does it at logon.

Check (expected results as of 2026-10-14):

```bash
netstat -ano | findstr ":20128 "              # LISTENING on 127.0.0.1:20128 only
curl -s http://127.0.0.1:20128/v1/models      # {"error":{"code":"AUTH_002","message":"Authentication required",…}}
```

The startup log lists the `.env` files it loaded. `%USERPROFILE%\.omniroute\.env` must come
first, and no Glass `.env` may appear.

## 3b. Start it with Windows (required)

Glass's fallback only works while OmniRoute runs, so it starts at logon. Set up on 2026-10-14;
no administrator rights needed.

1. Create `%USERPROFILE%\.omniroute\start-omniroute.cmd` with **CRLF** line endings. Written with
   LF only, its `>>` redirect did not run and no log came out.
   ```bat
   @echo off
   rem Starts the local OmniRoute gateway for Glass (docs/runbook/OMNIROUTE_SETUP.md in the glass repo).
   rem Runs from this folder so OmniRoute reads this folder's .env first and never a repo's .env.
   cd /d "%USERPROFILE%\.omniroute"
   call "%APPDATA%\npm\omniroute.cmd" serve --no-open --no-tray --daemon >> "%USERPROFILE%\.omniroute\logs\autostart.log" 2>&1
   ```
2. Register the task (PowerShell, as yourself):
   ```powershell
   $action    = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$env:USERPROFILE\.omniroute\start-omniroute.cmd`""
   $trigger   = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
   $settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -Hidden
   $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
   Register-ScheduledTask -TaskName "OmniRoute (Glass local gateway)" -Action $action -Trigger $trigger -Settings $settings -Principal $principal
   ```
   The 5-minute time limit applies to the launcher only: `--daemon` returns at once and the
   server keeps running.
3. Test without logging off:
   ```powershell
   omniroute stop
   Start-ScheduledTask -TaskName "OmniRoute (Glass local gateway)"
   Get-NetTCPConnection -LocalPort 20128 -State Listen     # 127.0.0.1 only
   Get-Content "$env:USERPROFILE\.omniroute\logs\autostart.log" -Tail 5
   ```
   On 2026-10-14:
   - the port was listening on 127.0.0.1 within ~4 s, and the task result was 0;
   - `autostart.log` showed only `%USERPROFILE%\.omniroute\.env` and the package's own `.env`
     loaded;
   - `/v1/models` without a key still answered 401.
4. To undo: `Unregister-ScheduledTask -TaskName "OmniRoute (Glass local gateway)"`, then delete
   `start-omniroute.cmd`.

## 4. Dashboard (by hand, in the browser)

1. Open http://localhost:20128/dashboard/settings/security, turn **Require login** on and set the
   admin password. With
   `INITIAL_PASSWORD=` empty the dashboard starts **without** one (`/api/settings` shows
   `hasPassword: false`): any program on this machine can change it until you set it.
2. **Providers**: add the key of each of the three (see the next section for where to get each).
   - Do **not** connect anything by OAuth (Claude Code, Codex, Antigravity, Kiro, Cursor…).
   - Do **not** add "web", "web-cookie" or "keyless" providers.

   Those reuse subscriptions or scrape chat sites, against the providers' terms (research R1).
3. **Mistral console**: check whether the free plan may use your requests for training, and turn
   it off if so. The prompts carry interview transcripts.
4. **Combos**: create `free-stack`, strategy **priority** (fixed order), one model per provider,
   in the order of the next section's table (its CLI command is there).
5. **Endpoints / API Keys**: create a client API key for Glass, named `glass`, with **no log**
   on. It can also be made without the dashboard, straight into the Glass `.env` without showing
   it (what was done on 2026-10-14):
   ```bash
   curl -s -X POST http://127.0.0.1:20128/api/keys -H 'Content-Type: application/json' \
     -d '{"name":"glass","noLog":true,"scopes":[]}'      # the reply's "key" field is the key
   ```
   The call works without a session only while the dashboard has no password.

## Which free providers (triage of 2026-10-14)

The dashboard's **Free Tier** tab lists 151 providers. Few of them suit Glass, which sends
interview transcripts and needs a fast first token. The source is OmniRoute's own curated catalog
(`open-sse/config/freeModelCatalog.data.ts`, curated 2026-09-12). It lists 78 providers with free
LLM models, and gives each a free type and a terms-of-use verdict (`ok`, `caution`, `ambiguous`,
`avoid`). Those verdicts are OmniRoute's; each provider's own terms were not re-read.

**Left out, and why:**

| Group | Examples | Reason |
|---|---|---|
| Not chat LLMs | Exa, Firecrawl, Context7, AnySearch, ComfyUI, Dify | Search, scraping, images, app builders |
| Verdict `avoid` (13) | Antigravity (agy), Kiro, DuckDuckGo web, T3 web, Blackbox, OpenCode, Fireworks, AI21 | They reuse subscriptions or scrape chat sites |
| Sign-up credit only | DeepInfra, Cerebras, NVIDIA, Vertex, Hyperbolic, Scaleway, Nebius, DeepSeek | The credit runs out: no lasting fallback |
| Chinese identity or CN editions | ModelScope (regional-identity gate), Agnes-CN, GLM-CN, Doubao, Baidu | Hard sign-up, and transcripts would go there |
| Trains on prompts | Kilo Gateway | Transcripts would feed training |
| Resellers of "free Claude/GPT" | Api.airforce, BazaarLink, BluesMinds, xKiro | Unclear source; transcripts would pass through unknown parties |
| Volunteer network | AI Horde | Slow, and whoever runs the model sees the prompt |
| Already in Glass | Groq, Gemini | Glass calls them directly, as layers 1 and 2 |

**Still possible, not chosen:** GLM / Z.ai (international), HuggingFace (small quota), and the
small aggregators Requesty, Navy, Aion, SEA-LION (`ok`) and LLM7, Nara (`caution`, large quotas).
Read a small aggregator's privacy policy before adding it: transcripts would pass through it.

**Chosen on 2026-10-14, in `free-stack` order.** Five were picked from the catalog; two turned
out not to be free (next paragraph), so three are left. The order follows the measured time to
first token (streamed, ~1.1K-token prompt, through OmniRoute):

| # | OmniRoute provider | Where to get the key | Combo model | ttft p50 | Free tier |
|---|---|---|---|---|---|
| 1 | `cohere` | dashboard.cohere.com → API Keys: the trial key `default` | `command-a-03-2025` | 582 ms | Trial key: monthly call cap, non-commercial use |
| 2 | `cloudflare-ai` | dash.cloudflare.com → AI → Workers AI → **REST API**: an API token with the Workers AI permission. The connection **also** needs the Account ID (see below) | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | 1210 ms | Daily neurons, ~150 replies/day for this model (catalog) |
| 3 | `openrouter` | openrouter.ai → Settings → Keys, **after** the privacy setting below | `google/gemma-4-31b-it:free` | — (429 upstream on 2026-10-14) | Daily request cap; the `:free` pool is shared and often full |

Notes from setting them up:
- **Cloudflare Account ID.** Without it every call fails with 502 "Cloudflare Workers AI requires
  an Account ID". The account ID is the hex string in the dashboard URL. It is stored in the
  connection's `providerSpecificData.accountId`. The CLI cannot set it, so it was set from the
  logged-in dashboard tab's console:
  ```js
  const id = '<cloudflare-ai connection id from: omniroute providers list --json>';
  fetch('/api/providers/' + id, {method: 'PUT', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({providerSpecificData: {importFreeModelsOnly: true, accountId: '<account id>'}})})
  ```
- **Model IDs** in OmniRoute's `/v1/models`: `cohere/command-a-03-2025`,
  `cloudflare-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast`, `openrouter/google/gemma-4-31b-it:free`.
  - `cfp/…` is the keyless Cloudflare **playground**, verdict `avoid`.
  - `openrouter/google/gemma-4-31b-it` without `:free` is the **paid** one.
- **OpenRouter `:free` models tested**, the four left after the privacy setting:
  - `gemma-4-31b-it` and `gemma-4-26b-a4b-it` got 429 `rate_limited` from OpenRouter on every
    try.
  - `dots-3-note-preview` spent all 300 tokens reasoning and gave no answer.
  - `north-mini-code` answered, but slowly (ttft 2–6 s), and it is a code model.
  - The Gemma stays last: it serves only when OpenRouter's free pool has room.
- **How a failing model looks through OmniRoute:**
  - Streamed: `200`, a keepalive, then the stream closes empty ("Premature close").
  - Not streamed: the real status (502, 429) with the upstream message.
  - On an upstream 429, OmniRoute's egress still retries 3 times (~5 s) before it gives up, even
    with the two waits of step 6 turned off.
- **Combo** (created by the CLI; JSON because the Cloudflare ID has slashes of its own):
  ```bash
  omniroute combo create free-stack --strategy priority --models '[{"providerId":"cohere","model":"command-a-03-2025"},{"providerId":"cloudflare-ai","model":"@cf/meta/llama-3.3-70b-instruct-fp8-fast"},{"providerId":"openrouter","model":"google/gemma-4-31b-it:free"}]'
  ```
  Checked on 2026-10-14:
  - `free-stack` is listed in `/v1/models`.
  - 4/4 runs answered by Cohere, ttft p50 618 ms.
  - With the Cohere connection set inactive (`omniroute providers edit <id> --inactive`), 2/2 runs
    were answered by Cloudflare, ttft 1.2–1.4 s.

**Checked in the consoles on 2026-10-14, with new accounts.** The catalog was wrong for two of
the five:
- **Mistral:** the API keys page says "Upgrade to use your API keys … Upgrade to activate your API
  keys". The only plans offered were Pro ($11.99/month) and pay-as-you-go: no free API plan.
- **SambaNova:** its "Free" plan says "Add a payment method and purchase credits to run your
  first requests".

Both are out until they offer a free API again. Two more findings:
- **Cohere** creates a trial key (`default`) with the account.
- **OpenRouter**, Settings → Privacy: **"Allow free endpoints that train on request data"** was
  **on** by default. With it on, a `:free` model may keep the prompts (interview transcripts) and
  train on them. It was turned **off** on 2026-10-14 (switch, then **Save changes**).
  - The eligibility preview went from 635 available / 3 unavailable to 620 / 18.
  - Of the 14 `:free` models, 4 remain: `google/gemma-4-31b-it`, `google/gemma-4-26b-a4b-it` (Google
    AI Studio), `cohere/north-mini-code` (Cohere), `dots-studio/dots-3-note-preview` (AtlasCloud).
  - None of the four trains on prompts, but all keep them: Google for 55 days, Cohere for 30 days,
    AtlasCloud for an unstated time.
  - The other 10 (Nvidia Nemotron, Poolside Laguna, Thinking Machines Inkling, Liquid LFM) train on
    prompts.
  - Source: the `data_policy` field that each model page on openrouter.ai embeds for its free
    endpoint.

`free-stack` is the **last** fallback: it only runs after Groq and Gemini failed, and the combo
tries one provider at a time. More providers do not make it faster; three independent sources make
one outage harmless. Re-check the order with the measurement of step 6.

## 5. Glass

1. **Settings → OpenAI-compatible**: Base URL `http://localhost:20128/v1`, API Key = the client
   key from step 4.5, **Save**. Save lists OmniRoute's models, which checks the URL and the key.
2. **Settings → Groq LLM Model ID**: the usual list with `free-stack` at the end, then
   **Save Groq Models**:
   ```
   openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b,gemini-3.5-flash-lite,gemini-3.1-flash-lite,free-stack
   ```
   Only the last saved list runs, so the OmniRoute entry goes in this same list. Saving a list
   in the OpenAI-compatible field would replace it.
3. Under the field, **What each model can do** must show `free-stack` as
   **OpenAI-compatible**. If it shows Gemini, OmniRoute's models list does not name the combo:
   Glass would send it to Gemini. Fix it before relying on the fallback.
   - **Override `free-stack`'s capabilities** in that panel (**Edit**): **Sees images: No**,
     **Reasoning: No**, **Max output: 8192**.
   - Why: OmniRoute reports the combo as vision, reasoning, and max output 32,768. With those
     figures, a request with no cap of its own (Ask) is sent with `max_tokens` 9,216 (8,192 plus
     1,024 for reasoning).
   - Cohere refuses that ("max tokens must be less than or equal to 8192"), so the combo skips its
     fastest model. On 2026-10-14: ttft 3.2 s through Cloudflare instead of ~0.6 s through Cohere.
   - None of the combo's first two models sees images or reasons.
   - Done on 2026-10-14 straight in the database instead of the panel:
     - table `model_catalog` in `%APPDATA%\Glass\pickleglass.db`, row
       `provider='openai-compatible' AND model_id='free-stack'`;
     - values `override_vision=0, override_reasoning=0, override_max_output=8192`.
   - **Close Glass first.** It keeps the catalog in memory and writes whole rows back on each
     refresh, so a change made while it runs is not seen and gets overwritten.
   - After the restart and a catalog refresh the three values were still there. `free-stack` with
     `max_tokens` 8192 was answered by Cohere (2/2, ttft ~0.84 s).
4. For the scripts (latency probe, live eval), the Glass `.env` (not tracked by git) holds:
   ```ini
   OMNIROUTE_API_KEY=<client key from step 4.5>
   # live eval only:
   OPENAI_COMPATIBLE_BASE_URL=http://localhost:20128/v1
   OPENAI_COMPATIBLE_API_KEY=<same client key>
   ```

## 6. Measure before relying on it

```bash
node scripts/probe-openai-compatible-ttft.js --runs 10 \
  --target groq-direct,https://api.groq.com/openai/v1,openai/gpt-oss-120b,GROQ_API_KEY \
  --target free-stack,http://localhost:20128/v1,free-stack,OMNIROUTE_API_KEY
```

It prints the time to first token (p50/p90) of each target and the difference. Record the result
in research R2 of the spec.

**Gateway overhead alone (2026-10-14).** Measured by connecting Groq in OmniRoute too, so both
targets reach the same model. Result: ttft p50 558 ms direct vs. 637 ms through OmniRoute,
**+79 ms**.
- Groq was connected by the CLI, as `groq-measure`, without showing the key:
  ```bash
  cd %USERPROFILE%\.omniroute
  GROQ_API_KEY=<from the Glass .env> omniroute providers add groq --name groq-measure --credential-env GROQ_API_KEY --yes
  omniroute providers test groq-measure
  ```
- The model ID is `groq/openai/gpt-oss-120b`.
- The same key serves both sides, so run `--runs 6 --gap-ms 20000`. Closer runs hit Groq's
  8K tokens-per-minute limit.
- `groq-measure` is not part of `free-stack`. Remove it with `omniroute providers remove groq-measure`
  when no longer needed.

**Turn off OmniRoute's waits on rate limits.** Its defaults absorb a 429 instead of returning it.
In that first, too-close run, Groq direct failed in ~100 ms while OmniRoute answered after 6–9 s.
Glass has its own failover, which needs the failure at once. In the dashboard, **Settings →
Resilience**, turn off:
- `waitForCooldown`: it retries the same connection, up to 3 times and 30 s;
- `comboCooldownWait`: it waits up to 90 s when every model of the combo cools down.

`omniroute resilience config show --output json` shows the current values. The CLI cannot change
these two.
- On 2026-10-14 the Resilience page saved `waitForCooldown` and then stopped loading
  ("Loading resilience status…").
- The second one was turned off through the dashboard's own API, from the logged-in tab's
  console: `fetch('/api/resilience',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({comboCooldownWait:{enabled:false}})})`.
- Done on 2026-10-14: both show `"enabled": false`.

## 7. Day to day

- OmniRoute must be running during an interview. If it is down, the `free-stack` entry fails in
  a few milliseconds ("Connection error.") and the earlier entries are unaffected.
- **Upgrade:** `npm install -g omniroute@<version>` from `%USERPROFILE%`. The data folder and its
  `.env` stay. Re-run the checks of step 3.
- **It starts at logon** (step 3b). Allow 1–2 minutes of warm-up after logging in. A quick
  check is `curl -s -o NUL -w "%{http_code} %{time_total}s" http://127.0.0.1:20128/api/health`,
  which should print 200 in milliseconds.
- **Start or restart by hand:** `Start-ScheduledTask -TaskName "OmniRoute (Glass local gateway)"`,
  or step 3's command from `%USERPROFILE%\.omniroute`.
- **Stop:** `omniroute stop`, or end the `node`/`omniroute` process listening on 20128.
- **Remove:** undo step 3b, run `npm uninstall -g omniroute`, then delete `%USERPROFILE%\.omniroute`
  (database, provider keys, encryption key).

## Pitfalls (seen on 2026-10-14)

- **Starting it from the Glass repo loads Glass's `.env`** (Groq key included) into OmniRoute's
  process: it reads `.env` from the current folder too. Always `cd %USERPROFILE%\.omniroute`
  first.
- **The data folder is `%USERPROFILE%\.omniroute`**, not `%APPDATA%\omniroute` as its source
  suggests for Windows. Its own startup log says which one it uses (`[DB] … file:`).
- **`omniroute@3.8.52` was not on npm** on 2026-10-14 (the repo's `CHANGELOG` says "TBD"); 3.8.51
  is the latest published version.
- **A foreground `serve` dies with its terminal or session.** Stopping it may leave the child
  `node` listening on 20128; `omniroute stop` ends it. Run it with `--daemon` (step 3), started at
  logon (step 3b).
- **A `.cmd` file written with LF line endings** ran, but its `>>` log redirect did not. Save it with
  CRLF.

# Audio Capture & Speech-to-Text (STT)

A deep reference for how Glass captures audio, attributes it to speakers, and turns it
into text. Complements the **Listen feature** section of the [README](../README.md#listen-feature).
All claims below are grounded in the current code with `file:line` references.

---

## 1. Two-channel speaker attribution ("Me" vs "Them")

Glass runs **two completely independent STT sessions** and tags every transcript by
**which audio source the bytes arrived on** — *not* by analyzing voice characteristics.
This is **source attribution, not speaker diarization**.

| Speaker tag | Fed from | STT session | Code |
|---|---|---|---|
| `"Me"` | Your **microphone** | `mySttSession` | `sttService.js:583` `sendMicAudioContent()` → `flushMyCompletion()` tags `'Me'` (`:88`) |
| `"Them"` | **System / loopback** audio | `theirSttSession` | `sttService.js:611` `sendSystemAudioContent()` → `flushTheirCompletion()` tags `'Them'` (`:115`) |

- Both sessions are created in parallel at listen start (`sttService.js:505-508`).
- The mic stream and the system stream never mix — separate `getUserMedia` /
  loopback pipelines in `listenCapture.js` feed `sendMicAudioContent` (`:331`) and
  `sendSystemAudioContent` (`:398`) respectively.
- Each finalized utterance is persisted to the `transcripts` table with its `speaker`
  tag (`listenService.js:123`).

**Practical consequence:** the clean "interviewer vs. me" split works because the other
party arrives through the **system-audio** channel (Zoom/Meet/Teams output). If two people
are physically in the room sharing your microphone, both are tagged `"Me"` — there is no
voice-based separation within a single source.

---

## 2. Per-platform audio capture

STT itself is platform-independent. What differs per OS is **how system ("Them") audio is
captured**. Entry point: `listenCapture.js:417` `startCapture()`, which branches on platform.

| Platform | Mic ("Me") | System audio ("Them") | Echo cancellation |
|---|---|---|---|
| **Windows** | `getUserMedia` | **Electron native loopback** — `getDisplayMedia({video:true, audio:true})` resolved to `audio: 'loopback'` by the handler in `index.js:175-182`. No external binary. (`listenCapture.js:515-566`) | ✅ WASM/Rust AEC |
| **macOS** | `getUserMedia` | Bundled **`SystemAudioDump`** native binary, spawned and streamed as PCM (`sttService.js:666-757`, `startMacOSAudioCapture`). Gated to `darwin` only (`:667`). (`listenCapture.js:424-473`) | ✅ WASM/Rust AEC |
| **Linux** | `getUserMedia` | ❌ **Disabled** — `getDisplayMedia({audio:false})`. Mic only; no "Them" channel. (`listenCapture.js:474-514`) | ❌ |

> **Note:** This corrects an earlier README claim that system audio was "macOS only" and
> that "on Windows/Linux only the user's mic is captured." Windows **does** capture system
> audio via native loopback. Only **Linux** is mic-only.

### Acoustic Echo Cancellation (AEC)

On **macOS and Windows** the mic path runs through a Rust/WASM AEC module
(`listenCapture.js:134` `runAecSync`, loaded via `aec.js`). It uses the **system-audio
stream as the echo reference** to subtract the other party's voice — which leaks from your
speakers back into your mic — *before* that audio reaches the `"Me"` session. This keeps the
interviewer's voice from being double-transcribed onto both channels.

- AEC-enabled mic path: `setupMicProcessing()` (`listenCapture.js:292`), used by macOS (`:465`) and Windows (`:538`).
- Linux uses `setupLinuxMicProcessing()` (`listenCapture.js:345`) — **no** AEC.

Audio format across all platforms: **PCM16, mono, 24 kHz**, chunked at 100 ms.

---

## 3. STT / LLM provider matrix

Providers are declared in a single registry: `factory.js:23-111` (`PROVIDERS`). The model
selection layer (`modelStateService.js`) and the Settings UI are entirely **data-driven**
from this registry — adding a model to a provider's `sttModels`/`llmModels` array is enough
to surface it in the UI.

| Provider | STT | LLM | Notes |
|---|---|---|---|
| **OpenAI** | ✅ `gpt-4o-mini-transcribe` | ✅ `gpt-4.1` | Realtime STT; gets a 60 s keep-alive heartbeat (`sttService.js:537-548`) |
| **OpenAI (Glass)** | ✅ | ✅ | Pickle-hosted key via Portkey; same OpenAI handler |
| **Gemini** | ✅ `gemini-3.8-live` | ✅ `gemini-3-flash-preview` | LLM supports CSV failover; STT does **not** (see §5) |
| **Anthropic** | ❌ | ✅ `claude-opus-5-5` · `claude-sonnet-5-5` · `claude-haiku-5-5` | LLM only — `sttModels: []`; LLM supports CSV failover |
| **Groq** | ❌ | ✅ `openai/gpt-oss-120b` · `openai/gpt-oss-20b` · `qwen/qwen3.8-27b` | LLM only — `sttModels: []` (Groq's Whisper is batch-only); LLM supports CSV failover |
| **Deepgram** | ✅ `nova-3` | ❌ | STT only (see §4) |
| **Whisper (local)** | ✅ tiny/base/small/medium | ❌ | Runs in main process only |
| **Ollama (local)** | ❌ | ✅ (dynamic) | LLM only |

**How selection resolves at runtime:** `modelStateService.getCurrentModelInfo('stt')`
(`modelStateService.js:498`) returns `{ provider, model, apiKey }` for the active STT
provider, which `sttService` hands to `createSTT(provider, opts)` (`factory.js:189`).
A model ID is mapped back to its provider by `getProviderForModel()` (`modelStateService.js:390`).

`areProvidersConfigured()` requires **both** a working LLM key and a working STT key
(`modelStateService.js:580-598`) — so an STT-only provider like Deepgram cannot satisfy the
app on its own.

---

## 4. Using Deepgram for STT

Deepgram is a fully-wired, selectable STT provider — no code change required.

**Enable it:**
1. Open **Settings**. The API-key section renders one input per registered provider
   (`SettingsView.js:1375` loops `Object.entries(this.providerConfig)`), so a
   **"Deepgram API Key"** field appears automatically.
2. Paste your key and **Save**. This calls `setApiKey('deepgram', key)`, which validates
   against `https://api.deepgram.com/v1/projects` (`deepgram.js:15-37`) before storing.
3. **Change STT Model** → pick **"Nova-3 (General)"** (appears in `getAvailableModels('stt')`
   once the key is saved — `SettingsView.js:1559`).

**How it streams:** `createSTT` (`deepgram.js:39-101`) opens a WebSocket to
`wss://api.deepgram.com/v1/listen` configured `encoding=linear16, sample_rate=24000,
channels=1, smart_format=true, interim_results=true` — matching the capture pipeline's
PCM16/mono/24 kHz output. Two sockets are opened (Me + Them). Messages are parsed in
`sttService.js:276` / `:418` (`message.channel.alternatives[0].transcript`, `is_final`).

**Language.** Deepgram listens for one language, sent as `language=` in the WebSocket URL
(`buildListenQuery` in `deepgram.js`). The language comes from the **Transcription language**
setting (`sttLanguage`: `pt-BR` default, or `en-US`), read by
`sttService._resolveSttLanguage` at every session start and renewal and translated per provider
by `toProviderLanguage` (`sttLanguage.js`): Deepgram and Gemini get the full tag, OpenAI gets
`pt` / `en`. Nova-3 supports `pt-BR`. `language=multi` (code-switching) and `detect_language`
are not used. Per-side (Me / Them) language is not implemented.

**Keyterms.** Each session also sends `keyterm=` parameters, words nova-3 should favor
(`sttKeyterms.js`, built by `sttService._keyterms` at every session start and renewal). It works
in `pt-BR` as well as `en-US`: in the live eval, "O que é LINQ?" was heard as "O que é link?"
without them and right with them. The list has two parts:
- the career notes' company names and manifest entities, first (at most 50; the interviewer's
  company is the name the STT most often misspells). There are none until the notes have loaded;
- a fixed list of technical names an STT hears as plain words (`LINQ`, `gRPC`, `Kafka`,
  `goroutine`, `API token`, `rate limiter`, `CLAUDE.md`, …). "AI" is in it only inside phrases
  (`AI agent`, `AI tools`, `AI setup`): alone, two letters could pull "I" or "a" into it.

The cap is the 50 names plus the whole fixed list, so the fixed list always fits. Deepgram refuses
a request whose keyterms pass 500 tokens in all; `sttKeyterms.test.js` keeps the fixed list and 50
names of 20 characters under it by a conservative estimate. The log line shows only how many terms
were sent, since some come from the notes. Other STT providers ignore the list.

**Caveats:**
- **STT-only.** `createLLM`/`createStreamingLLM` are stubs that throw (`deepgram.js:104-111`).
  You still need a separate LLM provider (OpenAI / Gemini / Anthropic / Groq / Ollama) for Ask and
  summaries.
- **Model pinned to `nova-3`.** `createSTT` does not read the `model` option — it hardcodes
  `model: 'nova-3'` in the query string (`deepgram.js:46-48`). Adding other Deepgram models
  to the registry will not take effect without editing the provider.
- **No app-level keep-alive.** `_sendKeepAlive` only fires for OpenAI (`sttService.js:537-548`).
  In practice fine during active listening (audio flows every 100 ms), but a dropped socket
  mid-session is only logged, not recovered (see §5).

---

## 5. STT resilience vs. failover

**There is no model/provider failover for STT — by explicit design.**

The Gemini CSV failover feature (`callWithFailover`, the model rotator, the
`_reset`/`_final_model` SSE sentinels) is wired **only** into `createLLM` /
`createStreamingLLM` — the Ask/answer path. So is the chain across providers (a model list
that ends in another provider's models, `ARCHITECTURE.md` §10.4). STT never touches either.
`createSTT` deliberately takes only the **first** model in the list (`gemini.js:135-137`):

```js
// STT does NOT failover — use only the first model in the CSV list (locked decision #3).
const firstModel = rotator.parseModelList(model)[0] || 'gemini-3.8-live';
```

Rationale (locked in `specs/2026-05-26-gemini-failover-design/spec.md`):
> STT strategy → **Single model, no failover** — STT is a persistent live session; rotation
> has no clean semantics. (And §8 out-of-scope: STT failover "would require a separate design
> for session-reconnect semantics.")

There is **no cross-provider** STT fallback either (e.g. Gemini STT 429 → switch to Deepgram
or Whisper). The provider is whatever is selected in Settings, and it stays there.

### What *does* exist (resilience — keeps a single session healthy)

| Mechanism | Where | Behavior |
|---|---|---|
| **Init retry** | `listenService.js:189-209` | Retries `initializeSttSessions` up to **10×** at 300 ms intervals on session start. Same model each time. |
| **Proactive session renewal** | `sttService.js:518-527`, `renewSessions` `:554-581` | Every **20 min** (`SESSION_RENEW_INTERVAL_MS`) tears down and recreates both sessions to dodge provider hard-timeouts, with a **2 s overlap** (`SOCKET_OVERLAP_MS`) so no audio is dropped. |
| **Keep-alive heartbeat** | `sttService.js:513-516`, `:537-548` | Every **60 s** (`KEEP_ALIVE_INTERVAL_MS`); OpenAI only (Gemini SDK self-heartbeats). |

### The gap

A live STT socket that **drops or errors mid-session** is **not** automatically recovered —
the `onerror`/`onclose` callbacks only log (`sttService.js:478-479`, `:487-488`). No
reconnect, no model switch, no provider fallback. The 20-min renewal is on a fixed timer; it
does not react to a failure. Recovery requires a manual Stop → Listen.

Building real STT failover/reconnect-on-drop would mean wrapping those callbacks to re-run
`createSTT` (with the next model, or a cross-provider chain) and re-attach the audio pipeline.

---

## 6. From transcript to insights & answers (the next hop)

STT's job ends at a **finalized, speaker-tagged transcript turn**. That turn is then forwarded
to two consumers at once by `listenService.handleTranscriptionComplete` (`listenService.js:105-112`):

1. **Persistence** → `sttRepository.addTranscript()` writes it to the `transcripts` table
   (`listenService.js:123`).
2. **Live Insights** → `summaryService.addConversationTurn()` feeds the rolling-summary engine
   (`listenService.js:111`), which produces the **"Live insights"** panel.

The insights panel starts every session showing **"No insights yet…"** and only fills after the
**5th** finalized turn (then refreshes every 5 turns). And critically, the **Ask** feature does
**not** receive this transcript — pressing Ask sends only your typed text + a fresh screenshot.
Settings → **Live panels** can turn Live Insights or Live Answer off; the transcript is captured
and saved the same way in every mode.

The full story of how a live conversation becomes insights and answers — including the
"interviewer asks a question, how do I get an answer?" walkthrough — is documented separately:

> **→ [`LIVE_INSIGHTS_AND_ASK.md`](LIVE_INSIGHTS_AND_ASK.md)**

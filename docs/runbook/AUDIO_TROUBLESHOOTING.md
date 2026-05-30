# Runbook — Audio / STT / "Speaker Split" Troubleshooting

Operator-facing triage for the most common Listen-feature failures. Symptoms map to the
mechanics in [`../AUDIO_AND_STT.md`](../AUDIO_AND_STT.md) and
[`../../ARCHITECTURE.md` §7](../../ARCHITECTURE.md#7-the-listen-audio--stt-feature). Work
top-down — the cheapest checks are first.

---

## Quick mental model (read this first)

- **`"Me"` = your microphone. `"Them"` = system/loopback audio.** The split is by **audio
  source**, never by voice. Two people on one mic are both `"Me"`. (`sttService.js:82`,`:109`)
- **Nothing transcribes without BOTH an LLM key and an STT key.** (`areProvidersConfigured`,
  `modelStateService.js:437-455`)
- **Linux never has `"Them"`** — system-audio loopback is disabled. (`listenCapture.js:488`)
- **Screenshots are unrelated to Listen** — they only happen on an Ask press.

---

## 1. "Nothing transcribes at all"

| Check | How | Fix |
|---|---|---|
| Providers configured? | Settings shows a selected STT **and** LLM model | Add an STT key (OpenAI/Gemini/Deepgram/Whisper) **and** an LLM key (or sign in / install Ollama). STT-only or LLM-only is not enough. |
| Mic permission | OS mic permission for Glass | Grant it; on macOS use the in-app permission flow. |
| STT session actually started? | Logs: `✅ Both STT sessions initialized successfully.` (`sttService.js:474`) | If you see 10 failed init attempts (`listenService.js:179-192`), the STT key/model is bad or the provider is unreachable. |
| Right model selected | Settings → STT model | A model whose provider has no key won't be auto-selected (`_autoSelectAvailableModels`). |

---

## 2. "I get `Me` but never `Them`" (no other-party transcript)

| Platform | Likely cause | Fix |
|---|---|---|
| **Linux** | Expected — loopback disabled by design (`listenCapture.js:488`). | Not fixable without code changes; Linux is mic-only. |
| **macOS** | Screen-recording permission missing, or `SystemAudioDump` didn't spawn. | Grant **Screen Recording** in System Settings. Check logs for `SystemAudioDump started with PID` vs `Failed to start SystemAudioDump` (`sttService.js:648-653`). |
| **macOS** | Stale `SystemAudioDump` from a prior crash. | The app `pkill`s existing copies on start (`sttService.js:601-628`); if stuck, Stop → Listen again. |
| **Windows** | Loopback stream had no audio track. | Logs: `No audio track in native loopback stream` (`listenCapture.js:554`). Ensure something is actually playing audio on the system output; re-Stop/Listen. |

---

## 3. "Both channels transcribe my own voice" (echo / double transcription)

This is the AEC (acoustic echo cancellation) path failing to subtract speaker bleed.

- AEC runs only on **macOS + Windows** via the Rust/WASM module (`runAecSync`,
  `listenCapture.js:134`). If the WASM module isn't loaded it **passes mic audio through
  unchanged** (`listenCapture.js:135`) — you lose echo cancellation but not transcription.
- Logs: `No system audio for AEC reference` (`listenCapture.js:325`) means there was no
  loopback reference to subtract — usually the same root cause as §2 (no `"Them"` stream).
- Mitigation: use headphones so the other party's voice never reaches your mic in the first
  place. AEC is a backstop, not a guarantee.
- Building AEC from source: the Rust source is the `aec` git submodule
  (`git submodule update --init`); the runtime glue is `src/ui/listen/audioCore/aec.js`.

---

## 4. "Transcript drops out after ~20–30 minutes"

- Glass proactively **renews** both STT sessions every **20 min** with a 2 s overlap to dodge
  provider hard timeouts (`sttService.js:482-491`, `renewSessions` `:518-545`). If a session
  still drops, note that **there is no auto-reconnect** — `onerror`/`onclose` only log
  (`sttService.js:443-444`,`:452-453`).
- **Fix:** Stop → Listen to start a fresh pair of sessions. Transcripts/summaries written so far
  are already persisted.
- OpenAI sessions also get a 60 s keep-alive (`sttService.js:478`,`:501-512`); Gemini self-beats.

---

## 5. "Latency / cost is high" or "I want offline"

- Switch STT to **Whisper (local)** and LLM to **Ollama (local)** in Settings — fully offline,
  no per-token cost. Whisper runs in the **main process only** (`factory.js:74-95`); first use
  downloads the model (SHA-256 verified, `checksums.js`).
- Whisper noise tokens (`[BLANK_AUDIO]`, `[INAUDIBLE]`, …) are filtered out
  (`sttService.js:175-205`), so brief silences won't pollute the transcript.

---

## 6. Diagnostic log landmarks

| Log line | Meaning | Source |
|---|---|---|
| `✅ Both STT sessions initialized successfully.` | STT up | `sttService.js:474` |
| `[ListenService] STT init attempt N failed` | retrying init (max 10) | `listenService.js:185` |
| `SystemAudioDump started with PID:` | macOS system audio up | `sttService.js:653` |
| `Windows native loopback audio capture started` | Windows `"Them"` up | `listenCapture.js:558` |
| `🔊 No system audio for AEC reference` | no echo reference (no `"Them"`) | `listenCapture.js:325` |
| `[SttService] Auto-renewing STT sessions…` | 20-min renewal firing | `sttService.js:486` |
| `My/Their STT session closed:` | a live socket dropped | `sttService.js:444`,`:453` |

---

*If a symptom isn't covered here, it's probably a provider-side or OS-permission issue rather
than a Glass bug — confirm the provider key works and the OS permission is granted before
filing.*

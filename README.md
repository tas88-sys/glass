<p align="center">
  <a href="https://pickle.com/glass">
   <img src="./public/assets/banner.gif" alt="Logo">
  </a>

  <h1 align="center">Glass by Pickle: Digital Mind Extension 🧠</h1>

</p>


<p align="center">
  <a href="https://discord.gg/UCZH5B5Hpd"><img src="./public/assets/button_dc.png" width="80" alt="Pickle Discord"></a>&ensp;<a href="https://pickle.com"><img src="./public/assets/button_we.png" width="105" alt="Pickle Website"></a>&ensp;<a href="https://x.com/intent/user?screen_name=leinadpark"><img src="./public/assets/button_xe.png" width="109" alt="Follow Daniel"></a>
</p>

> This project is a fork of [CheatingDaddy](https://github.com/sohzm/cheating-daddy) with modifications and enhancements. Thanks to [Soham](https://x.com/soham_btw) and all the open-source contributors who made this possible!

🤖 **Fast, light & open-source**—Glass lives on your desktop, sees what you see, listens in real time, understands your context, and turns every moment into structured knowledge.

💬 **Proactive in meetings**—it surfaces action items, summaries, and answers the instant you need them.

🫥️ **Truly invisible**—never shows up in screen recordings, screenshots, or your dock; no always-on capture or hidden sharing.

To have fun building with us, join our [Discord](https://discord.gg/UCZH5B5Hpd)!

## Instant Launch

⚡️  Skip the setup—launch instantly with our ready-to-run macOS app.  [[Download Here]](https://www.dropbox.com/scl/fi/znid09apxiwtwvxer6oc9/Glass_latest.dmg?rlkey=gwvvyb3bizkl25frhs4k1zwds&st=37q31b4w&dl=1)

## Quick Start (Local Build)

### Prerequisites

First download & install [Python](https://www.python.org/downloads/) and [Node](https://nodejs.org/en/download).
If you are using Windows, you need to also install [Build Tools for Visual Studio](https://visualstudio.microsoft.com/downloads/)

Ensure you're using Node.js version 20.x.x to avoid build errors with native dependencies.

```bash
# Check your Node.js version
node --version

# If you need to install Node.js 20.x.x, we recommend using nvm:
# curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
# nvm install 20
# nvm use 20
```

### Installation

```bash
npm run setup
```

## Highlights


### Ask: get answers based on all your previous screen actions & audio

<img width="100%" alt="booking-screen" src="./public/assets/00.gif">

### Meetings: real-time meeting notes, live summaries, session records

<img width="100%" alt="booking-screen" src="./public/assets/01.gif">

### Use your own API key, or sign up to use ours (free)

<img width="100%" alt="booking-screen" src="./public/assets/02.gif">

**Currently Supporting:**
- OpenAI API: Get OpenAI API Key [here](https://platform.openai.com/api-keys)
- Gemini API: Get Gemini API Key [here](https://aistudio.google.com/apikey)
- Local LLM Ollama & Whisper

### Liquid Glass Design (coming soon)

<img width="100%" alt="booking-screen" src="./public/assets/03.gif">

<p>
  for a more detailed guide, please refer to this <a href="https://www.youtube.com/watch?v=qHg3_4bU1Dw">video.</a>
  <i style="color:gray; font-weight:300;">
    we don't waste money on fancy vids; we just code.
  </i>
</p>


## Keyboard Shortcuts

`Ctrl/Cmd + \` : show and hide main window

`Ctrl/Cmd + Enter` : ask AI using all your previous screen and audio

`Ctrl/Cmd + Arrows` : move main window position

## How It Works

A technical walkthrough of what actually happens when you use Glass. Useful for contributors and anyone trying to understand the runtime behavior.

### Architecture at a glance

Glass is an Electron desktop app with two core features:

- **Ask** — query an LLM about your current screen with a hotkey
- **Listen** — real-time audio capture, transcription, and incremental summarization

Data is persisted to **SQLite** locally, or **Firebase** when signed in (the repository pattern auto-switches based on auth state).

### Ask feature

**Trigger:** `Ctrl/Cmd + Enter` invokes `askService.sendMessage()` (`src/features/ask/askService.js:218`).

**Per-query flow:**

1. **Screenshot capture** (`askService.js:38-120`):
   - macOS → native `screencapture -x -t jpg`, then resized via `sharp` to max **384px height** at JPEG quality 80
   - Windows/Linux → Electron `desktopCapturer.getSources()` at 1920×1080, JPEG quality 70
   - Image is base64-encoded and attached inline to the LLM message
2. **Message build** (`askService.js:259-274`) — system prompt + user text + the single screenshot (multimodal `image_url` part)
3. **Streaming call** through `createStreamingLLM(provider)` — supports Anthropic Claude, OpenAI, Gemini, Ollama, Whisper
4. **Stream parsing** (`_processStream`, `askService.js:369-425`) — SSE chunks broadcast to the Ask window in real time
5. **Persistence** — user prompt and assistant response written to the `ai_messages` table tied to a session id from `sessionRepository.getOrCreateActive('ask')`
6. **Multimodal fallback** (`askService.js:303-338`) — if the provider rejects the image, the request is retried text-only

**Important runtime behavior:**

- One Ask press = **exactly one screenshot** of the current screen. No image queue, no multi-image messages.
- `sendMessage(userPrompt, conversationHistoryRaw=[])` accepts a history parameter, but the IPC handlers (`src/bridge/featureBridge.js:82-83`) **never pass it**. Each Ask query is therefore independent from the LLM's perspective — the model does **not** remember prior questions, answers, or screenshots.
- The DB still stores every Q&A. That history powers the UI's transcript view, not the next prompt.
- `sessionRepository.getOrCreateActive` (`src/features/common/repositories/session/sqlite.repository.js:77`) reuses any session where `ended_at IS NULL`. Closing and reopening the app resumes the same session id, but again, the LLM context does not carry over.

### Listen feature

**Audio sources:**

| Stream | Speaker tag | Source | Platforms |
|---|---|---|---|
| Microphone | `"Me"` | Browser `getUserMedia()` | All |
| System audio | `"Them"` | Native `SystemAudioDump` binary | **macOS only** |

On Windows/Linux only the user's mic is captured.

**Real-time STT pipeline** (`src/features/listen/stt/sttService.js`):

- Two parallel STT sessions per provider (OpenAI Realtime, Gemini Live, Deepgram, or local Whisper)
- Interim/partial results stream to the UI; final results flush through a 2-second debounce
- Keep-alive heartbeat every 60s for OpenAI; session renewal every 20 minutes with a 2-second overlap to dodge provider hard timeouts
- Each finalized utterance is inserted into the `transcripts` table tagged with `session_id`, `speaker`, `text`, `start_at`

**Incremental summarization** (`src/features/listen/summary/summaryService.js`):

- `triggerAnalysisIfNeeded()` fires every time `conversationHistory.length % 5 === 0`
- Prompt includes the **last 30 conversation turns** plus the **previous summary** as context — summaries build forward rather than restarting
- Output is parsed into TLDR, bullet points, action items, and suggested follow-up questions
- Persisted with UPSERT to the `summaries` table (one row per session)

**Session lifecycle:**

- **Stop** → STT sessions closed, `SystemAudioDump` process killed, `sessions.ended_at` timestamped, in-memory state cleared
- **App quit mid-session** → `app.on('before-quit')` (`src/index.js:244-309`) calls `listenService.closeSession()` then `sessionRepository.endAllActiveSessions(uid)` as a safety net. Transcripts and summaries written incrementally during the session are already on disk.

### Storage schema (relevant tables)

```
sessions        (id, uid, session_type, started_at, ended_at, ...)
ai_messages     (session_id, role, content, ...)        -- Ask Q&A
transcripts     (session_id, speaker, text, start_at, ...) -- Listen STT output
summaries       (session_id PRIMARY KEY, text, tldr, bullet_json, action_json, ...)
```

### Known limitation: Listen → Ask context is not wired

`listenService.getConversationHistory()` exists (`src/features/listen/listenService.js:266`) and returns the in-memory transcript buffer, but no code path passes it into `askService.sendMessage`. The result: even with Listen actively transcribing a meeting, pressing `Ctrl/Cmd + Enter` sends only your text + current screenshot to the LLM — the transcript is not included as context.

Wiring this up is a small change in `featureBridge.js` for anyone wanting to contribute.

## Repo Activity

![Alt](https://repobeats.axiom.co/api/embed/a23e342faafa84fa8797fa57762885d82fac1180.svg "Repobeats analytics image")

## Contributing

We love contributions! Feel free to open issues for bugs or feature requests. For detailed guide, please see our [contributing guide](/CONTRIBUTING.md).
> Currently, we're working on a full code refactor and modularization. Once that's completed, we'll jump into addressing the major issues.

### Contributors

<a href="https://github.com/pickle-com/glass/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=pickle-com/glass" />
</a>

### Help Wanted Issues

We have a list of [help wanted](https://github.com/pickle-com/glass/issues?q=is%3Aissue%20state%3Aopen%20label%3A%22%F0%9F%99%8B%E2%80%8D%E2%99%82%EF%B8%8Fhelp%20wanted%22) that contain small features and bugs which have a relatively limited scope. This is a great place to get started, gain experience, and get familiar with our contribution process.


### 🛠 Current Issues & Improvements

| Status | Issue                          | Description                                       |
|--------|--------------------------------|---------------------------------------------------|
| 🚧 WIP      | Liquid Glass                    | Liquid Glass UI for MacOS 26 |

### Changelog

- Jul 5: Now support Gemini, Intel Mac supported
- Jul 6: Full code refactoring has done.
- Jul 7: Now support Claude, LLM/STT model selection
- Jul 8: Now support Windows(beta), Improved AEC by Rust(to seperate mic/system audio), shortcut editing(beta)
- Jul 8: Now support Local LLM & STT, Firebase Data Storage 


## About Pickle

**Our mission is to build a living digital clone for everyone.** Glass is part of Step 1—a trusted pipeline that transforms your daily data into a scalable clone. Visit [pickle.com](https://pickle.com) to learn more.

## Star History
[![Star History Chart](https://api.star-history.com/svg?repos=pickle-com/glass&type=Date)](https://www.star-history.com/#pickle-com/glass&Date)

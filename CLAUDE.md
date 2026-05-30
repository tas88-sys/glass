# glass Development Guidelines

Auto-generated from all feature plans. Last updated: 2026-05-30

## Active Technologies
- (2026-05-30-improve-STT-sessions)
- JavaScript, Node.js 18+ (Electron main + renderer; CommonJS) + Electron, `ws`, `@deepgram/sdk` (Deepgram Nova-3 realtime STT), WASM/Rust AEC (`aec.js` + submodule); alt STT providers OpenAI/Gemini/Whisper via `factory.js` (2026-05-30-improve-STT-sessions)
- SQLite (`better-sqlite3`) for transcripts — **untouched by this feature** (no schema change) (2026-05-30-improve-STT-sessions)

## Project Structure
```
backend/
frontend/
tests/
```

## Commands
# Add commands for 

## Code Style
: Follow standard conventions

## Recent Changes
- 2026-05-30-improve-STT-sessions: Added JavaScript, Node.js 18+ (Electron main + renderer; CommonJS) + Electron, `ws`, `@deepgram/sdk` (Deepgram Nova-3 realtime STT), WASM/Rust AEC (`aec.js` + submodule); alt STT providers OpenAI/Gemini/Whisper via `factory.js`
- 2026-05-30-improve-STT-sessions: Added

<!-- MANUAL ADDITIONS START -->
<!-- MANUAL ADDITIONS END -->

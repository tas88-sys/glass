# glass Development Guidelines

Auto-generated from all feature plans. Last updated: 2026-06-01

## Active Technologies
- (2026-06-01-interview-live-answer-readability)

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
- 2026-06-01-interview-live-answer-readability: Added

<!-- MANUAL ADDITIONS START -->
## Machine setup outside this repo

Things the app relies on that do not install with `npm run setup`. On a new machine, follow
each runbook; when a setup changes, update its runbook in the same change.

- **OmniRoute** (local gateway for the free-model fallback, the `free-stack` entry at the end of
  the Groq model list): [`docs/runbook/OMNIROUTE_SETUP.md`](docs/runbook/OMNIROUTE_SETUP.md).
  - It must run local-only. Its `%USERPROFILE%\.omniroute\.env` sets `127.0.0.1` and
    `REQUIRE_API_KEY=true`.
  - Start it from that folder, never from this repo: it would load this repo's `.env`.
  - It runs as a daemon, started at logon by the scheduled task "OmniRoute (Glass local
    gateway)" (runbook step 3b). A `serve` started in a Claude session dies with that session.
<!-- MANUAL ADDITIONS END -->
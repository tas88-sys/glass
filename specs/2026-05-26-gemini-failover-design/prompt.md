We need to create somekind of retry mechanism for gemini. 

often times, gemini api returns errors. THis is normally due to server degradation or real rate limit issues (429, 503, etc..)

Limits vary depending on the specific model being used,

My plan is to rotate the models at every request, following a order of priority. It means Gemini LLM Model ID and Gemini STT Model ID free-text inputs in settings should receive N models separated by comma.

For instance. Gemini LLM Model ID is set to: gemini-3.5-flash,gemini-3-flash-preview,gemini-3.1-flash-lite,gemini-2.5-flash,gemini-2.5-flash-lite

If a request fails, the next model in the queue should be tried and so on, until the last model is tried and the model is reset to the first one. 

This order should be followed for every request.

THe model in use should be displayed somewhere in the app.

Help me decide if this is the best approach or if I am missing something and this feature could be implemented with something else aswell.

### TLDR:
## DEFAULT (CODING CHALLENGES, DESING SYSTEM, ETC): gemini-3.5-flash,gemini-3-flash-preview,gemini-3.1-flash-lite,gemini-2.5-flash,gemini-2.5-flash-lite
## SPEED (ORAL TECH INTERVIEWS): gemini-3.1-flash-lite,gemini-3.5-flash,gemini-3-flash-preview,gemini-2.5-flash,gemini-2.5-flash-lite

### TLDR (updated 2026-10-05):
## DEFAULT (CODING CHALLENGES, DESING SYSTEM, ETC): gemini-3.8-flash,gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash,gemini-3.5-flash-lite
## SPEED (ORAL TECH INTERVIEWS): gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-3.8-flash,gemini-3.6-flash,gemini-3.5-flash

### TLDR (recommended 2026-10-05, free tier, based on the AI Studio usage dashboard):
## DEFAULT (CODING CHALLENGES, DESING SYSTEM, ETC): gemini-3-flash-preview,gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-3.8-flash
## SPEED (ORAL TECH INTERVIEWS): gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-3-flash-preview

Why:
- Last 7 days (free tier): gemini-3.5-flash, 3.6-flash, 3.7-flash and 3.8-flash got requests but never produced output (all 503 ServiceUnavailable, never 429). Only gemini-3-flash-preview, 3.1-flash-lite and 3.5-flash-lite answered. Small sample (1-2 tries per model per day).
- Every failed attempt adds a full round trip before the next model, and the 60 s cooldown means the same failures repeat every minute. Models that answer go first.
- DEFAULT: gemini-3-flash-preview is the strongest model that actually answers (thinking on by default, slower but fine for coding/system design). The Lites back it up. gemini-3.8-flash stays only as a last resort, in case capacity comes back.
- SPEED: Flash-Lite first. Default thinking is minimal (lowest latency), and the free-tier limits are 15 RPM / 500 RPD vs 5 RPM / 20 RPD on Flash, which matters because Live Answer fires on every question. No failing Flash models in this list: a 503 mid-interview costs more than a slightly weaker answer.
- Risk: gemini-3-flash-preview is a preview (Google suggests migrating to gemini-3.6-flash), and gemini-3.1-flash-lite shuts down 2027-05-07.
- Revisit with the per-attempt logs (`[Gemini Provider] attempt ...` lines in the `npm start` terminal). If billing is enabled and gemini-3.8-flash stops returning 503, move it to the front of DEFAULT.
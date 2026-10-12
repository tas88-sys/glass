# Edge Cases: Groq Output Limit and Screenshots

**Spec**: `2026-10-12-groq-otpm-images`

| # | Situation | Expected behavior | Covered by |
|---|-----------|-------------------|-----------|
| E1 | 429 "Request too large … (OTPM): Limit 1000, Requested 1679" | `too-large`; `tooLargeNumbers` → `{ limit: 1000, requested: 1679, output: true }` | FR-001, FR-002 (`groqErrors.test.js`) |
| E2 | 413 "Request too large … (TPM): Limit 8000, Requested 9400" | `too-large`; `output: false`; the TPM message as before | FR-001, FR-002, FR-004 |
| E3 | 429 "Rate limit reached … Limit 8000, Used 5454, Requested 4212" | `transient` with the server's cooldown; `tooLargeNumbers` → `null` ("Used" sits between) | FR-001, FR-002 |
| E4 | 429 with code `rate_limit_exceeded` and no message | `transient` | FR-001 |
| E5 | OTPM refusal on Qwen, gpt-oss next, no `visionOnly` | `_reset reason: 'too-large'` to gpt-oss, which answers without the image; Qwen not cooled down; log `limit=1000 requested=1679` | FR-001, FR-005, D5 (`groq.test.js`) |
| E6 | OTPM refusal on the only model | No second round; `userMessage` "qwen/qwen3.8-27b — asks for up to 1679 output tokens; this key allows 1000 per minute." | FR-004 |
| E7 | `visionOnly`, an image, list `gpt-oss-120b, gpt-oss-20b, qwen` | Only Qwen is tried; it answers with the image | FR-007 |
| E8 | `visionOnly`, an image, Qwen refused (OTPM) | One attempt; no `_reset`, no text; the request fails with Qwen's message; gpt-oss never called | FR-007 |
| E9 | `visionOnly`, an image, no vision model in the list | `NO_VISION_MODEL` before any request; one log line `request stream answered_by=none attempts=0 no model sees images: …` | FR-007 |
| E10 | `visionOnly` and no image | The list order and behavior of today | FR-007 |
| E11 | `visionOnly` on `chat()` / `generateContent()` | Same rules as the stream (one `runWithFailover`) | FR-006, FR-007 |
| E12 | Chain: image, Groq (with Qwen) then Gemini with a key | Groq segment gets `visionOnly: true`; Gemini's options have no `visionOnly` | FR-008 (`providerChain.test.js`) |
| E13 | Chain: no image | No `visionOnly` on any segment | FR-008 |
| E14 | Chain: image, the later segment does not see images | No `visionOnly` | FR-008 |
| E15 | Chain: image, the later segment that sees images has no key | No `visionOnly` (the image would be dropped for nothing); the later segment is skipped `no-key` | FR-008 |
| E16 | Chain, non-stream path (`generateContent` with `inlineData`) | `visionOnly` as on the stream path | FR-008 |
| E17 | Chain over the real providers, the user's list, an Ask-shaped request with no cap, Qwen refused on OTPM | `max_completion_tokens` 16,384 on Qwen; gpt-oss never called; the chain's `_reset reason: 'provider'` to `gemini-3.5-flash-lite`; Gemini gets the image; Qwen not cooling | SC-001 (`providerChain.integration.test.js`) |
| E18 | Chain: Groq segment without a vision model, then Gemini, image | Gemini runs first (images-first order, unchanged); `visionOnly` never set on Groq | FR-009, data-model |
| E19 | Chain: Gemini, then Groq with Qwen, image | Stable order: Gemini first. If it fails, Groq runs with no later segment, so no `visionOnly` and today's fallback | FR-008, FR-009 |
| E20 | Ask on gpt-oss, no cap | `max_completion_tokens` 17,408 (16,384 + 1,024 reasoning) | FR-003 (`groqRequest.test.js`) |
| E21 | Ask on Qwen, no cap | 16,384 (Qwen's maximum, no reasoning at `none`) | FR-003 |
| E22 | `GROQ_MAX_TOKENS=4000` | 4,000 (+ allowance on gpt-oss); the caller's cap still wins over it | FR-003 |
| E23 | Live Answer (900) on Qwen | 900: under the 1K output limit; accepted as before | G4 |
| E24 | Live Insights (1,024) on Qwen | Refused on OTPM, now `too-large` with no cooldown; the next model answers | FR-001, G4 |
| E25 | The key's output limit is raised (paid tier) | Qwen accepts 16,384 again; nothing to change (no stored state) | D7 |
| E26 | A refused request's `error=` in the log | Still cut at 160 characters; the numbers appear in `limit=` / `requested=` | FR-005 |
| E27 | `visionOnly` reaching the SDK | Never: it is read in `runWithFailover` only; `buildRequest` does not see it | FR-006 |

# Research: career router with Jev

Follows research R1–R17 of `specs/2026-10-11-live-answer-career-context/research.md`.

## R18: Jev in place of the regex router

**Decision**: Jev routes turns. The regex router is frozen and decides only when Jev cannot.

### Facts checked (2026-10-13, primary sources)

| Claim (from a search-engine AI summary) | Status |
|---|---|
| $0.042 per 1M input tokens, output free | ✅ docs.typesafe.ai/models: "Charged per input token. Output tokens are free." There is no pricing page (`typesafe.ai/pricing` is a 404). |
| 300 tokens ≈ $0.0000126; $1 ≈ 80,000 calls | ✅ The arithmetic is right. |
| "76x to 445x cheaper than LLMs" | ⚠️ From TypeSafe's own eval (per case $0.0004 against $0.0304 and $0.1761). Not independent. |
| The example request and response JSON | ❌ Wrong shape. The API (docs.typesafe.ai/api) uses `type: "choice" \| "score" \| "noul"`, `instructions`, and `criteria` as a map of option → description. Answers come back as `answers.<id>.choice / .probabilities / .confidence` (a `noul` as `answers.<id>.noul`). `usage` has `input_tokens` and `output_tokens` only. |
| "Guarantees the schema shape" | ⚠️ Vendor claim. Plausible, since the output is bounded; the client still validates every field. |
| "Case studies from the Brazilian community" | ❓ Nothing found. |

**What the summary leaves out:**
- Early access with a waitlist (console.typesafe.ai).
- *"English is the primary training language and where accuracy is currently best. Other languages … are handled but not equally well; test on your own content."* (models page).
- 64k tokens per request; 80 requests and 100k tokens per second; `429` and `529` to be retried with backoff.
- Not trained on customer requests; zero data retention for enterprise customers only.
- `jev-latest` and `jev-preview` are aliases that move with each release (today `jev-1.13.0`).
- 70–500 ms per call (vendor).

### Rationale

- **Cost decides nothing.** About 500 input tokens per call, or $0.00002. A one-hour interview costs under $0.01.
- **Upkeep is the gain.** Each miss used to be a new regex. Now it is a measured change to the criteria in `jevClient.js`.
- **Latency is hidden, not removed.** R6 rejected an LLM classifier for seconds of latency and for quota. Jev answers in hundreds of milliseconds, and the call starts when the gate accepts the turn, inside the 800 ms debounce (R10's prefetch pattern). The answer waits at most 250 ms more.
- **The fallback is required.** The network, a 429/529 or a revoked key must not take the notes away mid-interview. The tuned regex router is that fallback, so freezing it costs nothing.
- **Portuguese is the risk.** Most of the eval set (75 of 100) and most of the regex tuning are Portuguese. That is why the release checks compare per language, and why each criterion carries an English and a Portuguese example.
- **Privacy (owner decision).** The turn, the previous question, the interviewer's company and the manifest's names go to TypeSafe. The flag and the key make that explicit; a `CAREER_ROUTER` typo reads as `regex`.

### Alternatives considered

- **Hybrid (regex first, Jev only on `ambiguous`/`general`).** Smaller change and less data sent. Rejected by the owner in favor of the full switch. The earlier analysis is in `hybrid-plan.md`.
- **A local embedding fallback** (nearest prepared question with the Arctic Embed model already loaded). Free and offline. Left for later: it would replace the regex as the fallback, not Jev.
- **SDK (`@typesafe-ai/sdk`).** Its retries do not fit the live budget, and native `fetch` covers the rest.

### Superseded

R6's "an LLM classifier is rejected" still holds for generative LLMs. Jev is a decision model with bounded output and sub-second latency, and the latency it does add is hidden inside the debounce.

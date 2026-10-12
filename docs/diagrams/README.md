# Glass Architecture Diagrams

Mermaid (`.mmd`) source for every diagram referenced by
[`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) and
[`../LIVE_INSIGHTS_AND_ASK.md`](../LIVE_INSIGHTS_AND_ASK.md). Each file is a standalone diagram
grounded in the current code — read them next to the matching section.

## Index

| # | File | What it shows |
|---|------|---------------|
| 01 | `01-system-topology.mmd` | Process topology — main process, renderer windows, embedded web stack, local & cloud dependencies |
| 02 | `02-window-model-and-invisibility.mmd` | The `windowPool`, frameless/transparent windows, and `setContentProtection` (the "invisible to capture" mechanism) |
| 03 | `03-ipc-architecture.mmd` | The three bridges (`feature`/`window`/`internal`), preload `contextBridge`, and the web-dashboard data round-trip |
| 04 | `04-app-lifecycle.mmd` | Startup order in `app.whenReady()` and the graceful `before-quit` shutdown |
| 05 | `05-ask-vision-sequence.mmd` | One Ask press → one screenshot → streaming answer (and the stateless / text-only-fallback behavior) |
| 06 | `06-listen-audio-pipeline.mmd` | Dual-channel audio capture → AEC → two STT sessions → transcripts |
| 07 | `07-speaker-attribution.mmd` | Why "Me vs Them" is **source attribution, not voice diarization**, per platform |
| 08 | `08-stt-session-lifecycle.mmd` | STT init-retry, 60 s keep-alive, 20 min renewal, and the no-failover drop gap |
| 09 | `09-summarization-pipeline.mmd` | Incremental summary every 5 turns, building on the previous summary |
| 10 | `10-provider-factory-and-model-state.mmd` | The `PROVIDERS` registry + `modelStateService` resolution of `{provider, model, apiKey}` (+ `keys` for an LLM list), the `gemini-` / `claude-` / `vendor/model` (Groq) prefix rule, the routing of a list that names several providers to the chain, and the shared cooldown registry |
| 11 | `11-gemini-failover.mmd` | The Gemini CSV failover loop, error classification, and cooldown (LLM only) |
| 12 | `12-data-persistence-and-auth.mmd` | Dual SQLite/Firebase repository pattern, schema, and auth-driven storage switching |
| 13 | `13-run-as-is-decision.mmd` | "If I run it as-is" — what works on first launch, per platform |
| 14 | `14-career-intent-router.mmd` | How Live Answer's career intent router picks a route (company, follow-up, personal, ambiguous, general) and what each route searches. Shown in `LIVE_INSIGHTS_AND_ASK.md` §4.7 |
| 15 | `15-anthropic-failover.mmd` | The Claude CSV failover loop: request building, first-text / idle / deadline timeouts, error kinds, cooldowns, server-side refusal fallback, second round (LLM only) |
| 16 | `16-groq-failover.mmd` | The Groq CSV failover loop: image routing (vision models first), request building per reasoning family, first-text / idle / deadline timeouts, error kinds incl. too-large (413), cooldowns, second round (LLM only) |
| 17 | `17-cross-provider-chain.mmd` | A model list that names several providers (e.g. Groq then Gemini): segments, skips (no key, all models cooling, no time left), the 60 s chain deadline with a 15 s reserve, images first, the `provider` reset, and the final messages |

## Rendering

You need [`@mermaid-js/mermaid-cli`](https://github.com/mermaid-js/mermaid-cli)
(`mmdc`). The render scripts produce SVGs into `./out/`.

```bash
# one-off, no install
npx -p @mermaid-js/mermaid-cli mmdc -i 01-system-topology.mmd -o out/01-system-topology.svg

# or render all of them
./render.sh            # macOS / Linux / Git-Bash
pwsh ./render.ps1      # Windows PowerShell
```

GitHub, VS Code (with a Mermaid extension), and most Markdown viewers also render
`.mmd` / fenced `mermaid` blocks inline without any tooling.

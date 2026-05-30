# Glass Architecture Diagrams

Mermaid (`.mmd`) source for every diagram referenced by
[`../../ARCHITECTURE.md`](../../ARCHITECTURE.md). Each file is a standalone diagram
grounded in the current code — read them next to the matching ARCHITECTURE.md section.

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
| 10 | `10-provider-factory-and-model-state.mmd` | The `PROVIDERS` registry + `modelStateService` resolution of `{provider, model, apiKey}` |
| 11 | `11-gemini-failover.mmd` | The Gemini CSV failover loop, error classification, and cooldown (LLM only) |
| 12 | `12-data-persistence-and-auth.mmd` | Dual SQLite/Firebase repository pattern, schema, and auth-driven storage switching |
| 13 | `13-run-as-is-decision.mmd` | "If I run it as-is" — what works on first launch, per platform |

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

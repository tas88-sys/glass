# Documentation Update Report: Live Features Toggle

**Spec**: `2026-10-12-live-features-toggle`
**Date**: 2026-10-12
**Scope**: docs affected by the branch's code changes (T019, T-DOC-GATE)
**Method**: by hand. The documentation-reconciliation agent is not installed on this machine. I searched the live docs (`*.md`, `*.mmd` outside `specs/` and `node_modules/`) for:
- every description of the two Listen lanes ("Live Answer", "Live Insights", `triggerAnalysisIfNeeded`, "every 5", "5th");
- line references into the files this branch edits (`featureBridge.js`, `listenService.js`, `settingsService.js`, `summaryService.js`, `preload.js`, `ListenView.js`, `LiveAnswerView.js`, `liveAnswerHistory.js`, `SettingsView.js`). Each was compared with `origin/main`.

**Status: PASS**

## Updated

| Doc | Change |
|-----|--------|
| `docs/LIVE_INSIGHTS_AND_ASK.md` | §1 table: a "Can be turned off" row, and a note under the one-sentence version. §3.3: the every-5-turns test cited at its real line, with the early return before it. New §3.6 Turning Live Insights off: no call, no `summary-update`, no summary saved, the Activity page, the answer-only labels, the empty-state line and the copy, an analysis in flight finishing, the cadence when turned back on, the cost. §4.1: the early return before the four gates. New §4.8 Turning Live Answer off: the mode table, the early return, the career warm-up kept, `pauseLiveAnswer` and what it keeps (vs `resetLiveAnswer`), the `idle` status, where the mode lives (store key, `liveFeatures.js`, the two IPC handlers and the push, session start, the `[Live]` log line). §8 file map: two rows, and the IPC row names the new channels |
| `ARCHITECTURE.md` | §8 diagram: a "Live Insights on?" decision before the gate (renders with `mmdc`). §8 text: the gate's line references now point at the current code (they were already off on `main`). A paragraph on the Live panels setting: the store key, both early returns, the pause, the IPC handlers and the push, session start. §17 file map row |
| `docs/diagrams/09-summarization-pipeline.mmd` | The same decision before the gate, and a header comment. Renders with `@mermaid-js/mermaid-cli` |
| `docs/diagrams/README.md` | Row 09 says the pipeline is skipped when Live Insights is off |
| `docs/AUDIO_AND_STT.md` | §6: Live panels can turn either lane off; the transcript is captured and saved in every mode |
| `README.md` | A "Live panels" paragraph under Incremental summarization |
| `CHANGELOG.md` | `[Unreleased]` entry for the branch |
| `docs/future-work.md` | Item 7: the Listen-bar toggle, less frequent Live Insights and a per-lane model list, with acceptance items |

### Line references this branch moved

The branch inserts lines into files the docs cite by line. A reference past an insertion was shifted by the number of lines inserted before it. A reference that was right on `main` is still right, and one that was already off is no worse. 36 references (or runs such as `:134`, `:143`) were shifted:
- `ARCHITECTURE.md`: 8 (`featureBridge.js` ×5, `listenService.js` ×2, `preload.js` ×1);
- `docs/AUDIO_AND_STT.md`: 7 (`listenService.js` ×5, `SettingsView.js` ×2);
- `docs/LIVE_INSIGHTS_AND_ASK.md`: 19 (`featureBridge.js`, `summaryService.js`, `ListenView.js`, `listenService.js`, `preload.js`; the §3.3 one was then rewritten to the current line);
- `docs/runbook/AUDIO_TROUBLESHOOTING.md`: 2 (`listenService.js`).

One reference started on the blank line before an insertion (`listenService.js:99-107`, `handleTranscriptionComplete`) and was set to its new span, `:105-112`. The `featureBridge.js` references (the Ask handlers, `VALID_ASK_MODES`) were right on `main` and were checked against the current file.

## Checked, no change needed

- `ARCHITECTURE.md` §4 (IPC) describes the bridges in general and has no per-channel table; the new channels are named in §8.
- `docs/LIVE_INSIGHTS_AND_ASK.md` §4.3 (the `live-answer-update` payload table): the pause sends no new payload kind; the `idle` it may send is already listed.
- `docs/LIVE_INSIGHTS_AND_ASK.md` §4.5 (Session reset): unchanged. The session-start reset still runs as before; the new pause is described in §4.8.
- `docs/runbook/AUDIO_TROUBLESHOOTING.md`: about capture and STT, which do not depend on the mode.
- `CONTRIBUTING.md`, `docs/DESIGN_PATTERNS.md`, `docs/GEMINI_503_PEAK_HOURS.md`, `docs/proctoring-detection-coverage.md`, `docs/refactor-plan.md`: they do not describe the two lanes.
- `CHANGELOG.md` older entries and older specs: history, left as written.

## Found, not fixed (out of scope)

- Several line references into `summaryService.js` and `ListenView.js` in `docs/LIVE_INSIGHTS_AND_ASK.md` were already off on `main`. They point at other code than they describe, e.g. `ListenView.js:436`, which is CSS. They were shifted with the rest and left for a separate pass. The exceptions are the references in paragraphs this branch rewrote (§3.3 and `ARCHITECTURE.md` §8), which now point at the current code.

---
# Context Optimization Metadata
meta:
  spec_id: 2026-10-13-live-answer-history
  spec_name: live-answer-history
  status: completed
  phase: done
  created: 2026-10-13
  updated: 2026-10-13

summary:
  goals:
    - {id: G1, description: "After an interview, every live answer the app produced can be reviewed: what the interviewer said, what the panel showed, how it ended, which model wrote it and which notes it drew on", priority: HIGH}
  constraints:
    - {id: C1, description: "Local only: the app's SQLite DB. Never synced; skipped while signed in to Firebase, whose sessions live elsewhere and could not delete local rows", type: SECURITY}
    - {id: C2, description: "Never logs the answer text (the Listen lane's standing rule). A failed write costs the row, never the answer", type: TECHNICAL}
    - {id: C3, description: "Lifts C8 of 2026-05-30-interview-live-answer (in-memory only) by owner decision of 2026-10-13: the answers of a real interview were gone when the owner asked how good they were", type: TECHNICAL}
  decisions:
    - {id: D1, decision: "One table, live_answers, one row per answer the debounce started (answered, PASSIVE, empty, cut off by a newer question, failed)", rationale: "Review needs the misses too: a cut-off answer is what the candidate saw half of"}
    - {id: D2, decision: "On by default; LIVE_ANSWER_HISTORY=0 turns it off", rationale: "Same data class as the transcript, which the app already keeps; the owner asked for it"}
    - {id: D3, decision: "Note titles (sources), not the notes' text", rationale: "The notes stay in the KB; the titles say which ones the answer drew on"}
---

# Live answer history

## Problem

Live answers went to the panel and nowhere else (C8 of `2026-05-30-interview-live-answer`). After a
71-minute interview, the 101 answers it produced could not be reviewed: the debug log keeps counts,
never text, and the DB kept only the transcript.

## Functional requirements

- **FR-001 Row per answer.** When the 800 ms debounce starts an answer, the Listen lane keeps one
  row in `live_answers`: session id, `asked_at_ms`, the interviewer's `turn` and the extracted
  `question`, the `answer` as it last stood, `status` (`answer`, `passive`, `empty`, `replaced`,
  `error`), `error`, `model` (the one that answered, from the stream's `_final_model`, else the first
  of the list), the career `route`, `route_source` (`jev`, `regex`, `regex(<fallback>)`), `cue`,
  `sources_json` (note titles), `unverified_json` (the live check's flags), `first_token_ms` and
  `total_ms` from the debounce firing.
- **FR-002 Local only.** Written only for local sessions (not signed in to Firebase), never synced.
  `LIVE_ANSWER_HISTORY=0` turns it off. Text fields are clipped at 20,000 chars.
- **FR-003 Deleted with the session.** Deleting a session, or the local user, deletes its rows.
- **FR-004 Never in the way.** A failed write logs one line with the error, never the text, and the
  answer is unaffected.
- **FR-005 Export.** `scripts/export-live-answers.js` writes a session's rows (and, with
  `--with-transcript`, its transcript) to a JSONL file outside the repo; `--list` shows the Listen
  sessions with their answer counts.

## Files

- `src/features/common/config/schema.js`: the `live_answers` table (created by the schema sync on start).
- `src/features/listen/summary/repositories/liveAnswers.js`: `createLiveAnswerRepository` (`save`,
  `getBySessionId`, `enabled`) and the app's instance.
- `src/features/listen/summary/summaryService.js`: the debounce builds the record; `makeLiveAnswer`
  fills model, first token, text, status and flags; `saveLiveAnswer` writes it in `finally`.
- `src/features/common/repositories/{session,user}/sqlite.repository.js`: delete the rows.
- `scripts/export-live-answers.js`.
- Tests: `src/features/listen/summary/__tests__/liveAnswerHistory.test.js` (repository on
  `node:sqlite` in memory with the app's schema; the lane's rows for answer, PASSIVE, error, cut off,
  no session, and a failing repository).

## Verification

- `npm test`: 1430/1430.
- Under Electron's Node, on a copy of the owner's DB: the schema sync creates the table (17
  columns), a row is saved and read back, and deleting the session deletes it.

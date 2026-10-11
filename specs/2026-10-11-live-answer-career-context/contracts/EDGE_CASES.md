# Edge Cases: Live Answer Career Context

**Spec**: `2026-10-11-live-answer-career-context`

| # | Situation | Expected behavior | Covered by |
|---|-----------|-------------------|-----------|
| E1 | `CAREER_KB_PATH` unset | Feature disabled; LLM messages byte-identical to today | FR-001, SC-005, `summaryService` integration test |
| E2 | Path set but folder missing or unreadable | Same as E1, with a debug log once | FR-001, FR-017 |
| E3 | `glass-kb.json` is invalid JSON or has an unknown version | Manifest ignored; defaults apply | FR-002 |
| E4 | A manifest path tries to escape the root (`../x`) | That entry is dropped | FR-002 |
| E5 | A single file throws while reading or parsing | That file is skipped; the others are indexed | FR-017 |
| E6 | Q-line carries `⚠️ CONFIRMAR` or `[PREENCHER` | Whole Q-block dropped | FR-004 |
| E7 | Marker inside a body paragraph | Only that line removed | FR-004 |
| E8 | Heading-less file | One breadcrumb (`file`); split on paragraphs by size | FR-003 |
| E9 | Section over 1,200 chars | Split on paragraph boundaries; title repeated | FR-003 |
| E10 | A single paragraph over 1,200 chars | Split on sentence boundaries | FR-003 |
| E35 | A heading's body is under 300 chars and a subsection follows (a timing line above the answer) | The body moves into that subsection; it never stands alone | FR-003 |
| E36 | A table over 1,200 chars | Split by rows; each piece repeats the header row and any caption line right above it | FR-003 |
| E37 | An answer uses an ordinary word that is also a known company name ("we can bridge that gap") | Not flagged: names are matched with the manifest's casing in the answer | FR-021 |
| E38 | An answer has list numbers or numbers inside names ("1.", "EC2", "OAuth2") | Not flagged | FR-021 |
| E39 | An answer states a number worked out from the notes (years of experience from a start date) | Flagged: the line asks the candidate to check it before saying it | FR-021 |
| E11 | Turn in Portuguese, best note in English | Retrieved through the vector side; answer in Portuguese | FR-009, FR-014 |
| E12 | Turn names a tool or vendor exactly | BM25 rank carries it into the fused top k | FR-008, FR-010 |
| E13 | "why us" with active company A; notes of B rank higher | B's chunks dropped; A's and untagged chunks kept | FR-011 |
| E14 | "why us" with no active company | No company-tagged chunks; card plus untagged chunks only | FR-011 |
| E29 | A folder holds prep for companies A, B and C; a file name starts with B's slug | That file's chunks are tagged {B}; files naming none are tagged {A, B, C} | FR-005 |
| E30 | Company A's prep sits in two folders | Both folders alias to A; their chunks share the tag | FR-005 |
| E31 | Interviewer says a two-word company name whose first word is another company's name | The two-word name wins (longest match) | FR-011 |
| E15 | Interviewer names company A mid-session | `activeCompany` = A from then on (unless env set) | FR-011 |
| E16 | Short follow-up after a personal answer | Stays personal; previous query terms merged | FR-006 |
| E17 | Follow-up long after (> 5 min) or after a general question | No stickiness | FR-006 |
| E18 | Ambiguous turn with weak hits | Nothing injected | FR-012 |
| E19 | Embedding not ready within 150 ms | BM25-only; late result ignored | FR-009 |
| E20 | Model download fails or offline on first run | `ready-bm25` for the session | FR-009, FR-017 |
| E21 | Worker crashes mid-pass | BM25-only; cached rows kept; worker restarted on next warm | FR-017 |
| E22 | Newer question aborts the in-flight one, including while its career context is still being resolved | Context is resolved after the AbortController exists; if aborted after the await, no LLM call is made. No `sources` leak to the new id | FR-015 |
| E23 | Context block exceeds 9,000 chars | The card stays whole; lowest-ranked chunks dropped first, then the last chunk cut at a paragraph boundary | FR-013 |
| E24 | Two chunks with the same title from different files | Both kept (dedupe is path + title) | FR-013 |
| E25 | Same fact with different values in two chunks | Card value wins (addendum); newer chunk ranks first on ties | FR-010, FR-014 |
| E26 | `LIVE_ANSWER_DEBUG=1` | Logs show route, cue, ids, scores, timings; no note text | FR-018 |
| E27 | Statement-form career prompt without a question signal | Triggers (gate widened) | FR-007 |
| E28 | `me` turn with a career cue | Never triggers (speaker gate unchanged) | FR-007 |
| E32 | A company name that is also an ordinary word comes up in small talk (company "Bridge"; "we can bridge that gap") | No switch: detection needs a company-context phrase | FR-011 |
| E33 | The card alone exceeds the 9,000-char cap | Card injected whole, no chunks, debug warning | FR-013 |
| E34 | Feature disabled and a statement-form career prompt arrives ("your biggest weakness") | Does not trigger: the gate behaves exactly as today | FR-007, C1 |

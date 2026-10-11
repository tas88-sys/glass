# Documentation Update Report

**Spec**: `2026-10-11-live-answer-career-context`
**Date**: 2026-10-11
**Method**: manual. The `documentation-reconciliation` agent is not installed on this machine.

**Status: PASS**

## Scope

Every Markdown file outside `specs/` that mentions Live Answer, its prompt slot, its environment variables or the packaging the feature changed:

```
grep -rl "LIVE_ANSWER_DEBUG|Live Answer|customPrompt|GEMINI_HEDGE" --include=*.md
```

Older specs were left alone (historical records); `live-answer-improvements/` is the user's own notes.

## Changes

| Document | Change |
|----------|--------|
| `docs/LIVE_INSIGHTS_AND_ASK.md` | New §4.7 Career context: env vars (`CAREER_KB_PATH`, `CAREER_KB_COMPANY`, `CAREER_KB_VECTORS`), manifest, routes, retrieval, injection, `sources`, lifecycle, debug line, eval, rollback (FR-020). New §4.6: Gemini failover, hedge, 60 s deadline, `LIVE_ANSWER_DEBUG`. §4.1 describes the current question gate. §4.3 adds `sources`. §4.5 covers career session state. File map updated. Twelve stale `summaryService.js` line references fixed. These are the drifts listed in `live-answer-improvements/live-answer.md` |
| `ARCHITECTURE.md` | §8 line references fixed. §13 notes that Live Answer fills `customPrompt` with career context. §14 covers `onnxruntime-node` unpacking and per-platform binaries. §17 file map row |
| `CHANGELOG.md` | `[Unreleased]` entry: Added / Changed / Fixed / Docs |
| `docs/future-work.md` | "Personalized answers (v2)" marked shipped, with the spec's remaining out-of-scope items |
| `README.md`, `CONTRIBUTING.md` | No Live Answer content; no change needed |

## Checks

- No personal content (spec C5). The leak scan over all changed files (company names, employers, city, personal names) found 0 hits.
- Every `summaryService.js:` line reference in the two docs points at the code it names (checked against the current file).
- Environment variables in the docs match the code (`index.js`: `CAREER_KB_PATH`, `CAREER_KB_COMPANY`, `CAREER_KB_VECTORS`; `LIVE_ANSWER_DEBUG` gates `[career]` lines).

## Update for T029 (retrieval quality)

The embedding model, the fusion and the block size changed. Docs that named the old values:

| Document | Change |
|----------|--------|
| `docs/LIVE_INSIGHTS_AND_ASK.md` | §4.7: three rankings (BM25, chunk text, section title), one section per file, up to six chunks within 9,000 characters, Arctic Embed v2.0, ~310 MB download, ~25 min first pass, ~0.7 GB saved by `CAREER_KB_VECTORS=off` |
| `CHANGELOG.md` | `[Unreleased]` Added: model, title vectors, block size, RAM figure |
| `spec.md` | FR-009 (text and title vectors), FR-010 (three rankings, one per file, top 6), FR-013 (9,000 chars), dependency table |
| `research.md` | R5 update: the comparison, rejected options, decision and caveats |
| `plan.md`, `data-model.md`, `contracts/EDGE_CASES.md`, `quickstart.md` | Download size, excerpt cap, vector shapes and keys, E23/E33 cap, RAM figure |
| `spike-embeddings.md` | Note that the shipped model changed; the spike numbers stay as recorded |

Checks: the leak scan over the changed files found 0 hits, and no doc still names e5-small as the shipped model (it remains a model profile in `embedder.js`).

## Update for T030 (chunking)

Two chunker rules were added; the size cap did not change.

| Document | Change |
|----------|--------|
| `CHANGELOG.md` | `[Unreleased]` Added: the chunker line names both rules |
| `spec.md` | FR-003: short intros move into their subsection; split tables repeat their header row |
| `data-model.md` | Chunk `body`: when a body can be under 300 characters |
| `contracts/EDGE_CASES.md` | E35 (short intro above a subsection), E36 (table over the cap) |
| `research.md` | R12: slot audit, cap comparison, decision; R10 excerpt figure brought to 9,000 characters |

`docs/LIVE_INSIGHTS_AND_ASK.md` does not describe chunk rules, so it is unchanged.

## Update for T031 (live answer check) and T032 (pending answer-quality test)

| Document | Change |
|----------|--------|
| `README.md` | Listen feature: an optional career-context paragraph; Glass runs without a notes folder |
| `docs/LIVE_INSIGHTS_AND_ASK.md` | §4.7 step 5 (Check) and the `check unverified=N` debug line |
| `ARCHITECTURE.md` | Prompt section: answers that used notes are checked |
| `CHANGELOG.md` | `[Unreleased]` Added: live check of career answers |
| `docs/future-work.md` | §4: the answer-quality test (T032), pending |
| `spec.md` | FR-021 and its test-strategy row |
| `data-model.md`, `contracts/career-context.contracts.d.ts` | `unverified` payload field; `checkAnswer` on the module |
| `contracts/EDGE_CASES.md` | E37–E39 |
| `quickstart.md` | Manual check 11 |

## Update for T033 (ask script)

| Document | Change |
|----------|--------|
| `docs/LIVE_INSIGHTS_AND_ASK.md` | §4.7: later launches embed only new or edited sections; "Try one question"; both scripts read `.env` and the app's cache; the file table |
| `ARCHITECTURE.md` | Career row lists the ask script |
| `CHANGELOG.md` | `[Unreleased]` Added: the ask script |
| `spec.md` | FR-022 and its test-strategy row |
| `contracts/career-context.contracts.d.ts` | `trace.k` and the per-ranking fields of `trace.hits` |
| `quickstart.md` | §2: the ask script; both scripts read `.env` and the app's cache |
| `research.md` | R13: why the script was created, what was rejected, what its first use found |
| `README.md` | Career paragraph: how to see which notes a question would use |

## Update for T034 (router: past-tense "what was your")

| Document | Change |
|----------|--------|
| `contracts/EDGE_CASES.md` | E40 (past-tense question, fixed), E41 (follow-up vector query, open) |
| `research.md` | R13 findings |

`docs/LIVE_INSIGHTS_AND_ASK.md` does not list cue rules, so it is unchanged.

## Update for T035 (follow-up vector query)

| Document | Change |
|----------|--------|
| `spec.md` | FR-009: a follow-up's vector query and prefetch carry the previous question |
| `data-model.md`, `contracts/career-context.contracts.d.ts` | `anchorText` on the context and in `careerPrev`; `prefetch` takes the session |
| `docs/LIVE_INSIGHTS_AND_ASK.md` | §4.7 Retrieve: the follow-up embedding query |
| `contracts/EDGE_CASES.md` | E41 now fixed; E42 (a chain of follow-ups) |
| `research.md` | R13: the follow-up finding, fixed, with the before and after check |

## Update for T036 (intent router diagram)

| Document | Change |
|----------|--------|
| `docs/diagrams/14-career-intent-router.mmd` | New: the router's four checks in order, the route each one picks, and what each route searches |
| `docs/LIVE_INSIGHTS_AND_ASK.md` | §4.7: the diagram inline, then the rules (cues, order, follow-ups, manifest names, the ambiguous threshold, the answer gate), a table of examples with route and cue, and how to change a cue |
| `docs/diagrams/README.md` | Index row 14; the folder also serves `LIVE_INSIGHTS_AND_ASK.md` |
| `ARCHITECTURE.md` | §13 points to the diagram |

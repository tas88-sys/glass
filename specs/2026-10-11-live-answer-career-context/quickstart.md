# Quickstart & Verification: Live Answer Career Context

**Spec**: `2026-10-11-live-answer-career-context`
**Date**: 2026-10-11

## 1. Point Glass at the notes

In `.env` at the repo root (`src/index.js:8` loads it):

```
CAREER_KB_PATH=D:\path\to\career-notes
# optional: pin the interviewing company (folder name under companies.root)
CAREER_KB_COMPANY=
# optional: see routing and retrieval decisions
LIVE_ANSWER_DEBUG=1
```

Optional `glass-kb.json` at the notes root (see `data-model.md`):

```json
{
  "version": 1,
  "core": ["about-me/canonical-facts.md"],
  "include": ["**/*.md", "**/*.txt"],
  "exclude": ["chats/**", "code/**"],
  "companies": { "root": "interviews", "skip": ["shared"], "aliases": {} }
}
```

## 2. Automated checks

```bash
npm test                                   # pure modules + summaryService wiring (synthetic fixtures)
node scripts/eval-career-kb.js             # real KB: router matrix, recall@3, leaks, latency
node scripts/eval-career-kb.js --bm25-only # baseline for comparison
```

The eval reads `CAREER_KB_PATH` and `<KB>/glass-eval/questions.jsonl`. Pass criteria: SC-001 to SC-004 in `spec.md`.

## 3. Manual verification (running app)

`npm start`, open Listen, and play or speak interviewer audio as "them". With `LIVE_ANSWER_DEBUG=1`, each answer logs a line like:

```
[career] route=personal cue=behavioral:tell-me-about-a-time chunks=a1b2c3d4e5f6,… bm25=1.8ms vector=used(0ms wait) total=3.1ms
```

| # | FR | Say (as the interviewer) | Expected |
|---|----|--------------------------|----------|
| 1 | FR-006, FR-014, FR-015 | "Tell me about a time you disagreed with a teammate." | First-person story from the notes; "from: …" line under Q: |
| 2 | FR-014, SC-005 | "What's the difference between a mutex and a channel?" | Same style as today; no "from:" line; log shows `route=general` |
| 3 | FR-009 | The same question as #1, in Portuguese | Same story retrieved; answer in Portuguese |
| 4 | FR-011 | "Why do you want to join us?" (with `CAREER_KB_COMPANY` set) | Only that company's notes in "from:"; no other company named |
| 5 | FR-006 | Right after #1: "And what was the outcome?" | Stays personal (`cue=follow-up`) |
| 6 | FR-007 | "Your biggest weakness." (no question mark) | Triggers an answer |
| 7 | D6 | A question touching a fact listed on the canonical card | The card's value is used |
| 8 | C1 | Unset `CAREER_KB_PATH`, restart, repeat #1 | Today's behavior: no "from:", log shows the feature disabled |
| 9 | FR-009 | Rename the model cache folder, start offline | Answers still work; log shows `vector=unavailable` |
| 10 | FR-018 | Inspect the console during 1–9 | No note text in any `[career]` line |

## 4. Rollback

Unset `CAREER_KB_PATH`. Behavior returns to today's, with no other change required.

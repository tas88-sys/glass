# Phase 1 Data Model: Live Answer Career Context

**Spec**: `2026-10-11-live-answer-career-context`
**Date**: 2026-10-11

## Overview

There are no database changes. Everything lives in memory in the main process, except the embedding cache, which is a file in Electron `userData`. Types are formalized in `contracts/career-context.contracts.d.ts`.

## Entities

### Manifest (`glass-kb.json`, optional, at the KB root, owned by the user)

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `version` | `1` | `1` | Unknown versions are treated like a missing manifest |
| `include` | glob[] | `["**/*.md", "**/*.txt"]` | Relative to the KB root, forward slashes |
| `exclude` | glob[] | `[]` | Always also excludes `.git/**` and `node_modules/**`; exclude wins over include |
| `core` | path[] | `[]` | Canonical card file(s), injected whole on personal and company routes; never chunked |
| `companies.root` | path | none | A folder whose direct subfolders are companies |
| `companies.skip` | string[] | `[]` | Subfolders under `root` that are not companies (shared material) |
| `companies.aliases` | `{folder: string[]}` | `{}` | The company names a folder holds, as interviewers say them. Used for tagging (FR-005) and detection (FR-011). Several folders may list the same name |

Validation: if the JSON is invalid, it is ignored with a debug log and the defaults apply. Paths that escape the root (`..`) are dropped.

### Chunk

| Field | Type | Source |
|-------|------|--------|
| `id` | string | First 12 hex characters of sha1(`path` + `title` + ordinal). Stable across runs while the text is stable |
| `path` | string | Relative to the KB root |
| `title` | string | Breadcrumb `file › H2 › H3`; for Q-blocks, the breadcrumb plus the Q line |
| `body` | string | 300–1,200 characters, markers removed (FR-004) |
| `companies` | string[] | Folder under `companies.root`: its aliases narrowed by file name (else all of them), or the folder name when it has none. Empty for skipped folders and files outside the root (FR-005) |
| `date` | number (epoch ms) | `YYYY-MM(-DD)` in the filename, else file mtime |
| `kind` | `'qa' \| 'section'` | `qa` for `**Q:` blocks |
| `hash` | string | sha1(`title` + `\n` + `body`), the embedding cache key |

Lifecycle: the chunks of a file are replaced whenever its mtime changes (FR-016). Chunks of deleted files are dropped.

### Lexical index (BM25)

| Part | Shape |
|------|-------|
| `postings` | `Map<term, Array<[chunkIdx, tfTitle, tfBody]>>` |
| `lenTitle`, `lenBody` | `Uint16Array` per chunk |
| `avgTitle`, `avgBody` | number |
| params | `k1 = 1.2`, `b = 0.75`, weights title 3 and body 1 |

### Vector index and cache

| Part | Shape |
|------|-------|
| In memory | `Float32Array(n × 384)`, L2-normalized, row i ↔ chunk i |
| Cache file | `userData/career-kb/vectors-<modelId>.bin` plus `index.json` (`{ hash → row }`), rewritten after each embedding pass |
| Invalidation | A model-id change discards the cache. A chunk whose hash is missing gets embedded in the next low-priority pass |

### Route decision

`{ route: 'personal' | 'company' | 'ambiguous' | 'general', cue: string | null }`. The `cue` is the name of the rule that fired (for example `behavioral:tell-me-about-a-time`), never the turn text.

### Career context (what the debounce callback hands to `makeLiveAnswer`)

| Field | Type | Notes |
|-------|------|-------|
| `route` | Route | |
| `cue` | string \| null | |
| `block` | string | Empty string when nothing is injected |
| `addendum` | string | Empty string when nothing is injected |
| `sources` | string[] | Chunk titles, plus `canonical facts` when the card was injected |
| `chunkIds` | string[] | For debug logs |
| `timings` | `{ routeMs, bm25Ms, vectorMs, vectorUsed, totalMs }` | For debug logs and the eval |

`null` means the feature is disabled or erred, and the caller behaves as today.

### Session state (in `SummaryService`, reset by `resetLiveAnswer`)

| Field | Purpose |
|-------|---------|
| `careerPrev` | `{ route, queryTerms, ts }` of the last answered personal question, used for follow-ups |
| `activeCompany` | Detected company name (FR-011) when `CAREER_KB_COMPANY` is not set |
| `careerPrefetch` | `{ tail, promise }` for the query embedding started on the gated turn |

### `live-answer-update` payload (extended)

| Field | Change |
|-------|--------|
| `sources?: string[]` | **New.** Present only on answers with injected context, carried on every delta of that answer |

`applyLiveAnswerUpdate` stores `sources` on the entry when it creates it and keeps it on updates. Status payloads (`retrying`, `idle`, `error`) are unchanged.

### Eval question (KB repo, `glass-eval/questions.jsonl`, one JSON object per line)

| Field | Type | Notes |
|-------|------|-------|
| `text` | string | As the interviewer asked it |
| `lang` | `'en' \| 'pt'` | |
| `route` | Route | Expected route |
| `id` | string | `q001`… |
| `gold` | `{ path, anchor }[]` | Notes that answer it (personal and company items). A chunk matches when its `path` equals `path` and its title contains `anchor` (a heading or Q-line excerpt); an empty `anchor` matches any chunk of the file. Robust to breadcrumb format changes. A core-file entry is a hit when the route injects the card |
| `holdout` | boolean | Excluded from cue and threshold tuning; SC-001..SC-004 are judged on it |
| `company` | string \| null | Active company to simulate (company items) |
| `source` | string \| null | Note it was taken from. Its chunks are excluded while this item is evaluated (leave-source-out). `null` for generic phrasings |
| `fidelity` | `'transcript' \| 'recalled' \| 'debrief' \| 'written-form' \| 'reported' \| 'generic'` | How close `text` is to what was actually said. `generic` items only test company scoping |
| `note` | string? | Free-form remark |

## State transitions

```
disabled ──(CAREER_KB_PATH valid)──► warming ──► ready(bm25) ──(embedding pass done)──► ready(hybrid)
   ▲                                   │              │                                     │
   └──────────(error)──────────────────┴──────────────┴──────────(model error)──► ready(bm25)
```

`ready(bm25)` serves answers at once. Answers never wait for `ready(hybrid)`.

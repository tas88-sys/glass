# Phase 1 Data Model: Live Features Toggle

**Spec**: `2026-10-12-live-features-toggle`
**Date**: 2026-10-12

## Overview

There are no database changes.
- The choice is one key, `liveFeatures`, in the per-user settings store (`electron-store`, `users.<uid>`, or `users.default` with no signed-in user).
- The state the IPC returns and pushes is derived from that key on each call and never stored.
- The service's mode is in memory, one value per `SummaryService`.

Types are formalized in `contracts/live-features-toggle.contracts.d.ts`.

## Entities

### Setting (`settingsService` store)

| Field | Type | Notes |
|-------|------|-------|
| `liveFeatures` | `'both' \| 'answer' \| 'insights'` | Default `'both'` (`getDefaultSettings`). `getSettings` merges the saved object over the defaults, so a missing key reads `'both'`. A stored value outside the three reads `'both'` through `normalizeLiveFeatures`. |

### Mode table (`liveFeatures.js`)

| Mode | Live Answer runs | Live Insights runs | `liveFeaturesLabel` | Next in the cycle |
|------|------------------|--------------------|---------------------|-------------------|
| `both` | yes | yes | Answer + Insights | `answer` |
| `answer` | yes | no | Answer only | `insights` |
| `insights` | no | yes | Insights only | `both` |
| anything else | as `both` | as `both` | as `both` | as `both` → `answer` |

### State (`liveFeaturesState`, IPC payload)

| Field | Type | Notes |
|-------|------|-------|
| `mode` | `LiveFeatures` | Normalized |
| `answer` | boolean | `answerEnabled(mode)` |
| `insights` | boolean | `insightsEnabled(mode)` |

### View labels (`viewLabels`)

| Mode | `title` | `showButton` | `copyHover` |
|------|---------|--------------|-------------|
| `both` | Live insights | Show Insights | Copy Glass Analysis |
| `insights` | Live insights | Show Insights | Copy Glass Analysis |
| `answer` | Live answer | Show Answer | Copy Glass Answer |

`title` is the top-bar text in the insights view when not hovering the copy button. The transcript view keeps "Glass is Listening <time>" in every mode.

### Service fields (`SummaryService`)

| Field | Type | Notes |
|-------|------|-------|
| `liveFeatures` | `LiveFeatures` | `'both'` after construction; set by `setLiveFeatures` |

The existing answer-lane fields (`lastAnsweredTail`, `answerDebounceTimer`, `inFlightController`, `inFlight`, `hadFallback`, `lastAnswerTs`, `answerSeq`, `careerPrev`, `activeCompany`) and analysis-lane fields (`previousAnalysisResult`, `analysisHistory`) are unchanged in meaning.

### Answers text (`answersToText`)

| Input | Output |
|-------|--------|
| `[]` or not an array | `''` |
| `[{question:'Q2',text:'A2'},{question:'Q1',text:'A1'}]` (newest first) | `Q2\nA2\n\nQ1\nA1` |
| an entry without `question` | its text alone |
| an entry without `text` | skipped |

## IPC

| Channel | Direction | Payload | Result |
|---------|-----------|---------|--------|
| `settings:getLiveFeatures` | renderer → main (invoke) | none | `LiveFeaturesState` |
| `settings:setLiveFeatures` | renderer → main (invoke) | `mode` | `{ success: true } & LiveFeaturesState`, or `{ success: false, error }` |
| `listen:liveFeaturesChanged` | main → listen window | `LiveFeaturesState` | none |

## State transitions (the service)

| From → to | Effect on the answer lane | Effect on the analysis lane |
|-----------|---------------------------|-----------------------------|
| any → same | none | none |
| Answer on → off | `pauseLiveAnswer()`: timer cleared, in-flight aborted, `inFlight = false`. The aborted answer sends no more text; its `finally` may send `status: 'idle'` | none |
| Answer off → on | none; the next `them` question answers | none |
| Insights on → off | none | none; an analysis in flight finishes |
| Insights off → on | none | none; the next multiple of 5 turns runs the analysis |

Every transition logs `[Live] features=<mode>` once, from `setLiveFeatures`, including when the mode does not change at session start.

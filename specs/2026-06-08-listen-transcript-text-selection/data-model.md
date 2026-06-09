# Phase 1 Data Model: Listen-Mode Transcript Free Text Selection

**Spec**: `2026-06-08-listen-transcript-text-selection`
**Date**: 2026-06-08

## Overview

This feature is a **CSS-only presentation change**. It introduces **no new data, no new state,
no schema changes, and no persistence**. This document records the single existing UI entity it
touches, confirming nothing about its data shape changes.

## Entities

### Transcript message (existing — unchanged)

A single speech-to-text line rendered in the listen-mode transcript.

| Field | Type | Source | Changed by this feature? |
|-------|------|--------|--------------------------|
| `speaker` | string (`"me"` \| `"them"`, case-insensitive — normalized via `getSpeakerClass`) | `SttView.sttMessages[]` component state | No |
| `text` | string (the transcribed line) | `SttView.sttMessages[]` component state | No |
| `id` | derived from `messageIdCounter` | `SttView` internal counter | No |

- **Where held**: `SttView.sttMessages` (a Lit reactive `Array` property, `SttView.js:81-83`).
- **How rendered**: each message → a `<div class="stt-message ${me|them}">` inside
  `<div class="transcription-container">` (`SttView.js:206-218`).
- **What this feature changes**: only the **CSS selectability** of the already-rendered text
  (`user-select` / `cursor`). The entity's fields, types, lifecycle, and rendering markup are
  untouched.

## State Transitions

None. No state machine, no status field, no transitions are introduced or modified. The
transcript message lifecycle (append on new STT line, auto-scroll) is unchanged.

## Validation Rules

None introduced. There is no input, no form, no user-entered data — the user merely selects and
copies text that is already displayed.

## Persistence

None. The transcript lives in renderer component state for the duration of the listen session.
No database, file, or local-storage interaction is added or changed. (Spec System Context:
Databases = N/A.)

## Relationships

`ListenView` (host) ──contains──> `<stt-view>` (`SttView`, own Shadow DOM) ──renders──>
`.transcription-container` ──contains──> N × `.stt-message`.

The "Copy transcript" button lives on `ListenView` and reads transcript text via
`SttView.getTranscriptText()` (state-driven) — unaffected by this change.

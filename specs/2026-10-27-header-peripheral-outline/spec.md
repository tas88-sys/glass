---
# Context Optimization Metadata
meta:
  spec_id: 2026-10-27-header-peripheral-outline
  spec_name: header-peripheral-outline
  status: completed      # draft | in-progress | approved | completed
  phase: done            # specify | clarify | plan | tasks | preflight | feature-start | implement | verify
  created: 2026-10-27
  updated: 2026-10-27

summary:
  goals:
    - {id: G1, description: "The owner can find the header with peripheral vision and grab it with the mouse without looking at it", priority: HIGH}
  constraints:
    - {id: C1, description: "Only the main header's styles change (src/ui/app/MainHeader.js); dragging, buttons and window size stay as they are", type: TECHNICAL}
  decisions:
    - {id: D1, decision: "The ring and its glow are drawn inside the pill (2px ring plus an inset shadow), not as an outer glow", rationale: "The header window is exactly the pill's size (47px tall, windowManager.js), so an outer box-shadow would be clipped by the window edge"}
    - {id: D2, decision: "Amber (#FFB020), kept in one token, --header-accent", rationale: "Chosen by the owner: it stands out against the blue wallpaper and dark windows, and is not mistaken for the red of an active Listen"}
---

# Header peripheral outline

## Problem

Photo of 2026-10-27 (owner's PC). The header is a black pill at 60% opacity with a 1px white ring at
8–17% opacity. Over the blue wallpaper and dark windows it blends in, so the owner has to look straight
at it to drag it. Peripheral vision picks up luminance contrast and saturated color, not detail.

## Functional requirements

- **FR-001** The main header has a 2px solid ring in `--header-accent` (amber) around the whole pill (D1, D2).
- **FR-002** An amber inset glow (`inset 0 0 10px`, 35% opacity) widens the colored area without covering the text (D1).

The onboarding headers (welcome, API key, permission) are unchanged.

## Verification

| Check | Result |
|---|---|
| V1 `npm test` | Done 2026-10-27: 1532 pass, 0 fail |
| V2 Real app (run-glass driver), screenshot of the main header | Done 2026-10-27: the ring is whole, including the rounded ends; text and buttons stay legible |
| V3 Owner's PC, both monitors, over the blue wallpaper: the header is found with the corner of the eye; dragging still works and Ask/Listen follow | Owner, 2026-10-27: approved (LGTM) |

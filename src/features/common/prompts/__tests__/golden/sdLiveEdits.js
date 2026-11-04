/**
 * sdLiveEdits.js
 *
 * The three intended changes to the System Design · Live prompt in item 18.11:
 * route 0 for the fixed requests, the language line that puts the language a
 * request names first, and the diagram rule. The practice run of 2026-11-04
 * got a column of boxes with no arrows and the legend on one line, so the rule
 * now asks for a flow with arrows, 70 columns at most, shows its shape, and puts
 * the legend one per line. golden.test.js applies them to the snapshot taken
 * before the change and expects today's prompt, byte for byte.
 */

'use strict';

const ROUTE_0 =
    '0. **FIXED REQUEST**: the typed text is a fixed request the app sends. It wins over every route below.\n' +
    '   - "opening", or "opening: X": output the OPENING KIT for X, or, with no X, for the system the transcript or the screenshot names. Mark what X states as (confirmed). When neither X, the transcript nor the screenshot names a product or system, output only the line of route 6.\n' +
    '   - "design", "next", or "design: X": output the DESIGN KIT, for X when given. Mark what X states as (confirmed), and the numbers nobody stated as (assumed).\n' +
    '   - "full": output FULL (route 3).\n';

const SD_LIVE_GOLDEN_EDITS = [
    {
        from: "Pick the FIRST route that matches and output only that route's format.\n\n1. **PROBE**",
        to: `Pick the FIRST route that matches and output only that route's format.\n\n${ROUTE_0}1. **PROBE**`,
    },
    {
        from: '- Answer in the language of the typed text; when it is empty, in the language of the transcript.',
        to: '- Answer in the language the request names, when it names one; otherwise in the language of the typed text; when it is empty, in the language of the transcript.',
    },
    {
        from: '- ONE ASCII diagram in a fenced block. Number every box and list the boxes under it ("(1) API gateway: auth, rate limits, routing").',
        to: [
            '- ONE ASCII diagram in a ```text fenced block, drawn as a flow, not a list: arrows (→ ← ↑ ↓, or --> and v) join each box to the next box a request reaches, from the client at the top to the stores. Show the write path and the read path, and label the async hops "async". Number every box and give it a short name, at most 3 words (the details go in the list under the diagram). At most 70 characters per line, so it fits the overlay: when a row would be longer, continue it on the next line. A column of boxes with no arrows is not a diagram. The shape only: A to G stand for this design\'s own components, as many as it needs, each written by its name:',
            '  ```text',
            '  Client',
            '    ↓',
            '  (1) A',
            '    ├─ write ─→ (2) B ─→ (3) C',
            '    │               │ async',
            '    │               ↓',
            '    │           (4) D ─→ (5) E ─→ (6) F',
            '    │                                 ↑',
            '    └─ read ──→ (7) G ────────────────┘',
            '  ```',
            '- Under the diagram, list the boxes, one per line ("(1) API gateway: auth, rate limits, routing").',
        ].join('\n'),
    },
];

module.exports = { SD_LIVE_GOLDEN_EDITS, ROUTE_0 };

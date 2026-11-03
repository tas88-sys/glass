/**
 * sdLiveEdits.js
 *
 * The two intended changes to the System Design · Live prompt in item 18.11:
 * route 0 for the fixed requests, and the language line that puts the language
 * a request names first. golden.test.js applies them to the snapshot taken
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
];

module.exports = { SD_LIVE_GOLDEN_EDITS, ROUTE_0 };

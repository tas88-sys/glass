'use strict';

// Phase E: the System Design Ask mode (system_design, future-work item 17).
// Each Ask is one turn with no transcript, as in the app (featureBridge sends
// an empty history to every Ask mode but System Design · Live). Generic content only.

const CASES = [
    {
        // The rate limiter in fixtures/system-design.svg: the full 12 sections.
        id: 'E1-screenshot',
        kind: 'system-design',
        expect: 'full',
        userPrompt: 'Design this.',
        image: 'system-design.svg',
        problemOnScreen: true,
    },
    {
        // A problem typed with its constraints: Rule A, and the constraints are used as given.
        id: 'E2-constraints',
        kind: 'system-design-text',
        expect: 'full',
        userPrompt: 'twitter, 10M DAU, home timeline only, US only',
        mentionsScale: ['/10\\s?m(?:illion)?\\b/', '10,000,000'],
        singleRegion: true,
    },
    {
        // Rule B: only the named part, with no placeholder lines for the rest.
        id: 'E3-deep-dive',
        kind: 'system-design-deep-dive',
        expect: 'deep-dive',
        userPrompt: 'deep dive on the cache',
        mentionsAll: [
            { terms: ['TTL', '/time[- ]to[- ]live/'], severity: 'fail' },
            { terms: ['stampede', 'coalesc', 'thundering herd', 'lock-on-miss', 'single-flight', 'singleflight'], severity: 'warn' },
        ],
    },
];

module.exports = { CASES };

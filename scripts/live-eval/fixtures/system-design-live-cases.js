'use strict';

// Phase H: System Design · Live (Ask mode system_design_live, future-work item 16).
// One interview in five Asks: each case names the route the answer must take.
// `previous` names an earlier case whose answer goes back in as the previous
// answer, as askService does within one session. Generic content only.

const TRANSCRIPT_CONFIRMED = [
    'them: Design a Twitter-like home timeline.',
    'me: Before I start, a few questions. Roughly how many daily users, and is it one region or global?',
    'them: Let\'s say 10 million daily active users, all in the US.',
    'me: Which features are in scope? Posting, following, the home timeline, search, notifications?',
    'them: Only posting, following and the home timeline. Leave search and notifications out.',
    'me: Can the timeline be a few seconds behind?',
    'them: Yes, a few seconds is fine. But a post we accepted must never be lost.',
];

const CASES = [
    {
        id: 'H1-screenshot',
        expect: 'design',
        userPrompt: 'Design this.',
        image: 'system-design.svg',
        problemOnScreen: true,
        history: [],
    },
    {
        id: 'H2-opening',
        expect: 'opening',
        userPrompt: 'Design a Twitter-like feed.',
        history: [],
    },
    {
        id: 'H3-design',
        expect: 'design',
        userPrompt: 'design',
        history: TRANSCRIPT_CONFIRMED,
        mentionsScale: ['/10\\s?m(?:illion)?\\b/', '10,000,000'],
    },
    {
        id: 'H4-deep-dive',
        expect: 'deep-dive',
        userPrompt: 'deep dive: celebrity fan-out',
        history: TRANSCRIPT_CONFIRMED,
        previous: 'H3-design',
        mentionsAny: ['push', 'pull', 'hybrid'],
    },
    {
        id: 'H5-probe',
        expect: 'probe',
        userPrompt: 'what if the timeline cache cluster goes down?',
        history: TRANSCRIPT_CONFIRMED,
        previous: 'H3-design',
    },
    {
        // A bare system name with only a desktop on screen once got the
        // "No problem yet" line (2026-10-31): the name alone is the problem.
        id: 'H6-bare-name',
        expect: 'opening',
        userPrompt: 'twitter',
        image: 'desktop.svg',
        history: [],
    },
];

module.exports = { CASES, TRANSCRIPT_CONFIRMED };

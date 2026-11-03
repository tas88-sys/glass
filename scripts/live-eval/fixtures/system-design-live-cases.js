'use strict';

// Phase H: System Design · Live (Ask mode system_design_live, future-work item 16).
// One interview in five Asks: each case names the route the answer must take.
// `previous` names an earlier case whose answer goes back in as the previous
// answer, as askService does within one session. Generic content only.
// Each userPrompt is what the candidate types; phase H sends it the way
// askService does since item 18.11 (liveDesign.resolveLiveRequest): with no kit,
// text that is not a fixed word asks for its opening kit ("twitter" →
// "opening: twitter"), so a request for the design kit types `design`.

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
        // The problem and its scale only on screen. Since 18.11 "Design this."
        // with no kit would ask for the opening kit; the design kit is `design`.
        id: 'H1-screenshot',
        expect: 'design',
        userPrompt: 'design',
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
    {
        // 18.11 rule 11: `design` carries no language; the kit follows the
        // interviewer's Portuguese, with its headings as given.
        id: 'H7-design-pt',
        expect: 'design',
        userPrompt: 'design',
        history: [
            'them: Vamos projetar a timeline inicial de uma rede social parecida com o Twitter.',
            'me: Antes de começar, quantos usuários ativos por dia, e é uma região só?',
            'them: Digamos 10 milhões de usuários ativos por dia, todos no Brasil.',
            'me: Quais funcionalidades entram? Postar, seguir, a timeline?',
            'them: Só postar, seguir e a timeline. Busca e notificações ficam de fora.',
            'me: A timeline pode atrasar alguns segundos?',
            'them: Pode, alguns segundos tudo bem. Mas um post aceito nunca pode ser perdido.',
        ],
        lang: 'pt',
        mentionsScale: ['/10\\s?m(?:i(?:lh[õo]es|llion))?\\b/', '10.000.000', '10,000,000'],
    },
];

module.exports = { CASES, TRANSCRIPT_CONFIRMED };

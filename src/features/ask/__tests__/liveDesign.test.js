/**
 * liveDesign.test.js
 *
 * The fixed rules of System Design · Live v1 (future-work item 18.11): what a
 * send asks for (rules 1 and 2), the stored kit's type (rule 5), the probe's
 * kit excerpt (rule 7) and the state. The interview's language (rule 11):
 * askLanguage.test.js.
 * Invented text only.
 *
 * Run: node --test src/features/ask/__tests__/liveDesign.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    createLiveDesign,
    parseFixedWord,
    resolveLiveRequest,
    classifyKitAnswer,
    kitExcerpt,
    wordCount,
    KIT_MIN_WORDS,
    EXCERPT_MAX_CHARS,
    HINT_DESIGN_DONE,
} = require('../liveDesign');

const words = n => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

const DESIGN_KIT = [
    '## Requirements used',
    '- Scope: posting, following, home timeline (confirmed)',
    '- Scale: 10M daily users, US only (confirmed)',
    '## API',
    '- POST /v1/posts',
    '## Design',
    '```',
    '(1) gateway -> (2) post service',
    '```',
    '- **Write path:** 1. store the post',
    '- **Storage:**',
    '| Entity | Store | Key | Why |',
    '|---|---|---|---|',
    '| Post | Cassandra | post_id | heavy writes by key |',
    '| Timeline | Redis | user_id | fast reads |',
    '- **Decisions:** push fan-out for normal accounts, pull over 1M followers; timelines in Redis, last 800 IDs.',
    '## Deep dives',
    '- **Problem:** celebrity fan-out',
    '- **Pick:** hybrid fan-out; costs a merge at read time.',
    '- **Problem:** cache node lost',
    '- **Pick:** replicas per shard; costs memory.',
    '## Check against requirements',
    '- timeline in seconds → Redis',
].join('\n');

const OPENING_KIT = ['## Frame', '> We are building a home timeline. Is that right?', '## Scope', '- **In:** users can post'].join('\n');

describe('parseFixedWord (18.11 rule 2)', () => {
    const cases = [
        ['opening', { word: 'opening', arg: '' }],
        ['design', { word: 'design', arg: '' }],
        ['next', { word: 'next', arg: '' }],
        ['full', { word: 'full', arg: '' }],
        ['DESIGN', { word: 'design', arg: '' }],
        ['Design.', { word: 'design', arg: '' }],
        ['  design  ', { word: 'design', arg: '' }],
        ['design:', { word: 'design', arg: '' }],
        ['design :', { word: 'design', arg: '' }],
        ['opening: twitter', { word: 'opening', arg: 'twitter' }],
        ['Opening:uber.', { word: 'opening', arg: 'uber.' }],
        ['design: twitter, 10M DAU, US only', { word: 'design', arg: 'twitter, 10M DAU, US only' }],
    ];
    for (const [text, expected] of cases) {
        it(`${JSON.stringify(text)} is a fixed word`, () => assert.deepEqual(parseFixedWord(text), expected));
    }
    for (const text of ['design twitter feed', 'design?', 'design!', 'design：twitter', 'designs', 'deep dive cache', 'opening kit', '', '   ', null, undefined]) {
        it(`${JSON.stringify(text)} is not a fixed word`, () => assert.equal(parseFixedWord(text), null));
    }
});

describe('resolveLiveRequest (18.11 rules 1 and 2)', () => {
    it('rule 1: an empty send with no kit asks for the opening kit', () => {
        assert.deepEqual(resolveLiveRequest('', null), { send: 'opening', kitRequest: 'opening' });
        assert.deepEqual(resolveLiveRequest('   ', null), { send: 'opening', kitRequest: 'opening' });
        assert.deepEqual(resolveLiveRequest(undefined, null), { send: 'opening', kitRequest: 'opening' });
    });
    it('rule 1: an empty send after an opening kit asks for the design kit', () => {
        assert.deepEqual(resolveLiveRequest('', 'opening'), { send: 'design', kitRequest: 'design' });
    });
    it('rule 1: an empty send after a design kit sends nothing and gives the hint', () => {
        assert.deepEqual(resolveLiveRequest('', 'design'), { hint: HINT_DESIGN_DONE });
    });
    for (const kit of [null, 'opening', 'design']) {
        it(`rule 2: fixed words are sent as fixed requests, kit=${kit}`, () => {
            assert.deepEqual(resolveLiveRequest('opening', kit), { send: 'opening', kitRequest: 'opening' });
            assert.deepEqual(resolveLiveRequest('Opening: Uber', kit), { send: 'opening: Uber', kitRequest: 'opening' });
            assert.deepEqual(resolveLiveRequest('design.', kit), { send: 'design', kitRequest: 'design' });
            assert.deepEqual(resolveLiveRequest('NEXT', kit), { send: 'next', kitRequest: 'design' });
            assert.deepEqual(resolveLiveRequest('design: twitter, 10M DAU', kit), { send: 'design: twitter, 10M DAU', kitRequest: 'design' });
            assert.deepEqual(resolveLiveRequest('full', kit), { send: 'full', kitRequest: 'design' });
        });
    }
    it('rule 2: other text with no kit asks for the opening kit of exactly that text', () => {
        assert.deepEqual(resolveLiveRequest('twitter', null), { send: 'opening: twitter', kitRequest: 'opening' });
        assert.deepEqual(resolveLiveRequest('design twitter feed', null), { send: 'opening: design twitter feed', kitRequest: 'opening' });
        assert.deepEqual(resolveLiveRequest(' twitter, 10M DAU, US only ', null), { send: 'opening: twitter, 10M DAU, US only', kitRequest: 'opening' });
    });
    it('rule 2: other text with a kit goes as typed, and is not a kit request', () => {
        assert.deepEqual(resolveLiveRequest('deep dive cache', 'design'), { send: 'deep dive cache', kitRequest: null });
        assert.deepEqual(resolveLiveRequest('what if redis goes down?', 'opening'), { send: 'what if redis goes down?', kitRequest: null });
        assert.deepEqual(resolveLiveRequest('uber', 'design'), { send: 'uber', kitRequest: null });
    });
});

describe('classifyKitAnswer (18.11 rule 5)', () => {
    it('the headings decide when recognized: Requirements used is a design kit', () => {
        assert.equal(classifyKitAnswer(DESIGN_KIT, 'opening'), 'design');
        assert.equal(classifyKitAnswer(DESIGN_KIT, null), 'design');
        assert.equal(classifyKitAnswer(`${OPENING_KIT}\n${DESIGN_KIT}`, 'design'), 'design', 'full: both kits');
    });
    it('Frame alone is an opening kit, also for a design request', () => {
        assert.equal(classifyKitAnswer(OPENING_KIT, 'design'), 'opening');
        assert.equal(classifyKitAnswer(OPENING_KIT, null), 'opening');
    });
    it('with no heading, a kit request of at least 120 words is stored as the kit it asked for', () => {
        const bold = `**Frame**\n${words(KIT_MIN_WORDS)}`;
        assert.equal(classifyKitAnswer(bold, 'opening'), 'opening');
        assert.equal(classifyKitAnswer(words(KIT_MIN_WORDS), 'design'), 'design');
        assert.equal(classifyKitAnswer(words(KIT_MIN_WORDS - 1), 'design'), null);
    });
    it('with no heading, other requests are never stored', () => {
        assert.equal(classifyKitAnswer(words(400), null), null);
    });
    it('the "No problem yet" line is never stored, in either language', () => {
        assert.equal(classifyKitAnswer("No problem yet. Type the system to design (e.g. 'design a URL shortener'), or 'design' once the requirements are agreed.", 'opening'), null);
        assert.equal(classifyKitAnswer("Nenhum problema ainda. Digite o sistema a projetar (por exemplo, 'design a URL shortener'), ou 'design' quando os requisitos estiverem combinados.", 'design'), null);
    });
    it('empty answers are never stored', () => {
        assert.equal(classifyKitAnswer('', 'design'), null);
        assert.equal(classifyKitAnswer(null, 'opening'), null);
    });
    it('counts words with a letter or a digit', () => {
        assert.equal(wordCount('a - b | 10M —'), 3);
    });
});

describe('kitExcerpt (18.11 rule 7)', () => {
    it('keeps Requirements used, the Decisions line, the Storage table and the Pick lines', () => {
        const ex = kitExcerpt(DESIGN_KIT);
        assert.match(ex, /^## Requirements used\n- Scope: posting, following, home timeline \(confirmed\)\n- Scale: 10M daily users, US only \(confirmed\)/);
        assert.match(ex, /\*\*Decisions:\*\* push fan-out for normal accounts/);
        assert.match(ex, /Storage:\n\| Entity \| Store \| Key \| Why \|\n\|---\|---\|---\|---\|\n\| Post \| Cassandra \| post_id \| heavy writes by key \|\n\| Timeline \| Redis \| user_id \| fast reads \|/);
        assert.match(ex, /Deep dives:\n- \*\*Pick:\*\* hybrid fan-out; costs a merge at read time\.\n- \*\*Pick:\*\* replicas per shard; costs memory\./);
        assert.doesNotMatch(ex, /POST \/v1\/posts|Write path|Check against/);
    });
    it('falls back to the kit cut at a line break when it has none of the expected parts', () => {
        const long = Array.from({ length: 200 }, (_, i) => `line ${i} of a kit with other headings`).join('\n');
        const ex = kitExcerpt(long);
        assert.ok(ex.length <= EXCERPT_MAX_CHARS + 20, `${ex.length}`);
        assert.match(ex, /\n\[… cut\]$/);
        assert.equal(kitExcerpt('short kit'), 'short kit');
    });
    it('reads CRLF kits', () => {
        assert.match(kitExcerpt(DESIGN_KIT.replace(/\n/g, '\r\n')), /\*\*Decisions:\*\*/);
    });
});


describe('the state (createLiveDesign)', () => {
    it('keeps the Ask mode, coerced like settings', () => {
        const s = createLiveDesign();
        assert.equal(s.getAskMode(), 'default');
        assert.equal(s.isSdLive(), false);
        s.setAskMode('system_design_live');
        assert.equal(s.isSdLive(), true);
        s.setAskMode('nonsense');
        assert.equal(s.getAskMode(), 'default');
    });
    it('keeps one kit, the latest, for its session only', () => {
        const s = createLiveDesign();
        assert.equal(s.getKit('a'), null);
        s.storeKit({ sessionId: 'a', kind: 'opening', question: ' opening ', answer: OPENING_KIT });
        assert.equal(s.getKit('a').kind, 'opening');
        assert.equal(s.getKit('a').question, 'opening');
        assert.equal(s.getKit('a').excerpt, null, 'only a design kit gets an excerpt');
        assert.equal(s.getKit('b'), null);
        s.storeKit({ sessionId: 'a', kind: 'design', question: 'design', answer: DESIGN_KIT });
        assert.equal(s.getKit('a').kind, 'design');
        assert.match(s.getKit('a').excerpt, /Decisions/);
        s.storeKit({ sessionId: 'b', kind: 'opening', question: 'opening: uber', answer: OPENING_KIT });
        assert.equal(s.getKit('a'), null, 'one slot: the other session\'s kit replaced it');
        s.reset();
        assert.equal(s.getKit('b'), null);
        assert.equal(s.getAskMode(), 'default');
    });
});

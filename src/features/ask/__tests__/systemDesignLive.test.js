/**
 * systemDesignLive.test.js
 *
 * Ask mode System Design · Live (system_design_live, future-work item 16): its
 * own profile, the transcript and the previous kit in its prompt, and nothing
 * changed for the other modes. Also the System Design profile's fixes (item 17).
 *
 * Run: node --test src/features/ask/__tests__/systemDesignLive.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildAskMessages, formatConversationForAsk, normalizeAskMode, isLiveDesignKit, PREVIOUS_ANSWER_MAX_CHARS } = require('../askPrompt');
const { LIVE_OPENING_SECTIONS, LIVE_DESIGN_SECTIONS } = require('../../../../scripts/live-eval/checks');

const HISTORY = formatConversationForAsk(['them: assume 10 million daily users, all in the US', 'me: got it']);
const PREVIOUS = { question: 'design', answer: '## Requirements used\n- 10M daily users (confirmed)\n## Deep dives\n- celebrity fan-out' };

function build(askMode, previousAnswer = null) {
    return buildAskMessages({ askMode, userPrompt: 'what if the cache goes down?', conversationHistory: HISTORY, screenshotBase64: null, previousAnswer });
}

describe('System Design · Live mode', () => {
    it('is a mode of its own, with its own profile', () => {
        assert.equal(normalizeAskMode('system_design_live'), 'system_design_live');
        const built = build('system_design_live');
        assert.equal(built.askMode, 'system_design_live');
        assert.equal(built.profile, 'pickle_glass_system_design_live');
    });

    it('puts the transcript, then the previous answer, in the prompt', () => {
        const { systemPrompt } = build('system_design_live', PREVIOUS);
        const transcript = systemPrompt.indexOf('Transcript:\nthem: assume 10 million daily users');
        const previous = systemPrompt.indexOf('Previous answer (your last answer in this mode, in this interview):\nRequest: design\n## Requirements used');
        assert.ok(transcript > 0, 'transcript missing');
        assert.ok(previous > transcript, 'previous answer missing or before the transcript');
    });

    it('has no previous-answer block when there is none', () => {
        assert.doesNotMatch(build('system_design_live').systemPrompt, /Previous answer \(your last answer/);
        assert.doesNotMatch(build('system_design_live', { question: 'x', answer: '' }).systemPrompt, /Previous answer \(your last answer/);
    });

    it('names a screenshot-only request', () => {
        assert.match(build('system_design_live', { question: '  ', answer: '## Frame\n> hi' }).systemPrompt, /Request: \(screenshot only\)\n## Frame/);
    });

    it('cuts a long previous answer at a line break', () => {
        const line = `${'x'.repeat(99)}\n`;
        const answer = `## Requirements used\n${line.repeat(100)}`;
        const { systemPrompt } = build('system_design_live', { question: 'design', answer });
        const block = systemPrompt.slice(systemPrompt.indexOf('Request: design\n') + 'Request: design\n'.length);
        const kept = block.slice(0, block.indexOf('\n[… cut]'));
        assert.ok(kept.length <= PREVIOUS_ANSWER_MAX_CHARS, `${kept.length} chars kept`);
        assert.ok(kept.length > PREVIOUS_ANSWER_MAX_CHARS - 100, `${kept.length} chars kept`);
        assert.ok(kept.endsWith('x'), 'cut inside a line');
    });

    for (const mode of ['default', 'code', 'debug', 'system_design']) {
        it(`mode ${mode} ignores the previous answer`, () => {
            assert.deepEqual(build(mode, PREVIOUS), build(mode));
        });
    }
});

describe('isLiveDesignKit', () => {
    it('is true for the opening, design and full answers', () => {
        assert.equal(isLiveDesignKit('## Frame\n> Let me make sure I have it'), true);
        assert.equal(isLiveDesignKit('## Requirements used\n- 10M (confirmed)'), true);
        assert.equal(isLiveDesignKit('## Frame\n…\n## Requirements used\n…'), true);
    });

    it('is false for a deep dive, a probe or nothing', () => {
        assert.equal(isLiveDesignKit('## Deep dive: fan-out\n- **Problem:** …'), false);
        assert.equal(isLiveDesignKit('Serve the last cached page and rebuild in the background.\n- …'), false);
        assert.equal(isLiveDesignKit(''), false);
        assert.equal(isLiveDesignKit(null), false);
    });
});

describe('pickle_glass_system_design_live prompt', () => {
    const prompt = build('system_design_live').systemPrompt;

    it('names its five routes', () => {
        for (const route of ['**PROBE**', '**DEEP DIVE**', '**FULL**', '**DESIGN**', '**OPENING**']) {
            assert.ok(prompt.includes(route), `${route} missing`);
        }
    });

    it('reads a bare system name as a problem, whatever the screen shows', () => {
        // A typed "twitter" with only a desktop on screen once got "No problem yet" (2026-10-31).
        assert.match(prompt, /or just "twitter": a product or system name typed on its own means "design it"/);
        assert.match(prompt, /A screenshot with no problem on it \(a desktop, an editor, other apps\) adds nothing and never cancels a system named in the typed text/);
        assert.match(prompt, /6\. Only when the typed text is empty or names no product or system, AND neither the transcript nor the screenshot names one/);
    });

    it('spells the kit headings the live eval checks, in order', () => {
        for (const names of [LIVE_OPENING_SECTIONS, LIVE_DESIGN_SECTIONS]) {
            let from = 0;
            for (const name of names) {
                const at = prompt.indexOf(`\n## ${name}\n`, from);
                assert.ok(at >= 0, `"## ${name}" missing or out of order`);
                from = at + 1;
            }
        }
        assert.ok(prompt.includes('"## Deep dive: <topic>"'));
    });

    it('carries the corrected estimation defaults', () => {
        assert.match(prompt, /image metadata < 1 KB/);
        assert.match(prompt, /Never multiply by items per page twice/);
        assert.match(prompt, /Fan-out on write = writes\/s × average followers/);
    });
});

describe('the System Design profile', () => {
    // Item 16 kept this profile byte-identical; item 17 (2026-11-01) fixed it in place,
    // keeping its flow: one Ask, the twelve sections, Rule B for a deep dive.
    const prompt = build('system_design').systemPrompt;

    it('keeps its twelve sections, in order', () => {
        let from = 0;
        for (let i = 0; i < 12; i++) {
            const at = prompt.indexOf(`\n## ${i}. `, from);
            assert.ok(at >= 0, `"## ${i}." missing or out of order`);
            from = at + 1;
        }
    });

    it('has no placeholder for a prior turn and no stale text', () => {
        assert.doesNotMatch(prompt, /see prior turn/);
        assert.doesNotMatch(prompt, /Rule C/);
        assert.doesNotMatch(prompt, /100 KB image-meta/);
        assert.doesNotMatch(prompt, /as if the interviewer just confirmed them/);
        assert.doesNotMatch(prompt, /Opening 30s pitch/);
    });

    it('uses typed constraints as given and marks the rest as assumed', () => {
        assert.match(prompt, /twitter, 10M DAU, feed only/);
        assert.match(prompt, /\(given\)/);
        assert.match(prompt, /\(assumed\)/);
    });

    it('carries the corrected estimation rules', () => {
        assert.match(prompt, /image metadata < 1 KB/);
        assert.match(prompt, /Never multiply by items per page twice/);
        assert.match(prompt, /Fan-out writes\/s = writes\/s × average followers/);
        assert.match(prompt, /Egress = read requests\/s × response size, counted once/);
    });

    it('keeps the sections consistent with each other', () => {
        assert.match(prompt, /the first line of the answer is "## 0\. Opening Pitch"/);
        assert.match(prompt, /never contradict the Trade-off Roll-up/);
        assert.match(prompt, /appears in the Phase 1 diagram or a Phase 2 delta/);
    });

    it('answers a deep dive alone, under its own heading', () => {
        assert.match(prompt, /## Deep dive: <target>/);
    });
});

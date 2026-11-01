/**
 * systemDesignLive.test.js
 *
 * Ask mode System Design · Live (system_design_live, future-work item 16): its
 * own profile, the transcript and the previous kit in its prompt, and nothing
 * changed for the other modes, the System Design profile included.
 *
 * Run: node --test src/features/ask/__tests__/systemDesignLive.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { profilePrompts } = require('../../common/prompts/promptTemplates');
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
    it('is unchanged', () => {
        // sha256 of the profile on main before System Design · Live was added.
        const hash = crypto.createHash('sha256').update(JSON.stringify(profilePrompts.pickle_glass_system_design)).digest('hex');
        assert.equal(hash, '33e5024f8835fa5d42266ac21f03e8971ccf77ff5d1e6d6fb99597f0661b17be');
    });
});

/**
 * askPrompt.test.js
 *
 * buildAskMessages builds the same messages askService.sendMessage built
 * inline before the live eval (scripts/live-eval) needed them outside the
 * service. TODAY below is that inline code, copied verbatim; every mode, with
 * and without a screenshot, must match it byte for byte.
 *
 * Run: node --test src/features/ask/__tests__/askPrompt.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { getSystemPrompt } = require('../../common/prompts/promptBuilder');
const { buildAskMessages, formatConversationForAsk, normalizeAskMode } = require('../askPrompt');

// askService.sendMessage before askPrompt.js, with currentSettings.askMode as
// rawMode and currentSettings.preferredCodeLanguage as preferred.
function TODAY(rawMode, preferred, userPrompt, conversationHistory, screenshotBase64) {
    const VALID_MODES = ['default', 'code', 'debug', 'system_design'];
    const askMode = VALID_MODES.includes(rawMode) ? rawMode : 'default';
    const PROFILE_BY_MODE = {
        default: 'pickle_glass_analysis',
        code: 'pickle_glass_code',
        debug: 'pickle_glass_debug',
        system_design: 'pickle_glass_system_design',
    };
    const profile = PROFILE_BY_MODE[askMode];
    let language = '';
    if (askMode === 'code') {
        language = (preferred || '').trim();
    }
    let systemPrompt;
    if (askMode === 'code') {
        const base = getSystemPrompt(profile, conversationHistory, false);
        systemPrompt = base.replace('{{PREFERRED_LANGUAGE}}', language || '__INFER_FROM_SCREENSHOT__');
    } else {
        systemPrompt = getSystemPrompt(profile, conversationHistory, false);
    }
    const messages = [
        { role: 'system', content: systemPrompt },
        {
            role: 'user',
            content: [
                { type: 'text', text: `User Request: ${userPrompt.trim()}` },
            ],
        },
    ];
    if (screenshotBase64) {
        messages[1].content.push({
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${screenshotBase64}` },
        });
    }
    return { askMode, profile, systemPrompt, messages };
}

const HISTORY = formatConversationForAsk(['them: how would you shard this table?', 'me: by tenant id']);
const IMAGE = Buffer.from('not really a jpeg').toString('base64');

describe('buildAskMessages', () => {
    for (const mode of ['default', 'code', 'debug', 'system_design', 'bogus', undefined]) {
        for (const image of [IMAGE, null]) {
            for (const preferred of ['go', '  python  ', '', undefined]) {
                it(`mode=${mode} image=${!!image} language=${JSON.stringify(preferred)} matches today`, () => {
                    const got = buildAskMessages({
                        askMode: mode,
                        userPrompt: '  solve this  ',
                        conversationHistory: HISTORY,
                        preferredCodeLanguage: preferred,
                        screenshotBase64: image,
                    });
                    assert.deepEqual(got, TODAY(mode, preferred, '  solve this  ', HISTORY, image));
                });
            }
        }
    }

    it('code mode names the language, or asks to infer it from the screenshot', () => {
        const named = buildAskMessages({ askMode: 'code', userPrompt: 'x', conversationHistory: HISTORY, preferredCodeLanguage: ' javascript ' });
        assert.match(named.systemPrompt, /Target language: javascript\n/);
        const inferred = buildAskMessages({ askMode: 'code', userPrompt: 'x', conversationHistory: HISTORY, preferredCodeLanguage: '' });
        assert.match(inferred.systemPrompt, /Target language: __INFER_FROM_SCREENSHOT__/);
    });

    it('an unknown mode reads as default', () => {
        assert.equal(normalizeAskMode('system-design'), 'default');
        assert.equal(normalizeAskMode('system_design'), 'system_design');
    });
});

describe('formatConversationForAsk', () => {
    it('keeps the last 30 turns', () => {
        const turns = Array.from({ length: 35 }, (_, i) => `them: q${i}`);
        const text = formatConversationForAsk(turns);
        assert.equal(text.split('\n').length, 30);
        assert.ok(text.startsWith('them: q5\n'));
    });

    it('says so when there is no conversation', () => {
        assert.equal(formatConversationForAsk([]), 'No conversation history available.');
        assert.equal(formatConversationForAsk(undefined), 'No conversation history available.');
    });
});

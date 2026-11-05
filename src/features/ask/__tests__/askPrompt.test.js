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
const { buildAskMessages, formatConversationForAsk, normalizeAskMode, askUserText } = require('../askPrompt');

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

describe('the interview\'s language in the user turn (18.11 rule 11, every mode)', () => {
    const SECTION_SENTENCE = 'The interview is in Portuguese: write the whole answer in Portuguese, whatever the language of the request, keeping technical terms as they are commonly said and the section headings exactly as given. Code, with its names and comments, stays in English.';

    for (const mode of ['default', 'code', 'debug', 'system_design']) {
        it(`${mode}: names the language after the request; the system prompt and the image are unchanged`, () => {
            const got = buildAskMessages({ askMode: mode, userPrompt: '', conversationHistory: formatConversationForAsk([]), preferredCodeLanguage: 'go', screenshotBase64: IMAGE, answerLanguage: 'pt' });
            const today = TODAY(mode, 'go', '', formatConversationForAsk([]), IMAGE);
            assert.equal(got.systemPrompt, today.systemPrompt);
            assert.equal(got.messages[1].content[0].text, `User Request: \n\n${SECTION_SENTENCE}`);
            assert.deepEqual(got.messages[1].content[1], today.messages[1].content[1]);
        });

        it(`${mode}: with no language, the messages of today`, () => {
            const got = buildAskMessages({ askMode: mode, userPrompt: 'x', conversationHistory: HISTORY, screenshotBase64: IMAGE, answerLanguage: null });
            assert.deepEqual(got, TODAY(mode, undefined, 'x', HISTORY, IMAGE));
        });
    }

    it('English names English', () => {
        assert.equal(askUserText('Resolva esse problema.', 'en', 'code'), 'User Request: Resolva esse problema.\n\nThe interview is in English: write the whole answer in English, whatever the language of the request, keeping technical terms as they are commonly said and the section headings exactly as given. Code, with its names and comments, stays in English.');
    });

    it('System Design · Live keeps its own sentence, byte for byte', () => {
        assert.equal(askUserText('design', 'pt', 'system_design_live'), 'User Request: design\n\nThe interview is in Portuguese: write the whole answer in Portuguese, whatever the language of the request, keeping technical terms as they are commonly said and the kit headings exactly as given.');
    });

    it('an unknown language adds nothing', () => {
        assert.equal(askUserText(' x ', 'fr', 'default'), 'User Request: x');
        assert.equal(askUserText('x'), 'User Request: x');
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

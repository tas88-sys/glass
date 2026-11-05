/**
 * askLanguage.test.js — phase L (the interview's language in every Ask mode):
 * each case names the language it expects the way askService would, the
 * comments the code-comment check reads, and the bug on the debug screen.
 *
 * Run: node --test scripts/live-eval/__tests__
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const c = require('../checks');
const { CASES } = require('../fixtures/ask-language-cases');
const liveCases = require('../fixtures/system-design-live-cases');
const { askAnswerLanguage } = require('../../../src/features/ask/askLanguage');
const { questionLanguage } = require('../../../src/features/listen/summary/questionLanguage');
const { VALID_MODES } = require('../../../src/features/ask/askPrompt');

describe('phase L cases', () => {
    it('each case expects the language askService names: its STT language', () => {
        for (const k of CASES) {
            assert.ok(k.sttLanguage, `${k.id}: no sttLanguage`);
            assert.deepEqual(askAnswerLanguage({ sttLanguage: k.sttLanguage }), { language: k.lang, source: 'stt' }, k.id);
        }
    });

    it('the interviewer speaks the STT language; the typed text of L1, L5 and L6 does not', () => {
        for (const k of CASES) {
            const them = k.history.filter(t => t.startsWith('them:')).join(' ');
            if (them) assert.equal(questionLanguage(them), k.lang, k.id);
        }
        for (const id of ['L1-default-pt', 'L5-code-en', 'L6-default-en']) {
            const k = CASES.find(x => x.id === id);
            assert.notEqual(questionLanguage(k.userPrompt), k.lang, id);
        }
        const twitter = CASES.find(x => x.id === 'L7-sd-live-twitter');
        assert.deepEqual([twitter.history, twitter.userPrompt, twitter.sttLanguage], [[], 'twitter', 'pt-BR']);
    });

    it('covers every Ask mode, in both languages, with a screen that exists', () => {
        assert.deepEqual([...new Set(CASES.map(k => k.mode))].sort(), [...VALID_MODES].sort());
        assert.deepEqual([...new Set(CASES.map(k => k.lang))].sort(), ['en', 'pt']);
        for (const k of CASES) assert.ok(fs.existsSync(path.join(__dirname, '..', 'fixtures', k.image)), `${k.id}: ${k.image}`);
    });

    it('phase H: the English interview names English, the Portuguese one Portuguese', () => {
        for (const k of liveCases.CASES) {
            const got = askAnswerLanguage({ sttLanguage: k.sttLanguage || liveCases.STT_LANGUAGE });
            assert.equal(got.language, k.lang || 'en', k.id);
        }
    });
});

describe('codeComments', () => {
    it('reads line comments and block comments inside the fenced blocks only', () => {
        const text = [
            'Explicação: o laço para cedo demais.',
            '```js',
            '/**',
            ' * Largest sum of k consecutive numbers.',
            ' */',
            'function windowMax(nums, k) { // sliding window',
            '    const url = "http://example.com"; /* a block comment after a URL */',
            '    return 0;',
            '}',
            '```',
            '```python',
            '# keep the running sum',
            'total = 0',
            '```',
        ].join('\n');
        assert.equal(c.codeComments(text), ['Largest sum of k consecutive numbers.', 'sliding window', 'a block comment after a URL', 'keep the running sum'].join('\n'));
    });

    it('a Portuguese comment reads as Portuguese, an English one as English', () => {
        assert.equal(c.detectLang(c.codeComments('```js\n// soma da janela de tamanho k, para não perder a última janela\nx();\n```')), 'pt');
        assert.equal(c.detectLang(c.codeComments('```js\n// the sum of the window of size k, so the last one is not lost\nx();\n```')), 'en');
        assert.equal(c.codeComments('no code here'), '');
    });

    it('the debug headings are the prompt\'s', () => {
        const { getSystemPrompt } = require('../../../src/features/common/prompts/promptBuilder');
        const prompt = getSystemPrompt('pickle_glass_debug', '', false);
        for (const h of c.DEBUG_SECTIONS) assert.ok(prompt.includes(`### ${h}`), h);
    });
});

describe('the debug screen (fixtures/debug-code.svg)', () => {
    // The function as drawn, and with the loop bound the check asks for.
    function windowMax(nums, k, fixed) {
        let sum = 0;
        for (let i = 0; i < k; i++) sum += nums[i];
        let best = sum;
        for (let i = k; i < (fixed ? nums.length : nums.length - 1); i++) {
            sum += nums[i] - nums[i - k];
            best = Math.max(best, sum);
        }
        return best;
    }

    it('fails the test on the screen as drawn, and passes both with i < nums.length', () => {
        assert.equal(windowMax([5, 1, 1, 1], 2, false), 6);
        assert.equal(windowMax([1, 2, 3, 4, 10], 2, false), 7);
        assert.equal(windowMax([1, 2, 3, 4, 10], 2, true), 14);
        assert.equal(windowMax([5, 1, 1, 1], 2, true), 6);
        const svg = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'debug-code.svg'), 'utf8');
        assert.ok(svg.includes('i = k; i &lt; nums.length - 1; i++'));
        assert.ok(svg.includes('expected: 14') && svg.includes('received: 7'));
    });
});

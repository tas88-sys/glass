'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { TECH_KEYTERMS, MAX_EXTRA_KEYTERMS, MAX_KEYTERMS, buildKeyterms } = require('../sttKeyterms');

describe('buildKeyterms', () => {
    it('without names, is the fixed technical list', () => {
        assert.deepEqual(buildKeyterms(), [...TECH_KEYTERMS]);
        assert.deepEqual(buildKeyterms('Orbit Pay'), [...TECH_KEYTERMS], 'a non-array is ignored');
        assert.ok(buildKeyterms().includes('LINQ'), 'the word the live eval heard as "link"');
    });

    it('puts the notes\' names first, trimmed, and drops case-insensitive repeats', () => {
        const out = buildKeyterms([' Orbit  Pay ', 'orbit pay', 'kafka', '', null, 42, 'Lumen Works']);
        assert.deepEqual(out.slice(0, 3), ['Orbit Pay', 'kafka', 'Lumen Works']);
        assert.ok(!out.includes('Kafka'), 'the fixed list does not repeat a name already there');
        assert.equal(out.length, TECH_KEYTERMS.length + 2);
    });

    it('drops overlong entries', () => {
        assert.ok(!buildKeyterms(['x'.repeat(41)]).some(t => t.length > 40));
    });

    it('caps the names so the fixed list still fits, and the total', () => {
        const many = Array.from({ length: 200 }, (_, i) => `Company ${i}`);
        const out = buildKeyterms(many);
        assert.equal(out.filter(t => t.startsWith('Company ')).length, MAX_EXTRA_KEYTERMS);
        for (const term of TECH_KEYTERMS) assert.ok(out.includes(term), `${term} cut by the names`);
        assert.ok(out.length <= MAX_KEYTERMS);
    });

    it('has the interview terms the STT heard as other words (future-work item 15)', () => {
        for (const term of ['API token', 'rate limit', 'rate limiter', 'unbuffered channel', 'Claude Code', 'CLAUDE.md', 'AI agent']) {
            assert.ok(TECH_KEYTERMS.includes(term), term);
        }
        assert.ok(!TECH_KEYTERMS.includes('AI'), '"AI" alone could pull "I" or "a" into it');
    });

    // Deepgram refuses a request whose keyterms pass 500 tokens. Its tokenizer is
    // not published: count one token per 3 characters of each term, rounded up.
    const tokens = terms => terms.reduce((n, t) => n + Math.ceil(t.length / 3), 0);

    it('stays under Deepgram\'s 500-token keyterm cap', () => {
        assert.ok(tokens(TECH_KEYTERMS) <= 150, `fixed list ~${tokens(TECH_KEYTERMS)} tokens`);
        const names = Array.from({ length: MAX_EXTRA_KEYTERMS }, (_, i) => `Company Name ${String(i).padStart(7, '0')}`);
        assert.equal(names[0].length, 20);
        const out = buildKeyterms(names);
        assert.ok(tokens(out) < 500, `fixed list and ${MAX_EXTRA_KEYTERMS} names ~${tokens(out)} tokens`);
    });
});

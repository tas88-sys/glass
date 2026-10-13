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
        assert.ok(out.includes('LINQ'));
        assert.ok(out.length <= MAX_KEYTERMS);
    });
});

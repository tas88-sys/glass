/**
 * answerCheck.test.js — T031 (FR-021; E37, E38)
 *
 * Run: node --test src/features/common/career/__tests__/answerCheck.test.js
 *
 * Fixtures are invented text only (spec C5).
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { findUnsupported } = require('../answerCheck');

describe('findUnsupported: numbers (FR-021)', () => {
    it('flags a number the given text lacks and passes one it contains', () => {
        const given = 'The harbor team grew 35 percent in 2021.';
        assert.deepEqual(findUnsupported('We grew 35% in 2021.', given), []);
        assert.deepEqual(findUnsupported('We grew 36% in 2020.', given), ['36%', '2020']);
    });

    it('compares by value across thousands and decimal separators', () => {
        assert.deepEqual(findUnsupported('1000 ships, 1.000 ships, 1,000 ships', 'We logged 1,000 ships.'), []);
        assert.deepEqual(findUnsupported('Latency fell to 3.5 s.', 'A latência caiu para 3,5 s.'), []);
        assert.deepEqual(findUnsupported('Latency fell to 3.6 s.', 'A latência caiu para 3,5 s.'), ['3.6']);
    });

    it('expands k, mil, M and milhões on both sides', () => {
        assert.deepEqual(findUnsupported('About 10k tides a day.', 'Cerca de 10 mil marés por dia.'), []);
        assert.deepEqual(findUnsupported('About 10,000 tides a day.', 'About 10k tides a day.'), []);
        assert.deepEqual(findUnsupported('Served 2M readers.', 'Atendia 2 milhões de leitores.'), []);
        assert.deepEqual(findUnsupported('Served 2 million readers.', 'Served 2M readers.'), []);
        assert.deepEqual(findUnsupported('Served 3M readers.', 'Served 2M readers.'), ['3M']);
    });

    it('skips numbers glued to letters and list markers (E38)', () => {
        assert.deepEqual(findUnsupported('Ran on EC2 and K8s with OAuth2.', ''), []);
        assert.deepEqual(findUnsupported('1. First point\n2) Second point', ''), []);
        assert.deepEqual(findUnsupported('- led a team of 6', ''), ['6']);
    });

    it('treats a version-like number as one token', () => {
        assert.deepEqual(findUnsupported('Upgraded to 4.2.0.', 'Release 4.2.0 shipped.'), []);
        assert.deepEqual(findUnsupported('Upgraded to 4.3.0.', 'Release 4.2.0 shipped.'), ['4.3.0']);
    });
});

describe('findUnsupported: known names (FR-021)', () => {
    const names = ['Bridge', 'Harbor Co'];

    it('flags a known name the given text lacks', () => {
        assert.deepEqual(findUnsupported('At Harbor Co I led the beacon rewrite.', 'Notes about beacons.', names), ['Harbor Co']);
        assert.deepEqual(findUnsupported('At Harbor Co I led the beacon rewrite.', 'Harbor Co: beacon rewrite.', names), []);
    });

    it('matches the manifest casing in the answer, so an ordinary word is not a company (E37)', () => {
        assert.deepEqual(findUnsupported('We can bridge that gap.', '', names), []);
        assert.deepEqual(findUnsupported('At Bridge we shipped weekly.', '', names), ['Bridge']);
    });

    it('accepts the name in any casing in the given text', () => {
        assert.deepEqual(findUnsupported('At Bridge we shipped weekly.', 'them: here at bridge we ship weekly', names), []);
    });

    it('a shorter name inside a longer one is the same mention', () => {
        const both = ['Lumen', 'Lumen Works'];
        assert.deepEqual(findUnsupported('At Lumen Works I built lanterns.', '', both), ['Lumen Works']);
        assert.deepEqual(findUnsupported('At Lumen Works I built lanterns.', 'Lumen Works lanterns', both), []);
        assert.deepEqual(findUnsupported('Lumen Works, later Lumen alone.', '', both), ['Lumen Works', 'Lumen']);
    });

    it('ignores names outside the known list', () => {
        assert.deepEqual(findUnsupported('At Gullwing Labs I led the rewrite.', '', names), []);
    });
});

describe('findUnsupported: output', () => {
    it('lists findings in answer order, once each', () => {
        assert.deepEqual(findUnsupported('40% at Bridge, then 40% again and 7 releases.', '', ['Bridge']), ['40%', 'Bridge', '7']);
    });

    it('never throws on bad input', () => {
        assert.deepEqual(findUnsupported(null, 'x'), []);
        assert.deepEqual(findUnsupported('', 'x'), []);
        assert.deepEqual(findUnsupported('Grew 35%.', null), ['35%']);
        assert.deepEqual(findUnsupported('At Bridge.', '', 'Bridge'), []);
        assert.deepEqual(findUnsupported('At Bridge.', '', [null, '', 'Bridge']), ['Bridge']);
    });
});

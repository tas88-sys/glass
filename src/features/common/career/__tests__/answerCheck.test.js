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

describe('findUnsupported: technical constants (future-work item 14)', () => {
    it('skips an HTTP status next to an HTTP word', () => {
        assert.deepEqual(findUnsupported('The retry queue avoids 429 errors.', ''), []);
        assert.deepEqual(findUnsupported('It answered status 404, then HTTP 500.', ''), []);
        assert.deepEqual(findUnsupported('It returns a 503 response while draining.', ''), []);
        assert.deepEqual(findUnsupported('A falha vira erro 502 no gateway.', ''), []);
    });

    it('still marks a 3-digit number with no HTTP word near it', () => {
        assert.deepEqual(findUnsupported('The query returned 200 rows.', ''), ['200']);
    });

    it('skips a bare number inside an example', () => {
        assert.deepEqual(findUnsupported('Block large reviews (e.g., > 300 lines) without tests.', ''), []);
        assert.deepEqual(findUnsupported('Guarde em micros, por exemplo, 1/1.000 de centavo.', ''), []);
        assert.deepEqual(findUnsupported('Pick a small batch, for example 64 rows.', ''), []);
    });

    it('a constant repeated later in the answer stays a constant, but not as a percentage', () => {
        assert.deepEqual(findUnsupported('Store micros, e.g., 1/1.000 of a cent. Read it back dividing by 1.000.', ''), []);
        assert.deepEqual(findUnsupported('A cap, e.g. 40 rows. Coverage rose 40%.', ''), ['40%']);
    });

    it('an example ends at the sentence end', () => {
        assert.deepEqual(findUnsupported('Use a cap, e.g. a queue. We ran 40 lanterns.', ''), ['40']);
        assert.deepEqual(findUnsupported('Use a cap (e.g. a queue) with 40 lanterns.', ''), ['40']);
    });

    it('marks percentages, money and durations, inside an example too', () => {
        assert.deepEqual(findUnsupported('We cut latency by 30%.', 'Latency fell.'), ['30%']);
        assert.deepEqual(findUnsupported('A goal, e.g., 30% fewer pages.', ''), ['30%']);
        assert.deepEqual(findUnsupported('A budget, e.g., R$ 2 mil a month.', ''), ['2 mil']);
        assert.deepEqual(findUnsupported('A target, e.g., 200 ms at p99.', ''), ['200']);
        assert.deepEqual(findUnsupported('Coverage, por exemplo 15‑20 % of cases.', ''), ['15', '20 %']);
    });

    it('reads a percentage written with a space', () => {
        assert.deepEqual(findUnsupported('It gave 50 % lower latency.', ''), ['50 %']);
        assert.deepEqual(findUnsupported('It gave 50 % lower latency.', ''), ['50 %']);
        assert.deepEqual(findUnsupported('It gave 50 % lower latency.', 'latency down 50%'), []);
    });

    it('the accepted cost: a count of errors next to "errors" is not checked', () => {
        assert.deepEqual(findUnsupported('We cut 500 errors a day.', ''), []);
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

describe('findUnsupported: neighborhood (future-work item 10b)', () => {
    const names = ['Lumen Works', 'Harbor Co'];
    const notes = [
        '[Results]',
        '- Lumen Works: cloud cost cut by 40%.',
        '- Lumen Works: deploy time down from 2 h to 30 min.',
        '## Harbor Co',
        '- ticket triage 25% faster',
        '- Side project: delivery 3 to 5 times faster.',
        '- Led 5 engineers.',
    ].join('\n');
    const check = (answer, conversation = '') => findUnsupported(answer, `${notes}\n${conversation}`, names, { notes });

    it('marks a number the notes give to another result at the same employer', () => {
        assert.deepEqual(check('At Lumen Works I cut ingestion time by 40%.'), ['40% (other result)']);
        assert.deepEqual(check('Na Lumen Works reduzi o tempo de ingestão em 40%.'), ['40% (other result)']);
    });

    it('passes the same number with the same result, in either language', () => {
        assert.deepEqual(check('At Lumen Works I cut cloud cost by 40%.'), []);
        assert.deepEqual(check('Na Lumen Works reduzi o custo de nuvem em 40%.'), []);
        assert.deepEqual(check('Deploys dropped to 30 min.'), []);
    });

    it('marks the same result told at another employer', () => {
        assert.deepEqual(check('At Harbor Co I cut cloud cost by 40%.'), ['40% (other result)']);
        assert.deepEqual(check('At Harbor Co ticket triage got 25% faster.'), []);
    });

    it('takes the employer from the heading above the note line', () => {
        assert.deepEqual(check('At Lumen Works ticket triage got 25% faster.'), ['25% (other result)']);
    });

    it('checks a multiplier, and a range start as the range', () => {
        assert.deepEqual(check('Data processing got 3-5x faster.'), ['3 (other result)', '5 (other result)']);
        assert.deepEqual(check('Delivery got 3 to 5x faster.'), []);
    });

    it('leaves a bare number to the presence check', () => {
        assert.deepEqual(check('We ran 5 queue workers.'), []);
    });

    it('passes a number the question or transcript holds', () => {
        assert.deepEqual(check('At Lumen Works I cut ingestion time by 40%.', 'them: did ingestion drop 40%?'), []);
    });

    it('passes a number with nothing near it to compare', () => {
        assert.deepEqual(check('It came out 40% lower.'), []);
    });

    it('is off without the notes', () => {
        assert.deepEqual(findUnsupported('At Lumen Works I cut ingestion time by 40%.', notes, names), []);
    });
});

describe('findUnsupported: never-used technologies (future-work item 10b)', () => {
    const opts = { notUsed: ['Tidewire', 'Ferrous'] };
    const check = (answer, given = '') => findUnsupported(answer, given, ['Lumen Works'], opts);

    it('marks one claimed in the first person or at a known employer', () => {
        assert.deepEqual(check('I chose Tidewire for the event bus.'), ['Tidewire (never used)']);
        assert.deepEqual(check('Usei tidewire no projeto de filas.'), ['Tidewire (never used)']);
        assert.deepEqual(check('Lumen Works ran on Tidewire.', 'Lumen Works'), ['Tidewire (never used)']);
        assert.deepEqual(check('- At Lumen Works: migrei os serviços; cada um lia filas Tidewire.', 'Lumen Works'), ['Tidewire (never used)']);
    });

    it('passes a negated mention or one after "instead of"', () => {
        assert.deepEqual(check('I have never used Tidewire.'), []);
        assert.deepEqual(check("I haven't used Tidewire."), []);
        assert.deepEqual(check('Nunca usei Tidewire, só filas simples.'), []);
        assert.deepEqual(check('I picked a log store instead of Tidewire.'), []);
        assert.deepEqual(check('Usei filas em vez de Tidewire.'), []);
    });

    it('passes a general mention', () => {
        assert.deepEqual(check('Tidewire is a log-based broker.'), []);
    });

    it('marks it even when the given text names it (the addendum lists it)', () => {
        assert.deepEqual(check('I chose Tidewire.', 'The candidate has never used: Tidewire, Ferrous.'), ['Tidewire (never used)']);
    });

    it('lists each name once, in answer order', () => {
        assert.deepEqual(check('I used Ferrous. Then I chose Tidewire, and I kept Ferrous.'), ['Ferrous (never used)', 'Tidewire (never used)']);
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

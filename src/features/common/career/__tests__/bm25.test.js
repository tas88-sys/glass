/**
 * bm25.test.js — T012 (FR-008)
 *
 * Run: node --test src/features/common/career/__tests__/bm25.test.js
 *
 * Fixtures are invented text only (spec C5).
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { tokenize, foldAccents, slugify, normalizeForMatch, stem } = require('../textNormalize');
const { buildBm25, BM25_PARAMS } = require('../bm25');

const chunk = (title, body, extra = {}) => ({
    id: title, path: `${title}.md`, title, body, companies: [], date: 0, kind: 'section', hash: title, ...extra,
});

describe('textNormalize', () => {
    it('folds accents and lowercases', () => {
        assert.equal(foldAccents('Migração Ágil à noite'), 'Migracao Agil a noite');
        assert.deepEqual(tokenize('MIGRAÇÃO'), tokenize('migracao'));
    });

    it('removes English and Portuguese stopwords', () => {
        assert.deepEqual(tokenize('the and of you your with'), []);
        assert.deepEqual(tokenize('o a de que você não para com'), []);
    });

    it('keeps short technical terms and numbers', () => {
        const t = tokenize('Go and AI on k8s, 2019, 99%');
        assert.ok(t.includes('go'));
        assert.ok(t.includes('ai'));
        assert.ok(t.includes('k8s'));
        assert.ok(t.includes('2019'));
        assert.ok(t.includes('99'));
    });

    it('stems lightly so inflections meet', () => {
        assert.equal(stem('migrations'), stem('migration'));
        assert.equal(stem('migrated'), stem('migrating'));
        assert.equal(stem('leaders'), stem('leading'));
        assert.equal(stem('services'), stem('service'));
        assert.equal(stem('processes'), stem('process'));
        assert.equal(stem('stories'), stem('story'));
        assert.equal(stem('times'), 'time');
        assert.equal(stem('status'), 'status');
        assert.equal(stem('projetos'), stem('projeto'));
        assert.equal(stem('decisoes'), stem('decisao'));
        assert.equal(stem('desenvolvimento'), stem('desenvolver'));
        assert.equal(stem('user'), 'user');
        assert.equal(stem('apis'), 'api');
    });

    it('slugify keeps alphanumerics only (FR-005)', () => {
        assert.equal(slugify('Café Labs'), 'cafelabs');
        assert.equal(slugify('A&B'), 'ab');
        assert.equal(slugify('  Orbit-Pay 2 '), 'orbitpay2');
    });

    it('normalizeForMatch folds, lowercases, expands contractions and drops punctuation', () => {
        assert.equal(normalizeForMatch("What's   your take? You've led it, didn't you?"),
            'what is your take you have led it did not you');
        assert.equal(normalizeForMatch('Você já liderou?'), 'voce ja liderou');
        assert.equal(normalizeForMatch('I can’t say'), 'i can not say');
    });

    it('drops the Portuguese filler "aí" but keeps "AI"', () => {
        assert.deepEqual(tokenize('e aí, o deploy funcionou?'), ['deploy', 'funcionou']);
        assert.deepEqual(tokenize('AI tools and ai agents'), ['ai', 'tool', 'ai', 'agent']);
        assert.deepEqual(tokenize('Aí a IA ajudou'), ['ia', 'ajudou']);
    });

    it('never throws on non-strings', () => {
        assert.deepEqual(tokenize(null), []);
        assert.deepEqual(tokenize(undefined), []);
        assert.equal(normalizeForMatch(42), '42');
    });
});

describe('buildBm25 / search', () => {
    const docs = [
        chunk('harbor › Foghorn repair', 'We replaced the foghorn and logged every storm.'),
        chunk('harbor › Gull census', 'Counting gulls on the pier each morning.'),
        chunk('harbor › Railing', 'The railing was repainted in spring; the foghorn stayed broken.'),
    ];

    it('ranks the chunk that matches the query first', () => {
        const idx = buildBm25(docs);
        const hits = idx.search(tokenize('gulls census'), 3);
        assert.equal(hits[0].idx, 1);
        assert.ok(hits[0].score > 0);
    });

    it('matches an unaccented query against accented text', () => {
        const idx = buildBm25([chunk('notas › Migração', 'A migração do sistema legado levou seis meses.'), chunk('x', 'nada a ver')]);
        const hits = idx.search(tokenize('migracao legado'), 2);
        assert.equal(hits.length, 1);
        assert.equal(hits[0].idx, 0);
    });

    it('weights the title (3) above the body (1)', () => {
        assert.equal(BM25_PARAMS.wTitle, 3);
        assert.equal(BM25_PARAMS.wBody, 1);
        const idx = buildBm25([
            chunk('notes › Misc', 'lantern lantern'),
            chunk('notes › Lantern', 'a short body'),
        ]);
        const hits = idx.search(tokenize('lantern'), 2);
        assert.equal(hits[0].idx, 1, 'title match outranks a doubled body match');
    });

    it('uses k1 = 1.2 and b = 0.75 by default', () => {
        assert.equal(BM25_PARAMS.k1, 1.2);
        assert.equal(BM25_PARAMS.b, 0.75);
    });

    it('reports matched and searched distinct terms', () => {
        const idx = buildBm25(docs);
        const hits = idx.search(tokenize('foghorn storm lighthouse'), 3);
        const top = hits[0];
        assert.equal(top.idx, 0);
        assert.equal(top.queryTerms, 3);
        assert.equal(top.matchedTerms, 2);
        const second = hits.find(h => h.idx === 2);
        assert.equal(second.matchedTerms, 1);
    });

    it('a repeated query term counts once in matchedTerms but boosts the score', () => {
        const idx = buildBm25(docs);
        const once = idx.search(['foghorn', 'gull'], 3);
        const boosted = idx.search(['foghorn', 'foghorn', 'gull'], 3);
        assert.equal(boosted[0].queryTerms, 2);
        const scoreOf = (hits, i) => hits.find(h => h.idx === i).score;
        assert.ok(scoreOf(boosted, 0) > scoreOf(once, 0));
        assert.equal(scoreOf(boosted, 1), scoreOf(once, 1));
    });

    it('orders ties by index (stable)', () => {
        const idx = buildBm25([chunk('a', 'beacon'), chunk('b', 'beacon'), chunk('c', 'beacon')]);
        assert.deepEqual(idx.search(['beacon'], 3).map(h => h.idx), [0, 1, 2]);
    });

    it('returns [] for an empty query, an unknown term or k <= 0', () => {
        const idx = buildBm25(docs);
        assert.deepEqual(idx.search([], 3), []);
        assert.deepEqual(idx.search(['zeppelin'], 3), []);
        assert.deepEqual(idx.search(['foghorn'], 0), []);
    });

    it('limits results to k', () => {
        const idx = buildBm25(docs);
        assert.equal(idx.search(tokenize('foghorn storm railing gulls'), 2).length, 2);
    });

    it('handles an empty corpus', () => {
        assert.deepEqual(buildBm25([]).search(['x'], 3), []);
    });
});

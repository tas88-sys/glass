/**
 * chunker.test.js — T010, T030 (FR-002, FR-003, FR-004, FR-005; E4, E6–E10, E29, E30)
 *
 * Run: node --test src/features/common/career/__tests__/chunker.test.js
 *
 * Fixtures are invented text only (spec C5): no real names, employers,
 * companies or numbers from any real knowledge base.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { chunkMarkdown, MAX_CHARS, MIN_CHARS } = require('../chunker');
const { globToRegExp, sanitizePatterns, compilePathFilter } = require('../globMatch');

const sha1 = s => crypto.createHash('sha1').update(s).digest('hex');
const opts = (extra = {}) => ({ mtime: 1000, companiesOf: () => [], ...extra });

// ~250-char invented paragraph, numbered so pieces can be told apart.
const para = n =>
    `Paragraph ${n} talks about the lighthouse keeper who logged every storm in a notebook, ` +
    `counted the gulls on the pier, repainted the railing each spring and wrote long letters ` +
    `to the harbor office about the broken foghorn that nobody fixed for years.`;
// Two paragraphs: long enough to stand alone above a subsection.
const intro = `${para(1)}\n\n${para(2)}`;

describe('chunkMarkdown: headings and breadcrumbs (FR-003)', () => {
    it('builds "file › H2 › H3" titles and skips the document H1', () => {
        const md = [
            '# Lighthouse notes',
            '',
            '## Storms',
            '',
            intro,
            '',
            '### Winter',
            '',
            'Winter storms were the worst.',
        ].join('\n');
        const chunks = chunkMarkdown('notes/lighthouse.md', md, opts());
        assert.deepEqual(chunks.map(c => c.title), [
            'lighthouse › Storms',
            'lighthouse › Storms › Winter',
        ]);
        assert.equal(chunks[0].body, intro);
        assert.equal(chunks[1].body, 'Winter storms were the worst.');
        assert.ok(chunks.every(c => c.kind === 'section'));
        assert.ok(chunks.every(c => c.path === 'notes/lighthouse.md'));
    });

    it('drops "{#anchor}" ids and emphasis from heading titles', () => {
        const md = '## 5. **Round one** {#round-1}\n\nText.';
        assert.equal(chunkMarkdown('x.md', md, opts())[0].title, 'x › 5. Round one');
    });

    it('a sibling H2 resets the H3 level', () => {
        const md = `## A\n\n${intro}\n\n### A1\n\nnested text\n\n## B\n\nbeta text`;
        const titles = chunkMarkdown('x.md', md, opts()).map(c => c.title);
        assert.deepEqual(titles, ['x › A', 'x › A › A1', 'x › B']);
    });

    it('a heading-less file uses the file label as its only breadcrumb (E8)', () => {
        const chunks = chunkMarkdown('plain/journal.txt', 'Just a line of text.\n\nAnd another.', opts());
        assert.equal(chunks.length, 1);
        assert.equal(chunks[0].title, 'journal');
        assert.equal(chunks[0].body, 'Just a line of text.\n\nAnd another.');
    });

    it('ignores "#" lines inside fenced code blocks', () => {
        const md = '## Setup\n\n```bash\n# not a heading\necho hi\n```\n\nAfter the fence.';
        const chunks = chunkMarkdown('x.md', md, opts());
        assert.equal(chunks.length, 1);
        assert.equal(chunks[0].title, 'x › Setup');
        assert.match(chunks[0].body, /# not a heading/);
        assert.match(chunks[0].body, /After the fence\./);
    });

    it('skips YAML frontmatter', () => {
        const md = '---\ntags: [a, b]\n---\n## Topic\n\nBody text.';
        const chunks = chunkMarkdown('x.md', md, opts());
        assert.deepEqual(chunks.map(c => c.title), ['x › Topic']);
        assert.equal(chunks[0].body, 'Body text.');
    });

    it('drops sections with an empty body', () => {
        const md = '## Empty\n\n---\n\n## Full\n\nSomething here.';
        const chunks = chunkMarkdown('x.md', md, opts());
        assert.deepEqual(chunks.map(c => c.title), ['x › Full']);
    });
});

describe('chunkMarkdown: Q-blocks (FR-003)', () => {
    it('makes one chunk per **Q: block with the Q line in the title', () => {
        const md = [
            '## Practice bank',
            '',
            intro,
            '',
            '**Q: How do you keep a flaky test from blocking a release?**',
            'Quarantine it behind a tag and open a ticket.',
            'Fix the root cause within the sprint.',
            '',
            '**Q: What is a good retry budget?**',
            'Small, with jitter.',
        ].join('\n');
        const chunks = chunkMarkdown('bank.md', md, opts());
        assert.deepEqual(chunks.map(c => [c.kind, c.title]), [
            ['section', 'bank › Practice bank'],
            ['qa', 'bank › Practice bank › How do you keep a flaky test from blocking a release?'],
            ['qa', 'bank › Practice bank › What is a good retry budget?'],
        ]);
        assert.equal(chunks[1].body, 'Quarantine it behind a tag and open a ticket.\nFix the root cause within the sprint.');
        assert.equal(chunks[2].body, 'Small, with jitter.');
    });

    it('accepts numbered Q lines and the "**Q:** text" form', () => {
        const md = [
            '## Round one',
            '**Q1. Tell me about the harbor project.**',
            'Answer one.',
            '**Q1a. Were you the lead?**',
            'Answer two.',
            '**Q3 (follow-up). Anything else?**',
            'Answer three.',
            '**Q:** Inline form?',
            'Answer four.',
        ].join('\n');
        const titles = chunkMarkdown('r.md', md, opts()).map(c => c.title);
        assert.deepEqual(titles, [
            'r › Round one › Tell me about the harbor project.',
            'r › Round one › Were you the lead?',
            'r › Round one › Anything else?',
            'r › Round one › Inline form?',
        ]);
    });

    it('does not treat bold words starting with Q as Q lines', () => {
        const md = '## Notes\n\n**Quarterly** goals were met.';
        const chunks = chunkMarkdown('n.md', md, opts());
        assert.equal(chunks.length, 1);
        assert.equal(chunks[0].kind, 'section');
    });
});

describe('chunkMarkdown: short intros (FR-003)', () => {
    it('moves a short body into the subsection right under it', () => {
        const md = [
            '## Q7. Tell me about a storm night.',
            '',
            '**Timing:** 30s read, 3 min talk',
            '',
            '### Beats',
            '',
            'Situation, task, action, result.',
            '',
            '### Full answer',
            '',
            'The foghorn failed at midnight.',
        ].join('\n');
        const chunks = chunkMarkdown('bank.md', md, opts());
        assert.deepEqual(chunks.map(c => c.title), [
            'bank › Q7. Tell me about a storm night. › Beats',
            'bank › Q7. Tell me about a storm night. › Full answer',
        ]);
        assert.equal(chunks[0].body, '**Timing:** 30s read, 3 min talk\n\nSituation, task, action, result.');
        assert.equal(chunks[1].body, 'The foghorn failed at midnight.');
    });

    it('carries down more than one level', () => {
        const md = '## A\n\none\n\n### B\n\ntwo\n\n#### C\n\nthree';
        assert.deepEqual(chunkMarkdown('x.md', md, opts()).map(c => [c.title, c.body]), [
            ['x › A › B › C', 'one\n\ntwo\n\nthree'],
        ]);
    });

    it('moves a short section intro into its first Q-block', () => {
        const md = '## Bank\n\nShort intro.\n\n**Q: First?**\nAnswer one.\n\n**Q: Second?**\nAnswer two.';
        assert.deepEqual(chunkMarkdown('b.md', md, opts()).map(c => [c.kind, c.title, c.body]), [
            ['qa', 'b › Bank › First?', 'Short intro.\n\nAnswer one.'],
            ['qa', 'b › Bank › Second?', 'Answer two.'],
        ]);
    });

    it('moves a short preamble into the first section', () => {
        const md = '> Date: spring.\n\n## A\n\nText.';
        assert.deepEqual(chunkMarkdown('x.md', md, opts()).map(c => [c.title, c.body]), [
            ['x › A', '> Date: spring.\n\nText.'],
        ]);
    });

    it('keeps a short section that has no subsection under it', () => {
        const md = '## A\n\nShort answer.\n\n## B\n\nAnother short answer.';
        assert.deepEqual(chunkMarkdown('x.md', md, opts()).map(c => [c.title, c.body]), [
            ['x › A', 'Short answer.'],
            ['x › B', 'Another short answer.'],
        ]);
    });

    it('keeps an intro of MIN_CHARS or more on its own', () => {
        const md = `## A\n\n${'word '.repeat(MIN_CHARS / 5).trim()}.\n\n### A1\n\nNested.`;
        assert.deepEqual(chunkMarkdown('x.md', md, opts()).map(c => c.title), ['x › A', 'x › A › A1']);
    });
});

describe('chunkMarkdown: unfinished markers (FR-004)', () => {
    it('drops a Q-block whose Q line carries a marker (E6)', () => {
        const md = [
            '## Bank',
            '**Q: Biggest storm logged? ⚠️ CONFIRMAR**',
            'Draft answer.',
            '**Q: Favorite season? [PREENCHER]**',
            'Draft answer.',
            '**Q: Best tool?**',
            'The brass telescope.',
        ].join('\n');
        const chunks = chunkMarkdown('b.md', md, opts());
        assert.deepEqual(chunks.map(c => c.title), ['b › Bank › Best tool?']);
    });

    it('drops a section, and its subsections, when the heading carries a marker', () => {
        const md = '## Numbers [PREENCHER]\n\nDraft.\n\n### Detail\n\nMore draft.\n\n## Clean\n\nFinal text.';
        const chunks = chunkMarkdown('n.md', md, opts());
        assert.deepEqual(chunks.map(c => c.title), ['n › Clean']);
    });

    it('removes only the marker line inside a body (E7)', () => {
        const md = '## Story\n\nFirst line stays.\nThis number is 99 ⚠️ CONFIRMAR\nLast line stays.';
        const chunks = chunkMarkdown('s.md', md, opts());
        assert.equal(chunks.length, 1);
        assert.equal(chunks[0].body, 'First line stays.\nLast line stays.');
    });

    it('drops a Q-block whose answer the notes flag with ⚠️, and keeps the correction', () => {
        const md = [
            '## Record',
            '**Q9. What do you think of our stance on remote work?**',
            '> Talked about tooling instead. ⚠️ (misheard, see below)',
            '**Q10. Favorite tool?**',
            '> The brass telescope.',
            '## Correction',
            'Remote work: say how the team keeps decisions written down.',
        ].join('\n');
        const chunks = chunkMarkdown('d.md', md, opts());
        assert.deepEqual(chunks.map(c => c.title), ['d › Record › Favorite tool?', 'd › Correction']);
    });

    it('keeps a section whose body has a ⚠️ note', () => {
        const md = '## Story\n\n⚠️ Careful: say the number once.\nThe pipeline cut the batch to 15 minutes.';
        assert.equal(chunkMarkdown('s.md', md, opts()).length, 1);
    });

    it('matches the marker with or without the emoji variation selector', () => {
        const md = '## S\n\nkeep\n⚠ CONFIRMAR this\nkeep too';
        assert.equal(chunkMarkdown('s.md', md, opts())[0].body, 'keep\nkeep too');
    });
});

describe('chunkMarkdown: size bounds (FR-003; E9, E10)', () => {
    it('splits a long section on paragraph boundaries and repeats the title (E9)', () => {
        const body = Array.from({ length: 12 }, (_, i) => para(i + 1)).join('\n\n');
        const chunks = chunkMarkdown('long.md', `## Keeper\n\n${body}`, opts());
        assert.ok(chunks.length >= 3, `expected several pieces, got ${chunks.length}`);
        for (const c of chunks) {
            assert.equal(c.title, 'long › Keeper');
            assert.ok(c.body.length <= MAX_CHARS, `piece too long: ${c.body.length}`);
            assert.ok(c.body.startsWith('Paragraph '), 'pieces start on a paragraph boundary');
        }
        for (const c of chunks.slice(0, -1)) assert.ok(c.body.length >= 300, `piece too short: ${c.body.length}`);
        // Nothing lost, nothing duplicated.
        const joined = chunks.map(c => c.body).join('\n\n');
        assert.equal(joined, body);
        assert.equal(new Set(chunks.map(c => c.id)).size, chunks.length, 'ids differ by ordinal');
    });

    it('splits a single paragraph over the cap on sentence boundaries (E10)', () => {
        const sentence = n => `Sentence ${n} describes the tide tables the keeper copied by hand every week.`;
        const body = Array.from({ length: 40 }, (_, i) => sentence(i + 1)).join(' ');
        assert.ok(body.length > MAX_CHARS);
        const chunks = chunkMarkdown('p.md', `## One paragraph\n\n${body}`, opts());
        assert.ok(chunks.length >= 2);
        for (const c of chunks) {
            assert.ok(c.body.length <= MAX_CHARS);
            assert.match(c.body, /^Sentence \d+/);
            assert.match(c.body, /every week\.$/);
        }
    });

    it('hard-splits a sentence longer than the cap at a word boundary', () => {
        const body = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
        const chunks = chunkMarkdown('w.md', `## Run-on\n\n${body}`, opts());
        assert.ok(chunks.length >= 2);
        for (const c of chunks) {
            assert.ok(c.body.length <= MAX_CHARS);
            assert.match(c.body, /^word\d+/);
        }
    });
});

describe('chunkMarkdown: tables (FR-003)', () => {
    const header = '| Tool | Notes |\n|---|:-:|';
    const rows = Array.from({ length: 60 }, (_, i) => `| tool ${i} | used for the tide tables in season ${i} |`);

    it('repeats the header row in every piece of a split table', () => {
        const chunks = chunkMarkdown('t.md', `## Tools\n\n${header}\n${rows.join('\n')}`, opts());
        assert.ok(chunks.length >= 2, `expected several pieces, got ${chunks.length}`);
        for (const c of chunks) {
            assert.ok(c.body.startsWith(`${header}\n| tool `), 'piece starts with the header');
            assert.ok(c.body.length <= MAX_CHARS, `piece too long: ${c.body.length}`);
        }
        assert.deepEqual(chunks.flatMap(c => c.body.split('\n').slice(2)), rows, 'every row once, in order');
    });

    it('repeats a caption line right above the table', () => {
        const chunks = chunkMarkdown('t.md', `## Tools\n\n**Inventory**\n${header}\n${rows.join('\n')}`, opts());
        assert.ok(chunks.length >= 2);
        for (const c of chunks) assert.ok(c.body.startsWith(`**Inventory**\n${header}\n`));
    });

    it('keeps the text around a split table', () => {
        const md = `## Tools\n\n${para(1)}\n\n${header}\n${rows.join('\n')}\n\n${para(2)}`;
        const chunks = chunkMarkdown('t.md', md, opts());
        const all = chunks.map(c => c.body).join('\n\n');
        assert.ok(all.includes(para(1)) && all.includes(para(2)));
        assert.ok(chunks.filter(c => c.body.includes('| tool ')).every(c => c.body.includes(header)));
    });

    it('leaves a table that fits untouched', () => {
        const small = `${header}\n${rows.slice(0, 3).join('\n')}`;
        assert.equal(chunkMarkdown('t.md', `## Tools\n\n${small}`, opts())[0].body, small);
    });
});

describe('chunkMarkdown: metadata (FR-005)', () => {
    it('copies the company set from companiesOf', () => {
        const chunks = chunkMarkdown('prep/bridge/why.md', '## Why\n\nBecause.', opts({
            companiesOf: p => (p.startsWith('prep/bridge/') ? ['Bridge'] : []),
        }));
        assert.deepEqual(chunks[0].companies, ['Bridge']);
    });

    it('defaults to an empty company set', () => {
        const chunks = chunkMarkdown('a.md', '## A\n\nText.', { mtime: 5 });
        assert.deepEqual(chunks[0].companies, []);
    });

    it('takes the date from YYYY-MM-DD or YYYY-MM in the file name, else mtime', () => {
        const md = '## A\n\nText.';
        assert.equal(chunkMarkdown('debrief-2025-03-14.md', md, opts())[0].date, Date.UTC(2025, 2, 14));
        assert.equal(chunkMarkdown('dir/prep-2024-11.md', md, opts())[0].date, Date.UTC(2024, 10, 1));
        assert.equal(chunkMarkdown('dir/notes.md', md, opts({ mtime: 4242 }))[0].date, 4242);
        assert.equal(chunkMarkdown('2025-13-01.md', md, opts({ mtime: 7 }))[0].date, 7, 'invalid month falls back');
    });

    it('gives stable ids (12 hex) and content hashes (sha1 of title + body)', () => {
        const md = '## A\n\nText one.\n\n## B\n\nText two.';
        const first = chunkMarkdown('s.md', md, opts());
        const second = chunkMarkdown('s.md', md, opts());
        assert.deepEqual(first.map(c => c.id), second.map(c => c.id));
        for (const c of first) {
            assert.match(c.id, /^[0-9a-f]{12}$/);
            assert.equal(c.hash, sha1(`${c.title}\n${c.body}`));
        }
        assert.notEqual(first[0].id, first[1].id);
        const moved = chunkMarkdown('other.md', md, opts());
        assert.notEqual(moved[0].id, first[0].id, 'path is part of the id');
    });

    it('never throws on bad input', () => {
        assert.deepEqual(chunkMarkdown('x.md', null, opts()), []);
        assert.deepEqual(chunkMarkdown('x.md', '', opts()), []);
        assert.doesNotThrow(() => chunkMarkdown('x.md', '## A\n\nB', { companiesOf: () => { throw new Error('x'); } }));
    });
});

describe('globToRegExp (C6)', () => {
    it('"*" stays within one segment', () => {
        const re = globToRegExp('*.md');
        assert.ok(re.test('a.md'));
        assert.ok(!re.test('dir/a.md'));
        assert.ok(!re.test('a.txt'));
    });

    it('"**/" matches zero or more directories', () => {
        const re = globToRegExp('**/*.md');
        assert.ok(re.test('a.md'));
        assert.ok(re.test('x/y/a.md'));
        assert.ok(!re.test('x/a.mdx'));
    });

    it('a trailing "/**" matches the folder and everything under it', () => {
        const re = globToRegExp('chats/**');
        assert.ok(re.test('chats'));
        assert.ok(re.test('chats/a.md'));
        assert.ok(re.test('chats/x/y.md'));
        assert.ok(!re.test('chatsx/a.md'));
        assert.ok(!re.test('other/chats/a.md'));
    });

    it('"**" in the middle spans directories', () => {
        const re = globToRegExp('notes/**/drill/**');
        assert.ok(re.test('notes/drill/a.md'));
        assert.ok(re.test('notes/x/y/drill/a.md'));
        assert.ok(!re.test('notes/x/a.md'));
    });

    it('"?" matches exactly one character in a segment', () => {
        const re = globToRegExp('notes/?.md');
        assert.ok(re.test('notes/a.md'));
        assert.ok(!re.test('notes/ab.md'));
        assert.ok(!re.test('notes//.md'));
    });

    it('escapes regex characters literally', () => {
        const re = globToRegExp('cv (final) + v2.md');
        assert.ok(re.test('cv (final) + v2.md'));
        assert.ok(!re.test('cv final  v2.md'));
    });
});

describe('sanitizePatterns + compilePathFilter (FR-002; E4)', () => {
    it('drops entries that escape the root, absolute paths and non-strings (E4)', () => {
        assert.deepEqual(
            sanitizePatterns(['../outside/**', 'a/../../b.md', '/abs/x.md', 'C:/x.md', 42, null, 'ok/*.md', '.\\win\\*.md', '  ']),
            ['ok/*.md', 'win/*.md'],
        );
        assert.deepEqual(sanitizePatterns('not-an-array'), []);
    });

    it('exclude wins over include', () => {
        const f = compilePathFilter(['**/*.md'], ['drafts/**', 'secret.md']);
        assert.ok(f.matchesFile('notes/a.md'));
        assert.ok(!f.matchesFile('drafts/a.md'));
        assert.ok(!f.matchesFile('secret.md'));
        assert.ok(!f.matchesFile('notes/a.txt'));
    });

    it('always excludes .git and node_modules', () => {
        const f = compilePathFilter(['**/*.md'], []);
        assert.ok(!f.matchesFile('.git/a.md'));
        assert.ok(!f.matchesFile('node_modules/pkg/readme.md'));
        assert.ok(!f.matchesFile('sub/node_modules/pkg/readme.md'));
        assert.ok(f.excludesDir('.git'));
        assert.ok(f.excludesDir('sub/node_modules'));
    });

    it('prunes excluded directories', () => {
        const f = compilePathFilter(['**/*.md'], ['drafts/**']);
        assert.ok(f.excludesDir('drafts'));
        assert.ok(f.excludesDir('drafts/old'));
        assert.ok(!f.excludesDir('notes'));
    });
});

/**
 * smd.test.js
 *
 * The streaming markdown parser the Ask window renders with (src/ui/assets/smd.js).
 * Local change of 2026-11-04: an underscore between letters or digits is text, as in
 * CommonMark. Before it, the design kit's `tweet_id` opened italics that ran to the
 * end of the line and broke the Storage table row (found in the System Design · Live
 * practice run, item 18.11).
 *
 * Every case is parsed twice, in one chunk and one character at a time, and both
 * trees must match: the Ask window gets the answer in pieces of any size.
 *
 * Run: node --test src/ui/assets/__tests__/smd.test.js
 */

'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let smd;
before(async () => {
    smd = await import(pathToFileURL(path.join(__dirname, '..', 'smd.js')).href);
});

/** Parses `text` into a compact tree string, e.g. Document(Paragraph("a",Italic_Und("b"))). */
function parse(text, oneCharAtATime) {
    const root = { t: 'Document', c: [] };
    const stack = [root];
    const renderer = {
        data: null,
        add_token(_d, type) {
            const node = { t: smd.token_to_string(type), c: [] };
            stack[stack.length - 1].c.push(node);
            stack.push(node);
        },
        end_token() { stack.pop(); },
        add_text(_d, s) {
            const c = stack[stack.length - 1].c;
            if (typeof c[c.length - 1] === 'string') c[c.length - 1] += s;
            else c.push(s);
        },
        set_attr() {},
    };
    const p = smd.parser(renderer);
    if (oneCharAtATime) for (const ch of text) smd.parser_write(p, ch);
    else smd.parser_write(p, text);
    smd.parser_end(p);
    const show = n => (typeof n === 'string' ? JSON.stringify(n) : `${n.t}(${n.c.map(show).join(',')})`);
    return show(root);
}

function expectTree(text, expected) {
    assert.equal(parse(text, false), expected, 'one chunk');
    assert.equal(parse(text, true), expected, 'one character at a time');
}

describe('smd.js: an underscore between letters or digits is text', () => {
    const literal = [
        'append tweet_id to each follower',
        'GET /feed?cursor=&limit= → {tweets[], next_cursor}',
        'user_id → tweet IDs',
        '1_000_000 writes',
        'ação_x',
        'hash_map',
    ];
    for (const text of literal) {
        it(`keeps ${JSON.stringify(text)} as it is`, () => {
            expectTree(text, `Document(Paragraph(${JSON.stringify(text)}))`);
        });
    }

    it('keeps it inside bold, inline code and link text', () => {
        expectTree('**user_id** `timeline:{user_id}` `a_`',
            'Document(Paragraph(Strong_Ast("user_id")," ",Code_Inline("timeline:{user_id}")," ",Code_Inline("a_")))');
        expectTree('[a_b](http://x.com/a_b)', 'Document(Paragraph(Link("a_b")))');
    });

    it('keeps it in a code fence and in the text after it', () => {
        expectTree('```\na_b\nx_\n```\nafter_it', 'Document(Code_Fence("a_b\\nx_"),Paragraph("after_it"))');
    });
});

describe('smd.js: emphasis that worked before still works', () => {
    it('_italic_, __bold__, *a* and **b**', () => {
        expectTree('_real italic_ and __bold__ *a* **b**',
            'Document(Paragraph(Italic_Und("real italic")," and ",Strong_Und("bold")," ",Italic_Ast("a")," ",Strong_Ast("b")))');
    });

    it('an underscore inside _..._ or __...__ before a letter does not end it', () => {
        expectTree('_a snake_case b_', 'Document(Paragraph(Italic_Und("a snake_case b")))');
        expectTree('__a snake_case b__', 'Document(Paragraph(Strong_Und("a snake_case b")))');
        expectTree('_foo _bar_', 'Document(Paragraph(Italic_Und("foo _bar")))');
    });

    it('an italic after a snake_case word still opens', () => {
        expectTree('snake_case then _this_', 'Document(Paragraph("snake_case then ",Italic_Und("this")))');
    });
});

describe('smd.js: the design kit Storage table (practice run, 2026-11-04)', () => {
    it('stays one table with four cells per row', () => {
        const kit =
            '- **Read path:** 1) Feed svc → Redis `GET timeline:{user}` → list of IDs.\n' +
            '- **Storage:**\n\n' +
            '| Entity | Store | Key | Why |\n' +
            '|---|---|---|---|\n' +
            '| tweet | SQL | tweet_id | strong consistency, relations |\n' +
            '| follow | SQL | (follower, followee) | edge lookups, transactions |\n' +
            '| timeline | Redis | user_id → tweet IDs | fast reads, capped list |\n' +
            '| image | Object storage | image_id | large blobs |\n\n' +
            '- **Decisions:** push fan-out for normal accounts.\n';
        const row = cells => `Table_Row(${cells.map(c => `Table_Cell(${JSON.stringify(` ${c} `)})`).join(',')})`;
        expectTree(kit,
            'Document(' +
            'List_Unordered(' +
            'List_Item(Strong_Ast("Read path:")," 1) Feed svc → Redis ",Code_Inline("GET timeline:{user}")," → list of IDs."),' +
            'List_Item(Strong_Ast("Storage:"))),' +
            'Table(' + [
                row(['Entity', 'Store', 'Key', 'Why']),
                row(['tweet', 'SQL', 'tweet_id', 'strong consistency, relations']),
                row(['follow', 'SQL', '(follower, followee)', 'edge lookups, transactions']),
                row(['timeline', 'Redis', 'user_id → tweet IDs', 'fast reads, capped list']),
                row(['image', 'Object storage', 'image_id', 'large blobs']),
            ].join(',') + '),' +
            'List_Unordered(List_Item(Strong_Ast("Decisions:")," push fan-out for normal accounts.")))');
    });
});

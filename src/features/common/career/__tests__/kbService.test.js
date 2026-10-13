/**
 * kbService.test.js — T018 (FR-001, FR-002, FR-004, FR-005, FR-011, FR-016, FR-017, FR-018;
 * E1–E5, E26, E29–E32, E34; C1)
 *
 * Run: node --test src/features/common/career/__tests__/kbService.test.js
 *
 * Builds a throwaway KB in a temp dir. Fixtures are invented text only (spec C5).
 */

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { createKbService, parseManifest } = require('../kbService');
const { createCareerModule } = require('../index');

const CARD = [
    '# Canonical facts',
    '- Twelve years building harbor software.',
    '- Weekly releases at the last job.',
    '- Team size 99 ⚠️ CONFIRMAR',
].join('\n');

const FILES = {
    'about/card.md': CARD,
    'stories/conflict.md': [
        '# Stories',
        '## Disagreement with a teammate',
        '',
        'During the lighthouse schema debate my teammate wanted one table per beacon. I proposed a spike,',
        'we measured both designs for a week and kept the simpler one. We still talk about that spike.',
    ].join('\n'),
    'stories/migration-2024-05.md': [
        '## Migration of the tide service',
        '',
        'The tide service moved from a cron box to a queue consumer. The cutover took one night and nobody noticed.',
    ].join('\n'),
    'prep/bridge-orbit/bridge-why-us.md': '## Why Bridge\n\nBridge ships ferry schedules; I like their open roadmap and weekly demos.',
    'prep/bridge-orbit/general-prep.md': '## Pitch\n\nA short pitch that fits both ferry companies and their teams.',
    'prep/lumen/why.md': '## Why Lumen Works\n\nLumen Works builds lantern firmware and I enjoy embedded work.',
    'prep/lumen-extra/notes.md': '## More lantern notes\n\nThe lantern firmware team ships quarterly.',
    'prep/kestrel/why.md': '## Why kestrel\n\nKestrel trains falcons with drones.',
    'prep/shared/common.md': '## Common answers\n\nGeneric answer about ferry logistics that any company can hear.',
    'drafts/skip.md': '## Draft\n\nThis draft must never be indexed.',
    'node_modules/pkg/readme.md': '## Package\n\nNot a note.',
    'notes.txt': 'Plain text note about storm logs and barometers.',
};

const MANIFEST = {
    version: 1,
    core: ['about/card.md'],
    entities: ['Quillsoft'],
    include: ['**/*.md', '**/*.txt'],
    exclude: ['drafts/**', '../escape/**'],
    companies: {
        root: 'prep',
        skip: ['shared'],
        aliases: {
            'bridge-orbit': ['Bridge', 'Orbit Pay'],
            lumen: ['Lumen Works'],
            'lumen-extra': ['Lumen Works', 'Lumen'],
        },
    },
};

async function makeKb(files = FILES, manifest = MANIFEST) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'career-kb-'));
    for (const [rel, text] of Object.entries(files)) {
        const p = path.join(dir, rel);
        await fsp.mkdir(path.dirname(p), { recursive: true });
        await fsp.writeFile(p, text, 'utf8');
    }
    if (manifest !== null) {
        await fsp.writeFile(path.join(dir, 'glass-kb.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest), 'utf8');
    }
    return dir;
}

const dirs = [];
async function kb(...args) {
    const dir = await makeKb(...args);
    dirs.push(dir);
    return dir;
}
after(async () => {
    for (const d of dirs) await fsp.rm(d, { recursive: true, force: true });
});

function career(env, extra = {}) {
    const lines = [];
    const mod = createCareerModule({ env, log: line => lines.push(line), debug: true, ...extra });
    return { mod, lines };
}

describe('parseManifest (FR-002; E3, E4)', () => {
    it('invalid JSON → defaults', () => {
        const m = parseManifest('{not json');
        assert.equal(m.valid, false);
        assert.deepEqual(m.include, ['**/*.md', '**/*.txt']);
        assert.deepEqual(m.exclude, []);
        assert.deepEqual(m.core, []);
    });

    it('unknown version → defaults', () => {
        const m = parseManifest(JSON.stringify({ version: 2, include: ['x/**'] }));
        assert.equal(m.valid, false);
        assert.deepEqual(m.include, ['**/*.md', '**/*.txt']);
    });

    it('drops entries that escape the root (E4)', () => {
        const m = parseManifest(JSON.stringify(MANIFEST));
        assert.equal(m.valid, true);
        assert.deepEqual(m.exclude, ['drafts/**']);
        assert.deepEqual(m.entities, ['Quillsoft']);
    });

    it('missing manifest → defaults', () => {
        const m = parseManifest(null);
        assert.equal(m.valid, false);
        assert.deepEqual(m.include, ['**/*.md', '**/*.txt']);
    });
});

describe('kbService: indexing (FR-002, FR-004, FR-005)', () => {
    let snap;
    before(async () => {
        snap = await createKbService({ root: await kb() }).refresh();
    });

    it('indexes included files and skips excluded ones', () => {
        const paths = new Set(snap.chunks.map(c => c.path));
        assert.ok(paths.has('stories/conflict.md'));
        assert.ok(paths.has('notes.txt'));
        assert.ok(!paths.has('drafts/skip.md'), 'exclude glob');
        assert.ok(![...paths].some(p => p.startsWith('node_modules/')), 'node_modules always excluded');
    });

    it('never chunks core files and removes their marker lines (FR-002, FR-004)', () => {
        assert.ok(!snap.chunks.some(c => c.path === 'about/card.md'));
        assert.match(snap.core, /Twelve years building harbor software\./);
        assert.ok(!/CONFIRMAR|Team size 99/.test(snap.core));
    });

    it('tags company chunks with sets (E29, E30) and leaves the rest untagged', () => {
        const tags = p => snap.chunks.find(c => c.path === p).companies;
        assert.deepEqual(tags('prep/bridge-orbit/bridge-why-us.md'), ['Bridge'], 'narrowed by file name');
        assert.deepEqual(tags('prep/bridge-orbit/general-prep.md'), ['Bridge', 'Orbit Pay'], 'no name in file → all aliases');
        assert.deepEqual(tags('prep/lumen/why.md'), ['Lumen Works']);
        assert.deepEqual(tags('prep/lumen-extra/notes.md'), ['Lumen Works', 'Lumen'], 'shared name across folders');
        assert.deepEqual(tags('prep/kestrel/why.md'), ['kestrel'], 'folder without aliases → folder name');
        assert.deepEqual(tags('prep/shared/common.md'), [], 'skip folder');
        assert.deepEqual(tags('stories/conflict.md'), [], 'outside companies.root');
    });

    it('lists company names for detection, one per slug', () => {
        assert.deepEqual([...snap.companyNames].sort(), ['Bridge', 'Lumen', 'Lumen Works', 'Orbit Pay', 'kestrel']);
    });

    it('takes chunk dates from file names', () => {
        const c = snap.chunks.find(x => x.path === 'stories/migration-2024-05.md');
        assert.equal(c.date, Date.UTC(2024, 4, 1));
    });

    it('returns null for a missing root (E2)', async () => {
        assert.equal(await createKbService({ root: path.join(os.tmpdir(), 'no-such-kb-dir-xyz') }).refresh(), null);
    });
});

describe('kbService: refresh (FR-016; E5)', () => {
    it('re-reads only changed files, drops deleted ones', async () => {
        const dir = await kb();
        const reads = [];
        const realRead = fsp.readFile;
        const svc = createKbService({ root: dir, fs: { ...fsp, readFile: (p, ...a) => { reads.push(path.relative(dir, p).replace(/\\/g, '/')); return realRead(p, ...a); } } });
        await svc.refresh();
        reads.length = 0;

        const changed = path.join(dir, 'stories/conflict.md');
        await fsp.writeFile(changed, '## Disagreement with a teammate\n\nRewritten story about the beacon spike.', 'utf8');
        const later = new Date(Date.now() + 60_000);
        await fsp.utimes(changed, later, later);
        await fsp.rm(path.join(dir, 'notes.txt'));

        const snap = await svc.refresh();
        const noteReads = reads.filter(r => r !== 'glass-kb.json' && r !== 'about/card.md');
        assert.deepEqual(noteReads, ['stories/conflict.md']);
        assert.match(snap.chunks.find(c => c.path === 'stories/conflict.md').body, /beacon spike/);
        assert.ok(!snap.chunks.some(c => c.path === 'notes.txt'), 'deleted file dropped');
    });

    it('skips a file that fails to read and indexes the rest (E5)', async () => {
        const dir = await kb();
        const svc = createKbService({
            root: dir,
            fs: { ...fsp, readFile: (p, ...a) => (p.endsWith('conflict.md') ? Promise.reject(new Error('EACCES')) : fsp.readFile(p, ...a)) },
        });
        const snap = await svc.refresh();
        assert.ok(!snap.chunks.some(c => c.path === 'stories/conflict.md'));
        assert.ok(snap.chunks.some(c => c.path === 'stories/migration-2024-05.md'));
    });

    it('an invalid manifest falls back to defaults (E3)', async () => {
        const dir = await kb(FILES, '{not json');
        const snap = await createKbService({ root: dir }).refresh();
        assert.ok(snap.chunks.some(c => c.path === 'drafts/skip.md'), 'default include, no exclude');
        assert.equal(snap.core, '');
    });
});

describe('career module: disabled (FR-001; E1, E2, E34, C1)', () => {
    it('CAREER_KB_PATH unset → disabled, null context, no cue, no company (E1, E34)', async () => {
        const { mod } = career({});
        await mod.warm();
        assert.deepEqual(mod.status(), { state: 'disabled', chunks: 0, vectors: 0 });
        assert.equal(await mod.getCareerContext('Tell me about yourself', { prev: null, activeCompany: null }), null);
        assert.equal(mod.hasCareerCue('your biggest weakness'), false);
        assert.equal(mod.detectCompany('here at Bridge we ship'), null);
        assert.doesNotThrow(() => mod.prefetch('anything'));
        assert.deepEqual(mod.checkAnswer('We grew 40%.', { block: 'x' }, ''), []);
        assert.deepEqual(mod.keyterms(), []);
    });

    it('folder missing → disabled, logged once (E2)', async () => {
        const { mod, lines } = career({ CAREER_KB_PATH: path.join(os.tmpdir(), 'no-such-kb-dir-xyz') });
        await mod.warm();
        await mod.warm();
        assert.equal(mod.status().state, 'disabled');
        assert.equal(lines.filter(l => /disabled/.test(l)).length, 1);
    });

    it('the folder disappearing later disables the module', async () => {
        const dir = await makeKb();
        const { mod } = career({ CAREER_KB_PATH: dir });
        await mod.warm();
        assert.equal(mod.status().state, 'ready-bm25');
        await fsp.rm(dir, { recursive: true, force: true });
        await mod.warm();
        assert.equal(mod.status().state, 'disabled');
        assert.equal(mod.hasCareerCue('your biggest weakness'), false);
    });
});

describe('career module: ready (FR-008, FR-011, FR-012, FR-013, FR-014, FR-017)', () => {
    let dir;
    let mod;
    let lines;
    before(async () => {
        dir = await kb();
        ({ mod, lines } = career({ CAREER_KB_PATH: dir }));
        await mod.warm();
    });
    const session = (extra = {}) => ({ prev: null, activeCompany: null, ...extra });

    it('reaches ready-bm25 and reports counts only', () => {
        const s = mod.status();
        assert.deepEqual(Object.keys(s).sort(), ['chunks', 'state', 'vectors']);
        assert.equal(s.state, 'ready-bm25');
        assert.ok(s.chunks > 5);
        assert.equal(s.vectors, 0);
    });

    it('concurrent warm calls share one refresh', async () => {
        await Promise.all([mod.warm(), mod.warm(), mod.warm()]);
        assert.equal(mod.status().state, 'ready-bm25');
    });

    it('personal → card first, matching note, addendum, sources (FR-013, FR-014)', async () => {
        const ctx = await mod.getCareerContext('Tell me about a time you disagreed with a teammate.', session());
        assert.equal(ctx.route, 'personal');
        assert.equal(ctx.cue, 'behavioral:tell-me-about-a-time');
        assert.ok(ctx.block.startsWith('[canonical facts]\n# Canonical facts'));
        assert.match(ctx.block, /\[conflict › Disagreement with a teammate\]/);
        assert.ok(!/CONFIRMAR/.test(ctx.block));
        assert.equal(ctx.sources[ctx.sources.length - 1], 'canonical facts');
        assert.ok(ctx.sources.includes('conflict › Disagreement with a teammate'));
        assert.ok(ctx.chunkIds.length >= 1);
        assert.match(ctx.addendum, /^The interviewer is asking about the candidate's own background\./);
        assert.ok(!/interviewer's company is/.test(ctx.addendum));
        assert.ok(ctx.queryTerms.includes('teammat'));
        assert.equal(ctx.timings.vectorUsed, false, 'no embedder → BM25 only');
        for (const k of ['routeMs', 'bm25Ms', 'vectorMs', 'totalMs']) assert.equal(typeof ctx.timings[k], 'number');
    });

    it('a personal question with no matching note still injects the card', async () => {
        const ctx = await mod.getCareerContext('your biggest weakness', session());
        assert.equal(ctx.route, 'personal');
        assert.match(ctx.block, /^\[canonical facts\]/);
        assert.ok(ctx.addendum);
    });

    it('general → nothing injected (G2)', async () => {
        const ctx = await mod.getCareerContext("What's the difference between a mutex and a channel?", session());
        assert.deepEqual(
            { route: ctx.route, block: ctx.block, addendum: ctx.addendum, sources: ctx.sources, chunkIds: ctx.chunkIds },
            { route: 'general', block: '', addendum: '', sources: [], chunkIds: [] },
        );
    });

    it('ambiguous with weak hits → nothing injected (E18)', async () => {
        const ctx = await mod.getCareerContext('How would you design a rate limiter for payments?', session());
        assert.equal(ctx.route, 'ambiguous');
        assert.equal(ctx.block, '');
        assert.equal(ctx.addendum, '');
    });

    it('ambiguous with a strong lexical hit → injected like personal', async () => {
        const ctx = await mod.getCareerContext('How would you handle the migration of the tide service queue consumer?', session());
        assert.equal(ctx.route, 'ambiguous');
        assert.match(ctx.block, /\[migration-2024-05 › Migration of the tide service\]/);
        assert.ok(ctx.addendum);
    });

    it('company route with a known company keeps only its notes and untagged ones (E13)', async () => {
        const ctx = await mod.getCareerContext('Why do you want to join us? Tell me about ferry schedules and lantern firmware.', session({ activeCompany: 'Bridge' }));
        assert.equal(ctx.route, 'company');
        assert.ok(!/Lumen Works builds lantern/.test(ctx.block), 'other company dropped');
        assert.match(ctx.addendum, /The interviewer's company is Bridge\./);
    });

    it('company route searches for the active company by name when the question has no content words', async () => {
        const ctx = await mod.getCareerContext('Why do you want to join us?', session({ activeCompany: 'Bridge' }));
        assert.equal(ctx.route, 'company');
        assert.match(ctx.block, /\[bridge-why-us › Why Bridge\]/);
        assert.ok(ctx.queryTerms.includes('bridg'));
    });

    it('company route with no known company uses untagged notes only (E14)', async () => {
        const ctx = await mod.getCareerContext('Why do you want to join us? ferry logistics and lantern firmware', session());
        assert.equal(ctx.route, 'company');
        assert.ok(!/Bridge ships ferry|Lumen Works builds/.test(ctx.block));
        assert.match(ctx.block, /Generic answer about ferry logistics/);
    });

    it('CAREER_KB_COMPANY wins over the detected company', async () => {
        const { mod: pinned } = career({ CAREER_KB_PATH: dir, CAREER_KB_COMPANY: 'lumen works' });
        await pinned.warm();
        const ctx = await pinned.getCareerContext('Why do you want to join us? lantern firmware ferry schedules', session({ activeCompany: 'Bridge' }));
        assert.match(ctx.addendum, /The interviewer's company is Lumen Works\./, 'display name from the manifest');
        assert.ok(!/Bridge ships ferry/.test(ctx.block));
    });

    it('a follow-up reuses the previous question terms (E16)', async () => {
        const first = await mod.getCareerContext('Tell me about a time you migrated the tide service.', session());
        assert.equal(first.route, 'personal');
        const ctx = await mod.getCareerContext('And what was the outcome?', session({ prev: { route: first.route, ts: Date.now(), queryTerms: first.queryTerms } }));
        assert.equal(ctx.cue, 'follow-up');
        assert.match(ctx.block, /tide service/);
    });

    it('boosts the extracted question terms', async () => {
        const ctx = await mod.getCareerContext('Great answer. So, tell me about a time you disagreed with a teammate', session({ question: 'tell me about a time you disagreed with a teammate' }));
        assert.equal(ctx.chunkIds.length > 0, true);
        assert.match(ctx.block, /Disagreement with a teammate/);
    });

    it('leaves out the excluded source file (eval leave-source-out)', async () => {
        const ctx = await mod.getCareerContext('Tell me about a time you disagreed with a teammate.', session(), { excludePaths: ['stories/conflict.md'] });
        assert.ok(!/Disagreement with a teammate/.test(ctx.block));
    });

    it('trace.k lists more of the ranking without changing the block (ask script)', async () => {
        const q = 'Tell me about your work on ferry schedules, lantern firmware, the tide service, storm logs, the lighthouse schema and falcons.';
        const short = {};
        const a = await mod.getCareerContext(q, session(), { trace: short });
        const long = { k: 9 };
        const b = await mod.getCareerContext(q, session(), { trace: long });
        assert.equal(a.route, 'personal');
        assert.equal(short.hits.length, 6);
        assert.ok(long.hits.length > 6);
        assert.deepEqual(long.hits.slice(0, 6).map(h => h.id), short.hits.map(h => h.id));
        assert.deepEqual(b.chunkIds, a.chunkIds);
        assert.equal(b.block, a.block);
        const top = long.hits[0];
        assert.equal(typeof top.score, 'number');
        assert.equal(top.bm25Rank, 1);
        assert.equal(top.vectorRank, null, 'no embedder');
        assert.equal(top.titleRank, null);
        assert.equal(top.cosine, null);
    });

    it('returns null when something inside throws (FR-017)', async () => {
        const bad = { get prev() { throw new Error('boom'); }, activeCompany: null };
        assert.equal(await mod.getCareerContext('Tell me about yourself', bad), null);
    });

    it('hasCareerCue works while ready (FR-007)', () => {
        assert.equal(mod.hasCareerCue('your biggest weakness'), true);
        assert.equal(mod.hasCareerCue('a mutex guards memory'), false);
        assert.equal(mod.hasCareerCue('the team at Quillsoft'), true, 'manifest entities are personal cues');
        assert.equal(mod.hasCareerCue(null), false);
    });

    it('detectCompany: aliases and folder names, longest first, only in company-context phrases (E15, E31, E32)', () => {
        assert.equal(mod.detectCompany('Welcome to Lumen Works, glad you could make it'), 'Lumen Works');
        assert.equal(mod.detectCompany('here at Lumen we ship lanterns'), 'Lumen');
        assert.equal(mod.detectCompany('Here at Bridge we ship weekly.'), 'Bridge');
        assert.equal(mod.detectCompany('Você conhece a Orbit Pay?'), 'Orbit Pay');
        assert.equal(mod.detectCompany('aqui na orbitpay a gente usa filas'), 'Orbit Pay');
        assert.equal(mod.detectCompany('thanks for joining kestrel today'), 'kestrel');
        assert.equal(mod.detectCompany('we can bridge that gap later'), null, 'ordinary word in small talk');
        assert.equal(mod.detectCompany('the Bridge team is great'), null, 'no company-context phrase');
        assert.equal(mod.detectCompany(''), null);
        assert.equal(mod.detectCompany(undefined), null);
    });

    it('keyterms: the company names, then the manifest entities (for the STT)', () => {
        const terms = mod.keyterms();
        for (const n of ['Lumen Works', 'Orbit Pay', 'Quillsoft']) assert.ok(terms.includes(n), n);
        assert.ok(terms.indexOf('Orbit Pay') < terms.indexOf('Quillsoft'), 'companies first');
    });

    it('detectCompany: a name the STT misspelled by one letter still counts, in a company-context phrase', () => {
        assert.equal(mod.detectCompany('aqui na orbitpai a gente usa filas'), 'Orbit Pay', 'one edit');
        assert.equal(mod.detectCompany('Aqui na Orbit Pai a gente valoriza autonomia'), 'Orbit Pay', 'one edit, split words');
        assert.equal(mod.detectCompany('thanks for joining kestral today'), 'kestrel');
        assert.equal(mod.detectCompany('Here at Bridget we ship weekly.'), null, 'short names stay exact');
        assert.equal(mod.detectCompany('aqui na orbita a gente usa filas'), null, 'two edits on a short name');
        assert.equal(mod.detectCompany('aqui na korbitpay a gente'), null, 'first letter must match');
        assert.equal(mod.detectCompany('the orbitpai team is great'), null, 'no company-context phrase');
    });

    it('checkAnswer flags numbers and known names that neither the block nor the conversation has (FR-021)', async () => {
        const ctx = await mod.getCareerContext('Tell me about a time you disagreed with a teammate.', session());
        const answer = 'At Quillsoft we ran the spike for 2 weeks and cut review time by 40%.';
        assert.deepEqual(mod.checkAnswer(answer, ctx, 'them: Tell me about a time you disagreed with a teammate.'), ['Quillsoft', '2', '40%']);
        assert.deepEqual(mod.checkAnswer(answer, ctx, 'them: At Quillsoft, with 2 teams, did review time drop 40%?'), []);
        assert.deepEqual(mod.checkAnswer('Company aliases count too: Lumen Works.', ctx, ''), ['Lumen Works']);
    });

    it('checkAnswer returns [] without a block and never throws', async () => {
        const general = await mod.getCareerContext("What's the difference between a mutex and a channel?", session());
        assert.deepEqual(mod.checkAnswer('It takes 40% less memory.', general, ''), []);
        assert.deepEqual(mod.checkAnswer('It takes 40% less memory.', null, ''), []);
        assert.deepEqual(mod.checkAnswer(null, { block: 'x' }, ''), []);
    });

    it('debug output names routes, cues, ids and timings but never note or turn text (E26, C2)', async () => {
        lines.length = 0;
        const turns = [
            'Tell me about a time you disagreed with a teammate.',
            'Why do you want to join us? ferry logistics',
            'How would you design a rate limiter for payments?',
            "What's the difference between a mutex and a channel?",
        ];
        for (const t of turns) await mod.getCareerContext(t, session({ activeCompany: 'Bridge' }));
        const personal = await mod.getCareerContext(turns[0], session());
        mod.checkAnswer('At Quillsoft we cut review time by 40%.', personal, '');
        await mod.warm();
        const out = lines.join('\n');
        assert.match(out, /\[career\] check unverified=2/);
        assert.ok(!out.includes('40%') && !out.includes('review time'), 'check log is a count only');
        assert.match(out, /\[career\] route=personal cue=behavioral:tell-me-about-a-time chunks=[0-9a-f]{12}/);
        assert.match(out, /route=general/);
        assert.match(out, /bm25=\d+(?:\.\d+)?ms/);
        const forbidden = [
            'lighthouse schema', 'one table per beacon', 'Twelve years', 'harbor software', 'ferry schedules',
            'open roadmap', 'lantern firmware', 'Generic answer', 'disagreed with a teammate', 'rate limiter', 'mutex',
        ];
        for (const f of forbidden) assert.ok(!out.includes(f), `log leaked: ${f}`);
    });
});

describe('career module: ambiguous gate with vectors (FR-012; E43)', () => {
    const Q = 'How would you handle the migration of the tide service queue consumer?';
    // The tide note tops the fusion on its keyword and title ranks and has no
    // cosine; the conflict note comes only from the text-vector ranking.
    const embedderWith = cosine => ({
        minCosine: 0.35,
        sync: async () => {},
        isReadyFor: () => true,
        vectorCount: () => 1,
        indexFor: chunks => ({
            size: chunks.length,
            search: () => [{ idx: chunks.findIndex(c => /Disagreement/.test(c.title)), score: cosine }],
            searchTitles: () => [{ idx: chunks.findIndex(c => /tide service/.test(c.title)), score: 0.9 }],
        }),
        prefetch: () => {},
        query: async () => [1],
    });
    const ask = async cosine => {
        const { mod } = career({ CAREER_KB_PATH: await kb() }, { embedder: embedderWith(cosine) });
        await mod.warm();
        const trace = {};
        const ctx = await mod.getCareerContext(Q, { prev: null }, { trace });
        return { ctx, trace };
    };

    it('injects when a later section clears the cosine gate and the first has no cosine', async () => {
        const { ctx, trace } = await ask(0.6);
        assert.equal(ctx.route, 'ambiguous');
        assert.equal(ctx.timings.vectorUsed, true);
        assert.match(trace.hits[0].title, /tide service/);
        assert.equal(trace.hits[0].cosine, null);
        assert.match(ctx.block, /\[migration-2024-05 › Migration of the tide service\]/);
        assert.match(ctx.block, /\[conflict › Disagreement with a teammate\]/);
        assert.ok(ctx.addendum);
    });

    it('injects nothing when no section clears the gate (E18)', async () => {
        const { ctx } = await ask(0.2);
        assert.equal(ctx.route, 'ambiguous');
        assert.equal(ctx.timings.vectorUsed, true);
        assert.equal(ctx.block, '');
        assert.equal(ctx.addendum, '');
    });
});

describe('career module: follow-up vector query (FR-006, FR-009; E41)', () => {
    const prefetched = [];
    const queried = [];
    // Records the texts the module embeds; no vectors, so ranking stays BM25.
    const fakeEmbedder = {
        minCosine: 0.35,
        sync: async () => {},
        isReadyFor: () => true,
        vectorCount: () => 1,
        indexFor: () => ({ size: 1, search: () => [], searchTitles: () => [] }),
        prefetch: text => { prefetched.push(text); },
        query: async text => { queried.push(text); return null; },
    };
    const clear = () => { prefetched.length = 0; queried.length = 0; };
    const Q1 = 'Tell me about a time you disagreed with a teammate.';
    const FOLLOW = 'And what was the outcome?';
    const prevOf = ctx => ({ route: ctx.route, queryTerms: ctx.queryTerms, anchorText: ctx.anchorText, ts: Date.now() });
    let mod;
    before(async () => {
        ({ mod } = career({ CAREER_KB_PATH: await kb() }, { embedder: fakeEmbedder }));
        await mod.warm();
    });

    it('a question that is not a follow-up searches with its own text and becomes the anchor', async () => {
        clear();
        const ctx = await mod.getCareerContext(Q1, { prev: null });
        assert.deepEqual(queried, [Q1]);
        assert.equal(ctx.anchorText, Q1);
    });

    it('a follow-up prefetches and searches with the question it follows, through a chain of follow-ups', async () => {
        const prev = prevOf(await mod.getCareerContext(Q1, { prev: null }));
        clear();
        mod.prefetch(FOLLOW, { prev });
        const ctx = await mod.getCareerContext(FOLLOW, { prev });
        assert.equal(ctx.cue, 'follow-up');
        assert.deepEqual(prefetched, [`${Q1}\n${FOLLOW}`]);
        assert.deepEqual(queried, [`${Q1}\n${FOLLOW}`], 'the query reuses the prefetched text');
        assert.equal(ctx.anchorText, Q1);
        clear();
        const again = await mod.getCareerContext('What did you learn?', { prev: prevOf(ctx) });
        assert.equal(again.cue, 'follow-up');
        assert.deepEqual(queried, [`${Q1}\nWhat did you learn?`]);
        assert.equal(again.anchorText, Q1);
    });

    it('a new question after a personal one searches with its own text', async () => {
        const prev = prevOf(await mod.getCareerContext(Q1, { prev: null }));
        clear();
        const q = 'Have you worked with message queues?';
        mod.prefetch(q, { prev });
        const ctx = await mod.getCareerContext(q, { prev });
        assert.notEqual(ctx.cue, 'follow-up');
        assert.deepEqual(prefetched, [q]);
        assert.deepEqual(queried, [q]);
        assert.equal(ctx.anchorText, q);
    });

    it('a follow-up with no anchor (session state from before) searches with its own text', async () => {
        clear();
        const ctx = await mod.getCareerContext(FOLLOW, { prev: { route: 'personal', queryTerms: ['disagre'], ts: Date.now() } });
        assert.equal(ctx.cue, 'follow-up');
        assert.deepEqual(queried, [FOLLOW]);
    });

    it('keeps only the end of a long anchor', async () => {
        clear();
        const anchor = `${'filler words '.repeat(100)}${Q1}`;
        await mod.getCareerContext(FOLLOW, { prev: { route: 'personal', queryTerms: [], anchorText: anchor, ts: Date.now() } });
        assert.equal(queried.length, 1);
        assert.ok(queried[0].endsWith(`${Q1}\n${FOLLOW}`));
        assert.ok(queried[0].length <= 600 + 1 + FOLLOW.length);
    });

    it('general turns and a prefetch without a session behave as before', async () => {
        clear();
        mod.prefetch('What is a goroutine?');
        const ctx = await mod.getCareerContext('What is a goroutine?', { prev: null });
        assert.equal(ctx.route, 'general');
        assert.equal(ctx.anchorText, '');
        assert.deepEqual(prefetched, ['What is a goroutine?']);
        assert.deepEqual(queried, []);
    });
});

describe('career module: Jev router (spec 2026-10-13-career-router-jev)', () => {
    const answer = (route, confidence = 0.9, followUp) => ({
        ok: true,
        status: 200,
        json: async () => ({
            model: 'jev-1.13.0',
            answers: {
                route: { type: 'choice', choice: route, probabilities: { [route]: confidence }, confidence },
                ...(followUp === undefined ? {} : { follow_up: { type: 'noul', noul: followUp } }),
            },
            usage: { input_tokens: 400, output_tokens: 20 },
        }),
    });
    function fakeFetch(reply) {
        const bodies = [];
        const fn = async (url, init) => {
            bodies.push(JSON.parse(init.body));
            return typeof reply === 'function' ? reply(JSON.parse(init.body)) : reply;
        };
        fn.bodies = bodies;
        return fn;
    }
    async function jevCareer(reply, envExtra = {}, extra = {}) {
        const fetchImpl = fakeFetch(reply);
        const env = { CAREER_KB_PATH: await kb(), TYPESAFE_API_KEY: 'test-key', ...envExtra };
        const { mod, lines } = career(env, { fetchImpl, ...extra });
        await mod.warm();
        return { mod, lines, fetchImpl };
    }

    it('without a key the module routes by regex and the gate does not wait (SC-006)', async () => {
        const fetchImpl = fakeFetch(answer('general'));
        const { mod } = career({ CAREER_KB_PATH: await kb() }, { fetchImpl });
        await mod.warm();
        assert.equal(mod.gateUsesJev(), false);
        const ctx = await mod.getCareerContext('Tell me about a time you disagreed with a teammate.', { prev: null });
        assert.equal(ctx.route, 'personal');
        assert.equal(ctx.cue, 'behavioral:tell-me-about-a-time');
        assert.equal(ctx.routeSource, 'regex');
        assert.equal(ctx.routeFallback, null);
        assert.equal(fetchImpl.bodies.length, 0);
        assert.equal(mod.routerStats().state, 'no-key');
    });

    it('Jev decides the route; the query is built from the turn as before', async () => {
        const { mod, fetchImpl, lines } = await jevCareer(answer('personal', 0.88));
        const q = 'Me conta como foi a migração do tide service';
        const ctx = await mod.getCareerContext(q, { prev: null, activeCompany: null });
        assert.equal(ctx.route, 'personal');
        assert.equal(ctx.cue, 'jev:personal@0.88');
        assert.equal(ctx.routeSource, 'jev');
        assert.equal(ctx.routeConfidence, 0.88);
        assert.equal(typeof ctx.jevMs, 'number');
        assert.match(ctx.block, /\[migration-2024-05 › Migration of the tide service\]/);
        assert.ok(ctx.queryTerms.includes('tide'));
        const sent = fetchImpl.bodies[0];
        assert.equal(sent.state.turn, q);
        assert.deepEqual(sent.state.candidate_names, ['Quillsoft']);
        assert.ok(sent.state.note_companies.includes('Bridge'));
        assert.ok(lines.some(l => /route=personal cue=jev:personal@0\.88 .* src=jev jev=[\d.]+ms/.test(l)));
        for (const l of lines) assert.ok(!l.includes('tide service') && !l.includes('Quillsoft'), 'no text in the log');
    });

    it('a Jev general answer injects nothing, even where the regex saw a cue', async () => {
        const { mod } = await jevCareer(answer('general', 0.9));
        const ctx = await mod.getCareerContext('Tell me about a time you disagreed with a teammate.', { prev: null });
        assert.deepEqual(
            { route: ctx.route, block: ctx.block, addendum: ctx.addendum, sources: ctx.sources },
            { route: 'general', block: '', addendum: '', sources: [] },
        );
    });

    it('the interviewer\'s company goes in the state: CAREER_KB_COMPANY first, then the session\'s', async () => {
        const { mod, fetchImpl } = await jevCareer(answer('company', 0.9), { CAREER_KB_COMPANY: 'lumen works' });
        const ctx = await mod.getCareerContext('Por que você quer entrar aqui?', { prev: null, activeCompany: 'Bridge' });
        assert.equal(ctx.route, 'company');
        assert.equal(fetchImpl.bodies[0].state.interviewer_company, 'Lumen Works');
        assert.match(ctx.addendum, /The interviewer's company is Lumen Works\./);
    });

    it('prefetch, classifyTurn and getCareerContext share one Jev call per turn', async () => {
        const { mod, fetchImpl } = await jevCareer(answer('personal', 0.9));
        const session = { prev: null, activeCompany: 'Bridge' };
        mod.prefetch('your biggest weakness', session);
        const gate = await mod.classifyTurn('your biggest weakness', session);
        assert.equal(gate.route, 'personal');
        assert.equal(gate.source, 'jev');
        const ctx = await mod.getCareerContext('your biggest weakness', { ...session, question: 'your biggest weakness' });
        assert.equal(ctx.route, 'personal');
        assert.equal(fetchImpl.bodies.length, 1);
    });

    it('a slow Jev falls back to the regex within the resolve budget', async () => {
        const { mod } = await jevCareer(() => new Promise(() => {}), { CAREER_ROUTER_RESOLVE_BUDGET_MS: '20' });
        const t0 = Date.now();
        const ctx = await mod.getCareerContext('Tell me about a time you disagreed with a teammate.', { prev: null });
        assert.ok(Date.now() - t0 < 500);
        assert.equal(ctx.route, 'personal');
        assert.equal(ctx.cue, 'behavioral:tell-me-about-a-time');
        assert.equal(ctx.routeSource, 'regex');
        assert.equal(ctx.routeFallback, 'budget');
    });

    it('a failing Jev falls back to the regex and the answer still gets its notes', async () => {
        const { mod, lines } = await jevCareer({ ok: false, status: 529, json: async () => ({}) });
        const ctx = await mod.getCareerContext('Tell me about a time you disagreed with a teammate.', { prev: null });
        assert.equal(ctx.route, 'personal');
        assert.equal(ctx.routeFallback, 'overload');
        assert.match(ctx.block, /Disagreement with a teammate/);
        assert.ok(lines.some(l => /src=regex\(overload\)/.test(l)));
    });

    it('a Jev follow-up carries the previous terms and prefetches the anchored text once Jev answers', async () => {
        const prefetched = [];
        const fakeEmbedder = {
            minCosine: 0.35,
            sync: async () => {},
            isReadyFor: () => true,
            vectorCount: () => 1,
            indexFor: () => ({ size: 1, search: () => [], searchTitles: () => [] }),
            prefetch: text => { prefetched.push(text); },
            query: async () => null,
        };
        const { mod } = await jevCareer(body => (body.questions.follow_up ? answer('general', 0.6, 0.9) : answer('personal', 0.9)), {}, { embedder: fakeEmbedder });
        const Q1 = 'Tell me about a time you disagreed with a teammate.';
        const first = await mod.getCareerContext(Q1, { prev: null });
        const prev = { route: first.route, queryTerms: first.queryTerms, anchorText: first.anchorText, ts: Date.now() };
        prefetched.length = 0;
        const FOLLOW = 'E como isso terminou';        // no regex follow-up marker
        mod.prefetch(FOLLOW, { prev });
        assert.deepEqual(prefetched, [FOLLOW], 'the regex sees no follow-up');
        for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
        assert.deepEqual(prefetched, [FOLLOW, `${Q1}\n${FOLLOW}`], 'Jev does');
        const ctx = await mod.getCareerContext(FOLLOW, { prev });
        assert.equal(ctx.route, 'personal');
        assert.equal(ctx.cue, 'follow-up');
        assert.equal(ctx.routeSource, 'jev');
        assert.ok(ctx.queryTerms.includes('teammat'), 'previous terms carried');
        assert.equal(ctx.anchorText, Q1);
    });

    it('classifyTurn: null while disabled; the gate waits only while Jev can answer', async () => {
        const { mod: off } = career({ CAREER_KB_PATH: '' }, { fetchImpl: fakeFetch(answer('personal')) });
        assert.equal(await off.classifyTurn('your biggest weakness', {}), null);
        assert.equal(off.gateUsesJev(), false);
        const { mod } = await jevCareer({ ok: false, status: 401, json: async () => ({}) });
        assert.equal(mod.gateUsesJev(), true);
        const d = await mod.classifyTurn('your biggest weakness', { prev: null });
        assert.equal(d.route, 'personal', 'the regex decides after the 401');
        assert.equal(d.fallback, 'auth');
        assert.equal(mod.gateUsesJev(), false);
        assert.equal(mod.routerStats().state, 'disabled:auth');
    });
});

describe('career module: load isolation (C4)', () => {
    it('requiring index.js under plain Node loads neither Electron nor the model runtime', () => {
        const entry = path.resolve(__dirname, '..', 'index.js');
        const script = `
            require(${JSON.stringify(entry)});
            const loaded = Object.keys(require.cache).filter(k => /[\\\\/]node_modules[\\\\/](electron|@huggingface|onnxruntime-node)[\\\\/]/.test(k));
            process.stdout.write(JSON.stringify(loaded));
        `;
        const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, CAREER_KB_PATH: '' } });
        assert.deepEqual(JSON.parse(out), []);
    });
});

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

    it('debug output names routes, cues, ids and timings but never note or turn text (E26, C2)', async () => {
        lines.length = 0;
        const turns = [
            'Tell me about a time you disagreed with a teammate.',
            'Why do you want to join us? ferry logistics',
            'How would you design a rate limiter for payments?',
            "What's the difference between a mutex and a channel?",
        ];
        for (const t of turns) await mod.getCareerContext(t, session({ activeCompany: 'Bridge' }));
        await mod.warm();
        const out = lines.join('\n');
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

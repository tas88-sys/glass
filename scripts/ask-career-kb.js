#!/usr/bin/env node
'use strict';

// Ask the career notes a question and see what Live Answer would retrieve
// (spec 2026-10-11, FR-008 to FR-013). Same code path as the app: the router,
// BM25 and vectors fused, one section per note file, the 9,000-char block.
//
//   node scripts/ask-career-kb.js [options] "question"   one question
//   node scripts/ask-career-kb.js [options]              type questions one by one; a follow-up
//                                                        ("and what was the outcome?") reuses the
//                                                        previous one, as in the app; /new resets
//   node scripts/ask-career-kb.js [options] < file.txt   one question per line, in order
//
// Options:
//   --kb <dir>          the notes folder (default: CAREER_KB_PATH, also read from .env)
//   --company <name>    the interviewing company (default: CAREER_KB_COMPANY)
//   --top <n>           ranked sections to list (default 10; the block takes at most 6)
//   --block             also print the exact text added to the prompt
//   --bm25-only         keyword ranking only; never loads the model
//   --cache-dir <dir>   vector cache (default: the app's, so nothing is embedded twice)
//
// The output shows note paths, titles and, with --block, note text. It is for
// your terminal only: never paste it into this public repo (spec C5). Share
// results with scripts/eval-career-kb.js, which prints ids and counts only.

const path = require('node:path');
const readline = require('node:readline');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const { createCareerModule } = require('../src/features/common/career');
const { createEmbedder } = require('../src/features/common/career/embedder');
const { createKbService } = require('../src/features/common/career/kbService');

const { appCacheDir } = require('./career-cache-dir');

const MAX_BLOCK_CHARS = 9000;   // contextBuilder's cap, for the summary line

function parseArgs(argv) {
    const a = {
        kb: process.env.CAREER_KB_PATH || '',
        company: process.env.CAREER_KB_COMPANY || '',
        top: 10,
        block: false,
        bm25Only: /^(?:0|off|false|no)$/i.test(String(process.env.CAREER_KB_VECTORS || '').trim()),
        cacheDir: appCacheDir(),
        question: [],
    };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--kb') a.kb = argv[++i];
        else if (k === '--company') a.company = argv[++i];
        else if (k === '--top') a.top = Number(argv[++i]);
        else if (k === '--block') a.block = true;
        else if (k === '--bm25-only') a.bm25Only = true;
        else if (k === '--cache-dir') a.cacheDir = argv[++i];
        else if (k.startsWith('--')) throw new Error(`unknown argument: ${k}`);
        else a.question.push(k);
    }
    if (!a.kb) throw new Error('set CAREER_KB_PATH (in .env) or pass --kb <dir>');
    if (!(Number.isInteger(a.top) && a.top > 0)) throw new Error('--top takes a whole number above 0');
    return a;
}

const rank = r => (r == null ? '-' : String(r));

// Section titles start with the file name; the file is already on the line above.
function sectionOf(hit) {
    const stem = path.basename(hit.path, path.extname(hit.path));
    return hit.title.startsWith(`${stem} › `) ? hit.title.slice(stem.length + 3) : hit.title;
}

function report(ctx, trace, args) {
    const out = [];
    if (!ctx) {
        out.push('No answer from the career module (notes unreadable?).');
        return out;
    }
    if (ctx.route === 'general') {
        out.push('route: general');
        out.push('Nothing is added: Live Answer answers this one without your notes.');
        return out;
    }
    const vectors = args.bm25Only ? 'off' : ctx.timings.vectorUsed ? 'used' : 'not used (keywords only)';
    out.push(`route: ${ctx.route}${ctx.cue ? ` (${ctx.cue})` : ''} · vectors: ${vectors} · company: ${trace.activeCompany || '-'}`);

    const hits = (trace.hits || []).slice(0, args.top);
    const sent = new Set(ctx.chunkIds);
    if (hits.length) {
        out.push('');
        out.push('Ranked sections, at most one per note file. sent = in what the AI gets (the app\'s "from:"');
        out.push('line); kw, text, title = place in the keyword, note-text and section-title rankings;');
        out.push('cos = similarity of the question to the note text.');
        out.push('');
        out.push('   #  sent   score   kw  text title   cos  file, then section');
        hits.forEach((h, i) => {
            const cos = h.cosine == null ? '    -' : h.cosine.toFixed(3);
            const cols = `${String(i + 1).padStart(4)}  ${sent.has(h.id) ? 'yes ' : '    '}  ${h.score.toFixed(4)}` +
                `${rank(h.bm25Rank).padStart(5)}${rank(h.vectorRank).padStart(6)}${rank(h.titleRank).padStart(6)}  ${cos}  `;
            out.push(`${cols}${h.path}`);
            out.push(`${' '.repeat(cols.length)}${sectionOf(h)}`);
        });
    }

    out.push('');
    if (!ctx.block) {
        out.push(ctx.route === 'ambiguous' && hits.length
            ? 'Nothing is added: the best match is too weak for a question that may not be about you (FR-012).'
            : 'Nothing is added: no note matched.');
        return out;
    }
    const card = ctx.sources.includes('canonical facts') ? ' plus the canonical facts' : '';
    out.push(`Sent: ${sent.size} section${sent.size === 1 ? '' : 's'}${card}, ` +
        `${ctx.block.length.toLocaleString('en-US')} of ${MAX_BLOCK_CHARS.toLocaleString('en-US')} characters`);
    if (args.block) {
        out.push('');
        out.push('--- added to the system prompt (User-provided context) ---');
        out.push(ctx.block);
        out.push('--- added to the user message ---');
        out.push(ctx.addendum);
    }
    return out;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const kb = path.resolve(args.kb);
    const env = { CAREER_KB_PATH: kb, CAREER_KB_COMPANY: args.company };

    const snap = await createKbService({ root: kb }).refresh();
    if (!snap) throw new Error('notes folder missing or unreadable');
    const embedder = args.bm25Only ? null : createEmbedder({ cacheDir: () => args.cacheDir });
    const mod = createCareerModule({ env, embedder, debug: false });
    await mod.warm();
    process.stderr.write(`[ask] ${snap.files} files, ${snap.chunks.length} sections\n`);
    if (embedder) {
        process.stderr.write('[ask] loading the model; only new or edited sections get embedded...\n');
        const t0 = Date.now();
        await embedder.sync(snap.chunks);
        const state = embedder.isReadyFor(snap.chunks) ? 'ready' : 'incomplete; partly keywords only';
        process.stderr.write(`[ask] vectors ${state} (${embedder.vectorCount()} rows, ${Math.round((Date.now() - t0) / 1000)}s)\n`);
    }

    const session = { prev: null, activeCompany: null };
    async function ask(text) {
        if (!session.activeCompany) session.activeCompany = mod.detectCompany(text) || null;
        if (embedder) {
            mod.prefetch(text);
            await embedder.query(text, 10_000);     // the app's 800 ms debounce absorbs this
        }
        const trace = { k: args.top };
        const ctx = await mod.getCareerContext(text, { prev: session.prev, activeCompany: session.activeCompany }, { trace, bm25Only: args.bm25Only });
        // Follow-ups stick only to the last personal/company question, as in summaryService.
        session.prev = ctx && (ctx.route === 'personal' || ctx.route === 'company')
            ? { route: ctx.route, queryTerms: ctx.queryTerms || [], ts: Date.now() }
            : null;
        process.stdout.write(`${report(ctx, trace, args).join('\n')}\n`);
    }

    try {
        if (args.question.length) {
            await ask(args.question.join(' '));
            return;
        }
        // Typed questions get a prompt; piped ones (a file of questions) are echoed instead.
        const typed = !!process.stdin.isTTY;
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '\n> ' });
        let open = true;
        rl.once('close', () => { open = false; });
        if (typed) {
            process.stdout.write('Type a question as the interviewer would ask it. /new starts over, Ctrl+C quits.\n');
            rl.prompt();
        }
        for await (const line of rl) {
            if (!typed) process.stdout.write(`\n> ${line}\n`);
            const text = line.trim();
            if (text === '/new') {
                session.prev = null;
                session.activeCompany = null;
                process.stdout.write('Started over: no previous question, no company.\n');
            } else if (text) {
                await ask(text);
            }
            if (typed && open) rl.prompt();
        }
    } finally {
        if (embedder) embedder.close();
    }
}

main().catch(err => {
    process.stderr.write(`[ask] ${err.message}\n`);
    process.exitCode = 1;
});

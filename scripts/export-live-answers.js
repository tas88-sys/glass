#!/usr/bin/env node
'use strict';

// Exports a Listen session's live answers from the app's own DB, for review
// (spec 2026-10-13-live-answer-history).
//
//   node scripts/export-live-answers.js [--session <id>|--list] --out <file.jsonl> [--db <path>] [--with-transcript]
//
// --session: a session id (default: the latest Listen session with answers).
// --list:    the Listen sessions with their answer counts, no text.
// --out:     one JSON line per answer, in the order asked: { asked_at, turn,
//            question, answer, status, error, model, route, route_source, cue,
//            sources, unverified, first_token_ms, total_ms }. With
//            --with-transcript, the session's transcript lines come first as
//            { transcript: [{ at, speaker, text }] }.
// The DB is opened read-only (node:sqlite: the app's better-sqlite3 is built
// for Electron). The output holds the interview and the notes' text, so it
// must be outside this public repo; the script refuses a path inside it.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { answerWords } = require('./live-eval/checks');

function appDb() {
    const base = process.platform === 'win32' ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
        : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support')
            : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    return path.join(base, 'Glass', 'pickleglass.db');
}

function parseArgs(argv) {
    const a = { db: appDb(), session: null, out: null, list: false, transcript: false };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--db') a.db = argv[++i];
        else if (k === '--session') a.session = argv[++i];
        else if (k === '--out') a.out = argv[++i];
        else if (k === '--list') a.list = true;
        else if (k === '--with-transcript') a.transcript = true;
        else throw new Error(`unknown argument: ${k}`);
    }
    if (!a.list) {
        if (!a.out) throw new Error('pass --out <file.jsonl> (or --list)');
        a.out = path.resolve(a.out);
        const rel = path.relative(path.resolve(__dirname, '..'), a.out);
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) throw new Error('--out must be outside this repo: it holds the interview and note text');
    }
    return a;
}

const parse = v => {
    try {
        return v ? JSON.parse(v) : [];
    } catch {
        return [];
    }
};

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!fs.existsSync(args.db)) throw new Error(`no app DB at ${args.db}`);
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(args.db, { readOnly: true });
    const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'live_answers'").get();
    if (!hasTable) throw new Error('the app DB has no live_answers table yet: start the updated app once');

    const sessions = db.prepare(`
        SELECT s.id, s.started_at, s.ended_at, COUNT(l.id) AS answers
        FROM sessions s LEFT JOIN live_answers l ON l.session_id = s.id
        WHERE s.session_type = 'listen'
        GROUP BY s.id ORDER BY s.started_at DESC`).all();
    if (args.list) {
        for (const s of sessions) {
            const when = s.started_at ? new Date(s.started_at * 1000).toISOString().slice(0, 16).replace('T', ' ') : '-';
            process.stdout.write(`${s.id}  ${when}  ${s.answers} answers\n`);
        }
        return;
    }
    const id = args.session || (sessions.find(s => s.answers > 0) || {}).id;
    if (!id) throw new Error('no Listen session with answers');

    const lines = [];
    if (args.transcript) {
        const transcript = db.prepare('SELECT start_at, speaker, text FROM transcripts WHERE session_id = ? ORDER BY start_at ASC, created_at ASC').all(id)
            .map(t => ({ at: t.start_at, speaker: t.speaker, text: t.text }));
        lines.push(JSON.stringify({ session: id, transcript }));
    }
    const rows = db.prepare('SELECT * FROM live_answers WHERE session_id = ? ORDER BY asked_at_ms ASC, created_at ASC').all(id);
    for (const r of rows) {
        lines.push(JSON.stringify({
            asked_at: r.asked_at_ms,
            turn: r.turn,
            question: r.question,
            answer: r.answer,
            status: r.status,
            error: r.error,
            model: r.model,
            route: r.route,
            route_source: r.route_source,
            cue: r.cue,
            sources: parse(r.sources_json),
            unverified: parse(r.unverified_json),
            first_token_ms: r.first_token_ms,
            total_ms: r.total_ms,
        }));
    }
    fs.writeFileSync(args.out, `${lines.join('\n')}\n`);
    const byStatus = rows.reduce((o, r) => ({ ...o, [r.status]: (o[r.status] || 0) + 1 }), {});
    // Words per shown answer, as the live eval counts them (future-work item 11).
    const words = rows.filter(r => r.status === 'answer').map(r => answerWords(r.answer)).sort((a, b) => a - b);
    const length = words.length ? `; words p50 ${words[Math.ceil(words.length / 2) - 1]}, max ${words[words.length - 1]}, >120 ${words.filter(w => w > 120).length}` : '';
    process.stdout.write(`session ${id}: ${rows.length} answers ${JSON.stringify(byStatus)}${length} → ${args.out}\n`);
}

try {
    main();
} catch (err) {
    process.stderr.write(`[export] ${err.message}\n`);
    process.exit(1);
}

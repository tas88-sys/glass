'use strict';

// Results: one line per item on the console, report.json and report.md in the
// output folder (outside the repo). The console line carries ids, routes,
// numbers and check details, which never quote a question or an answer; the
// career-route questions' text goes to the local report only (spec 2026-10-11 C5).

const fs = require('node:fs');
const path = require('node:path');

/** fail | warn | pass, from the item's checks. */
function statusOf(item) {
    if (item.checks.some(c => c.level === 'fail' && !c.ok)) return 'FAIL';
    if (item.checks.some(c => c.level === 'warn' && !c.ok)) return 'WARN';
    return 'PASS';
}

const sec = ms => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)}s` : '-');

function consoleLine(item) {
    const st = statusOf(item);
    const m = item.metrics || {};
    const bits = [];
    if (m.route) bits.push(`route=${m.route}${m.expectedRoute && m.expectedRoute !== m.route ? `(want ${m.expectedRoute})` : ''}`);
    if (m.firstTokenMs != null) bits.push(`first=${sec(m.firstTokenMs)}`);
    if (m.totalMs != null) bits.push(`total=${sec(m.totalMs)}`);
    if (m.model) bits.push(`model=${m.model}`);
    if (m.resets) bits.push(`fallbacks=${m.resets}`);
    if (m.wer != null) bits.push(`wer=${m.wer}`);
    if (m.tests) bits.push(`tests=${m.tests}`);
    if (item.judge && item.judge.score != null) bits.push(`judge=${item.judge.score}/5`);
    const failed = item.checks.filter(c => !c.ok && c.level !== 'info').map(c => `${c.level === 'fail' ? '✗' : '!'} ${c.name}${c.detail ? ` (${c.detail})` : ''}`);
    return `${st.padEnd(4)} ${item.phase} ${item.id.padEnd(22)} ${bits.join(' ')}${failed.length ? `\n       ${failed.join('\n       ')}` : ''}`;
}

function md(text) {
    return String(text || '').replace(/\r/g, '');
}

function writeReports(outDir, run) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(run, null, 2));

    const lines = [];
    const counts = { PASS: 0, WARN: 0, FAIL: 0 };
    for (const it of run.items) counts[statusOf(it)]++;
    lines.push(`# Live eval — ${run.startedAt}`, '');
    lines.push(`Mode: ${run.mode} · ${counts.PASS} pass · ${counts.WARN} warn · ${counts.FAIL} fail · ${Math.round(run.elapsedMs / 1000)} s`, '');
    lines.push('```', ...run.config, '```', '');
    if (run.aggregates) {
        lines.push('## Aggregates', '', '```', JSON.stringify(run.aggregates, null, 2), '```', '');
    }
    let phase = null;
    for (const it of run.items) {
        if (it.phase !== phase) {
            phase = it.phase;
            lines.push(`## ${run.phaseNames[phase] || phase}`, '');
        }
        lines.push(`### ${statusOf(it)} · ${it.id}`, '');
        for (const c of it.checks) lines.push(`- ${c.ok ? '✓' : c.level === 'fail' ? '✗' : c.level === 'warn' ? '!' : '·'} ${c.name}${c.detail ? ` — ${md(c.detail)}` : ''}`);
        lines.push('', '```json', JSON.stringify(it.metrics || {}, null, 1), '```');
        if (it.question) lines.push('', `**Question (script):** ${md(Array.isArray(it.question) ? it.question.join(' … ') : it.question)}`);
        if (it.transcript != null && it.transcript !== '') lines.push('', `**Transcript (STT):** ${md(it.transcript)}`);
        if (it.extracted) lines.push('', `**Panel label:** ${md(it.extracted)}`);
        if (it.answer) lines.push('', '**Answer:**', '', '````markdown', md(it.answer), '````');
        if (it.judge) lines.push('', `**Judge (${it.judge.model}):** ${it.judge.error ? `error: ${it.judge.error}` : `${it.judge.score}/5 — ${md(it.judge.verdict)}`}`, ...(it.judge.issues || []).map(x => `  - ${md(x)}`));
        lines.push('');
    }
    fs.writeFileSync(path.join(outDir, 'report.md'), lines.join('\n'));
    return counts;
}

module.exports = { statusOf, consoleLine, writeReports };

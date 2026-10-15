'use strict';

// Phase D's Go answer, compiled with the Go on PATH: the eval runs only the
// JavaScript answer against the hidden tests, so a Go answer that does not
// build would pass unseen. Without Go installed the check is info only.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** The answer's code as a program `go build` takes: package main and a main. */
function asProgram(code) {
    let src = String(code || '').replace(/^﻿/, '');
    src = /^\s*package\s+\w+/m.test(src) ? src.replace(/^(\s*package\s+)\w+/m, '$1main') : `package main\n\n${src}`;
    if (!/\bfunc\s+main\s*\(\s*\)/.test(src)) src += '\n\nfunc main() {}\n';
    return src;
}

/**
 * @param {string} code - the Go block of the answer
 * @returns {{ available: boolean, ok: boolean, error: string, ms: number }}
 */
function buildGo(code, { timeoutMs = 120_000 } = {}) {
    const version = spawnSync('go', ['version'], { encoding: 'utf8', timeout: 10_000 });
    if (version.error || version.status !== 0) return { available: false, ok: false, error: 'go not on PATH', ms: 0 };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glass-eval-go-'));
    const t0 = Date.now();
    try {
        fs.writeFileSync(path.join(dir, 'main.go'), asProgram(code));
        const r = spawnSync('go', ['build', '-o', path.join(dir, 'solution.exe'), 'main.go'], {
            cwd: dir,
            encoding: 'utf8',
            timeout: timeoutMs,
            env: { ...process.env, GO111MODULE: 'off', GOFLAGS: '' },
        });
        const error = r.error ? r.error.message : r.status !== 0 ? (r.stderr || r.stdout || `exit ${r.status}`).trim().split(/\r?\n/).slice(0, 4).join(' | ') : '';
        return { available: true, ok: !error, error, ms: Date.now() - t0 };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

module.exports = { asProgram, buildGo };

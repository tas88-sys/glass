/**
 * goBuild.test.js — phase D's Go build: the answer's code as a program.
 * The build itself runs only where Go is installed.
 *
 * Run: node --test scripts/live-eval/__tests__
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const { asProgram, buildGo } = require('../goBuild');

const hasGo = !spawnSync('go', ['version']).error;

describe('asProgram', () => {
    it('adds package main and an empty main to a bare solution', () => {
        const src = asProgram('// Go\nimport "sort"\n\nfunc f(a []int) { sort.Ints(a) }');
        assert.match(src, /^package main\n/);
        assert.match(src, /func main\(\) \{\}\n$/);
    });
    it('renames another package to main and keeps a main the answer has', () => {
        const src = asProgram('package solution\n\nfunc main() { println(1) }');
        assert.match(src, /^package main\n/);
        assert.equal(src.match(/func main\(/g).length, 1);
    });
});

describe('buildGo', { skip: !hasGo && 'Go is not installed' }, () => {
    it('builds valid code and reports the compiler error of invalid code', () => {
        assert.equal(buildGo('func f(i, j int) int { return i + j }').ok, true);
        const bad = buildGo('func f(i, j int) { int(i, j) }');
        assert.equal(bad.ok, false);
        assert.match(bad.error, /int/);
    });
});

/**
 * checks.test.js — the live eval's deterministic checks and audio helpers.
 *
 * Run: node --test scripts/live-eval/__tests__
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const c = require('../checks');
const { parseWav, toMono24k, decodeGeminiAudio } = require('../tts');
const codeProblem = require('../fixtures/code-problem');

describe('candidateReply (phase B, what the candidate says back)', () => {
    it('is the headline without markdown or a "Headline:" label', () => {
        assert.equal(c.candidateReply('**Headline:** I build a one-pager first.\n\n- point', 'en-US'), 'I build a one-pager first.');
        assert.equal(c.candidateReply('- **Faço um PRD antes dos tickets.**\n- ponto', 'pt-BR'), 'Faço um PRD antes dos tickets.');
    });

    it('cuts a long headline to maxWords', () => {
        assert.equal(c.candidateReply('one two three four five six', 'en-US', 3), 'one two three.');
    });

    it('falls back to a short line in the turn language when nothing was shown', () => {
        assert.match(c.candidateReply('', 'pt-BR'), /^Boa pergunta/);
        assert.match(c.candidateReply('PASSIVE', 'en-US'), /^Good question/);
        assert.match(c.candidateReply(undefined, 'en-US'), /^Good question/);
    });
});

describe('wer', () => {
    it('is 0 for the same words, ignoring case, accents, punctuation and number words', () => {
        assert.equal(c.wer('Como você garantiria que um pagamento não seja cobrado duas vezes?', 'como voce garantiria que 1 pagamento nao seja cobrado 2 vezes'), 0);
    });
    it('counts substitutions, insertions and deletions over the reference length', () => {
        assert.equal(c.wer('a b c d', 'a x c'), 0.5);
        assert.equal(c.wer('', ''), 0);
        assert.equal(c.wer('', 'extra'), 1);
    });
});

describe('detectLang', () => {
    it('tells Portuguese from English and ignores code', () => {
        assert.equal(c.detectLang('Para garantir isso, eu usaria uma chave de idempotência no servidor e não no cliente.'), 'pt');
        assert.equal(c.detectLang('To make it safe, I would store an idempotency key with the result of each charge.'), 'en');
        assert.equal(c.detectLang('```js\nconst the = of + and;\n```\nOk.'), 'unknown');
    });
});

describe('answerShape', () => {
    it('reads the headline without markdown and counts bullets', () => {
        const s = c.answerShape('**Use an idempotency key.**\n\n- store it\n- return the saved result\n');
        assert.equal(s.headline, 'Use an idempotency key.');
        assert.equal(s.headlineWords, 4);
        assert.equal(s.bullets, 2);
    });
});

describe('mentions', () => {
    it('matches substrings and /regex/ terms without accents or case', () => {
        const m = c.mentions('A réplica atrasada (LAG) é lida do primário; 4,870 ms', ['replica', 'lag', '/4[.,\\s]?870/', 'sharding']);
        assert.deepEqual(m.found, ['replica', 'lag', '/4[.,\\s]?870/']);
        assert.deepEqual(m.missing, ['sharding']);
    });
    it('reads LaTeX complexity as plain text', () => {
        assert.equal(c.plainMath('$O(m \\cdot n \\log(m \\cdot n))$ on $220 \\times 220$'), 'O(m · n log(m · n)) on 220 × 220');
        const m = c.mentions('`O(m \\cdot n \\log(m \\cdot n))`', ['/o\\(\\s*m\\s*[·*x×]?\\s*n\\s*[·*x×]?\\s*log/']);
        assert.equal(m.found.length, 1);
    });
});

describe('sections', () => {
    const good = '### Clarifying Questions\nq\n### Reasoning / Think-Out-Loud\nr\n### Solution\n```js\nx\n```\n### Time Complexity\nt\n### Space Complexity\ns';
    it('accepts the five code sections in order', () => {
        assert.equal(c.sectionsInOrder(good, c.CODE_SECTIONS).ok, true);
    });
    it('reports missing and out-of-order sections', () => {
        const swapped = good.replace('### Time Complexity', '### TMP').replace('### Space Complexity', '### Time Complexity').replace('### TMP', '### Space Complexity');
        // Space now comes before Time: Time matches last, so Space is the one found out of order.
        assert.deepEqual(c.sectionsInOrder(swapped, c.CODE_SECTIONS).outOfOrder, ['Space Complexity']);
        assert.deepEqual(c.sectionsInOrder('### Solution', c.CODE_SECTIONS).missing, ['Clarifying Questions', 'Reasoning / Think-Out-Loud', 'Time Complexity', 'Space Complexity']);
    });
    it('checks system design sections 0 to 11', () => {
        const all = Array.from({ length: 12 }, (_, i) => `## ${i}. Part ${i}\ntext`).join('\n');
        assert.equal(c.systemDesignSections(all).ok, true);
        const r = c.systemDesignSections(all.replace('## 7. Part 7', 'Part 7'));
        assert.deepEqual(r.missing, [7]);
    });
    it('counts numbers with units', () => {
        assert.equal(c.concreteNumbers('2M QPS, p99 5 ms, 3 replicas, 40 GB, 99.9%'), 5);
    });
});

describe('codeBlocks and runJsSolution', () => {
    const tests = codeProblem.tests();
    it('extracts fenced blocks with their language', () => {
        const b = c.codeBlocks('x\n```javascript\nconst a = 1;\n```\n```go\nfunc f() {}\n```');
        assert.deepEqual(b.map(x => x.lang), ['javascript', 'go']);
    });
    it('passes the reference solution, in any of the shapes models write', () => {
        const body = codeProblem.reference.toString().replace(/^function reference/, 'function trapWater');
        for (const code of [body, `const trapWater = ${body.replace('function trapWater', 'function')};`, `var Solution = class { trapWater(h) { return (${body})(h); } };`]) {
            const r = c.runJsSolution(code, 'trapWater', tests);
            assert.equal(r.passed, r.total, JSON.stringify(r.failures.slice(0, 2)) + (r.error || ''));
        }
    });
    it('fails a wrong answer, a missing function and an endless loop', () => {
        assert.equal(c.runJsSolution('function trapWater() { return 0; }', 'trapWater', tests).passed < tests.length, true);
        assert.match(c.runJsSolution('function other() {}', 'trapWater', tests).error, /no function/);
        const loop = c.runJsSolution('function trapWater() { for (;;) {} }', 'trapWater', tests.slice(0, 1), { timeoutMs: 200 });
        assert.match(loop.failures[0].error, /timeout/);
    });
    it('times out a quadratic solution on the large grid', () => {
        // Brute force: for each cell, the lowest level water can escape at (Dijkstra-free flood per cell).
        const brute = `function trapWater(h) {
            const m = h.length, n = m ? h[0].length : 0; let w = 0;
            for (let r = 0; r < m; r++) for (let c = 0; c < n; c++) {
                let lo = h[r][c], hi = 20001;
                while (lo < hi) { const mid = (lo + hi) >> 1; const seen = new Set([r * n + c]); const st = [[r, c]]; let out = false;
                    while (st.length && !out) { const [a, b] = st.pop(); if (a === 0 || b === 0 || a === m - 1 || b === n - 1) { out = true; break; }
                        for (const [x, y] of [[a+1,b],[a-1,b],[a,b+1],[a,b-1]]) { const k = x * n + y; if (!seen.has(k) && h[x][y] < mid) { seen.add(k); st.push([x, y]); } } }
                    if (out) hi = mid; else lo = mid + 1; }
                w += Math.max(0, lo - 1 - h[r][c]) > 0 && lo - 1 > h[r][c] ? lo - 1 - h[r][c] : 0;
            }
            return w; }`;
        const large = tests.filter(t => /large/.test(t.name));
        const r = c.runJsSolution(brute, 'trapWater', large, { timeoutMs: 1500 });
        assert.equal(r.passed, 0);
    });
});

describe('audio helpers', () => {
    function wav(rate, channels, samples) {
        const data = Buffer.alloc(samples.length * 2);
        samples.forEach((s, i) => data.writeInt16LE(s, i * 2));
        const h = Buffer.alloc(44);
        h.write('RIFF', 0);
        h.writeUInt32LE(36 + data.length, 4);
        h.write('WAVE', 8);
        h.write('fmt ', 12);
        h.writeUInt32LE(16, 16);
        h.writeUInt16LE(1, 20);
        h.writeUInt16LE(channels, 22);
        h.writeUInt32LE(rate, 24);
        h.writeUInt32LE(rate * channels * 2, 28);
        h.writeUInt16LE(channels * 2, 32);
        h.writeUInt16LE(16, 34);
        h.write('data', 36);
        h.writeUInt32LE(data.length, 40);
        return Buffer.concat([h, data]);
    }
    it('reads a WAV and keeps 24 kHz mono as is', () => {
        const pcm = toMono24k(parseWav(wav(24000, 1, [1, -2, 3])));
        assert.deepEqual([pcm.readInt16LE(0), pcm.readInt16LE(2), pcm.readInt16LE(4)], [1, -2, 3]);
    });
    it('downmixes stereo and resamples 48 kHz to 24 kHz', () => {
        const pcm = toMono24k(parseWav(wav(48000, 2, [100, 300, 100, 300, 100, 300, 100, 300])));
        assert.equal(pcm.length, 4);
        assert.equal(pcm.readInt16LE(0), 200);
    });
    it('decodes raw L16 with its rate from the MIME type', () => {
        const raw = Buffer.alloc(8);
        assert.equal(decodeGeminiAudio('audio/L16;codec=pcm;rate=24000', raw.toString('base64')).length, 8);
        assert.equal(decodeGeminiAudio('audio/L16;codec=pcm;rate=12000', raw.toString('base64')).length, 16);
    });
});

'use strict';

// The Ask code scenario's problem: rain water held by a 2D height map (a hard
// classic, written here in our own words and pictured in code-problem.svg).
// The hidden tests come from the reference solution below, on hand-made edge
// cases, seeded random grids and one large grid that a quadratic solution
// cannot finish within the runner's timeout.

const FN_NAME = 'trapWater';

/** Reference: min-heap flood from the border, O(mn log mn). */
function reference(heightMap) {
    const m = heightMap.length;
    const n = m ? heightMap[0].length : 0;
    if (m < 3 || n < 3) return 0;
    const seen = Array.from({ length: m }, () => new Uint8Array(n));
    const heap = [];
    const push = (h, r, c) => {
        heap.push([h, r, c]);
        let i = heap.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (heap[p][0] <= heap[i][0]) break;
            [heap[p], heap[i]] = [heap[i], heap[p]];
            i = p;
        }
    };
    const pop = () => {
        const top = heap[0];
        const last = heap.pop();
        if (heap.length) {
            heap[0] = last;
            let i = 0;
            for (;;) {
                const l = 2 * i + 1;
                const r = l + 1;
                let s = i;
                if (l < heap.length && heap[l][0] < heap[s][0]) s = l;
                if (r < heap.length && heap[r][0] < heap[s][0]) s = r;
                if (s === i) break;
                [heap[s], heap[i]] = [heap[i], heap[s]];
                i = s;
            }
        }
        return top;
    };
    for (let r = 0; r < m; r++) {
        for (let c = 0; c < n; c++) {
            if (r === 0 || c === 0 || r === m - 1 || c === n - 1) {
                seen[r][c] = 1;
                push(heightMap[r][c], r, c);
            }
        }
    }
    let water = 0;
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    while (heap.length) {
        const [h, r, c] = pop();
        for (const [dr, dc] of dirs) {
            const nr = r + dr;
            const nc = c + dc;
            if (nr < 0 || nc < 0 || nr >= m || nc >= n || seen[nr][nc]) continue;
            seen[nr][nc] = 1;
            const nh = heightMap[nr][nc];
            if (nh < h) water += h - nh;
            push(Math.max(h, nh), nr, nc);
        }
    }
    return water;
}

function rng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 2 ** 32;
    };
}

function grid(rand, m, n, max) {
    return Array.from({ length: m }, () => Array.from({ length: n }, () => Math.floor(rand() * (max + 1))));
}

/** [{ name, input: [heightMap], expected }] */
function tests() {
    const cases = [
        ['empty', []],
        ['one row', [[3, 1, 3]]],
        ['two rows', [[3, 1, 3], [3, 1, 3]]],
        ['flat', [[2, 2, 2], [2, 2, 2], [2, 2, 2]]],
        ['single pit', [[5, 5, 5], [5, 1, 5], [5, 5, 5]]],
        ['leaky border', [[5, 5, 5], [5, 1, 0], [5, 5, 5]]],
        ['picture example', [[4, 4, 4, 4, 4], [4, 1, 2, 1, 4], [4, 2, 0, 2, 4], [4, 4, 3, 4, 4]]],
        ['nested walls', [[9, 9, 9, 9, 9, 9, 9], [9, 2, 2, 2, 2, 2, 9], [9, 2, 7, 7, 7, 2, 9], [9, 2, 7, 0, 7, 2, 9], [9, 2, 7, 7, 7, 2, 9], [9, 2, 2, 2, 2, 2, 9], [9, 9, 9, 9, 9, 9, 9]]],
        ['basin spills over the lowest wall', [[6, 6, 6, 6], [6, 1, 1, 3], [6, 1, 1, 6], [6, 6, 6, 6]]],
    ];
    const rand = rng(20261012);
    for (let i = 0; i < 12; i++) {
        const m = 3 + Math.floor(rand() * 10);
        const n = 3 + Math.floor(rand() * 10);
        cases.push([`random ${m}x${n} #${i + 1}`, grid(rand, m, n, 1 + Math.floor(rand() * 30))]);
    }
    cases.push(['large 220x220', grid(rand, 220, 220, 20000)]);
    return cases.map(([name, map]) => ({ name, input: [map], expected: reference(map) }));
}

module.exports = { FN_NAME, reference, tests };

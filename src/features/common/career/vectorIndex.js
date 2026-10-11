'use strict';

// Brute-force cosine search over L2-normalized rows (research R4): a few
// thousand 384-d vectors scan in about a millisecond, so no ANN index.

/**
 * @param {Float32Array} rows  n × dims, row i ↔ chunk i, L2-normalized
 * @param {number} dims
 */
function buildVectorIndex(rows, dims) {
    const n = dims > 0 && rows ? Math.floor(rows.length / dims) : 0;
    return {
        size: n,
        dims,
        /**
         * @param {Float32Array} query  L2-normalized
         * @param {number} k
         * @returns {Array<{idx:number, score:number}>}
         */
        search(query, k) {
            if (!query || query.length !== dims || n === 0 || !(k > 0)) return [];
            const hits = new Array(n);
            for (let i = 0; i < n; i++) {
                let dot = 0;
                const off = i * dims;
                for (let d = 0; d < dims; d++) dot += rows[off + d] * query[d];
                hits[i] = { idx: i, score: dot };
            }
            hits.sort((a, b) => b.score - a.score || a.idx - b.idx);
            return hits.slice(0, k);
        },
    };
}

module.exports = { buildVectorIndex };

'use strict';

// Brute-force cosine search over L2-normalized rows (research R4): a few
// thousand 768-d vectors scan in a few milliseconds, so no ANN index.

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
            // Keep only the best k in place (descending; on equal scores the lower
            // index stays first). No per-row objects: this runs on the answer path,
            // and allocation churn showed up as GC pauses in the p95.
            const kk = Math.min(Math.floor(k), n);
            const topScore = new Float64Array(kk);
            const topIdx = new Int32Array(kk);
            let count = 0;
            for (let i = 0; i < n; i++) {
                let dot = 0;
                const off = i * dims;
                for (let d = 0; d < dims; d++) dot += rows[off + d] * query[d];
                if (count === kk) {
                    if (dot <= topScore[kk - 1]) continue;
                    count--;                                   // drop the current worst
                }
                let pos = count;
                while (pos > 0 && topScore[pos - 1] < dot) {
                    topScore[pos] = topScore[pos - 1];
                    topIdx[pos] = topIdx[pos - 1];
                    pos--;
                }
                topScore[pos] = dot;
                topIdx[pos] = i;
                count++;
            }
            const hits = new Array(count);
            for (let j = 0; j < count; j++) hits[j] = { idx: topIdx[j], score: topScore[j] };
            return hits;
        },
    };
}

module.exports = { buildVectorIndex };

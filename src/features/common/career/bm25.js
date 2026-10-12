'use strict';

// BM25 over chunk title (weight 3) and body (weight 1), combined per term
// before saturation (BM25F). Pure JS inverted index: the retrieval core must
// run under plain Node (spec C4), so no SQLite FTS5 (research R2).

const { tokenize } = require('./textNormalize');

const BM25_PARAMS = Object.freeze({ k1: 1.2, b: 0.75, wTitle: 3, wBody: 1 });

function countTerms(tokens) {
    const m = new Map();
    for (const t of tokens) m.set(t, (m.get(t) || 0) + 1);
    return m;
}

/**
 * @param {Array<{title:string, body:string}>} chunks
 * @param {typeof BM25_PARAMS} [params]
 */
function buildBm25(chunks, params = BM25_PARAMS) {
    const n = chunks.length;
    const lenTitle = new Uint32Array(n);
    const lenBody = new Uint32Array(n);
    /** @type {Map<string, Array<[number, number, number]>>} term → [chunkIdx, tfTitle, tfBody] */
    const postings = new Map();

    for (let i = 0; i < n; i++) {
        const titleTerms = tokenize(chunks[i].title);
        const bodyTerms = tokenize(chunks[i].body);
        lenTitle[i] = titleTerms.length;
        lenBody[i] = bodyTerms.length;
        const tfTitle = countTerms(titleTerms);
        const tfBody = countTerms(bodyTerms);
        for (const term of new Set([...tfTitle.keys(), ...tfBody.keys()])) {
            let list = postings.get(term);
            if (!list) postings.set(term, (list = []));
            list.push([i, tfTitle.get(term) || 0, tfBody.get(term) || 0]);
        }
    }

    let sumTitle = 0;
    let sumBody = 0;
    for (let i = 0; i < n; i++) {
        sumTitle += lenTitle[i];
        sumBody += lenBody[i];
    }
    const avgTitle = n ? sumTitle / n || 1 : 1;
    const avgBody = n ? sumBody / n || 1 : 1;
    const { k1, b, wTitle, wBody } = params;

    return {
        size: n,

        /**
         * @param {string[]} queryTerms  already tokenized; repeats boost a term
         * @param {number} k
         * @returns {Array<{idx:number, score:number, matchedTerms:number, queryTerms:number}>}
         */
        search(queryTerms, k) {
            if (!Array.isArray(queryTerms) || queryTerms.length === 0 || !(k > 0) || n === 0) return [];
            const qtf = countTerms(queryTerms);
            const scores = new Map();
            const matched = new Map();
            for (const [term, weight] of qtf) {
                const list = postings.get(term);
                if (!list) continue;
                const idf = Math.log(1 + (n - list.length + 0.5) / (list.length + 0.5));
                for (const [i, tfT, tfB] of list) {
                    const tf =
                        (wTitle * tfT) / (1 - b + (b * lenTitle[i]) / avgTitle) +
                        (wBody * tfB) / (1 - b + (b * lenBody[i]) / avgBody);
                    const s = (weight * idf * tf * (k1 + 1)) / (tf + k1);
                    scores.set(i, (scores.get(i) || 0) + s);
                    matched.set(i, (matched.get(i) || 0) + 1);
                }
            }
            const hits = [];
            for (const [idx, score] of scores) {
                hits.push({ idx, score, matchedTerms: matched.get(idx), queryTerms: qtf.size });
            }
            hits.sort((x, y) => y.score - x.score || x.idx - y.idx);
            return hits.slice(0, k);
        },
    };
}

module.exports = { buildBm25, BM25_PARAMS };

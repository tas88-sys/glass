'use strict';

/**
 * sttKeyterms.js
 *
 * Words the speech-to-text should favor. Deepgram nova-3 takes them as
 * `keyterm` query parameters, in Portuguese too: in the live eval it heard
 * "O que é LINQ?" as "O que é link?" without them and right with them. Other
 * providers ignore the list.
 *
 * Two sources: a fixed list of technical names an interview uses and an STT
 * hears as plain words, plus the company and entity names of the career notes
 * (the interviewer's company is the name the STT most often misspells).
 *
 * Pure and self-contained (no dependencies, no side effects).
 */

// Names that sound like ordinary words or get split ("LINQ" → "link",
// "gRPC" → "G RPC", "Kubernetes" → "cooper netties", "API token" → "IP token",
// "rate limiter" → "reclimiter", "CLAUDE.md" → "Club MD"). Kept short: Deepgram
// caps the keyterms of a request at 500 tokens. "AI" goes only inside phrases:
// alone, two letters could pull "I" or "a" into it (future-work item 15).
const TECH_KEYTERMS = Object.freeze([
    'LINQ', 'gRPC', 'GraphQL', 'Kafka', 'RabbitMQ', 'Kubernetes', 'kubectl', 'Redis', 'PostgreSQL',
    'MongoDB', 'DynamoDB', 'Cassandra', 'Elasticsearch', 'goroutine', 'mutex', 'Terraform', 'nginx',
    'OAuth', 'JWT', 'idempotency', 'sharding', 'CQRS', 'Golang', 'TypeScript', 'Django', 'FastAPI',
    'Spring Boot', 'Entity Framework', 'BigQuery', 'Snowflake', 'Kinesis', 'SQS', 'on-call',
    'API token', 'rate limit', 'rate limiter', 'unbuffered channel', 'buffered channel',
    'Claude Code', 'CLAUDE.md', 'AI agent', 'AI tools', 'AI setup',
]);

const MAX_EXTRA_KEYTERMS = 50;  // names from the notes
const MAX_KEYTERMS = MAX_EXTRA_KEYTERMS + TECH_KEYTERMS.length;   // the fixed list always fits
const MAX_TERM_CHARS = 40;

/**
 * The fixed list plus extra names, deduplicated without regard to case,
 * blank or overlong entries dropped, the extra names first (they are the
 * ones only this user has; at most MAX_EXTRA_KEYTERMS of them), at most
 * MAX_KEYTERMS in all.
 * @param {unknown} [extra] names from the career notes
 * @returns {string[]}
 */
function buildKeyterms(extra) {
    const out = [];
    const seen = new Set();
    const add = term => {
        if (typeof term !== 'string') return;
        const t = term.trim().replace(/\s+/g, ' ');
        if (!t || t.length > MAX_TERM_CHARS) return;
        const key = t.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        out.push(t);
    };
    for (const term of Array.isArray(extra) ? extra : []) {
        if (out.length >= MAX_EXTRA_KEYTERMS) break;
        add(term);
    }
    for (const term of TECH_KEYTERMS) add(term);
    return out.slice(0, MAX_KEYTERMS);
}

module.exports = { TECH_KEYTERMS, MAX_EXTRA_KEYTERMS, MAX_KEYTERMS, buildKeyterms };

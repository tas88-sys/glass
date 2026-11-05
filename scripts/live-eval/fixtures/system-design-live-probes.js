'use strict';

// Phase I: the Live Answer lane in System Design · Live (future-work items 18.1
// and 18.11, rules 6 and 7). Each run is one design round through the real
// SummaryService: the interviewer's clarifying lines get nothing while no design
// kit exists; then a design kit is stored, and each probe gets one PROBE
// answer built on it. The kits are fixed text, so a probe can be checked
// against the store its Decisions line names. Generic content only.

const KIT_EN = `## Requirements used
- Scope: posting, following, the home timeline (confirmed); search and notifications out (confirmed)
- Scale: 10M daily active users, all in the US (confirmed); about 100 reads per write (assumed)
- Targets: timeline p99 under 200 ms (assumed); a timeline a few seconds behind is fine (confirmed); an accepted post is never lost (confirmed)
## API
- POST /v1/posts {text, idempotency_key} → {post_id}
- GET /v1/timeline?cursor= → {posts[], next_cursor}
## Design
\`\`\`
(1) API gateway → (2) Post service → (3) Cassandra posts
                         ↓
                  (4) Kafka → (5) Fan-out workers → (6) Redis timelines
\`\`\`
- **Write path:** 1. the post is written to Cassandra (sync); 2. an event goes to Kafka (sync, via an outbox); 3. fan-out workers push the post ID to followers' timelines (async).
- **Read path:** 1. the timeline service reads the user's list of IDs from Redis; 2. it hydrates the posts from a post cache, then Cassandra.
- **Storage:**
| Entity | Store | Key | Why |
|---|---|---|---|
| Post | Cassandra | post_id | heavy writes read by key |
| Timeline | Redis | user_id | fast reads of the last 800 IDs |
| Follow graph | MySQL | follower_id, followee_id | relations |
- **Decisions:** push fan-out for normal accounts, pull for accounts over 1M followers; timelines in Redis, last 800 IDs; posts in Cassandra.
> Posts land in Cassandra, Kafka fans them out, and each timeline is a list of IDs in Redis.
## Deep dives
- **Problem:** a celebrity post fans out to 50M timelines
- **Options:** A, push to all: simple reads, huge write bursts; B, pull at read time: no burst, slower reads
- **Pick:** hybrid: push for normal accounts, pull for celebrities; costs a merge at read time; switch if read latency passes 200 ms.
- **Failure:** a fan-out backlog delays timelines by seconds; workers catch up from Kafka.
- **Problem:** a Redis timeline shard is lost
- **Options:** A, replicas per shard; B, rebuild from Cassandra on a miss
- **Pick:** replicas per shard plus a background rebuild; costs memory; switch if memory cost doubles.
- **Failure:** users see the last cached page, then the rebuilt timeline.
## Check against requirements
- timeline a few seconds behind → async fan-out
## Next questions
- **Q:** why not SQL for posts? **A:** writes by key at this scale fit Cassandra better.`;

const KIT_PT = KIT_EN
    .replace('> Posts land in Cassandra, Kafka fans them out, and each timeline is a list of IDs in Redis.', '> Os posts vão para o Cassandra, o Kafka faz o fan-out, e cada timeline é uma lista de IDs no Redis.');

const RUNS = [
    {
        id: 'en',
        lang: 'en-US',
        kit: KIT_EN,
        beforeKit: [
            'Design a Twitter-like home timeline.',
            'Assume about 10 million daily active users, all in the US.',
        ],
        probes: [
            { id: 'cache-down', text: 'What if the timeline cache cluster goes down?', mentionsAny: ['redis', 'replica', '/rebuild/'] },
            { id: 'why-not-sql', text: 'Why not just use a single SQL database for the posts?', mentionsAny: ['cassandra', '/write/'] },
            { id: 'celebrity', text: 'How do you handle someone with 50 million followers?', mentionsAny: ['pull', 'hybrid'] },
        ],
        baseline: 'How would you make a payment endpoint safe to retry?',
    },
    {
        id: 'pt',
        lang: 'pt-BR',
        kit: KIT_PT,
        beforeKit: [
            'Vamos projetar a timeline inicial de uma rede social parecida com o Twitter.',
            'Assuma uns 10 milhões de usuários ativos por dia, todos no Brasil.',
        ],
        probes: [
            { id: 'cache-down', text: 'E se o cluster de cache das timelines cair, o que acontece?', mentionsAny: ['redis', '/r[ée]plica/', '/reconstr/', '/rebuild/'] },
            { id: 'why-not-sql', text: 'Por que não usar um único banco SQL para os posts?', mentionsAny: ['cassandra', '/escrita/', '/write/'] },
        ],
        baseline: 'Como você deixaria um endpoint de pagamento seguro para repetir a chamada?',
    },
];

module.exports = { RUNS, KIT_EN, KIT_PT };

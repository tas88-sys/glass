'use strict';

// Optional LLM judge (--judge): a second model scores each answer against a
// rubric for its kind and lists concrete problems. It never decides PASS/FAIL
// (the deterministic checks do); the scores go in the report next to them.
// Gemini by default (the app's DB has no Anthropic key); --judge-model picks
// another Gemini model.

const KINDS = {
    live: 'This is a Live Answer: a suggestion shown on screen while a candidate is in a job interview, read aloud almost verbatim right after the interviewer asks. It should open with a short headline answer, then at most a few short bullets. Judge whether it is technically correct, answers the most recent interviewer question (using the transcript for context), is concise enough to say in under a minute, and is in the language the interviewer used.',
    'live-career': 'This is a Live Answer to a question about the candidate themself, written from the candidate\'s own notes (given below as NOTES). Judge as for any Live Answer, and also whether every fact it states (companies, numbers, projects, dates) is supported by the NOTES: an invented or altered fact is a serious problem. A general or behavioral framing is fine when the notes have nothing specific.',
    'ask-image': 'This is an Ask answer: the candidate pressed a key to ask about their screen; the screenshot is attached. Judge whether it reads the screenshot correctly (exact values), answers the typed request, and is accurate.',
    code: 'This is an Ask answer in coding-interview mode for the problem in the attached screenshot. Its required sections are Clarifying Questions, Reasoning / Think-Out-Loud (naive to optimal), Solution, Time Complexity and Space Complexity. Judge whether the clarifying questions fit this problem, the reasoning reaches the optimal approach, the complexity claims are correct, and the code is clean. (The code was also run against hidden tests; the result is given.)',
    'system-design': 'This is an Ask answer in system-design-interview mode for the prompt in the attached screenshot. Judge whether it addresses every requirement in the screenshot (global quota within ±5%, surviving the loss of a region, p99 added latency under 5 ms, quota changes within 10 s, 429 with Retry-After, 50M keys at 2M requests/s over 5 regions), gives concrete numbers, and makes sound trade-offs a staff engineer would defend.',
};

const SCHEMA = {
    type: 'object',
    properties: {
        score: { type: 'integer', description: '1 (unusable) to 5 (excellent)' },
        correctness: { type: 'integer' },
        relevance: { type: 'integer' },
        concision: { type: 'integer' },
        speakability: { type: 'integer' },
        issues: { type: 'array', items: { type: 'string' } },
        verdict: { type: 'string', description: 'one sentence' },
    },
    required: ['score', 'correctness', 'relevance', 'concision', 'speakability', 'issues', 'verdict'],
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Tried in order until one exists for the key (a model can be retired for new users).
const DEFAULT_MODELS = ['gemini-3.1-pro-preview', 'gemini-pro-latest', 'gemini-3.5-flash-lite'];

function createJudge({ apiKey, model, log = () => {} }) {
    if (!apiKey) return null;
    const { GoogleGenAI } = require('@google/genai');
    const ai = new GoogleGenAI({ apiKey });
    const candidates = model ? [model] : DEFAULT_MODELS.slice();

    /**
     * @param {object} o
     * @param {keyof KINDS} o.kind
     * @param {string} o.question
     * @param {string} o.answer
     * @param {string} [o.transcript]
     * @param {string} [o.notes] - the career block the answer was given
     * @param {string} [o.extra] - e.g. the hidden-test result
     * @param {string} [o.imageBase64] - JPEG
     */
    async function score({ kind, question, answer, transcript, notes, extra, imageBase64 }) {
        const text = [
            `ROLE: you are a strict senior interviewer reviewing an AI assistant's output. Scores are integers 1-5.`,
            `KIND: ${KINDS[kind] || KINDS.live}`,
            transcript ? `TRANSCRIPT (most recent last):\n${transcript}` : '',
            `QUESTION OR REQUEST:\n${question}`,
            notes ? `NOTES:\n${notes}` : '',
            extra ? `ALSO KNOWN:\n${extra}` : '',
            `ANSWER TO JUDGE:\n${answer || '(empty)'}`,
        ].filter(Boolean).join('\n\n');
        const parts = [{ text }];
        if (imageBase64) parts.push({ inlineData: { mimeType: 'image/jpeg', data: imageBase64 } });
        let lastError = 'no judge model available';
        while (candidates.length) {
            const current = candidates[0];
            for (let attempt = 0; attempt < 4; attempt++) {
                try {
                    const r = await ai.models.generateContent({
                        model: current,
                        contents: [{ role: 'user', parts }],
                        config: { responseMimeType: 'application/json', responseSchema: SCHEMA, temperature: 0 },
                    });
                    const raw = r.text || r.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
                    return { model: current, ...JSON.parse(raw) };
                } catch (err) {
                    const status = err.status || err.code;
                    lastError = `${status || ''} ${String(err.message).replace(/\s+/g, ' ').slice(0, 160)}`.trim();
                    if (status === 404 || (status === 429 && /PerDay/i.test(String(err.message)))) break;
                    if ((status === 429 || status === 500 || status === 503) && attempt < 3) {
                        const wait = 8000 * (attempt + 1);
                        log(`[judge] ${current} ${status}, retrying in ${wait / 1000}s`);
                        await sleep(wait);
                        continue;
                    }
                    return { model: current, error: lastError };
                }
            }
            // This model is gone or spent for the day: the next one judges from now on.
            log(`[judge] ${current} unavailable (${lastError.slice(0, 60)}); trying the next model`);
            candidates.shift();
        }
        return { model: null, error: lastError };
    }

    return { score, get model() { return candidates[0] || null; } };
}

module.exports = { createJudge, KINDS };

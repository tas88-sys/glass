'use strict';

// The live answer's question gate, pure (no Electron): summaryService uses it,
// and scripts/replay-career-session.js replays real sessions through it.

// ---------------------------------------------------------------------------
// Pure helper: isLikelyQuestion (FR-002)
// Recall-oriented: true when text ends with '?' OR starts with a question
// opener (case-insensitive). When uncertain, favor true — PASSIVE suppresses.
// ---------------------------------------------------------------------------
// Balanced, quota-aware question gate (FR-002).
//
// Triggers when the turn carries a real question SIGNAL, and skips the
// interviewer's declarative monologue so we don't spend LLM calls (and the
// daily quota) on talk that isn't a question. Catches ~every real question;
// the only by-design gap is a cue-less statement-form prompt ("your biggest
// weakness"). PASSIVE still suppresses any false trigger.
//
// A turn triggers when ANY of these holds:
//   1. a '?' appears anywhere (STT usually punctuates questions)
//   2. an imperative/interview cue appears (design, compare, give me, ...)
//   3. an embedded/indirect question appears ("...the question is what...")
//   4. a wh-word or yes/no auxiliary LEADS any clause (after peeling leading
//      discourse markers, so "okay so how does X" counts)
// Otherwise it is treated as declarative monologue and skipped.

// wh-words + yes/no auxiliaries/modals that lead an interrogative clause.
const CLAUSE_LEAD_RE =
    /^(?:what|how|why|when|where|which|who|whom|whose|whether|is|are|am|was|were|do|does|did|can|could|would|will|should|shall|may|might|have|has|had|must)\b/i;
// Discourse markers / fillers that can precede the real clause start.
const LEAD_STRIP_RE =
    /^(?:so|and|but|now|well|okay|ok|alright|right|um|uh|er|like|you know|i mean|then|yeah|no|oh|hmm)\b[\s,]*/i;
// Imperative / interview cues — a strong question signal anywhere in the turn.
const CONTENT_CUE_RE = new RegExp(
    '\\b(?:tell me|tell us|walk me|walk us|walk through|give me|give us|show me|' +
    'show us|describe|explain|compare|contrast|define|design|implement|write|' +
    'build|create|solve|optimi[sz]e|refactor|debug|consider|suppose|imagine|' +
    'assume|elaborate|outline|discuss|go over|step through|reason about|' +
    'think about|talk about|what about|how about|what if|let\'s say|lets say|' +
    'name (?:a|an|some|the)|list (?:a|an|some|the|out)|your thoughts|any thoughts|' +
    'your take|thoughts on|difference between|pros and cons|trade-?offs)\\b',
    'i'
);
// Indirect / embedded question: a copula or asking-verb followed by a wh-word.
const EMBEDDED_Q_RE =
    /\b(?:is|are|was|were|wonder|wondering|curious|know|asking|ask|want(?:ed)? to know|looking at|question is)\s+(?:what|how|why|when|where|which|who|whether|if)\b/i;

// Portuguese twins of the signals above. The STT often leaves the '?' off a
// Portuguese question ("Me explica a diferença entre…"), so the gate needs its
// own words. PT_CLAUSE_LEAD_RE and PT_CONTENT_CUE_RE match accent-folded,
// lowercase text (foldPt); PT_LEAD_STRIP_RE peels the original text, so it
// spells the accents itself. "aí", "legal" and "show" are left out: peeled
// from English ("AI is…", "Legal is…") they would expose an auxiliary.
const PT_LEAD_STRIP_RE =
    /^(?:ent[aã]o|e(?!\s+se(?![\p{L}\p{N}]))|mas|agora|bom|bem|beleza|t[aá]|ok|certo|tipo|n[eé]|olha|enfim|perfeito|[oó]timo|hum|ah)(?![\p{L}\p{N}])[\s,]*/iu;
// Question words and "você + verb" openers. "Como" alone also means "as"
// ("Como arquiteta, …"), so it counts only before a verb or "você".
const PT_CLAUSE_LEAD_RE = new RegExp(
    '^(?:o que|oque|que tipo|qual|quais|quem|quando|onde|aonde|por que|pra que|para que|' +
    'quanto|quantos|quantas|sera que|e se|' +
    'como (?:que |e que )?(?:se )?(?:voce|vc|voces|a gente|e|era|foi|seria|ficaria|funciona|funcionaria|' +
    'faz|faria|fazer|lida|lidaria|lidar|garante|garantiria|garantir|escala|escalaria|escalar|resolve|' +
    'resolveria|resolver|implementa|implementaria|implementar|projeta|projetaria|projetar|evita|evitaria|' +
    'evitar|trata|trataria|tratar|mede|mediria|medir|calcula|calcularia|calcular|testa|testaria|testar)|' +
    '(?:voce|vc|voces) (?:ja|conhece|sabe|tem|teve|pode|poderia|consegue|conseguiria|costuma|prefere|acha|' +
    'usaria|faria|gosta|usa|trabalha|trabalhou|usou|lidou|participou)|' +
    '(?:pode|poderia|consegue|conseguiria) (?:me |nos )?(?:explicar|falar|contar|dar|mostrar|descrever|detalhar|' +
    'comentar|resumir|dizer)|' +
    'tem (?:algum|alguma|alguns|algumas|experiencia|exemplo)|ja (?:trabalhou|usou|teve|fez|lidou|participou|precisou))\\b'
);
// Requests and interview cues anywhere in the turn.
const PT_CONTENT_CUE_RE = new RegExp(
    '\\b(?:me (?:explica|explique|fala|fale|conta|conte|diz|diga|descreve|descreva|mostra|mostre|passa|passe|' +
    'lista|liste|ajuda a entender|ajude a entender)|me (?:da|de) (?:um|uma|alguns|algumas|exemplo)|' +
    'explique|descreva|compare|defina|projete|desenhe|implemente|escreva|resolva|otimize|elabore|liste|' +
    'comente|considere|suponha|imagine|imagina|pense em|pensa em|' +
    '(?:fala|fale|conta|conte|explica) (?:sobre|um pouco|mais|pra mim|pra gente)|' +
    'explica (?:como|o que|a diferenca|por que|qual)|' +
    'diferenca entre|pros e contras|vantagens e desvantagens|o que (?:voce|vc) acha|na sua (?:opiniao|visao)|' +
    'sua (?:opiniao|visao) sobre|(?:gostaria de|queria|quero) (?:saber|ouvir|entender)|' +
    '(?:gostaria|queria) que (?:voce|vc)|sabe (?:me )?dizer|saberia (?:me )?dizer|que tal|vamos supor|digamos que)\\b'
);

/** Accents folded, lowercase: the space the Portuguese regexes match in. */
function foldPt(text) {
    return text.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
}

/** Discourse markers peeled from the start of a clause, English and Portuguese. */
function peelLead(clause) {
    let c = clause.trim();
    let prev;
    do {
        prev = c;
        c = c.replace(LEAD_STRIP_RE, '').trim();
        c = c.replace(PT_LEAD_STRIP_RE, '').trim();
    } while (c !== prev);
    return c;
}

/** A wh-word / auxiliary (or its Portuguese twin) leads the peeled clause. */
function leadsQuestion(peeled) {
    return CLAUSE_LEAD_RE.test(peeled) || PT_CLAUSE_LEAD_RE.test(foldPt(peeled));
}

function hasContentCue(text) {
    return CONTENT_CUE_RE.test(text) || PT_CONTENT_CUE_RE.test(foldPt(text));
}

function isLikelyQuestion(text) {
    if (typeof text !== 'string') return false;
    const trimmed = text.trim();
    if (trimmed.length === 0) return false;

    if (trimmed.includes('?')) return true;            // 1. explicit question mark
    if (hasContentCue(trimmed)) return true;           // 2. imperative/interview cue
    if (EMBEDDED_Q_RE.test(trimmed)) return true;      // 3. embedded/indirect question

    // 4. wh-word / auxiliary leading any clause (peel leading discourse markers
    //    so "okay so how does X work" still counts).
    for (const clause of trimmed.split(/[.!?;,\n]+/)) {
        if (leadsQuestion(peelLead(clause))) return true;
    }

    // 5. No question signal — declarative monologue; skip to save quota (PASSIVE
    //    would have suppressed it anyway). Cue-less statement-form prompts are
    //    the known by-design gap (FR-002 / EDGE_CASES).
    return false;
}

// ---------------------------------------------------------------------------
// Pure helper: isBackchannel (spec 2026-10-13-career-router-jev, R19)
// True when every word of the turn is an acknowledgment, a filler or a
// "pardon?" ("Aham.", "Hã?", "Ah entendi, beleza.", "Got it.", "Sorry?"),
// so no answer is wanted. A real session armed answers on these: "Hã?" passed
// the '?' rule, and with Jev the statement-form ones read as follow-ups. The
// STT writes "um"/"hum" as "1", so a lone 1 is a filler too. Words that start
// a real question ("o que", "quando", "what is") are not in the lists.
// Accent-folded and lowercase (foldPt); at most BACKCHANNEL_MAX_WORDS words.
// ---------------------------------------------------------------------------
const BACKCHANNEL_MAX_WORDS = 8;
const BACKCHANNEL_WORDS = new Set([
    // Portuguese
    'a', 'ah', 'aha', 'aham', 'ahn', 'ai', 'alo', 'bacana', 'beleza', 'bem', 'boa', 'bom', 'caraca', 'certo',
    'claro', 'e', 'eh', 'entao', 'entendi', 'entendo', 'esta', 'exato', 'exatamente', 'falou', 'ha', 'hein',
    'hum', 'humm', 'hm', 'hmm', 'isso', 'joia', 'la', 'legal', 'maneiro', 'mas', 'massa', 'nossa', 'nao', 'oi',
    'ok', 'okay', 'opa', 'otimo', 'pa', 'perfeito', 'pronto', 'show', 'sim', 'ta', 'tranquilo', 'uhum', 'um',
    'vamos', 'verdade', 'de', 'bola', 'demais', 'top', 'interessante', 'faz', 'sentido', 'saquei',
    // English
    'oh', 'yeah', 'yes', 'yep', 'no', 'nope', 'right', 'sure', 'cool', 'nice', 'great', 'good', 'got', 'it',
    'i', 'see', 'mhm', 'mhmm', 'mm', 'mmm', 'hmmm', 'uh', 'uhm', 'umm', 'er', 'erm', 'huh', 'wow', 'alright', 'so', 'and', 'well', 'sorry', 'pardon', 'perfect',
    'awesome', 'exactly', 'true', 'gotcha', 'makes', 'sense', 'interesting', 'that',
    'is', 'amazing', 'fair', 'enough', 'indeed', 'totally', 'definitely', 'absolutely',
    // STT
    '1',
]);

function isBackchannel(text) {
    if (typeof text !== 'string') return false;
    const words = foldPt(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (words.length === 0 || words.length > BACKCHANNEL_MAX_WORDS) return false;
    return words.every(w => BACKCHANNEL_WORDS.has(w));
}

// ---------------------------------------------------------------------------
// Pure helper: shouldTriggerAnswer (FR-001 + FR-004)
// Decision-only: does not manage debounce or abort — orchestrator does that.
// Returns false when:
//   - speaker is not 'them' (case-insensitive mic gate)
//   - text is only an acknowledgment or filler (isBackchannel)
//   - text is not a likely question, and carries no career cue
//   - normalized tail equals lastAnsweredTail (de-dup same question)
// Returns true otherwise (including when inFlight with new tail — the caller
// is responsible for aborting the in-flight request).
//
// hasCareerCue (optional) widens the question heuristic for statement-form
// career prompts ("your biggest weakness", career FR-007). The career module
// returns false while it is disabled, so the gate is then exactly today's.
// ---------------------------------------------------------------------------
function normalizeTail(text) {
    if (!text) return '';
    return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

function hasCue(hasCareerCue, text) {
    if (typeof hasCareerCue !== 'function') return false;
    try {
        return hasCareerCue(text) === true;
    } catch {
        return false;
    }
}

function shouldTriggerAnswer(speaker, text, lastAnsweredTail, inFlight, hasCareerCue) {
    // Speaker gate
    if (typeof speaker !== 'string' || speaker.toLowerCase() !== 'them') return false;
    // Acknowledgments and fillers want no answer (R19)
    if (isBackchannel(text)) return false;
    // Question heuristic, widened by career cues (career FR-007)
    if (!isLikelyQuestion(text) && !hasCue(hasCareerCue, text)) return false;
    // De-dup: same normalized tail as last answered
    const tail = normalizeTail(text);
    if (lastAnsweredTail !== null && lastAnsweredTail !== undefined && tail === lastAnsweredTail) return false;
    return true;
}

module.exports = {
    isLikelyQuestion,
    peelLead,
    leadsQuestion,
    hasContentCue,
    foldPt,
    EMBEDDED_Q_RE,
    normalizeTail,
    shouldTriggerAnswer,
    isBackchannel,
    BACKCHANNEL_MAX_WORDS,
};

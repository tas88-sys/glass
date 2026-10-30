'use strict';

// The live answer's question gate and extractQuestion, pure (no Electron): summaryService uses them,
// and scripts/replay-career-session.js replays real sessions through them.

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
// Pure helper: endsWithConfirmationCheck (spec 2026-10-16-confirmation-check-answer)
// True when the turn ends by only checking that the candidate is following:
// "…as próximas etapas são essas, está bem?", "…next week, okay?". The tag
// stands after a comma or period, or alone ("Tá?"); a name after it is kept
// out ("…está, Ana?"). A real session got a recap and an answer in the
// interviewer's voice for these; makeLiveAnswer then asks for one line.
// Says nothing about the rest of the turn: the model still sees a real question.
// ---------------------------------------------------------------------------
const CHECK_TAIL_RE = new RegExp(
    '(?:^|[,.;:!]\\s*)(?:(?:esta|ta)(?:\\s+(?:bem|bom|certo|ok|okay|claro))?|ok|okay|certo|beleza|combinado|' +
    'pode ser|tudo (?:bem|certo)|entendeu|entendido|ficou claro|faz sentido|ne|nao e|correto|' +
    'right|all right|alright|sounds? good|makes sense|got it|yeah)$'
);

function endsWithConfirmationCheck(text) {
    if (typeof text !== 'string') return false;
    const trimmed = text.trim();
    if (!trimmed.endsWith('?')) return false;
    const t = trimmed.slice(0, -1).trimEnd();
    if (CHECK_TAIL_RE.test(foldPt(t))) return true;
    // The STT capitalizes names: "…está, Ana?" / "…está Ana?".
    const unnamed = t.replace(/,?\s+\p{Lu}\p{Ll}+$/u, '');
    return unnamed !== t && CHECK_TAIL_RE.test(foldPt(unnamed));
}

// ---------------------------------------------------------------------------
// Question candidates (future-work item 9)
// The clauses of a turn that carry a question signal, ranked: tier 1 ends in
// '?', tier 2 is led by a question word or auxiliary (or an embedded one),
// tier 3 has only a content cue. A check ("tudo bem?", "beleza?"), a statement
// ending in a tag ("…o mesmo bytecode, não é?") or a hand-over ("pode falar",
// "go ahead") is flagged: it loses to any real candidate. extractQuestion picks from these, and the setup and reported
// rules below read them.
// ---------------------------------------------------------------------------
// The turn passing the floor back: a request to answer, not a question.
const HANDOVER_RE = /^(?:pode (?:falar|seguir|continuar|comecar|mandar)|(?:fique|fica) a vontade|manda ver|isso|go ahead|feel free|over to you|your turn|the floor is yours)$/;
// A tag that turns a statement into a check: "…o mesmo bytecode, não é?".
const TAG_TAIL_RE = /(?:^|[\s,.;:!])(?:nao e|ne|sabe|entendeu|certo|correto|right|okay|ok|isn'?t it|don'?t you think|you know)$/;

function foldedClause(clause) {
    return foldPt(String(clause || '')).replace(/[?.!,;:\s]+$/, '').trim();
}

function isHandover(clause) {
    return HANDOVER_RE.test(foldedClause(clause));
}

/** A clause that only checks the candidate is following, ends in a tag, or hands over the floor. */
function isCheckOrHandover(clause) {
    const t = foldedClause(clause);
    if (!t) return false;
    return HANDOVER_RE.test(t) || CHECK_TAIL_RE.test(t) || TAG_TAIL_RE.test(t);
}

/**
 * A sentence from its last comma part that leads a question to its end, peeled:
 * commas drop the framing ("Como arquiteta, ou mesmo antes disso, como que você
 * faz…") and keep a list inside the question ("retries, timeouts, and idempotency").
 * A hand-over at the end ("…Kafka, pode falar") is dropped first.
 */
function askingSpan(sentence) {
    const parts = sentence.split(',');
    while (parts.length > 1 && isHandover(peelLead(parts[parts.length - 1]))) parts.pop();
    for (let i = parts.length - 1; i > 0; i--) {
        const rest = peelLead(parts.slice(i).join(','));
        if (rest && leadsQuestion(rest)) return rest;
    }
    return peelLead(parts.join(','));
}

/**
 * The turn's question candidates, in order: { span, tier, check }, span the
 * peeled asking span (no '?').
 * Split on sentence ends and em-dashes, not commas: "with Go concurrency
 * (goroutines, channels, context) in production?" stays whole (live eval q084).
 */
function questionCandidates(text) {
    if (typeof text !== 'string') return [];
    const trimmed = text.trim();
    const out = [];
    const re = /[^.!?;\n—]+/g;
    let m;
    while ((m = re.exec(trimmed)) !== null) {
        const raw = m[0].trim();
        if (!raw) continue;
        const hasQuestionMark = trimmed[m.index + m[0].length] === '?';
        const check = isCheckOrHandover(raw);
        let span = askingSpan(raw);
        // A check peels to nothing ("Beleza", "Ok"): keep it as said.
        if (!span && check) span = raw;
        if (!span) continue;
        let tier = 0;
        if (hasQuestionMark) tier = 1;
        else if (leadsQuestion(span) || EMBEDDED_Q_RE.test(span)) tier = 2;
        else if (hasContentCue(span)) tier = 3;
        if (tier === 0) continue;
        out.push({ span, tier, check });
    }
    return out;
}

// ---------------------------------------------------------------------------
// Pure helper: extractQuestion (FR-006/FR-007/FR-009/FR-012)
// Given a raw transcription turn, extract the most-specific interrogative
// span: the Q: label, and the words the career search boosts.
//
// Algorithm (future-work item 9):
//   guard: non-string → ''; trim; empty → ''
//   rank the turn's question candidates (questionCandidates): tier 1 ends in
//   '?', tier 2 is led by a wh-word / auxiliary (or embedded), tier 3 has a
//   content cue only. Checks and hand-overs ("tudo bem?", "pode falar") lose
//   to any real tier 1 or 2 candidate.
//   take the highest tier present and the LAST clause within it, peeled;
//   a check alone is its own label ("Beleza?")
//   cue-only or no candidate → full trimmed text
// So "…você diz escalada pelo quê? … menos garbage collector atuando," gives
// the question, not the trailing fragment.
//
// Total / pure: never throws, never returns null/undefined. Non-empty input
// always yields non-empty output (falls back to the full trimmed turn).
// ---------------------------------------------------------------------------
function extractQuestion(text) {
    if (typeof text !== 'string') return '';
    const trimmed = text.trim();
    if (trimmed.length === 0) return '';

    const candidates = questionCandidates(trimmed);
    const pick = list => {
        const top = Math.min(...list.map(c => c.tier));
        return list.filter(c => c.tier === top).pop();
    };
    const real = candidates.filter(c => !c.check && c.tier <= 2);
    const checks = candidates.filter(c => c.check && c.tier <= 2);
    const best = real.length ? pick(real) : checks.length ? pick(checks) : null;
    // Leading discourse markers stay peeled ("And where are you based" →
    // "where are you based", G2); the '?' comes back when the turn had one.
    if (best) return best.tier === 1 ? best.span + '?' : best.span;

    // Fallback: full trimmed text (T3 cue-only, T4, T8 declarative, no strong signal)
    return trimmed;
}

// ---------------------------------------------------------------------------
// Pure helper: isSetupOnly (future-work item 9)
// True when the turn announces a scenario and asks nothing yet: "Tudo bem?
// Perfeito. Eu queria colocar um cenário, vamos imaginar que a gente tem um
// endpoint que recebe um CSV…". A real session answered that with a whole
// design two turns before the question. The caller holds the turn and quotes it
// with the question that follows. A scenario with its question ("Imagine X.
// How would you design it?") or with a task left after the setup words
// ("imagine you are designing…") is not one.
// ---------------------------------------------------------------------------
const SETUP_RE = new RegExp(
    '\\b(?:vamos imaginar|imagina que|imagine que|vamos supor que|suponha que|digamos que|' +
    '(?:eu )?(?:queria|quero|vou) (?:te )?(?:colocar|dar|passar|propor|trazer) (?:um|1) cenario|' +
    // "So let's say one specific member, but maybe you have an example…" asks.
    'let\'?s say,? (?:for (?:example|instance),? )?(?:that )?(?:you|we|there)|' +
    'imagine that|suppose that|picture this|here\'?s (?:the|a) scenario|' +
    'let me (?:set up|give you|describe) (?:a|the) scenario)\\b',
    'g'
);

// A task in the scenario itself: "imagine that you are designing…", "…precisa projetar".
const SETUP_TASK_RE = /\b(?:design|build|implement|architect|scal|optimi[sz]|refactor|debug)(?:e|es|ed|ing)?\b|\b(?:projetar|desenhar|implementar|construir|otimizar|escalar|modelar)\b/;

function isSetupOnly(text) {
    if (typeof text !== 'string') return false;
    const folded = foldPt(text);
    if (!new RegExp(SETUP_RE.source).test(folded)) return false;
    if (questionCandidates(text).some(c => !c.check && c.tier <= 2)) return false;
    const rest = folded.replace(SETUP_RE, ' ');
    return !hasContentCue(rest) && !SETUP_TASK_RE.test(rest);
}

// ---------------------------------------------------------------------------
// Pure helper: isReportedOnly (future-work item 9)
// True when every question of the turn sits inside reported or future speech:
// "…they probably are going to ask, like, could you explain why this? How
// would you change this?" A real session answered such a description of the
// next round with a war story. A question that asks the candidate directly
// ("tell me", "now", "me conta") or follows a pivot back to them ("but first",
// "mas antes") is not reported.
// ---------------------------------------------------------------------------
const REPORTED_FRAME_RE = new RegExp(
    // English: "they will ask", "they probably are going to ask", "maybe they will do, like"
    '\\b(?:they|he|she|someone|somebody|the (?:interviewers?|team|client|panel|hiring manager))' +
    '(?:\'ll)?(?:\\s+(?:will|might|may|could|would|can|are going to|is going to|are gonna|is gonna|gonna|probably|also|then|maybe|usually|often))+' +
    '\\s+(?:ask|say|do|check|require|expect|want)\\b|' +
    '\\b(?:they|he|she) (?:want|wants|would like|like) to (?:see|know|understand|hear)\\b|' +
    '\\b(?:things|stuff) (?:that )?they (?:\\w+ ){0,2}(?:check|ask|look for|look at|want)\\b|' +
    // Portuguese: "eles vão perguntar", "podem te perguntar", "eles querem ver"
    '\\b(?:eles|elas|ele|ela|o pessoal|o time|a equipe|o gestor|o entrevistador|alguem)' +
    '(?:\\s+(?:vao|vai|podem|pode|devem|deve|provavelmente|talvez|tambem|costumam|costuma))+' +
    '\\s+(?:te |lhe )?(?:perguntar|pedir|questionar|dizer|falar|olhar|checar|avaliar|querer saber)\\b|' +
    '\\b(?:vao|podem) te perguntar\\b|' +
    '\\b(?:eles|elas|ele|ela) (?:querem|quer|gostam de|gosta de) (?:ver|saber|entender|ouvir)\\b|' +
    '\\bcoisas que (?:eles|elas) (?:\\w+ ){0,2}(?:olham|checam|perguntam|avaliam)\\b',
    'g'
);
// Back to the candidate after a reported frame.
const PIVOT_RE = /\b(?:but first|before that|anyway|mas antes|antes disso|enfim|voltando)\b/g;
// A question put to the candidate now, even after a frame.
const DIRECT_RE = /\b(?:(?:tell|walk|give|show) (?:me|us)|me (?:conta|conte|fala|fale|explica|explique|diz|diga|mostra|mostre)|(?:right )?now|agora|today|hoje)\b/;

function matchStarts(re, folded) {
    const out = [];
    const g = new RegExp(re.source, 'g');
    let m;
    while ((m = g.exec(folded)) !== null) {
        out.push({ start: m.index, end: m.index + m[0].length });
        if (m[0].length === 0) g.lastIndex++;
    }
    return out;
}

/** The turn has reported or future speech in it ("they will ask", "eles vão perguntar"). */
function hasReportedFrame(text) {
    return typeof text === 'string' && matchStarts(REPORTED_FRAME_RE, foldPt(text.trim())).length > 0;
}

function isReportedOnly(text) {
    if (typeof text !== 'string') return false;
    const trimmed = text.trim();
    // Frames, pivots and candidates are all placed in the folded turn.
    const folded = foldPt(trimmed);
    const frames = matchStarts(REPORTED_FRAME_RE, folded);
    if (frames.length === 0) return false;
    const pivots = matchStarts(PIVOT_RE, folded);
    // The questions proper; a bare cue ("explain your reasoning", advice) only when there are none.
    const all = questionCandidates(trimmed).filter(c => !c.check);
    const asked = all.filter(c => c.tier <= 2);
    const real = asked.length ? asked : all;
    if (real.length === 0) return false;
    let from = 0;
    return real.every(c => {
        const span = foldPt(c.span);
        const at = folded.indexOf(span, from);
        const start = at < 0 ? folded.indexOf(span) : at;
        if (start >= 0) from = start + span.length;
        if (start < 0 || DIRECT_RE.test(span)) return false;
        // The frame may open the clause itself: "eles vão perguntar coisas como: por que…?"
        const frame = frames.filter(f => f.start < start + span.length).pop();
        if (!frame) return false;
        return !pivots.some(p => p.start >= frame.end && p.start < start);
    });
}

// ---------------------------------------------------------------------------
// Pure helper: shouldTriggerAnswer (FR-001 + FR-004)
// Decision-only: does not manage debounce or abort — orchestrator does that.
// Returns false when:
//   - speaker is not 'them' (case-insensitive mic gate)
//   - text is only an acknowledgment or filler (isBackchannel)
//   - text only sets up a scenario, or only quotes questions someone else
//     will ask (isSetupOnly, isReportedOnly; future-work item 9)
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
    // A scenario still being set up, or the questions of someone else (item 9)
    if (isSetupOnly(text) || isReportedOnly(text)) return false;
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
    endsWithConfirmationCheck,
    isCheckOrHandover,
    askingSpan,
    questionCandidates,
    extractQuestion,
    isSetupOnly,
    hasReportedFrame,
    isReportedOnly,
};

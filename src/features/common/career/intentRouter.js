'use strict';

// Deterministic intent router (FR-006, research R6). Provider-agnostic and pure:
// no LLM call, no fs.
//
// FROZEN (spec 2026-10-13-career-router-jev, R18): Jev (jevRouter.js) routes
// turns now; this router decides only when Jev cannot (no key, CAREER_ROUTER=
// regex, a network error, a timeout, an open circuit, low confidence), and
// stays the synchronous gate while Jev is off. Do not add cues for phrasings
// Jev misses: measure them with scripts/eval-career-kb.js --router jev and
// change the Jev criteria (jevClient.js) instead. stripCuePhrases still builds
// every retrieval query.
//
// Classifies one interviewer turn as
//   personal  — about the candidate's own background (inject notes)
//   company   — about the interviewer's company ("why us"; inject scoped notes)
//   ambiguous — hypothetical / habitual / opinion (inject only above a threshold)
//   general   — anything else (inject nothing; today's behavior)
//
// Cue tables are data: [ruleName, RegExp] pairs matched against
// normalizeForMatch(text) (accents folded, lowercase, contractions expanded,
// punctuation removed). The rule name is what the debug log shows; this module
// sends nothing anywhere (with Jev on, jevRouter.js sends the turn to TypeSafe).

const { normalizeForMatch } = require('./textNormalize');

const FOLLOW_UP_WINDOW_MS = 5 * 60 * 1000;
const FOLLOW_UP_MAX_WORDS = 10;

const YOU = '(?:voce|vc)';
// Activities a person is doing ("está participando", "anda buscando").
const DOING = '(?:participando|buscando|procurando|trabalhando|atuando|estudando|aplicando|conversando|considerando|liderando|usando|utilizando|desenvolvendo|fazendo|olhando|avaliando|entrevistando)';

const COMPANY_CUES = [
    ['company:why-us', /\bwhy (?:us|our company|this company|our team|join us)\b/],
    ['company:why-join', /\bwhy (?:do|would) you (?:want|like|wish) to (?:join|work (?:here|with us|for us|at|with))\b/],
    ['company:why-interested', /\bwhy (?:are you|you are) (?:interested|applying|excited)\b/],
    ['company:what-know-about-us', /\bwhat do you know about (?:us|our|the company|what we do)\b/],
    ['company:this-role', /\byou\b.*\b(?:this|our) (?:role|position|opportunity|job opening)\b/],
    ['company:what-think-of-us', /\bwhat do you think (?:of|about) (?:\w+ ){0,3}(?:us|our company|the company)\b/],
    ['company:pt-por-que-trabalhar', new RegExp(`\\bpor ?que (?:${YOU} )?(?:quer|gostaria de|deseja|pensa em) (?:trabalhar|entrar|fazer parte|se juntar)\\b`)],
    ['company:pt-sobre-a-gente', /\b(?:sobre|conhece|conhecia) a gente\b|\b(?:sobre|da|de) (?:nossa|a nossa) empresa\b/],
    ['company:pt-com-a-gente', /\b(?:contato|trabalhar|trabalhando|entrar|conversando|conversar) com a gente\b/],
    ['company:pt-essa-vaga', /\b(?:nessa|nesta|essa|esta|dessa|desta) (?:vaga|posicao|oportunidade)\b/],
    ['company:pt-o-que-acha-da-empresa', new RegExp(`\\bo que ${YOU} acha d[ao] (?:\\w+ ){0,3}(?:empresa|companhia|gente)\\b`)],
];

const PERSONAL_CUES = [
    // Behavioral framing
    ['behavioral:tell-me-about-a-time', /\b(?:tell|walk) (?:me|us) (?:\w+ )?(?:about|through) (?:a|an|one|the) (?:time|situation|moment|occasion|example|instance|project|case)\b/],
    ['behavioral:a-time-when', /\b(?:a|one|the last) (?:time|occasion|instance) (?:when|where|that|in which|you)\b/],
    ['behavioral:example-when-you', /\bexample (?:of )?(?:a time|when you|where you|from your|in which you|of how you)\b/],
    ['behavioral:have-you-ever', /\bhave you (?:ever|been)\b/],
    // Background
    ['background:about-yourself', /\b(?:about|introduce|describe|present) yourself\b/],
    ['background:tell-me-about-your', /\b(?:tell|walk|talk) (?:me|us) (?:\w+ )?(?:about|through) your\b/],
    ['background:what-you-do', /\bwhat (?:do|are) you (?:do|doing|working on|currently|building|focused on)\b|\bwhat (?:kind|type) of (?:work|projects|role) (?:do|did|are) you\b/],
    ['background:fragment', /^(?:and |so )?(?:any|some|much|prior|previous|professional|hands on) (?:experience|exposure|background) (?:with|in|on|using)\b|^(?:and |so )?(?:current|expected|desired) (?:salary|compensation|role|company|employer|stack|location)\b/],
    ['background:your-career', /\byour (?:background|career|resume|cv|experience|journey|trajectory|track record|professional|story|path|workflow|workflows|routine|tooling|stack(?! trace))\b/],
    ['background:your-role', /\byour (?:\w+ )?(?:current|previous|last|past|former|first|main|day to day|daily) (?:role|job|position|company|employer|team|project|manager|work|responsibilities|duties)\b|\byour (?:\w+ )?(?:responsibilities|duties|tech stack)\b/],
    ['background:your-trait', /\byour (?:biggest|greatest|main|key|top|best|worst|proudest|major) (?:weakness|weaknesses|strength|strengths|achievement|achievements|accomplishment|challenge|failure|mistake|win|contribution|lesson|regret|impact|project|projects)\b/],
    ['background:your-strengths', /\byour (?:strengths|weaknesses|strong points|weak points|achievements|accomplishments)\b/],
    ['background:proud', /\bproud (?:of|about)\b|\bproudest\b/],
    ['background:what-was-your-role', /\bwhat (?:was|is|were) your (?:role|part|contribution|responsibility|title|impact)\b/],
    // Past tense asks about what the candidate did ("What was your biggest project?").
    // Present "what is your ..." stays out: it is often an opinion ("your approach"), an ambiguous cue.
    ['background:what-was-your', /\b(?:what|which) (?:was|were) your\b|\bwhat (?:has|have) been your\b/],
    ['background:in-your-last', /\bin your (?:last|current|previous|past|former) \w+/],
    ['background:good-at', /\b(?:are you|you are|you would be|would you be) (?:\w+ )?(?:good|strong|great|best) (?:at|in)\b/],
    ['background:why-leaving', /\bwhy (?:are you|did you|do you want to|would you) (?:\w+ )?(?:leav|look|chang|switch|mov|quit)\w*/],
    ['background:future', /\bwhere do you see yourself\b|\bwhat motivates you\b|\bwhat are you looking for\b/],
    ['background:logistics', /\b(?:salary|compensation|pay) (?:expectation|expectations|range|requirement|requirements)\b|\bnotice period\b|\bwhen (?:can|could) you start\b/],
    ['background:where-based', /\bwhere (?:are you|do you) (?:based|located|from|live)\b/],
    // Experience (second person, past or perfect)
    ['experience:have-you', /\bhave you (?:\w+ )?(?:worked|used|led|built|managed|designed|implemented|handled|dealt|had|done|seen|faced|run|shipped|owned|migrated|written|mentored|deployed|scaled|introduced|tried|been|set up|adopted|automated|maintained|integrated|launched|contributed|coached|hired|interviewed|taught|trained|supported|architected|standardized|standardised)\b/],
    ['experience:did-you', /\b(?:did|were) you (?!know\b|understand\b|hear\b|see\b|catch\b|get (?:that|it|me)\b|mean\b|say\b)\w+/],
    ['experience:you-past', /\byou (?:have |had )?(?:worked|led|built|managed|designed|implemented|handled|faced|chose|decided|learned|learnt|delivered|shipped|owned|migrated|created|wrote|mentored|solved|resolved|fixed|improved|reduced|increased|joined|left|started|dealt|convinced|disagreed|failed|ran|drove|introduced|proposed|influenced|debugged|scaled|optimized|optimised|launched|deployed|architected|refactored|onboarded|hired|received|spent|had to|were (?:responsible|in charge|the))\b/],
    ['experience:do-you-have', /\b(?:do|did) you have (?:\w+ ){0,3}(?:experience|exposure|background|knowledge)\b|\byears of experience\b|\bhow (?:much|many years of) experience\b|\bare you familiar with\b/],
    // English twins of the Portuguese present-tense and job cues below ("Do you work
    // remotely?", "Are you interviewing elsewhere?"). "How do you work with X?" asks for an
    // approach, an ambiguous cue, as in Portuguese.
    ['experience:do-you-now', /(?<!\bhow )\bdo you (?:currently |still |now |also |usually |normally |actually )?(?:work|live|lead|manage|speak|report|code|program|deliver|ship|mentor)\b|(?<!\b(?:do|does|did|would|could|will|should|can|might|to) )\byou (?:currently |now |still )?work (?:with|on|for|at|in)\b|\breport(?:s|ing)? to you\b/],
    ['experience:are-you-now', /\bare you (?:currently |still |also |actively |now |already )?(?:interviewing|working|looking|applying|talking|speaking|open|available|willing|planning|participating|leading|managing|based|employed|in (?:other|any|another|a) (?:\w+ )?process(?:es)?)\b/],
    ['experience:how-long', /\bhow long (?:have|had|did) you\b|\byou\b.*\bfor how long\b/],
    ['background:your-people', /\byour (?:\w+ )?(?:company|employer|manager|managers|boss|peers|colleagues|teammates|coworkers|co workers|tech lead|reports|direct reports)\b|\bat work\b/],
    ['background:why-change', /\b(?:reason|reasons|motivation)(?: why)? (?:that )?you\b(?: \w+){0,4} (?:leav|chang|mov|switch|quit|look\w* (?:for|around|elsewhere)|open to)\w*|\bwhat (?:would|could|might|made|makes|is making) (?:make )?you\b(?: \w+){0,3} (?:leav|chang|mov|switch|quit|look\w* (?:for|around|elsewhere)|open to)\w*/],
    ['background:start-date', /\bhow (?:soon|quickly|long|much time) (?:would|could|will|can|do) you (?:\w+ ){0,4}(?:start|join|be available)\b|\b(?:after|once) (?:you )?(?:get|getting|receive|receiving|accept|accepting) (?:an|the|our) offer\b/],
    ['background:do-well', /\byou (?:would|could|will|might) (?:do|perform) (?:\w+ )?(?:well|great|best)\b|\byou (?:would|could|will) (?:shine|excel|stand out)\b|\bwe (?:have not|did not) (?:yet )?(?:covered|discussed|talked about|asked (?:you )?about)\b/],
    // "Tell me about a launch that went well": a request about something that happened.
    ['behavioral:tell-me-about-a-past', /\b(?:tell|talk) (?:me|us) (?:\w+ )?about (?:a|an|one|some) (?:\w+ ){1,4}(?:that|which) (?:\w+ )?(?:went|worked|failed|succeeded|broke|shipped|launched|happened|turned out|saved|changed|grew|scaled)\b/],
    ['behavioral:example-having-to', /\bexample (?:of )?(?:having to|having had to|you had to|you needed to)\b|\b(?:do|did) you have (?:an|a|any|one|some) (?:\w+ )?(?:example|story|situation|instance)s?\b/],
    // Portuguese
    ['behavioral:pt-uma-vez', /\b(?:uma|alguma) (?:vez|situacao|ocasiao|experiencia|historia) (?:em que|que|onde|na qual|quando)\b/],
    ['behavioral:pt-um-momento', /\b(?:um|algum) (?:momento|exemplo|caso|projeto) (?:em que|que|onde|no qual|quando|de quando)\b/],
    ['behavioral:pt-de-um-exemplo', /\b(?:me )?(?:de|da) (?:um exemplo|(?:alguns |uns )?exemplos)(?: (?:de quando|em que|seu|sua|seus|suas|real|reais|pessoal|pessoais|pratico|praticos|concreto|concretos)\b|$)/],
    // "Cases de sucesso", "histórias de fracasso": stories the candidate lived. "Casos de
    // falha" stays out: in a technical question it means failure modes.
    ['behavioral:pt-cases', /\b(?:cases?|historias?) de (?:sucesso|falha|fracasso|insucesso)\b|\b(?:casos?|exemplos?) de (?:sucesso|fracasso|insucesso)\b/],
    ['behavioral:success-stories', /\b(?:success|failure) stor(?:y|ies)\b/],
    ['behavioral:pt-ja-aconteceu', /\bja aconteceu (?:de|com voce|com vc)\b/],
    ['background:pt-fale-de-voce', new RegExp(`\\b(?:fale|fala|conte|conta)(?: (?:um pouco|mais))? (?:sobre|de) (?:${YOU}|sua|seu|suas|seus|tua|teu)\\b`)],
    ['behavioral:pt-conte-sobre-um-passado', new RegExp(`\\b(?:conte|conta|fale|fala)(?: um pouco| mais)? (?:sobre|de) (?:um|uma|algum|alguma) (?:\\w+ ){1,4}que (?:${YOU} )?(?:ja )?(?:\\w+ou|\\w+eu|\\w+iu|deu|fez|foi|teve|trouxe|disse|quis|veio|pos|soube)\\b`)],
    ['background:pt-apresente', /\b(?:se apresent\w*|apresente se|apresenta se)\b/],
    ['background:pt-sua-trajetoria', /\b(?:sua|tua) (?:experiencia|trajetoria|carreira|historia|jornada|formacao|funcao|rotina|stack|maior|principal|ultima|atual|atuacao|contribuicao)\b/],
    ['background:pt-seu-momento', /\b(?:seu|teu) (?:momento|maior|principal|ultimo|atual|trabalho|emprego|cargo|papel|time|projeto|perfil|curriculo|background|ponto|pacote)\b/],
    // Only nouns that name a person's record: "seus/suas" is also "its" ("Kafka e seus
    // desafios"), so "desafios", "impactos" and "resultados" alone stay out.
    ['background:pt-seus-pontos', /\b(?:seus|suas|teus|tuas) (?:\w+ )?(?:pontos|qualidades|defeitos|conquistas|realizacoes|experiencias|projetos|responsabilidades|contribuicoes|aprendizados)\b/],
    // "Um dos seus desafios", "qual das suas entregas": picking one from the candidate's own.
    ['background:pt-um-dos-seus', /\b(?:um|uma|algum|alguma|qual|quais) (?:dos|das) (?:seus|suas|teus|tuas)\b/],
    ['background:pt-salario', /\b(?:salario|salarial|remuneracao|pretensao|beneficios)\b/],
    ['background:pt-mudar', /\b(?:por ?que|qual (?:e )?o motivo|o que (?:e que )?(?:te )?(?:faria|faz|levaria))\b.*\b(?:mudar|sair|saindo|deixar|trocar|mudanca)\b/],
    ['background:pt-comecar', /\bquanto tempo (?:\w+ )?precisaria\b|\bquando (?:voce |vc )?(?:pode|poderia) comecar\b|\breceber (?:uma|a) oferta\b/],
    ['background:pt-onde-mora', new RegExp(`\\bonde (?:${YOU} )?(?:mora|vive)\\b`)],
    ['background:pt-voce-e-de', new RegExp(`\\b${YOU} e (?:de|da|do|dos|das|daqui|natural de)\\b`)],
    ['background:pt-orgulho', /\borgulh\w*/],
    ['background:pt-manda-bem', new RegExp(`\\b${YOU} (?:\\w+ )?(?:mandaria|manda|se sairia|seria|e|iria) (?:bem|forte|bom|boa)\\b`)],
    ['background:pt-ainda', /\bainda (?:trabalha|esta|atua)\b/],
    ['experience:pt-ha-quanto-tempo', /\bha quanto tempo\b|\bquantos anos de\b|\banos de experiencia\b/],
    ['experience:pt-tem-experiencia', /\b(?:tem|teve|possui|possuiu) (?:\w+ )?experiencia\b/],
    ['experience:pt-voce-past', new RegExp(`\\b${YOU} (?:ja |se |nao |tambem |ainda |chegou a )?\\w{2,}(?:ou|eu|iu)\\b`)],
    ['experience:pt-voce-irregular', new RegExp(`\\b${YOU} (?:ja )?(?:trouxe|fez|disse|teve|esteve|foi|quis|veio|pos|soube)\\b`)],
    ['experience:pt-voce-presente', new RegExp(`\\b${YOU} (?:mora|vive|trabalha|atua|(?:esta|estava|anda) ${DOING})\\b`)],
    // "Used to" tense: any -ar verb in -ava ("tomava", "liderava"), plus common -er/-ir
    // verbs listed by name: a bare -ia would also catch present tense ("gerencia",
    // "negocia") and conditionals ("faria"), which are not about past experience.
    ['experience:pt-voce-imperfeito', new RegExp(`\\b${YOU} (?:ja |tambem |ainda |nao |sempre )?(?:\\w+ava|era|tinha|vinha|fazia|dizia|podia|escrevia|resolvia|atendia|mantinha|decidia|definia|conduzia|construia|desenvolvia|dividia|seguia|recebia|escolhia|corrigia|entendia|aprendia|respondia|percebia|produzia|mexia)\\b`)],
    ['experience:pt-voces', /\bvoces (?:\w+ )?(?:\w+am|\w+em)\b/],
    ['experience:pt-ja-past', /\bja \w{2,}(?:ou|eu|iu)\b/],
    // Implied subject: Portuguese drops "você" ("Trabalha remoto hoje?", "Conhece Kafka?").
    // "Usa-se X" is impersonal, not about the candidate.
    ['experience:pt-implied-subject', /^(?:e |entao |mas )?(?:hoje |atualmente |ainda |ja |tambem )?(?:trabalha|atua|mora|usa|utiliza|conhece|possui|programa|desenvolve|lidera|gerencia|codifica|estuda|faz parte)\b(?! se\b)/],
    // "Está participando de outros processos?" Only activities a person does, so
    // "está funcionando?" (a thing) stays general.
    ['experience:pt-implied-doing', new RegExp(`^(?:e |entao |mas )?(?:hoje |atualmente |ainda |ja |tambem )?(?:esta|estava|anda) ${DOING}\\b`)],
    ['experience:pt-implied-past', /^(?:e |entao |mas )?(?:ja )?(?:precisou|teve que|teve de|chegou a|participou|atuou|liderou|trabalhou|usou|utilizou|lidou|enfrentou)\b(?! se\b)/],
    // "Tem algum exemplo de adaptação que precisou fazer?": an example the candidate lived.
    ['behavioral:pt-exemplo-que', new RegExp(`\\b(?:algum|alguma|um|uma) (?:exemplo|caso|situacao|momento|vez|historia|experiencia)\\b(?: \\w+){0,4} que (?:${YOU} )?(?:ja )?(?:precisou|teve que|teve de|conseguiu|lidou|enfrentou|fez|liderou|tomou|participou|passou|chegou a)\\b`)],
    // "Como você gerencia X?" asks for an approach (ambiguous), not a fact.
    ['experience:pt-voce-habito', new RegExp(`(?<!\\bcomo (?:que )?)\\b${YOU} (?:hoje |atualmente |ainda |tambem )?(?:faz|fazia|trabalhava|atuava|cuida|cuidava|usa|usava|utiliza|utilizava|lidera|liderava|gerencia|programa|desenvolve|conhece|gosta)\\b`)],
    ['background:pt-o-que-faz', new RegExp(`\\b(?:o que|no que|com o que) (?:${YOU} )?(?:faz|trabalha|atua|esta fazendo|esta trabalhando)\\b|\\b(?:seu|teu) dia a dia\\b`)],
];

const AMBIGUOUS_CUES = [
    ['hypothetical:how-would-you', /\b(?:how|what|which|where|when|why|who) would you\b|\bwould you (?:rather|prefer|choose|use|recommend|do|handle|approach)\b/],
    ['hypothetical:how-you-would', /\bhow you would\b/],
    ['hypothetical:if-you', /\bif you (?:were|had to|could|need to|needed to|join|joined)\b/],
    ['hypothetical:imagine', /\b(?:imagine|suppose|assume) (?:that )?you\b|\blet (?:is|us) say\b|\blets say\b/],
    // A turn that opens on "do you" counts too: the STT often drops a leading
    // "how" ("Do you ensure the reliability of a system?").
    ['habitual:how-do-you', /(?:\bhow |^(?:and |so )?)do you (?:\w+ )?(?:approach|handle|deal|manage|decide|prioritize|prioritise|ensure|keep|structure|organize|organise|balance|measure|review|onboard|mentor|go about|think about|adapt|stay|learn|grow|motivate|communicate|explain|give|receive|resolve|estimate|plan|lead|work with|make sure|raise|develop|level up|upskill|coach|support|help|teach|train|share|spread)\b/],
    // "Give an example." closing a turn, and "your team", also open technical prompts
    // ("What's a closure? Give an example.", "Your team needs to process...").
    ['habitual:give-an-example', /\b(?:give|share) (?:me |us )?(?:an|one|a|some) (?:real |concrete |specific |practical |personal )?examples?$/],
    ['habitual:your-team', /\byour (?:\w+ )?teams?\b/],
    ['habitual:which-do-you-use', /\b(?:which|what) (?:\w+ ){0,3}(?:do|did) you (?:currently |usually |mostly |normally )?(?:use|prefer|pick|choose|reach for)\b/],
    ['opinion:your-take', /\b(?:what is|what are) your (?:approach|opinion|take|view|views|philosophy|process|strategy|preference|favorite|favourite|go to|thoughts)\b|\byour (?:thoughts|opinion|take|view) on\b|\bin your (?:opinion|view)\b|\bwhat do you think (?:about|of)\b|\bdo you (?:prefer|like|think|believe|agree)\b/],
    ['hypothetical:pt-faria', new RegExp(`\\b(?:como|o que|qual|onde|quando|por que) (?:${YOU} )?\\w+(?:aria|eria|iria)\\b`)],
    ['hypothetical:pt-se-voce', new RegExp(`\\bse (?:${YOU} )?\\w+(?:asse|esse|isse)\\b|\\bse (?:${YOU}) (?:fosse|tivesse|pudesse|precisasse)\\b`)],
    ['habitual:pt-como-voce', new RegExp(`\\bcomo (?:que )?${YOU}\\b`)],
    ['opinion:pt-opiniao', new RegExp(`\\b(?:qual|qual e) (?:a )?(?:sua|tua) (?:opiniao|visao|abordagem|preferencia)\\b|\\bna (?:sua|tua) (?:opiniao|visao)\\b|\\bo que ${YOU} acha\\b|\\b${YOU} prefere\\b`)],
    // "Tell me about a migration you…" usually means one the candidate lived, but "a" plus
    // any noun also opens technical asks ("tell me about a hash map"): notes only if close.
    // "Tell me about the CAP theorem" stays general.
    ['open:tell-me-about-a', /\b(?:tell|talk) (?:me|us) (?:\w+ )?about (?:a|an|one|some) \w+/],
    ['open:pt-conte-sobre-um', /\b(?:conte|conta|fale|fala)(?: um pouco| mais)? (?:sobre|de) (?:um|uma|algum|alguma) \w+/],
];

const FOLLOW_UP_MARKERS = [
    /\bwhat was the (?:outcome|result|impact|end result|takeaway|lesson)\b/,
    /\bhow did (?:that|it|this) (?:go|end|turn out|work out|play out)\b/,
    /\band then\b/,
    /\band after that\b/,
    /\bwhat happened (?:next|then|after|afterwards)\b/,
    /\bwhat did you learn\b/,
    /\bwhat would you do differently\b/,
    /\bwhy did you (?:do|choose|pick) that\b/,
    /\be ai\b/,
    /\be depois\b/,
    /\bqual foi o (?:resultado|impacto)\b/,
    /\be o resultado\b/,
    /\bo que aconteceu (?:depois|em seguida|entao)\b/,
    /\bcomo (?:terminou|acabou)\b/,
    new RegExp(`\\bo que ${YOU} aprendeu\\b`),
];

// Framing phrases removed from the retrieval query (FR-008). Content words
// ("weakness", "migration") stay; only the question's wrapper goes.
const FRAMING = [
    // Company questions: the wrapper is the whole question ("why do you want to
    // join us"); the active company's name supplies the query instead (FR-011).
    /\bwhy (?:do|would) you (?:want|like|wish) to (?:join|work)(?: (?:here|with|for|at))?\b/g,
    /\bwhy (?:are you|you are) (?:interested|applying|excited)(?: (?:in|to|for|about))?\b/g,
    /\bwhat do you know about\b/g,
    new RegExp(`\\bpor ?que (?:${YOU} )?(?:quer|gostaria de|deseja|pensa em) (?:trabalhar|entrar|fazer parte|se juntar)(?: (?:aqui|com a gente|conosco|na|no))?\\b`, 'g'),
    new RegExp(`\\bo que ${YOU} (?:sabe|conhece) (?:sobre|da|de)\\b`, 'g'),
    // Experience questions: "have you worked with X" is about X.
    /\b(?:have|had) you (?:ever )?(?:worked|used|dealt|done|had)(?: (?:with|on|in))?\b/g,
    /\b(?:do|did) you have (?:any )?(?:\w+ ){0,2}(?:experience|exposure)(?: (?:with|in|on))?\b/g,
    new RegExp(`\\b(?:${YOU} )?ja (?:trabalhou|usou|utilizou|atuou|teve|fez|precisou|lidou|passou)(?: (?:com|em|por|de))?\\b`, 'g'),
    new RegExp(`\\b(?:${YOU} )?(?:tem|teve|possui) (?:alguma |muita )?experiencia(?: (?:com|em))?\\b`, 'g'),
    new RegExp(`\\bcomo (?:${YOU} )?lidou\\b|\\bquais (?:acoes|atitudes|medidas) (?:${YOU} )?tomou\\b`, 'g'),
    /\b(?:can|could|would) you (?:please )?(?:tell|walk|talk|give|share|describe)(?: (?:me|us))?\b/g,
    /\b(?:tell|walk|talk) (?:me|us) (?:\w+ )?(?:about|through)\b/g,
    /\b(?:tell|give|show) (?:me|us)\b/g,
    /\b(?:describe|share|explain)\b/g,
    /\b(?:an|one|a good|a specific) example (?:of|from|when)?\b/g,
    /\b(?:a|one|the last|the) (?:time|situation|moment|occasion|instance) (?:when|where|that|in which)?\b/g,
    /\bhave you ever\b/g,
    /\bi (?:would|d) (?:like|love) to hear (?:about)?\b/g,
    /\b(?:me )?(?:conta|conte|fala|fale)(?: (?:um pouco|mais))?(?: (?:sobre|de|pra mim|pra gente))?\b/g,
    /\b(?:pode|poderia) (?:me )?(?:contar|falar|compartilhar|descrever|dar)\b/g,
    /\b(?:me )?(?:de|da) (?:um exemplo|(?:alguns |uns )?exemplos)(?: de)?\b/g,
    /\bde (?:forma|maneira|modo) (?:rapida|breve|resumida|objetiva|sucinta|direta)(?: e (?:rapida|breve|resumida|objetiva|sucinta|direta))?\b/g,
    /\b(?:uma|alguma) (?:vez|situacao|ocasiao|experiencia) (?:em que|que|onde|na qual|quando)?\b/g,
    /\b(?:um|algum) (?:momento|exemplo|caso) (?:em que|que|onde|no qual|quando|de quando)?\b/g,
    /\b(?:descreva|compartilhe|explique)\b/g,
    /\bgostaria de (?:saber|ouvir)\b/g,
];

function compileNames(names) {
    const out = [];
    for (const n of Array.isArray(names) ? names : []) {
        if (typeof n !== 'string') continue;
        const words = normalizeForMatch(n).split(' ').filter(Boolean);
        if (!words.length) continue;
        // "Harbor Lights" also matches "harborlights" (STT often drops the space).
        out.push({ name: n, len: words.join('').length, re: new RegExp(`\\b${words.join(' ?')}\\b`) });
    }
    return out.sort((a, b) => b.len - a.len);
}

// Name lists are small and stable for a session; cache their compiled form.
const nameCache = new Map();
function compiledNames(names) {
    const key = Array.isArray(names) ? names.join('\u0001') : '';
    let hit = nameCache.get(key);
    if (!hit) {
        if (nameCache.size > 32) nameCache.clear();
        hit = compileNames(names);
        nameCache.set(key, hit);
    }
    return hit;
}

function firstMatch(cues, s) {
    for (const [name, re] of cues) if (re.test(s)) return name;
    return null;
}

function companyNameCue(s, companies) {
    for (const { re } of compiledNames(companies)) {
        const m = s.match(re);
        if (!m) continue;
        const before = s.slice(0, m.index);
        if (/\b(?:conhece|conhecia|ouviu falar|heard (?:of|about)|know about|join|joining|trabalhar (?:na|no|em)|entrar (?:na|no))\s*(?:a |o |da |do |de )?$/.test(before)) {
            return 'company:named';
        }
    }
    return null;
}

/**
 * @param {string} text
 * @param {{ prev?: {route:string, ts:number, queryTerms?:string[]}|null, entities?: string[], companies?: string[], now?: number }} [ctx]
 * @returns {{ route: 'personal'|'company'|'ambiguous'|'general', cue: string|null }}
 */
function classifyCareerIntent(text, ctx = {}) {
    const general = { route: 'general', cue: null };
    if (typeof text !== 'string') return general;
    const s = normalizeForMatch(text);
    if (!s) return general;
    const c = ctx || {};

    const company = firstMatch(COMPANY_CUES, s) || companyNameCue(s, c.companies);
    if (company) return { route: 'company', cue: company };

    const prev = c.prev;
    if (prev && (prev.route === 'personal' || prev.route === 'company') && Number.isFinite(prev.ts)) {
        const now = Number.isFinite(c.now) ? c.now : Date.now();
        const words = s.split(' ').length;
        if (now - prev.ts <= FOLLOW_UP_WINDOW_MS && words <= FOLLOW_UP_MAX_WORDS && FOLLOW_UP_MARKERS.some(re => re.test(s))) {
            return { route: prev.route, cue: 'follow-up' };
        }
    }

    const personal = firstMatch(PERSONAL_CUES, s);
    if (personal) return { route: 'personal', cue: personal };
    if (compiledNames(c.entities).some(({ re }) => re.test(s))) return { route: 'personal', cue: 'entity' };

    const ambiguous = firstMatch(AMBIGUOUS_CUES, s);
    if (ambiguous) return { route: 'ambiguous', cue: ambiguous };

    return general;
}

/** Turn text minus framing phrases, normalized (FR-008). */
function stripCuePhrases(text) {
    if (typeof text !== 'string') return '';
    let s = normalizeForMatch(text);
    for (const re of FRAMING) s = s.replace(re, ' ');
    return s.replace(/\s+/g, ' ').trim();
}

/** FR-007: a personal or company cue on the turn alone (no follow-up context). */
function hasCareerCue(text, entities, companies) {
    const { route } = classifyCareerIntent(text, { entities, companies });
    return route === 'personal' || route === 'company';
}

module.exports = {
    classifyCareerIntent,
    stripCuePhrases,
    hasCareerCue,
    FOLLOW_UP_WINDOW_MS,
    FOLLOW_UP_MAX_WORDS,
    // Exposed for the eval script and future tuning (cue tables are data).
    COMPANY_CUES,
    PERSONAL_CUES,
    AMBIGUOUS_CUES,
    FOLLOW_UP_MARKERS,
};

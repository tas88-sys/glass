'use strict';

// Phase L: every Ask mode answers in the interview's language (future-work
// 18.11, rule 11). Each case is one Ask with a screenshot, sent as askService
// sends it: the interviewer's turns decide the language (askLanguage.js), then
// the typed text, then the speech-to-text language while Listen runs. Only
// System Design · Live puts the turns in its prompt; the other modes still get
// no transcript, as in the app. The headings and the code stay in English.
// Generic content only.

const PT_CODING = [
    'them: Agora vamos para a parte de código. Você consegue compartilhar a tela?',
    'me: Claro, já estou compartilhando.',
    'them: Ótimo. Dá uma olhada no problema que está na tela e me fala como você resolveria.',
];
const EN_CODING = [
    'them: Let\'s move on to the coding part. Can you share your screen?',
    'me: Sure, it is shared.',
    'them: Great. Take a look at the problem on the screen and tell me how you would solve it.',
];

const CASES = [
    {
        // The interview wins over an English request.
        id: 'L1-default-pt',
        mode: 'default',
        history: [
            'them: Esse é o painel de pagamentos dos últimos minutos.',
            'me: Certo, estou vendo.',
            'them: Me conta o que deu errado aqui e o que você olharia primeiro.',
        ],
        userPrompt: 'Which request failed on this screen, how long did it take and what was the error code?',
        image: 'ask-image.svg',
        lang: 'pt',
        imageFacts: true,
    },
    {
        // Ctrl+Enter with nothing typed, the problem in English on the screen.
        id: 'L2-code-pt',
        mode: 'code',
        history: PT_CODING,
        userPrompt: '',
        image: 'code-problem.svg',
        lang: 'pt',
        code: { language: 'javascript', execute: true },
    },
    {
        id: 'L3-debug-pt',
        mode: 'debug',
        history: [
            'them: Esse teste está falhando desde ontem.',
            'me: Deixa eu ver o código.',
            'them: Você consegue achar o erro e me explicar como corrigiria?',
        ],
        userPrompt: '',
        image: 'debug-code.svg',
        lang: 'pt',
        debug: true,
    },
    {
        id: 'L4-system-design-pt',
        mode: 'system_design',
        history: [
            'them: Agora vamos para a parte de design de sistemas.',
            'me: Combinado.',
            'them: Quero que você desenhe o sistema que está na tela, com os requisitos que estão ali.',
        ],
        userPrompt: '',
        image: 'system-design.svg',
        lang: 'pt',
        systemDesign: true,
    },
    {
        // The other way: an English interview, a request typed in Portuguese.
        id: 'L5-code-en',
        mode: 'code',
        history: EN_CODING,
        userPrompt: 'Resolva esse problema.',
        image: 'code-problem.svg',
        lang: 'en',
        code: { language: 'javascript', execute: true },
    },
    {
        id: 'L6-default-en',
        mode: 'default',
        history: [
            'them: This is the payments dashboard for the last few minutes.',
            'me: Okay, I can see it.',
            'them: Tell me what went wrong here and what you would check first.',
        ],
        userPrompt: 'Qual pedido falhou nessa tela?',
        image: 'ask-image.svg',
        lang: 'en',
    },
    {
        // A turn too short to tell and a fixed word: the STT language decides.
        id: 'L7-sd-live-stt',
        mode: 'system_design_live',
        history: ['them: Vamos desenhar o Twitter.'],
        userPrompt: 'opening',
        image: 'desktop.svg',
        sttLanguage: 'pt-BR',
        lang: 'pt',
        expectRoute: 'opening',
    },
];

module.exports = { CASES };

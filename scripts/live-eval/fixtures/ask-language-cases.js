'use strict';

// Phase L: every Ask mode answers in the interview's language (future-work
// 18.11, rule 11). Each case is one Ask with a screenshot, sent as askService
// sends it: the speech-to-text language (sttLanguage) names the language
// (askLanguage.js), whatever the turns or the typed text say. The turns are
// the interview's, as Listen would hear it in that language; only System
// Design · Live puts them in its prompt, the other modes get no transcript, as
// in the app. The headings and the code stay in English. Generic content only.

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
        sttLanguage: 'pt-BR',
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
        sttLanguage: 'pt-BR',
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
        sttLanguage: 'pt-BR',
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
        sttLanguage: 'pt-BR',
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
        sttLanguage: 'en-US',
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
        sttLanguage: 'en-US',
        lang: 'en',
    },
    {
        // The practice of 2026-11-04: `twitter` typed with Listen off (no
        // transcript) and the setting in Portuguese got an English kit.
        id: 'L7-sd-live-twitter',
        mode: 'system_design_live',
        history: [],
        userPrompt: 'twitter',
        image: 'desktop.svg',
        sttLanguage: 'pt-BR',
        lang: 'pt',
        expectRoute: 'opening',
    },
];

module.exports = { CASES };

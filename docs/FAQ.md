# Perguntas frequentes sobre o Glass

Respostas tiradas do código em 2026-10-18 (commit `755e3cc`). Os caminhos com número de linha
apontam para onde cada comportamento mora; se o código mudar, confira lá antes de confiar no texto.

- [1. Quando o conteúdo da pasta `estudos` entra no Live Answer?](#1-quando-o-conteúdo-da-pasta-estudos-entra-no-live-answer)
- [2. O Live Answer lembra da conversa inteira?](#2-o-live-answer-lembra-da-conversa-inteira)
- [3. O app usa a SDK da TypeSafe?](#3-o-app-usa-a-sdk-da-typesafe)
- [4. Qual o peso entre busca semântica e BM25?](#4-qual-o-peso-entre-busca-semântica-e-bm25)
- [5. O app usa re-ranking, como RRF?](#5-o-app-usa-re-ranking-como-rrf)
- [6. Fine-tuning e os scripts de eval não são a mesma coisa?](#6-fine-tuning-e-os-scripts-de-eval-não-são-a-mesma-coisa)
- [7. O app usa golden set nas evals?](#7-o-app-usa-golden-set-nas-evals)
- [8. Postgres tem fila como os message brokers, com LISTEN e NOTIFY?](#8-postgres-tem-fila-como-os-message-brokers-com-listen-e-notify)
- [9. Que tecnologia mostra as respostas na tela? É SSE?](#9-que-tecnologia-mostra-as-respostas-na-tela-é-sse)
- [10. O embedding é o Snowflake Arctic? Como ele se compara ao MiniLM?](#10-o-embedding-é-o-snowflake-arctic-como-ele-se-compara-ao-minilm)

---

## 1. Quando o conteúdo da pasta `estudos` entra no Live Answer?

A pasta `estudos` não tem tratamento próprio. Ela é só mais uma pasta da base de notas apontada por
`CAREER_KB_PATH`, e o manifesto da base (`glass-kb.json`) não a exclui. O que vale para ela vale para
toda nota indexada.

**O que é lido.** Só `.md` e `.txt` (o `include` do manifesto). Os PDFs e as imagens de `estudos`
**não entram**: para o app usar um PDF, o texto dele precisa virar `.md`.

**Quando é indexado.** Na abertura do app (`src/index.js:246`) e no início de cada sessão de Listen
(`src/features/listen/listenService.js:182`). O índice BM25 sai na hora. Os embeddings rodam em
segundo plano num processo separado e ficam em cache no disco por hash do conteúdo, então só nota
nova ou alterada é recalculada.

**Quando é usado.** A cada pergunta do entrevistador, depois do debounce de 800 ms:

1. O roteador (Jev, com o roteador por regex de reserva) classifica a fala em `personal`, `company`,
   `ambiguous` ou `general`.
2. **Na rota `general` a base inteira fica de fora**, `estudos` incluída
   (`src/features/common/career/index.js:392`). Uma pergunta técnica pura ("o que é um índice
   composto?") é classificada como `general` e o modelo responde só com o que já sabe. Ou seja, o
   material de estudo **não** ajuda nas perguntas técnicas genéricas; ele só aparece quando a
   pergunta é sobre você, sobre a empresa ou ambígua.
3. Nas outras rotas, BM25 e busca vetorial rodam sobre todos os trechos (`index.js:417-442`), as
   listas são fundidas (pergunta 5) e saem até 6 trechos, um por arquivo.
4. As notas de `estudos` ficam fora de `conteudo-entrevistas/`, então não têm empresa marcada. Isso
   as torna "preparo genérico", liberado em qualquer rota, inclusive `company`
   (`retriever.js:16-21`).
5. Na rota `ambiguous` ainda há um portão: algum trecho precisa ter cosseno de pelo menos 0,35
   (ou, sem vetores, cobrir metade dos termos da pergunta). Abaixo disso nada é injetado.
6. Os trechos escolhidos entram no system prompt depois do cartão de fatos canônicos, num bloco de
   até 9.000 caracteres (`contextBuilder.js:16`). Os títulos aparecem no painel como fontes.

Para ver se uma nota de `estudos` é recuperada para uma pergunta, rode
`node scripts/ask-career-kb.js "<pergunta>"`, que mostra a rota e o ranking.

## 2. O Live Answer lembra da conversa inteira?

**Não.** O que existe são quatro memórias diferentes, nenhuma delas a conversa toda:

| Memória | O que guarda | Onde |
|---|---|---|
| Transcrição no prompt | As **últimas 30 falas** (`me:` / `them:`) da sessão | `summaryService.js:321` (`formatConversationForPrompt(…, 30)`) |
| Follow-up da busca | Termos e texto da última pergunta `personal`/`company`, para que "e qual foi o resultado?" busque as mesmas notas. O regex aceita até 5 minutos depois | `summaryService.js:761`, `intentRouter.js:27` |
| Fala anterior do entrevistador | O segmento anterior, se veio nos últimos 20 s, para o roteador entender perguntas quebradas em duas falas | `jevRouter.js:41` |
| Histórico de respostas | Cada resposta gravada na tabela `live_answers` do SQLite, **só para revisão depois**; não volta para o prompt | spec `2026-10-13-live-answer-history` |

Pontos práticos:

- A sessão guarda todas as falas em memória (`conversationHistory`), mas o modelo só vê as 30 últimas.
  Como uma "fala" é um segmento do STT, 30 falas podem ser poucos minutos de entrevista.
- O modelo **não vê as respostas que ele mesmo sugeriu antes**. Vê o que você de fato falou (as
  linhas `me:`), não o texto do painel.
- O Live Insights (o resumo) roda a cada 5 falas, também sobre as 30 últimas, e carrega o resumo
  anterior adiante. Esse resumo não entra no prompt do Live Answer.

Se quiser memória da conversa toda, o caminho mais barato é passar o resumo acumulado do Live
Insights ao prompt do Live Answer, junto das 30 falas. Aumentar o limite de 30 também funciona, mas
custa tokens e latência a cada resposta.

## 3. O app usa a SDK da TypeSafe?

**Não.** O cliente do Jev (`src/features/common/career/jevClient.js`) faz um `POST` em
`https://api.typesafe.ai/v1/systemone` com o `fetch` nativo, um timeout rígido e nenhum retry. A
decisão está registrada em `specs/2026-10-13-career-router-jev/research.md:41`: os retries da
`@typesafe-ai/sdk` não cabem no orçamento da resposta ao vivo, e o `fetch` cobre o resto. A spec
fixa isso como restrição (C6: "Native fetch only, no SDK, no new dependency").

Os provedores de LLM, por outro lado, usam as SDKs oficiais: `@anthropic-ai/sdk`, `groq-sdk`,
`openai` (também para os endpoints compatíveis com OpenAI) e `@google/genai`.

## 4. Qual o peso entre busca semântica e BM25?

Não há um peso numérico do tipo "70% semântica, 30% BM25". A fusão usa **só a posição** de cada
trecho em cada lista, não a nota (`retriever.js`):

- Três rankings votam: **BM25**, **vetor do texto do trecho** e **vetor do título da seção**.
- Cada um contribui com seus 20 primeiros, e cada trecho ganha `1 / (60 + posição)` em cada lista
  em que aparece. Todas as listas têm o mesmo peso.
- Como duas das três listas são semânticas, na prática a semântica tem cerca de **2/3 do voto**.
  Um trecho que aparece nas três listas vence um que lidera só uma.
- Dentro do BM25, o título pesa 3 e o corpo pesa 1 (`bm25.js:9`, BM25F com k1 = 1,2 e b = 0,75).
- Se o vetor da pergunta não fica pronto em 150 ms, aquela resposta sai **só com BM25**. O mesmo
  vale para `CAREER_KB_VECTORS=off`.

**Só dá para saber por eval?** O desenho dá para saber lendo o código (está acima). O que só a eval
responde é **o efeito**: quantas vezes a nota certa entra no bloco. A pesquisa testou pesos
diferentes por lista e outros valores de k, e a diferença ficou dentro de ±2 itens, que é ruído
nesse conjunto (`specs/2026-10-11-live-answer-career-context/research.md`, "Smaller knobs"). Para
inspecionar uma pergunta isolada, o `scripts/ask-career-kb.js` mostra para cada trecho a posição no
BM25, no vetor do texto e no vetor do título.

## 5. O app usa re-ranking, como RRF?

**Usa RRF** (Reciprocal Rank Fusion, k = 60, `retriever.js:11`). A rigor, RRF é **fusão** de
rankings, não re-ranking: ele combina listas já ordenadas sem olhar o texto de novo. Depois da fusão
vêm só regras simples:

- empate: a nota mais recente vence, depois a melhor posição no BM25, depois no vetor;
- no máximo um trecho por arquivo (bancos de respostas têm muitas seções quase iguais);
- na rota `company`, só notas da empresa ativa ou sem empresa;
- os 6 primeiros, até 9.000 caracteres.

Um re-ranker de verdade (cross-encoder) foi testado e **rejeitado**: o
`mmarco-mMiniLMv2-L12-H384-v1` baixou o recall de 47,2% para 43,4% e levou ~12 s por pergunta
sob carga; o `bge-reranker-v2-m3` é lento demais em CPU para o debounce de 800 ms (research R5).

## 6. Fine-tuning e os scripts de eval não são a mesma coisa?

Não. Um muda o modelo; o outro mede o sistema.

- **Fine-tuning** treina o modelo de novo com exemplos seus e **muda os pesos** dele. Este repo não
  faz isso em lugar nenhum: o LLM, o embedding (Arctic) e o Jev são usados como vêm.
- **Os scripts de eval** (`scripts/eval-career-kb.js`, `scripts/replay-career-session.js`,
  `scripts/live-eval/`) **não mudam nada**. Rodam perguntas conhecidas pelo app e contam acertos:
  rota certa, nota certa no bloco, vazamento de outra empresa, latência, resposta com o termo
  esperado.

O que confunde é que a eval serve para **ajustar o sistema ao redor do modelo**: qual modelo de
embedding, quantos trechos, o tamanho do bloco, o limiar de cosseno, as regras do roteador. Isso é
ajuste de configuração (parecido com busca de hiperparâmetros), não de pesos. O risco é o mesmo do
fine-tuning: decorar o conjunto de teste. Por isso há um **holdout** (itens separados que não
guiam as decisões; o script avisa quando o resultado neles fica mais de 10 pontos abaixo) e a regra
de deixar a nota de origem de cada pergunta fora da busca (leave-source-out).

## 7. O app usa golden set nas evals?

**Sim**, e ele fica fora deste repo, na própria base de notas, em `glass-eval/` (que o manifesto
exclui do índice):

- `questions.jsonl`: **133 perguntas reais** de entrevistadores, cada uma com a rota esperada, as
  notas "gold" que a respondem, o idioma, a empresa e a marca de holdout. É o golden set do
  `eval-career-kb.js`, que mede recall@3, recall injetado (alvo de 85%), a matriz de confusão do
  roteador e vazamentos.
- `questions-synthetic.jsonl`: 40 perguntas escritas por LLM, só com a rota esperada. Rodam à
  parte, porque não são perguntas reais.

O live eval (`npm run eval:live`) usa ainda uma entrevista inventada
(`scripts/live-eval/fixtures/interview.json`) com checagens determinísticas e, com `--judge`, um
LLM como juiz. Isso não é golden set no mesmo sentido: não há resposta-modelo para comparar, só
critérios.

Um limite conhecido: o recall subconta. Uma auditoria manual achou casos em que a nota injetada
respondia a pergunta mas não estava marcada como gold (research R5, "Caveats").

## 8. Postgres tem fila como os message brokers, com LISTEN e NOTIFY?

(O Glass não usa Postgres: guarda dados em SQLite local e, logado, no Firestore.)

`LISTEN`/`NOTIFY` é **pub/sub, não fila**:

- Só recebe quem está conectado e escutando na hora. Mensagem sem ouvinte se perde; não há
  persistência, ack nem reentrega.
- A notificação sai só quando a transação que a emitiu faz commit, e o payload tem limite de cerca
  de 8 KB.
- Todo ouvinte recebe a mesma mensagem (fan-out). Não há divisão de trabalho entre consumidores.

Para ter **fila** no Postgres, o padrão é uma tabela de jobs consumida com
`SELECT … FOR UPDATE SKIP LOCKED`: vários workers pegam linhas diferentes sem se bloquear, e o job
só sai da tabela quando o worker confirma. `LISTEN`/`NOTIFY` costuma entrar só como "acorda, tem job
novo", para o worker não ficar consultando. Bibliotecas que fazem isso: pg-boss e graphile-worker
(Node), River (Go), a extensão pgmq. Isso cobre muito caso de uso, mas não substitui um broker em
volume alto, roteamento complexo ou retenção longa de eventos (Kafka, RabbitMQ).

## 9. Que tecnologia mostra as respostas na tela? É SSE?

**SSE aparece no meio do caminho, mas a tela não recebe SSE.** São três trechos:

1. **Provedor → app.** As APIs de LLM (Anthropic, Groq, OpenAI e compatíveis) respondem em
   streaming por HTTP com Server-Sent Events, lido pelas SDKs.
2. **Dentro do processo principal.** Cada provedor reembala os pedaços como um `ReadableStream` no
   formato SSE (`data: {...}\n\n`, terminando em `data: [DONE]`) com sinais internos, como
   `_reset` (troca de modelo no failover) e `_final_model`
   (`providers/anthropic.js:844`, `providerChain.js:295`). O `summaryService` e o `askService`
   leem esse stream linha a linha. É o formato SSE usado como protocolo interno; não há servidor
   HTTP nem `EventSource`.
3. **Processo principal → janela.** O texto vai por **IPC do Electron**:
   `webContents.send('live-answer-update', …)` no Live Answer e `ask:stateUpdate` no Ask, expostos
   à janela pelo `preload.js`. A janela é feita com **Lit** (web components), converte o markdown
   com **marked** e sanitiza com **DOMPurify** (`src/ui/listen/summary/LiveAnswerView.js`).

## 10. O embedding é o Snowflake Arctic? Como ele se compara ao MiniLM?

**Sim.** O modelo padrão é `Snowflake/snowflake-arctic-embed-m-v2.0`, quantizado em int8, rodando
local com transformers.js num processo separado (`embedder.js:24-31`). Cada trecho ganha dois
vetores: um do texto e um do título da seção. O `multilingual-e5-small` continua como perfil
alternativo.

**Por que o Arctic.** Foi escolhido numa comparação com quatro modelos sobre as perguntas reais
(research R5). O problema principal eram perguntas em português cuja melhor nota está em inglês, e
os modelos multilíngues maiores acertam muito mais esse cruzamento:

| Recall injetado (configuração final: título + texto, top 6, 9.000 chars) | Valor |
|---|---|
| `multilingual-e5-small` | 54,7% |
| `multilingual-e5-base` | 66,0% |
| `gte-multilingual-base` | 73,6% |
| `snowflake-arctic-embed-m-v2.0` | 75,5% |

O gte ficou a um item do Arctic, mas o Arctic indexa cerca de 40% mais rápido nesta máquina. Custo
do Arctic: download de 311 MB, ~0,7 GB de RAM no processo do modelo, 26 ms (p50) por pergunta.

**Comparação com o MiniLM.** O MiniLM **nunca foi medido** neste corpus; os números abaixo são das
fichas dos modelos, não de eval nossa.

| | `all-MiniLM-L6-v2` | `snowflake-arctic-embed-m-v2.0` |
|---|---|---|
| Idiomas | Só inglês | Multilíngue, incluindo português |
| Dimensões | 384 | 768 (aceita corte para 256, Matryoshka) |
| Tamanho | ~22 M de parâmetros | ~305 M (113 M fora da camada de embedding) |
| Contexto | 256 tokens (corta o resto) | Até 8.192 tokens |
| Velocidade e RAM | Muito mais leve e rápido | Mais pesado, mas cabe nos 800 ms (26 ms por pergunta) |

O MiniLM só aparece na pesquisa como o embedding padrão do Chroma, descartado por ser só inglês
(research R4). Como as entrevistas misturam português e inglês e boa parte das notas está em
inglês, ele perderia justamente nas perguntas que fizeram o e5-small falhar. Existe uma variante
multilíngue (`paraphrase-multilingual-MiniLM-L12-v2`, 384 dimensões), mas ela é de uma geração
anterior aos modelos testados; para valer a troca, ela teria que vencer o Arctic no
`eval-career-kb.js`.

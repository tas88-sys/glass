# Live Answer Lane — design

**Date:** 2026-05-30
**Status:** Validated design, not yet implemented
**Related:** `./prompts.md` (original brief / UX discussion, migrated into this spec dir)

## Problem

During an interview, when the interviewer asks a question over system audio, the
candidate wants Glass to answer it without typing. Today nothing does this directly:

- **Live Insights** runs every 5 turns (`summaryService.js:306`) and produces a
  rolling summary plus suggested questions — not an answer to the interviewer's
  question. The analysis prompt *can* answer questions, but the user message at
  `summaryService.js:114-134` overrides that directive and forces a summary shape.
- **Ask** answers questions, but never receives the transcript. `featureBridge.js:134`
  calls `askService.sendMessage(userPrompt)` with no history, so each query sees only
  the typed text and a screenshot.

So the candidate gets summaries automatically, or screenshot-blind answers on demand,
but never an automatic answer to what was just asked.

## What already exists

The pieces to build on are already in the codebase:

| Piece | Location | State |
|---|---|---|
| A prompt that detects and answers the interviewer's question | `pickle_glass_analysis` (`promptTemplates.js:238`) | Complete. Primary directive at line 249; intent detection at 260; passive mode at 374. |
| The live transcript buffer | `summaryService.getConversationHistory()` (`:48`) | Complete. Array of `me:`/`them:` lines. |
| Transcript-into-prompt injection | `summaryService.js:93-94` | Complete. Replaces the `{{CONVERSATION_HISTORY}}` token (`promptTemplates.js:402`) with the real transcript. |
| Automatic trigger during listening | `triggerAnalysisIfNeeded()` (`:305`) | Complete, but tuned for summaries on a 5-turn cadence. |
| Renderer channel + UI pane | `summary-update` → `SummaryView` | Complete. |

The gap is narrow: run the existing answer-capable prompt against the existing
transcript on its own trigger, and show the result in its own section.

`pickle_glass_analysis` already runs text-only in the summary path (no screenshot),
so a transcript-only answer needs no new model handling.

## Approach

Add a second analysis lane beside Live Insights. The existing summary lane stays
closed for modification; the new lane is additive. This follows the Open-Closed
Principle the way the codebase is already seamed — `addConversationTurn` is the shared
hub, and each lane hangs off it independently.

```
                 addConversationTurn(speaker, text)        existing hub
                          |
        +-----------------+------------------+
        v                                    v
 triggerAnalysisIfNeeded()           triggerAnswerIfNeeded()        NEW
 (every 5 turns, UNTOUCHED)          (on them: question, debounced)
        |                                    |
        v                                    v
 makeOutlineAndRequests()            makeLiveAnswer()               NEW
 -> 'summary-update'                 -> 'live-answer-update'        NEW channel
        |                                    |
        v                                    v
   <summary-view>  (UNTOUCHED)       <live-answer-view>             NEW component
        +------------- both inside the insights pane ---------------+
```

If `makeLiveAnswer` were deleted, Live Insights would behave identically.

### Closed (no edits)

`makeOutlineAndRequests`, the `summary-update` channel, `SummaryView.js`, the prompt
text in `promptTemplates.js`, `askService.js`, `featureBridge.js`.

### Open (additive only)

1. `summaryService.makeLiveAnswer()` — a sibling method.
2. `triggerAnswerIfNeeded()` plus the `live-answer-update` channel.
3. Two bridge entries in `preload.js`.
4. A `<live-answer-view>` component, added as one element in `ListenView.render()`.

## Service logic

### `makeLiveAnswer(conversationTexts)`

Reuses the existing injection pattern, drops the summary-forcing user message, and
adds a sentinel so the prompt's passive mode becomes a clean "stay silent" signal.

```js
async makeLiveAnswer(conversationTexts) {
    const recent = this.formatConversationForPrompt(conversationTexts, 30);
    const systemPrompt = getSystemPrompt('pickle_glass_analysis', '', false)
        .replace('{{CONVERSATION_HISTORY}}', recent);          // same as :94

    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content:
            "Answer the interviewer's (them:) most recent question directly, " +
            'per your primary directive. If the transcript ends with no question ' +
            'directed at me, reply with exactly: PASSIVE' },
    ];

    const llm = createLLM(/* modelInfo */ { maxTokens: 900, temperature: 0.7 });
    const { content } = await llm.chat(messages);
    if (content.trim() === 'PASSIVE') return null;             // suppress, keep last answer
    return { answer: content, ts: Date.now() };
}
```

The model comes from `modelStateService.getCurrentModelInfo('llm')`, so the configured
provider, key handling, and the Gemini-failover path all carry over.

### `triggerAnswerIfNeeded()`

Called from `addConversationTurn`, beside the existing `triggerAnalysisIfNeeded()`
call. Four gates run before any LLM call:

| Gate | Rule | Why |
|---|---|---|
| Speaker | latest turn is `them:` | never answer the candidate's own mic (`Me`) |
| Heuristic | tail ends with `?`, or opens with what/how/why/can/could/tell me/walk me/describe… | filter non-questions without a model call |
| Debounce | wait ~1.5s after the last `them:` turn, resetting on each new one | coalesce a multi-segment question into one call |
| De-dup / in-flight | skip if a call is in flight, or the tail matches `lastAnsweredTail` | avoid re-answering on a trailing fragment |

`Me` is the mic and `Them` is system audio (`sttService.js:82,109`), so the speaker
gate targets interviewer speech.

### Cost

The lane fires roughly once per interviewer question, not once per turn — the cost
tracks the value delivered. The heuristic blocks most non-questions for free, and the
model returns `PASSIVE` on the rest. Tuning knobs if an interviewer is talkative: the
debounce window, a minimum interval between calls (for example one per three seconds),
and `maxTokens`.

### Lifecycle

A new `resetLiveAnswer()` clears `lastAnsweredTail`, the debounce timer, and the
in-flight flag. The timer is cleared on session close and guarded by the existing
`isDestroyed()` check before any send. This matters because of the known STT
Stop/Start race: a late timer must not fire an answer into a torn-down session.

## UI and IPC

### `preload.js`

Additive, inside the existing `summaryView` namespace (`:205`):

```js
onLiveAnswerUpdate: (cb) => ipcRenderer.on('live-answer-update', cb),
removeAllLiveAnswerUpdateListeners: () => ipcRenderer.removeAllListeners('live-answer-update'),
```

### `LiveAnswerView.js` (new)

A small Lit element. `marked`, `hljs`, and `DOMPurify` attach to `window` when
`SummaryView` loads them, so this component uses them without loading them again.

```js
properties = { liveAnswer: String, isVisible: Boolean }
connectedCallback()    -> onLiveAnswerUpdate((e, d) => { this.liveAnswer = d.answer; this.requestUpdate(); })
disconnectedCallback() -> removeAllLiveAnswerUpdateListeners()
render()               -> "Live Answer" title + rendered markdown of the answer
```

### `ListenView.js`

The import, plus one element above `<summary-view>` (`:681`) so the answer reads
first, plus one line in the reset block (`:467`) to clear it on session reset:

```js
<live-answer-view .isVisible=${this.viewMode === 'insights'}></live-answer-view>
<summary-view ...></summary-view>   // unchanged
```

Answer and summary share the insights pane. No new view-mode or toggle.

### Behavior at the edges

- `PASSIVE` returns null, the service emits nothing, and the panel keeps the last
  answer rather than flickering to empty between questions.
- No session or empty transcript: the trigger never fires.
- Long answers scroll; `insights-container` already scrolls.

## Test plan

1. **Service.** `makeLiveAnswer` returns an answer on a `them:` question and null on
   PASSIVE. Heuristic truth-table. De-dup: the same tail twice produces one call.
   Debounce: rapid segments produce one call. A `me:` question produces no call.
2. **Integration (mock LLM).** Pushing turns emits `live-answer-update`, and
   `summary-update` still fires on its own 5-turn cadence — proof the lanes are
   independent. Closing the session mid-debounce clears the timer with no
   `isDestroyed` throw.
3. **Manual.** A system-audio question produces an answer in about two seconds, with
   no duplicate answers on trailing fragments.
4. **Regression.** `SummaryView` output is unchanged.

## Scope

This design touches neither `askService.js` nor `featureBridge.js`. The README's
on-demand gap — Ask receiving the live transcript — stays open as separate future
work.

### Files

- New: `src/ui/listen/summary/LiveAnswerView.js`
- Additive edits: `src/features/listen/summary/summaryService.js`, `src/preload.js`,
  `src/ui/listen/ListenView.js`
- Untouched: `makeOutlineAndRequests`, `SummaryView.js`, `promptTemplates.js`,
  `askService.js`, `featureBridge.js`

## Open questions for implementation

- Debounce window: 1.5s is a starting point; tune against real STT segment timing.
- Should the panel show a brief "thinking" state while a call is in flight, or update
  only when the answer lands? Starting choice: update only on landing, to keep the
  pane quiet.
- Whether to persist live answers to the session DB as `makeOutlineAndRequests` does
  for summaries (`summaryRepository.saveSummary`), or keep them in memory only.

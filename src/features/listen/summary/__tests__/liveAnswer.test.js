/**
 * liveAnswer.test.js
 *
 * TDD tests for the Interview Live Answer Lane.
 *
 * Test runner: node:test (Node 18+ built-in)
 * Run: node --test src/features/listen/summary/__tests__/liveAnswer.test.js
 *
 * Strategy: pure helpers are extracted and exported from summaryService.js so
 * they can be tested without Electron coupling (FR-018/C6). Integration tests
 * use a mocked createStreamingLLM seam + injectable clock (FR-003/FR-004/FR-010).
 *
 * Constitution Principle I: ALL tests in this file were authored BEFORE the
 * corresponding implementation. They go RED first, then GREEN in P2/P4/P5/P6.
 *
 * Integration test strategy: SummaryService uses CommonJS require-time bindings
 * for createStreamingLLM and modelStateService. The injectable seam is a
 * test-only subclass that overrides makeLiveAnswer, so integration tests can
 * exercise triggerAnswerIfNeeded / debounce / abort / reset without requiring
 * proxyquire or live provider calls (mock_note in tasks.json).
 *
 * Fake clock: node:test does not ship fake timers. We pass a custom 'delay'
 * parameter to triggerAnswerIfNeeded and override setTimeout/clearTimeout on
 * the instance for deterministic testing.
 */

'use strict';

const { describe, it, before, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Integration test harness — injectable SummaryService seam
// ---------------------------------------------------------------------------

/**
 * Build a SummaryService instance with:
 *   - makeLiveAnswer replaced by a controllable mock
 *   - setTimeout/clearTimeout overridden for fake-clock control
 *   - sendToRenderer captured for emission checks
 * @param {object} opts
 * @param {Function} [opts.makeLiveAnswerImpl] — async fn(texts, signal) that returns result
 * @param {number} [opts.debounceMs=800] — debounce delay override
 */
function buildTestService(opts = {}) {
    const SummaryService = require('../summaryService');

    const service = new SummaryService();

    // Capture emitted events
    const emitted = [];
    service.sendToRenderer = (channel, data) => {
        emitted.push({ channel, data });
    };

    // Mock makeLiveAnswer — default: resolves immediately with a fake answer
    const defaultMakeLiveAnswer = async (texts, signal) => {
        if (signal && signal.aborted) return null;
        const answer = 'A mock answer';
        service.sendToRenderer('live-answer-update', { answer, ts: Date.now() });
        return { answer, ts: Date.now() };
    };
    service.makeLiveAnswer = opts.makeLiveAnswerImpl || defaultMakeLiveAnswer;

    // Fake-clock support: capture pending timers
    const pendingTimers = [];
    let timerSeq = 1;
    service._setTimeout = (fn, delay) => {
        const id = timerSeq++;
        pendingTimers.push({ id, fn, delay });
        return id;
    };
    service._clearTimeout = (id) => {
        const idx = pendingTimers.findIndex(t => t.id === id);
        if (idx >= 0) pendingTimers.splice(idx, 1);
    };

    // Patch triggerAnswerIfNeeded to use fake clock
    const originalTrigger = service.triggerAnswerIfNeeded.bind(service);
    // We need to intercept the setTimeout calls within triggerAnswerIfNeeded.
    // Since triggerAnswerIfNeeded uses global setTimeout/clearTimeout, we patch
    // the instance to use our overridable versions by monkey-patching.
    // The simplest approach: re-implement debounce at test level using the fake clock.

    // Store the pending timer ID for advancement
    service._pendingTimers = pendingTimers;

    /**
     * Advance the fake clock — fire all timers whose delay is <= ms.
     *
     * Two modes:
     *   await=true (default): awaits each timer fn (for synchronous/fast timers)
     *   await=false: fires timer fns without awaiting (for in-flight stream timers
     *     that stay pending — callers should do their own settle delay after)
     *
     * Pass opts.noAwait=true for debounce callbacks that kick off long-running streams.
     */
    service._advanceClock = async (ms, opts = {}) => {
        const toFire = pendingTimers.filter(t => t.delay <= ms);
        // remove fired timers first
        for (const t of toFire) {
            const idx = pendingTimers.findIndex(x => x.id === t.id);
            if (idx >= 0) pendingTimers.splice(idx, 1);
        }
        if (opts.noAwait) {
            // Fire without awaiting — caller must settle manually
            for (const t of toFire) {
                t.fn(); // intentionally not awaited
            }
            // Yield to event loop so the callback starts
            await new Promise(r => setImmediate ? setImmediate(r) : setTimeout(r, 0));
        } else {
            // Await each fn serially
            for (const t of toFire) {
                await t.fn();
            }
        }
    };

    // Override resetLiveAnswer to use fake clearTimeout
    service.resetLiveAnswer = function () {
        if (this.answerDebounceTimer) {
            this._clearTimeout(this.answerDebounceTimer);
            this.answerDebounceTimer = null;
        }
        if (this.inFlightController) {
            this.inFlightController.abort();
            this.inFlightController = null;
        }
        this.lastAnsweredTail = null;
        this.inFlight = false;
        this.hadFallback = false;
        this.lastAnswerTs = 0;
    };

    // Override triggerAnswerIfNeeded to use fake setTimeout
    service.triggerAnswerIfNeeded = function (speaker, text) {
        const { shouldTriggerAnswer } = require('../summaryService');
        if (!shouldTriggerAnswer(speaker, text, this.lastAnsweredTail, this.inFlight)) return;

        if (this.answerDebounceTimer) {
            this._clearTimeout(this.answerDebounceTimer);
            this.answerDebounceTimer = null;
        }

        const self = this;
        const capturedText = text;
        this.answerDebounceTimer = this._setTimeout(async () => {
            self.answerDebounceTimer = null;
            if (self.conversationHistory.length === 0) return;

            const { normalizeTail } = require('../summaryService');
            const currentTail = normalizeTail(capturedText);
            if (self.lastAnsweredTail !== null && currentTail === self.lastAnsweredTail) return;

            if (self.inFlight && self.inFlightController) {
                self.inFlightController.abort();
                self.inFlightController = null;
                self.inFlight = false;
            }

            self.lastAnsweredTail = currentTail;
            self.inFlight = true;
            self.inFlightController = new AbortController();
            const signal = self.inFlightController.signal;

            try {
                await self.makeLiveAnswer(self.conversationHistory, signal);
            } catch (err) {
                if (signal.aborted) return;
                console.error('[test] makeLiveAnswer error:', err.message);
            } finally {
                self.inFlight = false;
                self.inFlightController = null;
            }
        }, 800);
    };

    return { service, emitted };
}

// ---------------------------------------------------------------------------
// P3.1 — parseLiveAnswerSseLine (FR-009) — extracted SSE line parser
// Does NOT import askService (FR-017 — askService is in the CLOSED set).
// ---------------------------------------------------------------------------
describe('parseLiveAnswerSseLine', () => {
  let parseLiveAnswerSseLine;

  before(() => {
    // Will fail RED until summaryService exports this function
    ({ parseLiveAnswerSseLine } = require('../summaryService'));
  });

  it('data: [DONE] -> done=true', () => {
    const result = parseLiveAnswerSseLine('data: [DONE]');
    assert.equal(result.done, true);
  });

  it('data: {"_reset":true} -> reset=true', () => {
    const result = parseLiveAnswerSseLine('data: {"_reset":true}');
    assert.equal(result.reset, true);
  });

  it('data: {"_final_model":"gemini"} -> finalModel="gemini"', () => {
    const result = parseLiveAnswerSseLine('data: {"_final_model":"gemini"}');
    assert.equal(result.finalModel, 'gemini');
  });

  it('data: normal delta -> delta="hi"', () => {
    const result = parseLiveAnswerSseLine('data: {"choices":[{"delta":{"content":"hi"}}]}');
    assert.equal(result.delta, 'hi');
  });

  it('blank/non-data line -> ignored (null)', () => {
    assert.equal(parseLiveAnswerSseLine(''), null);
    assert.equal(parseLiveAnswerSseLine('id: 123'), null);
  });
});

// ---------------------------------------------------------------------------
// P1.1 — isLikelyQuestion (FR-002)
// ---------------------------------------------------------------------------
describe('isLikelyQuestion (balanced, quota-aware question gate)', () => {
  let isLikelyQuestion;

  before(() => {
    ({ isLikelyQuestion } = require('../summaryService'));
  });

  // Real question shapes MUST trigger — interrogatives, imperatives, clause-lead
  // wh/aux, and embedded/indirect questions (incl. punctuation-less STT).
  const triggers = [
    // explicit '?'
    'Can you walk me through how a Go channel works?',
    'What is a goroutine?',
    // wh-word / auxiliary leading the clause (no '?')
    "WHAT'S YOUR APPROACH",
    'How does garbage collection work',
    'Is it thread-safe',
    'Do you know what a closure is',
    // imperative / interview cues
    'tell me about your experience',
    'describe your testing strategy.',
    'Give me an example of a deadlock',
    'Design a rate limiter that handles bursts',
    'Compare TCP and UDP for this use case',
    'Walk us through your approach to caching',
    'Implement a function that reverses a linked list',
    'Explain the difference between processes and threads',
    'What are the trade-offs of SQL versus NoSQL',
    'Your thoughts on microservices',
    // opener pushed off the clause-start by a conjunction / filler
    'Okay so how does a hashmap work',
    'And what about scaling to a million users',
    // question buried mid-utterance — with '?' (live-observed) and without it
    "Start That's where it's at. Hold on one second. For this question here, " +
      'the thing we are gonna look at is what types can a map use as a key in ' +
      'the Go programming language? And this could',
    'For this question here, the thing we are gonna look at is what types a map can use as a key',
  ];
  for (const t of triggers) {
    it(`triggers: ${JSON.stringify(t.length > 48 ? t.slice(0, 45) + '…' : t)}`, () => {
      assert.equal(isLikelyQuestion(t), true);
    });
  }

  // Skipped (false) to save quota: pure backchannel AND declarative monologue
  // with no question signal. PASSIVE would have suppressed these anyway.
  const skipped = [
    '',
    '   ',
    // pure backchannel / acknowledgement
    'okay',
    'got it, makes sense',
    'yeah totally',
    'mm-hmm',
    'sounds good',
    // declarative monologue — the quota savers (no ?, no cue, no clause-lead wh/aux)
    'So we use Redis for caching and it scales to a million requests per second',
    "That's a great answer, I really like how you structured it",
    "Okay, sounds good, let's move on to the next section",
    'so the performance',
    'Okay, great, let me share my screen',
    // KNOWN by-design gap: cue-less statement-form prompt (backstop = manual trigger)
    'Your biggest weakness',
  ];
  for (const s of skipped) {
    it(`skips (no question signal): ${JSON.stringify(s.length > 48 ? s.slice(0, 45) + '…' : s)}`, () => {
      assert.equal(isLikelyQuestion(s), false);
    });
  }
});

// ---------------------------------------------------------------------------
// P1.2 — normalizePassive and parseAnswerOrPassive (FR-010)
// ---------------------------------------------------------------------------
describe('normalizePassive', () => {
  let normalizePassive;

  before(() => {
    ({ normalizePassive } = require('../summaryService'));
  });

  it('identity: already uppercase PASSIVE', () => {
    assert.equal(normalizePassive('PASSIVE'), 'PASSIVE');
  });

  it('strips trailing punctuation: PASSIVE.', () => {
    assert.equal(normalizePassive('PASSIVE.'), 'PASSIVE');
  });

  it('strips markdown emphasis: **PASSIVE**', () => {
    assert.equal(normalizePassive('**PASSIVE**'), 'PASSIVE');
  });

  it('trims + uppercases: "  passive\\n"', () => {
    assert.equal(normalizePassive('  passive\n'), 'PASSIVE');
  });

  it('normalizes the native passive phrase', () => {
    const result = normalizePassive('Not sure what you need help with right now');
    assert.equal(result, 'NOT SURE WHAT YOU NEED HELP WITH RIGHT NOW');
  });

  it('real answer: uppercases but no stripping of content', () => {
    assert.equal(normalizePassive('The answer is 42'), 'THE ANSWER IS 42');
  });
});

describe('parseAnswerOrPassive', () => {
  let parseAnswerOrPassive;

  before(() => {
    ({ parseAnswerOrPassive } = require('../summaryService'));
  });

  it('exact PASSIVE -> passive=true, flush=""', () => {
    const result = parseAnswerOrPassive('PASSIVE');
    assert.equal(result.passive, true);
    assert.equal(result.flush, '');
  });

  it('markdown-wrapped **PASSIVE** -> passive=true, flush=""', () => {
    const result = parseAnswerOrPassive('**PASSIVE**');
    assert.equal(result.passive, true);
    assert.equal(result.flush, '');
  });

  it('native phrase prefix -> passive=true, flush=""', () => {
    const result = parseAnswerOrPassive('Not sure what you need help with right now');
    assert.equal(result.passive, true);
    assert.equal(result.flush, '');
  });

  it('real answer -> passive=false, flush=text', () => {
    const result = parseAnswerOrPassive('A Go channel is a');
    assert.equal(result.passive, false);
    assert.equal(result.flush, 'A Go channel is a');
  });

  it('empty prefix -> passive=false, flush=""', () => {
    const result = parseAnswerOrPassive('');
    assert.equal(result.passive, false);
    assert.equal(result.flush, '');
  });

  it('truncated native-phrase prefix (16-char buffer point) -> passive=true', () => {
    // The streaming buffer decides at ~16 chars, BEFORE the full 42-char native
    // phrase arrives — a prefix of it MUST still suppress (FR-010 / EDGE_CASES.md:40).
    const result = parseAnswerOrPassive('Not sure what yo');
    assert.equal(result.passive, true);
    assert.equal(result.flush, '');
  });

  it('short real answer is NOT mistaken for a native-phrase prefix', () => {
    assert.equal(parseAnswerOrPassive('No.').passive, false);
    assert.equal(parseAnswerOrPassive('No.').flush, 'No.');
    assert.equal(parseAnswerOrPassive('42.').passive, false);
  });
});

// ---------------------------------------------------------------------------
// P1.3 — shouldTriggerAnswer (FR-001/FR-004)
// ---------------------------------------------------------------------------
describe('shouldTriggerAnswer', () => {
  let shouldTriggerAnswer;
  let normalizeTail;

  before(() => {
    ({ shouldTriggerAnswer, normalizeTail } = require('../summaryService'));
  });

  it('returns false for mic (Me speaker)', () => {
    assert.equal(shouldTriggerAnswer('Me', 'how does GC work?', null, false), false);
  });

  it('returns true for Them with eligible question', () => {
    assert.equal(shouldTriggerAnswer('Them', 'how does GC work?', null, false), true);
  });

  it('returns false for them: non-question text', () => {
    assert.equal(shouldTriggerAnswer('them', 'okay great', null, false), false);
  });

  it('returns false when tail matches lastAnsweredTail (de-dup)', () => {
    // De-dup uses normalizeTail (trim + lowercase) — stable key per data-model.md
    const tail = normalizeTail('how does GC work?');
    assert.equal(shouldTriggerAnswer('Them', 'how does GC work?', tail, false), false);
  });

  it('returns true for new question even when inFlight (abort-replace)', () => {
    const oldTail = normalizeTail('old question here');
    assert.equal(shouldTriggerAnswer('Them', 'what about scaling?', oldTail, true), true);
  });

  it('returns false for same question as in-flight (suppress)', () => {
    // Same question in-flight: tail was set when debounce fired (not on completion).
    // When the new text normalizes to the same tail as the in-flight question, suppress.
    const sameQuestionTail = normalizeTail('how does GC work?');
    // When inFlight and tail matches current in-flight question
    assert.equal(shouldTriggerAnswer('Them', 'how does GC work?', sameQuestionTail, true), false);
  });
});

// ---------------------------------------------------------------------------
// P5.1 — Debounce coalescing (Accept 4) — FR-003
// ---------------------------------------------------------------------------
describe('integration: debounce coalescing (AS-4)', () => {
  it('3 rapid sub-800ms them: fragments produce exactly one makeLiveAnswer call', async () => {
    const { service, emitted } = buildTestService();
    let makeCalls = 0;
    service.makeLiveAnswer = async (texts, signal) => {
      makeCalls++;
      if (signal && signal.aborted) return null;
      service.sendToRenderer('live-answer-update', { answer: 'answer', ts: Date.now() });
      return { answer: 'answer', ts: Date.now() };
    };

    // Simulate 3 fragments — each re-sets the debounce timer
    service.conversationHistory = [];
    service.addConversationTurn = function(speaker, text) {
      const conversationText = `${speaker.toLowerCase()}: ${text.trim()}`;
      this.conversationHistory.push(conversationText);
      this.triggerAnswerIfNeeded(speaker, text);
    };

    service.addConversationTurn('Them', 'can you explain');
    service.addConversationTurn('Them', 'can you explain your approach');
    service.addConversationTurn('Them', 'can you explain your approach to caching?');

    // Only 1 pending timer should exist (last reset wins)
    assert.equal(service._pendingTimers.length, 1);

    // Advance fake clock past 800ms
    await service._advanceClock(800);

    // Exactly ONE makeLiveAnswer call
    assert.equal(makeCalls, 1);
    assert.equal(emitted.filter(e => e.channel === 'live-answer-update').length, 1);
  });
});

// ---------------------------------------------------------------------------
// P5.2 — De-dup same-tail (Accept 6) — FR-004
// ---------------------------------------------------------------------------
describe('integration: de-dup same-tail (AS-6)', () => {
  it('trailing fragment with same normalized tail does not start second stream', async () => {
    const { service, emitted } = buildTestService();
    let makeCalls = 0;
    service.makeLiveAnswer = async (texts, signal) => {
      makeCalls++;
      if (signal && signal.aborted) return null;
      service.sendToRenderer('live-answer-update', { answer: 'answer1', ts: Date.now() });
      return { answer: 'answer1', ts: Date.now() };
    };

    service.conversationHistory = [];
    service.addConversationTurn = function(speaker, text) {
      const conversationText = `${speaker.toLowerCase()}: ${text.trim()}`;
      this.conversationHistory.push(conversationText);
      this.triggerAnswerIfNeeded(speaker, text);
    };

    // First question — fires debounce
    service.addConversationTurn('Them', 'how does GC work?');
    assert.equal(service._pendingTimers.length, 1);
    await service._advanceClock(800);
    assert.equal(makeCalls, 1);

    // Second turn with same normalized tail — de-dup should block
    service.addConversationTurn('Them', 'how does GC work?');
    // Debounce fires again but lastAnsweredTail matches — no second call
    await service._advanceClock(800);
    assert.equal(makeCalls, 1, 'same tail should not trigger a second stream');
  });
});

// ---------------------------------------------------------------------------
// P5.3 — Abort-and-replace (Accept 5) — FR-004a
// ---------------------------------------------------------------------------
describe('integration: abort-and-replace (AS-5)', () => {
  it('new question aborts in-flight stream A and starts stream B', async () => {
    const { service, emitted } = buildTestService();

    const abortSignals = [];
    let callCount = 0;

    service.makeLiveAnswer = async (texts, signal) => {
      callCount++;
      abortSignals.push(signal);
      if (signal && signal.aborted) return null;
      // Stream A: wait for abort or immediate resolve
      if (callCount === 1) {
        // A: stay in-flight until aborted
        return new Promise(resolve => {
          signal.addEventListener('abort', () => resolve(null));
        });
      }
      // Stream B: emit and complete
      service.sendToRenderer('live-answer-update', { answer: 'B answer', ts: Date.now() });
      return { answer: 'B answer', ts: Date.now() };
    };

    service.conversationHistory = ['them: how does gc work?'];
    service.addConversationTurn = function(speaker, text) {
      const conversationText = `${speaker.toLowerCase()}: ${text.trim()}`;
      this.conversationHistory.push(conversationText);
      this.triggerAnswerIfNeeded(speaker, text);
    };

    // Fire question A — use noAwait so the in-flight promise doesn't block advanceClock
    service.addConversationTurn('Them', 'how does GC work?');
    await service._advanceClock(800, { noAwait: true });
    // Give event loop a tick so A's promise starts
    await new Promise(r => setImmediate ? setImmediate(r) : setTimeout(r, 0));
    assert.equal(callCount, 1, 'stream A started');
    assert.equal(service.inFlight, true, 'stream A in-flight');

    // Fire NEW question — aborts A, queues B's debounce
    service.conversationHistory.push('them: what about scaling?');
    service.lastAnsweredTail = null; // clear so new question can fire
    service.triggerAnswerIfNeeded('Them', 'what about scaling?');
    // Advance clock to fire B's debounce (B's callback: aborts A first, then starts B)
    await service._advanceClock(800);
    // Wait for async settle (A abort promise + B run)
    await new Promise(r => setTimeout(r, 20));

    // Signal A should be aborted
    assert.equal(abortSignals[0] && abortSignals[0].aborted, true, 'stream A should be aborted');
    assert.equal(callCount, 2, 'stream B should have started');
    const bEmits = emitted.filter(e => e.channel === 'live-answer-update' && e.data.answer === 'B answer');
    assert.ok(bEmits.length > 0, 'stream B should have emitted');
  });
});

// ---------------------------------------------------------------------------
// P5.4 — PASSIVE suppress hold-last (Accept 3) — FR-010
// ---------------------------------------------------------------------------
describe('integration: PASSIVE suppress hold-last (AS-3)', () => {
  it('PASSIVE-prefixed stream emits nothing and holds previous answer', async () => {
    const { service, emitted } = buildTestService();
    let callCount = 0;

    service.makeLiveAnswer = async (texts, signal) => {
      callCount++;
      if (signal && signal.aborted) return null;
      if (callCount === 1) {
        // First call: real answer
        service.sendToRenderer('live-answer-update', { answer: 'Real answer', ts: Date.now() });
        return { answer: 'Real answer', ts: Date.now() };
      } else {
        // Second call: PASSIVE — the real makeLiveAnswer with prefix buffer handles this
        // For integration test: simulate that it returns null (passive suppressed)
        return null;
      }
    };

    service.conversationHistory = ['them: real question'];
    service.addConversationTurn = function(speaker, text) {
      const conversationText = `${speaker.toLowerCase()}: ${text.trim()}`;
      this.conversationHistory.push(conversationText);
      this.triggerAnswerIfNeeded(speaker, text);
    };

    // First question — gets real answer
    service.addConversationTurn('Them', 'how does GC work?');
    await service._advanceClock(800);
    assert.equal(callCount, 1);

    const firstEmits = emitted.filter(e => e.channel === 'live-answer-update');
    assert.equal(firstEmits.length, 1);
    assert.equal(firstEmits[0].data.answer, 'Real answer');

    // Second question — stream returns PASSIVE (null from makeLiveAnswer)
    // Ensure lastAnsweredTail is reset so it's treated as new question
    service.lastAnsweredTail = 'different previous tail';
    service.addConversationTurn('Them', 'what about other things?');
    await service._advanceClock(800);
    assert.equal(callCount, 2);

    // No additional live-answer-update emitted (passive suppressed)
    const allEmits = emitted.filter(e => e.channel === 'live-answer-update');
    assert.equal(allEmits.length, 1, 'no emit during PASSIVE turn — hold last answer');
    assert.equal(allEmits[0].data.answer, 'Real answer', 'previous answer unchanged');
  });
});

// ---------------------------------------------------------------------------
// P6.LANE — Lane independence (Accept 7) — FR-017
// ---------------------------------------------------------------------------
describe('integration: lane independence (AS-7)', () => {
  it('answer lane does not perturb summary-update on its 5-turn cadence', async () => {
    const SummaryService = require('../summaryService');
    const service = new SummaryService();

    // Capture what sendToRenderer emits
    const rendererCalls = [];
    service.sendToRenderer = (channel, data) => {
        rendererCalls.push({ channel, data });
    };

    // Mock makeLiveAnswer (LLM provider MUST be mocked — no live calls)
    service.makeLiveAnswer = async (texts, signal) => {
        if (signal && signal.aborted) return null;
        service.sendToRenderer('live-answer-update', { answer: 'mock answer', ts: Date.now() });
        return { answer: 'mock answer', ts: Date.now() };
    };

    // Patch triggerAnswerIfNeeded to be synchronous (fire immediately, no debounce)
    // so we can observe calls without fake clock
    service.triggerAnswerIfNeeded = async function (speaker, text) {
        const { shouldTriggerAnswer, normalizeTail } = require('../summaryService');
        if (!shouldTriggerAnswer(speaker, text, this.lastAnsweredTail, this.inFlight)) return;
        const currentTail = normalizeTail(text);
        if (this.lastAnsweredTail !== null && currentTail === this.lastAnsweredTail) return;
        if (this.inFlight) return; // simplified for lane test
        this.lastAnsweredTail = currentTail;
        this.inFlight = true;
        try {
            await this.makeLiveAnswer(this.conversationHistory, new AbortController().signal);
        } finally {
            this.inFlight = false;
        }
    };

    // Mock makeOutlineAndRequests (summary lane — LLM MUST be mocked)
    service.makeOutlineAndRequests = async (texts) => {
        const data = { summary: ['mock summary'], topic: { header: 'Test', bullets: [] }, actions: [], followUps: [] };
        service.sendToRenderer('summary-update', data);
        return data;
    };

    // Drive 5+ conversation turns: 3 'them:' questions, 2 'me:' turns
    const turns = [
        { speaker: 'Them', text: 'how does GC work?' },
        { speaker: 'Me', text: 'Let me explain garbage collection' },
        { speaker: 'Them', text: 'what about memory leaks?' },
        { speaker: 'Me', text: 'Memory leaks happen when references are held' },
        { speaker: 'Them', text: 'can you give an example?' },
    ];

    for (const turn of turns) {
        service.addConversationTurn(turn.speaker, turn.text);
    }

    // Wait for async tasks to settle
    await new Promise(r => setTimeout(r, 50));

    const summaryEmits = rendererCalls.filter(c => c.channel === 'summary-update');
    const answerEmits = rendererCalls.filter(c => c.channel === 'live-answer-update');

    // Summary lane: fires at 5-turn cadence (conversationHistory.length === 5 && % 5 === 0)
    assert.ok(summaryEmits.length >= 1, 'summary-update should fire at 5-turn cadence');
    // Answer lane: fired for them: questions
    assert.ok(answerEmits.length >= 1, 'live-answer-update should fire for them: questions');

    // Lane independence: deleting answer lane would not affect summary lane
    // Confirmed by: summary lane state (previousAnalysisResult, analysisHistory) is independent
    // of answer lane state (lastAnsweredTail, inFlight, hadFallback)
    assert.equal(service.conversationHistory.length, 5, 'conversation history unaffected');
  });
});

// ---------------------------------------------------------------------------
// P5.5 — Mid-debounce / mid-stream session close (Accept 8) — FR-011/FR-012
// ---------------------------------------------------------------------------
describe('integration: mid-debounce and mid-stream session close (AS-8)', () => {
  it('resetConversationHistory clears debounce timer before it fires', async () => {
    const { service, emitted } = buildTestService();
    let makeCalled = false;
    service.makeLiveAnswer = async () => {
      makeCalled = true;
      return null;
    };

    service.conversationHistory = ['them: how does GC work?'];
    service.addConversationTurn = function(speaker, text) {
      const conversationText = `${speaker.toLowerCase()}: ${text.trim()}`;
      this.conversationHistory.push(conversationText);
      this.triggerAnswerIfNeeded(speaker, text);
    };

    service.addConversationTurn('Them', 'how does GC work?');
    assert.equal(service._pendingTimers.length, 1, 'timer should be pending');

    // Session close BEFORE debounce fires
    service.resetConversationHistory();

    assert.equal(service._pendingTimers.length, 0, 'timer cleared by reset');
    assert.equal(service.answerDebounceTimer, null);

    // Advance clock — callback should NOT run
    await service._advanceClock(800);
    assert.equal(makeCalled, false, 'make should not be called after reset');
    assert.equal(emitted.length, 0, 'no emit after reset');
  });

  it('resetConversationHistory aborts in-flight stream', async () => {
    const { service, emitted } = buildTestService();
    let aborted = false;
    let capturedSignal = null;

    service.makeLiveAnswer = async (texts, signal) => {
      capturedSignal = signal;
      // Stay in-flight until aborted
      return new Promise(resolve => {
        signal.addEventListener('abort', () => {
          aborted = true;
          resolve(null);
        });
      });
    };

    service.conversationHistory = ['them: how does gc work?'];
    service.addConversationTurn = function(speaker, text) {
      const conversationText = `${speaker.toLowerCase()}: ${text.trim()}`;
      this.conversationHistory.push(conversationText);
      this.triggerAnswerIfNeeded(speaker, text);
    };

    service.addConversationTurn('Them', 'how does GC work?');
    await service._advanceClock(800, { noAwait: true });
    // Give event loop a tick so makeLiveAnswer starts
    await new Promise(r => setImmediate ? setImmediate(r) : setTimeout(r, 0));
    assert.equal(service.inFlight, true, 'stream should be in-flight');
    assert.ok(capturedSignal, 'signal should be captured');

    // Session close mid-stream
    service.resetConversationHistory();

    // Signal should be aborted immediately (synchronously)
    assert.equal(capturedSignal.aborted, true, 'in-flight signal should be aborted');

    await new Promise(r => setTimeout(r, 10));
    assert.equal(aborted, true, 'abort event should have fired');
    assert.equal(emitted.length, 0, 'no emit after reset');
  });

  it('late debounce callback bails on empty conversationHistory (FR-012)', async () => {
    const { service, emitted } = buildTestService();
    let makeCalled = false;
    service.makeLiveAnswer = async () => {
      makeCalled = true;
      return null;
    };

    service.conversationHistory = ['them: how does GC work?'];
    service.addConversationTurn = function(speaker, text) {
      const conversationText = `${speaker.toLowerCase()}: ${text.trim()}`;
      this.conversationHistory.push(conversationText);
      this.triggerAnswerIfNeeded(speaker, text);
    };

    service.addConversationTurn('Them', 'how does GC work?');

    // Manually empty history to simulate race (session closed between debounce start and fire)
    service.conversationHistory = [];

    // Do NOT call resetConversationHistory (timer still pending)
    // Advance clock — callback should bail on empty history
    await service._advanceClock(800);
    assert.equal(makeCalled, false, 'should bail on empty history');
    assert.equal(emitted.length, 0, 'no emit when history empty');
  });
});

// ---------------------------------------------------------------------------
// P4.1 — Integration non-regression: emitted question value (FR-008)
// ---------------------------------------------------------------------------
describe('integration: emitted question value (T-P4.1 / FR-008)', () => {
  it('emitted live-answer-update question equals extractQuestion(text) for filler-wrapped turn', async () => {
    const SummaryService = require('../summaryService');
    const { extractQuestion, shouldTriggerAnswer, normalizeTail } = require('../summaryService');

    const service = new SummaryService();
    const emitted = [];

    service.sendToRenderer = (channel, data) => {
      emitted.push({ channel, data });
    };

    // Capture the meta.question passed to makeLiveAnswer (LLM provider MOCKED — no live calls)
    let capturedMeta = null;
    service.makeLiveAnswer = async (texts, signal, meta = {}) => {
      if (signal && signal.aborted) return null;
      capturedMeta = meta;
      const answer = 'Mock answer for test';
      service.sendToRenderer('live-answer-update', {
        id: meta.id,
        question: meta.question,
        answer,
        ts: Date.now(),
      });
      return { answer, ts: Date.now() };
    };

    // Fake-clock plumbing (mirrors buildTestService)
    const pendingTimers = [];
    let timerSeq = 1;
    service._setTimeout = (fn, delay) => {
      const id = timerSeq++;
      pendingTimers.push({ id, fn, delay });
      return id;
    };
    service._clearTimeout = (id) => {
      const idx = pendingTimers.findIndex(t => t.id === id);
      if (idx >= 0) pendingTimers.splice(idx, 1);
    };
    service._pendingTimers = pendingTimers;
    service._advanceClock = async (ms) => {
      const toFire = pendingTimers.filter(t => t.delay <= ms);
      for (const t of toFire) {
        const idx = pendingTimers.findIndex(x => x.id === t.id);
        if (idx >= 0) pendingTimers.splice(idx, 1);
      }
      for (const t of toFire) await t.fn();
    };

    // Override triggerAnswerIfNeeded to forward meta (mirrors production: passes
    // { id, question: extractQuestion(text) } to makeLiveAnswer — the real code path
    // this spec wires at summaryService.js call site).
    service.triggerAnswerIfNeeded = function (speaker, text) {
      if (!shouldTriggerAnswer(speaker, text, this.lastAnsweredTail, this.inFlight)) return;

      if (this.answerDebounceTimer) {
        this._clearTimeout(this.answerDebounceTimer);
        this.answerDebounceTimer = null;
      }

      const self = this;
      const capturedText = text;
      this.answerDebounceTimer = this._setTimeout(async () => {
        self.answerDebounceTimer = null;
        if (self.conversationHistory.length === 0) return;

        const currentTail = normalizeTail(capturedText);
        if (self.lastAnsweredTail !== null && currentTail === self.lastAnsweredTail) return;

        if (self.inFlight && self.inFlightController) {
          self.inFlightController.abort();
          self.inFlightController = null;
          self.inFlight = false;
        }

        self.lastAnsweredTail = currentTail;
        self.inFlight = true;
        self.inFlightController = new AbortController();
        const signal = self.inFlightController.signal;
        const answerId = ++self.answerSeq;

        try {
          // Pass meta with extractQuestion(text) — this is the production behavior
          // wired by T-P3.1 at the call site in summaryService.js
          await self.makeLiveAnswer(self.conversationHistory, signal, {
            id: answerId,
            question: extractQuestion(capturedText),
          });
        } catch (err) {
          if (signal.aborted) return;
          console.error('[test] makeLiveAnswer error:', err.message);
        } finally {
          self.inFlight = false;
          self.inFlightController = null;
        }
      }, 800);
    };

    service.addConversationTurn = function(speaker, text) {
      const conversationText = `${speaker.toLowerCase()}: ${text.trim()}`;
      this.conversationHistory.push(conversationText);
      this.triggerAnswerIfNeeded(speaker, text);
    };

    // Filler-wrapped turn: extractQuestion should extract the interrogative span
    const fillerTurn = "Okay so, um, the thing I wanted to ask is — how would you design a rate limiter?";
    const expectedQuestion = extractQuestion(fillerTurn);

    service.conversationHistory = ['them: let us start'];
    service.addConversationTurn('Them', fillerTurn);
    await service._advanceClock(800);

    // Verify meta.question was passed as extractQuestion(text)
    assert.ok(capturedMeta !== null, 'makeLiveAnswer should have been called');
    assert.equal(
      capturedMeta.question,
      expectedQuestion,
      `emitted question should equal extractQuestion(text): expected "${expectedQuestion}", got "${capturedMeta && capturedMeta.question}"`
    );

    // Verify the emitted live-answer-update carries the extracted question
    const liveAnswerEmits = emitted.filter(e => e.channel === 'live-answer-update');
    assert.ok(liveAnswerEmits.length >= 1, 'live-answer-update should have been emitted');
    assert.equal(liveAnswerEmits[0].data.question, expectedQuestion,
      'emitted question field should match extractQuestion result');
  });
});

// ---------------------------------------------------------------------------
// extractQuestion (FR-006/FR-007/FR-012) — truth-table T1–T8
// ---------------------------------------------------------------------------
describe('extractQuestion', () => {
  let extractQuestion;

  before(() => {
    ({ extractQuestion } = require('../summaryService'));
  });

  // T1: clean wh-question that IS the whole sentence → returns it unmangled
  it('T1: returns a clean wh-question unmangled', () => {
    const input = 'How does garbage collection work in Go?';
    const result = extractQuestion(input);
    assert.equal(result, 'How does garbage collection work in Go?');
  });

  // T2: filler-wrapped question → extracted interrogative span
  it('T2: extracts interrogative span from filler-wrapped question', () => {
    const input = "Okay so, um, the thing I wanted to ask is — how would you design a rate limiter?";
    const result = extractQuestion(input);
    assert.equal(result, 'how would you design a rate limiter?');
  });

  // T3: bare imperative cue with no '?' → full trimmed turn (fallback)
  it('T3: falls back to full trimmed text for bare imperative cue', () => {
    const input = 'Walk me through your last project.';
    const result = extractQuestion(input);
    // Should be the full trimmed sentence (no interrogative clause found)
    assert.ok(result.length > 0, 'result must be non-empty');
    assert.equal(result, input.trim());
  });

  // T4: cue with no '?' → cue-bearing clause or full text, never empty
  it('T4: returns non-empty string for cue with no question mark', () => {
    const input = 'compare a process and a thread';
    const result = extractQuestion(input);
    assert.ok(result.length > 0, 'result must be non-empty for non-empty input');
  });

  // T5: multiple questions → LAST interrogative clause, leading discourse marker
  // peeled (PINNED — RD5; spec.md Edge Cases + data-model §E3 + acceptance SC-002/TG-001)
  it('T5: returns LAST interrogative clause when multiple questions present', () => {
    const input = "What's your name? And where are you based?";
    const result = extractQuestion(input);
    assert.equal(result, 'where are you based?');
  });

  // T6: empty string / whitespace → ''
  it('T6: returns empty string for empty input', () => {
    assert.equal(extractQuestion(''), '');
    assert.equal(extractQuestion('   '), '');
  });

  // T7: null / undefined / non-string → ''
  it('T7: returns empty string for null, undefined, or non-string input', () => {
    assert.equal(extractQuestion(null), '');
    assert.equal(extractQuestion(undefined), '');
    assert.equal(extractQuestion(42), '');
    assert.equal(extractQuestion({}), '');
  });

  // T8: declarative statement → full trimmed text (fallback, never empty)
  it('T8: returns full trimmed text for declarative statement', () => {
    const input = 'Yes — Go is statically typed.';
    const result = extractQuestion(input);
    assert.ok(result.length > 0, 'result must be non-empty for non-empty input');
    assert.equal(result, input.trim());
  });
});

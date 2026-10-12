/**
 * providerChain.js
 *
 * Cross-provider failover (spec 2026-10-12-cross-provider-failover). A model
 * list may name several providers, e.g. three Groq models then two Gemini
 * models. factory.splitByProvider cuts it into segments (runs of one
 * provider's IDs); this module runs them in turn through each provider's
 * public createStreamingLLM / createLLM, so every provider keeps its own
 * failover, cooldowns, rounds, timeouts and image routing.
 *
 * Plan (decided per request; skips decided when a segment's turn comes):
 *  - with an image, segments that see images go first (stable), and a segment
 *    with a later one (with a key) that sees images runs with visionOnly: its
 *    text-only models do not answer without the image;
 *  - a segment whose provider has no key is skipped;
 *  - a segment whose models all cool down (modelHealth) is skipped while a
 *    later segment with a key has a healthy model;
 *  - an answer must start within chainDeadlineMs() across segments; a segment
 *    with a later one behind it keeps FALLBACK_RESERVE_MS for it. Each provider
 *    keeps its own wait before its second round (2-3 s), so a brief overload
 *    still resolves on the provider the user put first.
 *
 * Never calls an SDK, never logs prompt, answer or reasoning text, and gives
 * each provider its own key only. Providers are required when a segment runs,
 * so loading this module loads no SDK.
 */

'use strict';

const health = require('./providers/modelHealth');

/** Providers whose IDs can be cut into segments (factory.inferProviderFromModelId). */
const CHAIN_PROVIDERS = Object.freeze(['anthropic', 'gemini', 'groq']);
// Kept for a later segment while one can still run.
const FALLBACK_RESERVE_MS = 15_000;
// Longest a request may wait for an answer to start, across every segment.
const CHAIN_DEADLINE_MS = 60_000;

/** "60s", "0.08s", "12.35s" (the providers' format) */
const seconds = (ms) => `${Math.round(ms / 10) / 100}s`;

/**
 * Chain deadline, or null for none. LLM_CHAIN_DEADLINE_MS overrides; 0 disables.
 * @param {object} [env=process.env]
 * @returns {number|null} milliseconds
 */
function chainDeadlineMs(env = process.env) {
  const raw = env?.LLM_CHAIN_DEADLINE_MS;
  if (raw == null || String(raw).trim() === '') return CHAIN_DEADLINE_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return CHAIN_DEADLINE_MS;
  return n > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// Adapters (what the chain needs from each provider)
// ---------------------------------------------------------------------------

const groq = () => require('./providers/groq');
const gemini = () => require('./providers/gemini');
const anthropic = () => require('./providers/anthropic');

/**
 * The real providers. requestDeadlineMs is each provider's own exported
 * function, so its env override holds. firstModel is the model the provider
 * will try first, for the _reset that announces the switch.
 */
const DEFAULT_ADAPTERS = Object.freeze({
  groq: {
    id: 'groq',
    createStreamingLLM: (opts) => groq().createStreamingLLM(opts),
    createLLM: (opts) => groq().createLLM(opts),
    requestDeadlineMs: () => groq().requestDeadlineMs(),
    seesImages: (models) => models.some((m) => groq().modelTraits(m).vision),
    firstModel: (models, input) => health.pickModel(groq().orderForImages(models, input)),
  },
  gemini: {
    id: 'gemini',
    createStreamingLLM: (opts) => gemini().createStreamingLLM(opts),
    createLLM: (opts) => gemini().createLLM(opts),
    requestDeadlineMs: () => gemini().requestDeadlineMs(),
    seesImages: () => true,
    firstModel: (models) => health.pickModel(models),
  },
  anthropic: {
    id: 'anthropic',
    createStreamingLLM: (opts) => anthropic().createStreamingLLM(opts),
    createLLM: (opts) => anthropic().createLLM(opts),
    requestDeadlineMs: () => anthropic().requestDeadlineMs(),
    seesImages: () => true,
    firstModel: (models) => health.pickModel(models),
  },
});

// ---------------------------------------------------------------------------
// Plan (pure)
// ---------------------------------------------------------------------------

const isImagePart = (part) => !!part && typeof part === 'object' && ((part.type === 'image_url' && !!part.image_url) || !!part.inlineData);

/**
 * Whether Glass messages (or generateContent parts) carry an image.
 * @param {Array} input
 * @returns {boolean}
 */
function hasImages(input) {
  return (input || []).some((item) => {
    if (item && typeof item === 'object' && 'role' in item) return Array.isArray(item.content) && item.content.some(isImagePart);
    return isImagePart(item);
  });
}

/**
 * With an image, the segments that see images first (stable), then the rest;
 * otherwise the list order.
 * @param {Array<{provider: string, models: string[]}>} segments
 * @param {boolean} withImages
 * @param {object} adapters
 * @returns {{ segments: Array, reordered: boolean }}
 */
function orderSegments(segments, withImages, adapters) {
  if (!withImages) return { segments: [...segments], reordered: false };
  const sees = segments.map((s) => !!adapters[s.provider]?.seesImages(s.models));
  const ordered = [...segments.filter((s, i) => sees[i]), ...segments.filter((s, i) => !sees[i])];
  return { segments: ordered, reordered: ordered.some((s, i) => s !== segments[i]) };
}

/**
 * Why the segment at `index` is skipped when its turn comes, or null.
 *  - 'no-key': its provider has no key;
 *  - 'cooling': every model cools down and a later segment with a key has a
 *    model that does not (if every one cools down, they run in order).
 * @param {{ index: number, segments: Array, keys: object, isCoolingDown: function(string): boolean }} input
 * @returns {'no-key'|'cooling'|null}
 */
function skipReason({ index, segments, keys, isCoolingDown }) {
  const segment = segments[index];
  const hasKey = (s) => !!keys?.[s.provider];
  if (!hasKey(segment)) return 'no-key';
  if (segment.models.every(isCoolingDown)) {
    const healthyLater = segments.slice(index + 1).some((s) => hasKey(s) && s.models.some((m) => !isCoolingDown(m)));
    if (healthyLater) return 'cooling';
  }
  return null;
}

/**
 * Timing options for one segment.
 *  - requestDeadlineMs: the smaller of the provider's own deadline and the
 *    chain time left (less the reserve when a later segment can run); omitted
 *    once an answer started or when neither applies;
 *  - skip: 'deadline' when a later segment can run and no time is left.
 * The provider's wait before its second round is never changed.
 * @param {{ providerDeadlineMs: number|null, leftMs: number, laterCanRun: boolean, answerStarted: boolean }} input
 * @returns {{ requestDeadlineMs?: number, skip?: 'deadline' }}
 */
function segmentTiming({ providerDeadlineMs, leftMs, laterCanRun, answerStarted }) {
  const timing = {};
  if (answerStarted) return timing;
  const own = providerDeadlineMs > 0 ? providerDeadlineMs : Infinity;
  const deadline = Math.min(own, laterCanRun ? leftMs - FALLBACK_RESERVE_MS : leftMs);
  if (laterCanRun && deadline <= 0) timing.skip = 'deadline';
  else if (Number.isFinite(deadline)) timing.requestDeadlineMs = deadline;
  return timing;
}

/**
 * What the user reads when no segment answered.
 *  - one provider ran: its own message;
 *  - more: "All providers failed (groq → gemini). Last: …";
 *  - the chain deadline ended it: "No answer within 60s (groq → gemini). Last: …".
 * @param {{ ran: string[], last: Error & { userMessage?: string }, deadlineMs?: number }} input
 * @returns {string}
 */
function failureMessage({ ran, last, deadlineMs }) {
  const reason = last?.userMessage || last?.message || String(last);
  const trail = ran.join(' → ');
  if (deadlineMs != null) return `No answer within ${seconds(deadlineMs)} (${trail}). Last: ${reason}`;
  if (ran.length <= 1) return reason;
  return `All providers failed (${trail}). Last: ${reason}`;
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

/**
 * One line per segment whose turn came: provider, models, outcome, the model
 * that answered, time spent, and the provider's own short error message.
 * Never prompt, answer or reasoning text, never a key.
 */
function logSegment({ mode, index, of, segment, outcome, answeredBy, ms, err }) {
  const parts = [`[LLM Chain] segment ${index}/${of} ${mode} provider=${segment.provider} models=${segment.models.join(',')} outcome=${outcome}`];
  if (answeredBy) parts.push(`answered_by=${answeredBy}`);
  if (ms != null) parts.push(`total=${ms}ms`);
  if (err) parts.push(`error=${JSON.stringify(err.userMessage || err.message || String(err))}`);
  (outcome === 'failed' ? console.warn : console.log)(parts.join(' '));
}

/** Per-request summary: who answered and the end-to-end time across segments. */
function logRequest({ mode, answeredBy, provider, segmentsRun, ms, reordered = false, cancelled = false }) {
  const line = `[LLM Chain] request ${mode} answered_by=${answeredBy || 'none'} provider=${provider || 'none'} segments_run=${segmentsRun} total=${ms}ms${reordered ? ' order=images-first' : ''}${cancelled ? ' cancelled' : ''}`;
  (answeredBy || cancelled ? console.log : console.warn)(line);
}

// ---------------------------------------------------------------------------
// Turns (shared by the stream and non-stream paths)
// ---------------------------------------------------------------------------

/**
 * The request's plan: whether it carries an image, segment order, and the key
 * of each provider (the active one falls back to opts.apiKey when keys does
 * not name it).
 */
function planRequest({ segments, keys, apiKey, adapters, input }) {
  const withImages = hasImages(input);
  const { segments: ordered, reordered } = orderSegments(segments, withImages, adapters);
  const segmentKeys = { ...(keys || {}) };
  const active = segments[0]?.provider;
  if (active && !segmentKeys[active]) segmentKeys[active] = apiKey;
  return { withImages, ordered, reordered, segmentKeys };
}

/** The model a segment will try first, for the _reset; its first model when that cannot be told. */
function firstModelOf(adapter, segment, input) {
  try { return adapter.firstModel(segment.models, input); } catch { return segment.models[0]; }
}

/**
 * Decide the turn of segment i: skip it, stop (chain deadline passed), or
 * call it with these options: the caller's options, its own key, its models,
 * its timing (segmentTiming), and visionOnly when the request carries an
 * image that a later segment with a key sees (only Groq has models that drop
 * images; the other providers ignore the option).
 * @returns {{ skip: string } | { deadlineHit: true } | { adapter: object, options: object }}
 */
function decideTurn({ i, withImages, ordered, segmentKeys, adapters, base, deadlineMs, startedAt, answerStarted, now }) {
  const segment = ordered[i];
  const skip = skipReason({ index: i, segments: ordered, keys: segmentKeys, isCoolingDown: health.isCoolingDown });
  if (skip) return { skip };
  const leftMs = deadlineMs == null || answerStarted ? Infinity : startedAt + deadlineMs - now();
  if (leftMs <= 0) return { deadlineHit: true };
  const adapter = adapters[segment.provider];
  let providerDeadlineMs = null;
  try { providerDeadlineMs = adapter.requestDeadlineMs(); } catch {} // the call below reports a provider that cannot load
  const laterCanRun = ordered.slice(i + 1).some((s) => !!segmentKeys[s.provider]);
  const timing = segmentTiming({ providerDeadlineMs, leftMs, laterCanRun, answerStarted });
  if (timing.skip) return { skip: timing.skip };
  const options = { ...base, apiKey: segmentKeys[segment.provider], model: segment.models.join(',') };
  if (timing.requestDeadlineMs !== undefined) options.requestDeadlineMs = timing.requestDeadlineMs;
  if (withImages && laterSeesImages({ i, ordered, segmentKeys, adapters })) options.visionOnly = true;
  return { adapter, options };
}

/** Whether a segment after i, with a key, sees images. */
function laterSeesImages({ i, ordered, segmentKeys, adapters }) {
  return ordered.slice(i + 1).some((s) => !!segmentKeys[s.provider] && !!adapters[s.provider]?.seesImages(s.models));
}

/** The final error: the last segment's (or a stand-in), with the FR-013 userMessage. */
function finalError({ lastErr, ran, deadlineHit, deadlineMs }) {
  const err = lastErr && typeof lastErr === 'object'
    ? lastErr
    : new Error(lastErr != null ? String(lastErr) : 'No provider in the model list has an API key.');
  err.userMessage = failureMessage({ ran, last: err, deadlineMs: deadlineHit ? deadlineMs : undefined });
  return err;
}

// ---------------------------------------------------------------------------
// Stream
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const encode = (obj) => encoder.encode(`data: ${JSON.stringify(obj)}\n\n`);

/** What one SSE event (the text before its blank line) says: [DONE], answer text, the model in play. */
function inspectEvent(event) {
  const info = { done: false, answerText: false, model: null };
  for (const line of event.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') { info.done = true; continue; }
    let json;
    try { json = JSON.parse(data); } catch { continue; }
    if (json?.choices?.[0]?.delta?.content) info.answerText = true;
    if (typeof json?._final_model === 'string') info.model = json._final_model;
    else if (json?._reset && typeof json.next_model === 'string') info.model = json.next_model;
  }
  return info;
}

/**
 * The streaming chain over two or more segments.
 *
 * streamChat resolves at once with a Response whose body is SSE: the running
 * segment's events pass through unchanged (its deltas, _resets and
 * _final_model); its [DONE] becomes the chain's [DONE]. When a segment fails
 * (its stream errors, ends without [DONE], or its call throws) and another
 * can run, the chain sends { _reset, next_model, reason: 'provider' } and
 * runs it. When none answers, the stream errors with the last segment's
 * error, whose userMessage is failureMessage(). Cancelling the stream cancels
 * the running segment's reader (the provider aborts its request) and starts
 * nothing else, with no error.
 *
 * @param {object} input
 * @param {Array<{provider: string, models: string[]}>} input.segments - from factory.splitByProvider, list order
 * @param {object} [input.keys] - provider → key
 * @param {object} [input.opts] - the caller's options (apiKey: the active provider's key; keys and model are ignored)
 * @param {object} [input.adapters=DEFAULT_ADAPTERS]
 * @param {object} [input.env=process.env] - for chainDeadlineMs
 * @param {function(): number} [input.now=Date.now]
 */
function createChainStreamingLLM({ segments, keys, opts = {}, adapters = DEFAULT_ADAPTERS, env = process.env, now = Date.now }) {
  const { keys: _keys, apiKey, model: _model, ...base } = opts;

  return {
    streamChat: async (messages) => {
      // Shared with cancel(): the consumer gave up, so cancel the running
      // segment (its provider aborts the request) and start no other.
      let cancelled = false;
      let reader = null;

      const stream = new ReadableStream({
        cancel() {
          cancelled = true;
          if (reader) reader.cancel().catch(() => {});
        },
        async start(controller) {
          // Guard against enqueue-after-close: once the consumer cancels,
          // enqueue throws ERR_INVALID_STATE.
          const safeEnqueue = (chunk) => {
            if (controller.desiredSize === null) return false;
            try { controller.enqueue(chunk); return true; } catch { return false; }
          };
          const mode = 'stream';
          const startedAt = now();
          const deadlineMs = chainDeadlineMs(env);
          const { withImages, ordered, reordered, segmentKeys } = planRequest({ segments, keys, apiKey, adapters, input: messages });
          const of = ordered.length;
          const ran = [];
          let lastErr = null;
          let failedBefore = false; // a segment failed: the next one to run is announced
          let answerStarted = false;
          let deadlineHit = false;
          let answered = null;

          for (let i = 0; i < of && !cancelled; i++) {
            const segment = ordered[i];
            const turn = decideTurn({ i, withImages, ordered, segmentKeys, adapters, base, deadlineMs, startedAt, answerStarted, now });
            if (turn.deadlineHit) {
              deadlineHit = true;
              logSegment({ mode, index: i + 1, of, segment, outcome: 'skipped-deadline' });
              break;
            }
            if (turn.skip) {
              logSegment({ mode, index: i + 1, of, segment, outcome: `skipped-${turn.skip}` });
              continue;
            }

            let model = firstModelOf(turn.adapter, segment, messages);
            if (failedBefore) safeEnqueue(encode({ _reset: true, next_model: model, reason: 'provider' }));
            ran.push(segment.provider);
            const segmentStartedAt = now();
            const elapsed = () => now() - segmentStartedAt;
            let done = false;

            try {
              const response = await turn.adapter.createStreamingLLM(turn.options).streamChat(messages);
              if (cancelled) {
                response?.body?.cancel().catch(() => {});
              } else {
                reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffered = '';
                while (!done && !cancelled) {
                  const { done: ended, value } = await reader.read();
                  if (cancelled) break;
                  buffered += ended ? decoder.decode() : decoder.decode(value, { stream: true });
                  // A last event without its blank line still counts.
                  if (ended && buffered && !buffered.endsWith('\n\n')) buffered += '\n\n';
                  let cut;
                  while (!done && (cut = buffered.indexOf('\n\n')) !== -1) {
                    const event = buffered.slice(0, cut);
                    buffered = buffered.slice(cut + 2);
                    const info = inspectEvent(event);
                    if (info.done) { done = true; break; }
                    if (info.model) model = info.model;
                    if (info.answerText) answerStarted = true;
                    safeEnqueue(encoder.encode(`${event}\n\n`));
                  }
                  if (ended) break;
                }
                // The segment's stream is closed after its [DONE]; this only releases it.
                if (done) reader.cancel().catch(() => {});
                reader = null;
                if (!done && !cancelled) throw new Error(`${segment.provider}: the stream ended before [DONE]`);
              }
            } catch (err) {
              reader = null;
              if (!cancelled) {
                lastErr = err;
                failedBefore = true;
                logSegment({ mode, index: i + 1, of, segment, outcome: 'failed', ms: elapsed(), err });
                continue;
              }
            }

            if (cancelled) {
              logSegment({ mode, index: i + 1, of, segment, outcome: 'cancelled', ms: elapsed() });
              break;
            }
            answered = { model, provider: segment.provider };
            logSegment({ mode, index: i + 1, of, segment, outcome: 'ok', answeredBy: model, ms: elapsed() });
            break;
          }

          const ms = now() - startedAt;
          if (cancelled) {
            logRequest({ mode, answeredBy: null, provider: null, segmentsRun: ran.length, ms, reordered, cancelled: true });
            return;
          }
          if (answered) {
            logRequest({ mode, answeredBy: answered.model, provider: answered.provider, segmentsRun: ran.length, ms, reordered });
            safeEnqueue(encoder.encode('data: [DONE]\n\n'));
            try { controller.close(); } catch {}
            return;
          }
          logRequest({ mode, answeredBy: null, provider: null, segmentsRun: ran.length, ms, reordered });
          try { controller.error(finalError({ lastErr, ran, deadlineHit, deadlineMs })); } catch {}
        },
      });

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Non-stream
// ---------------------------------------------------------------------------

/**
 * The non-streaming chain (chat, generateContent) over two or more segments:
 * the same plan, skips, keys and timing as the stream. Each segment's
 * createLLM(...) method of the same name is tried in turn; the first result
 * is returned unchanged. When none answers, throws the last segment's error
 * with the failureMessage() userMessage.
 *
 * @param {object} input - as createChainStreamingLLM
 */
function createChainLLM({ segments, keys, opts = {}, adapters = DEFAULT_ADAPTERS, env = process.env, now = Date.now }) {
  const { keys: _keys, apiKey, model: _model, ...base } = opts;

  async function run(method, input) {
    const mode = 'once';
    const startedAt = now();
    const deadlineMs = chainDeadlineMs(env);
    const { withImages, ordered, reordered, segmentKeys } = planRequest({ segments, keys, apiKey, adapters, input });
    const of = ordered.length;
    const ran = [];
    let lastErr = null;
    let deadlineHit = false;

    for (let i = 0; i < of; i++) {
      const segment = ordered[i];
      const turn = decideTurn({ i, withImages, ordered, segmentKeys, adapters, base, deadlineMs, startedAt, answerStarted: false, now });
      if (turn.deadlineHit) {
        deadlineHit = true;
        logSegment({ mode, index: i + 1, of, segment, outcome: 'skipped-deadline' });
        break;
      }
      if (turn.skip) {
        logSegment({ mode, index: i + 1, of, segment, outcome: `skipped-${turn.skip}` });
        continue;
      }
      ran.push(segment.provider);
      const segmentStartedAt = now();
      try {
        const result = await turn.adapter.createLLM(turn.options)[method](input);
        const answeredBy = result?._modelUsed || firstModelOf(turn.adapter, segment, input);
        logSegment({ mode, index: i + 1, of, segment, outcome: 'ok', answeredBy, ms: now() - segmentStartedAt });
        logRequest({ mode, answeredBy, provider: segment.provider, segmentsRun: ran.length, ms: now() - startedAt, reordered });
        return result;
      } catch (err) {
        lastErr = err;
        logSegment({ mode, index: i + 1, of, segment, outcome: 'failed', ms: now() - segmentStartedAt, err });
      }
    }

    logRequest({ mode, answeredBy: null, provider: null, segmentsRun: ran.length, ms: now() - startedAt, reordered });
    throw finalError({ lastErr, ran, deadlineHit, deadlineMs });
  }

  return {
    chat: (messages) => run('chat', messages),
    generateContent: (parts) => run('generateContent', parts),
  };
}

module.exports = {
  CHAIN_PROVIDERS,
  FALLBACK_RESERVE_MS,
  DEFAULT_ADAPTERS,
  chainDeadlineMs,
  hasImages,
  orderSegments,
  skipReason,
  segmentTiming,
  failureMessage,
  createChainStreamingLLM,
  createChainLLM,
};

const { Groq, APIConnectionError } = require('groq-sdk');
const health = require('./modelHealth');
const catalog = require('../modelCatalog');
const { classify, retryAfterMs, retryAfterHeaderMs, shortErrorMessage, tooLargeNumbers, errorCode } = require('./groqErrors');

// ---------------------------------------------------------------------------
// Model traits (catalog, plus the reasoning dialect)
// ---------------------------------------------------------------------------

// How a reasoning family is asked to reason: which fields and efforts it
// takes (REASONING_EFFORTS). models.list says only that a model reasons
// (supported_features), not which fields it accepts, and a field a model does
// not know returns 400. So this stays a table: request format, like the SDK's
// types. A model that reasons in no family here gets no reasoning field and
// reasons at its own default.
const REASONING_DIALECTS = [
  { match: /^openai\/gpt-oss-/, family: 'gpt-oss' },
  { match: /^qwen\/qwen3/, family: 'qwen3' },
];

/**
 * What the model takes: vision and maxOutput from the catalog (override, else
 * Groq's models API, else no image and no cap); the reasoning dialect when
 * the catalog does not say the model does not reason.
 * @param {string} modelId
 * @returns {{ reasoning: 'gpt-oss'|'qwen3'|null, vision: boolean, maxOutput: number|null }}
 */
function modelTraits(modelId) {
  const id = String(modelId || '');
  const caps = catalog.capabilities('groq', id);
  const dialect = caps.reasoning === false ? null : REASONING_DIALECTS.find((d) => d.match.test(id));
  return { reasoning: dialect ? dialect.family : null, vision: caps.vision === true, maxOutput: caps.maxOutput ?? null };
}

/**
 * One entry of Groq's models list in the catalog's shape. A field Groq does
 * not send is null (unknown), not false.
 * @param {object} m - GET /openai/v1/models item
 */
function normalizeModel(m) {
  const modalities = Array.isArray(m?.input_modalities) ? m.input_modalities : null;
  const features = Array.isArray(m?.supported_features) ? m.supported_features : null;
  const max = Number(m?.max_completion_tokens ?? m?.max_output_length);
  return {
    id: m?.id,
    vision: modalities ? modalities.includes('image') : null,
    maxOutput: Number.isFinite(max) && max > 0 ? max : null,
    reasoning: features ? features.includes('reasoning') : null,
    effortLevels: null,
    thinking: null,
  };
}

// ---------------------------------------------------------------------------
// Request building (pure)
// ---------------------------------------------------------------------------

// Every Glass lane has someone waiting on the answer. gpt-oss thinks at every
// effort; qwen3's 'none' is its instruct mode, which answers without thinking.
const REASONING_EFFORTS = {
  'gpt-oss': { accepted: ['low', 'medium', 'high'], fallback: 'low' },
  qwen3: { accepted: ['none', 'default', 'low', 'medium', 'high'], fallback: 'none' },
};
// The cap for a caller that sets none, which today is only Ask. A code or
// system design answer runs to thousands of tokens (4,204 measured on
// gpt-oss-120b, research R20), and an Ask answer must not stop mid-way. The
// declared value is not metered against the per-minute limit (R5, R20). The
// exception is Qwen on a key with a 1K output limit, which refuses it as
// too-large; an image then goes to a later provider (visionOnly), and the
// catalog keeps the limit, so the next request over it skips Qwen without a call.
const DEFAULT_MAX_TOKENS = 16_384;
// Reasoning tokens count toward max_completion_tokens, so a caller's cap (Live
// Answer passes 900) could end inside the reasoning. The declared value is not
// metered against the per-minute limit (research R5), so the allowance is free.
const DEFAULT_REASONING_TOKENS = 1024;
const MAX_IMAGES = 3;

/** A number from the environment, or null when unset, blank or not a number. */
function envNumber(env, name) {
  const raw = env?.[name];
  if (raw == null || String(raw).trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function resolveEffort(family, effort, env) {
  const { accepted, fallback } = REASONING_EFFORTS[family];
  for (const value of [effort, env?.GROQ_REASONING_EFFORT]) {
    const level = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (accepted.includes(level)) return level;
  }
  return fallback;
}

function completionBudget({ maxTokens, reasons, maxOutput, env }) {
  const envMax = envNumber(env, 'GROQ_MAX_TOKENS');
  let max = Number.isFinite(maxTokens) && maxTokens > 0
    ? Math.floor(maxTokens)
    : envMax != null && envMax > 0 ? Math.floor(envMax) : DEFAULT_MAX_TOKENS;
  if (reasons) {
    const allowance = envNumber(env, 'GROQ_REASONING_TOKENS');
    max += allowance != null && allowance >= 0 ? Math.floor(allowance) : DEFAULT_REASONING_TOKENS;
  }
  return maxOutput != null ? Math.min(max, maxOutput) : max;
}

const dataUrl = (mimeType, data) => `data:${mimeType || 'image/jpeg'};base64,${data}`;

/** A Glass part as a chat-completions text or image part, or null. */
function toPart(part) {
  if (typeof part === 'string') return part ? { type: 'text', text: part } : null;
  if (!part || typeof part !== 'object') return null;
  if (part.type === 'text') return typeof part.text === 'string' && part.text ? { type: 'text', text: part.text } : null;
  if (part.type === 'image_url' && part.image_url?.url) return { type: 'image_url', image_url: { url: part.image_url.url } };
  if (part.inlineData?.data) return { type: 'image_url', image_url: { url: dataUrl(part.inlineData.mimeType, part.inlineData.data) } };
  return null;
}

/**
 * Glass messages to chat-completions messages: roles and order kept, empty
 * text dropped, images kept only for a model that sees them (at most 3 per
 * request) and counted otherwise. Content left with no image becomes one
 * string; a message left empty is dropped.
 */
function mapMessages(messages, vision) {
  const out = [];
  let imagesSent = 0;
  let imagesDropped = 0;
  for (const msg of messages || []) {
    if (!msg) continue;
    const role = msg.role === 'system' || msg.role === 'assistant' ? msg.role : 'user';
    const parts = [];
    for (const raw of Array.isArray(msg.content) ? msg.content : [msg.content]) {
      const part = toPart(raw);
      if (!part) continue;
      if (part.type === 'image_url') {
        if (!vision || imagesSent >= MAX_IMAGES) { imagesDropped++; continue; }
        imagesSent++;
      }
      parts.push(part);
    }
    if (parts.length === 0) continue;
    const content = parts.some((p) => p.type === 'image_url') ? parts : parts.map((p) => p.text).join('\n');
    out.push({ role, content });
  }
  return { messages: out, imagesSent, imagesDropped };
}

const isImagePart = (part) => !!part && typeof part === 'object' && ((part.type === 'image_url' && !!part.image_url) || !!part.inlineData);

/** Whether Glass messages (or generateContent parts) carry an image. */
function hasImages(items) {
  return (items || []).some((item) => {
    if (item && typeof item === 'object' && 'role' in item) return Array.isArray(item.content) && item.content.some(isImagePart);
    return isImagePart(item);
  });
}

/**
 * The attempt order: with an image in the request, the models that see
 * images first (list order), then the rest; otherwise the list as given.
 * @param {string[]} models
 * @param {Array} messages - Glass messages, or generateContent parts
 * @returns {string[]}
 */
function orderForImages(models, messages) {
  if (!hasImages(messages)) return [...models];
  return [...models.filter((m) => modelTraits(m).vision), ...models.filter((m) => !modelTraits(m).vision)];
}

/**
 * Build the chat-completions request for one attempt. Always streams, the
 * non-streaming lanes included: a non-streaming response sends its headers
 * only once the whole answer is written, which the SDK's 15 s timeout would
 * cut. Never sends max_tokens, top_p, logprobs, n, stream_options,
 * service_tier, tools, response_format or a message name.
 *
 * @param {object} input
 * @param {string} input.modelId
 * @param {Array} input.messages - Glass messages ({ role, content })
 * @param {number} [input.maxTokens] - caller cap; else GROQ_MAX_TOKENS; else 16,384
 * @param {number} [input.temperature] - sent when within [0, 2]
 * @param {string} [input.effort] - reasoning effort; else GROQ_REASONING_EFFORT; else the family default
 * @param {object} [input.env=process.env]
 * @returns {{ params: object, imagesSent: number, imagesDropped: number, effort: string|null }}
 */
function buildRequest({ modelId, messages, maxTokens, temperature, effort, env = process.env }) {
  const traits = modelTraits(modelId);
  const mapped = mapMessages(messages, traits.vision);
  const resolved = traits.reasoning ? resolveEffort(traits.reasoning, effort, env) : null;
  const reasons = traits.reasoning === 'gpt-oss' || (traits.reasoning === 'qwen3' && resolved !== 'none');

  const params = {
    model: modelId,
    messages: mapped.messages,
    stream: true,
    max_completion_tokens: completionBudget({ maxTokens, reasons, maxOutput: traits.maxOutput, env }),
  };
  if (typeof temperature === 'number' && Number.isFinite(temperature) && temperature >= 0 && temperature <= 2) {
    params.temperature = temperature;
  }
  if (traits.reasoning === 'gpt-oss') {
    params.reasoning_effort = resolved;
    // The reasoning text is never shown, so it is never sent.
    params.include_reasoning = false;
  } else if (traits.reasoning === 'qwen3') {
    params.reasoning_effort = resolved;
    if (resolved !== 'none') params.reasoning_format = 'hidden';
  }
  return { params, imagesSent: mapped.imagesSent, imagesDropped: mapped.imagesDropped, effort: resolved };
}

/**
 * The max_completion_tokens buildRequest declares for the model, without
 * building the request.
 * @param {{ modelId: string, maxTokens?: number, effort?: string, env?: object }} input
 * @returns {number}
 */
function declaredMaxTokens({ modelId, maxTokens, effort, env = process.env }) {
  const traits = modelTraits(modelId);
  const resolved = traits.reasoning ? resolveEffort(traits.reasoning, effort, env) : null;
  const reasons = traits.reasoning === 'gpt-oss' || (traits.reasoning === 'qwen3' && resolved !== 'none');
  return completionBudget({ maxTokens, reasons, maxOutput: traits.maxOutput, env });
}

// ---------------------------------------------------------------------------
// Timeouts
// ---------------------------------------------------------------------------

// Time allowed until the first text of an attempt. A healthy Groq model starts
// within a second or two (queue 0.1-1.5 s in the live checks); a longer
// silence means queueing or a stall.
const FIRST_TEXT_TIMEOUT_MS = 15_000;
// Longest a request may wait for an answer to start, across every attempt and
// the second round. Once an answer streams it no longer applies.
const REQUEST_DEADLINE_MS = 45_000;
// Once text streams, longest gap between two chunks.
const IDLE_TIMEOUT_MS = 15_000;

/**
 * First-text timeout. GROQ_FIRST_TEXT_TIMEOUT_MS overrides it.
 * @param {object} [env=process.env]
 * @returns {number} milliseconds
 */
function firstTextTimeoutMs(env = process.env) {
  const n = envNumber(env, 'GROQ_FIRST_TEXT_TIMEOUT_MS');
  return n != null && n > 0 ? n : FIRST_TEXT_TIMEOUT_MS;
}

/** The env value when ≥ 0 (0 → null, disabled), else the default. */
function optionalTimeoutMs(env, name, fallback) {
  const n = envNumber(env, name);
  if (n == null || n < 0) return fallback;
  return n > 0 ? n : null;
}

/**
 * Request deadline, or null for none. GROQ_REQUEST_DEADLINE_MS overrides; 0 disables.
 * @param {object} [env=process.env]
 * @returns {number|null} milliseconds
 */
function requestDeadlineMs(env = process.env) {
  return optionalTimeoutMs(env, 'GROQ_REQUEST_DEADLINE_MS', REQUEST_DEADLINE_MS);
}

/**
 * Idle timeout once text streams, or null for none. GROQ_IDLE_TIMEOUT_MS overrides; 0 disables.
 * @param {object} [env=process.env]
 * @returns {number|null} milliseconds
 */
function idleTimeoutMs(env = process.env) {
  return optionalTimeoutMs(env, 'GROQ_IDLE_TIMEOUT_MS', IDLE_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------
// SDK calls
// ---------------------------------------------------------------------------

// The SDK never retries: it would wait out the server's retry-after inside the
// attempt, uncapped and uncancellable. Failover and the second round are the
// loop's, so every wait is under our timers.
const SDK_MAX_RETRIES = 0;
// Time until response headers only; every chat call streams, so headers come
// once the request is accepted. The body is bounded by our own timers.
const SDK_TIMEOUT_MS = 15_000;

class GroqProvider {
  /**
   * Lists models: costs nothing and names no model, so a deprecation cannot
   * break it. Never throws.
   * @param {string} key
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  static async validateApiKey(key) {
    if (!key || typeof key !== 'string' || !key.startsWith('gsk_')) {
      return { success: false, error: 'Invalid Groq API key format.' };
    }

    try {
      const client = new Groq({ apiKey: key, maxRetries: SDK_MAX_RETRIES });
      await client.models.list({ maxRetries: SDK_MAX_RETRIES, timeout: SDK_TIMEOUT_MS });
      return { success: true };
    } catch (err) {
      if (err?.status === 401) return { success: false, error: 'Invalid Groq API key.' };
      if (err instanceof APIConnectionError || typeof err?.status !== 'number') {
        console.error('[GroqProvider] Network error during key validation:', shortErrorMessage(err));
        return { success: false, error: 'A network error occurred during validation.' };
      }
      return { success: false, error: shortErrorMessage(err) || `Validation failed with status: ${err.status}` };
    }
  }
}

/**
 * Every model of the key's list, for the catalog (modelCatalog.refresh). A
 * model Groq marks inactive is left out.
 * @param {string} apiKey
 * @returns {Promise<object[]>} normalizeModel entries
 */
async function listModels(apiKey) {
  const client = makeClient(apiKey);
  const page = await client.models.list({ maxRetries: SDK_MAX_RETRIES, timeout: SDK_TIMEOUT_MS });
  const data = Array.isArray(page?.data) ? page.data : [];
  return data.filter((m) => m?.id && m.active !== false).map(normalizeModel);
}

/**
 * One model the list did not name, for the catalog (modelCatalog.ensureKnown).
 * @param {string} apiKey
 * @param {string} modelId
 * @returns {Promise<object|null>} null when Groq has no such model
 */
async function getModel(apiKey, modelId) {
  const client = makeClient(apiKey);
  try {
    return normalizeModel(await client.models.retrieve(modelId, { maxRetries: SDK_MAX_RETRIES, timeout: SDK_TIMEOUT_MS }));
  } catch (err) {
    if (err?.status === 404) return null;
    throw err;
  }
}

/**
 * Groq's Whisper transcribes whole files; Glass needs a real-time session, so
 * STT stays on another provider. Placeholder with the shape the factory expects.
 * @returns {Promise<object>} STT session placeholder
 */
async function createSTT() {
  console.warn('[Groq] STT not supported. Use Gemini, Deepgram, OpenAI or Whisper for STT.');
  return {
    sendRealtimeInput: async () => {
      console.warn('[Groq] STT sendRealtimeInput called but not implemented');
    },
    close: async () => {
      console.log('[Groq] STT session closed');
    },
  };
}

// ---------------------------------------------------------------------------
// Failover
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = 'openai/gpt-oss-120b';
// Cooldowns (the registry clamps them to [5 s, 5 min]). Transient HTTP and
// stream errors use the server's retry hint, else 60 s (retryAfterMs).
const UNAVAILABLE_COOLDOWN_MS = 300_000;
// A stall, a budget spent on reasoning, a stream stopped early or a 422 is
// specific to one request: the model is kept out only briefly.
const SHORT_COOLDOWN_MS = 10_000;
// When every model of the list fails, the ones that failed fast get one more
// round after a short wait (brief overload bursts usually pass by then).
const MAX_ROUNDS = 2;
const RETRY_ROUND_DELAY_MS = 2_000;

/** "45s", "0.08s", "12.35s" */
const seconds = (ms) => `${Math.round(ms / 10) / 100}s`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const providerError = (code, message) => Object.assign(new Error(message), { code });
const headerOf = (headers, name) => (headers && typeof headers.get === 'function' ? headers.get(name) : null);

/**
 * Resolve after `ms`, or as soon as `signal` aborts.
 * @param {number} ms
 * @param {AbortSignal} signal
 * @returns {Promise<void>}
 */
function waitOrAbort(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/**
 * One line per model attempt, so the cost of failover is visible: which
 * model, how it ended, status and Groq code, time to first text, total time,
 * finish reason, effort, images, tokens, queue time, the per-minute token
 * headroom and request id. Never prompt, answer or reasoning text.
 *
 * @param {object} a
 * @param {'stream'|'once'} a.mode
 * @param {number} a.attempt - 1-based attempt index within the request
 * @param {number} a.of - planned attempts: size of the list (+ the second round's models)
 * @param {string} a.modelId
 * @param {string} a.outcome - 'ok' | 'cancelled' | 'timeout' | classify() kind
 * @param {object} a.stats
 * @param {unknown} [a.err]
 */
function logAttempt({ mode, attempt, of, modelId, outcome, stats, err }) {
  const parts = [`[Groq Provider] attempt ${attempt}/${of} ${mode} model=${modelId} outcome=${outcome}`];
  if (typeof err?.status === 'number') parts.push(`status=${err.status}`);
  const code = errorCode(err);
  if (code) parts.push(`code=${code}`);
  if (stats.firstTextAt != null) parts.push(`ttft=${stats.firstTextAt - stats.startedAt}ms`);
  // last vs total: how long the connection stayed open after the last text.
  if (stats.lastTextAt != null) parts.push(`last=${stats.lastTextAt - stats.startedAt}ms`);
  parts.push(`total=${Date.now() - stats.startedAt}ms`);
  if (stats.chunks) parts.push(`chunks=${stats.chunks}`);
  if (stats.finishReason) parts.push(`stop=${stats.finishReason}`);
  if (stats.effort) parts.push(`effort=${stats.effort}`);
  const images = [stats.imagesSent && `sent:${stats.imagesSent}`, stats.imagesDropped && `dropped:${stats.imagesDropped}`].filter(Boolean);
  if (images.length) parts.push(`images=${images.join(',')}`);
  const u = stats.usage;
  if (u) {
    parts.push(`tokens=in:${u.prompt_tokens ?? '-'},out:${u.completion_tokens ?? '-'},reasoning:${u.completion_tokens_details?.reasoning_tokens ?? 0},cached:${u.prompt_tokens_details?.cached_tokens ?? 0}`);
    if (typeof u.queue_time === 'number') parts.push(`queue=${Math.round(u.queue_time * 1000)}ms`);
  }
  const tpmLeft = stats.tpmLeft ?? headerOf(err?.headers, 'x-ratelimit-remaining-tokens');
  if (tpmLeft != null) parts.push(`tpm_left=${tpmLeft}`);
  // The numbers come late in Groq's message, past the cut of error= below.
  const tooLarge = err ? tooLargeNumbers(err) : null;
  if (tooLarge) parts.push(`limit=${tooLarge.limit} requested=${tooLarge.requested}`);
  if (stats.servedBy && stats.servedBy !== modelId) parts.push(`served_by=${stats.servedBy}`);
  const requestId = stats.requestId || headerOf(err?.headers, 'x-request-id');
  if (requestId) parts.push(`request_id=${requestId}`);
  if (err) parts.push(`error=${JSON.stringify(shortErrorMessage(err))}`);
  (outcome === 'ok' || outcome === 'cancelled' ? console.log : console.warn)(parts.join(' '));
}

/**
 * Per-request summary: end-to-end latency including every failed attempt.
 */
function logRequest({ mode, answeredBy, attempts, startedAt, reordered = false, cancelled = false }) {
  const line = `[Groq Provider] request ${mode} answered_by=${answeredBy || 'none'} attempts=${attempts} total=${Date.now() - startedAt}ms${reordered ? ' order=vision-first' : ''}${cancelled ? ' cancelled' : ''}`;
  (answeredBy || cancelled ? console.log : console.warn)(line);
}

const isTimeout = (err) => err?.code === 'FIRST_TEXT_TIMEOUT' || err?.code === 'IDLE_TIMEOUT';

/**
 * Whether a failed attempt is worth repeating in the second round: a fast
 * transient failure. Timeouts already cost seconds, a budget spent on
 * reasoning would be spent again, a 422 or a stream stopped early is about
 * this request, and a rate limit only joins when the server's own retry hint
 * fits in the wait.
 */
function joinsNextRound(err, kind, delayMs) {
  if (kind !== 'transient' || err?.code || err?.status === 422) return false;
  if (err?.status === 429 || errorCode(err) === 'rate_limit_exceeded') {
    const hint = retryAfterHeaderMs(err);
    return hint != null && hint <= delayMs;
  }
  return true;
}

function resetReason(err, kind) {
  if (isTimeout(err)) return 'timeout';
  if (kind === 'unavailable' || kind === 'too-large') return kind;
  return 'transient';
}

/** Cooldown for a failed attempt, or null for none (too-large: the next request may fit). */
function cooldownFor(err, kind) {
  if (kind === 'unavailable') return UNAVAILABLE_COOLDOWN_MS;
  if (kind === 'too-large') return null;
  return err?.code || err?.status === 422 ? SHORT_COOLDOWN_MS : retryAfterMs(err);
}

/** The failure, as the user reads it after "Last: ". */
function describeFailure(modelId, err, kind) {
  if (kind === 'unavailable') return `${modelId} is not available to this API key (decommissioned, blocked or not found). Pick a current model in Settings.`;
  if (kind === 'too-large') {
    const n = tooLargeNumbers(err);
    if (n?.output) return `${modelId} — asks for up to ${n.requested} output tokens; this key allows ${n.limit} per minute.`;
    if (n) return `${modelId} — request needs ${n.requested} tokens; this key allows ${n.limit} per minute. This request alone is over the limit: shorten the context or use a higher Groq tier.`;
  }
  return `${modelId} — ${shortErrorMessage(err)}`;
}

/**
 * Run one attempt on one model. Text goes to sink.text as it arrives.
 * Resolves on success, or quietly when the consumer is gone (stats.aborted /
 * control.cancelled()). Throws on any failure, including the provider's own:
 * FIRST_TEXT_TIMEOUT, IDLE_TIMEOUT, STREAM_ERROR, EMPTY_MAX_TOKENS.
 *
 * The SDK ends the iteration without throwing when its signal aborts, so our
 * timeouts are read from the stats flags after the loop, not from an error.
 * It also keeps reading after [DONE] until the server closes the connection,
 * so the attempt stops at the chunk that carries finish_reason.
 */
async function runAttempt({ client, modelId, messages, maxTokens, temperature, effort, stats, sink, control }) {
  const abortController = new AbortController();
  control.track(abortController);
  const stop = (why) => {
    if (!stats.timedOut) stats.timedOut = why;
    abortController.abort();
  };
  let idleTimer = null;
  const armIdle = () => {
    if (stats.idleMs == null) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => stop('idle'), stats.idleMs);
  };
  const firstTextTimer = setTimeout(() => stop('first-text'), stats.timeoutMs);

  try {
    const built = buildRequest({ modelId, messages, maxTokens, temperature, effort });
    stats.maxTokens = built.params.max_completion_tokens;
    stats.effort = built.effort;
    stats.imagesSent = built.imagesSent;
    stats.imagesDropped = built.imagesDropped;
    const options = { maxRetries: SDK_MAX_RETRIES, timeout: SDK_TIMEOUT_MS, signal: abortController.signal };
    const { data: chunks, response } = await client.chat.completions.create(built.params, options).withResponse();
    stats.requestId = headerOf(response?.headers, 'x-request-id');
    stats.tpmLeft = headerOf(response?.headers, 'x-ratelimit-remaining-tokens');

    for await (const chunk of chunks) {
      // Before the first text the first-text timeout governs; reasoning
      // chunks (never requested, but tolerated) do not start the answer.
      if (stats.firstTextAt != null) armIdle();
      if (chunk.x_groq?.id) stats.requestId = chunk.x_groq.id;
      if (chunk.model) stats.servedBy = chunk.model;
      if (chunk.x_groq?.error) {
        // The string may echo the request, so it is not kept.
        stats.streamError = true;
        break;
      }
      const choice = chunk.choices?.[0];
      const text = choice?.delta?.content;
      if (text) {
        const now = Date.now();
        if (stats.firstTextAt == null) {
          stats.firstTextAt = now;
          clearTimeout(firstTextTimer);
          armIdle();
        }
        stats.lastTextAt = now;
        stats.chunks++;
        if (!sink.text(text)) stats.aborted = true;
      }
      const usage = chunk.x_groq?.usage || chunk.usage;
      if (usage) stats.usage = usage;
      if (choice?.finish_reason) {
        stats.finishReason = choice.finish_reason;
        stats.stopped = true;
      }
      if (stats.stopped || stats.aborted) break;
    }
  } catch (err) {
    // An abort of ours ends the request with an abort error or quietly; the flags say why.
    if (!stats.timedOut && !stats.aborted && !control.cancelled()) throw err;
  } finally {
    clearTimeout(firstTextTimer);
    clearTimeout(idleTimer);
    // The answer is complete (or abandoned). Close the connection instead of
    // waiting for the server to.
    abortController.abort();
    control.untrack(abortController);
  }

  if (stats.aborted || control.cancelled()) return;
  if (stats.streamError) throw providerError('STREAM_ERROR', 'the stream was stopped early');
  if (!stats.stopped) {
    if (stats.timedOut === 'first-text') throw providerError('FIRST_TEXT_TIMEOUT', `no text after ${seconds(stats.timeoutMs)}`);
    if (stats.timedOut === 'idle') throw providerError('IDLE_TIMEOUT', `no chunk for ${seconds(stats.idleMs)} after text started`);
    throw new Error('stream ended before finish_reason');
  }
  if (stats.finishReason === 'length' && stats.firstTextAt == null) {
    throw providerError('EMPTY_MAX_TOKENS', `used its whole token budget (${stats.maxTokens}) before answering`);
  }
}

/**
 * One request over the model list, shared by streamChat and chat /
 * generateContent: order the list for images, pick a healthy model, attempt
 * it, classify the failure, cool the model down, fail over (announced through
 * sink.reset), give the fast failures a second round, and stop at the request
 * deadline.
 *
 * @param {object} o
 * @param {object} o.client - Groq client
 * @param {string} o.model - one Groq ID or a CSV list
 * @param {'stream'|'once'} o.mode
 * @param {Array} o.messages - Glass messages
 * @param {number} [o.maxTokens]
 * @param {number} [o.temperature]
 * @param {string} [o.effort]
 * @param {boolean} [o.visionOnly] - with an image, only the models that see images may answer
 * @param {object} o.timing - firstTextTimeoutMs / requestDeadlineMs / idleTimeoutMs overrides, retryRoundDelayMs
 * @param {object} o.sink - text(t) → false once the consumer is gone; reset({ next_model, reason })
 * @param {object} o.control - cancelled() → boolean; track(abortController) / untrack(abortController)
 * @returns {Promise<{ modelId: string, servedBy: string, stats: object } | null>} null when cancelled
 * @throws the last error, carrying a short userMessage; NO_VISION_MODEL, before any attempt,
 *   when visionOnly leaves no model
 */
async function runWithFailover({ client, model, mode, messages, maxTokens, temperature, effort, visionOnly, timing, sink, control }) {
  let listed = health.parseModelList(model);
  if (listed.length === 0) listed = [DEFAULT_MODEL];
  let remaining = orderForImages(listed, messages);
  const reordered = remaining.some((m, i) => m !== listed[i]);
  // A later provider sees the image (providerChain): a text-only model here
  // would answer without it, so it is left to that provider.
  if (visionOnly && hasImages(messages)) {
    remaining = remaining.filter((m) => modelTraits(m).vision);
    if (remaining.length === 0) {
      console.warn(`[Groq Provider] request ${mode} answered_by=none attempts=0 no model sees images: ${listed.join(',')}`);
      const err = providerError('NO_VISION_MODEL', 'no model in the list sees images');
      err.userMessage = 'No Groq model in the list sees images.';
      throw err;
    }
  }
  // The key's output limit, learned from an earlier refusal (catalog): a model
  // whose declared cap is over it would be refused before answering, so it is
  // left out without a call. A smaller cap (Live Answer's 900) still runs there.
  const overLimit = [];
  const candidates = remaining;
  remaining = remaining.filter((m) => {
    const limit = catalog.keyOutputLimit('groq', m);
    if (limit == null) return true;
    const requested = declaredMaxTokens({ modelId: m, maxTokens, effort });
    if (requested <= limit) return true;
    overLimit.push({ modelId: m, limit, requested });
    return false;
  });
  for (const s of overLimit) {
    console.warn(`[Groq Provider] skip model=${s.modelId} reason=key-output-limit limit=${s.limit} requested=${s.requested}`);
  }
  if (remaining.length === 0) {
    const s = overLimit[0];
    console.warn(`[Groq Provider] request ${mode} answered_by=none attempts=0 every candidate is over this key's output limit: ${candidates.join(',')}`);
    const err = providerError('KEY_OUTPUT_LIMIT', `asks for up to ${s.requested} output tokens; this key allows ${s.limit} per minute`);
    err.userMessage = `${s.modelId} — asks for up to ${s.requested} output tokens; this key allows ${s.limit} per minute.`;
    throw err;
  }
  // Planned attempts for the "attempt i/n" log; grows when a second round starts.
  let plannedAttempts = remaining.length;
  let retryable = []; // models of this round worth another try (joinsNextRound)
  let round = 1;
  let attempts = 0;
  let lastErr = null;
  let lastKind = null;
  let lastModel = null;
  const startedAt = Date.now();

  const delayMs = timing.retryRoundDelayMs ?? RETRY_ROUND_DELAY_MS;
  const deadlineSetting = timing.requestDeadlineMs !== undefined ? timing.requestDeadlineMs : requestDeadlineMs();
  const deadlineMs = deadlineSetting > 0 ? deadlineSetting : null;
  const idleSetting = timing.idleTimeoutMs !== undefined ? timing.idleTimeoutMs : idleTimeoutMs();
  const idleMs = idleSetting > 0 ? idleSetting : null;
  // The request deadline applies until an answer starts (any text).
  let answerStarted = false;
  let deadlineHit = false;
  const timeLeft = () => (deadlineMs == null || answerStarted ? Infinity : startedAt + deadlineMs - Date.now());

  const endCancelled = (modelId, stats) => {
    // If text had arrived the model was answering: it is reported as
    // answered_by (with "cancelled") and kept healthy.
    const answered = stats.firstTextAt != null;
    logAttempt({ mode, attempt: attempts, of: plannedAttempts, modelId, outcome: 'cancelled', stats });
    if (answered) health.markSucceeded(modelId);
    logRequest({ mode, answeredBy: answered ? stats.servedBy || modelId : null, attempts, startedAt, reordered, cancelled: true });
    return null;
  };

  while (!control.cancelled()) {
    if (remaining.length === 0) {
      if (round >= MAX_ROUNDS || retryable.length === 0) break;
      if (timeLeft() <= delayMs) { deadlineHit = true; break; }
      round++;
      remaining = retryable;
      retryable = [];
      plannedAttempts += remaining.length;
      console.warn(`[Groq Provider] all models failed — retry round ${round} in ${delayMs}ms: ${remaining.join(',')}`);
      sink.reset({ next_model: remaining[0], reason: 'retry' });
      const waitAbort = new AbortController();
      control.track(waitAbort);
      await waitOrAbort(delayMs, waitAbort.signal);
      control.untrack(waitAbort);
      continue;
    }

    const left = timeLeft();
    if (left <= 0) { deadlineHit = true; break; }
    const modelId = health.pickModel(remaining);
    // The attempt's own budget, shortened to what is left of the request deadline.
    const modelTimeoutMs = timing.firstTextTimeoutMs ?? firstTextTimeoutMs();
    const stats = {
      startedAt: Date.now(), timeoutMs: Math.min(modelTimeoutMs, left), idleMs,
      firstTextAt: null, lastTextAt: null, chunks: 0, finishReason: null, usage: null,
      servedBy: null, requestId: null, tpmLeft: null, maxTokens: null, effort: null,
      imagesSent: 0, imagesDropped: 0,
      stopped: false, streamError: false, timedOut: null, aborted: false,
    };
    lastModel = modelId;
    attempts++;

    try {
      await runAttempt({ client, modelId, messages, maxTokens, temperature, effort, stats, sink, control });
    } catch (rawErr) {
      if (control.cancelled()) return endCancelled(modelId, stats);
      const err = rawErr && typeof rawErr === 'object' ? rawErr : new Error(String(rawErr));
      const kind = classify(err);
      lastErr = err;
      lastKind = kind;
      if (stats.firstTextAt != null) answerStarted = true;
      logAttempt({ mode, attempt: attempts, of: plannedAttempts, modelId, outcome: isTimeout(err) ? 'timeout' : kind, stats, err });
      if (kind === 'too-large') {
        // Over the key's output tokens per minute: refused before answering. Kept
        // in the catalog, so the next request over it skips the model.
        const n = tooLargeNumbers(err);
        if (n?.output) catalog.recordKeyOutputLimit('groq', modelId, n.limit);
      }

      if (kind === 'fatal-request' || kind === 'fatal-auth') {
        logRequest({ mode, answeredBy: null, attempts, startedAt, reordered });
        err.userMessage = `${modelId} — ${shortErrorMessage(err)}`;
        throw err;
      }
      const cooldown = cooldownFor(err, kind);
      if (cooldown != null) health.markFailed(modelId, cooldown);
      if (joinsNextRound(err, kind, delayMs)) retryable.push(modelId);
      remaining = remaining.filter(m => m !== modelId);
      // A first-text timeout cut short by the deadline: the deadline is reached.
      if (err.code === 'FIRST_TEXT_TIMEOUT' && stats.timeoutMs < modelTimeoutMs) { deadlineHit = true; break; }
      if (remaining.length > 0 && timeLeft() > 0) {
        sink.reset({ next_model: health.pickModel(remaining), reason: resetReason(err, kind) });
      }
      continue;
    }

    if (stats.aborted || control.cancelled()) return endCancelled(modelId, stats);
    logAttempt({ mode, attempt: attempts, of: plannedAttempts, modelId, outcome: 'ok', stats });
    health.markSucceeded(modelId);
    const servedBy = stats.servedBy || modelId;
    logRequest({ mode, answeredBy: servedBy, attempts, startedAt, reordered });
    return { modelId, servedBy, stats };
  }

  if (control.cancelled()) {
    logRequest({ mode, answeredBy: null, attempts, startedAt, reordered, cancelled: true });
    return null;
  }
  logRequest({ mode, answeredBy: null, attempts, startedAt, reordered });
  if (deadlineHit) console.warn(`[Groq Provider] request deadline reached — no answer within ${deadlineMs}ms`);

  const err = lastErr || new Error('no model was tried');
  const failure = describeFailure(lastModel, err, lastKind);
  if (attempts === 1 && !deadlineHit && (lastKind === 'unavailable' || lastKind === 'too-large')) {
    err.userMessage = failure;
  } else {
    const tried = `${plural(attempts, 'attempt')}${round > 1 ? `, ${round} rounds` : ''}`;
    err.userMessage = deadlineHit
      ? `No answer within ${seconds(deadlineMs)} (${tried}). Last: ${failure}`
      : `All Groq models failed (${tried}). Last: ${failure}`;
  }
  throw err;
}

// ---------------------------------------------------------------------------
// LLM instances
// ---------------------------------------------------------------------------

function makeClient(apiKey) {
  return new Groq({ apiKey, maxRetries: SDK_MAX_RETRIES, timeout: SDK_TIMEOUT_MS });
}

/**
 * Creates a Groq LLM instance (chat, generateContent) with failover. Calls
 * stream internally and return the joined text; the shapes match the other
 * providers, plus _modelUsed. Failures throw with a short userMessage.
 *
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} [opts.model='openai/gpt-oss-120b'] - one Groq ID or a CSV list, tried in order (image-capable models first for images)
 * @param {number} [opts.maxTokens] - default GROQ_MAX_TOKENS, else 16,384; plus the reasoning allowance on models that reason
 * @param {number} [opts.temperature] - sent when within [0, 2]
 * @param {string} [opts.effort] - reasoning effort (default GROQ_REASONING_EFFORT, else low for gpt-oss and none for qwen3)
 * @param {boolean} [opts.visionOnly] - a request with an image goes only to the models that see images
 *   (set by providerChain when a later provider sees it); the request fails instead of dropping the image
 * @param {number} [opts.firstTextTimeoutMs] - overrides firstTextTimeoutMs() for every model
 * @param {number|null} [opts.requestDeadlineMs] - overrides requestDeadlineMs(); null disables
 * @param {number|null} [opts.idleTimeoutMs] - overrides idleTimeoutMs(); null disables
 * @param {number} [opts.retryRoundDelayMs] - wait before the second round (default 2 s)
 */
function createLLM({ apiKey, model = DEFAULT_MODEL, maxTokens, temperature, effort, visionOnly, firstTextTimeoutMs: firstTextOverride, requestDeadlineMs: deadlineOverride, idleTimeoutMs: idleOverride, retryRoundDelayMs = RETRY_ROUND_DELAY_MS }) {
  const client = makeClient(apiKey);
  const timing = { firstTextTimeoutMs: firstTextOverride, requestDeadlineMs: deadlineOverride, idleTimeoutMs: idleOverride, retryRoundDelayMs };
  // No consumer can cancel a non-streaming call.
  const control = { cancelled: () => false, track: () => {}, untrack: () => {} };

  async function complete(messages) {
    let text = '';
    // A failed attempt's partial text is dropped before the next attempt.
    const sink = { text: (t) => { text += t; return true; }, reset: () => { text = ''; } };
    await catalog.ensureKnown('groq', apiKey, health.parseModelList(model));
    const { servedBy, stats } = await runWithFailover({ client, model, mode: 'once', messages, maxTokens, temperature, effort, visionOnly, timing, sink, control });
    const raw = {
      model: servedBy,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: stats.finishReason }],
      usage: stats.usage,
    };
    return { text, raw, servedBy };
  }

  return {
    generateContent: async (parts) => {
      // Every part is user content (strings and inlineData images); none is promoted to the system prompt.
      const { text, raw, servedBy } = await complete([{ role: 'user', content: parts }]);
      return { response: { text: () => text }, raw, _modelUsed: servedBy };
    },

    chat: async (messages) => {
      const { text, raw, servedBy } = await complete(messages);
      return { content: text, raw, _modelUsed: servedBy };
    },
  };
}

/**
 * Creates a Groq streaming LLM instance with failover.
 *
 * streamChat resolves at once with a Response whose body is SSE in the
 * OpenAI delta shape, plus the control lines the consumers already read:
 * { _reset, next_model, reason } before another attempt (the partial answer
 * is to be discarded), { _final_model } and [DONE] on success. A failure
 * errors the stream with an error carrying a short `userMessage`.
 * Cancelling the returned stream aborts the in-flight request (or the wait
 * between rounds) and stops failover, with no error.
 *
 * @param {object} opts - as createLLM
 */
function createStreamingLLM({ apiKey, model = DEFAULT_MODEL, maxTokens, temperature, effort, visionOnly, firstTextTimeoutMs: firstTextOverride, requestDeadlineMs: deadlineOverride, idleTimeoutMs: idleOverride, retryRoundDelayMs = RETRY_ROUND_DELAY_MS }) {
  const client = makeClient(apiKey);
  const timing = { firstTextTimeoutMs: firstTextOverride, requestDeadlineMs: deadlineOverride, idleTimeoutMs: idleOverride, retryRoundDelayMs };

  return {
    streamChat: async (messages) => {
      // Shared with cancel(): the consumer (Ask window closed / new request,
      // Live Answer replaced) gave up, so abort the in-flight request (or the
      // wait between rounds) and stop.
      let cancelled = false;
      const inFlight = new Set();
      const control = {
        cancelled: () => cancelled,
        track: (abortController) => {
          if (cancelled) abortController.abort();
          inFlight.add(abortController);
        },
        untrack: (abortController) => inFlight.delete(abortController),
      };
      const encode = (obj) => new TextEncoder().encode(`data: ${JSON.stringify(obj)}\n\n`);

      const stream = new ReadableStream({
        cancel() {
          cancelled = true;
          for (const abortController of inFlight) abortController.abort();
        },
        async start(controller) {
          // Guard against enqueue-after-close: once the consumer cancels,
          // `controller.desiredSize` is null and enqueue throws ERR_INVALID_STATE.
          const safeEnqueue = (chunk) => {
            if (controller.desiredSize === null) return false;
            try { controller.enqueue(chunk); return true; } catch { return false; }
          };
          const sink = {
            text: (text) => safeEnqueue(encode({ choices: [{ delta: { content: text } }] })),
            reset: ({ next_model, reason }) => { safeEnqueue(encode({ _reset: true, next_model, reason })); },
          };
          try {
            await catalog.ensureKnown('groq', apiKey, health.parseModelList(model));
            const result = await runWithFailover({ client, model, mode: 'stream', messages, maxTokens, temperature, effort, visionOnly, timing, sink, control });
            if (!result) return;
            safeEnqueue(encode({ _final_model: result.servedBy }));
            safeEnqueue(new TextEncoder().encode('data: [DONE]\n\n'));
            try { controller.close(); } catch {}
          } catch (err) {
            if (cancelled) return;
            console.error(`[Groq Provider] ${err?.userMessage || shortErrorMessage(err)}`);
            try { controller.error(err); } catch {}
          }
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    },
  };
}

module.exports = {
  GroqProvider,
  createSTT,
  createLLM,
  createStreamingLLM,
  listModels,
  getModel,
  normalizeModel,
  modelTraits,
  buildRequest,
  declaredMaxTokens,
  orderForImages,
  firstTextTimeoutMs,
  requestDeadlineMs,
  idleTimeoutMs,
};

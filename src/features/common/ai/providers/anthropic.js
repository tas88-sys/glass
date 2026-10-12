const { Anthropic, APIConnectionError } = require('@anthropic-ai/sdk');
const health = require('./modelHealth');
const catalog = require('../modelCatalog');
const { classify, retryAfterMs, retryAfterHeaderMs, shortErrorMessage } = require('./anthropicErrors');

// Whether Glass messages (or generateContent parts) carry an image. Required
// when called: providerChain requires the providers lazily too.
const hasImages = (input) => require('../providerChain').hasImages(input);

// ---------------------------------------------------------------------------
// Request building (pure)
// ---------------------------------------------------------------------------

// Every Glass lane has someone waiting on the answer.
const DEFAULT_EFFORT = 'low';
// Thinking counts toward max_tokens, so a small cap (Live Answer passes 900)
// can run out inside thinking, before any text. Floor on models that think.
const MIN_MAX_TOKENS = 4096;
const DEFAULT_MAX_TOKENS = { stream: 16_000, once: 8_192 };
// Server-side refusal fallback, "default" form. Sent to every model until the
// API rejects it for one (the catalog keeps that).
const SERVER_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/**
 * The effort levels the model takes in output_config.effort, from the
 * catalog (the Models API's capabilities.effort). Empty when the model takes
 * none (Haiku 4.5 and Sonnet 4.5 reject effort with a 400) or when the
 * catalog does not know the model: then no effort is sent.
 * @param {string} modelId
 * @returns {string[]}
 */
function effortLevels(modelId) {
  return catalog.capabilities('anthropic', String(modelId || '')).effortLevels || [];
}

/**
 * Whether the model takes output_config.effort (catalog).
 * @param {string} modelId
 * @returns {boolean}
 */
function acceptsEffort(modelId) {
  return effortLevels(modelId).length > 0;
}

/**
 * One model of the Models API in the catalog's shape. A capability the API
 * does not send is null (unknown), not false.
 * @param {object} m - GET /v1/models item
 */
function normalizeModel(m) {
  const caps = m?.capabilities && typeof m.capabilities === 'object' ? m.capabilities : null;
  const supported = (node) => (node && typeof node === 'object' && typeof node.supported === 'boolean' ? node.supported : null);
  let levels = null;
  const effort = caps?.effort;
  if (effort && typeof effort === 'object') {
    levels = supported(effort) === false
      ? []
      : Object.entries(effort).filter(([k, v]) => k !== 'supported' && supported(v) === true).map(([k]) => k);
  }
  const thinking = supported(caps?.thinking);
  const max = Number(m?.max_tokens);
  return {
    id: m?.id,
    vision: supported(caps?.image_input),
    maxOutput: Number.isFinite(max) && max > 0 ? max : null,
    reasoning: thinking,
    effortLevels: levels,
    thinking,
  };
}

/** A number from the environment, or null when unset, blank or not a number. */
function envNumber(env, name) {
  const raw = env?.[name];
  if (raw == null || String(raw).trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** The caller's effort, else ANTHROPIC_EFFORT, else low, among the model's levels; else its first level. */
function resolveEffort(effort, env, levels) {
  for (const value of [effort, env?.ANTHROPIC_EFFORT, DEFAULT_EFFORT]) {
    const level = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (levels.includes(level)) return level;
  }
  return levels[0];
}

function minMaxTokens(env) {
  const n = envNumber(env, 'ANTHROPIC_MIN_MAX_TOKENS');
  return n != null && n > 0 ? Math.floor(n) : MIN_MAX_TOKENS;
}

function serverFallbackOff(env) {
  return String(env?.ANTHROPIC_SERVER_FALLBACK ?? '').trim().toLowerCase() === 'off';
}

function imageFromDataUrl(url) {
  const s = String(url || '');
  const comma = s.indexOf(',');
  const head = comma >= 0 ? s.slice(0, comma) : '';
  const mediaType = /^data:([^;,]+)/.exec(head)?.[1] || 'image/jpeg';
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data: comma >= 0 ? s.slice(comma + 1) : s } };
}

/**
 * One Glass part to an Anthropic block: strings and text parts to text,
 * image_url data URLs and generateContent inlineData to base64 images. Empty
 * text is dropped (the API rejects it).
 */
function toBlock(part) {
  if (typeof part === 'string') return part ? { type: 'text', text: part } : null;
  if (!part || typeof part !== 'object') return null;
  if (part.type === 'text') return typeof part.text === 'string' && part.text ? { type: 'text', text: part.text } : null;
  if (part.type === 'image_url' && part.image_url) return imageFromDataUrl(part.image_url.url);
  if (part.inlineData) {
    return { type: 'image', source: { type: 'base64', media_type: part.inlineData.mimeType || 'image/jpeg', data: part.inlineData.data } };
  }
  return null;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(p => (typeof p === 'string' ? p : p?.type === 'text' ? p.text : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * Glass messages to { system, messages }: system messages joined with a blank
 * line; consecutive messages with the same role merged (the API wants them
 * alternating). Images are dropped (and counted) for a model that does not
 * see them.
 */
function mapMessages(messages, vision = true) {
  const system = [];
  const out = [];
  let imagesDropped = 0;
  for (const msg of messages || []) {
    if (!msg) continue;
    if (msg.role === 'system') {
      const text = textOf(msg.content);
      if (text) system.push(text);
      continue;
    }
    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    const content = (Array.isArray(msg.content) ? msg.content : [msg.content]).map(toBlock).filter((block) => {
      if (!block) return false;
      if (block.type === 'image' && !vision) { imagesDropped++; return false; }
      return true;
    });
    if (content.length === 0) continue;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...content);
    else out.push({ role, content });
  }
  return { system: system.join('\n\n'), messages: out, imagesDropped };
}

/**
 * Build the Messages API request for one attempt. Never sends temperature,
 * top_p, top_k or thinking (current models reject non-default sampling, and
 * thinking keeps each model's default). Every call streams, the non-streaming
 * lanes included: a non-streaming response sends its headers only once the
 * whole answer is written, which the SDK's 15 s timeout would cut.
 *
 * What the model takes comes from the catalog (the Models API, or an
 * override in Settings): the effort levels (none known: no effort), whether
 * it thinks (the max_tokens floor; unknown counts as thinking, so a small cap
 * never ends inside thinking), its output maximum (the cap never goes over
 * it), whether it sees images, and whether the API refused the server-side
 * fallback beta for it.
 *
 * @param {object} input
 * @param {string} input.modelId
 * @param {Array} input.messages - Glass messages ({ role, content })
 * @param {number} [input.maxTokens] - caller cap; default by mode
 * @param {string} [input.effort] - one of the model's levels; else ANTHROPIC_EFFORT; else low
 * @param {'stream'|'once'} [input.mode='stream'] - picks the default max_tokens
 * @param {boolean} [input.serverFallback=true] - false once the API rejected the beta
 * @param {object} [input.env=process.env]
 * @returns {{ method: 'messages'|'beta', params: object, imagesDropped: number }}
 */
function buildRequest({ modelId, messages, maxTokens, effort, mode = 'stream', serverFallback = true, env = process.env }) {
  const caps = catalog.capabilities('anthropic', String(modelId || ''));
  const { system, messages: mapped, imagesDropped } = mapMessages(messages, caps.vision !== false);
  const levels = caps.effortLevels || [];
  const thinks = caps.effortLevels ? levels.length > 0 : caps.thinking !== false;
  let max = Number.isFinite(maxTokens) && maxTokens > 0
    ? Math.floor(maxTokens)
    : DEFAULT_MAX_TOKENS[mode === 'once' ? 'once' : 'stream'];
  if (thinks) max = Math.max(max, minMaxTokens(env));
  if (caps.maxOutput != null) max = Math.min(max, caps.maxOutput);

  const params = { model: modelId, max_tokens: max, messages: mapped, stream: true };
  if (system) params.system = system;
  if (levels.length > 0) params.output_config = { effort: resolveEffort(effort, env, levels) };

  if (!serverFallback || serverFallbackOff(env) || caps.serverFallback === false) {
    return { method: 'messages', params, imagesDropped };
  }
  params.betas = [SERVER_FALLBACK_BETA];
  params.fallbacks = 'default';
  return { method: 'beta', params, imagesDropped };
}

// ---------------------------------------------------------------------------
// Timeouts
// ---------------------------------------------------------------------------

// Time allowed until the first text of an attempt. Thinking streams as empty
// blocks and pings (which the SDK hides), so the wait is silent. The Haiku
// family thinks little at low effort.
const FIRST_TEXT_TIMEOUT_HAIKU_MS = 20_000;
const FIRST_TEXT_TIMEOUT_DEFAULT_MS = 45_000;
// Longest a request may wait for an answer to start, across every attempt and
// the second round. Once an answer streams it no longer applies.
const REQUEST_DEADLINE_MS = 60_000;
// Once text streams, longest gap between two stream events.
const IDLE_TIMEOUT_MS = 30_000;

/**
 * Per-model first-text timeout. ANTHROPIC_FIRST_TEXT_TIMEOUT_MS overrides it
 * for every model.
 * @param {string} modelId
 * @param {object} [env=process.env]
 * @returns {number} milliseconds
 */
function firstTextTimeoutMs(modelId, env = process.env) {
  const n = envNumber(env, 'ANTHROPIC_FIRST_TEXT_TIMEOUT_MS');
  if (n != null && n > 0) return n;
  return /(^|-)haiku(-|$)/i.test(String(modelId || '')) ? FIRST_TEXT_TIMEOUT_HAIKU_MS : FIRST_TEXT_TIMEOUT_DEFAULT_MS;
}

/** The env value when ≥ 0 (0 → null, disabled), else the default. */
function optionalTimeoutMs(env, name, fallback) {
  const n = envNumber(env, name);
  if (n == null || n < 0) return fallback;
  return n > 0 ? n : null;
}

/**
 * Request deadline, or null for none. ANTHROPIC_REQUEST_DEADLINE_MS overrides; 0 disables.
 * @param {object} [env=process.env]
 * @returns {number|null} milliseconds
 */
function requestDeadlineMs(env = process.env) {
  return optionalTimeoutMs(env, 'ANTHROPIC_REQUEST_DEADLINE_MS', REQUEST_DEADLINE_MS);
}

/**
 * Idle timeout once text streams, or null for none. ANTHROPIC_IDLE_TIMEOUT_MS overrides; 0 disables.
 * @param {object} [env=process.env]
 * @returns {number|null} milliseconds
 */
function idleTimeoutMs(env = process.env) {
  return optionalTimeoutMs(env, 'ANTHROPIC_IDLE_TIMEOUT_MS', IDLE_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------
// SDK calls
// ---------------------------------------------------------------------------

// The SDK never retries: it would wait out the server's retry-after inside the
// attempt, however long (0.133 has no cap). Failover and the second round are
// the loop's, so every wait is under our timers.
const SDK_MAX_RETRIES = 0;
// Time until response headers only; every Messages call streams, so headers
// come once the request is accepted. The body is bounded by our own timers.
const SDK_TIMEOUT_MS = 15_000;

class AnthropicProvider {
  /**
   * Lists one model: costs nothing and names no model, so a model retirement
   * cannot break it. Never throws.
   * @param {string} key
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  static async validateApiKey(key) {
    if (!key || typeof key !== 'string' || !key.startsWith('sk-ant-')) {
      return { success: false, error: 'Invalid Anthropic API key format.' };
    }

    try {
      const client = new Anthropic({ apiKey: key, maxRetries: SDK_MAX_RETRIES });
      await client.models.list({ limit: 1 }, { maxRetries: SDK_MAX_RETRIES, timeout: SDK_TIMEOUT_MS });
      return { success: true };
    } catch (err) {
      if (err?.status === 401) return { success: false, error: 'Invalid Anthropic API key.' };
      if (err instanceof APIConnectionError || typeof err?.status !== 'number') {
        console.error('[AnthropicProvider] Network error during key validation:', shortErrorMessage(err));
        return { success: false, error: 'A network error occurred during validation.' };
      }
      return { success: false, error: shortErrorMessage(err) || `Validation failed with status: ${err.status}` };
    }
  }
}

/**
 * Every model of the key's list, for the catalog (modelCatalog.refresh). The
 * SDK pages through the list. A retired model (lifecycle) is left out: a
 * request naming it fails.
 * @param {string} apiKey
 * @returns {Promise<object[]>} normalizeModel entries
 */
async function listModels(apiKey) {
  const client = makeClient(apiKey);
  const out = [];
  for await (const m of client.models.list({ limit: 1000 }, { maxRetries: SDK_MAX_RETRIES, timeout: SDK_TIMEOUT_MS })) {
    if (m?.id && m.lifecycle !== 'retired') out.push(normalizeModel(m));
  }
  return out;
}

/**
 * One model the list did not name (an alias), for the catalog
 * (modelCatalog.ensureKnown).
 * @param {string} apiKey
 * @param {string} modelId
 * @returns {Promise<object|null>} null when the API has no such model
 */
async function getModel(apiKey, modelId) {
  const client = makeClient(apiKey);
  try {
    return normalizeModel(await client.models.retrieve(modelId, {}, { maxRetries: SDK_MAX_RETRIES, timeout: SDK_TIMEOUT_MS }));
  } catch (err) {
    if (err?.status === 404) return null;
    throw err;
  }
}

/**
 * Creates an Anthropic STT session
 * Note: Anthropic doesn't have native real-time STT, so this is a placeholder
 * You might want to use a different STT service or implement a workaround
 * @param {object} opts - Configuration options
 * @param {string} opts.apiKey - Anthropic API key
 * @param {string} [opts.language='en'] - Language code
 * @param {object} [opts.callbacks] - Event callbacks
 * @returns {Promise<object>} STT session placeholder
 */
async function createSTT({ apiKey, language = "en", callbacks = {}, ...config }) {
  console.warn("[Anthropic] STT not natively supported. Consider using OpenAI or Gemini for STT.")

  // Return a mock STT session that doesn't actually do anything
  // You might want to fallback to another provider for STT
  return {
    sendRealtimeInput: async (audioData) => {
      console.warn("[Anthropic] STT sendRealtimeInput called but not implemented")
    },
    close: async () => {
      console.log("[Anthropic] STT session closed")
    },
  }
}

// ---------------------------------------------------------------------------
// Failover
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = 'claude-opus-5-5';
// Cooldowns (the registry clamps them to [5 s, 5 min]). Transient HTTP and
// stream errors use the server's retry hint, else 60 s (retryAfterMs).
const UNAVAILABLE_COOLDOWN_MS = 300_000;
// A stall, or a budget spent on thinking, is specific to one request: the
// model is kept out only briefly.
const TIMEOUT_COOLDOWN_MS = 10_000;
// When every model of the list fails, the ones that failed fast get one more
// round after a short wait (brief overload bursts usually pass by then).
const MAX_ROUNDS = 2;
const RETRY_ROUND_DELAY_MS = 2_000;

/** "45s", "0.08s", "12.35s" */
const seconds = (ms) => `${Math.round(ms / 10) / 100}s`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const providerError = (code, message) => Object.assign(new Error(message), { code });

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
 * model, how it ended, status, time to first text, total time, stop reason,
 * tokens, server-side fallback and request id. Never prompt or answer text.
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
  const parts = [`[Anthropic Provider] attempt ${attempt}/${of} ${mode} model=${modelId} outcome=${outcome}`];
  if (typeof err?.status === 'number') parts.push(`status=${err.status}`);
  if (stats.firstTextAt != null) parts.push(`ttft=${stats.firstTextAt - stats.startedAt}ms`);
  // last vs total: how long the connection stayed open after the last text.
  if (stats.lastTextAt != null) parts.push(`last=${stats.lastTextAt - stats.startedAt}ms`);
  parts.push(`total=${Date.now() - stats.startedAt}ms`);
  if (stats.chunks) parts.push(`chunks=${stats.chunks}`);
  if (stats.stopReason) parts.push(`stop=${stats.stopReason}`);
  if (stats.refusalCategory) parts.push(`category=${stats.refusalCategory}`);
  const u = stats.usage;
  if (u) parts.push(`tokens=in:${u.input_tokens ?? '-'},out:${u.output_tokens ?? '-'},cache_read:${u.cache_read_input_tokens ?? 0}`);
  if (stats.imagesDropped) parts.push(`images=dropped:${stats.imagesDropped}`);
  if (stats.fallbackFrom) parts.push(`fallback=${stats.fallbackFrom}→${stats.servedBy}`);
  else if (stats.servedBy && stats.servedBy !== modelId) parts.push(`served_by=${stats.servedBy}`);
  const requestId = err?.requestID || stats.requestId;
  if (requestId) parts.push(`request_id=${requestId}`);
  if (err) parts.push(`error=${JSON.stringify(shortErrorMessage(err))}`);
  (outcome === 'ok' || outcome === 'cancelled' ? console.log : console.warn)(parts.join(' '));
}

/**
 * Per-request summary: end-to-end latency including every failed attempt.
 */
function logRequest({ mode, answeredBy, attempts, startedAt, cancelled = false }) {
  const line = `[Anthropic Provider] request ${mode} answered_by=${answeredBy || 'none'} attempts=${attempts} total=${Date.now() - startedAt}ms${cancelled ? ' cancelled' : ''}`;
  (answeredBy || cancelled ? console.log : console.warn)(line);
}

const isTimeout = (err) => err?.code === 'FIRST_TEXT_TIMEOUT' || err?.code === 'IDLE_TIMEOUT';

/**
 * Whether a failed attempt is worth repeating in the second round: a fast
 * transient failure. Timeouts already cost 20-45 s, a budget spent on
 * thinking would be spent again, and a rate limit only joins when the
 * server's own retry hint fits in the wait.
 */
function joinsNextRound(err, kind, delayMs) {
  if (kind !== 'transient' || err?.code) return false;
  if (err?.status === 429 || err?.type === 'rate_limit_error') {
    const hint = retryAfterHeaderMs(err);
    return hint != null && hint <= delayMs;
  }
  return true;
}

function resetReason(err, kind) {
  if (isTimeout(err)) return 'timeout';
  if (kind === 'unavailable' || kind === 'refusal') return kind;
  return 'transient';
}

/** Cooldown for a failed attempt, or null for none (refusals). */
function cooldownFor(err, kind) {
  if (kind === 'unavailable') return UNAVAILABLE_COOLDOWN_MS;
  if (kind === 'refusal') return null;
  return err?.code ? TIMEOUT_COOLDOWN_MS : retryAfterMs(err);
}

/** The failure, as the user reads it after "Last: ". */
function describeFailure(modelId, err, kind) {
  if (kind === 'unavailable') return `${modelId} is not available to this API key (retired or not enabled). Pick a current model in Settings.`;
  if (kind === 'refusal') return `${modelId} declined to answer.`;
  return `${modelId} — ${shortErrorMessage(err)}`;
}

/**
 * Send one Messages request (always streaming) and return its event
 * iterator. A 400 on the beta method is resent once without the beta: when
 * that is accepted, the beta was the cause (an org or a model without it),
 * and the catalog keeps it, so that model is not sent the beta again. When
 * the resend fails too, its error is the attempt's and nothing is recorded.
 */
async function openStream({ client, modelId, mode, messages, maxTokens, effort, stats, signal }) {
  const options = { maxRetries: SDK_MAX_RETRIES, timeout: SDK_TIMEOUT_MS, signal };
  const request = (serverFallback) => buildRequest({ modelId, messages, maxTokens, effort, mode, serverFallback });
  const send = async ({ method, params, imagesDropped }) => {
    stats.maxTokens = params.max_tokens;
    stats.imagesDropped = imagesDropped;
    const api = method === 'beta' ? client.beta.messages : client.messages;
    const { data, request_id: requestId } = await api.create(params, options).withResponse();
    stats.requestId = requestId || null;
    return data;
  };

  const first = request(true);
  try {
    return await send(first);
  } catch (err) {
    if (first.method !== 'beta' || signal.aborted || err?.status !== 400) throw err;
    const data = await send(request(false));
    catalog.markServerFallback('anthropic', modelId, false);
    console.warn(`[Anthropic Provider] server-side fallback off for model=${modelId}: ${shortErrorMessage(err)}`);
    return data;
  }
}

/**
 * Run one attempt on one model. Text goes to sink.text as it arrives.
 * Resolves on success, or quietly when the consumer is gone (stats.aborted /
 * control.cancelled()). Throws on any failure, including the provider's own:
 * FIRST_TEXT_TIMEOUT, IDLE_TIMEOUT, REFUSAL, EMPTY_MAX_TOKENS.
 *
 * The SDK ends the iteration without throwing when its signal aborts, so our
 * timeouts are read from the stats flags after the loop, not from an error.
 */
async function runAttempt({ client, modelId, mode, messages, maxTokens, effort, stats, sink, control }) {
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
    const events = await openStream({ client, modelId, mode, messages, maxTokens, effort, stats, signal: abortController.signal });
    for await (const event of events) {
      // Pings never reach us (the SDK drops them), so before the first text
      // the first-text timeout governs and the idle timer is off.
      if (stats.firstTextAt != null) armIdle();
      switch (event.type) {
        case 'message_start':
          stats.servedBy = event.message?.model || null;
          stats.usage = { ...event.message?.usage };
          break;
        case 'content_block_start':
          // Server-side fallback: another model continues the same answer.
          if (event.content_block?.type === 'fallback') {
            stats.fallbackFrom = stats.fallbackFrom || event.content_block.from?.model || stats.servedBy || modelId;
            stats.servedBy = event.content_block.to?.model || stats.servedBy;
          }
          break;
        case 'content_block_delta': {
          const text = event.delta?.type === 'text_delta' ? event.delta.text : '';
          if (!text) break;
          const now = Date.now();
          if (stats.firstTextAt == null) {
            stats.firstTextAt = now;
            clearTimeout(firstTextTimer);
            armIdle();
          }
          stats.lastTextAt = now;
          stats.chunks++;
          if (!sink.text(text)) stats.aborted = true;
          break;
        }
        case 'message_delta':
          if (event.delta?.stop_reason) stats.stopReason = event.delta.stop_reason;
          if (event.delta?.stop_details?.category) stats.refusalCategory = event.delta.stop_details.category;
          for (const [key, value] of Object.entries(event.usage || {})) {
            if (value != null) stats.usage = { ...stats.usage, [key]: value };
          }
          break;
        case 'message_stop':
          stats.stopped = true;
          break;
      }
      if (stats.stopped || stats.aborted) break;
    }
  } catch (err) {
    // An abort of ours ends the request with an abort error or quietly; the flags say why.
    if (!stats.timedOut && !stats.aborted && !control.cancelled()) throw err;
  } finally {
    clearTimeout(firstTextTimer);
    clearTimeout(idleTimer);
    // The answer is complete (or abandoned). The server can keep the
    // connection open after message_stop; close it instead of waiting.
    abortController.abort();
    control.untrack(abortController);
  }

  if (stats.aborted || control.cancelled()) return;
  if (!stats.stopped) {
    if (stats.timedOut === 'first-text') throw providerError('FIRST_TEXT_TIMEOUT', `no text after ${seconds(stats.timeoutMs)}`);
    if (stats.timedOut === 'idle') throw providerError('IDLE_TIMEOUT', `no stream event for ${seconds(stats.idleMs)} after text started`);
    throw new Error('stream ended before message_stop');
  }
  if (stats.stopReason === 'refusal') {
    throw providerError('REFUSAL', `declined to answer${stats.refusalCategory ? ` (${stats.refusalCategory})` : ''}`);
  }
  if (stats.stopReason === 'max_tokens' && stats.firstTextAt == null) {
    throw providerError('EMPTY_MAX_TOKENS', `used its whole token budget (${stats.maxTokens}) before answering`);
  }
}

/**
 * One request over the model list, shared by streamChat and chat /
 * generateContent: pick a healthy model, attempt it, classify the failure,
 * cool the model down, fail over (announced through sink.reset), give the
 * fast failures a second round, and stop at the request deadline.
 *
 * @param {object} o
 * @param {object} o.client - Anthropic client
 * @param {string} o.model - one Claude ID or a CSV list
 * @param {'stream'|'once'} o.mode
 * @param {Array} o.messages - Glass messages
 * @param {number} [o.maxTokens]
 * @param {string} [o.effort]
 * @param {boolean} [o.visionOnly] - with an image, only the models that see images may answer
 * @param {object} o.timing - firstTextTimeoutMs / requestDeadlineMs / idleTimeoutMs overrides, retryRoundDelayMs
 * @param {object} o.sink - text(t) → false once the consumer is gone; reset({ next_model, reason })
 * @param {object} o.control - cancelled() → boolean; track(abortController) / untrack(abortController)
 * @returns {Promise<{ modelId: string, servedBy: string, stats: object } | null>} null when cancelled
 * @throws the last error, carrying a short userMessage; NO_VISION_MODEL, before any attempt,
 *   when visionOnly leaves no model
 */
async function runWithFailover({ client, model, mode, messages, maxTokens, effort, visionOnly, timing, sink, control }) {
  let listed = health.parseModelList(model);
  if (listed.length === 0) listed = [DEFAULT_MODEL];
  // With an image, the models that see it go first (catalog); a model that
  // does not see images gets the request without them.
  const withImages = hasImages(messages);
  let remaining = catalog.orderForImages('anthropic', listed, withImages);
  // A later provider sees the image (providerChain): a model here that does
  // not would answer without it, so it is left to that provider.
  if (visionOnly && withImages) {
    remaining = remaining.filter((m) => catalog.seesImages('anthropic', m));
    if (remaining.length === 0) {
      console.warn(`[Anthropic Provider] request ${mode} answered_by=none attempts=0 no model sees images: ${listed.join(',')}`);
      const err = providerError('NO_VISION_MODEL', 'no model in the list sees images');
      err.userMessage = 'No Anthropic model in the list sees images.';
      throw err;
    }
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
    logRequest({ mode, answeredBy: answered ? stats.servedBy || modelId : null, attempts, startedAt, cancelled: true });
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
      console.warn(`[Anthropic Provider] all models failed — retry round ${round} in ${delayMs}ms: ${remaining.join(',')}`);
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
    const modelTimeoutMs = timing.firstTextTimeoutMs ?? firstTextTimeoutMs(modelId);
    const stats = {
      startedAt: Date.now(), timeoutMs: Math.min(modelTimeoutMs, left), idleMs,
      firstTextAt: null, lastTextAt: null, chunks: 0, stopReason: null, refusalCategory: null, usage: null,
      servedBy: null, fallbackFrom: null, requestId: null, maxTokens: null,
      stopped: false, timedOut: null, aborted: false,
    };
    lastModel = modelId;
    attempts++;

    try {
      await runAttempt({ client, modelId, mode, messages, maxTokens, effort, stats, sink, control });
    } catch (rawErr) {
      if (control.cancelled()) return endCancelled(modelId, stats);
      const err = rawErr && typeof rawErr === 'object' ? rawErr : new Error(String(rawErr));
      const kind = classify(err);
      lastErr = err;
      lastKind = kind;
      if (stats.firstTextAt != null) answerStarted = true;
      logAttempt({ mode, attempt: attempts, of: plannedAttempts, modelId, outcome: isTimeout(err) ? 'timeout' : kind, stats, err });

      if (kind === 'fatal-request' || kind === 'fatal-auth') {
        logRequest({ mode, answeredBy: null, attempts, startedAt });
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
    logRequest({ mode, answeredBy: servedBy, attempts, startedAt });
    return { modelId, servedBy, stats };
  }

  if (control.cancelled()) {
    logRequest({ mode, answeredBy: null, attempts, startedAt, cancelled: true });
    return null;
  }
  logRequest({ mode, answeredBy: null, attempts, startedAt });
  if (deadlineHit) console.warn(`[Anthropic Provider] request deadline reached — no answer within ${deadlineMs}ms`);

  const err = lastErr || new Error('no model was tried');
  const failure = describeFailure(lastModel, err, lastKind);
  if (attempts === 1 && !deadlineHit && (lastKind === 'unavailable' || lastKind === 'refusal')) {
    err.userMessage = failure;
  } else {
    const tried = `${plural(attempts, 'attempt')}${round > 1 ? `, ${round} rounds` : ''}`;
    err.userMessage = deadlineHit
      ? `No answer within ${seconds(deadlineMs)} (${tried}). Last: ${failure}`
      : `All Claude models failed (${tried}). Last: ${failure}`;
  }
  throw err;
}

// ---------------------------------------------------------------------------
// LLM instances
// ---------------------------------------------------------------------------

function makeClient(apiKey) {
  return new Anthropic({ apiKey, maxRetries: SDK_MAX_RETRIES, timeout: SDK_TIMEOUT_MS });
}

/**
 * Creates an Anthropic LLM instance (chat, generateContent) with failover.
 * Calls stream internally and return the joined text; the shapes match the
 * other providers, plus _modelUsed. Failures throw with a short userMessage.
 *
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} [opts.model='claude-opus-5-5'] - one Claude ID or a CSV list, tried in order
 * @param {number} [opts.maxTokens] - default 8192; at least 4096 on models that think
 * @param {string} [opts.effort] - one of the model's effort levels (default ANTHROPIC_EFFORT, else low)
 * @param {boolean} [opts.visionOnly] - a request with an image goes only to the models that see images
 *   (set by providerChain when a later provider sees it)
 * @param {number} [opts.temperature] - accepted for compatibility; never sent
 * @param {number} [opts.firstTextTimeoutMs] - overrides firstTextTimeoutMs(modelId) for every model
 * @param {number|null} [opts.requestDeadlineMs] - overrides requestDeadlineMs(); null disables
 * @param {number|null} [opts.idleTimeoutMs] - overrides idleTimeoutMs(); null disables
 * @param {number} [opts.retryRoundDelayMs] - wait before the second round (default 2 s)
 */
function createLLM({ apiKey, model = DEFAULT_MODEL, maxTokens, effort, visionOnly, firstTextTimeoutMs: firstTextOverride, requestDeadlineMs: deadlineOverride, idleTimeoutMs: idleOverride, retryRoundDelayMs = RETRY_ROUND_DELAY_MS }) {
  const client = makeClient(apiKey);
  const timing = { firstTextTimeoutMs: firstTextOverride, requestDeadlineMs: deadlineOverride, idleTimeoutMs: idleOverride, retryRoundDelayMs };
  // No consumer can cancel a non-streaming call.
  const control = { cancelled: () => false, track: () => {}, untrack: () => {} };

  async function complete(messages) {
    let text = '';
    // A failed attempt's partial text is dropped before the next attempt.
    const sink = { text: (t) => { text += t; return true; }, reset: () => { text = ''; } };
    await catalog.ensureKnown('anthropic', apiKey, health.parseModelList(model));
    const { servedBy, stats } = await runWithFailover({ client, model, mode: 'once', messages, maxTokens, effort, visionOnly, timing, sink, control });
    const raw = { model: servedBy, stop_reason: stats.stopReason, usage: stats.usage, content: [{ type: 'text', text }] };
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
 * Creates an Anthropic streaming LLM instance with failover.
 *
 * streamChat resolves at once with a Response whose body is SSE in the
 * OpenAI delta shape, plus the control lines the consumers already read:
 * { _reset, next_model, reason } before another attempt (the partial answer
 * is to be discarded), { _final_model } and [DONE] on success. A failure
 * errors the stream with an error carrying a short `userMessage`.
 * Cancelling the returned stream aborts the in-flight request (or the wait
 * between rounds) and stops failover, with no error.
 *
 * @param {object} opts - as createLLM; maxTokens defaults to 16000
 */
function createStreamingLLM({ apiKey, model = DEFAULT_MODEL, maxTokens, effort, visionOnly, firstTextTimeoutMs: firstTextOverride, requestDeadlineMs: deadlineOverride, idleTimeoutMs: idleOverride, retryRoundDelayMs = RETRY_ROUND_DELAY_MS }) {
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
            await catalog.ensureKnown('anthropic', apiKey, health.parseModelList(model));
            const result = await runWithFailover({ client, model, mode: 'stream', messages, maxTokens, effort, visionOnly, timing, sink, control });
            if (!result) return;
            safeEnqueue(encode({ _final_model: result.servedBy }));
            safeEnqueue(new TextEncoder().encode('data: [DONE]\n\n'));
            try { controller.close(); } catch {}
          } catch (err) {
            if (cancelled) return;
            console.error(`[Anthropic Provider] ${err?.userMessage || shortErrorMessage(err)}`);
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
  AnthropicProvider,
  createSTT,
  createLLM,
  createStreamingLLM,
  listModels,
  getModel,
  normalizeModel,
  buildRequest,
  acceptsEffort,
  effortLevels,
  firstTextTimeoutMs,
  requestDeadlineMs,
  idleTimeoutMs,
};

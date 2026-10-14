/**
 * openaiCompatible.js
 *
 * An LLM provider for any server that speaks the OpenAI chat-completions API
 * at a base URL the user types in Settings: a provider's own endpoint
 * (SambaNova, Mistral, OpenRouter, NVIDIA NIM), or a local gateway such as
 * OmniRoute (spec 2026-10-14-openai-compatible-provider). One endpoint at a
 * time; the endpoint's model IDs are typed as a list, like Groq's.
 *
 * The saved credential is the base URL and the API key in one string
 * (formatCredential), so it is stored, encrypted and handed around exactly
 * like the other providers' keys: the chain, the catalog and Settings need no
 * second field.
 *
 * Failover follows groq.js: an ordered list with cooldowns, a second round for
 * fast transient failures, a first-text timeout, an idle timeout, a request
 * deadline, cancellation that stops the HTTP request, one log line per
 * attempt. Two differences, because the models behind one endpoint may come
 * from different upstreams: a model that refuses a request (400, 422) hands
 * it to the next model instead of ending it, and the cooldowns are kept under
 * this provider's own names (healthKey), so a Groq model and the same ID here
 * do not share one.
 */

'use strict';

const OpenAI = require('openai');
const health = require('./modelHealth');
const catalog = require('../modelCatalog');
const { classify, retryAfterMs, retryAfterHeaderMs, shortErrorMessage, errorCode } = require('./openaiCompatibleErrors');

const PROVIDER_ID = 'openai-compatible';

// ---------------------------------------------------------------------------
// Credential (base URL + API key in one saved string)
// ---------------------------------------------------------------------------

// Neither a URL nor a key holds a line break, and a Settings input cannot type one.
const CREDENTIAL_SEPARATOR = '\n';
// The key the SDK sends when the endpoint needs none (a local server without auth).
const NO_KEY = 'none';
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1'];

/**
 * The base URL, checked: https, or http on this machine only (a key sent over
 * plain http to another host could be read on the way). Trailing slashes are
 * dropped; the path is kept (it usually ends in /v1).
 * @param {string} raw
 * @returns {{ baseURL: string } | { error: string }}
 */
function checkBaseURL(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return { error: 'Enter the base URL of the OpenAI-compatible API (e.g. http://localhost:20128/v1).' };
  let url;
  try {
    url = new URL(text);
  } catch {
    return { error: `"${text}" is not a URL.` };
  }
  const local = LOCAL_HOSTS.includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    return { error: 'The base URL must use https (http is accepted only for localhost).' };
  }
  if (url.username || url.password) return { error: 'Put the API key in its own field, not in the URL.' };
  if (url.search || url.hash) return { error: 'The base URL takes no query or fragment.' };
  return { baseURL: `${url.origin}${url.pathname.replace(/\/+$/, '')}` };
}

/**
 * The saved credential for a base URL and key. The key may be empty.
 * @param {string} baseURL
 * @param {string} [apiKey]
 * @returns {string}
 */
function formatCredential(baseURL, apiKey) {
  return `${String(baseURL).trim()}${CREDENTIAL_SEPARATOR}${String(apiKey || '').trim()}`;
}

/**
 * The base URL and key of a saved credential, or null when it holds no valid
 * base URL. A credential without the separator is a URL alone.
 * @param {string} credential
 * @returns {{ baseURL: string, apiKey: string } | null}
 */
function parseCredential(credential) {
  if (typeof credential !== 'string') return null;
  const cut = credential.indexOf(CREDENTIAL_SEPARATOR);
  const rawURL = cut === -1 ? credential : credential.slice(0, cut);
  const apiKey = cut === -1 ? '' : credential.slice(cut + 1).trim();
  const checked = checkBaseURL(rawURL);
  if (!checked.baseURL) return null;
  return { baseURL: checked.baseURL, apiKey };
}

/** host[:port] of the endpoint, for the logs (never the key). */
function hostOf(baseURL) {
  try { return new URL(baseURL).host; } catch { return '?'; }
}

// ---------------------------------------------------------------------------
// Model traits (catalog)
// ---------------------------------------------------------------------------

/**
 * What the model takes: vision, maxOutput and reasoning from the catalog
 * (override, else the endpoint's models list, else no image, no cap, no
 * reasoning).
 * @param {string} modelId
 * @returns {{ vision: boolean, maxOutput: number|null, reasoning: boolean }}
 */
function modelTraits(modelId) {
  const caps = catalog.capabilities(PROVIDER_ID, String(modelId || ''));
  return { vision: caps.vision === true, maxOutput: caps.maxOutput ?? null, reasoning: caps.reasoning === true };
}

const arrayOf = (v) => (Array.isArray(v) ? v : null);
const firstPositive = (...values) => {
  for (const v of values) {
    const n = Number(v);
    if (v != null && Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return null;
};

/**
 * One entry of the endpoint's models list in the catalog's shape. Each server
 * names the fields its own way: input_modalities (Groq, OmniRoute),
 * architecture.input_modalities (OpenRouter), capabilities.vision and
 * capabilities.reasoning (OmniRoute), supported_parameters (OpenRouter),
 * supported_features (Groq). A field no server sends is null (unknown).
 * @param {object} m - GET /models item
 */
function normalizeModel(m) {
  const modalities = arrayOf(m?.input_modalities) || arrayOf(m?.architecture?.input_modalities);
  let vision = modalities ? modalities.includes('image') : null;
  if (typeof m?.capabilities?.vision === 'boolean') vision = m.capabilities.vision;

  const params = arrayOf(m?.supported_parameters);
  const features = arrayOf(m?.supported_features);
  let reasoning = null;
  if (params) reasoning = params.includes('reasoning') || params.includes('include_reasoning');
  if (features) reasoning = features.includes('reasoning');
  if (typeof m?.capabilities?.reasoning === 'boolean') reasoning = m.capabilities.reasoning;

  return {
    id: m?.id,
    vision,
    maxOutput: firstPositive(m?.max_completion_tokens, m?.max_output_tokens, m?.top_provider?.max_completion_tokens, m?.max_output_length),
    reasoning,
    effortLevels: null,
    thinking: null,
  };
}

// ---------------------------------------------------------------------------
// Request building (pure)
// ---------------------------------------------------------------------------

// The cap for a caller that sets none (Ask). Lower than Groq's 16,384: an
// endpoint that does not report a model's output limit may refuse a cap over
// it, and an Ask answer measured up to ~4,200 tokens (groq-provider R20).
const DEFAULT_MAX_TOKENS = 8_192;
// Reasoning tokens count toward max_tokens on most servers, so a caller's cap
// (Live Answer passes 900) could end inside the reasoning.
const DEFAULT_REASONING_TOKENS = 1024;
const MAX_IMAGES = 3;

// Output ceilings a server stated in a 400 ("max tokens must be less than or
// equal to 8192"), per model, until the app restarts. The catalog may know no
// limit, and a gateway's models list may say a model reasons when it does not
// (OmniRoute says so of every model), which adds the reasoning allowance.
const statedCeilings = new Map();

/** The max_tokens ceiling a 400 names, or null. */
function statedTokenCeiling(err) {
  if (err?.status !== 400) return null;
  const message = String(err.message || '');
  const m = message.match(/max[_ ]?(?:completion[_ ])?tokens?\b[^.]*?(?:less than or equal to|at most|<=)\s*`?(\d{2,7})/i)
    || message.match(/supports at most (\d{2,7}) completion tokens/i);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Forget the stated ceilings (tests). */
function resetStatedCeilings() {
  statedCeilings.clear();
}

/** A number from the environment, or null when unset, blank or not a number. */
function envNumber(env, name) {
  const raw = env?.[name];
  if (raw == null || String(raw).trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function completionBudget({ maxTokens, reasons, maxOutput, env }) {
  const envMax = envNumber(env, 'OPENAI_COMPATIBLE_MAX_TOKENS');
  let max = Number.isFinite(maxTokens) && maxTokens > 0
    ? Math.floor(maxTokens)
    : envMax != null && envMax > 0 ? Math.floor(envMax) : DEFAULT_MAX_TOKENS;
  if (reasons) {
    const allowance = envNumber(env, 'OPENAI_COMPATIBLE_REASONING_TOKENS');
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

/** The smaller of two caps, either of which may be null. */
function lowest(a, b) {
  if (a == null) return b ?? null;
  return b == null ? a : Math.min(a, b);
}

/**
 * Build the chat-completions request for one attempt. Always streams, the
 * non-streaming lanes included (headers come once the request is accepted,
 * so the SDK's header timeout never cuts a long answer). Sends only the
 * fields every OpenAI-compatible server takes: model, messages, stream,
 * max_tokens and temperature. No reasoning field: each server names it its
 * own way, and a field a model does not know is a 400.
 *
 * @param {object} input
 * @param {string} input.modelId
 * @param {Array} input.messages - Glass messages ({ role, content })
 * @param {number} [input.maxTokens] - caller cap; else OPENAI_COMPATIBLE_MAX_TOKENS; else 8,192;
 *   never over the model's catalog limit or a ceiling the server stated (statedCeilings)
 * @param {number} [input.temperature] - sent when within [0, 2]
 * @param {object} [input.env=process.env]
 * @returns {{ params: object, imagesSent: number, imagesDropped: number }}
 */
function buildRequest({ modelId, messages, maxTokens, temperature, env = process.env }) {
  const traits = modelTraits(modelId);
  const mapped = mapMessages(messages, traits.vision);
  const params = {
    model: modelId,
    messages: mapped.messages,
    stream: true,
    max_tokens: completionBudget({ maxTokens, reasons: traits.reasoning, maxOutput: lowest(traits.maxOutput, statedCeilings.get(modelId)), env }),
  };
  if (typeof temperature === 'number' && Number.isFinite(temperature) && temperature >= 0 && temperature <= 2) {
    params.temperature = temperature;
  }
  return { params, imagesSent: mapped.imagesSent, imagesDropped: mapped.imagesDropped };
}

// ---------------------------------------------------------------------------
// Timeouts
// ---------------------------------------------------------------------------

// Time allowed until the first text of an attempt. Longer than Groq's 15 s:
// a gateway may try several upstreams of its own before the first token.
const FIRST_TEXT_TIMEOUT_MS = 20_000;
// Longest a request may wait for an answer to start, across every attempt and
// the second round. Once an answer streams it no longer applies.
const REQUEST_DEADLINE_MS = 45_000;
// Once text streams, longest gap between two chunks.
const IDLE_TIMEOUT_MS = 15_000;

/**
 * First-text timeout. OPENAI_COMPATIBLE_FIRST_TEXT_TIMEOUT_MS overrides it.
 * @param {object} [env=process.env]
 * @returns {number} milliseconds
 */
function firstTextTimeoutMs(env = process.env) {
  const n = envNumber(env, 'OPENAI_COMPATIBLE_FIRST_TEXT_TIMEOUT_MS');
  return n != null && n > 0 ? n : FIRST_TEXT_TIMEOUT_MS;
}

/** The env value when ≥ 0 (0 → null, disabled), else the default. */
function optionalTimeoutMs(env, name, fallback) {
  const n = envNumber(env, name);
  if (n == null || n < 0) return fallback;
  return n > 0 ? n : null;
}

/**
 * Request deadline, or null for none. OPENAI_COMPATIBLE_REQUEST_DEADLINE_MS overrides; 0 disables.
 * @param {object} [env=process.env]
 * @returns {number|null} milliseconds
 */
function requestDeadlineMs(env = process.env) {
  return optionalTimeoutMs(env, 'OPENAI_COMPATIBLE_REQUEST_DEADLINE_MS', REQUEST_DEADLINE_MS);
}

/**
 * Idle timeout once text streams, or null for none. OPENAI_COMPATIBLE_IDLE_TIMEOUT_MS overrides; 0 disables.
 * @param {object} [env=process.env]
 * @returns {number|null} milliseconds
 */
function idleTimeoutMs(env = process.env) {
  return optionalTimeoutMs(env, 'OPENAI_COMPATIBLE_IDLE_TIMEOUT_MS', IDLE_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------
// SDK calls
// ---------------------------------------------------------------------------

// The SDK never retries: failover and the second round are the loop's, so
// every wait is under our timers.
const SDK_MAX_RETRIES = 0;
// Time until response headers only; every chat call streams. The body is
// bounded by our own timers.
const SDK_TIMEOUT_MS = 20_000;

/**
 * The SDK client for a credential. Everything it would otherwise read from
 * the environment is set here: OPENAI_API_KEY, OPENAI_ORG_ID and
 * OPENAI_PROJECT_ID belong to OpenAI and must never reach another server.
 * @param {string} credential
 * @returns {OpenAI}
 */
function makeClient(credential) {
  const parsed = parseCredential(credential);
  if (!parsed) {
    const err = Object.assign(new Error('the saved base URL is not valid'), { code: 'BAD_CREDENTIAL' });
    err.userMessage = 'The OpenAI-compatible base URL saved in Settings is not valid. Save it again.';
    throw err;
  }
  return new OpenAI({
    apiKey: parsed.apiKey || NO_KEY,
    baseURL: parsed.baseURL,
    organization: null,
    project: null,
    maxRetries: SDK_MAX_RETRIES,
    timeout: SDK_TIMEOUT_MS,
  });
}

class OpenAICompatibleProvider {
  /**
   * Lists the endpoint's models: costs nothing and names no model. Never throws.
   * @param {string} credential - formatCredential(baseURL, apiKey)
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  static async validateApiKey(credential) {
    const cut = typeof credential === 'string' ? credential.indexOf(CREDENTIAL_SEPARATOR) : -1;
    const checked = checkBaseURL(cut === -1 ? credential : credential.slice(0, cut));
    if (checked.error) return { success: false, error: checked.error };
    try {
      await makeClient(credential).models.list({ maxRetries: SDK_MAX_RETRIES, timeout: SDK_TIMEOUT_MS });
      return { success: true };
    } catch (err) {
      if (err?.status === 401 || err?.status === 403) return { success: false, error: `${hostOf(checked.baseURL)} refused the API key.` };
      if (err?.status === 404) return { success: false, error: `${checked.baseURL}/models not found. Check the base URL (it usually ends in /v1).` };
      if (typeof err?.status !== 'number') {
        console.error(`[OpenAI-compatible Provider] Network error during validation host=${hostOf(checked.baseURL)}:`, shortErrorMessage(err));
        return { success: false, error: `Could not reach ${hostOf(checked.baseURL)}. Is the server running?` };
      }
      return { success: false, error: shortErrorMessage(err) || `Validation failed with status: ${err.status}` };
    }
  }
}

/**
 * Every model of the endpoint's list, for the catalog (modelCatalog.refresh).
 * @param {string} credential
 * @returns {Promise<object[]>} normalizeModel entries
 */
async function listModels(credential) {
  const page = await makeClient(credential).models.list({ maxRetries: SDK_MAX_RETRIES, timeout: SDK_TIMEOUT_MS });
  const data = Array.isArray(page?.data) ? page.data : [];
  return data.filter((m) => m?.id).map(normalizeModel);
}

/**
 * One model the list did not name, for the catalog (modelCatalog.ensureKnown).
 * @param {string} credential
 * @param {string} modelId
 * @returns {Promise<object|null>} null when the endpoint has no such model
 */
async function getModel(credential, modelId) {
  try {
    return normalizeModel(await makeClient(credential).models.retrieve(modelId, { maxRetries: SDK_MAX_RETRIES, timeout: SDK_TIMEOUT_MS }));
  } catch (err) {
    if (err?.status === 404) return null;
    throw err;
  }
}

/**
 * STT stays on another provider (Glass needs a real-time session).
 * Placeholder with the shape the factory expects.
 * @returns {Promise<object>} STT session placeholder
 */
async function createSTT() {
  console.warn('[OpenAI-compatible] STT not supported. Use Gemini, Deepgram, OpenAI or Whisper for STT.');
  return {
    sendRealtimeInput: async () => {
      console.warn('[OpenAI-compatible] STT sendRealtimeInput called but not implemented');
    },
    close: async () => {
      console.log('[OpenAI-compatible] STT session closed');
    },
  };
}

// ---------------------------------------------------------------------------
// Health (cooldowns under this provider's own names)
// ---------------------------------------------------------------------------

/** The registry key of a model of this provider: "openai/gpt-oss-120b" here is not Groq's. */
const healthKey = (modelId) => `${PROVIDER_ID}:${modelId}`;

/** Whether the model cools down (read by providerChain). */
function isCoolingDown(modelId) {
  return health.isCoolingDown(healthKey(modelId));
}

/** The model to try first: the first healthy one, else the soonest to recover. */
function pickModel(models) {
  return health.pickModel(models.map(healthKey)).slice(PROVIDER_ID.length + 1);
}

// ---------------------------------------------------------------------------
// Failover
// ---------------------------------------------------------------------------

// Cooldowns (the registry clamps them to [5 s, 5 min]). Transient HTTP and
// stream errors use the server's retry hint, else 60 s (retryAfterMs).
const UNAVAILABLE_COOLDOWN_MS = 300_000;
// A stall, a budget spent on reasoning, a stream stopped early or a refused
// request is specific to one request: the model is kept out only briefly.
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
 * One line per model attempt: which model, how it ended, status and code,
 * time to first text, total time, finish reason, images, tokens, the model
 * that served it and the gateway's routing note (OmniRoute's
 * X-OmniRoute-Decision). Never prompt, answer or reasoning text, never the key.
 */
function logAttempt({ mode, attempt, of, modelId, outcome, stats, err }) {
  const parts = [`[OpenAI-compatible Provider] attempt ${attempt}/${of} ${mode} model=${modelId} outcome=${outcome}`];
  if (typeof err?.status === 'number') parts.push(`status=${err.status}`);
  const code = errorCode(err);
  if (code) parts.push(`code=${code}`);
  if (stats.headersAt != null) parts.push(`headers=${stats.headersAt - stats.startedAt}ms`);
  if (stats.firstTextAt != null) parts.push(`ttft=${stats.firstTextAt - stats.startedAt}ms`);
  if (stats.lastTextAt != null) parts.push(`last=${stats.lastTextAt - stats.startedAt}ms`);
  parts.push(`total=${Date.now() - stats.startedAt}ms`);
  if (stats.chunks) parts.push(`chunks=${stats.chunks}`);
  if (stats.finishReason) parts.push(`stop=${stats.finishReason}`);
  const images = [stats.imagesSent && `sent:${stats.imagesSent}`, stats.imagesDropped && `dropped:${stats.imagesDropped}`].filter(Boolean);
  if (images.length) parts.push(`images=${images.join(',')}`);
  const u = stats.usage;
  if (u) parts.push(`tokens=in:${u.prompt_tokens ?? '-'},out:${u.completion_tokens ?? '-'},reasoning:${u.completion_tokens_details?.reasoning_tokens ?? 0}`);
  if (stats.servedBy && stats.servedBy !== modelId) parts.push(`served_by=${stats.servedBy}`);
  if (stats.decision) parts.push(`route=${JSON.stringify(stats.decision)}`);
  const requestId = stats.requestId || headerOf(err?.headers, 'x-request-id');
  if (requestId) parts.push(`request_id=${requestId}`);
  if (err) parts.push(`error=${JSON.stringify(shortErrorMessage(err))}`);
  (outcome === 'ok' || outcome === 'cancelled' ? console.log : console.warn)(parts.join(' '));
}

/** Per-request summary: end-to-end latency including every failed attempt. */
function logRequest({ mode, host, answeredBy, attempts, startedAt, reordered = false, cancelled = false }) {
  const line = `[OpenAI-compatible Provider] request ${mode} host=${host} answered_by=${answeredBy || 'none'} attempts=${attempts} total=${Date.now() - startedAt}ms${reordered ? ' order=vision-first' : ''}${cancelled ? ' cancelled' : ''}`;
  (answeredBy || cancelled ? console.log : console.warn)(line);
}

const isTimeout = (err) => err?.code === 'FIRST_TEXT_TIMEOUT' || err?.code === 'IDLE_TIMEOUT';

/**
 * Whether a failed attempt is worth repeating in the second round: a fast
 * transient failure. Timeouts already cost seconds, a budget spent on
 * reasoning would be spent again, a stream stopped early is about this
 * request, and a rate limit only joins when the server's own retry hint fits
 * in the wait.
 */
function joinsNextRound(err, kind, delayMs) {
  if (kind !== 'transient' || err?.code) return false;
  if (err?.status === 429) {
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
  if (kind === 'rejected' || err?.code) return SHORT_COOLDOWN_MS;
  return retryAfterMs(err);
}

/** The failure, as the user reads it after "Last: ". */
function describeFailure(modelId, err, kind) {
  if (kind === 'unavailable' && err?.status === 402) return `${modelId} needs credit this account does not have. Pick a free model in Settings.`;
  if (kind === 'unavailable') return `${modelId} is not served by this endpoint (not found for this key). Pick a model it lists in Settings.`;
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
 * so the attempt stops at the chunk that carries finish_reason (a usage chunk
 * a server sends after it is not waited for: it only feeds the log).
 */
async function runAttempt({ client, modelId, messages, maxTokens, temperature, stats, sink, control }) {
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
    const built = buildRequest({ modelId, messages, maxTokens, temperature });
    stats.maxTokens = built.params.max_tokens;
    stats.imagesSent = built.imagesSent;
    stats.imagesDropped = built.imagesDropped;
    const options = { maxRetries: SDK_MAX_RETRIES, timeout: SDK_TIMEOUT_MS, signal: abortController.signal };
    const { data: chunks, response } = await client.chat.completions.create(built.params, options).withResponse();
    stats.headersAt = Date.now();
    stats.requestId = headerOf(response?.headers, 'x-request-id');
    const decision = headerOf(response?.headers, 'x-omniroute-decision');
    if (decision) stats.decision = String(decision).slice(0, 160);

    for await (const chunk of chunks) {
      if (stats.firstTextAt != null) armIdle();
      if (chunk.model) stats.servedBy = chunk.model;
      if (chunk.error) {
        // A mid-stream error (OpenRouter sends one as a chunk). Its message
        // may echo the request, so it is not kept.
        stats.streamError = true;
        break;
      }
      if (chunk.usage) stats.usage = chunk.usage;
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
 * deadline. Only a key refusal (fatal-auth) ends the request early.
 *
 * @param {object} o
 * @param {object} o.client - OpenAI client for the endpoint
 * @param {string} o.host - the endpoint's host, for the logs
 * @param {string} o.model - one model ID or a CSV list
 * @param {'stream'|'once'} o.mode
 * @param {Array} o.messages - Glass messages
 * @param {number} [o.maxTokens]
 * @param {number} [o.temperature]
 * @param {boolean} [o.visionOnly] - with an image, only the models that see images may answer
 * @param {object} o.timing - firstTextTimeoutMs / requestDeadlineMs / idleTimeoutMs overrides, retryRoundDelayMs
 * @param {object} o.sink - text(t) → false once the consumer is gone; reset({ next_model, reason })
 * @param {object} o.control - cancelled() → boolean; track(abortController) / untrack(abortController)
 * @returns {Promise<{ modelId: string, servedBy: string, stats: object } | null>} null when cancelled
 * @throws the last error, carrying a short userMessage; NO_MODEL (empty list) or
 *   NO_VISION_MODEL (visionOnly leaves no model) before any attempt
 */
async function runWithFailover({ client, host, model, mode, messages, maxTokens, temperature, visionOnly, timing, sink, control }) {
  const listed = health.parseModelList(model);
  if (listed.length === 0) {
    // No endpoint has a model every other one has: there is no default.
    const err = providerError('NO_MODEL', 'no model in the list');
    err.userMessage = 'No OpenAI-compatible model is set. Type the endpoint\'s model IDs in Settings.';
    throw err;
  }
  let remaining = orderForImages(listed, messages);
  const reordered = remaining.some((m, i) => m !== listed[i]);
  // A later provider sees the image (providerChain): a text-only model here
  // would answer without it, so it is left to that provider.
  if (visionOnly && hasImages(messages)) {
    remaining = remaining.filter((m) => modelTraits(m).vision);
    if (remaining.length === 0) {
      console.warn(`[OpenAI-compatible Provider] request ${mode} answered_by=none attempts=0 no model sees images: ${listed.join(',')}`);
      const err = providerError('NO_VISION_MODEL', 'no model in the list sees images');
      err.userMessage = 'No OpenAI-compatible model in the list sees images.';
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
  // A model whose 400 named its max_tokens ceiling is tried again at once, at
  // that ceiling (once per request), before the list moves on.
  let retryAtCeiling = null;
  const triedAtCeiling = new Set();
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
    if (answered) health.markSucceeded(healthKey(modelId));
    logRequest({ mode, host, answeredBy: answered ? stats.servedBy || modelId : null, attempts, startedAt, reordered, cancelled: true });
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
      console.warn(`[OpenAI-compatible Provider] all models failed — retry round ${round} in ${delayMs}ms: ${remaining.join(',')}`);
      sink.reset({ next_model: remaining[0], reason: 'retry' });
      const waitAbort = new AbortController();
      control.track(waitAbort);
      await waitOrAbort(delayMs, waitAbort.signal);
      control.untrack(waitAbort);
      continue;
    }

    const left = timeLeft();
    if (left <= 0) { deadlineHit = true; break; }
    const modelId = retryAtCeiling || pickModel(remaining);
    retryAtCeiling = null;
    // The attempt's own budget, shortened to what is left of the request deadline.
    const modelTimeoutMs = timing.firstTextTimeoutMs ?? firstTextTimeoutMs();
    const stats = {
      startedAt: Date.now(), timeoutMs: Math.min(modelTimeoutMs, left), idleMs,
      headersAt: null, firstTextAt: null, lastTextAt: null, chunks: 0, finishReason: null, usage: null,
      servedBy: null, requestId: null, decision: null, maxTokens: null,
      imagesSent: 0, imagesDropped: 0,
      stopped: false, streamError: false, timedOut: null, aborted: false,
    };
    lastModel = modelId;
    attempts++;

    try {
      await runAttempt({ client, modelId, messages, maxTokens, temperature, stats, sink, control });
    } catch (rawErr) {
      if (control.cancelled()) return endCancelled(modelId, stats);
      const err = rawErr && typeof rawErr === 'object' ? rawErr : new Error(String(rawErr));
      const kind = classify(err);
      lastErr = err;
      lastKind = kind;
      if (stats.firstTextAt != null) answerStarted = true;
      logAttempt({ mode, attempt: attempts, of: plannedAttempts, modelId, outcome: isTimeout(err) ? 'timeout' : kind, stats, err });

      const ceiling = statedTokenCeiling(err);
      if (ceiling != null && ceiling < stats.maxTokens && stats.firstTextAt == null && !triedAtCeiling.has(modelId)) {
        statedCeilings.set(modelId, ceiling);
        triedAtCeiling.add(modelId);
        retryAtCeiling = modelId;
        plannedAttempts++;
        console.warn(`[OpenAI-compatible Provider] ${modelId} takes at most ${ceiling} output tokens (asked ${stats.maxTokens}) — trying it again at ${ceiling}`);
        continue;
      }

      if (kind === 'fatal-auth') {
        logRequest({ mode, host, answeredBy: null, attempts, startedAt, reordered });
        err.userMessage = `${host} refused the API key (${err.status}). Check it in Settings.`;
        throw err;
      }
      const cooldown = cooldownFor(err, kind);
      if (cooldown != null) health.markFailed(healthKey(modelId), cooldown);
      if (joinsNextRound(err, kind, delayMs)) retryable.push(modelId);
      remaining = remaining.filter(m => m !== modelId);
      // A first-text timeout cut short by the deadline: the deadline is reached.
      if (err.code === 'FIRST_TEXT_TIMEOUT' && stats.timeoutMs < modelTimeoutMs) { deadlineHit = true; break; }
      if (remaining.length > 0 && timeLeft() > 0) {
        sink.reset({ next_model: pickModel(remaining), reason: resetReason(err, kind) });
      }
      continue;
    }

    if (stats.aborted || control.cancelled()) return endCancelled(modelId, stats);
    logAttempt({ mode, attempt: attempts, of: plannedAttempts, modelId, outcome: 'ok', stats });
    health.markSucceeded(healthKey(modelId));
    const servedBy = stats.servedBy || modelId;
    logRequest({ mode, host, answeredBy: servedBy, attempts, startedAt, reordered });
    return { modelId, servedBy, stats };
  }

  if (control.cancelled()) {
    logRequest({ mode, host, answeredBy: null, attempts, startedAt, reordered, cancelled: true });
    return null;
  }
  logRequest({ mode, host, answeredBy: null, attempts, startedAt, reordered });
  if (deadlineHit) console.warn(`[OpenAI-compatible Provider] request deadline reached — no answer within ${deadlineMs}ms`);

  const err = lastErr || new Error('no model was tried');
  const failure = describeFailure(lastModel, err, lastKind);
  if (attempts === 1 && !deadlineHit && lastKind === 'unavailable') {
    err.userMessage = failure;
  } else {
    const tried = `${plural(attempts, 'attempt')}${round > 1 ? `, ${round} rounds` : ''}`;
    err.userMessage = deadlineHit
      ? `No answer within ${seconds(deadlineMs)} (${tried}). Last: ${failure}`
      : `All OpenAI-compatible models failed (${tried}). Last: ${failure}`;
  }
  throw err;
}

// ---------------------------------------------------------------------------
// LLM instances
// ---------------------------------------------------------------------------

/**
 * The endpoint's client and host, made on first use: a credential whose URL
 * is not valid fails the request (with a userMessage), not the creation.
 * @param {string} credential
 * @returns {function(): { client: OpenAI, host: string }}
 */
function endpointFor(credential) {
  let endpoint = null;
  return () => {
    if (!endpoint) endpoint = { client: makeClient(credential), host: hostOf(parseCredential(credential).baseURL) };
    return endpoint;
  };
}

/**
 * Creates an OpenAI-compatible LLM instance (chat, generateContent) with
 * failover. Calls stream internally and return the joined text; the shapes
 * match the other providers, plus _modelUsed. Failures throw with a short
 * userMessage.
 *
 * @param {object} opts
 * @param {string} opts.apiKey - the saved credential (formatCredential)
 * @param {string} opts.model - one model ID or a CSV list, tried in order (image-capable models first for images)
 * @param {number} [opts.maxTokens] - default OPENAI_COMPATIBLE_MAX_TOKENS, else 8,192; plus the reasoning allowance on models that reason
 * @param {number} [opts.temperature] - sent when within [0, 2]
 * @param {boolean} [opts.visionOnly] - a request with an image goes only to the models that see images
 * @param {number} [opts.firstTextTimeoutMs] - overrides firstTextTimeoutMs() for every model
 * @param {number|null} [opts.requestDeadlineMs] - overrides requestDeadlineMs(); null disables
 * @param {number|null} [opts.idleTimeoutMs] - overrides idleTimeoutMs(); null disables
 * @param {number} [opts.retryRoundDelayMs] - wait before the second round (default 2 s)
 */
function createLLM({ apiKey, model, maxTokens, temperature, visionOnly, firstTextTimeoutMs: firstTextOverride, requestDeadlineMs: deadlineOverride, idleTimeoutMs: idleOverride, retryRoundDelayMs = RETRY_ROUND_DELAY_MS }) {
  const endpoint = endpointFor(apiKey);
  const timing = { firstTextTimeoutMs: firstTextOverride, requestDeadlineMs: deadlineOverride, idleTimeoutMs: idleOverride, retryRoundDelayMs };
  // No consumer can cancel a non-streaming call.
  const control = { cancelled: () => false, track: () => {}, untrack: () => {} };

  async function complete(messages) {
    let text = '';
    // A failed attempt's partial text is dropped before the next attempt.
    const sink = { text: (t) => { text += t; return true; }, reset: () => { text = ''; } };
    const { client, host } = endpoint();
    await catalog.ensureKnown(PROVIDER_ID, apiKey, health.parseModelList(model));
    const { servedBy, stats } = await runWithFailover({ client, host, model, mode: 'once', messages, maxTokens, temperature, visionOnly, timing, sink, control });
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
 * Creates an OpenAI-compatible streaming LLM instance with failover.
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
function createStreamingLLM({ apiKey, model, maxTokens, temperature, visionOnly, firstTextTimeoutMs: firstTextOverride, requestDeadlineMs: deadlineOverride, idleTimeoutMs: idleOverride, retryRoundDelayMs = RETRY_ROUND_DELAY_MS }) {
  const endpoint = endpointFor(apiKey);
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
            const { client, host } = endpoint();
            await catalog.ensureKnown(PROVIDER_ID, apiKey, health.parseModelList(model));
            const result = await runWithFailover({ client, host, model, mode: 'stream', messages, maxTokens, temperature, visionOnly, timing, sink, control });
            if (!result) return;
            safeEnqueue(encode({ _final_model: result.servedBy }));
            safeEnqueue(new TextEncoder().encode('data: [DONE]\n\n'));
            try { controller.close(); } catch {}
          } catch (err) {
            if (cancelled) return;
            console.error(`[OpenAI-compatible Provider] ${err?.userMessage || shortErrorMessage(err)}`);
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
  PROVIDER_ID,
  OpenAICompatibleProvider,
  createSTT,
  createLLM,
  createStreamingLLM,
  listModels,
  getModel,
  normalizeModel,
  modelTraits,
  buildRequest,
  statedTokenCeiling,
  resetStatedCeilings,
  orderForImages,
  checkBaseURL,
  formatCredential,
  parseCredential,
  healthKey,
  isCoolingDown,
  pickModel,
  firstTextTimeoutMs,
  requestDeadlineMs,
  idleTimeoutMs,
};

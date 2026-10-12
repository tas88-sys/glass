const { Groq, APIConnectionError } = require('groq-sdk');
const health = require('./modelHealth');
const { classify, retryAfterMs, retryAfterHeaderMs, shortErrorMessage, tooLargeNumbers, errorCode } = require('./groqErrors');

// ---------------------------------------------------------------------------
// Model traits (static table)
// ---------------------------------------------------------------------------

// What each family accepts. A field a model does not know returns 400, so an
// unknown model gets no reasoning field and no image.
const MODEL_TRAITS = [
  { match: /^openai\/gpt-oss-/, traits: { reasoning: 'gpt-oss', vision: false, maxOutput: 65_536 } },
  { match: /^qwen\/qwen3\.8-27b$/, traits: { reasoning: 'qwen3', vision: true, maxOutput: 16_384 } },
  { match: /^qwen\/qwen3/, traits: { reasoning: 'qwen3', vision: false, maxOutput: null } },
];
const NO_TRAITS = { reasoning: null, vision: false, maxOutput: null };

/**
 * @param {string} modelId
 * @returns {{ reasoning: 'gpt-oss'|'qwen3'|null, vision: boolean, maxOutput: number|null }}
 */
function modelTraits(modelId) {
  const id = String(modelId || '');
  const hit = MODEL_TRAITS.find((t) => t.match.test(id));
  return { ...(hit ? hit.traits : NO_TRAITS) };
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
const DEFAULT_MAX_TOKENS = 2048;
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
 * @param {number} [input.maxTokens] - caller cap; else GROQ_MAX_TOKENS; else 2048
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

module.exports = {
  GroqProvider,
  createSTT,
  modelTraits,
  buildRequest,
  orderForImages,
  firstTextTimeoutMs,
  requestDeadlineMs,
  idleTimeoutMs,
};

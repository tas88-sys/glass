const { Anthropic, APIConnectionError } = require('@anthropic-ai/sdk');
const { shortErrorMessage } = require('./anthropicErrors');

// ---------------------------------------------------------------------------
// Request building (pure)
// ---------------------------------------------------------------------------

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
// Every Glass lane has someone waiting on the answer.
const DEFAULT_EFFORT = 'low';
// Thinking counts toward max_tokens, so a small cap (Live Answer passes 900)
// can run out inside thinking, before any text. Floor on models that think.
const MIN_MAX_TOKENS = 4096;
const DEFAULT_MAX_TOKENS = { stream: 16_000, once: 8_192 };
// Server-side refusal fallback, "default" form. Only these models have it:
// Haiku 5.5 has none (a declined request stays declined).
const SERVER_FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const SERVER_FALLBACK_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5'];

/**
 * Whether the model takes output_config.effort (and thinks by default): the
 * Claude 5 families and later, claude-opus-4-5 … 4-8, claude-sonnet-4-6.
 * Haiku 4.5 and Sonnet 4.5 reject effort with a 400.
 * @param {string} modelId
 * @returns {boolean}
 */
function acceptsEffort(modelId) {
  const id = String(modelId || '');
  const family = /^claude-(?:fable|mythos|opus|sonnet|haiku)-(\d+)(?:\D|$)/.exec(id);
  if (family && Number(family[1]) >= 5) return true;
  return /^claude-opus-4-[5-8](?:\D|$)/.test(id) || /^claude-sonnet-4-6(?:\D|$)/.test(id);
}

/** A number from the environment, or null when unset, blank or not a number. */
function envNumber(env, name) {
  const raw = env?.[name];
  if (raw == null || String(raw).trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function resolveEffort(effort, env) {
  for (const value of [effort, env?.ANTHROPIC_EFFORT]) {
    const level = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (EFFORT_LEVELS.includes(level)) return level;
  }
  return DEFAULT_EFFORT;
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
 * alternating).
 */
function mapMessages(messages) {
  const system = [];
  const out = [];
  for (const msg of messages || []) {
    if (!msg) continue;
    if (msg.role === 'system') {
      const text = textOf(msg.content);
      if (text) system.push(text);
      continue;
    }
    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    const content = (Array.isArray(msg.content) ? msg.content : [msg.content]).map(toBlock).filter(Boolean);
    if (content.length === 0) continue;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...content);
    else out.push({ role, content });
  }
  return { system: system.join('\n\n'), messages: out };
}

/**
 * Build the Messages API request for one attempt. Never sends temperature,
 * top_p, top_k or thinking (current models reject non-default sampling, and
 * thinking keeps each model's default). Every call streams, the non-streaming
 * lanes included: a non-streaming response sends its headers only once the
 * whole answer is written, which the SDK's 15 s timeout would cut.
 *
 * @param {object} input
 * @param {string} input.modelId
 * @param {Array} input.messages - Glass messages ({ role, content })
 * @param {number} [input.maxTokens] - caller cap; default by mode
 * @param {string} [input.effort] - low|medium|high|xhigh|max; else ANTHROPIC_EFFORT; else low
 * @param {'stream'|'once'} [input.mode='stream'] - picks the default max_tokens
 * @param {boolean} [input.serverFallback=true] - false once the API rejected the beta
 * @param {object} [input.env=process.env]
 * @returns {{ method: 'messages'|'beta', params: object }}
 */
function buildRequest({ modelId, messages, maxTokens, effort, mode = 'stream', serverFallback = true, env = process.env }) {
  const { system, messages: mapped } = mapMessages(messages);
  const thinks = acceptsEffort(modelId);
  let max = Number.isFinite(maxTokens) && maxTokens > 0
    ? Math.floor(maxTokens)
    : DEFAULT_MAX_TOKENS[mode === 'once' ? 'once' : 'stream'];
  if (thinks) max = Math.max(max, minMaxTokens(env));

  const params = { model: modelId, max_tokens: max, messages: mapped, stream: true };
  if (system) params.system = system;
  if (thinks) params.output_config = { effort: resolveEffort(effort, env) };

  if (!serverFallback || serverFallbackOff(env) || !SERVER_FALLBACK_MODELS.includes(modelId)) {
    return { method: 'messages', params };
  }
  params.betas = [SERVER_FALLBACK_BETA];
  params.fallbacks = 'default';
  return { method: 'beta', params };
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
// attempt (no cap since 0.126). Failover and the second round are the loop's.
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

/**
 * Creates an Anthropic LLM instance
 * @param {object} opts - Configuration options
 * @param {string} opts.apiKey - Anthropic API key
 * @param {string} [opts.model='claude-3-5-sonnet-20241022'] - Model name
 * @param {number} [opts.temperature=0.7] - Temperature
 * @param {number} [opts.maxTokens=4096] - Max tokens
 * @returns {object} LLM instance
 */
function createLLM({ apiKey, model = "claude-3-5-sonnet-20241022", temperature = 0.7, maxTokens = 8192, ...config }) {
  const client = new Anthropic({ apiKey })

  return {
    generateContent: async (parts) => {
      const messages = []
      let systemPrompt = ""
      const userContent = []

      for (const part of parts) {
        if (typeof part === "string") {
          if (systemPrompt === "" && part.includes("You are")) {
            systemPrompt = part
          } else {
            userContent.push({ type: "text", text: part })
          }
        } else if (part.inlineData) {
          userContent.push({
            type: "image",
            source: {
              type: "base64",
              media_type: part.inlineData.mimeType,
              data: part.inlineData.data,
            },
          })
        }
      }

      if (userContent.length > 0) {
        messages.push({ role: "user", content: userContent })
      }

      try {
        const response = await client.messages.create({
          model: model,
          max_tokens: maxTokens,
          temperature: temperature,
          system: systemPrompt || undefined,
          messages: messages,
        })

        return {
          response: {
            text: () => response.content[0].text,
          },
          raw: response,
        }
      } catch (error) {
        console.error("Anthropic API error:", error)
        throw error
      }
    },

    // For compatibility with chat-style interfaces
    chat: async (messages) => {
      let systemPrompt = ""
      const anthropicMessages = []

      for (const msg of messages) {
        if (msg.role === "system") {
          systemPrompt = msg.content
        } else {
          // Handle multimodal content
          let content
          if (Array.isArray(msg.content)) {
            content = []
            for (const part of msg.content) {
              if (typeof part === "string") {
                content.push({ type: "text", text: part })
              } else if (part.type === "text") {
                content.push({ type: "text", text: part.text })
              } else if (part.type === "image_url" && part.image_url) {
                // Convert base64 image to Anthropic format
                const imageUrl = part.image_url.url
                const [mimeInfo, base64Data] = imageUrl.split(",")

                // Extract the actual MIME type from the data URL
                const mimeType = mimeInfo.match(/data:([^;]+)/)?.[1] || "image/jpeg"

                content.push({
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: mimeType,
                    data: base64Data,
                  },
                })
              }
            }
          } else {
            content = [{ type: "text", text: msg.content }]
          }

          anthropicMessages.push({
            role: msg.role === "user" ? "user" : "assistant",
            content: content,
          })
        }
      }

      const response = await client.messages.create({
        model: model,
        max_tokens: maxTokens,
        temperature: temperature,
        system: systemPrompt || undefined,
        messages: anthropicMessages,
      })

      return {
        content: response.content[0].text,
        raw: response,
      }
    },
  }
}

/**
 * Creates an Anthropic streaming LLM instance
 * @param {object} opts - Configuration options
 * @param {string} opts.apiKey - Anthropic API key
 * @param {string} [opts.model='claude-3-5-sonnet-20241022'] - Model name
 * @param {number} [opts.temperature=0.7] - Temperature
 * @param {number} [opts.maxTokens=4096] - Max tokens
 * @returns {object} Streaming LLM instance
 */
function createStreamingLLM({
  apiKey,
  model = "claude-3-5-sonnet-20241022",
  temperature = 0.7,
  maxTokens = 8192,
  ...config
}) {
  const client = new Anthropic({ apiKey })

  return {
    streamChat: async (messages) => {
      console.log("[Anthropic Provider] Starting streaming request")

      let systemPrompt = ""
      const anthropicMessages = []

      for (const msg of messages) {
        if (msg.role === "system") {
          systemPrompt = msg.content
        } else {
          // Handle multimodal content
          let content
          if (Array.isArray(msg.content)) {
            content = []
            for (const part of msg.content) {
              if (typeof part === "string") {
                content.push({ type: "text", text: part })
              } else if (part.type === "text") {
                content.push({ type: "text", text: part.text })
              } else if (part.type === "image_url" && part.image_url) {
                // Convert base64 image to Anthropic format
                const imageUrl = part.image_url.url
                const [mimeInfo, base64Data] = imageUrl.split(",")

                // Extract the actual MIME type from the data URL
                const mimeType = mimeInfo.match(/data:([^;]+)/)?.[1] || "image/jpeg"

                console.log(`[Anthropic] Processing image with MIME type: ${mimeType}`)

                content.push({
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: mimeType,
                    data: base64Data,
                  },
                })
              }
            }
          } else {
            content = [{ type: "text", text: msg.content }]
          }

          anthropicMessages.push({
            role: msg.role === "user" ? "user" : "assistant",
            content: content,
          })
        }
      }

      // Create a ReadableStream to handle Anthropic's streaming
      const stream = new ReadableStream({
        async start(controller) {
          try {
            console.log("[Anthropic Provider] Processing messages:", anthropicMessages.length, "messages")

            let chunkCount = 0
            let totalContent = ""

            // Stream the response
            const stream = await client.messages.create({
              model: model,
              max_tokens: maxTokens,
              temperature: temperature,
              system: systemPrompt || undefined,
              messages: anthropicMessages,
              stream: true,
            })

            for await (const chunk of stream) {
              if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
                chunkCount++
                const chunkText = chunk.delta.text || ""
                totalContent += chunkText

                // Format as SSE data
                const data = JSON.stringify({
                  choices: [
                    {
                      delta: {
                        content: chunkText,
                      },
                    },
                  ],
                })
                controller.enqueue(new TextEncoder().encode(`data: ${data}\n\n`))
              }
            }

            console.log(
              `[Anthropic Provider] Streamed ${chunkCount} chunks, total length: ${totalContent.length} chars`,
            )

            // Send the final done message
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
            controller.close()
            console.log("[Anthropic Provider] Streaming completed successfully")
          } catch (error) {
            console.error("[Anthropic Provider] Streaming error:", error)
            controller.error(error)
          }
        },
      })

      // Create a Response object with the stream
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      })
    },
  }
}

module.exports = {
    AnthropicProvider,
    createSTT,
    createLLM,
    createStreamingLLM,
    buildRequest,
    acceptsEffort,
    firstTextTimeoutMs,
    requestDeadlineMs,
    idleTimeoutMs,
};

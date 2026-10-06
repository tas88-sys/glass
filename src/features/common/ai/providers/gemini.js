const { GoogleGenerativeAI } = require("@google/generative-ai")
const { GoogleGenAI } = require("@google/genai")
const rotator = require('./geminiModelRotator')

class GeminiProvider {
    static async validateApiKey(key) {
        if (!key || typeof key !== 'string') {
            return { success: false, error: 'Invalid Gemini API key format.' };
        }

        try {
            const validationUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`;
            const response = await fetch(validationUrl);

            if (response.ok) {
                return { success: true };
            } else {
                const errorData = await response.json().catch(() => ({}));
                const message = errorData.error?.message || `Validation failed with status: ${response.status}`;
                return { success: false, error: message };
            }
        } catch (error) {
            console.error(`[GeminiProvider] Network error during key validation:`, error);
            return { success: false, error: 'A network error occurred during validation.' };
        }
    }
}


/**
 * Creates a Gemini STT session
 * @param {object} opts - Configuration options
 * @param {string} opts.apiKey - Gemini API key
 * @param {string} [opts.language='en-US'] - Language code
 * @param {object} [opts.callbacks] - Event callbacks
 * @returns {Promise<object>} STT session
 */
async function createSTT({ apiKey, language = "en-US", callbacks = {}, model = 'gemini-3.8-live', ...config }) {
  // STT does NOT failover — use only the first model in the CSV list (locked decision #3).
  const firstModel = rotator.parseModelList(model)[0] || 'gemini-3.8-live';
  const liveClient = new GoogleGenAI({ vertexai: false, apiKey })

  // Language code BCP-47 conversion
  const lang = language.includes("-") ? language : `${language}-US`

  const session = await liveClient.live.connect({

    model: firstModel,
    callbacks: {
      ...callbacks,
      onMessage: (msg) => {
        if (!msg || typeof msg !== 'object') return;
        msg.provider = 'gemini';
        callbacks.onmessage?.(msg);
      }
    },

    config: {
      inputAudioTranscription: {},
      speechConfig: { languageCode: lang },
    },
  })

  return {
    sendRealtimeInput: async (payload) => session.sendRealtimeInput(payload),
    close: async () => session.close(),
  }
}

/**
 * Per-attempt diagnostics. One line per model attempt so the cost of failover
 * is visible: which model, how it ended, HTTP status, time to first chunk,
 * total time, and token usage (thoughts = thinking tokens, a large share of
 * latency on Gemini 3.x).
 *
 * @param {object} a
 * @param {'stream'|'once'} a.mode
 * @param {number} a.attempt   - 1-based attempt index within the request
 * @param {number} a.of        - planned attempts: size of the model list (+ the second round's models)
 * @param {string} a.modelId
 * @param {string} a.outcome   - 'ok' | 'aborted' | 'timeout' | classifyError() kind
 * @param {object} a.stats     - { startedAt, firstChunkAt?, lastChunkAt?, chunks?, finishReason?, usage? }
 * @param {unknown} [a.err]
 */
function logAttempt({ mode, attempt, of, modelId, outcome, stats, err }) {
  const parts = [`[Gemini Provider] attempt ${attempt}/${of} ${mode} model=${modelId} outcome=${outcome}`];
  const status = err?.status ?? err?.statusCode ?? err?.httpStatus;
  if (status != null) parts.push(`status=${status}`);
  if (stats.firstChunkAt != null) parts.push(`ttft=${stats.firstChunkAt - stats.startedAt}ms`);
  // last vs total: how long the connection stayed open after the last chunk.
  if (stats.lastChunkAt != null) parts.push(`last=${stats.lastChunkAt - stats.startedAt}ms`);
  parts.push(`total=${Date.now() - stats.startedAt}ms`);
  if (stats.chunks) parts.push(`chunks=${stats.chunks}`);
  if (stats.finishReason) parts.push(`finish=${stats.finishReason}`);
  const u = stats.usage;
  if (u) parts.push(`tokens=in:${u.promptTokenCount ?? '-'},out:${u.candidatesTokenCount ?? '-'},thoughts:${u.thoughtsTokenCount ?? 0}`);
  if (err) parts.push(`error=${JSON.stringify(shortErrorMessage(err))}`);
  (outcome === 'ok' ? console.log : console.warn)(parts.join(' '));
}

/**
 * Drop the SDK prefix and request URL from an error message; keep the
 * server's reason ("[503 Service Unavailable] The model is overloaded...").
 * @param {unknown} err
 * @returns {string}
 */
function shortErrorMessage(err) {
  return String(err?.message ?? err)
    .replace(/^\[GoogleGenerativeAI Error\]:\s*/, '')
    .replace(/Error fetching from \S+:\s*/, '')
    .slice(0, 160);
}

// Time allowed until the first streamed chunk before an attempt is abandoned
// and the next model is tried. Flash-Lite models think minimally and normally
// answer in < 20 s; other models may think for a long time before the first token.
const FIRST_CHUNK_TIMEOUT_LITE_MS = 25_000;
const FIRST_CHUNK_TIMEOUT_DEFAULT_MS = 60_000;

/**
 * Per-model first-chunk timeout. GEMINI_FIRST_CHUNK_TIMEOUT_MS (env) overrides
 * it for every model, for tuning and manual testing.
 * @param {string} modelId
 * @returns {number} milliseconds
 */
function firstChunkTimeoutMs(modelId) {
  const fromEnv = Number(process.env.GEMINI_FIRST_CHUNK_TIMEOUT_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return /-flash-lite$/.test(modelId) ? FIRST_CHUNK_TIMEOUT_LITE_MS : FIRST_CHUNK_TIMEOUT_DEFAULT_MS;
}

// When every model in the list fails, the streaming path waits and goes through
// the models that failed fast once more (503 "high demand" spikes are usually brief).
const MAX_ROUNDS = 2;
const RETRY_ROUND_DELAY_MS = 3_000;

/**
 * Whether a failed attempt is worth repeating in the next round: transient,
 * fast to fail, and not a quota limit. Timeouts cost 25-60 s each and 429s
 * would only burn quota again a few seconds later.
 * @param {unknown} err
 * @param {object} stats - the attempt's stats (timedOut)
 * @returns {boolean}
 */
function retryableNextRound(err, stats) {
  if (stats.timedOut) return false;
  const status = err?.status ?? err?.statusCode ?? err?.httpStatus;
  return status !== 429;
}

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
 * Per-request summary: end-to-end latency including every failed attempt.
 */
function logRequest({ mode, answeredBy, attempts, startedAt, cancelled = false }) {
  const line = `[Gemini Provider] request ${mode} answered_by=${answeredBy || 'none'} attempts=${attempts} total=${Date.now() - startedAt}ms${cancelled ? ' cancelled' : ''}`;
  (answeredBy || cancelled ? console.log : console.warn)(line);
}

/**
 * Failover helper for non-streaming LLM calls.
 * Tries each model in the list; on transient error, cools down the current
 * model and moves to the next. On fatal error, throws immediately.
 *
 * @param {string[]} modelList
 * @param {function(string, object): Promise<object>} doCall  - async fn that receives a modelId
 *   and a stats object it may fill with `usage` (usageMetadata) for logging
 * @returns {Promise<object>}  - result of doCall merged with { _modelUsed }
 */
async function callWithFailover(modelList, doCall) {
  let remaining = [...modelList];
  let lastErr;
  let attempts = 0;
  const requestStartedAt = Date.now();
  while (remaining.length > 0) {
    const modelId = rotator.pickModel(remaining);
    const stats = { startedAt: Date.now(), usage: null };
    attempts++;
    try {
      const result = await doCall(modelId, stats);
      logAttempt({ mode: 'once', attempt: attempts, of: modelList.length, modelId, outcome: 'ok', stats });
      logRequest({ mode: 'once', answeredBy: modelId, attempts, startedAt: requestStartedAt });
      rotator.markSucceeded(modelId);
      return { ...result, _modelUsed: modelId };
    } catch (err) {
      lastErr = err;
      const kind = rotator.classifyError(err);
      logAttempt({ mode: 'once', attempt: attempts, of: modelList.length, modelId, outcome: kind, stats, err });
      if (kind !== 'transient') {
        logRequest({ mode: 'once', answeredBy: null, attempts, startedAt: requestStartedAt });
        throw err;
      }
      rotator.markFailed(modelId, rotator.parseRetryAfter(err));
      remaining = remaining.filter(m => m !== modelId);
    }
  }
  logRequest({ mode: 'once', answeredBy: null, attempts, startedAt: requestStartedAt });
  throw lastErr;
}

/**
 * Creates a Gemini LLM instance with proper text response handling
 */
function createLLM({ apiKey, model = "gemini-3-flash-preview", temperature = 0.7, maxTokens = 65536, ...config }) {
  const client = new GoogleGenerativeAI(apiKey)
  const modelList = rotator.parseModelList(model);
  const effectiveModelList = modelList.length > 0 ? modelList : [model];

  return {
    generateContent: async (parts) => {
      return callWithFailover(effectiveModelList, async (modelId, stats) => {
        const geminiModel = client.getGenerativeModel({
          model: modelId,
          generationConfig: {
            temperature,
            maxOutputTokens: maxTokens,
            // Ensure we get text responses, not JSON
            responseMimeType: "text/plain",
          },
        })

        const userContent = []

        for (const part of parts) {
          if (typeof part === "string") {
            // Don't automatically assume strings starting with "You are" are system prompts
            // Check if it's explicitly marked as a system instruction
            userContent.push(part)
          } else if (part.inlineData) {
            userContent.push({
              inlineData: {
                mimeType: part.inlineData.mimeType,
                data: part.inlineData.data,
              },
            })
          }
        }

        const result = await geminiModel.generateContent(userContent)
        const response = await result.response
        stats.usage = response.usageMetadata || null

        // Return plain text, not wrapped in JSON structure
        return {
          response: {
            text: () => response.text(),
          },
        }
      });
    },

    chat: async (messages) => {
      return callWithFailover(effectiveModelList, async (modelId, stats) => {
        // Filter out any system prompts that might be causing JSON responses
        let systemInstruction = ""
        const history = []
        let lastMessage

        messages.forEach((msg, index) => {
          if (msg.role === "system") {
            // Clean system instruction - avoid JSON formatting requests
            systemInstruction = msg.content
              .replace(/respond in json/gi, "")
              .replace(/format.*json/gi, "")
              .replace(/return.*json/gi, "")

            // Add explicit instruction for natural text
            if (!systemInstruction.includes("respond naturally")) {
              systemInstruction += "\n\nRespond naturally in plain text, not in JSON or structured format."
            }
            return
          }

          const role = msg.role === "user" ? "user" : "model"

          if (index === messages.length - 1) {
            lastMessage = msg
          } else {
            history.push({ role, parts: [{ text: msg.content }] })
          }
        })

        const geminiModel = client.getGenerativeModel({
          model: modelId,
          systemInstruction:
            systemInstruction ||
            "Respond naturally in plain text format. Do not use JSON or structured responses unless specifically requested.",
          generationConfig: {
            temperature: temperature,
            maxOutputTokens: maxTokens,
            // Force plain text responses
            responseMimeType: "text/plain",
          },
        })

        const chat = geminiModel.startChat({
          history: history,
        })

        let content = lastMessage.content

        // Handle multimodal content
        if (Array.isArray(content)) {
          const geminiContent = []
          for (const part of content) {
            if (typeof part === "string") {
              geminiContent.push(part)
            } else if (part.type === "text") {
              geminiContent.push(part.text)
            } else if (part.type === "image_url" && part.image_url) {
              const base64Data = part.image_url.url.split(",")[1]
              geminiContent.push({
                inlineData: {
                  mimeType: "image/png",
                  data: base64Data,
                },
              })
            }
          }
          content = geminiContent
        }

        const result = await chat.sendMessage(content)
        const response = await result.response
        stats.usage = response.usageMetadata || null

        // Return plain text content
        return {
          content: response.text(),
          raw: result,
        }
      });
    },
  }
}

/**
 * Creates a Gemini streaming LLM instance with failover support.
 *
 * On a transient error (429/503/etc.) during streaming, or when no chunk arrives
 * within the first-chunk timeout, emits a _reset sentinel to the consumer and
 * retries with the next model in the CSV list.
 * When every model fails, the ones that failed fast with a transient error
 * (retryableNextRound) get one more round after a short wait, announced with
 * a _reset whose reason is 'retry'.
 * On a fatal error or when all models are exhausted, calls controller.error()
 * with an error carrying a short `userMessage` for display.
 * Cancelling the returned stream aborts the in-flight request (or the wait
 * between rounds) and stops failover.
 *
 * @param {object} opts
 * @param {number} [opts.firstChunkTimeoutMs] - overrides firstChunkTimeoutMs(modelId) for every model
 * @param {number} [opts.retryRoundDelayMs] - wait before the second round (default RETRY_ROUND_DELAY_MS)
 */
function createStreamingLLM({ apiKey, model = "gemini-3-flash-preview", temperature = 0.7, maxTokens = 65536, firstChunkTimeoutMs: firstChunkTimeoutOverride, retryRoundDelayMs = RETRY_ROUND_DELAY_MS, ...config }) {
  const client = new GoogleGenerativeAI(apiKey)

  return {
    streamChat: async (messages) => {
      console.log("[Gemini Provider] Starting streaming request")

      let systemInstruction = ""
      const nonSystemMessages = []

      for (const msg of messages) {
        if (msg.role === "system") {
          // Clean and modify system instruction
          systemInstruction = msg.content
            .replace(/respond in json/gi, "")
            .replace(/format.*json/gi, "")
            .replace(/return.*json/gi, "")

          if (!systemInstruction.includes("respond naturally")) {
            systemInstruction += "\n\nRespond naturally in plain text, not in JSON or structured format."
          }
        } else {
          nonSystemMessages.push(msg)
        }
      }

      /**
       * Stream one attempt for a given modelId.
       * Throws on any error (including mid-stream) so the outer loop can decide
       * whether to fail over or surface the error.
       *
       * @param {object} opts
       * @param {string} opts.modelId
       * @param {Array} opts.messages - nonSystemMessages
       * @param {function(Uint8Array): boolean} opts.safeEnqueue
       * @param {object} opts.stats - filled with firstChunkAt / lastChunkAt / chunks / finishReason /
       *   usage / aborted / timedOut for logging
       * @param {AbortController} opts.abortController - aborts this attempt's HTTP request
       */
      async function streamOneAttempt({ modelId, messages: msgs, safeEnqueue, stats, abortController }) {
        const geminiModel = client.getGenerativeModel({
          model: modelId,
          systemInstruction:
            systemInstruction ||
            "Respond naturally in plain text format. Do not use JSON or structured responses unless specifically requested.",
          generationConfig: {
            temperature,
            maxOutputTokens: maxTokens || 65536,
            responseMimeType: "text/plain",
          },
        })

        const lastMessage = msgs[msgs.length - 1]
        let geminiContent = []

        if (Array.isArray(lastMessage.content)) {
          for (const part of lastMessage.content) {
            if (typeof part === "string") {
              geminiContent.push(part)
            } else if (part.type === "text") {
              geminiContent.push(part.text)
            } else if (part.type === "image_url" && part.image_url) {
              const base64Data = part.image_url.url.split(",")[1]
              geminiContent.push({
                inlineData: {
                  mimeType: "image/png",
                  data: base64Data,
                },
              })
            }
          }
        } else {
          geminiContent = [lastMessage.content]
        }

        const contentParts = geminiContent.map((part) => {
          if (typeof part === "string") {
            return { text: part }
          } else if (part.inlineData) {
            return { inlineData: part.inlineData }
          }
          return part
        })

        // A request can be accepted and then stall for ~90 s before the first chunk;
        // abandon it after the timeout so the loop can fail over.
        const timer = setTimeout(() => {
          stats.timedOut = true
          abortController.abort()
        }, stats.timeoutMs)

        try {
          const result = await geminiModel.generateContentStream(
            { contents: [{ role: "user", parts: contentParts }] },
            { signal: abortController.signal },
          )
          // The SDK also exposes an aggregated `response` promise we never read;
          // without a handler it becomes an unhandled rejection when the stream errors.
          result.response?.catch?.(() => {})

          for await (const chunk of result.stream) {
            stats.lastChunkAt = Date.now()
            stats.chunks++
            if (stats.firstChunkAt == null) {
              stats.firstChunkAt = stats.lastChunkAt
              clearTimeout(timer)
            }
            // The last chunk carries the request's usageMetadata (incl. thoughtsTokenCount).
            if (chunk.usageMetadata) stats.usage = chunk.usageMetadata
            const finishReason = chunk.candidates?.[0]?.finishReason
            if (finishReason) stats.finishReason = finishReason
            const chunkText = chunk.text() || ""
            const data = JSON.stringify({
              choices: [{ delta: { content: chunkText } }],
            })
            if (!safeEnqueue(new TextEncoder().encode(`data: ${data}\n\n`))) {
              stats.aborted = true
              return;
            }
            // The answer is complete. The server can keep the connection open for
            // seconds after this chunk; stop reading and close it instead of waiting.
            if (finishReason) {
              abortController.abort()
              break
            }
          }
        } finally {
          clearTimeout(timer)
        }
      }

      const modelCsv = model;
      // Shared with cancel(): the consumer (Ask window closed / new request,
      // Live Answer replaced) gave up, so abort the in-flight attempt and stop.
      let cancelled = false;
      let currentAbort = null;
      const stream = new ReadableStream({
        cancel(reason) {
          cancelled = true;
          currentAbort?.abort(reason);
        },
        async start(controller) {
          // Guard against enqueue-after-close: when a consumer cancels the stream
          // (e.g. AskService aborts on a new request), `controller.desiredSize`
          // becomes null. Enqueueing then throws ERR_INVALID_STATE.
          const safeEnqueue = (chunk) => {
            if (controller.desiredSize === null) return false
            try { controller.enqueue(chunk); return true } catch { return false }
          }
          const encode = (obj) => new TextEncoder().encode(`data: ${JSON.stringify(obj)}\n\n`)
          const encodeDone = () => new TextEncoder().encode("data: [DONE]\n\n")

          let remaining = rotator.parseModelList(modelCsv);
          if (remaining.length === 0) remaining = [modelCsv];
          // Planned attempts for the "attempt i/n" log; grows when a second round starts.
          let plannedAttempts = remaining.length;
          let lastErr;
          let succeededModel = null;
          let attempts = 0;
          let round = 1;
          let retryable = []; // models of this round worth another try (retryableNextRound)
          const requestStartedAt = Date.now();

          let lastModel = null;

          while (!cancelled) {
            if (remaining.length === 0) {
              if (round >= MAX_ROUNDS || retryable.length === 0) break;
              round++;
              remaining = retryable;
              retryable = [];
              plannedAttempts += remaining.length;
              console.warn(`[Gemini Provider] all models failed — retry round ${round} in ${retryRoundDelayMs}ms: ${remaining.join(',')}`);
              safeEnqueue(encode({ _reset: true, next_model: remaining[0], reason: 'retry' }));
              const waitAbort = new AbortController();
              currentAbort = waitAbort;
              await waitOrAbort(retryRoundDelayMs, waitAbort.signal);
              currentAbort = null;
              continue;
            }

            const modelId = rotator.pickModel(remaining);
            const timeoutMs = firstChunkTimeoutOverride ?? firstChunkTimeoutMs(modelId);
            const stats = { startedAt: Date.now(), firstChunkAt: null, lastChunkAt: null, chunks: 0, finishReason: null, usage: null, aborted: false, timedOut: false, timeoutMs };
            const abortController = new AbortController();
            currentAbort = abortController;
            lastModel = modelId;
            attempts++;
            try {
              await streamOneAttempt({ modelId, messages: nonSystemMessages, safeEnqueue, stats, abortController });
              if (stats.aborted || cancelled) {
                // The consumer stopped reading. If text had arrived the model was answering,
                // so it is reported as answered_by (with "cancelled") and kept healthy.
                logAttempt({ mode: 'stream', attempt: attempts, of: plannedAttempts, modelId, outcome: 'aborted', stats });
                if (stats.firstChunkAt != null) rotator.markSucceeded(modelId);
                logRequest({ mode: 'stream', answeredBy: stats.firstChunkAt != null ? modelId : null, attempts, startedAt: requestStartedAt, cancelled: true });
                return;
              }
              logAttempt({ mode: 'stream', attempt: attempts, of: plannedAttempts, modelId, outcome: 'ok', stats });
              succeededModel = modelId;
              rotator.markSucceeded(modelId);
              break;
            } catch (rawErr) {
              if (cancelled) {
                // AbortError from our own cancel(): classifyError would call it transient
                // and fail over, but the consumer is gone.
                logAttempt({ mode: 'stream', attempt: attempts, of: plannedAttempts, modelId, outcome: 'aborted', stats });
                if (stats.firstChunkAt != null) rotator.markSucceeded(modelId);
                logRequest({ mode: 'stream', answeredBy: stats.firstChunkAt != null ? modelId : null, attempts, startedAt: requestStartedAt, cancelled: true });
                return;
              }
              const err = stats.timedOut
                ? Object.assign(new Error(`no response after ${timeoutMs / 1000}s`), { code: 'FIRST_CHUNK_TIMEOUT' })
                : rawErr;
              lastErr = err;
              const kind = stats.timedOut ? 'transient' : rotator.classifyError(err);
              logAttempt({ mode: 'stream', attempt: attempts, of: plannedAttempts, modelId, outcome: stats.timedOut ? 'timeout' : kind, stats, err });
              if (kind !== 'transient') {
                console.error("[Gemini Provider] Fatal streaming error:", err)
                logRequest({ mode: 'stream', answeredBy: null, attempts, startedAt: requestStartedAt });
                if (err && typeof err === 'object') err.userMessage = `${modelId} — ${shortErrorMessage(err)}`;
                try { controller.error(err); } catch {}
                return;
              }
              rotator.markFailed(modelId, rotator.parseRetryAfter(err));
              if (retryableNextRound(err, stats)) retryable.push(modelId);
              remaining = remaining.filter(m => m !== modelId);
              if (remaining.length > 0) {
                safeEnqueue(encode({ _reset: true, next_model: remaining[0], reason: stats.timedOut ? 'timeout' : 'transient' }));
              }
            } finally {
              currentAbort = null;
            }
          }

          if (cancelled) {
            logRequest({ mode: 'stream', answeredBy: null, attempts, startedAt: requestStartedAt, cancelled: true });
            return;
          }
          logRequest({ mode: 'stream', answeredBy: succeededModel, attempts, startedAt: requestStartedAt });
          if (!succeededModel) {
            console.error("[Gemini Provider] All models failed:", lastErr)
            if (lastErr && typeof lastErr === 'object') {
              const rounds = round > 1 ? `, ${round} rounds` : '';
              lastErr.userMessage = `All Gemini models failed (${attempts} attempts${rounds}). Last: ${lastModel} — ${shortErrorMessage(lastErr)}`;
            }
            try { controller.error(lastErr); } catch {}
            return;
          }
          safeEnqueue(encode({ _final_model: succeededModel }));
          safeEnqueue(encodeDone());
          try { controller.close(); } catch {}
        },
      })

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
    GeminiProvider,
    createSTT,
    createLLM,
    createStreamingLLM,
    firstChunkTimeoutMs
};

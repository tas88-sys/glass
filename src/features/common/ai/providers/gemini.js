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
async function createSTT({ apiKey, language = "en-US", callbacks = {}, model = 'gemini-live-2.5-flash-preview', ...config }) {
  // STT does NOT failover — use only the first model in the CSV list (locked decision #3).
  const firstModel = rotator.parseModelList(model)[0] || 'gemini-live-2.5-flash-preview';
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
 * Failover helper for non-streaming LLM calls.
 * Tries each model in the list; on transient error, cools down the current
 * model and moves to the next. On fatal error, throws immediately.
 *
 * @param {string[]} modelList
 * @param {function(string): Promise<object>} doCall  - async fn that receives a modelId
 * @returns {Promise<object>}  - result of doCall merged with { _modelUsed }
 */
async function callWithFailover(modelList, doCall) {
  let remaining = [...modelList];
  let lastErr;
  while (remaining.length > 0) {
    const modelId = rotator.pickModel(remaining);
    try {
      const result = await doCall(modelId);
      rotator.markSucceeded(modelId);
      return { ...result, _modelUsed: modelId };
    } catch (err) {
      lastErr = err;
      const kind = rotator.classifyError(err);
      if (kind !== 'transient') throw err;
      rotator.markFailed(modelId, rotator.parseRetryAfter(err));
      remaining = remaining.filter(m => m !== modelId);
    }
  }
  throw lastErr;
}

/**
 * Creates a Gemini LLM instance with proper text response handling
 */
function createLLM({ apiKey, model = "gemini-2.5-flash", temperature = 0.7, maxTokens = 65536, ...config }) {
  const client = new GoogleGenerativeAI(apiKey)
  const modelList = rotator.parseModelList(model);
  const effectiveModelList = modelList.length > 0 ? modelList : [model];

  return {
    generateContent: async (parts) => {
      return callWithFailover(effectiveModelList, async (modelId) => {
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

        // Return plain text, not wrapped in JSON structure
        return {
          response: {
            text: () => response.text(),
          },
        }
      });
    },

    chat: async (messages) => {
      return callWithFailover(effectiveModelList, async (modelId) => {
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
 * On a transient error (429/503/etc.) during streaming, emits a _reset sentinel
 * to the consumer and retries with the next model in the CSV list.
 * On a fatal error or when all models are exhausted, calls controller.error().
 */
function createStreamingLLM({ apiKey, model = "gemini-2.5-flash", temperature = 0.7, maxTokens = 65536, ...config }) {
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
       */
      async function streamOneAttempt({ modelId, messages: msgs, safeEnqueue }) {
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

        const result = await geminiModel.generateContentStream({
          contents: [{ role: "user", parts: contentParts }],
        })

        for await (const chunk of result.stream) {
          const chunkText = chunk.text() || ""
          const data = JSON.stringify({
            choices: [{ delta: { content: chunkText } }],
          })
          if (!safeEnqueue(new TextEncoder().encode(`data: ${data}\n\n`))) return;
        }
      }

      const modelCsv = model;
      const stream = new ReadableStream({
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
          let lastErr;
          let succeededModel = null;

          while (remaining.length > 0) {
            const modelId = rotator.pickModel(remaining);
            try {
              await streamOneAttempt({ modelId, messages: nonSystemMessages, safeEnqueue });
              succeededModel = modelId;
              rotator.markSucceeded(modelId);
              break;
            } catch (err) {
              lastErr = err;
              const kind = rotator.classifyError(err);
              if (kind !== 'transient') {
                console.error("[Gemini Provider] Fatal streaming error:", err)
                try { controller.error(err); } catch {}
                return;
              }
              rotator.markFailed(modelId, rotator.parseRetryAfter(err));
              remaining = remaining.filter(m => m !== modelId);
              if (remaining.length > 0) {
                safeEnqueue(encode({ _reset: true, next_model: remaining[0], reason: 'transient' }));
              }
            }
          }

          if (!succeededModel) {
            console.error("[Gemini Provider] All models failed:", lastErr)
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
    createStreamingLLM
};

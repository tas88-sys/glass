// factory.js

const providerChain = require('./providerChain');
const catalog = require('./modelCatalog');

/**
 * @typedef {object} ModelOption
 * @property {string} id 
 * @property {string} name
 */

/**
 * @typedef {object} Provider
 * @property {string} name
 * @property {() => any} handler
 * @property {ModelOption[]} llmModels
 * @property {ModelOption[]} sttModels
 */

/**
 * @type {Object.<string, Provider>}
 */
const PROVIDERS = {
  'openai': {
      name: 'OpenAI',
      handler: () => require("./providers/openai"),
      llmModels: [
          { id: 'gpt-4.1', name: 'GPT-4.1' },
      ],
      sttModels: [
          { id: 'gpt-4o-mini-transcribe', name: 'GPT-4o Mini Transcribe' }
      ],
  },

  'openai-glass': {
      name: 'OpenAI (Glass)',
      handler: () => require("./providers/openai"),
      llmModels: [
          { id: 'gpt-4.1-glass', name: 'GPT-4.1 (glass)' },
      ],
      sttModels: [
          { id: 'gpt-4o-mini-transcribe-glass', name: 'GPT-4o Mini Transcribe (glass)' }
      ],
  },
  'gemini': {
      name: 'Gemini',
      handler: () => require("./providers/gemini"),
      llmModels: [
          { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash (preview)' },
      ],
      sttModels: [
          { id: 'gemini-3.8-live', name: 'Gemini 3.8 Live' }
      ],
  },
  'anthropic': {
      name: 'Anthropic',
      handler: () => require("./providers/anthropic"),
      llmModels: [
          { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
          { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
          { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
      ],
      sttModels: [],
  },
  'groq': {
      name: 'Groq',
      handler: () => require("./providers/groq"),
      llmModels: [
          { id: 'openai/gpt-oss-120b', name: 'GPT-OSS 120B (Groq)' },
          { id: 'openai/gpt-oss-20b', name: 'GPT-OSS 20B (Groq)' },
          { id: 'qwen/qwen3.8-27b', name: 'Qwen 3.8 27B, vision (Groq, preview)' },
      ],
      sttModels: [], // Groq's Whisper is batch-only; Glass needs real-time STT
  },
  'openai-compatible': {
      // Any OpenAI chat-completions server at a base URL (OpenRouter, SambaNova,
      // a local OmniRoute…). Its models are the endpoint's own, typed in
      // Settings; none is preset, so onboarding does not offer it.
      name: 'OpenAI-compatible',
      handler: () => require("./providers/openaiCompatible"),
      llmModels: [],
      sttModels: [],
  },
  'deepgram': {
    name: 'Deepgram',
    handler: () => require("./providers/deepgram"),
    llmModels: [],
    sttModels: [
        { id: 'nova-3', name: 'Nova-3 (General)' },
        ],
    },
  'ollama': {
      name: 'Ollama (Local)',
      handler: () => require("./providers/ollama"),
      llmModels: [], // Dynamic models populated from installed Ollama models
      sttModels: [], // Ollama doesn't support STT yet
  },
  'whisper': {
      name: 'Whisper (Local)',
      handler: () => {
          // This needs to remain a function due to its conditional logic for renderer/main process
          if (typeof window === 'undefined') {
              const { WhisperProvider } = require("./providers/whisper");
              return new WhisperProvider();
          }
          // Return a dummy object for the renderer process
          return {
              validateApiKey: async () => ({ success: true }), // Mock validate for renderer
              createSTT: () => { throw new Error('Whisper STT is only available in main process'); },
          };
      },
      llmModels: [],
      sttModels: [
          { id: 'whisper-tiny', name: 'Whisper Tiny (39M)' },
          { id: 'whisper-base', name: 'Whisper Base (74M)' },
          { id: 'whisper-small', name: 'Whisper Small (244M)' },
          { id: 'whisper-medium', name: 'Whisper Medium (769M)' },
      ],
  },
};

/**
 * The provider an ID's prefix suggests: 'claude-…' → anthropic, 'gemini-…' →
 * gemini, '<vendor>/<model>' → groq. Only the last resort of
 * inferProviderFromModelId, for an ID no provider's models list has (no key
 * for it yet, an empty catalog, or a typo).
 * @param {string} id
 * @returns {'anthropic'|'gemini'|'groq'|null}
 */
function providerFromPrefix(id) {
  if (id.startsWith('claude-')) return 'anthropic';
  if (id.startsWith('gemini-')) return 'gemini';
  if (/^[^\s/]+\/\S+$/.test(id)) return 'groq';
  return null;
}

/**
 * Provider of a model ID typed in Settings, or of a comma-separated list of
 * them (the first entry decides): the provider whose models API lists it
 * (modelCatalog); when several do, `context` (the field the list was typed
 * in, or the run it continues) if it is one of them. An ID no catalog has
 * falls back to its prefix (providerFromPrefix), logged once. An
 * OpenAI-compatible endpoint's IDs have no prefix of their own: in its field
 * or run, an unlisted ID stays there unless its prefix names Anthropic or
 * Gemini ('vendor/model' is as much OpenRouter's shape as Groq's). Installed
 * Ollama models are matched before this by the callers.
 * @param {string|null|undefined} modelId
 * @param {string} [context]
 * @returns {'anthropic'|'gemini'|'groq'|'openai-compatible'|null}
 */
function inferProviderFromModelId(modelId, context) {
  if (typeof modelId !== 'string') return null;
  const first = modelId.split(',').map(s => s.trim()).find(Boolean) || '';
  if (!first) return null;
  const listed = catalog.providerOf(first, context);
  if (listed) return listed;
  const byPrefix = providerFromPrefix(first);
  const inferred = context === 'openai-compatible' && (byPrefix === null || byPrefix === 'groq') ? context : byPrefix;
  catalog.notePrefixProvider(first, inferred);
  return inferred;
}

/**
 * Segments of a model list that may name several providers: runs of
 * consecutive IDs of one provider (inferProviderFromModelId, with the current
 * run as context). An ID with no inferable provider joins the current run;
 * the first run's provider is `firstProvider`. Only Anthropic, Gemini, Groq and OpenAI-compatible lists are cut; any other
 * provider's list is one segment. Trimmed, empties dropped; an empty list → [].
 * @param {string|null|undefined} modelCsv
 * @param {string} firstProvider - the active provider
 * @returns {{ provider: string, models: string[] }[]}
 */
function splitByProvider(modelCsv, firstProvider) {
  const ids = typeof modelCsv === 'string' ? modelCsv.split(',').map(s => s.trim()).filter(Boolean) : [];
  if (ids.length === 0) return [];
  if (!providerChain.CHAIN_PROVIDERS.includes(firstProvider)) return [{ provider: firstProvider, models: ids }];
  const segments = [];
  let current = firstProvider;
  for (const id of ids) {
    current = inferProviderFromModelId(id, current) || current;
    const last = segments[segments.length - 1];
    if (last && last.provider === current) last.models.push(id);
    else segments.push({ provider: current, models: [id] });
  }
  return segments;
}

/**
 * The caller's options without keys, and the keys. No provider ever receives
 * the keys map: the chain gives each segment its own key as apiKey.
 */
function takeKeys(opts) {
  if (!opts || !('keys' in opts)) return { keys: undefined, opts };
  const { keys, ...rest } = opts;
  return { keys, opts: rest };
}

function sanitizeModelId(model) {
  return (typeof model === 'string') ? model.replace(/-glass$/, '') : model;
}

function createSTT(provider, opts) {
  if (provider === 'openai-glass') provider = 'openai';
  
  const handler = PROVIDERS[provider]?.handler();
  if (!handler?.createSTT) {
      throw new Error(`STT not supported for provider: ${provider}`);
  }
  if (opts && opts.model) {
    opts = { ...opts, model: sanitizeModelId(opts.model) };
  }
  return handler.createSTT(opts);
}

function createLLM(provider, opts) {
  if (provider === 'openai-glass') provider = 'openai';
  const taken = takeKeys(opts);
  opts = taken.opts;
  // A list naming several providers runs them in turn (providerChain.js).
  const segments = splitByProvider(opts?.model, provider);
  if (segments.length > 1) return providerChain.createChainLLM({ segments, keys: taken.keys, opts });

  const handler = PROVIDERS[provider]?.handler();
  if (!handler?.createLLM) {
      throw new Error(`LLM not supported for provider: ${provider}`);
  }
  if (opts && opts.model) {
    opts = { ...opts, model: sanitizeModelId(opts.model) };
  }
  return handler.createLLM(opts);
}

function createStreamingLLM(provider, opts) {
  if (provider === 'openai-glass') provider = 'openai';
  const taken = takeKeys(opts);
  opts = taken.opts;
  // A list naming several providers runs them in turn (providerChain.js).
  const segments = splitByProvider(opts?.model, provider);
  if (segments.length > 1) return providerChain.createChainStreamingLLM({ segments, keys: taken.keys, opts });

  const handler = PROVIDERS[provider]?.handler();
  if (!handler?.createStreamingLLM) {
      throw new Error(`Streaming LLM not supported for provider: ${provider}`);
  }
  if (opts && opts.model) {
    opts = { ...opts, model: sanitizeModelId(opts.model) };
  }
  return handler.createStreamingLLM(opts);
}

function getProviderClass(providerId) {
    const providerConfig = PROVIDERS[providerId];
    if (!providerConfig) return null;
    
    // Handle special cases for glass providers
    let actualProviderId = providerId;
    if (providerId === 'openai-glass') {
        actualProviderId = 'openai';
    }
    
    // The handler function returns the module, from which we get the class.
    const module = providerConfig.handler();
    
    // Map provider IDs to their actual exported class names
    const classNameMap = {
        'openai': 'OpenAIProvider',
        'anthropic': 'AnthropicProvider',
        'gemini': 'GeminiProvider',
        'groq': 'GroqProvider',
        'openai-compatible': 'OpenAICompatibleProvider',
        'deepgram': 'DeepgramProvider',
        'ollama': 'OllamaProvider',
        'whisper': 'WhisperProvider'
    };
    
    const className = classNameMap[actualProviderId];
    return className ? module[className] : null;
}

function getAvailableProviders() {
  const stt = [];
  const llm = [];
  for (const [id, provider] of Object.entries(PROVIDERS)) {
      if (provider.sttModels.length > 0) stt.push(id);
      if (provider.llmModels.length > 0) llm.push(id);
  }
  return { stt: [...new Set(stt)], llm: [...new Set(llm)] };
}

module.exports = {
  PROVIDERS,
  createSTT,
  createLLM,
  createStreamingLLM,
  getProviderClass,
  getAvailableProviders,
  inferProviderFromModelId,
  providerFromPrefix,
  splitByProvider,
};
/**
 * modelCatalog.js
 *
 * What each model can do, read from its provider's models API instead of
 * tables keyed by model name (spec 2026-10-12-model-catalog). For a provider
 * and model ID, every field resolves in this order:
 *  1. the user's override, set in Settings;
 *  2. what the provider's models API reported (Groq input_modalities,
 *     max_completion_tokens, supported_features; Anthropic capabilities and
 *     max_tokens; Gemini outputTokenLimit and thinking; an OpenAI-compatible
 *     endpoint's own fields, openaiCompatible.normalizeModel);
 *  3. the provider's default (PROVIDER_DEFAULTS), one rule per provider.
 *
 * Also kept per model, learned from the API's own refusals: whether the
 * Anthropic server-side fallback beta is accepted, and the output tokens per
 * minute the key allows (Groq refuses a request over it before generating).
 *
 * Every read is synchronous, from memory. The copy is loaded from SQLite at
 * startup (model_catalog table) and refreshed in the background: at startup,
 * when a key is saved, and when a list names a model the catalog does not
 * know (ensureKnown, which a request waits on for at most ENSURE_TIMEOUT_MS).
 * Without configure() there is no store and no fetcher: nothing is fetched
 * (the tests seed what they need).
 *
 * Singleton module, like modelHealth: one Electron process, one catalog.
 */

'use strict';

/** Providers with a models API the catalog reads (the chain's providers). */
const CATALOG_PROVIDERS = Object.freeze(['anthropic', 'gemini', 'groq', 'openai-compatible']);

// One rule per provider, for a field neither the user nor the API set.
const PROVIDER_DEFAULTS = Object.freeze({
  // An image sent to a Groq model that reads only text is a 400.
  groq: Object.freeze({ vision: false }),
  // models.list reports no input modalities; every Gemini chat model reads images.
  gemini: Object.freeze({ vision: true }),
  anthropic: Object.freeze({ vision: true }),
  // Most OpenAI-compatible servers report no input modalities; an image sent
  // to a model that reads only text is a 400.
  'openai-compatible': Object.freeze({ vision: false }),
});

/** Fields the user can override in Settings. */
const OVERRIDE_FIELDS = Object.freeze(['vision', 'maxOutput', 'reasoning']);

// A provider's list is read again after this long (in the background).
const REFRESH_TTL_MS = 24 * 60 * 60 * 1000;
// A learned per-key limit is forgotten after this long (the account's tier can change).
const KEY_LIMIT_TTL_MS = 24 * 60 * 60 * 1000;
// Longest a request waits for the catalog to learn a model it does not know.
const ENSURE_TIMEOUT_MS = 2_000;

// Map<"provider\0modelId", Row>
const rows = new Map();
// Map<provider, epoch ms of the last full list read in this process>
const listedAt = new Map();
// Map<provider or "provider\0modelId", Promise> (one fetch at a time)
const inflight = new Map();
// IDs whose provider came from a prefix, logged once each
const prefixLogged = new Set();

let store = null;
let fetchers = {};
let now = Date.now;

const keyOf = (provider, modelId) => `${provider}\u0000${modelId}`;
const message = (err) => String(err?.message || err).slice(0, 200);

/**
 * @typedef {object} Row
 * @property {string} provider
 * @property {string} modelId
 * @property {boolean|null} listed - the provider has it (true), said it has not (false), unknown (null)
 * @property {boolean|null} vision
 * @property {number|null} maxOutput
 * @property {boolean|null} reasoning
 * @property {string[]|null} effortLevels - Anthropic effort levels the model accepts
 * @property {boolean|null} thinking
 * @property {boolean|null} serverFallback - false once the API rejected the beta for it
 * @property {{ vision: boolean|null, maxOutput: number|null, reasoning: boolean|null }} override
 * @property {number|null} keyOutputLimit - output tokens per minute this key allows
 * @property {number|null} keyLimitAt
 * @property {number|null} fetchedAt
 */

function emptyRow(provider, modelId) {
  return {
    provider, modelId, listed: null, vision: null, maxOutput: null, reasoning: null,
    effortLevels: null, thinking: null, serverFallback: null,
    override: { vision: null, maxOutput: null, reasoning: null },
    keyOutputLimit: null, keyLimitAt: null, fetchedAt: null,
  };
}

const toBool = (v) => (v == null ? null : !!v);
const toInt = (v) => (v == null ? null : (Number.isFinite(Number(v)) ? Math.floor(Number(v)) : null));
const fromBool = (v) => (v == null ? null : (v ? 1 : 0));

function rowFromDb(r) {
  let effortLevels = null;
  if (r.effort_levels) {
    try { const parsed = JSON.parse(r.effort_levels); if (Array.isArray(parsed)) effortLevels = parsed.map(String); } catch {}
  }
  return {
    provider: r.provider, modelId: r.model_id, listed: toBool(r.listed),
    vision: toBool(r.vision), maxOutput: toInt(r.max_output), reasoning: toBool(r.reasoning),
    effortLevels, thinking: toBool(r.thinking), serverFallback: toBool(r.server_fallback),
    override: { vision: toBool(r.override_vision), maxOutput: toInt(r.override_max_output), reasoning: toBool(r.override_reasoning) },
    keyOutputLimit: toInt(r.key_output_limit), keyLimitAt: toInt(r.key_limit_at), fetchedAt: toInt(r.fetched_at),
  };
}

function rowToDb(row) {
  return {
    provider: row.provider, model_id: row.modelId, listed: fromBool(row.listed),
    vision: fromBool(row.vision), max_output: row.maxOutput, reasoning: fromBool(row.reasoning),
    effort_levels: row.effortLevels ? JSON.stringify(row.effortLevels) : null,
    thinking: fromBool(row.thinking), server_fallback: fromBool(row.serverFallback),
    override_vision: fromBool(row.override.vision), override_max_output: row.override.maxOutput,
    override_reasoning: fromBool(row.override.reasoning),
    key_output_limit: row.keyOutputLimit, key_limit_at: row.keyLimitAt,
    fetched_at: row.fetchedAt, updated_at: now(),
  };
}

function persist(row) {
  if (!store) return;
  try {
    store.upsert(rowToDb(row));
  } catch (err) {
    console.warn(`[Model Catalog] could not save provider=${row.provider} model=${row.modelId}: ${message(err)}`);
  }
}

function rowFor(provider, modelId) {
  const key = keyOf(provider, modelId);
  let row = rows.get(key);
  if (!row) {
    row = emptyRow(provider, modelId);
    rows.set(key, row);
  }
  return row;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/**
 * The fetchers of the real providers, each { list(apiKey), get(apiKey, id) }
 * returning normalized entries ({ id, vision, maxOutput, reasoning,
 * effortLevels, thinking }; null = not reported). Required when called, so
 * loading this module loads no SDK.
 */
function defaultFetchers() {
  const of = (name) => ({
    list: (apiKey) => require(`./providers/${name}`).listModels(apiKey),
    get: (apiKey, id) => require(`./providers/${name}`).getModel(apiKey, id),
  });
  return { anthropic: of('anthropic'), gemini: of('gemini'), groq: of('groq'), 'openai-compatible': of('openaiCompatible') };
}

/**
 * @param {object} o
 * @param {object} [o.store] - { getAll(), upsert(row) } (repositories/modelCatalog)
 * @param {object} [o.fetchers] - provider → { list, get } (defaultFetchers())
 * @param {function(): number} [o.now]
 */
function configure({ store: s, fetchers: f, now: n } = {}) {
  if (s !== undefined) store = s;
  if (f !== undefined) fetchers = f || {};
  if (n !== undefined) now = n || Date.now;
}

/** Load the saved catalog into memory (startup). A failed read leaves it empty. */
function load() {
  if (!store) return 0;
  let saved = [];
  try {
    saved = store.getAll() || [];
  } catch (err) {
    console.warn(`[Model Catalog] could not read the saved catalog: ${message(err)}`);
    return 0;
  }
  for (const r of saved) {
    if (!r?.provider || !r?.model_id) continue;
    rows.set(keyOf(r.provider, r.model_id), rowFromDb(r));
  }
  console.log(`[Model Catalog] loaded ${saved.length} models`);
  return saved.length;
}

// ---------------------------------------------------------------------------
// Reads (synchronous)
// ---------------------------------------------------------------------------

function keyOutputLimit(provider, modelId) {
  const row = rows.get(keyOf(provider, modelId));
  if (!row || row.keyOutputLimit == null) return null;
  if (row.keyLimitAt != null && now() - row.keyLimitAt > KEY_LIMIT_TTL_MS) return null;
  return row.keyOutputLimit;
}

/**
 * What the model can do: override, else reported, else the provider default.
 * `source` says where vision, maxOutput and reasoning came from
 * ('override' | 'api' | 'default' | 'unknown').
 * @param {string} provider
 * @param {string} modelId
 */
function capabilities(provider, modelId) {
  const row = rows.get(keyOf(provider, modelId));
  const defaults = PROVIDER_DEFAULTS[provider] || {};
  const source = {};
  const pick = (field) => {
    const o = row?.override?.[field];
    if (o != null) { source[field] = 'override'; return o; }
    const reported = row?.[field];
    if (reported != null) { source[field] = 'api'; return reported; }
    if (defaults[field] != null) { source[field] = 'default'; return defaults[field]; }
    source[field] = 'unknown';
    return null;
  };
  return {
    vision: pick('vision'),
    maxOutput: pick('maxOutput'),
    reasoning: pick('reasoning'),
    effortLevels: row?.effortLevels ? [...row.effortLevels] : null,
    thinking: row?.thinking ?? null,
    serverFallback: row?.serverFallback ?? null,
    keyOutputLimit: keyOutputLimit(provider, modelId),
    listed: row?.listed ?? null,
    source,
  };
}

/** Whether the model sees images (capabilities().vision is true). */
function seesImages(provider, modelId) {
  return capabilities(provider, modelId).vision === true;
}

/**
 * The attempt order: with an image, the models that see images first (list
 * order), then the rest; otherwise the list as given.
 * @param {string} provider
 * @param {string[]} models
 * @param {boolean} withImages
 * @returns {string[]}
 */
function orderForImages(provider, models, withImages) {
  if (!withImages) return [...models];
  return [...models.filter((m) => seesImages(provider, m)), ...models.filter((m) => !seesImages(provider, m))];
}

/** Providers whose models API has the ID. */
function providersListing(modelId) {
  const found = [];
  for (const provider of CATALOG_PROVIDERS) {
    if (rows.get(keyOf(provider, modelId))?.listed === true) found.push(provider);
  }
  return found;
}

/**
 * The provider of a model ID: the one whose models API has it; when several
 * do, `context` if it is one of them (the field the list was typed in, or the
 * run it continues), else the first. Null when no catalog has it.
 * @param {string} modelId
 * @param {string} [context]
 * @returns {string|null}
 */
function providerOf(modelId, context) {
  const found = providersListing(modelId);
  if (found.length === 0) return null;
  if (found.length > 1 && context && found.includes(context)) return context;
  return found[0];
}

/** Log, once per ID, that a model's provider came from its prefix. */
function notePrefixProvider(modelId, provider) {
  if (prefixLogged.has(modelId)) return;
  prefixLogged.add(modelId);
  console.warn(`[Model Catalog] provider of model=${modelId} taken from its prefix (${provider || 'none'}): no provider's models list has it`);
}

/** Whether the catalog has an answer for the ID that is still good. */
function isKnown(provider, modelId) {
  const row = rows.get(keyOf(provider, modelId));
  if (!row) return false;
  if (row.listed === true) return true;
  return row.listed === false && row.fetchedAt != null && now() - row.fetchedAt < REFRESH_TTL_MS;
}

function isFresh(provider) {
  const at = listedAt.get(provider);
  return at != null && now() - at < REFRESH_TTL_MS;
}

/**
 * For Settings: the catalog's view of these IDs (or of every model of the
 * provider when ids is omitted).
 * @param {{ provider?: string, ids?: string[] }} [q]
 */
function snapshot({ provider, ids } = {}) {
  const providers = provider ? [provider] : CATALOG_PROVIDERS;
  const out = [];
  for (const p of providers) {
    const wanted = ids || [...rows.values()].filter((r) => r.provider === p).map((r) => r.modelId);
    for (const id of wanted) {
      const row = rows.get(keyOf(p, id));
      out.push({ provider: p, modelId: id, fetchedAt: row?.fetchedAt ?? null, override: { ...(row?.override || emptyRow(p, id).override) }, ...capabilities(p, id) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Store what the API reported, keeping the override and what was learned. */
function writeReported(provider, entry, at) {
  const row = rowFor(provider, entry.id);
  row.listed = true;
  row.vision = entry.vision ?? null;
  row.maxOutput = entry.maxOutput ?? null;
  row.reasoning = entry.reasoning ?? null;
  row.effortLevels = Array.isArray(entry.effortLevels) ? [...entry.effortLevels] : null;
  row.thinking = entry.thinking ?? null;
  row.fetchedAt = at;
  persist(row);
}

/**
 * Read the provider's whole list. Without force, a list read less than
 * REFRESH_TTL_MS ago is kept. One read at a time per provider. A failure keeps
 * what is known. A listed model the new list lacks becomes unknown (an alias
 * the list never names is then looked up again by ensureKnown).
 * @returns {Promise<boolean>} whether the catalog has a current list
 */
function refresh(provider, apiKey, { force = false } = {}) {
  const fetcher = fetchers[provider];
  if (!apiKey || !fetcher?.list) return Promise.resolve(false);
  if (!force && isFresh(provider)) return Promise.resolve(true);
  if (inflight.has(provider)) return inflight.get(provider);

  const work = (async () => {
    const startedAt = now();
    let entries;
    try {
      entries = await fetcher.list(apiKey);
    } catch (err) {
      const known = [...rows.values()].filter((r) => r.provider === provider && r.listed === true).length;
      console.warn(`[Model Catalog] refresh provider=${provider} failed, keeping ${known} known models: ${message(err)}`);
      return false;
    }
    const at = now();
    const seen = new Set();
    for (const entry of entries || []) {
      if (!entry?.id) continue;
      seen.add(entry.id);
      writeReported(provider, entry, at);
    }
    for (const row of rows.values()) {
      if (row.provider !== provider || seen.has(row.modelId) || row.listed !== true) continue;
      row.listed = null;
      persist(row);
    }
    listedAt.set(provider, at);
    console.log(`[Model Catalog] refresh provider=${provider} models=${seen.size} total=${at - startedAt}ms`);
    return true;
  })().finally(() => inflight.delete(provider));
  inflight.set(provider, work);
  return work;
}

/** Look up one ID the list does not name (an alias, or a model that does not exist). */
function lookup(provider, apiKey, modelId) {
  const fetcher = fetchers[provider];
  if (!fetcher?.get) return Promise.resolve();
  const key = keyOf(provider, modelId);
  if (inflight.has(key)) return inflight.get(key);
  const work = (async () => {
    try {
      const entry = await fetcher.get(apiKey, modelId);
      const at = now();
      if (entry) {
        writeReported(provider, { ...entry, id: modelId }, at);
      } else {
        const row = rowFor(provider, modelId);
        row.listed = false;
        row.fetchedAt = at;
        persist(row);
        console.warn(`[Model Catalog] provider=${provider} has no model=${modelId}`);
      }
    } catch (err) {
      console.warn(`[Model Catalog] lookup provider=${provider} model=${modelId} failed: ${message(err)}`);
    }
  })().finally(() => inflight.delete(key));
  inflight.set(key, work);
  return work;
}

/**
 * Make sure the catalog knows these IDs. When it does, returns at once (a
 * stale list is read again in the background). Otherwise reads the list (if
 * stale) and looks up what is still missing, waiting at most timeoutMs: past
 * that the caller goes on with the defaults and the work finishes in the
 * background. Never throws.
 * @param {string} provider
 * @param {string} apiKey
 * @param {string[]} ids
 * @param {{ timeoutMs?: number }} [o]
 */
async function ensureKnown(provider, apiKey, ids, { timeoutMs = ENSURE_TIMEOUT_MS } = {}) {
  if (!apiKey || !fetchers[provider]) return;
  const missing = (ids || []).filter((id) => id && !isKnown(provider, id));
  if (missing.length === 0) {
    if (!isFresh(provider)) refresh(provider, apiKey).catch(() => {});
    return;
  }
  const work = (async () => {
    await refresh(provider, apiKey);
    const still = missing.filter((id) => !isKnown(provider, id));
    await Promise.all(still.map((id) => lookup(provider, apiKey, id)));
  })().catch(() => {});
  let timer = null;
  const timeout = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); });
  await Promise.race([work, timeout]);
  clearTimeout(timer);
}

/**
 * Set or clear (null) one override.
 * @param {string} provider
 * @param {string} modelId
 * @param {'vision'|'maxOutput'|'reasoning'} field
 * @param {boolean|number|null} value
 */
function setOverride(provider, modelId, field, value) {
  if (!CATALOG_PROVIDERS.includes(provider)) throw new Error(`no catalog for provider: ${provider}`);
  if (!OVERRIDE_FIELDS.includes(field)) throw new Error(`not an override field: ${field}`);
  let v = value;
  if (v != null) {
    if (field === 'maxOutput') {
      v = Math.floor(Number(v));
      if (!Number.isFinite(v) || v <= 0) throw new Error('maxOutput must be a positive number');
    } else if (typeof v !== 'boolean') {
      throw new Error(`${field} must be true, false or null`);
    }
  }
  const row = rowFor(provider, modelId);
  row.override[field] = v ?? null;
  persist(row);
  console.log(`[Model Catalog] override provider=${provider} model=${modelId} ${field}=${v ?? 'auto'}`);
}

/** Clear every override of the model. */
function clearOverrides(provider, modelId) {
  const row = rows.get(keyOf(provider, modelId));
  if (!row) return;
  row.override = { vision: null, maxOutput: null, reasoning: null };
  persist(row);
}

/** Record whether the API accepts the server-side fallback beta for the model. */
function markServerFallback(provider, modelId, supported) {
  const row = rowFor(provider, modelId);
  if (row.serverFallback === supported) return;
  row.serverFallback = supported;
  persist(row);
}

/** Record the output tokens per minute the key allows on the model (from a refusal). */
function recordKeyOutputLimit(provider, modelId, limit) {
  const n = toInt(limit);
  if (n == null || n <= 0) return;
  const row = rowFor(provider, modelId);
  row.keyOutputLimit = n;
  row.keyLimitAt = now();
  persist(row);
}

/** Forget the provider's learned key limits (its key changed). */
function clearKeyLimits(provider) {
  for (const row of rows.values()) {
    if (row.provider !== provider || row.keyOutputLimit == null) continue;
    row.keyOutputLimit = null;
    row.keyLimitAt = null;
    persist(row);
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Put models in the catalog as if the provider's list reported them, and
 * mark that list current. For tests.
 * @internal
 */
function seed(provider, entries) {
  const at = now();
  for (const entry of entries) writeReported(provider, entry, at);
  listedAt.set(provider, at);
}

/**
 * Empty the catalog and drop the store, fetchers and clock. For test beforeEach only.
 * @internal
 */
function resetCatalog() {
  rows.clear();
  listedAt.clear();
  inflight.clear();
  prefixLogged.clear();
  store = null;
  fetchers = {};
  now = Date.now;
}

module.exports = {
  CATALOG_PROVIDERS,
  PROVIDER_DEFAULTS,
  OVERRIDE_FIELDS,
  REFRESH_TTL_MS,
  KEY_LIMIT_TTL_MS,
  ENSURE_TIMEOUT_MS,
  defaultFetchers,
  configure,
  load,
  capabilities,
  seesImages,
  orderForImages,
  providersListing,
  providerOf,
  notePrefixProvider,
  isKnown,
  keyOutputLimit,
  snapshot,
  refresh,
  ensureKnown,
  setOverride,
  clearOverrides,
  markServerFallback,
  recordKeyOutputLimit,
  clearKeyLimits,
  seed,
  resetCatalog,
};

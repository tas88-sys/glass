/**
 * openaiCompatible.test.js
 *
 * The OpenAI-compatible provider: the saved credential (base URL + key), the
 * models-list normalization, the request it builds, the error classes, and
 * failover, streaming (streamChat) and non-streaming (chat), against a
 * scripted fake of the openai SDK.
 *
 * The fake re-exports the real openai error classes (loaded before the
 * interceptor), so status, body and headers match production. Its streams
 * replay scripted chunks, honour the request's signal, and end without
 * throwing on abort, as the real SDK does. Timeouts are shortened through
 * the options, so the suite runs on real timers.
 * Run: node --test src/features/common/ai/providers/__tests__/openaiCompatible.test.js
 */

'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const RealOpenAI = require('openai');
const { APIError, APIConnectionError } = RealOpenAI;

// ---------------------------------------------------------------------------
// Fake SDK
// ---------------------------------------------------------------------------

let script = null; // async (call) => plan | throws; set per test
let calls = []; // { params, options, signal }
let clients = []; // constructor options of every client made
let modelsList = async () => ({ data: [] });
let modelsRetrieve = async () => { throw APIError.generate(404, { error: { message: 'not found' } }, undefined, new Headers()); };

function abortable(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/** Replays a plan: { chunks: [chunk | { wait: ms }], error?, hang?, headers? }. */
async function* replay(plan, signal) {
  for (const item of plan.chunks || []) {
    if (signal.aborted) return;
    if (item.wait != null) { await abortable(item.wait, signal); continue; }
    yield item;
  }
  if (signal.aborted) return;
  if (plan.error) throw plan.error;
  if (plan.hang) await abortable(2 ** 31 - 1, signal);
}

function fakeCreate(params, options) {
  const call = { params: structuredClone(params), options, signal: options?.signal };
  calls.push(call);
  const opened = (async () => {
    const plan = await script(call);
    return { plan, data: replay(plan, call.signal) };
  })();
  const promise = opened.then(r => r.data);
  promise.catch(() => {});
  promise.withResponse = async () => {
    const { plan, data } = await opened;
    return { data, response: new Response(null, { headers: { 'x-request-id': `req_${calls.length}`, ...(plan.headers || {}) } }) };
  };
  return promise;
}

class FakeOpenAI {
  constructor(opts) {
    this.clientOpts = opts;
    clients.push(opts);
    this.chat = { completions: { create: (params, options) => fakeCreate(params, options) } };
    this.models = { list: (...a) => modelsList(...a), retrieve: (...a) => modelsRetrieve(...a) };
  }
}
Object.assign(FakeOpenAI, RealOpenAI, { default: FakeOpenAI });

const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'openai') return FakeOpenAI;
  return originalLoad.apply(this, arguments);
};
for (const k of Object.keys(require.cache)) if (/[\\/]openaiCompatible\.js$/.test(k)) delete require.cache[k];

const health = require('../modelHealth');
const catalog = require('../../modelCatalog');
const compat = require('../openaiCompatible');
const { classify } = require('../openaiCompatibleErrors');
const {
  OpenAICompatibleProvider, createLLM, createStreamingLLM, normalizeModel, buildRequest,
  checkBaseURL, formatCredential, parseCredential, healthKey, listModels,
} = compat;

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------

const CRED = formatCredential('http://localhost:20128/v1', 'sk-local');
const base = (model) => ({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model });
const ch = {
  text: (model, content) => ({ ...base(model), choices: [{ index: 0, delta: { content }, finish_reason: null }] }),
  reasoning: (model, reasoning) => ({ ...base(model), choices: [{ index: 0, delta: { reasoning }, finish_reason: null }] }),
  finish: (model, reason = 'stop') => ({ ...base(model), choices: [{ index: 0, delta: {}, finish_reason: reason }], usage: { prompt_tokens: 9, completion_tokens: 3 } }),
  error: (model) => ({ ...base(model), choices: [], error: { message: 'upstream failed', code: 502 } }),
};
const answer = (model, ...texts) => ({ chunks: [...texts.map(t => ch.text(model, t)), ch.finish(model)] });
const httpError = (status, message = 'server said no', headers = {}) =>
  APIError.generate(status, { error: { message } }, undefined, new Headers(headers));

function byModel(plans) {
  const seen = {};
  return async (call) => {
    const model = call.params.model;
    if (!(model in plans)) throw new Error(`unscripted model ${model}`);
    const i = (seen[model] = (seen[model] ?? -1) + 1);
    const entry = plans[model];
    const plan = Array.isArray(entry) ? entry[Math.min(i, entry.length - 1)] : entry;
    if (plan instanceof Error) throw plan;
    return plan;
  };
}

function parseChunk(raw) {
  return raw.split('\n').filter(l => l.startsWith('data: ')).map((l) => {
    const d = l.slice(6);
    if (d === '[DONE]') return { done: true };
    const json = JSON.parse(d);
    if (json.choices) return { text: json.choices[0].delta.content };
    return json;
  });
}

async function readAll(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let error = null;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      events.push(...parseChunk(decoder.decode(value)));
    }
  } catch (err) {
    error = err;
  }
  return { events, error, text: events.filter(e => e.text != null).map(e => e.text).join('') };
}

const USER = [{ role: 'user', content: 'hi' }];
const IMAGE = { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } };
const FAST = { firstTextTimeoutMs: 300, retryRoundDelayMs: 20 };
const stream = (model, extra = {}) => createStreamingLLM({ apiKey: CRED, model, ...FAST, ...extra }).streamChat(USER);

/** Set environment variables for one test. */
function withEnv(t, vars) {
  const before = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  Object.assign(process.env, vars);
  t.after(() => { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}

/** Silence the provider's logs for one test, keeping them for assertions. */
function quiet(t) {
  const lines = [];
  for (const level of ['log', 'warn', 'error']) t.mock.method(console, level, (...a) => { lines.push(a.join(' ')); });
  return lines;
}

beforeEach(() => {
  script = null;
  calls = [];
  clients = [];
  modelsList = async () => ({ data: [] });
  health.resetHealth();
  catalog.resetCatalog();
});

// ---------------------------------------------------------------------------
// Credential
// ---------------------------------------------------------------------------

describe('checkBaseURL', () => {
  it('takes https anywhere and http on this machine only', () => {
    assert.deepEqual(checkBaseURL('https://openrouter.ai/api/v1'), { baseURL: 'https://openrouter.ai/api/v1' });
    assert.deepEqual(checkBaseURL('http://localhost:20128/v1'), { baseURL: 'http://localhost:20128/v1' });
    assert.deepEqual(checkBaseURL('http://127.0.0.1:8000/v1'), { baseURL: 'http://127.0.0.1:8000/v1' });
    assert.deepEqual(checkBaseURL('http://[::1]:8000/v1'), { baseURL: 'http://[::1]:8000/v1' });
    assert.match(checkBaseURL('http://192.168.0.10:20128/v1').error, /https/);
    assert.match(checkBaseURL('ftp://localhost/v1').error, /https/);
  });

  it('drops trailing slashes and keeps the path', () => {
    assert.deepEqual(checkBaseURL('  https://api.sambanova.ai/v1//  '), { baseURL: 'https://api.sambanova.ai/v1' });
    assert.deepEqual(checkBaseURL('https://example.com/'), { baseURL: 'https://example.com' });
  });

  it('refuses an empty value, a non-URL, a key in the URL, a query or a fragment', () => {
    assert.match(checkBaseURL('').error, /base URL/);
    assert.match(checkBaseURL(undefined).error, /base URL/);
    assert.match(checkBaseURL('localhost:20128').error, /https|not a URL/);
    assert.match(checkBaseURL('https://user:sk@example.com/v1').error, /own field/);
    assert.match(checkBaseURL('https://example.com/v1?key=1').error, /query/);
    assert.match(checkBaseURL('https://example.com/v1#x').error, /query/);
  });
});

describe('formatCredential / parseCredential', () => {
  it('round-trips the base URL and key', () => {
    assert.deepEqual(parseCredential(formatCredential('https://openrouter.ai/api/v1/', ' sk-or-1 ')), { baseURL: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-1' });
  });

  it('a URL alone, or with an empty key, has no key', () => {
    assert.deepEqual(parseCredential('http://localhost:20128/v1'), { baseURL: 'http://localhost:20128/v1', apiKey: '' });
    assert.deepEqual(parseCredential(formatCredential('http://localhost:20128/v1', '')), { baseURL: 'http://localhost:20128/v1', apiKey: '' });
  });

  it('null when the URL is not valid', () => {
    assert.equal(parseCredential(formatCredential('http://example.com/v1', 'k')), null);
    assert.equal(parseCredential(null), null);
    assert.equal(parseCredential('\nsk'), null);
  });
});

describe('the SDK client', () => {
  it('gets the endpoint and key, never the OpenAI settings from the environment', async (t) => {
    quiet(t);
    withEnv(t, { OPENAI_API_KEY: 'sk-openai-real', OPENAI_ORG_ID: 'org-real' });
    script = byModel({ m: answer('m', 'ok') });
    await readAll(await stream('m'));
    assert.equal(clients.length, 1);
    assert.equal(clients[0].baseURL, 'http://localhost:20128/v1');
    assert.equal(clients[0].apiKey, 'sk-local');
    assert.equal(clients[0].organization, null);
    assert.equal(clients[0].project, null);
    assert.equal(clients[0].maxRetries, 0);
  });

  it('sends a placeholder key when the endpoint needs none', async (t) => {
    quiet(t);
    withEnv(t, { OPENAI_API_KEY: 'sk-openai-real' });
    script = byModel({ m: answer('m', 'ok') });
    await readAll(await createStreamingLLM({ apiKey: formatCredential('http://localhost:20128/v1', ''), model: 'm', ...FAST }).streamChat(USER));
    assert.equal(clients[0].apiKey, 'none');
  });
});

// ---------------------------------------------------------------------------
// Models list
// ---------------------------------------------------------------------------

describe('normalizeModel', () => {
  it('reads Groq-shaped entries', () => {
    assert.deepEqual(normalizeModel({ id: 'qwen/qwen3.8-27b', input_modalities: ['text', 'image'], max_completion_tokens: 16384, supported_features: ['reasoning'] }),
      { id: 'qwen/qwen3.8-27b', vision: true, maxOutput: 16384, reasoning: true, effortLevels: null, thinking: null });
  });

  it('reads OpenRouter-shaped entries', () => {
    const m = normalizeModel({
      id: 'meta-llama/llama-3.3-70b-instruct:free',
      architecture: { input_modalities: ['text'] },
      top_provider: { max_completion_tokens: 4096 },
      supported_parameters: ['max_tokens', 'temperature'],
    });
    assert.deepEqual([m.vision, m.maxOutput, m.reasoning], [false, 4096, false]);
    assert.equal(normalizeModel({ id: 'x', supported_parameters: ['reasoning', 'include_reasoning'] }).reasoning, true);
  });

  it('reads OmniRoute-shaped entries', () => {
    const m = normalizeModel({ id: 'groq/openai/gpt-oss-120b', max_output_tokens: 65536, input_modalities: ['text'], capabilities: { vision: false, reasoning: true, tool_calling: true } });
    assert.deepEqual([m.vision, m.maxOutput, m.reasoning], [false, 65536, true]);
    assert.equal(normalizeModel({ id: 'v', capabilities: { vision: true } }).vision, true);
  });

  it('unknown (null) for what the server does not say', () => {
    assert.deepEqual(normalizeModel({ id: 'bare', object: 'model', owned_by: 'x' }),
      { id: 'bare', vision: null, maxOutput: null, reasoning: null, effortLevels: null, thinking: null });
  });
});

describe('listModels', () => {
  it('normalizes the endpoint list and drops entries without an ID', async () => {
    modelsList = async () => ({ data: [{ id: 'a', input_modalities: ['text', 'image'] }, { object: 'model' }, { id: 'b' }] });
    const models = await listModels(CRED);
    assert.deepEqual(models.map(m => [m.id, m.vision]), [['a', true], ['b', null]]);
  });
});

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

describe('buildRequest', () => {
  it('sends only model, messages, stream, max_tokens and temperature', () => {
    const { params } = buildRequest({ modelId: 'm', messages: USER, temperature: 0.4, env: {} });
    assert.deepEqual(Object.keys(params).sort(), ['max_tokens', 'messages', 'model', 'stream', 'temperature']);
    assert.equal(params.stream, true);
    assert.equal(params.max_tokens, 8192);
  });

  it('the caller cap wins, then OPENAI_COMPATIBLE_MAX_TOKENS, then 8,192; the model limit caps it', () => {
    assert.equal(buildRequest({ modelId: 'm', messages: USER, maxTokens: 900, env: {} }).params.max_tokens, 900);
    assert.equal(buildRequest({ modelId: 'm', messages: USER, env: { OPENAI_COMPATIBLE_MAX_TOKENS: '2000' } }).params.max_tokens, 2000);
    catalog.seed('openai-compatible', [{ id: 'small', maxOutput: 4096 }]);
    assert.equal(buildRequest({ modelId: 'small', messages: USER, env: {} }).params.max_tokens, 4096);
  });

  it('adds the reasoning allowance on a model the catalog says reasons', () => {
    catalog.seed('openai-compatible', [{ id: 'thinker', reasoning: true }]);
    assert.equal(buildRequest({ modelId: 'thinker', messages: USER, maxTokens: 900, env: {} }).params.max_tokens, 1924);
    assert.equal(buildRequest({ modelId: 'thinker', messages: USER, maxTokens: 900, env: { OPENAI_COMPATIBLE_REASONING_TOKENS: '0' } }).params.max_tokens, 900);
  });

  it('keeps images only for a model that sees them (default: text only)', () => {
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'what is this' }, IMAGE] }];
    const blind = buildRequest({ modelId: 'm', messages, env: {} });
    assert.deepEqual([blind.imagesSent, blind.imagesDropped], [0, 1]);
    assert.equal(blind.params.messages[0].content, 'what is this');
    catalog.seed('openai-compatible', [{ id: 'eyes', vision: true }]);
    const seeing = buildRequest({ modelId: 'eyes', messages, env: {} });
    assert.equal(seeing.imagesSent, 1);
    assert.equal(seeing.params.messages[0].content[1].image_url.url, IMAGE.image_url.url);
  });

  it('leaves out a temperature outside [0, 2]', () => {
    assert.equal('temperature' in buildRequest({ modelId: 'm', messages: USER, temperature: 3, env: {} }).params, false);
  });
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

describe('classify', () => {
  it('key errors end the request; refusals, missing models and limits fail over', () => {
    assert.equal(classify(httpError(401)), 'fatal-auth');
    assert.equal(classify(httpError(403)), 'fatal-auth');
    assert.equal(classify(httpError(400)), 'rejected');
    assert.equal(classify(httpError(422)), 'rejected');
    assert.equal(classify(httpError(404)), 'unavailable');
    assert.equal(classify(httpError(402)), 'unavailable');
    assert.equal(classify(httpError(413)), 'too-large');
    for (const s of [408, 409, 425, 429, 500, 502, 503]) assert.equal(classify(httpError(s)), 'transient', String(s));
  });

  it('connection errors, our own codes and anything unknown are transient', () => {
    assert.equal(classify(new APIConnectionError({ message: 'ECONNREFUSED' })), 'transient');
    assert.equal(classify(Object.assign(new Error('x'), { code: 'FIRST_TEXT_TIMEOUT' })), 'transient');
    assert.equal(classify(new Error('weird')), 'transient');
    assert.equal(classify(null), 'transient');
  });
});

// ---------------------------------------------------------------------------
// Failover
// ---------------------------------------------------------------------------

describe('createStreamingLLM', () => {
  it('streams the answer, then _final_model and [DONE]', async (t) => {
    const lines = quiet(t);
    script = byModel({ 'groq/openai/gpt-oss-120b': { ...answer('openai/gpt-oss-120b', 'Hel', 'lo'), headers: { 'x-omniroute-decision': 'strategy=priority provider=groq' } } });
    const { events, error, text } = await readAll(await stream('groq/openai/gpt-oss-120b', { maxTokens: 900 }));
    assert.equal(error, null);
    assert.equal(text, 'Hello');
    assert.deepEqual(events.slice(-2), [{ _final_model: 'openai/gpt-oss-120b' }, { done: true }]);
    assert.equal(calls[0].params.max_tokens, 900);
    const attempt = lines.find(l => l.includes('attempt 1/1'));
    assert.match(attempt, /outcome=ok/);
    assert.match(attempt, /ttft=\d+ms/);
    assert.match(attempt, /route="strategy=priority provider=groq"/);
    assert.match(lines.find(l => l.includes('request stream')), /host=localhost:20128/);
    assert.ok(!lines.some(l => l.includes('Hello') || l.includes('sk-local')), 'no answer text or key in the logs');
  });

  it('a rate limit fails over and cools the model under this provider\'s name only', async (t) => {
    quiet(t);
    script = byModel({ a: httpError(429, 'slow down', { 'retry-after': '30' }), b: answer('b', 'ok') });
    const { events, text } = await readAll(await stream('a,b'));
    assert.equal(text, 'ok');
    assert.deepEqual(events[0], { _reset: true, next_model: 'b', reason: 'transient' });
    assert.equal(health.isCoolingDown(healthKey('a')), true);
    assert.equal(health.isCoolingDown('a'), false, 'a Groq model with the same ID is not cooled');
    assert.equal(compat.isCoolingDown('a'), true);
  });

  it('a model that refuses the request (400) hands it to the next model', async (t) => {
    quiet(t);
    script = byModel({ a: httpError(400, 'unknown parameter'), b: answer('b', 'fine') });
    const { text, error } = await readAll(await stream('a,b'));
    assert.equal(error, null);
    assert.equal(text, 'fine');
    assert.equal(calls.length, 2);
  });

  it('a refused key ends the request without trying the next model', async (t) => {
    quiet(t);
    script = byModel({ a: httpError(401, 'bad key'), b: answer('b', 'never') });
    const { error } = await readAll(await stream('a,b'));
    assert.match(error.userMessage, /localhost:20128 refused the API key \(401\)/);
    assert.equal(calls.length, 1);
  });

  it('a model the endpoint does not serve says so', async (t) => {
    quiet(t);
    script = byModel({ gone: httpError(404, 'model not found') });
    const { error } = await readAll(await stream('gone'));
    assert.match(error.userMessage, /gone is not served by this endpoint/);
  });

  it('a model that needs credit (402) says so', async (t) => {
    quiet(t);
    script = byModel({ paid: httpError(402, 'insufficient credits') });
    const { error } = await readAll(await stream('paid'));
    assert.match(error.userMessage, /needs credit/);
  });

  it('a first-text timeout moves on; reasoning chunks do not count as text', async (t) => {
    quiet(t);
    script = byModel({ slow: { chunks: [ch.reasoning('slow', 'hmm')], hang: true }, fast: answer('fast', 'here') });
    const { text, events } = await readAll(await stream('slow,fast', { firstTextTimeoutMs: 80 }));
    assert.equal(text, 'here');
    assert.equal(events[0].reason, 'timeout');
  });

  it('an error chunk mid-stream fails over', async (t) => {
    quiet(t);
    script = byModel({ a: { chunks: [ch.error('a')] }, b: answer('b', 'second') });
    const { text } = await readAll(await stream('a,b'));
    assert.equal(text, 'second');
  });

  it('stops at finish_reason even when the server keeps the connection open', async (t) => {
    quiet(t);
    script = byModel({ a: { ...answer('a', 'done'), hang: true } });
    const started = Date.now();
    const { text } = await readAll(await stream('a', { idleTimeoutMs: 5_000 }));
    assert.equal(text, 'done');
    assert.ok(Date.now() - started < 1_000);
  });

  it('a whole budget spent before any text fails over (EMPTY_MAX_TOKENS)', async (t) => {
    quiet(t);
    script = byModel({ a: { chunks: [ch.reasoning('a', '…'), ch.finish('a', 'length')] }, b: answer('b', 'ok') });
    const { text } = await readAll(await stream('a,b'));
    assert.equal(text, 'ok');
  });

  it('with an image, the model that sees images goes first; visionOnly leaves out the rest', async (t) => {
    quiet(t);
    catalog.seed('openai-compatible', [{ id: 'blind', vision: false }, { id: 'eyes', vision: true }]);
    script = byModel({ eyes: answer('eyes', 'a cat') });
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'what?' }, IMAGE] }];
    const res = await createStreamingLLM({ apiKey: CRED, model: 'blind,eyes', ...FAST }).streamChat(messages);
    assert.equal((await readAll(res)).text, 'a cat');
    assert.equal(calls[0].params.model, 'eyes');

    const none = await createStreamingLLM({ apiKey: CRED, model: 'blind', visionOnly: true, ...FAST }).streamChat(messages);
    const { error } = await readAll(none);
    assert.equal(error.code, 'NO_VISION_MODEL');
    assert.equal(calls.length, 1);
  });

  it('an empty list is an error, not a default model', async (t) => {
    quiet(t);
    const { error } = await readAll(await stream(''));
    assert.equal(error.code, 'NO_MODEL');
    assert.equal(calls.length, 0);
  });

  it('a saved URL that is not valid fails the request, not the creation', async (t) => {
    quiet(t);
    const llm = createStreamingLLM({ apiKey: formatCredential('http://example.com/v1', 'k'), model: 'a', ...FAST });
    const { error } = await readAll(await llm.streamChat(USER));
    assert.equal(error.code, 'BAD_CREDENTIAL');
    assert.match(error.userMessage, /base URL saved in Settings is not valid/);
  });

  it('cancelling aborts the request in flight', async (t) => {
    quiet(t);
    script = byModel({ a: { chunks: [ch.text('a', 'part')], hang: true } });
    const res = await stream('a', { idleTimeoutMs: null });
    const reader = res.body.getReader();
    await reader.read();
    while (!calls[0]) await new Promise(r => setTimeout(r, 5));
    await reader.cancel();
    await new Promise(r => setTimeout(r, 20));
    assert.equal(calls[0].signal.aborted, true);
  });

  it('every model failing ends with one message naming the last failure', async (t) => {
    quiet(t);
    script = byModel({ a: httpError(503, 'overloaded'), b: httpError(503, 'overloaded') });
    const { error } = await readAll(await stream('a,b'));
    assert.match(error.userMessage, /^All OpenAI-compatible models failed \(4 attempts, 2 rounds\)\. Last: b — overloaded$/);
  });
});

describe('createLLM', () => {
  it('chat returns the joined text and the model that answered', async (t) => {
    quiet(t);
    script = byModel({ a: httpError(500), b: answer('b-served', 'Hi ', 'there') });
    const result = await createLLM({ apiKey: CRED, model: 'a,b', ...FAST }).chat(USER);
    assert.equal(result.content, 'Hi there');
    assert.equal(result._modelUsed, 'b-served');
  });

  it('generateContent sends every part as user content', async (t) => {
    quiet(t);
    script = byModel({ a: answer('a', 'ok') });
    const result = await createLLM({ apiKey: CRED, model: 'a', ...FAST }).generateContent(['one', 'two']);
    assert.equal(result.response.text(), 'ok');
    assert.deepEqual(calls[0].params.messages, [{ role: 'user', content: 'one\ntwo' }]);
  });
});

// ---------------------------------------------------------------------------
// Key validation
// ---------------------------------------------------------------------------

describe('OpenAICompatibleProvider.validateApiKey', () => {
  it('refuses a bad URL without a request', async () => {
    let listed = 0;
    modelsList = async () => { listed++; return { data: [] }; };
    const result = await OpenAICompatibleProvider.validateApiKey(formatCredential('http://example.com/v1', 'k'));
    assert.equal(result.success, false);
    assert.match(result.error, /https/);
    assert.equal(listed, 0);
  });

  it('lists the models to check the key', async () => {
    modelsList = async () => ({ data: [{ id: 'a' }] });
    assert.deepEqual(await OpenAICompatibleProvider.validateApiKey(CRED), { success: true });
  });

  it('says which host refused the key, or could not be reached', async (t) => {
    quiet(t);
    modelsList = async () => { throw httpError(401); };
    assert.match((await OpenAICompatibleProvider.validateApiKey(CRED)).error, /localhost:20128 refused the API key/);
    modelsList = async () => { throw httpError(404); };
    assert.match((await OpenAICompatibleProvider.validateApiKey(CRED)).error, /\/models not found/);
    modelsList = async () => { throw new APIConnectionError({ message: 'ECONNREFUSED' }); };
    assert.match((await OpenAICompatibleProvider.validateApiKey(CRED)).error, /Could not reach localhost:20128/);
  });
});

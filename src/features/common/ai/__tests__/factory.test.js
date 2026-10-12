/**
 * factory.test.js
 *
 * Provider presets and the model-ID prefix rule that maps a typed model (or
 * CSV list) to its provider.
 * Run: node --test src/features/common/ai/__tests__/factory.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { PROVIDERS, inferProviderFromModelId } = require('../factory');

describe('Anthropic presets (FR-001)', () => {
  it('are the current Opus, Sonnet and Haiku', () => {
    assert.deepEqual(PROVIDERS.anthropic.llmModels.map(m => m.id), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
  });

  it('list no retired Claude 3 model', () => {
    for (const provider of Object.values(PROVIDERS)) {
      for (const m of [...provider.llmModels, ...provider.sttModels]) assert.doesNotMatch(m.id, /^claude-3/);
    }
  });

  it('have no STT model', () => {
    assert.deepEqual(PROVIDERS.anthropic.sttModels, []);
  });
});

describe('inferProviderFromModelId (FR-002)', () => {
  const cases = [
    ['claude-haiku-5-5', 'anthropic'],
    ['claude-haiku-5-5,claude-sonnet-5-5', 'anthropic'],
    [' claude-opus-5-5 ', 'anthropic'],
    [' , claude-sonnet-5-5', 'anthropic'],
    ['gemini-3-flash-preview', 'gemini'],
    ['gemini-3.1-flash-lite,gemini-3-flash-preview', 'gemini'],
    ['gpt-4.1', null],
    ['llama3.2:latest', null],
    ['', null],
    [null, null],
    [undefined, null],
    [42, null],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} → ${expected}`, () => assert.equal(inferProviderFromModelId(input), expected));
  }
});

describe('Groq provider (spec 2026-10-12-groq-provider FR-001)', () => {
  const RETIRED = /^(llama-3\.[13]-|qwen\/qwen3-32b|qwen\/qwen3\.6-|meta-llama\/llama-4-|moonshotai\/|groq\/compound)/;

  it('is registered with the three active chat models and no STT model', () => {
    assert.equal(PROVIDERS.groq.name, 'Groq');
    assert.deepEqual(PROVIDERS.groq.llmModels.map(m => m.id), ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b']);
    assert.deepEqual(PROVIDERS.groq.sttModels, []);
  });

  it('offers no model retired for free and developer tiers', () => {
    for (const m of PROVIDERS.groq.llmModels) assert.doesNotMatch(m.id, RETIRED);
  });

  it('getProviderClass resolves GroqProvider', () => {
    const { getProviderClass } = require('../factory');
    const { GroqProvider } = require('../providers/groq');
    assert.equal(getProviderClass('groq'), GroqProvider);
  });
});

describe('inferProviderFromModelId: Groq (spec 2026-10-12-groq-provider FR-002)', () => {
  const cases = [
    ['openai/gpt-oss-120b', 'groq'],
    ['qwen/qwen3.8-27b,openai/gpt-oss-20b', 'groq'],
    [' openai/gpt-oss-20b', 'groq'],
    [' , qwen/qwen3.8-27b', 'groq'],
    ['acme/model-1', 'groq'],
    ['claude-haiku-5-5,openai/gpt-oss-120b', 'anthropic'],
    ['gemini-3-flash-preview,openai/gpt-oss-120b', 'gemini'],
    ['llama-3.3-70b-versatile', null],
    ['a b/c', null],
    ['/model', null],
    ['vendor/', null],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} → ${expected}`, () => assert.equal(inferProviderFromModelId(input), expected));
  }
});

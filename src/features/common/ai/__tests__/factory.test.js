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

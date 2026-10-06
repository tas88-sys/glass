/**
 * askStreamState.js
 *
 * Pure reducer for the Ask SSE stream (no Electron), used by
 * askService._processStream and unit-tested directly.
 *
 * Keeps `isLoading` true until the first content token arrives, so the Ask
 * window shows "Thinking..." during failover / model thinking instead of an
 * empty "AI Response".
 */

'use strict';

/**
 * @typedef {object} AskStreamState
 * @property {string} fullResponse
 * @property {boolean} isLoading         - true until the first token (and again after a _reset)
 * @property {boolean} isStreaming       - true once tokens are flowing
 * @property {string|null} responseModel - model that answered (_final_model)
 * @property {boolean} responseHadFallback
 * @property {string|null} retryingWith  - model being tried after a _reset, until its first token
 */

/** @returns {AskStreamState} */
function initialAskStreamState() {
  return {
    fullResponse: '',
    isLoading: true,
    isStreaming: false,
    responseModel: null,
    responseHadFallback: false,
    retryingWith: null,
  };
}

/**
 * Apply one parsed SSE `data:` payload.
 * @param {AskStreamState} state
 * @param {object} json
 * @returns {AskStreamState} next state — the same reference when nothing changed
 */
function applyAskSseEvent(state, json) {
  if (!json || typeof json !== 'object') return state;

  // Failover: discard the partial answer and wait for the next model.
  if (json._reset) {
    return {
      ...state,
      fullResponse: '',
      isLoading: true,
      isStreaming: false,
      responseHadFallback: true,
      retryingWith: json.next_model || null,
    };
  }

  if (json._final_model) {
    return { ...state, responseModel: json._final_model };
  }

  const token = json.choices?.[0]?.delta?.content || '';
  if (!token) return state;
  return {
    ...state,
    fullResponse: state.fullResponse + token,
    isLoading: false,
    isStreaming: true,
    retryingWith: null,
  };
}

module.exports = { initialAskStreamState, applyAskSseEvent };

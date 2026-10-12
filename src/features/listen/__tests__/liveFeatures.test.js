/**
 * liveFeatures.test.js
 *
 * Unit tests for the Live Answer / Live Insights mode rule (spec
 * 2026-10-12-live-features-toggle, FR-001, D9).
 * Run: node --test src/features/listen/__tests__/liveFeatures.test.js
 *
 * Pure logic, no Electron/Lit/DOM coupling.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const MODULE_PATH = path.join(__dirname, '..', 'liveFeatures.js');

const {
    LIVE_FEATURES,
    DEFAULT_LIVE_FEATURES,
    normalizeLiveFeatures,
    answerEnabled,
    insightsEnabled,
    nextLiveFeatures,
    liveFeaturesState,
    liveFeaturesLabel,
    viewLabels,
} = require(MODULE_PATH);

const INVALID = [null, undefined, 42, '', 'ANSWER', {}, ['answer']];

describe('LIVE_FEATURES', () => {
    it('lists the three modes, default first, and the default is both', () => {
        assert.deepEqual([...LIVE_FEATURES], ['both', 'answer', 'insights']);
        assert.equal(DEFAULT_LIVE_FEATURES, 'both');
    });

    it('cannot be changed by a caller', () => {
        assert.ok(Object.isFrozen(LIVE_FEATURES));
    });
});

describe('normalizeLiveFeatures', () => {
    it('passes the three modes through', () => {
        for (const mode of ['both', 'answer', 'insights']) {
            assert.equal(normalizeLiveFeatures(mode), mode);
        }
    });

    it('reads any other value as both', () => {
        for (const value of INVALID) {
            assert.equal(normalizeLiveFeatures(value), 'both', `value ${JSON.stringify(value)}`);
        }
    });
});

describe('answerEnabled / insightsEnabled', () => {
    it('follow the mode table', () => {
        assert.equal(answerEnabled('both'), true);
        assert.equal(insightsEnabled('both'), true);
        assert.equal(answerEnabled('answer'), true);
        assert.equal(insightsEnabled('answer'), false);
        assert.equal(answerEnabled('insights'), false);
        assert.equal(insightsEnabled('insights'), true);
    });

    it('treat an invalid mode as both (both lanes on)', () => {
        for (const value of INVALID) {
            assert.equal(answerEnabled(value), true, `answer for ${JSON.stringify(value)}`);
            assert.equal(insightsEnabled(value), true, `insights for ${JSON.stringify(value)}`);
        }
    });
});

describe('nextLiveFeatures', () => {
    it('cycles both -> answer -> insights -> both', () => {
        assert.equal(nextLiveFeatures('both'), 'answer');
        assert.equal(nextLiveFeatures('answer'), 'insights');
        assert.equal(nextLiveFeatures('insights'), 'both');
    });

    it('moves an invalid mode on as if it were both', () => {
        for (const value of INVALID) {
            assert.equal(nextLiveFeatures(value), 'answer', `value ${JSON.stringify(value)}`);
        }
    });
});

describe('liveFeaturesState', () => {
    it('returns the normalized mode and both flags', () => {
        assert.deepEqual(liveFeaturesState('both'), { mode: 'both', answer: true, insights: true });
        assert.deepEqual(liveFeaturesState('answer'), { mode: 'answer', answer: true, insights: false });
        assert.deepEqual(liveFeaturesState('insights'), { mode: 'insights', answer: false, insights: true });
        assert.deepEqual(liveFeaturesState(7), { mode: 'both', answer: true, insights: true });
        assert.deepEqual(liveFeaturesState(undefined), { mode: 'both', answer: true, insights: true });
    });

    it('never turns both lanes off', () => {
        for (const value of [...LIVE_FEATURES, ...INVALID]) {
            const state = liveFeaturesState(value);
            assert.ok(state.answer || state.insights, `value ${JSON.stringify(value)}`);
        }
    });
});

describe('liveFeaturesLabel', () => {
    it('names each mode for the Settings button', () => {
        assert.equal(liveFeaturesLabel('both'), 'Answer + Insights');
        assert.equal(liveFeaturesLabel('answer'), 'Answer only');
        assert.equal(liveFeaturesLabel('insights'), 'Insights only');
    });

    it('labels an invalid mode as both', () => {
        for (const value of INVALID) {
            assert.equal(liveFeaturesLabel(value), 'Answer + Insights', `value ${JSON.stringify(value)}`);
        }
    });
});

describe('viewLabels', () => {
    const INSIGHTS = { title: 'Live insights', showButton: 'Show Insights', copyHover: 'Copy Glass Analysis' };

    it('uses the answer labels only in answer mode', () => {
        assert.deepEqual(viewLabels('answer'), { title: 'Live answer', showButton: 'Show Answer', copyHover: 'Copy Glass Answer' });
        assert.deepEqual(viewLabels('both'), INSIGHTS);
        assert.deepEqual(viewLabels('insights'), INSIGHTS);
        assert.deepEqual(viewLabels(null), INSIGHTS);
    });

    it('returns a new object each call, so a caller cannot change the table', () => {
        const first = viewLabels('answer');
        assert.notEqual(viewLabels('answer'), first);
        first.title = 'changed';
        assert.equal(viewLabels('answer').title, 'Live answer');
    });
});

describe('module', () => {
    it('loads no other module', () => {
        delete require.cache[MODULE_PATH];
        const before = new Set(Object.keys(require.cache));
        require(MODULE_PATH);
        const added = Object.keys(require.cache).filter(key => !before.has(key));
        assert.deepEqual(added, [MODULE_PATH]);
    });
});

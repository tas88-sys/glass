/**
 * focusRestoreDecision.test.js
 *
 * Unit tests for the pure focus-restore decision helper.
 * Run: node --test src/ui/ask/__tests__/focusRestoreDecision.test.js
 *
 * Pure logic, no DOM/Electron coupling.
 * Contract: specs/2026-06-08-cursor-visibility-toggle/contracts/focusRestoreDecision.d.ts
 * Encodes FR-004 no-steal guard: hide-induced blur PRESERVES snapshot; genuine blur CLEARS.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { onBlur, shouldRestoreOnVisible } = require('../focusRestoreDecision');

// Stub snapshot factory — returns a fixed snapshot without touching the DOM.
const STUB_SNAPSHOT = { start: 3, end: 7 };
const stubFactory = () => STUB_SNAPSHOT;

describe('onBlur', () => {
    it('PRESERVE: documentHidden=true + isInputFocused=true -> captures snapshot, keeps isInputFocused=true', () => {
        const result = onBlur(true, true, stubFactory);
        assert.deepEqual(result.snapshot, STUB_SNAPSHOT, 'snapshot should be the factory result');
        assert.equal(result.isInputFocused, true, 'isInputFocused should remain true (hide-induced)');
    });

    it('CLEAR: documentHidden=false -> clears snapshot, sets isInputFocused=false (genuine blur)', () => {
        const result = onBlur(false, true, stubFactory);
        assert.equal(result.snapshot, null, 'snapshot should be null on genuine blur');
        assert.equal(result.isInputFocused, false, 'isInputFocused should be false on genuine blur');
    });

    it('CLEAR: documentHidden=true but isInputFocused=false -> clears (input was not focused at hide)', () => {
        const result = onBlur(true, false, stubFactory);
        assert.equal(result.snapshot, null, 'no snapshot when input was not focused');
        assert.equal(result.isInputFocused, false, 'isInputFocused remains false');
    });

    it('CLEAR: documentHidden=false + isInputFocused=false -> clears', () => {
        const result = onBlur(false, false, stubFactory);
        assert.equal(result.snapshot, null);
        assert.equal(result.isInputFocused, false);
    });

    it('uses the snapshotFactory result as the preserved snapshot (not a hardcoded value)', () => {
        const custom = { start: 0, end: 0 };
        const result = onBlur(true, true, () => custom);
        assert.equal(result.snapshot, custom, 'snapshot should come from the factory');
    });

    it('does not call the snapshotFactory when result is CLEAR', () => {
        let called = false;
        const trackingFactory = () => { called = true; return STUB_SNAPSHOT; };
        onBlur(false, true, trackingFactory);
        assert.equal(called, false, 'factory should not be called on genuine blur');
    });
});

describe('shouldRestoreOnVisible', () => {
    it('returns true when snapshot is non-null', () => {
        assert.equal(shouldRestoreOnVisible({ start: 3, end: 7 }), true);
    });

    it('returns true for a collapsed caret snapshot {start:0, end:0}', () => {
        assert.equal(shouldRestoreOnVisible({ start: 0, end: 0 }), true);
    });

    it('returns false when snapshot is null (FR-004: no focus steal)', () => {
        assert.equal(shouldRestoreOnVisible(null), false);
    });

    it('returns false when snapshot is undefined', () => {
        assert.equal(shouldRestoreOnVisible(undefined), false);
    });
});

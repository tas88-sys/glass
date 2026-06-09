/**
 * changeAllWindowsVisibility.show-focus.test.js
 *
 * Main-process stub test for the windowManager show-branch focus behavior.
 * Run: node --test src/window/__tests__/changeAllWindowsVisibility.show-focus.test.js
 *
 * Contract: specs/2026-06-08-cursor-visibility-toggle/contracts/windowManager.show-focus.md
 * Tests FR-003 (ask window gets OS focus on show), FR-004 edge (no focus when ask absent),
 * FR-005 (no setIgnoreMouseEvents/setAlwaysOnTop side-effects), and crash-safe guard.
 *
 * Strategy: stub windowPool (Map) with mock BrowserWindows exposing spy counters.
 * lastVisibleWindows is module-level and NOT exported — seed it via the hide branch:
 *   call changeAllWindowsVisibility(pool, false) first, THEN changeAllWindowsVisibility(pool, true).
 * Uses require-cache injection to stub 'electron' and transitive deps before loading windowManager.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simple call counter for spy functions. */
function makeSpy() {
    const spy = function (...args) { spy.calls.push(args); };
    spy.calls = [];
    spy.callCount = () => spy.calls.length;
    spy.reset = () => { spy.calls = []; };
    return spy;
}

/** Build a mock BrowserWindow spy object. */
function makeMockWin({ visible = true, destroyed = false } = {}) {
    let _visible = visible;
    let _destroyed = destroyed;
    return {
        isVisible: () => _visible,
        setVisible: (v) => { _visible = v; },
        isDestroyed: () => _destroyed,
        setDestroyed: (v) => { _destroyed = v; },
        show: makeSpy(),
        hide: makeSpy(),
        focus: makeSpy(),
        moveTop: makeSpy(),
        setIgnoreMouseEvents: makeSpy(),
        setAlwaysOnTop: makeSpy(),
        on: makeSpy(),
        once: makeSpy(),
        webContents: { on: makeSpy(), send: makeSpy() },
    };
}

// ---------------------------------------------------------------------------
// Inject stubs into require cache before loading windowManager
// ---------------------------------------------------------------------------

// Stub 'electron' — changeAllWindowsVisibility only needs windowPool and module-level state
require.cache['electron'] = {
    id: 'electron',
    filename: 'electron',
    loaded: true,
    exports: {
        BrowserWindow: class BrowserWindow {
            constructor() { return makeMockWin(); }
            static fromId() { return null; }
        },
        globalShortcut: { register: () => true, unregisterAll: () => {} },
        screen: {
            getPrimaryDisplay: () => ({
                workAreaSize: { width: 1920, height: 1080 },
                workArea: { x: 0, y: 0, width: 1920, height: 1080 },
                bounds: { x: 0, y: 0, width: 1920, height: 1080 },
            }),
            getDisplayNearestPoint: () => ({
                workAreaSize: { width: 1920, height: 1080 },
                workArea: { x: 0, y: 0, width: 1920, height: 1080 },
                bounds: { x: 0, y: 0, width: 1920, height: 1080 },
            }),
            on: () => {},
        },
        app: {
            getPath: () => '/tmp',
            on: () => {},
            whenReady: () => Promise.resolve(),
            isReady: () => true,
            getVersion: () => '0.0.0',
        },
        shell: { openExternal: () => {} },
        ipcMain: { on: () => {}, handle: () => {}, emit: () => {} },
        dialog: { showMessageBox: () => {} },
        powerMonitor: { on: () => {} },
        nativeImage: { createEmpty: () => ({}) },
    },
};

// Stub transitive requires
// __dirname = src/window/__tests__ ; windowManager lives in src/window/
const WIN_DIR = path.resolve(__dirname, '..');
const SRC_DIR = path.resolve(__dirname, '../..');

const stubEventEmitter = { on: () => {}, off: () => {}, emit: () => {}, once: () => {} };

const shortcutsPath = require.resolve(path.join(SRC_DIR, 'features/shortcuts/shortcutsService'));
require.cache[shortcutsPath] = {
    id: shortcutsPath, filename: shortcutsPath, loaded: true,
    exports: Object.assign(Object.create(stubEventEmitter), {
        getShortcutConfig: () => ({}),
        registerShortcut: () => {},
    }),
};

const bridgePath = require.resolve(path.join(SRC_DIR, 'bridge/internalBridge'));
require.cache[bridgePath] = {
    id: bridgePath, filename: bridgePath, loaded: true,
    exports: stubEventEmitter,
};

const permissionPath = require.resolve(path.join(SRC_DIR, 'features/common/repositories/permission'));
require.cache[permissionPath] = {
    id: permissionPath, filename: permissionPath, loaded: true,
    exports: { getAll: async () => [], get: async () => null },
};

const layoutPath = require.resolve(path.join(WIN_DIR, 'windowLayoutManager'));
require.cache[layoutPath] = {
    id: layoutPath, filename: layoutPath, loaded: true,
    exports: class WindowLayoutManager {
        calculateLayout() { return {}; }
        on() {} off() {}
    },
};

const smoothPath = require.resolve(path.join(WIN_DIR, 'smoothMovementManager'));
require.cache[smoothPath] = {
    id: smoothPath, filename: smoothPath, loaded: true,
    exports: class SmoothMovementManager {
        on() {} off() {} start() {} stop() {}
    },
};

// Now require windowManager — will use stubs above for all transitive deps
const wmPath = require.resolve(path.join(WIN_DIR, 'windowManager'));
const wmModule = require(wmPath);

// changeAllWindowsVisibility is NOT yet exported (T007 adds it) -> will be undefined -> Red
const { changeAllWindowsVisibility } = wmModule;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('changeAllWindowsVisibility — show-branch focus', () => {

    it('Case 1: ask + header both visible before hide -> askWin.focus() and askWin.moveTop() called exactly once on show', () => {
        assert.ok(
            typeof changeAllWindowsVisibility === 'function',
            'changeAllWindowsVisibility must be exported from windowManager.js (add in T007)'
        );

        const header = makeMockWin({ visible: true });
        const ask = makeMockWin({ visible: true });
        const pool = new Map([['header', header], ['ask', ask]]);

        // Hide branch: seeds lastVisibleWindows = {header, ask}
        changeAllWindowsVisibility(pool, false);

        // Windows are now hidden
        header.setVisible(false);
        ask.setVisible(false);
        // Reset spy counts so we only measure the show branch
        header.focus.reset(); ask.focus.reset();
        header.moveTop.reset(); ask.moveTop.reset();
        ask.setIgnoreMouseEvents.reset(); ask.setAlwaysOnTop.reset();
        header.setIgnoreMouseEvents.reset(); header.setAlwaysOnTop.reset();

        // Show branch: should call ask.focus() and ask.moveTop()
        changeAllWindowsVisibility(pool, true);

        assert.equal(ask.focus.callCount(), 1, 'ask.focus() should be called exactly once');
        assert.equal(ask.moveTop.callCount(), 1, 'ask.moveTop() should be called exactly once');

        // FR-005: NO setIgnoreMouseEvents or setAlwaysOnTop on ANY window
        assert.equal(ask.setIgnoreMouseEvents.callCount(), 0, 'ask.setIgnoreMouseEvents must NOT be called (FR-005)');
        assert.equal(ask.setAlwaysOnTop.callCount(), 0, 'ask.setAlwaysOnTop must NOT be called (FR-005)');
        assert.equal(header.setIgnoreMouseEvents.callCount(), 0, 'header.setIgnoreMouseEvents must NOT be called (FR-005)');
        assert.equal(header.setAlwaysOnTop.callCount(), 0, 'header.setAlwaysOnTop must NOT be called (FR-005)');
    });

    it('Case 2: only header visible before hide (ask absent) -> no focus/moveTop called on show', () => {
        assert.ok(
            typeof changeAllWindowsVisibility === 'function',
            'changeAllWindowsVisibility must be exported from windowManager.js (add in T007)'
        );

        const header = makeMockWin({ visible: true });
        // ask is NOT in the pool (not visible at hide time)
        const pool = new Map([['header', header]]);

        // Hide branch: seeds lastVisibleWindows = {header} only
        changeAllWindowsVisibility(pool, false);
        header.setVisible(false);

        // Show branch
        changeAllWindowsVisibility(pool, true);

        // No ask in lastVisibleWindows -> no focus/moveTop
        assert.equal(header.focus.callCount(), 0, 'header.focus should not be called');
        assert.equal(header.moveTop.callCount(), 0, 'header.moveTop should not be called');
    });

    it('Case 3: ask.isDestroyed() === true at show time -> no throw, no focus call', () => {
        assert.ok(
            typeof changeAllWindowsVisibility === 'function',
            'changeAllWindowsVisibility must be exported from windowManager.js (add in T007)'
        );

        const header = makeMockWin({ visible: true });
        const ask = makeMockWin({ visible: true });
        const pool = new Map([['header', header], ['ask', ask]]);

        // Hide branch: seeds lastVisibleWindows = {header, ask}
        changeAllWindowsVisibility(pool, false);
        header.setVisible(false);
        ask.setVisible(false);

        // Mark ask as destroyed before show
        ask.setDestroyed(true);
        ask.focus.reset();
        ask.moveTop.reset();

        // Show branch: must NOT throw, must NOT call focus on destroyed window
        assert.doesNotThrow(() => changeAllWindowsVisibility(pool, true));
        assert.equal(ask.focus.callCount(), 0, 'focus must not be called on a destroyed window');
        assert.equal(ask.moveTop.callCount(), 0, 'moveTop must not be called on a destroyed window');
    });
});

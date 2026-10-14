/**
 * modelStateService.routerKey.test.js
 *
 * The career router's TypeSafe key in Settings (spec 2026-10-13-career-router-jev):
 * it is saved like a provider key (provider 'typesafe'), checked by one
 * minimal Jev call, and alone it does not count as an AI key. The
 * repositories, auth, electron-store and the Jev client are faked.
 * Run: node --test src/features/common/services/__tests__/modelStateService.routerKey.test.js
 */

'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const rows = new Map();
const providerSettings = {
    getAll: async () => [...rows.values()].map(r => ({ ...r })),
    getByProvider: async p => (rows.has(p) ? { ...rows.get(p) } : null),
    upsert: async (p, s) => { rows.set(p, { ...(rows.get(p) || {}), ...s, provider: p }); },
    getRawApiKeys: async () => [...rows.values()].map(r => ({ api_key: r.api_key })),
    setActiveProvider: async () => {},
    getActiveProvider: async () => null,
    getActiveSettings: async () => ({ llm: null, stt: null }),
};
const jevChecks = [];
let jevResult = { success: true };

const originalLoad = Module._load;
Module._load = function (request) {
    if (request === 'electron-store') return class { get() {} set() {} delete() {} };
    if (request === '../repositories/providerSettings') return providerSettings;
    if (request === '../repositories/modelCatalog') return { getAll: () => [], upsert: () => {} };
    if (request === '../repositories/ollamaModel') return { getInstalledModels: () => [] };
    if (request === './authService') return { getCurrentUserId: () => 'default_user', getCurrentUser: () => ({ isLoggedIn: false }) };
    if (request === './encryptionService') return { looksEncrypted: () => false, initializeKey: async () => {} };
    if (request === '../career/jevClient') return { validateKey: async args => { jevChecks.push(args); return jevResult; } };
    return originalLoad.apply(this, arguments);
};

const service = require('../modelStateService');

beforeEach(() => {
    rows.clear();
    jevChecks.length = 0;
    jevResult = { success: true };
    service.removeAllListeners();
});

describe('TypeSafe key in Settings', () => {
    it('Save checks the key with Jev, stores it under typesafe and tells the app', async () => {
        let updated = 0;
        service.on('settings-updated', () => { updated++; });
        const r = await service.setApiKey('typesafe', 'ts-key-1');
        assert.deepEqual(r, { success: true });
        assert.deepEqual(jevChecks, [{ apiKey: 'ts-key-1' }]);
        assert.equal(rows.get('typesafe').api_key, 'ts-key-1');
        assert.equal((await service.getAllApiKeys()).typesafe, 'ts-key-1');
        assert.equal(updated, 1, 'the router key cache refreshes on settings-updated');
    });

    it('a key TypeSafe rejects is not saved', async () => {
        jevResult = { success: false, error: 'TypeSafe rejected the key (401).' };
        const r = await service.setApiKey('typesafe', 'bad');
        assert.equal(r.success, false);
        assert.match(r.error, /401/);
        assert.equal(rows.has('typesafe'), false);
    });

    it('a key that could not be checked is saved', async () => {
        jevResult = { success: true, unverified: 'net' };
        const r = await service.setApiKey('typesafe', 'ts-key-2');
        assert.equal(r.success, true);
        assert.equal(rows.get('typesafe').api_key, 'ts-key-2');
    });

    it('an empty key is refused before any call', async () => {
        const r = await service.setApiKey('typesafe', '   ');
        assert.equal(r.success, false);
        assert.equal(jevChecks.length, 0);
    });

    it('Clear removes it and tells the app', async () => {
        rows.set('typesafe', { provider: 'typesafe', api_key: 'ts-key-1' });
        let updated = 0;
        service.on('settings-updated', () => { updated++; });
        assert.equal(await service.removeApiKey('typesafe'), true);
        assert.equal((await service.getAllApiKeys()).typesafe, null);
        assert.equal(updated, 1);
    });

    it('alone it is not an AI key: the API key screen still shows', async () => {
        rows.set('typesafe', { provider: 'typesafe', api_key: 'ts-key-1' });
        assert.equal(await service.hasValidApiKey(), false);
        assert.equal(await service.areProvidersConfigured(), false);
        rows.set('groq', { provider: 'groq', api_key: 'gsk' });
        assert.equal(await service.hasValidApiKey(), true);
    });

    it('it offers no models and is not a provider in the config', async () => {
        rows.set('typesafe', { provider: 'typesafe', api_key: 'ts-key-1' });
        assert.deepEqual(await service.getAvailableModels('llm'), []);
        assert.deepEqual(await service.getAvailableModels('stt'), []);
        assert.equal('typesafe' in service.getProviderConfig(), false);
    });
});

const firebaseRepository = require('./firebase.repository');
const sqliteRepository = require('./sqlite.repository');

let authService = null;

function setAuthService(service) {
    authService = service;
}

function getBaseRepository() {
    if (!authService) {
        throw new Error('AuthService not set for providerSettings repository');
    }
    
    const user = authService.getCurrentUser();
    return user.isLoggedIn ? firebaseRepository : sqliteRepository;
}

const providerSettingsRepositoryAdapter = {
    // Core CRUD operations
    async getByProvider(provider) {
        const repo = getBaseRepository();
        const uid = authService.getCurrentUserId();
        return await repo.getByProvider(uid, provider);
    },

    async getAllByUid() {
        const repo = getBaseRepository();
        const uid = authService.getCurrentUserId();
        return await repo.getAllByUid(uid);
    },

    async upsert(provider, settings) {
        const repo = getBaseRepository();
        const uid = authService.getCurrentUserId();
        const now = Date.now();
        
        const settingsWithMeta = {
            ...settings,
            uid,
            provider,
            updated_at: now,
            created_at: settings.created_at || now
        };
        
        return await repo.upsert(uid, provider, settingsWithMeta);
    },

    async remove(provider) {
        const repo = getBaseRepository();
        const uid = authService.getCurrentUserId();
        return await repo.remove(uid, provider);
    },

    async removeAllByUid() {
        const repo = getBaseRepository();
        const uid = authService.getCurrentUserId();
        return await repo.removeAllByUid(uid);
    },

    async getRawApiKeysByUid() {
        // This function should always target the local sqlite DB,
        // as it's part of the local-first boot sequence.
        const uid = authService.getCurrentUserId();
        return await sqliteRepository.getRawApiKeysByUid(uid);
    }
};

module.exports = {
    ...providerSettingsRepositoryAdapter,
    setAuthService
}; 
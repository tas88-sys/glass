const sqliteRepository = require('./sqlite.repository');
const firebaseRepository = require('./firebase.repository');
const authService = require('../../services/authService');

function getBaseRepository() {
    const user = authService.getCurrentUser();
    if (user && user.isLoggedIn) {
        return firebaseRepository;
    }
    return sqliteRepository;
}

const userRepositoryAdapter = {
    findOrCreate: (user) => {
        // This function receives the full user object, which includes the uid. No need to inject.
        return getBaseRepository().findOrCreate(user);
    },
    
    getById: () => {
        const uid = authService.getCurrentUserId();
        return getBaseRepository().getById(uid);
    },

    saveApiKey: (apiKey, provider) => {
        const uid = authService.getCurrentUserId();
        return getBaseRepository().saveApiKey(uid, apiKey, provider);
    },

    update: (updateData) => {
        const uid = authService.getCurrentUserId();
        return getBaseRepository().update({ uid, ...updateData });
    },

    deleteById: () => {
        const uid = authService.getCurrentUserId();
        return getBaseRepository().deleteById(uid);
    }
};

module.exports = userRepositoryAdapter; 
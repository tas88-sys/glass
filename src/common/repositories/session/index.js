const sqliteRepository = require('./sqlite.repository');
const firebaseRepository = require('./firebase.repository');
const authService = require('../../../common/services/authService');

function getBaseRepository() {
    const user = authService.getCurrentUser();
    if (user && user.isLoggedIn) {
        return firebaseRepository;
    }
    return sqliteRepository;
}

// The adapter layer that injects the UID
const sessionRepositoryAdapter = {
    getById: (id) => getBaseRepository().getById(id),
    
    create: (type = 'ask') => {
        const uid = authService.getCurrentUserId();
        return getBaseRepository().create(uid, type);
    },
    
    getAllByUserId: () => {
        const uid = authService.getCurrentUserId();
        return getBaseRepository().getAllByUserId(uid);
    },

    updateTitle: (id, title) => getBaseRepository().updateTitle(id, title),
    
    deleteWithRelatedData: (id) => getBaseRepository().deleteWithRelatedData(id),

    end: (id) => getBaseRepository().end(id),

    updateType: (id, type) => getBaseRepository().updateType(id, type),

    touch: (id) => getBaseRepository().touch(id),

    getOrCreateActive: (requestedType = 'ask') => {
        const uid = authService.getCurrentUserId();
        return getBaseRepository().getOrCreateActive(uid, requestedType);
    },

    endAllActiveSessions: () => {
        const uid = authService.getCurrentUserId();
        return getBaseRepository().endAllActiveSessions(uid);
    },
};

module.exports = sessionRepositoryAdapter; 
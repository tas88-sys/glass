const { collection, doc, getDoc, getDocs, setDoc, deleteDoc, query, where } = require('firebase/firestore');
const { getFirestoreInstance: getFirestore } = require('../../services/firebaseClient');
const { createEncryptedConverter } = require('../firestoreConverter');

// Create encrypted converter for provider settings
const providerSettingsConverter = createEncryptedConverter([
    'api_key', // Encrypt API keys
    'selected_llm_model', // Encrypt model selections for privacy
    'selected_stt_model'
]);

function providerSettingsCol() {
    const db = getFirestore();
    return collection(db, 'provider_settings').withConverter(providerSettingsConverter);
}

async function getByProvider(uid, provider) {
    try {
        const docRef = doc(providerSettingsCol(), `${uid}_${provider}`);
        const docSnap = await getDoc(docRef);
        return docSnap.exists() ? { id: docSnap.id, ...docSnap.data() } : null;
    } catch (error) {
        console.error('[ProviderSettings Firebase] Error getting provider settings:', error);
        return null;
    }
}

async function getAllByUid(uid) {
    try {
        const q = query(providerSettingsCol(), where('uid', '==', uid));
        const querySnapshot = await getDocs(q);
        return querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (error) {
        console.error('[ProviderSettings Firebase] Error getting all provider settings:', error);
        return [];
    }
}

async function upsert(uid, provider, settings) {
    try {
        const docRef = doc(providerSettingsCol(), `${uid}_${provider}`);
        await setDoc(docRef, settings, { merge: true });
        return { changes: 1 };
    } catch (error) {
        console.error('[ProviderSettings Firebase] Error upserting provider settings:', error);
        throw error;
    }
}

async function remove(uid, provider) {
    try {
        const docRef = doc(providerSettingsCol(), `${uid}_${provider}`);
        await deleteDoc(docRef);
        return { changes: 1 };
    } catch (error) {
        console.error('[ProviderSettings Firebase] Error removing provider settings:', error);
        throw error;
    }
}

async function removeAllByUid(uid) {
    try {
        const settings = await getAllByUid(uid);
        const deletePromises = settings.map(setting => {
            const docRef = doc(providerSettingsCol(), setting.id);
            return deleteDoc(docRef);
        });
        
        await Promise.all(deletePromises);
        return { changes: settings.length };
    } catch (error) {
        console.error('[ProviderSettings Firebase] Error removing all provider settings:', error);
        throw error;
    }
}

// Get active provider for a specific type (llm or stt)
async function getActiveProvider(uid, type) {
    try {
        const column = type === 'llm' ? 'is_active_llm' : 'is_active_stt';
        const q = query(providerSettingsCol(), 
            where('uid', '==', uid),
            where(column, '==', true)
        );
        const querySnapshot = await getDocs(q);
        
        if (querySnapshot.empty) {
            return null;
        }
        
        const doc = querySnapshot.docs[0];
        return { id: doc.id, ...doc.data() };
    } catch (error) {
        console.error('[ProviderSettings Firebase] Error getting active provider:', error);
        return null;
    }
}

// Set active provider for a specific type
async function setActiveProvider(uid, provider, type) {
    try {
        const column = type === 'llm' ? 'is_active_llm' : 'is_active_stt';
        
        // First, deactivate all providers for this type
        const allSettings = await getAllByUid(uid);
        const updatePromises = allSettings.map(setting => {
            const docRef = doc(providerSettingsCol(), setting.id);
            return setDoc(docRef, { [column]: false }, { merge: true });
        });
        await Promise.all(updatePromises);
        
        // Then activate the specified provider
        if (provider) {
            const docRef = doc(providerSettingsCol(), `${uid}_${provider}`);
            await setDoc(docRef, { [column]: true }, { merge: true });
        }
        
        return { success: true };
    } catch (error) {
        console.error('[ProviderSettings Firebase] Error setting active provider:', error);
        throw error;
    }
}

// Get all active settings (both llm and stt)
async function getActiveSettings(uid) {
    try {
        // Firebase doesn't support OR queries in this way, so we'll get all settings and filter
        const allSettings = await getAllByUid(uid);
        
        const activeSettings = {
            llm: null,
            stt: null
        };
        
        allSettings.forEach(setting => {
            if (setting.is_active_llm) {
                activeSettings.llm = setting;
            }
            if (setting.is_active_stt) {
                activeSettings.stt = setting;
            }
        });
        
        return activeSettings;
    } catch (error) {
        console.error('[ProviderSettings Firebase] Error getting active settings:', error);
        return { llm: null, stt: null };
    }
}

module.exports = {
    getByProvider,
    getAllByUid,
    upsert,
    remove,
    removeAllByUid,
    getActiveProvider,
    setActiveProvider,
    getActiveSettings
}; 
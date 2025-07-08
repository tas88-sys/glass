const { getFirestore, collection, doc, addDoc, getDoc, getDocs, updateDoc, deleteDoc, query, where, orderBy } = require('firebase/firestore');
const { createEncryptedConverter } = require('../../../common/repositories/firestoreConverter');

const userPresetConverter = createEncryptedConverter(['prompt']);

const defaultPresetConverter = {
    toFirestore: (data) => data,
    fromFirestore: (snapshot, options) => {
        const data = snapshot.data(options);
        return { ...data, id: snapshot.id };
    }
};

function userPresetsCol() {
    const db = getFirestore();
    return collection(db, 'prompt_presets').withConverter(userPresetConverter);
}

function defaultPresetsCol() {
    const db = getFirestore();
    return collection(db, 'defaults/prompt_presets').withConverter(defaultPresetConverter);
}

async function getPresets(uid) {
    const userPresetsQuery = query(userPresetsCol(), where('uid', '==', uid));
    const defaultPresetsQuery = query(defaultPresetsCol());

    const [userSnapshot, defaultSnapshot] = await Promise.all([
        getDocs(userPresetsQuery),
        getDocs(defaultPresetsQuery)
    ]);

    const presets = [
        ...defaultSnapshot.docs.map(d => d.data()),
        ...userSnapshot.docs.map(d => d.data())
    ];

    return presets.sort((a, b) => {
        if (a.is_default && !b.is_default) return -1;
        if (!a.is_default && b.is_default) return 1;
        return a.title.localeCompare(b.title);
    });
}

async function getPresetTemplates() {
    const q = query(defaultPresetsCol(), orderBy('title', 'asc'));
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => doc.data());
}

async function createPreset({ uid, title, prompt }) {
    const now = Math.floor(Date.now() / 1000);
    const newPreset = {
        uid: uid,
        title,
        prompt,
        is_default: false,
        created_at: now,
    };
    const docRef = await addDoc(userPresetsCol(), newPreset);
    return { id: docRef.id };
}

async function updatePreset(id, { title, prompt }, uid) {
    const docRef = doc(userPresetsCol(), id);
    const docSnap = await getDoc(docRef);

    if (!docSnap.exists() || docSnap.data().uid !== uid || docSnap.data().is_default) {
        throw new Error("Preset not found or permission denied to update.");
    }
    
    await updateDoc(docRef, { title, prompt });
    return { changes: 1 };
}

async function deletePreset(id, uid) {
    const docRef = doc(userPresetsCol(), id);
    const docSnap = await getDoc(docRef);

    if (!docSnap.exists() || docSnap.data().uid !== uid || docSnap.data().is_default) {
        throw new Error("Preset not found or permission denied to delete.");
    }

    await deleteDoc(docRef);
    return { changes: 1 };
}

module.exports = {
    getPresets,
    getPresetTemplates,
    createPreset,
    updatePreset,
    deletePreset,
}; 
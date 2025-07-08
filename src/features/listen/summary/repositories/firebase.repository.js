const { getFirestore, collection, doc, setDoc, getDoc } = require('firebase/firestore');
const { createEncryptedConverter } = require('../../../../common/repositories/firestoreConverter');

const fieldsToEncrypt = ['tldr', 'text', 'bullet_json', 'action_json'];
const summaryConverter = createEncryptedConverter(fieldsToEncrypt);

function summaryDocRef(sessionId) {
    if (!sessionId) throw new Error("Session ID is required to access summary.");
    const db = getFirestore();
    const path = `sessions/${sessionId}/summary`;
    return doc(collection(db, path).withConverter(summaryConverter), 'data');
}

async function saveSummary({ uid, sessionId, tldr, text, bullet_json, action_json, model = 'unknown' }) {
    const now = Math.floor(Date.now() / 1000);
    const summaryData = {
        uid, // To know who generated the summary
        generated_at: now,
        model,
        text,
        tldr,
        bullet_json,
        action_json,
        updated_at: now,
    };
    
    const docRef = summaryDocRef(sessionId);
    await setDoc(docRef, summaryData, { merge: true });

    return { changes: 1 };
}

async function getSummaryBySessionId(sessionId) {
    const docRef = summaryDocRef(sessionId);
    const docSnap = await getDoc(docRef);
    return docSnap.exists() ? docSnap.data() : null;
}

module.exports = {
    saveSummary,
    getSummaryBySessionId,
}; 
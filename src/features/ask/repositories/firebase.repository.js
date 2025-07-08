const { getFirestore, collection, addDoc, query, getDocs, orderBy } = require('firebase/firestore');
const { createEncryptedConverter } = require('../../../common/repositories/firestoreConverter');

const aiMessageConverter = createEncryptedConverter(['content']);

function aiMessagesCol(sessionId) {
    if (!sessionId) throw new Error("Session ID is required to access AI messages.");
    const db = getFirestore();
    return collection(db, `sessions/${sessionId}/ai_messages`).withConverter(aiMessageConverter);
}

async function addAiMessage({ uid, sessionId, role, content, model = 'unknown' }) {
    const now = Math.floor(Date.now() / 1000);
    const newMessage = {
        uid, // To identify the author of the message
        session_id: sessionId,
        sent_at: now,
        role,
        content,
        model,
        created_at: now,
    };
    
    const docRef = await addDoc(aiMessagesCol(sessionId), newMessage);
    return { id: docRef.id };
}

async function getAllAiMessagesBySessionId(sessionId) {
    const q = query(aiMessagesCol(sessionId), orderBy('sent_at', 'asc'));
    const querySnapshot = await getDocs(q);
    return querySnapshot.docs.map(doc => doc.data());
}

module.exports = {
    addAiMessage,
    getAllAiMessagesBySessionId,
}; 
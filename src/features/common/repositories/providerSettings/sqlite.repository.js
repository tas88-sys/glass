const sqliteClient = require('../../services/sqliteClient');
const encryptionService = require('../../services/encryptionService');

function getByProvider(uid, provider) {
    const db = sqliteClient.getDb();
    const stmt = db.prepare('SELECT * FROM provider_settings WHERE uid = ? AND provider = ?');
    const result = stmt.get(uid, provider) || null;
    
    if (result && result.api_key) {
        // Decrypt API key if it exists
        result.api_key = encryptionService.decrypt(result.api_key);
    }
    
    return result;
}

function getAllByUid(uid) {
    const db = sqliteClient.getDb();
    const stmt = db.prepare('SELECT * FROM provider_settings WHERE uid = ? ORDER BY provider');
    const results = stmt.all(uid);
    
    // Decrypt API keys for all results
    return results.map(result => {
        if (result.api_key) {
            result.api_key = encryptionService.decrypt(result.api_key);
        }
        return result;
    });
}

function upsert(uid, provider, settings) {
    const db = sqliteClient.getDb();
    
    // Encrypt API key if it exists
    const encryptedSettings = { ...settings };
    if (encryptedSettings.api_key) {
        encryptedSettings.api_key = encryptionService.encrypt(encryptedSettings.api_key);
    }
    
    // Use SQLite's UPSERT syntax (INSERT ... ON CONFLICT ... DO UPDATE)
    const stmt = db.prepare(`
        INSERT INTO provider_settings (uid, provider, api_key, selected_llm_model, selected_stt_model, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(uid, provider) DO UPDATE SET
            api_key = excluded.api_key,
            selected_llm_model = excluded.selected_llm_model,
            selected_stt_model = excluded.selected_stt_model,
            updated_at = excluded.updated_at
    `);
    
    const result = stmt.run(
        uid,
        provider,
        encryptedSettings.api_key || null,
        encryptedSettings.selected_llm_model || null,
        encryptedSettings.selected_stt_model || null,
        encryptedSettings.created_at || Date.now(),
        encryptedSettings.updated_at
    );
    
    return { changes: result.changes };
}

function remove(uid, provider) {
    const db = sqliteClient.getDb();
    const stmt = db.prepare('DELETE FROM provider_settings WHERE uid = ? AND provider = ?');
    const result = stmt.run(uid, provider);
    return { changes: result.changes };
}

function removeAllByUid(uid) {
    const db = sqliteClient.getDb();
    const stmt = db.prepare('DELETE FROM provider_settings WHERE uid = ?');
    const result = stmt.run(uid);
    return { changes: result.changes };
}

module.exports = {
    getByProvider,
    getAllByUid,
    upsert,
    remove,
    removeAllByUid
}; 
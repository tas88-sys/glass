const sqliteClient = require('../../services/sqliteClient');

function getByProvider(uid, provider) {
    const db = sqliteClient.getDb();
    const stmt = db.prepare('SELECT * FROM provider_settings WHERE uid = ? AND provider = ?');
    const result = stmt.get(uid, provider) || null;
    
    if (result && result.api_key) {
        result.api_key = encryptionService.decrypt(result.api_key);
    }
    
    return result;
}

function getAllByUid(uid) {
    const db = sqliteClient.getDb();
    const stmt = db.prepare('SELECT * FROM provider_settings WHERE uid = ? ORDER BY provider');
    const results = stmt.all(uid);
    
    return results.map(result => {
        if (result.api_key) {
            result.api_key = result.api_key;
        }
        return result;
    });
}

function upsert(uid, provider, settings) {
    // Validate: prevent direct setting of active status
    if (settings.is_active_llm || settings.is_active_stt) {
        console.warn('[ProviderSettings] Warning: is_active_llm/is_active_stt should not be set directly. Use setActiveProvider() instead.');
    }
    
    const db = sqliteClient.getDb();
    
    // Use SQLite's UPSERT syntax (INSERT ... ON CONFLICT ... DO UPDATE)
    const stmt = db.prepare(`
        INSERT INTO provider_settings (uid, provider, api_key, selected_llm_model, selected_stt_model, is_active_llm, is_active_stt, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(uid, provider) DO UPDATE SET
            api_key = excluded.api_key,
            selected_llm_model = excluded.selected_llm_model,
            selected_stt_model = excluded.selected_stt_model,
            -- is_active_llm and is_active_stt are NOT updated here
            -- Use setActiveProvider() to change active status
            updated_at = excluded.updated_at
    `);
    
    const result = stmt.run(
        uid,
        provider,
        settings.api_key || null,
        settings.selected_llm_model || null,
        settings.selected_stt_model || null,
        0, // is_active_llm - always 0, use setActiveProvider to activate
        0, // is_active_stt - always 0, use setActiveProvider to activate
        settings.created_at || Date.now(),
        settings.updated_at
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

function getRawApiKeysByUid(uid) {
    const db = sqliteClient.getDb();
    const stmt = db.prepare('SELECT api_key FROM provider_settings WHERE uid = ?');
    return stmt.all(uid);
}

// Get active provider for a specific type (llm or stt)
function getActiveProvider(uid, type) {
    const db = sqliteClient.getDb();
    const column = type === 'llm' ? 'is_active_llm' : 'is_active_stt';
    const stmt = db.prepare(`SELECT * FROM provider_settings WHERE uid = ? AND ${column} = 1`);
    const result = stmt.get(uid) || null;
    
    if (result && result.api_key) {
        result.api_key = result.api_key;
    }
    
    return result;
}

// Set active provider for a specific type
function setActiveProvider(uid, provider, type) {
    const db = sqliteClient.getDb();
    const column = type === 'llm' ? 'is_active_llm' : 'is_active_stt';
    
    // Start transaction to ensure only one provider is active
    db.transaction(() => {
        // First, deactivate all providers for this type
        const deactivateStmt = db.prepare(`UPDATE provider_settings SET ${column} = 0 WHERE uid = ?`);
        deactivateStmt.run(uid);
        
        // Then activate the specified provider
        if (provider) {
            const activateStmt = db.prepare(`UPDATE provider_settings SET ${column} = 1 WHERE uid = ? AND provider = ?`);
            activateStmt.run(uid, provider);
        }
    })();
    
    return { success: true };
}

// Get all active settings (both llm and stt)
function getActiveSettings(uid) {
    const db = sqliteClient.getDb();
    const stmt = db.prepare(`
        SELECT * FROM provider_settings 
        WHERE uid = ? AND (is_active_llm = 1 OR is_active_stt = 1)
        ORDER BY provider
    `);
    const results = stmt.all(uid);
    
    // Decrypt API keys and organize by type
    const activeSettings = {
        llm: null,
        stt: null
    };
    
    results.forEach(result => {
        if (result.api_key) {
            result.api_key = result.api_key;
        }
        if (result.is_active_llm) {
            activeSettings.llm = result;
        }
        if (result.is_active_stt) {
            activeSettings.stt = result;
        }
    });
    
    return activeSettings;
}

module.exports = {
    getByProvider,
    getAllByUid,
    upsert,
    remove,
    removeAllByUid,
    getRawApiKeysByUid,
    getActiveProvider,
    setActiveProvider,
    getActiveSettings
}; 
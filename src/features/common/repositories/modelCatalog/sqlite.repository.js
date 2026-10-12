/**
 * The model_catalog table (schema.js): one row per provider and model ID.
 * Rows are read whole at startup and written one at a time; modelCatalog.js
 * keeps the copy every request reads.
 */

const COLUMNS = [
    'provider', 'model_id', 'listed', 'vision', 'max_output', 'reasoning', 'effort_levels',
    'thinking', 'server_fallback', 'override_vision', 'override_max_output', 'override_reasoning',
    'key_output_limit', 'key_limit_at', 'fetched_at', 'updated_at',
];

/**
 * @param {function(): object} getDb - a better-sqlite3 (or node:sqlite) database
 */
function createRepository(getDb) {
    function getAll() {
        return getDb().prepare('SELECT * FROM model_catalog ORDER BY provider, model_id').all();
    }

    /** Insert the row, or replace every column of the existing one. */
    function upsert(row) {
        const values = COLUMNS.map((c) => (row[c] === undefined ? null : row[c]));
        const updates = COLUMNS.filter((c) => c !== 'provider' && c !== 'model_id').map((c) => `${c} = excluded.${c}`).join(', ');
        const stmt = getDb().prepare(`
            INSERT INTO model_catalog (${COLUMNS.join(', ')})
            VALUES (${COLUMNS.map(() => '?').join(', ')})
            ON CONFLICT(provider, model_id) DO UPDATE SET ${updates}
        `);
        return { changes: stmt.run(...values).changes };
    }

    function remove(provider, modelId) {
        const stmt = getDb().prepare('DELETE FROM model_catalog WHERE provider = ? AND model_id = ?');
        return { changes: stmt.run(provider, modelId).changes };
    }

    return { getAll, upsert, remove };
}

module.exports = {
    COLUMNS,
    createRepository,
};

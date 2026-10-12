const { createRepository } = require('./sqlite.repository');

// SQLite only, like providerSettings: the catalog describes this machine's keys.
const sqliteRepository = createRepository(() => require('../../services/sqliteClient').getDb());

module.exports = sqliteRepository;

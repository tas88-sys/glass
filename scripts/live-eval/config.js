'use strict';

// Where the live eval gets keys, model lists and settings, in this order:
//   1. command-line flags (--llm-models, --llm-provider, --stt-provider, ...);
//   2. .env (GROQ_API_KEY, GEMINI_API_KEY, ANTHROPIC_API_KEY, DEEPGRAM_API_KEY,
//      OPENAI_COMPATIBLE_BASE_URL + OPENAI_COMPATIBLE_API_KEY, CAREER_KB_PATH,
//      CAREER_KB_COMPANY);
//   3. the app's own data, opened read-only: %APPDATA%\Glass\pickleglass.db
//      (provider_settings, model_catalog) and pickle-glass-settings.json.
// The app's files are never written. Keys never reach the console or a report:
// describe() prints where each value came from, not the value.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// typesafe: the career router's key (Jev), saved in Settings like the others.
// openai-compatible: the base URL; its key, if any, is OPENAI_COMPATIBLE_API_KEY.
const KEY_ENV = { groq: 'GROQ_API_KEY', gemini: 'GEMINI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', deepgram: 'DEEPGRAM_API_KEY', typesafe: 'TYPESAFE_API_KEY', 'openai-compatible': 'OPENAI_COMPATIBLE_BASE_URL' };

/** The value the app saves for a provider from .env: the key, or for the OpenAI-compatible provider "<base URL>\n<key>". */
function envCredential(provider, env) {
    const value = env[KEY_ENV[provider]];
    if (!value) return null;
    return provider === 'openai-compatible' ? `${value.trim()}\n${(env.OPENAI_COMPATIBLE_API_KEY || '').trim()}` : value;
}

function appDataDir() {
    const home = os.homedir();
    const base = process.platform === 'win32' ? process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
        : process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
            : process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    return path.join(base, 'Glass');
}

/** Read-only view of the app DB: provider rows and the saved model catalog, or null. */
function readAppDb(dbPath) {
    if (!fs.existsSync(dbPath)) return { error: 'not found' };
    let Database;
    try {
        Database = require('better-sqlite3');
    } catch (err) {
        return { error: `better-sqlite3 did not load (${err.code || err.message}); run through npm run eval:live` };
    }
    let db;
    try {
        db = new Database(dbPath, { readonly: true, fileMustExist: true });
        const providers = db.prepare('SELECT * FROM provider_settings').all();
        let catalog = [];
        try {
            catalog = db.prepare('SELECT * FROM model_catalog').all();
        } catch {
            /* older DB without the catalog table */
        }
        return { providers, catalog };
    } catch (err) {
        return { error: err.message };
    } finally {
        try {
            db?.close();
        } catch {
            /* ignore */
        }
    }
}

function readAppSettings(file) {
    try {
        const users = JSON.parse(fs.readFileSync(file, 'utf8')).users || {};
        return users.default_user || users.default || Object.values(users)[0] || {};
    } catch {
        return {};
    }
}

/**
 * @param {object} args - parsed flags (run.js)
 * @param {object} [env=process.env]
 */
function loadConfig(args, env = process.env) {
    const dataDir = args.appData || appDataDir();
    const db = args.noAppData ? { error: 'skipped (--no-app-data)' } : readAppDb(path.join(dataDir, 'pickleglass.db'));
    const rows = Object.fromEntries((db.providers || []).map(r => [r.provider, r]));
    const saved = args.noAppData ? {} : readAppSettings(path.join(dataDir, 'pickle-glass-settings.json'));
    const source = {};

    const keys = {};
    for (const provider of Object.keys(KEY_ENV)) {
        const fromEnv = envCredential(provider, env);
        if (fromEnv) {
            keys[provider] = fromEnv;
            source[`${provider} key`] = '.env';
        } else if (rows[provider]?.api_key) {
            keys[provider] = rows[provider].api_key;
            source[`${provider} key`] = 'app DB';
        } else {
            keys[provider] = null;
            source[`${provider} key`] = 'none';
        }
    }

    const activeLlm = Object.values(rows).find(r => r.is_active_llm === 1);
    const llmProvider = args.llmProvider || activeLlm?.provider || null;
    const llmModels = args.llmModels || (llmProvider && rows[llmProvider]?.selected_llm_model) || null;
    source['llm list'] = args.llmModels ? 'flag' : llmModels ? 'app DB' : 'none';

    const activeStt = Object.values(rows).find(r => r.is_active_stt === 1);
    const sttProvider = args.sttProvider || activeStt?.provider || (keys.deepgram ? 'deepgram' : null);
    const sttModel = args.sttModel || (sttProvider && rows[sttProvider]?.selected_stt_model) || (sttProvider === 'deepgram' ? 'nova-3' : null);
    source['stt'] = args.sttProvider ? 'flag' : activeStt ? 'app DB' : sttProvider ? 'default' : 'none';

    const settings = {
        askMode: saved.askMode || 'default',
        preferredCodeLanguage: saved.preferredCodeLanguage != null ? saved.preferredCodeLanguage : 'go',
        sttLanguage: saved.sttLanguage || 'pt-BR',
        liveFeatures: saved.liveFeatures || 'both',
    };

    return {
        dataDir,
        dbError: db.error || null,
        catalogRows: db.catalog || [],
        keys,
        llm: { provider: llmProvider, model: llmModels },
        stt: { provider: sttProvider, model: sttModel, apiKey: sttProvider ? keys[sttProvider] : null },
        settings,
        kbPath: args.kb || env.CAREER_KB_PATH || '',
        kbCompany: env.CAREER_KB_COMPANY || '',
        source,
    };
}

/** Lines safe to print: providers, lists and where each value came from, no keys. */
function describe(cfg) {
    const lines = [
        `app data: ${cfg.dbError ? `not read (${cfg.dbError})` : 'read-only'}`,
        `LLM: ${cfg.llm.provider || '-'} [${cfg.llm.model || '-'}] (${cfg.source['llm list']})`,
        `STT: ${cfg.stt.provider || '-'} ${cfg.stt.model || ''} (${cfg.source.stt})`,
        `keys: ${Object.keys(KEY_ENV).map(p => `${p}=${cfg.source[`${p} key`]}`).join(' ')}`,
        `settings: askMode=${cfg.settings.askMode} code=${cfg.settings.preferredCodeLanguage || '(infer)'} stt=${cfg.settings.sttLanguage} live=${cfg.settings.liveFeatures}`,
        `career notes: ${cfg.kbPath ? 'set' : 'not set'}`,
    ];
    return lines;
}

module.exports = { loadConfig, describe, appDataDir, KEY_ENV };

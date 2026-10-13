const { EventEmitter } = require('events');
const Store = require('electron-store');
const { PROVIDERS, getProviderClass, inferProviderFromModelId, splitByProvider } = require('../ai/factory');
const modelCatalog = require('../ai/modelCatalog');
const encryptionService = require('./encryptionService');
const providerSettingsRepository = require('../repositories/providerSettings');
const modelCatalogRepository = require('../repositories/modelCatalog');

// How long saving a model list waits for the catalog to learn its models, so
// Settings shows what they can do right after Save.
const SAVE_CATALOG_TIMEOUT_MS = 5_000;
// The career router's key (Jev, TypeSafe AI): a provider_settings row like the
// others (encrypted, same Save/Clear flow), but no LLM or STT models.
const ROUTER_KEY_PROVIDER = 'typesafe';
const authService = require('./authService');
const ollamaModelRepository = require('../repositories/ollamaModel');

class ModelStateService extends EventEmitter {
    constructor() {
        super();
        this.authService = authService;
        // electron-store는 오직 레거시 데이터 마이그레이션 용도로만 사용됩니다.
        this.store = new Store({ name: 'pickle-glass-model-state' });
    }

    async initialize() {
        console.log('[ModelStateService] Initializing one-time setup...');
        await this._initializeEncryption();
        await this._runMigrations();
        this._initializeCatalog();
        this.setupLocalAIStateSync();
        await this._autoSelectAvailableModels([], true);
        console.log('[ModelStateService] One-time setup complete.');
    }

    /**
     * The model catalog (modelCatalog.js): saved in SQLite, filled from each
     * provider's models API. Loads what was saved, then reads every list
     * with a key again in the background.
     */
    _initializeCatalog() {
        modelCatalog.configure({ store: modelCatalogRepository, fetchers: modelCatalog.defaultFetchers() });
        modelCatalog.load();
        this.refreshCatalog({ force: true }).catch(err => console.warn('[ModelStateService] Catalog refresh failed:', err.message));
    }

    /**
     * Read the models lists of the catalog providers that have a key (all, or
     * the one named), then tell the windows. A failed read keeps what is known.
     * @param {{ provider?: string, force?: boolean }} [o]
     */
    async refreshCatalog({ provider, force = false } = {}) {
        const keys = await this.getAllApiKeys();
        const providers = provider ? [provider] : modelCatalog.CATALOG_PROVIDERS;
        await Promise.all(providers.filter(p => keys[p]).map(p => modelCatalog.refresh(p, keys[p], { force })));
        this.emit('state-updated', await this.getLiveState());
        return true;
    }

    /**
     * Let the catalog learn every model a list names before it is resolved:
     * the lists of the providers with a key (when stale), then a lookup of
     * each ID still unknown at the provider it resolves to (an alias).
     * Waits at most SAVE_CATALOG_TIMEOUT_MS.
     */
    async _learnModelList(list, fieldProvider) {
        const keys = await this.getAllApiKeys();
        const work = (async () => {
            await Promise.all(modelCatalog.CATALOG_PROVIDERS.filter(p => keys[p]).map(p => modelCatalog.refresh(p, keys[p])));
            const segments = splitByProvider(list, fieldProvider);
            await Promise.all(segments.filter(s => keys[s.provider]).map(s =>
                modelCatalog.ensureKnown(s.provider, keys[s.provider], s.models, { timeoutMs: SAVE_CATALOG_TIMEOUT_MS })));
        })();
        let timer = null;
        await Promise.race([work, new Promise(resolve => { timer = setTimeout(resolve, SAVE_CATALOG_TIMEOUT_MS); })]);
        clearTimeout(timer);
    }

    /**
     * For Settings: how a list typed in a field runs, and what the catalog
     * knows about each model. Nothing is saved.
     * @param {{ list: string, fieldProvider: string }} input
     * @returns {Promise<{ segments: object[], models: object[], missingKeys: string[] }>}
     */
    async planModelList({ list, fieldProvider }) {
        const keys = await this.getAllApiKeys();
        const segments = splitByProvider(list, fieldProvider);
        const models = [];
        for (const s of segments) {
            for (const id of s.models) {
                const listedBy = modelCatalog.providersListing(id);
                models.push({
                    ...modelCatalog.snapshot({ provider: s.provider, ids: [id] })[0],
                    providerSource: listedBy.includes(s.provider) ? 'catalog' : 'prefix',
                    hasKey: !!keys[s.provider],
                });
            }
        }
        const missingKeys = [...new Set(segments.map(s => s.provider).filter(p => !keys[p]))];
        return { segments, models, missingKeys };
    }

    /** For Settings: what the catalog knows about these models. */
    getCatalog({ provider, ids } = {}) {
        return modelCatalog.snapshot({ provider, ids });
    }

    /**
     * Set or clear (value null) one capability override, from Settings.
     * @returns {{ success: boolean, error?: string }}
     */
    async setCapabilityOverride({ provider, modelId, field, value }) {
        try {
            modelCatalog.setOverride(provider, modelId, field, value);
        } catch (err) {
            return { success: false, error: err.message };
        }
        this.emit('state-updated', await this.getLiveState());
        return { success: true };
    }

    async _initializeEncryption() {
        try {
            const rows = await providerSettingsRepository.getRawApiKeys();
            if (rows.some(r => r.api_key && encryptionService.looksEncrypted(r.api_key))) {
                console.log('[ModelStateService] Encrypted keys detected, initializing encryption...');
                const userIdForMigration = this.authService.getCurrentUserId();
                await encryptionService.initializeKey(userIdForMigration);
            } else {
                console.log('[ModelStateService] No encrypted keys detected, skipping encryption initialization.');
            }
        } catch (err) {
            console.warn('[ModelStateService] Error while checking encrypted keys:', err.message);
        }
    }

    async _runMigrations() {
        console.log('[ModelStateService] Checking for data migrations...');
        const userId = this.authService.getCurrentUserId();
        
        try {
            const sqliteClient = require('./sqliteClient');
            const db = sqliteClient.getDb();
            const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user_model_selections'").get();
            
            if (tableExists) {
                const selections = db.prepare('SELECT * FROM user_model_selections WHERE uid = ?').get(userId);
                if (selections) {
                    console.log('[ModelStateService] Migrating from user_model_selections table...');
                    if (selections.llm_model) {
                        const llmProvider = this.getProviderForModel(selections.llm_model, 'llm');
                        if (llmProvider) {
                            await this.setSelectedModel('llm', selections.llm_model);
                        }
                    }
                    if (selections.stt_model) {
                        const sttProvider = this.getProviderForModel(selections.stt_model, 'stt');
                        if (sttProvider) {
                            await this.setSelectedModel('stt', selections.stt_model);
                        }
                    }
                    db.prepare('DROP TABLE user_model_selections').run();
                    console.log('[ModelStateService] user_model_selections migration complete.');
                }
            }
        } catch (error) {
            console.error('[ModelStateService] user_model_selections migration failed:', error);
        }

        try {
            const legacyData = this.store.get(`users.${userId}`);
            if (legacyData && legacyData.apiKeys) {
                console.log('[ModelStateService] Migrating from electron-store...');
                for (const [provider, apiKey] of Object.entries(legacyData.apiKeys)) {
                    if (apiKey && PROVIDERS[provider]) {
                        await this.setApiKey(provider, apiKey);
                    }
                }
                if (legacyData.selectedModels?.llm) {
                    await this.setSelectedModel('llm', legacyData.selectedModels.llm);
                }
                if (legacyData.selectedModels?.stt) {
                    await this.setSelectedModel('stt', legacyData.selectedModels.stt);
                }
                this.store.delete(`users.${userId}`);
                console.log('[ModelStateService] electron-store migration complete.');
            }
        } catch (error) {
            console.error('[ModelStateService] electron-store migration failed:', error);
        }
    }
    
    setupLocalAIStateSync() {
        const localAIManager = require('./localAIManager');
        localAIManager.on('state-changed', (service, status) => {
            this.handleLocalAIStateChange(service, status);
        });
    }

    async handleLocalAIStateChange(service, state) {
        console.log(`[ModelStateService] LocalAI state changed: ${service}`, state);
        if (!state.installed || !state.running) {
            const candidateTypes = service === 'ollama' ? ['llm'] : service === 'whisper' ? ['stt'] : [];
            const types = [];
            if (candidateTypes.length > 0) {
                const selected = await this.getSelectedModels();
                for (const t of candidateTypes) {
                    const currentProvider = this.getProviderForModel(selected[t], t);
                    if (currentProvider === service) {
                        types.push(t);
                    }
                }
            }
            if (types.length > 0) {
                await this._autoSelectAvailableModels(types);
            }
        }
        this.emit('state-updated', await this.getLiveState());
    }

    async getLiveState() {
        const providerSettings = await providerSettingsRepository.getAll();
        const apiKeys = {};
        Object.keys(PROVIDERS).forEach(provider => {
            const setting = providerSettings.find(s => s.provider === provider);
            apiKeys[provider] = setting?.api_key || null;
        });

        const activeSettings = await providerSettingsRepository.getActiveSettings();
        const selectedModels = {
            llm: activeSettings.llm?.selected_llm_model || null,
            stt: activeSettings.stt?.selected_stt_model || null
        };
        
        return { apiKeys, selectedModels };
    }

    async _autoSelectAvailableModels(forceReselectionForTypes = [], isInitialBoot = false) {
        console.log(`[ModelStateService] Running auto-selection. Force re-selection for: [${forceReselectionForTypes.join(', ')}]`);
        const { apiKeys, selectedModels } = await this.getLiveState();
        const types = ['llm', 'stt'];

        for (const type of types) {
            const currentModelId = selectedModels[type];
            let isCurrentModelValid = false;
            const forceReselection = forceReselectionForTypes.includes(type);

            if (currentModelId && !forceReselection) {
                const provider = this.getProviderForModel(currentModelId, type);
                const apiKey = apiKeys[provider];
                if (provider && apiKey) {
                    isCurrentModelValid = true;
                }
            }

            if (!isCurrentModelValid) {
                console.log(`[ModelStateService] No valid ${type.toUpperCase()} model selected or selection forced. Finding an alternative...`);
                const availableModels = await this.getAvailableModels(type);
                if (availableModels.length > 0) {
                    const apiModel = availableModels.find(model => {
                        const provider = this.getProviderForModel(model.id, type);
                        return provider && provider !== 'ollama' && provider !== 'whisper';
                    });
                    const newModel = apiModel || availableModels[0];
                    await this.setSelectedModel(type, newModel.id);
                    console.log(`[ModelStateService] Auto-selected ${type.toUpperCase()} model: ${newModel.id}`);
                } else {
                    await providerSettingsRepository.setActiveProvider(null, type);
                    if (!isInitialBoot) {
                       this.emit('state-updated', await this.getLiveState());
                    }
                }
            }
        }
    }
    
    async setFirebaseVirtualKey(virtualKey) {
        console.log(`[ModelStateService] Setting Firebase virtual key.`);

        // 키를 설정하기 전에, 이전에 openai-glass 키가 있었는지 확인합니다.
        const previousSettings = await providerSettingsRepository.getByProvider('openai-glass');
        const wasPreviouslyConfigured = !!previousSettings?.api_key;

        // 항상 새로운 가상 키로 업데이트합니다.
        await this.setApiKey('openai-glass', virtualKey);

        if (virtualKey) {
            // 이전에 설정된 적이 없는 경우 (최초 로그인)에만 모델을 강제로 변경합니다.
            if (!wasPreviouslyConfigured) {
                console.log('[ModelStateService] First-time setup for openai-glass, setting default models.');
                const llmModel = PROVIDERS['openai-glass']?.llmModels[0];
                const sttModel = PROVIDERS['openai-glass']?.sttModels[0];
                if (llmModel) await this.setSelectedModel('llm', llmModel.id);
                if (sttModel) await this.setSelectedModel('stt', sttModel.id);
            } else {
                console.log('[ModelStateService] openai-glass key updated, but respecting user\'s existing model selection.');
            }
        } else {
            // 로그아웃 시, 현재 활성화된 모델이 openai-glass인 경우에만 다른 모델로 전환합니다.
            const selected = await this.getSelectedModels();
            const llmProvider = this.getProviderForModel(selected.llm, 'llm');
            const sttProvider = this.getProviderForModel(selected.stt, 'stt');
            
            const typesToReselect = [];
            if (llmProvider === 'openai-glass') typesToReselect.push('llm');
            if (sttProvider === 'openai-glass') typesToReselect.push('stt');

            if (typesToReselect.length > 0) {
                console.log('[ModelStateService] Logged out, re-selecting models for:', typesToReselect.join(', '));
                await this._autoSelectAvailableModels(typesToReselect);
            }
        }
    }

    async setApiKey(provider, key) {
        console.log(`[ModelStateService] setApiKey for ${provider}`);
        if (!provider) {
            throw new Error('Provider is required');
        }

        // 'openai-glass'는 자체 인증 키를 사용하므로 유효성 검사를 건너뜁니다.
        if (provider !== 'openai-glass') {
            const validationResult = await this.validateApiKey(provider, key);
            if (!validationResult.success) {
                console.warn(`[ModelStateService] API key validation failed for ${provider}: ${validationResult.error}`);
                return validationResult;
            }
        }

        const finalKey = (provider === 'ollama' || provider === 'whisper') ? 'local' : key;
        const existingSettings = await providerSettingsRepository.getByProvider(provider) || {};
        await providerSettingsRepository.upsert(provider, { ...existingSettings, api_key: finalKey });

        if (modelCatalog.CATALOG_PROVIDERS.includes(provider)) {
            // A new key: the limits learned for the old one may not hold, and its list may differ.
            modelCatalog.clearKeyLimits(provider);
            this.refreshCatalog({ provider, force: true }).catch(err => console.warn(`[ModelStateService] Catalog refresh failed for ${provider}:`, err.message));
        }

        // 키가 추가/변경되었으므로, 해당 provider의 모델을 자동 선택할 수 있는지 확인
        await this._autoSelectAvailableModels([]);
        
        this.emit('state-updated', await this.getLiveState());
        this.emit('settings-updated');
        return { success: true };
    }

    async getAllApiKeys() {
        const allSettings = await providerSettingsRepository.getAll();
        const apiKeys = {};
        allSettings.forEach(s => {
            if (s.provider !== 'openai-glass') {
                apiKeys[s.provider] = s.api_key;
            }
        });
        return apiKeys;
    }

    async removeApiKey(provider) {
        const setting = await providerSettingsRepository.getByProvider(provider);
        if (setting && setting.api_key) {
            await providerSettingsRepository.upsert(provider, { ...setting, api_key: null });
            modelCatalog.clearKeyLimits(provider);
            await this._autoSelectAvailableModels(['llm', 'stt']);
            this.emit('state-updated', await this.getLiveState());
            this.emit('settings-updated');
            return true;
        }
        return false;
    }

    /**
     * 사용자가 Firebase에 로그인했는지 확인합니다.
     */
    isLoggedInWithFirebase() {
        return this.authService.getCurrentUser().isLoggedIn;
    }

    /**
     * 유효한 API 키가 하나라도 설정되어 있는지 확인합니다.
     */
    async hasValidApiKey() {
        if (this.isLoggedInWithFirebase()) return true;

        const allSettings = await providerSettingsRepository.getAll();
        // The TypeSafe key only routes career questions; alone it answers nothing.
        return allSettings.some(s => s.provider !== ROUTER_KEY_PROVIDER && s.api_key && s.api_key.trim().length > 0);
    }

    /**
     * The provider of a model ID or list. `context` is the Settings field the
     * list was typed in: it decides an ID that several providers list.
     */
    getProviderForModel(arg1, arg2, context) {
        // Compatibility: support both (type, modelId) old order and (modelId, type) new order
        let type, modelId;
        if (arg1 === 'llm' || arg1 === 'stt') {
            type = arg1;
            modelId = arg2;
        } else {
            modelId = arg1;
            type = arg2;
        }
        if (!modelId || !type) return null;
        for (const providerId in PROVIDERS) {
            const models = type === 'llm' ? PROVIDERS[providerId].llmModels : PROVIDERS[providerId].sttModels;
            if (models && models.some(m => m.id === modelId)) {
                return providerId;
            }
        }
        if (type === 'llm') {
            const installedModels = ollamaModelRepository.getInstalledModels();
            if (installedModels.some(m => m.name === modelId)) return 'ollama';
        }
        // A typed ID or CSV list: the provider whose models list has it (the
        // catalog), else its prefix. Gemini for LLM or STT; Anthropic and Groq
        // for LLM only.
        const inferred = inferProviderFromModelId(modelId, context);
        if (inferred === 'gemini' || ((inferred === 'anthropic' || inferred === 'groq') && type === 'llm')) return inferred;
        return null;
    }

    /** The active LLM and STT models, and the provider row each is saved in. */
    async getSelectedModels() {
        const active = await providerSettingsRepository.getActiveSettings();
        return {
            llm: active.llm?.selected_llm_model || null,
            stt: active.stt?.selected_stt_model || null,
            llmProvider: active.llm?.provider || null,
            sttProvider: active.stt?.provider || null,
        };
    }
    
    /**
     * @param {'llm'|'stt'} type
     * @param {string} modelId - one ID or a CSV list
     * @param {string} [fieldProvider] - the Settings field it was typed in
     */
    async setSelectedModel(type, modelId, fieldProvider) {
        // The catalog learns the list's models first, so their provider comes
        // from the providers' lists and Settings can show what they can do.
        if (type === 'llm' && modelCatalog.CATALOG_PROVIDERS.includes(fieldProvider)) {
            await this._learnModelList(modelId, fieldProvider);
        }
        const provider = this.getProviderForModel(modelId, type, fieldProvider);
        if (!provider) {
            console.warn(`[ModelStateService] No provider found for model ${modelId}`);
            return false;
        }

        const existingSettings = await providerSettingsRepository.getByProvider(provider) || {};
        const newSettings = { ...existingSettings };

        if (type === 'llm') {
            newSettings.selected_llm_model = modelId;
        } else {
            newSettings.selected_stt_model = modelId;
        }
        
        await providerSettingsRepository.upsert(provider, newSettings);
        await providerSettingsRepository.setActiveProvider(provider, type);
        
        console.log(`[ModelStateService] Selected ${type} model: ${modelId} (provider: ${provider})`);
        
        if (type === 'llm' && provider === 'ollama') {
            require('./localAIManager').warmUpModel(modelId).catch(err => console.warn(err));
        }
        
        this.emit('state-updated', await this.getLiveState());
        this.emit('settings-updated');
        return true;
    }

    /** The models Settings offers, each with the provider it belongs to. */
    async getAvailableModels(type) {
        const allSettings = await providerSettingsRepository.getAll();
        const available = [];
        const modelListKey = type === 'llm' ? 'llmModels' : 'sttModels';
        const withProvider = (provider, models) => models.map(m => ({ ...m, provider }));

        for (const setting of allSettings) {
            if (!setting.api_key) continue;

            const providerId = setting.provider;
            if (providerId === 'ollama' && type === 'llm') {
                const installed = ollamaModelRepository.getInstalledModels();
                available.push(...installed.map(m => ({ id: m.name, name: m.name, provider: 'ollama' })));
            } else if (modelCatalog.CATALOG_PROVIDERS.includes(providerId) && PROVIDERS[providerId]?.[modelListKey]) {
                const presets = PROVIDERS[providerId][modelListKey];
                const customId = type === 'llm' ? setting.selected_llm_model : setting.selected_stt_model;
                if (customId && !presets.some(m => m.id === customId)) {
                    available.push({ id: customId, name: `${customId} (custom)`, provider: providerId });
                }
                available.push(...withProvider(providerId, presets));
            } else if (PROVIDERS[providerId]?.[modelListKey]) {
                available.push(...withProvider(providerId, PROVIDERS[providerId][modelListKey]));
            }
        }
        return [...new Map(available.map(item => [item.id, item])).values()];
    }

    async getCurrentModelInfo(type) {
        const activeSetting = await providerSettingsRepository.getActiveProvider(type);
        if (!activeSetting) return null;
        
        const model = type === 'llm' ? activeSetting.selected_llm_model : activeSetting.selected_stt_model;
        if (!model) return null;

        const info = {
            provider: activeSetting.provider,
            model: model,
            apiKey: activeSetting.api_key,
        };
        if (type === 'llm') info.keys = await this._keysForModelList(model, activeSetting);
        return info;
    }

    /**
     * The saved key of every provider a model list names (a list may end in
     * another provider's models; see providerChain.js), or null when none is
     * saved. The active provider's key comes from its own row.
     */
    async _keysForModelList(model, activeSetting) {
        const keys = {};
        for (const { provider } of splitByProvider(model, activeSetting.provider)) {
            if (provider in keys) continue;
            if (provider === activeSetting.provider) {
                keys[provider] = activeSetting.api_key || null;
                continue;
            }
            const setting = await providerSettingsRepository.getByProvider(provider);
            keys[provider] = setting?.api_key || null;
        }
        return keys;
    }

    // --- 핸들러 및 유틸리티 메서드 ---

    async validateApiKey(provider, key) {
        if (!key || (key.trim() === '' && provider !== 'ollama' && provider !== 'whisper')) {
            return { success: false, error: 'API key cannot be empty.' };
        }
        if (provider === ROUTER_KEY_PROVIDER) {
            const result = await require('../career/jevClient').validateKey({ apiKey: key });
            if (result.unverified) console.warn(`[ModelStateService] TypeSafe key saved unverified (${result.unverified})`);
            return result;
        }
        const ProviderClass = getProviderClass(provider);
        if (!ProviderClass || typeof ProviderClass.validateApiKey !== 'function') {
            return { success: true };
        }
        try {
            return await ProviderClass.validateApiKey(key);
        } catch (error) {
            return { success: false, error: 'An unexpected error occurred during validation.' };
        }
    }

    getProviderConfig() {
        const config = {};
        for (const key in PROVIDERS) {
            const { handler, ...rest } = PROVIDERS[key];
            // catalog: its models API feeds the model catalog, and its lists can run across providers
            config[key] = { ...rest, catalog: modelCatalog.CATALOG_PROVIDERS.includes(key) };
        }
        return config;
    }
    
    async handleRemoveApiKey(provider) {
        const success = await this.removeApiKey(provider);
        if (success) {
            const selectedModels = await this.getSelectedModels();
            if (!selectedModels.llm && !selectedModels.stt) {
                this.emit('force-show-apikey-header');
            }
        }
        return success;
    }

    /*-------------- Compatibility Helpers --------------*/
    async handleValidateKey(provider, key) {
        return await this.setApiKey(provider, key);
    }

    async handleSetSelectedModel(type, modelId, fieldProvider) {
        return await this.setSelectedModel(type, modelId, fieldProvider);
    }

    async areProvidersConfigured() {
        if (this.isLoggedInWithFirebase()) return true;
        const allSettings = await providerSettingsRepository.getAll();
        const apiKeyMap = {};
        allSettings.forEach(s => apiKeyMap[s.provider] = s.api_key);
        // LLM
        const hasLlmKey = Object.entries(apiKeyMap).some(([provider, key]) => {
            if (!key) return false;
            if (provider === 'whisper') return false; // whisper는 LLM 없음
            return PROVIDERS[provider]?.llmModels?.length > 0;
        });
        // STT
        const hasSttKey = Object.entries(apiKeyMap).some(([provider, key]) => {
            if (!key) return false;
            if (provider === 'ollama') return false; // ollama는 STT 없음
            return PROVIDERS[provider]?.sttModels?.length > 0 || provider === 'whisper';
        });
        return hasLlmKey && hasSttKey;
    }
}

const modelStateService = new ModelStateService();
module.exports = modelStateService;
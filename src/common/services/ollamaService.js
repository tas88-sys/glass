const { spawn } = require('child_process');
const { promisify } = require('util');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs').promises;
const { app } = require('electron');
const LocalAIServiceBase = require('./localAIServiceBase');
const { spawnAsync } = require('../utils/spawnHelper');
const { DOWNLOAD_CHECKSUMS } = require('../config/checksums');

class OllamaService extends LocalAIServiceBase {
    constructor() {
        super('OllamaService');
        this.baseUrl = 'http://localhost:11434';
        this.warmingModels = new Map();
        this.warmedModels = new Set();
        this.lastWarmUpAttempt = new Map();
        
        // Request management system
        this.activeRequests = new Map();
        this.requestTimeouts = new Map();
        this.healthStatus = {
            lastHealthCheck: 0,
            consecutive_failures: 0,
            is_circuit_open: false
        };
        
        // Configuration
        this.requestTimeout = 8000; // 8s for health checks
        this.warmupTimeout = 15000; // 15s for model warmup
        this.healthCheckInterval = 60000; // 1min between health checks
        this.circuitBreakerThreshold = 3;
        this.circuitBreakerCooldown = 30000; // 30s
        
        // Supported models are determined dynamically from installed models
        this.supportedModels = {};
        
        // Start health monitoring
        this._startHealthMonitoring();
    }

    getOllamaCliPath() {
        if (this.getPlatform() === 'darwin') {
            return '/Applications/Ollama.app/Contents/Resources/ollama';
        }
        return 'ollama';
    }

    /**
     * Professional request management with AbortController-based cancellation
     */
    async _makeRequest(url, options = {}, operationType = 'default') {
        const requestId = `${operationType}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        // Circuit breaker check
        if (this._isCircuitOpen()) {
            throw new Error('Service temporarily unavailable (circuit breaker open)');
        }
        
        // Request deduplication for health checks
        if (operationType === 'health' && this.activeRequests.has('health')) {
            console.log('[OllamaService] Health check already in progress, returning existing promise');
            return this.activeRequests.get('health');
        }
        
        const controller = new AbortController();
        const timeout = options.timeout || this.requestTimeout;
        
        // Set up timeout mechanism
        const timeoutId = setTimeout(() => {
            controller.abort();
            this.activeRequests.delete(requestId);
            this._recordFailure();
        }, timeout);
        
        this.requestTimeouts.set(requestId, timeoutId);
        
        const requestPromise = this._executeRequest(url, {
            ...options,
            signal: controller.signal
        }, requestId);
        
        // Store active request for deduplication and cleanup
        this.activeRequests.set(operationType === 'health' ? 'health' : requestId, requestPromise);
        
        try {
            const result = await requestPromise;
            this._recordSuccess();
            return result;
        } catch (error) {
            this._recordFailure();
            if (error.name === 'AbortError') {
                throw new Error(`Request timeout after ${timeout}ms`);
            }
            throw error;
        } finally {
            clearTimeout(timeoutId);
            this.requestTimeouts.delete(requestId);
            this.activeRequests.delete(operationType === 'health' ? 'health' : requestId);
        }
    }
    
    async _executeRequest(url, options, requestId) {
        try {
            console.log(`[OllamaService] Executing request ${requestId} to ${url}`);
            const response = await fetch(url, options);
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            return response;
        } catch (error) {
            console.error(`[OllamaService] Request ${requestId} failed:`, error.message);
            throw error;
        }
    }
    
    _isCircuitOpen() {
        if (!this.healthStatus.is_circuit_open) return false;
        
        // Check if cooldown period has passed
        const now = Date.now();
        if (now - this.healthStatus.lastHealthCheck > this.circuitBreakerCooldown) {
            console.log('[OllamaService] Circuit breaker cooldown expired, attempting recovery');
            this.healthStatus.is_circuit_open = false;
            this.healthStatus.consecutive_failures = 0;
            return false;
        }
        
        return true;
    }
    
    _recordSuccess() {
        this.healthStatus.consecutive_failures = 0;
        this.healthStatus.is_circuit_open = false;
        this.healthStatus.lastHealthCheck = Date.now();
    }
    
    _recordFailure() {
        this.healthStatus.consecutive_failures++;
        this.healthStatus.lastHealthCheck = Date.now();
        
        if (this.healthStatus.consecutive_failures >= this.circuitBreakerThreshold) {
            console.warn(`[OllamaService] Circuit breaker opened after ${this.healthStatus.consecutive_failures} failures`);
            this.healthStatus.is_circuit_open = true;
        }
    }
    
    _startHealthMonitoring() {
        // Passive health monitoring - only when requests are made
        console.log('[OllamaService] Health monitoring system initialized');
    }
    
    /**
     * Cleanup all active requests and resources
     */
    _cleanup() {
        console.log(`[OllamaService] Cleaning up ${this.activeRequests.size} active requests`);
        
        // Cancel all active requests
        for (const [requestId, promise] of this.activeRequests) {
            if (this.requestTimeouts.has(requestId)) {
                clearTimeout(this.requestTimeouts.get(requestId));
                this.requestTimeouts.delete(requestId);
            }
        }
        
        this.activeRequests.clear();
        this.requestTimeouts.clear();
    }

    async isInstalled() {
        try {
            const platform = this.getPlatform();
            
            if (platform === 'darwin') {
                try {
                    await fs.access('/Applications/Ollama.app');
                    return true;
                } catch {
                    const ollamaPath = await this.checkCommand(this.getOllamaCliPath());
                    return !!ollamaPath;
                }
            } else {
                const ollamaPath = await this.checkCommand(this.getOllamaCliPath());
                return !!ollamaPath;
            }
        } catch (error) {
            console.log('[OllamaService] Ollama not found:', error.message);
            return false;
        }
    }

    async isServiceRunning() {
        try {
            const response = await this._makeRequest(`${this.baseUrl}/api/tags`, {
                method: 'GET',
                timeout: this.requestTimeout
            }, 'health');
            
            return response.ok;
        } catch (error) {
            console.log(`[OllamaService] Service health check failed: ${error.message}`);
            return false;
        }
    }

    async startService() {
        const platform = this.getPlatform();
        
        try {
            if (platform === 'darwin') {
                try {
                    await spawnAsync('open', ['-a', 'Ollama']);
                    await this.waitForService(() => this.isServiceRunning());
                    return true;
                } catch {
                    spawn(this.getOllamaCliPath(), ['serve'], {
                        detached: true,
                        stdio: 'ignore'
                    }).unref();
                    await this.waitForService(() => this.isServiceRunning());
                    return true;
                }
            } else {
                spawn(this.getOllamaCliPath(), ['serve'], {
                    detached: true,
                    stdio: 'ignore',
                    shell: platform === 'win32'
                }).unref();
                await this.waitForService(() => this.isServiceRunning());
                return true;
            }
        } catch (error) {
            console.error('[OllamaService] Failed to start service:', error);
            throw error;
        }
    }

    async stopService() {
        return await this.shutdown();
    }

    async getInstalledModels() {
        try {
            const response = await this._makeRequest(`${this.baseUrl}/api/tags`, {
                method: 'GET',
                timeout: this.requestTimeout
            }, 'models');
            
            const data = await response.json();
            return data.models || [];
        } catch (error) {
            console.error('[OllamaService] Failed to get installed models:', error.message);
            return [];
        }
    }

    async getInstalledModelsList() {
        try {
            const { stdout } = await spawnAsync(this.getOllamaCliPath(), ['list']);
            const lines = stdout.split('\n').filter(line => line.trim());
            
            // Skip header line (NAME, ID, SIZE, MODIFIED)
            const modelLines = lines.slice(1);
            
            const models = [];
            for (const line of modelLines) {
                if (!line.trim()) continue;
                
                // Parse line: "model:tag    model_id    size    modified_time"
                const parts = line.split(/\s+/);
                if (parts.length >= 3) {
                    models.push({
                        name: parts[0],
                        id: parts[1],
                        size: parts[2] + (parts[3] === 'GB' || parts[3] === 'MB' ? ' ' + parts[3] : ''),
                        status: 'installed'
                    });
                }
            }
            
            return models;
        } catch (error) {
            console.log('[OllamaService] Failed to get installed models via CLI, falling back to API');
            // Fallback to API if CLI fails
            const apiModels = await this.getInstalledModels();
            return apiModels.map(model => ({
                name: model.name,
                id: model.digest || 'unknown',
                size: model.size || 'Unknown',
                status: 'installed'
            }));
        }
    }

    async getModelSuggestions() {
        try {
            // Get actually installed models
            const installedModels = await this.getInstalledModelsList();
            
            // Get user input history from storage (we'll implement this in the frontend)
            // For now, just return installed models
            return installedModels;
        } catch (error) {
            console.error('[OllamaService] Failed to get model suggestions:', error);
            return [];
        }
    }

    async isModelInstalled(modelName) {
        const models = await this.getInstalledModels();
        return models.some(model => model.name === modelName);
    }

    async pullModel(modelName) {
        if (!modelName?.trim()) {
            throw new Error(`Invalid model name: ${modelName}`);
        }

        console.log(`[OllamaService] Starting to pull model: ${modelName} via API`);
        
        try {
            const response = await fetch(`${this.baseUrl}/api/pull`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: modelName,
                    stream: true
                })
            });

            if (!response.ok) {
                throw new Error(`Pull API failed: ${response.status} ${response.statusText}`);
            }

            // Handle Node.js streaming response
            return new Promise((resolve, reject) => {
                let buffer = '';
                
                response.body.on('data', (chunk) => {
                    buffer += chunk.toString();
                    const lines = buffer.split('\n');
                    
                    // Keep incomplete line in buffer
                    buffer = lines.pop() || '';
                    
                    // Process complete lines
                    for (const line of lines) {
                        if (!line.trim()) continue;
                        
                        try {
                            const data = JSON.parse(line);
                            const progress = this._parseOllamaPullProgress(data, modelName);
                            
                            if (progress !== null) {
                                this.setInstallProgress(modelName, progress);
                                this.emit('pull-progress', { 
                                    model: modelName, 
                                    progress,
                                    status: data.status || 'downloading'
                                });
                                console.log(`[OllamaService] API Progress: ${progress}% for ${modelName} (${data.status || 'downloading'})`);
                            }

                            // Handle completion
                            if (data.status === 'success') {
                                console.log(`[OllamaService] Successfully pulled model: ${modelName}`);
                                this.emit('pull-complete', { model: modelName });
                                this.clearInstallProgress(modelName);
                                resolve();
                                return;
                            }
                        } catch (parseError) {
                            console.warn('[OllamaService] Failed to parse response line:', line);
                        }
                    }
                });

                response.body.on('end', () => {
                    // Process any remaining data in buffer
                    if (buffer.trim()) {
                        try {
                            const data = JSON.parse(buffer);
                            if (data.status === 'success') {
                                console.log(`[OllamaService] Successfully pulled model: ${modelName}`);
                                this.emit('pull-complete', { model: modelName });
                            }
                        } catch (parseError) {
                            console.warn('[OllamaService] Failed to parse final buffer:', buffer);
                        }
                    }
                    this.clearInstallProgress(modelName);
                    resolve();
                });

                response.body.on('error', (error) => {
                    console.error(`[OllamaService] Stream error for ${modelName}:`, error);
                    this.clearInstallProgress(modelName);
                    reject(error);
                });
            });
        } catch (error) {
            this.clearInstallProgress(modelName);
            console.error(`[OllamaService] Pull model failed:`, error);
            throw error;
        }
    }

    _parseOllamaPullProgress(data, modelName) {
        // Handle Ollama API response format
        if (data.status === 'success') {
            return 100;
        }

        // Handle downloading progress
        if (data.total && data.completed !== undefined) {
            const progress = Math.round((data.completed / data.total) * 100);
            return Math.min(progress, 99); // Don't show 100% until success
        }

        // Handle status-based progress
        const statusProgress = {
            'pulling manifest': 5,
            'downloading': 10,
            'verifying sha256 digest': 90,
            'writing manifest': 95,
            'removing any unused layers': 98
        };

        if (data.status && statusProgress[data.status] !== undefined) {
            return statusProgress[data.status];
        }

        return null;
    }



    async installMacOS(onProgress) {
        console.log('[OllamaService] Installing Ollama on macOS using DMG...');
        
        try {
            const dmgUrl = 'https://ollama.com/download/Ollama.dmg';
            const tempDir = app.getPath('temp');
            const dmgPath = path.join(tempDir, 'Ollama.dmg');
            const mountPoint = path.join(tempDir, 'OllamaMount');

            console.log('[OllamaService] Step 1: Downloading Ollama DMG...');
            onProgress?.({ stage: 'downloading', message: 'Downloading Ollama installer...', progress: 0 });
            const checksumInfo = DOWNLOAD_CHECKSUMS.ollama.dmg;
            await this.downloadWithRetry(dmgUrl, dmgPath, {
                expectedChecksum: checksumInfo?.sha256,
                onProgress: (progress) => {
                    onProgress?.({ stage: 'downloading', message: `Downloading... ${progress}%`, progress });
                }
            });
            
            console.log('[OllamaService] Step 2: Mounting DMG...');
            onProgress?.({ stage: 'mounting', message: 'Mounting disk image...', progress: 0 });
            await fs.mkdir(mountPoint, { recursive: true });
            await spawnAsync('hdiutil', ['attach', dmgPath, '-mountpoint', mountPoint]);
            onProgress?.({ stage: 'mounting', message: 'Disk image mounted.', progress: 100 });
            
            console.log('[OllamaService] Step 3: Installing Ollama.app...');
            onProgress?.({ stage: 'installing', message: 'Installing Ollama application...', progress: 0 });
            await spawnAsync('cp', ['-R', `${mountPoint}/Ollama.app`, '/Applications/']);
            onProgress?.({ stage: 'installing', message: 'Application installed.', progress: 100 });
            
            console.log('[OllamaService] Step 4: Setting up CLI path...');
            onProgress?.({ stage: 'linking', message: 'Creating command-line shortcut...', progress: 0 });
            try {
                const script = `do shell script "mkdir -p /usr/local/bin && ln -sf '${this.getOllamaCliPath()}' '/usr/local/bin/ollama'" with administrator privileges`;
                await spawnAsync('osascript', ['-e', script]);
                onProgress?.({ stage: 'linking', message: 'Shortcut created.', progress: 100 });
            } catch (linkError) {
                console.error('[OllamaService] CLI symlink creation failed:', linkError.message);
                onProgress?.({ stage: 'linking', message: 'Shortcut creation failed (permissions?).', progress: 100 });
                // Not throwing an error, as the app might still work
            }
            
            console.log('[OllamaService] Step 5: Cleanup...');
            onProgress?.({ stage: 'cleanup', message: 'Cleaning up installation files...', progress: 0 });
            await spawnAsync('hdiutil', ['detach', mountPoint]);
            await fs.unlink(dmgPath).catch(() => {});
            await fs.rmdir(mountPoint).catch(() => {});
            onProgress?.({ stage: 'cleanup', message: 'Cleanup complete.', progress: 100 });
            
            console.log('[OllamaService] Ollama installed successfully on macOS');
            
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            return true;
        } catch (error) {
            console.error('[OllamaService] macOS installation failed:', error);
            throw new Error(`Failed to install Ollama on macOS: ${error.message}`);
        }
    }

    async installWindows(onProgress) {
        console.log('[OllamaService] Installing Ollama on Windows...');
        
        try {
            const exeUrl = 'https://ollama.com/download/OllamaSetup.exe';
            const tempDir = app.getPath('temp');
            const exePath = path.join(tempDir, 'OllamaSetup.exe');

            console.log('[OllamaService] Step 1: Downloading Ollama installer...');
            onProgress?.({ stage: 'downloading', message: 'Downloading Ollama installer...', progress: 0 });
            const checksumInfo = DOWNLOAD_CHECKSUMS.ollama.exe;
            await this.downloadWithRetry(exeUrl, exePath, {
                expectedChecksum: checksumInfo?.sha256,
                onProgress: (progress) => {
                    onProgress?.({ stage: 'downloading', message: `Downloading... ${progress}%`, progress });
                }
            });
            
            console.log('[OllamaService] Step 2: Running silent installation...');
            onProgress?.({ stage: 'installing', message: 'Installing Ollama...', progress: 0 });
            await spawnAsync(exePath, ['/VERYSILENT', '/NORESTART']);
            onProgress?.({ stage: 'installing', message: 'Installation complete.', progress: 100 });
            
            console.log('[OllamaService] Step 3: Cleanup...');
            onProgress?.({ stage: 'cleanup', message: 'Cleaning up installation files...', progress: 0 });
            await fs.unlink(exePath).catch(() => {});
            onProgress?.({ stage: 'cleanup', message: 'Cleanup complete.', progress: 100 });
            
            console.log('[OllamaService] Ollama installed successfully on Windows');
            
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            return true;
        } catch (error) {
            console.error('[OllamaService] Windows installation failed:', error);
            throw new Error(`Failed to install Ollama on Windows: ${error.message}`);
        }
    }

    async installLinux() {
        console.log('[OllamaService] Installing Ollama on Linux...');
        console.log('[OllamaService] Automatic installation on Linux is not supported for security reasons.');
        console.log('[OllamaService] Please install Ollama manually:');
        console.log('[OllamaService] 1. Visit https://ollama.com/download/linux');
        console.log('[OllamaService] 2. Follow the official installation instructions');
        console.log('[OllamaService] 3. Or use your package manager if available');
        throw new Error('Manual installation required on Linux. Please visit https://ollama.com/download/linux');
    }



    async warmUpModel(modelName, forceRefresh = false) {
        if (!modelName?.trim()) {
            console.warn(`[OllamaService] Invalid model name for warm-up`);
            return false;
        }

        // Check if already warmed (and not forcing refresh)
        if (!forceRefresh && this.warmedModels.has(modelName)) {
            console.log(`[OllamaService] Model ${modelName} already warmed up, skipping`);
            return true;
        }

        // Check if currently warming - return existing Promise
        if (this.warmingModels.has(modelName)) {
            console.log(`[OllamaService] Model ${modelName} is already warming up, joining existing operation`);
            return await this.warmingModels.get(modelName);
        }

        // Check rate limiting (prevent too frequent attempts)
        const lastAttempt = this.lastWarmUpAttempt.get(modelName);
        const now = Date.now();
        if (lastAttempt && (now - lastAttempt) < 5000) { // 5 second cooldown
            console.log(`[OllamaService] Rate limiting warm-up for ${modelName}, try again in ${5 - Math.floor((now - lastAttempt) / 1000)}s`);
            return false;
        }

        // Create and store the warming Promise
        const warmingPromise = this._performWarmUp(modelName);
        this.warmingModels.set(modelName, warmingPromise);
        this.lastWarmUpAttempt.set(modelName, now);

        try {
            const result = await warmingPromise;
            
            if (result) {
                this.warmedModels.add(modelName);
                console.log(`[OllamaService] Model ${modelName} successfully warmed up`);
            }
            
            return result;
        } finally {
            // Always clean up the warming Promise
            this.warmingModels.delete(modelName);
        }
    }

    async _performWarmUp(modelName) {
        console.log(`[OllamaService] Starting warm-up for model: ${modelName}`);
        
        try {
            const response = await this._makeRequest(`${this.baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: modelName,
                    messages: [
                        { role: 'user', content: 'Hi' }
                    ],
                    stream: false,
                    options: {
                        num_predict: 1, // Minimal response
                        temperature: 0
                    }
                }),
                timeout: this.warmupTimeout
            }, `warmup_${modelName}`);

            return true;
        } catch (error) {
            console.error(`[OllamaService] Failed to warm up model ${modelName}:`, error.message);
            return false;
        }
    }

    async autoWarmUpSelectedModel() {
        try {
            // Get selected model from ModelStateService
            const modelStateService = global.modelStateService;
            if (!modelStateService) {
                console.log('[OllamaService] ModelStateService not available for auto warm-up');
                return false;
            }

            const selectedModels = modelStateService.getSelectedModels();
            const llmModelId = selectedModels.llm;
            
            // Check if it's an Ollama model
            const provider = modelStateService.getProviderForModel('llm', llmModelId);
            if (provider !== 'ollama') {
                console.log('[OllamaService] Selected LLM is not Ollama, skipping warm-up');
                return false;
            }

            // Check if Ollama service is running
            const isRunning = await this.isServiceRunning();
            if (!isRunning) {
                console.log('[OllamaService] Ollama service not running, clearing warm-up cache');
                this._clearWarmUpCache();
                return false;
            }

            // Check if model is installed
            const isInstalled = await this.isModelInstalled(llmModelId);
            if (!isInstalled) {
                console.log(`[OllamaService] Model ${llmModelId} not installed, skipping warm-up`);
                return false;
            }

            console.log(`[OllamaService] Auto-warming up selected model: ${llmModelId}`);
            return await this.warmUpModel(llmModelId);
            
        } catch (error) {
            console.error('[OllamaService] Auto warm-up failed:', error);
            return false;
        }
    }

    _clearWarmUpCache() {
        this.warmedModels.clear();
        this.warmingModels.clear();
        this.lastWarmUpAttempt.clear();
        console.log('[OllamaService] Warm-up cache cleared');
    }

    getWarmUpStatus() {
        return {
            warmedModels: Array.from(this.warmedModels),
            warmingModels: Array.from(this.warmingModels.keys()),
            lastAttempts: Object.fromEntries(this.lastWarmUpAttempt)
        };
    }

    async shutdown(force = false) {
        console.log(`[OllamaService] Shutdown initiated (force: ${force})`);
        
        if (!force && this.warmingModels.size > 0) {
            const warmingList = Array.from(this.warmingModels.keys());
            console.log(`[OllamaService] Waiting for ${warmingList.length} models to finish warming: ${warmingList.join(', ')}`);
            
            const warmingPromises = Array.from(this.warmingModels.values());
            try {
                // Use Promise.allSettled instead of race with setTimeout
                const results = await Promise.allSettled(warmingPromises);
                const completed = results.filter(r => r.status === 'fulfilled').length;
                console.log(`[OllamaService] ${completed}/${results.length} warming operations completed`);
            } catch (error) {
                console.log('[OllamaService] Error waiting for warm-up completion, proceeding with shutdown');
            }
        }

        // Clean up all resources
        this._cleanup();
        this._clearWarmUpCache();
        
        return super.shutdown(force);
    }

    async shutdownMacOS(force) {
        try {
            // Try to quit Ollama.app gracefully
            await spawnAsync('osascript', ['-e', 'tell application "Ollama" to quit']);
            console.log('[OllamaService] Ollama.app quit successfully');
            
            // Wait a moment for graceful shutdown
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            // Check if still running
            const stillRunning = await this.isServiceRunning();
            if (stillRunning) {
                console.log('[OllamaService] Ollama still running, forcing shutdown');
                // Force kill if necessary
                await spawnAsync('pkill', ['-f', this.getOllamaCliPath()]);
            }
            
            return true;
        } catch (error) {
            console.log('[OllamaService] Graceful quit failed, trying force kill');
            try {
                await spawnAsync('pkill', ['-f', this.getOllamaCliPath()]);
                return true;
            } catch (killError) {
                console.error('[OllamaService] Failed to force kill Ollama:', killError);
                return false;
            }
        }
    }

    async shutdownWindows(force) {
        try {
            // Try to stop the service gracefully
            await spawnAsync('taskkill', ['/IM', 'ollama.exe', '/T']);
            console.log('[OllamaService] Ollama process terminated on Windows');
            return true;
        } catch (error) {
            console.log('[OllamaService] Standard termination failed, trying force kill');
            try {
                await spawnAsync('taskkill', ['/IM', 'ollama.exe', '/F', '/T']);
                return true;
            } catch (killError) {
                console.error('[OllamaService] Failed to force kill Ollama on Windows:', killError);
                return false;
            }
        }
    }

    async shutdownLinux(force) {
        try {
            await spawnAsync('pkill', ['-f', this.getOllamaCliPath()]);
            console.log('[OllamaService] Ollama process terminated on Linux');
            return true;
        } catch (error) {
            if (force) {
                await spawnAsync('pkill', ['-9', '-f', this.getOllamaCliPath()]).catch(() => {});
            }
            console.error('[OllamaService] Failed to shutdown Ollama on Linux:', error);
            return false;
        }
    }

    async getAllModelsWithStatus() {
        // Get all installed models directly from Ollama
        const installedModels = await this.getInstalledModels();
        
        const models = [];
        for (const model of installedModels) {
            models.push({
                name: model.name,
                displayName: model.name, // Use model name as display name
                size: model.size || 'Unknown',
                description: `Ollama model: ${model.name}`,
                installed: true,
                installing: this.installationProgress.has(model.name),
                progress: this.getInstallProgress(model.name)
            });
        }
        
        // Also add any models currently being installed
        for (const [modelName, progress] of this.installationProgress) {
            if (!models.find(m => m.name === modelName)) {
                models.push({
                    name: modelName,
                    displayName: modelName,
                    size: 'Unknown',
                    description: `Ollama model: ${modelName}`,
                    installed: false,
                    installing: true,
                    progress: progress
                });
            }
        }
        
        return models;
    }
}

// Export singleton instance
const ollamaService = new OllamaService();
module.exports = ollamaService;
export class LocalProgressTracker {
    constructor(serviceName) {
        this.serviceName = serviceName;
        this.activeOperations = new Map(); // operationId -> { controller, onProgress }
        
        // Check if we're in renderer process with window.api available
        if (!window.api) {
            throw new Error(`${serviceName} requires Electron environment with contextBridge`);
        }
        
        this.globalProgressHandler = (event, data) => {
            const operation = this.activeOperations.get(data.model || data.modelId);
            if (operation && !operation.controller.signal.aborted) {
                operation.onProgress(data.progress);
            }
        };
        
        // Set up progress listeners based on service name
        if (serviceName.toLowerCase() === 'ollama') {
            window.api.settingsView.onOllamaPullProgress(this.globalProgressHandler);
        } else if (serviceName.toLowerCase() === 'whisper') {
            window.api.settingsView.onWhisperDownloadProgress(this.globalProgressHandler);
        }
        
        this.progressEvent = serviceName.toLowerCase();
    }

    async trackOperation(operationId, operationType, onProgress) {
        if (this.activeOperations.has(operationId)) {
            throw new Error(`${operationType} ${operationId} is already in progress`);
        }

        const controller = new AbortController();
        const operation = { controller, onProgress };
        this.activeOperations.set(operationId, operation);

        try {
            let result;
            
            // Use appropriate API call based on service and operation
            if (this.serviceName.toLowerCase() === 'ollama' && operationType === 'install') {
                result = await window.api.settingsView.pullOllamaModel(operationId);
            } else if (this.serviceName.toLowerCase() === 'whisper' && operationType === 'download') {
                result = await window.api.settingsView.downloadWhisperModel(operationId);
            } else {
                throw new Error(`Unsupported operation: ${this.serviceName}:${operationType}`);
            }
            
            if (!result.success) {
                throw new Error(result.error || `${operationType} failed`);
            }
            
            return true;
        } catch (error) {
            if (!controller.signal.aborted) {
                throw error;
            }
            return false;
        } finally {
            this.activeOperations.delete(operationId);
        }
    }

    async installModel(modelName, onProgress) {
        return this.trackOperation(modelName, 'install', onProgress);
    }

    async downloadModel(modelId, onProgress) {
        return this.trackOperation(modelId, 'download', onProgress);
    }

    cancelOperation(operationId) {
        const operation = this.activeOperations.get(operationId);
        if (operation) {
            operation.controller.abort();
            this.activeOperations.delete(operationId);
        }
    }

    cancelAllOperations() {
        for (const [operationId, operation] of this.activeOperations) {
            operation.controller.abort();
        }
        this.activeOperations.clear();
    }

    isOperationActive(operationId) {
        return this.activeOperations.has(operationId);
    }

    getActiveOperations() {
        return Array.from(this.activeOperations.keys());
    }

    destroy() {
        this.cancelAllOperations();
        
        // Remove progress listeners based on service name
        if (this.progressEvent === 'ollama') {
            window.api.settingsView.removeOnOllamaPullProgress(this.globalProgressHandler);
        } else if (this.progressEvent === 'whisper') {
            window.api.settingsView.removeOnWhisperDownloadProgress(this.globalProgressHandler);
        }
    }
}

let trackers = new Map();

export function getLocalProgressTracker(serviceName) {
    if (!trackers.has(serviceName)) {
        trackers.set(serviceName, new LocalProgressTracker(serviceName));
    }
    return trackers.get(serviceName);
}

export function destroyLocalProgressTracker(serviceName) {
    const tracker = trackers.get(serviceName);
    if (tracker) {
        tracker.destroy();
        trackers.delete(serviceName);
    }
}

export function destroyAllProgressTrackers() {
    for (const [name, tracker] of trackers) {
        tracker.destroy();
    }
    trackers.clear();
}

// Legacy compatibility exports
export function getOllamaProgressTracker() {
    return getLocalProgressTracker('ollama');
}

export function destroyOllamaProgressTracker() {
    destroyLocalProgressTracker('ollama');
}
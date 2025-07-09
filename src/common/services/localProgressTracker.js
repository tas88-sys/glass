export class LocalProgressTracker {
    constructor(serviceName) {
        this.serviceName = serviceName;
        this.activeOperations = new Map(); // operationId -> { controller, onProgress }
        this.ipcRenderer = window.require?.('electron')?.ipcRenderer;
        
        if (!this.ipcRenderer) {
            throw new Error(`${serviceName} requires Electron environment`);
        }
        
        this.globalProgressHandler = (event, data) => {
            const operation = this.activeOperations.get(data.model || data.modelId);
            if (operation && !operation.controller.signal.aborted) {
                operation.onProgress(data.progress);
            }
        };
        
        const progressEvents = {
            'ollama': 'ollama:pull-progress',
            'whisper': 'whisper:download-progress'
        };
        
        const eventName = progressEvents[serviceName.toLowerCase()] || `${serviceName}:progress`;
        this.progressEvent = eventName;
        this.ipcRenderer.on(eventName, this.globalProgressHandler);
    }

    async trackOperation(operationId, operationType, onProgress) {
        if (this.activeOperations.has(operationId)) {
            throw new Error(`${operationType} ${operationId} is already in progress`);
        }

        const controller = new AbortController();
        const operation = { controller, onProgress };
        this.activeOperations.set(operationId, operation);

        try {
            const ipcChannels = {
                'ollama': { install: 'ollama:pull-model' },
                'whisper': { download: 'whisper:download-model' }
            };
            
            const channel = ipcChannels[this.serviceName.toLowerCase()]?.[operationType] || 
                           `${this.serviceName}:${operationType}`;
            
            const result = await this.ipcRenderer.invoke(channel, operationId);
            
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
        if (this.ipcRenderer) {
            this.ipcRenderer.removeListener(this.progressEvent, this.globalProgressHandler);
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
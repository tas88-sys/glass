const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const LocalAIServiceBase = require('./localAIServiceBase');
const { spawnAsync } = require('../utils/spawnHelper');
const { DOWNLOAD_CHECKSUMS } = require('../config/checksums');

const fsPromises = fs.promises;

class WhisperService extends LocalAIServiceBase {
    constructor() {
        super('WhisperService');
        this.isInitialized = false;
        this.whisperPath = null;
        this.modelsDir = null;
        this.tempDir = null;
        this.availableModels = {
            'whisper-tiny': {
                name: 'Tiny',
                size: '39M',
                url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin'
            },
            'whisper-base': {
                name: 'Base',
                size: '74M',
                url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin'
            },
            'whisper-small': {
                name: 'Small',
                size: '244M',
                url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin'
            },
            'whisper-medium': {
                name: 'Medium',
                size: '769M',
                url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin'
            }
        };
    }

    async initialize() {
        if (this.isInitialized) return;

        try {
            const homeDir = os.homedir();
            const whisperDir = path.join(homeDir, '.glass', 'whisper');
            
            this.modelsDir = path.join(whisperDir, 'models');
            this.tempDir = path.join(whisperDir, 'temp');
            this.whisperPath = path.join(whisperDir, 'bin', 'whisper');

            await this.ensureDirectories();
            await this.ensureWhisperBinary();
            
            this.isInitialized = true;
            console.log('[WhisperService] Initialized successfully');
        } catch (error) {
            console.error('[WhisperService] Initialization failed:', error);
            throw error;
        }
    }

    async ensureDirectories() {
        await fsPromises.mkdir(this.modelsDir, { recursive: true });
        await fsPromises.mkdir(this.tempDir, { recursive: true });
        await fsPromises.mkdir(path.dirname(this.whisperPath), { recursive: true });
    }

    async ensureWhisperBinary() {
        const whisperCliPath = await this.checkCommand('whisper-cli');
        if (whisperCliPath) {
            this.whisperPath = whisperCliPath;
            console.log(`[WhisperService] Found whisper-cli at: ${this.whisperPath}`);
            return;
        }

        const whisperPath = await this.checkCommand('whisper');
        if (whisperPath) {
            this.whisperPath = whisperPath;
            console.log(`[WhisperService] Found whisper at: ${this.whisperPath}`);
            return;
        }

        try {
            await fsPromises.access(this.whisperPath, fs.constants.X_OK);
            console.log('[WhisperService] Custom whisper binary found');
            return;
        } catch (error) {
            // Continue to installation
        }

        const platform = this.getPlatform();
        if (platform === 'darwin') {
            console.log('[WhisperService] Whisper not found, trying Homebrew installation...');
            try {
                await this.installViaHomebrew();
                return;
            } catch (error) {
                console.log('[WhisperService] Homebrew installation failed:', error.message);
            }
        }

        await this.autoInstall();
    }

    async installViaHomebrew() {
        const brewPath = await this.checkCommand('brew');
        if (!brewPath) {
            throw new Error('Homebrew not found. Please install Homebrew first.');
        }

        console.log('[WhisperService] Installing whisper-cpp via Homebrew...');
        await spawnAsync('brew', ['install', 'whisper-cpp']);
        
        const whisperCliPath = await this.checkCommand('whisper-cli');
        if (whisperCliPath) {
            this.whisperPath = whisperCliPath;
            console.log(`[WhisperService] Whisper-cli installed via Homebrew at: ${this.whisperPath}`);
        } else {
            const whisperPath = await this.checkCommand('whisper');
            if (whisperPath) {
                this.whisperPath = whisperPath;
                console.log(`[WhisperService] Whisper installed via Homebrew at: ${this.whisperPath}`);
            }
        }
    }


    async ensureModelAvailable(modelId) {
        if (!this.isInitialized) {
            console.log('[WhisperService] Service not initialized, initializing now...');
            await this.initialize();
        }

        const modelInfo = this.availableModels[modelId];
        if (!modelInfo) {
            throw new Error(`Unknown model: ${modelId}. Available models: ${Object.keys(this.availableModels).join(', ')}`);
        }

        const modelPath = await this.getModelPath(modelId);
        try {
            await fsPromises.access(modelPath, fs.constants.R_OK);
            console.log(`[WhisperService] Model ${modelId} already available at: ${modelPath}`);
        } catch (error) {
            console.log(`[WhisperService] Model ${modelId} not found, downloading...`);
            await this.downloadModel(modelId);
        }
    }

    async downloadModel(modelId) {
        const modelInfo = this.availableModels[modelId];
        const modelPath = await this.getModelPath(modelId);
        const checksumInfo = DOWNLOAD_CHECKSUMS.whisper.models[modelId];
        
        this.emit('downloadProgress', { modelId, progress: 0 });
        
        await this.downloadWithRetry(modelInfo.url, modelPath, {
            expectedChecksum: checksumInfo?.sha256,
            onProgress: (progress) => {
                this.emit('downloadProgress', { modelId, progress });
            }
        });
        
        console.log(`[WhisperService] Model ${modelId} downloaded successfully`);
    }


    async getModelPath(modelId) {
        if (!this.isInitialized || !this.modelsDir) {
            throw new Error('WhisperService is not initialized. Call initialize() first.');
        }
        return path.join(this.modelsDir, `${modelId}.bin`);
    }

    async getWhisperPath() {
        return this.whisperPath;
    }

    async saveAudioToTemp(audioBuffer, sessionId = '') {
        const timestamp = Date.now();
        const random = Math.random().toString(36).substr(2, 6);
        const sessionPrefix = sessionId ? `${sessionId}_` : '';
        const tempFile = path.join(this.tempDir, `audio_${sessionPrefix}${timestamp}_${random}.wav`);
        
        const wavHeader = this.createWavHeader(audioBuffer.length);
        const wavBuffer = Buffer.concat([wavHeader, audioBuffer]);
        
        await fsPromises.writeFile(tempFile, wavBuffer);
        return tempFile;
    }

    createWavHeader(dataSize) {
        const header = Buffer.alloc(44);
        const sampleRate = 24000;
        const numChannels = 1;
        const bitsPerSample = 16;
        
        header.write('RIFF', 0);
        header.writeUInt32LE(36 + dataSize, 4);
        header.write('WAVE', 8);
        header.write('fmt ', 12);
        header.writeUInt32LE(16, 16);
        header.writeUInt16LE(1, 20);
        header.writeUInt16LE(numChannels, 22);
        header.writeUInt32LE(sampleRate, 24);
        header.writeUInt32LE(sampleRate * numChannels * bitsPerSample / 8, 28);
        header.writeUInt16LE(numChannels * bitsPerSample / 8, 32);
        header.writeUInt16LE(bitsPerSample, 34);
        header.write('data', 36);
        header.writeUInt32LE(dataSize, 40);
        
        return header;
    }

    async cleanupTempFile(filePath) {
        if (!filePath || typeof filePath !== 'string') {
            console.warn('[WhisperService] Invalid file path for cleanup:', filePath);
            return;
        }

        const filesToCleanup = [
            filePath,
            filePath.replace('.wav', '.txt'),
            filePath.replace('.wav', '.json')
        ];

        for (const file of filesToCleanup) {
            try {
                // Check if file exists before attempting to delete
                await fsPromises.access(file, fs.constants.F_OK);
                await fsPromises.unlink(file);
                console.log(`[WhisperService] Cleaned up: ${file}`);
            } catch (error) {
                // File doesn't exist or already deleted - this is normal
                if (error.code !== 'ENOENT') {
                    console.warn(`[WhisperService] Failed to cleanup ${file}:`, error.message);
                }
            }
        }
    }

    async getInstalledModels() {
        if (!this.isInitialized) {
            console.log('[WhisperService] Service not initialized for getInstalledModels, initializing now...');
            await this.initialize();
        }

        const models = [];
        for (const [modelId, modelInfo] of Object.entries(this.availableModels)) {
            try {
                const modelPath = await this.getModelPath(modelId);
                await fsPromises.access(modelPath, fs.constants.R_OK);
                models.push({
                    id: modelId,
                    name: modelInfo.name,
                    size: modelInfo.size,
                    installed: true
                });
            } catch (error) {
                models.push({
                    id: modelId,
                    name: modelInfo.name,
                    size: modelInfo.size,
                    installed: false
                });
            }
        }
        return models;
    }

    async isServiceRunning() {
        return this.isInitialized;
    }

    async startService() {
        if (!this.isInitialized) {
            await this.initialize();
        }
        return true;
    }

    async stopService() {
        return true;
    }

    async isInstalled() {
        try {
            const whisperPath = await this.checkCommand('whisper-cli') || await this.checkCommand('whisper');
            return !!whisperPath;
        } catch (error) {
            return false;
        }
    }

    async installMacOS() {
        throw new Error('Binary installation not available for macOS. Please install Homebrew and run: brew install whisper-cpp');
    }

    async installWindows() {
        console.log('[WhisperService] Installing Whisper on Windows...');
        const version = 'v1.7.6';
        const binaryUrl = `https://github.com/ggerganov/whisper.cpp/releases/download/${version}/whisper-cpp-${version}-win-x64.zip`;
        const tempFile = path.join(this.tempDir, 'whisper-binary.zip');
        
        try {
            await this.downloadWithRetry(binaryUrl, tempFile);
            const extractDir = path.dirname(this.whisperPath);
            await spawnAsync('powershell', ['-command', `Expand-Archive -Path '${tempFile}' -DestinationPath '${extractDir}' -Force`]);
            await fsPromises.unlink(tempFile);
            console.log('[WhisperService] Whisper installed successfully on Windows');
            return true;
        } catch (error) {
            console.error('[WhisperService] Windows installation failed:', error);
            throw new Error(`Failed to install Whisper on Windows: ${error.message}`);
        }
    }

    async installLinux() {
        console.log('[WhisperService] Installing Whisper on Linux...');
        const version = 'v1.7.6';
        const binaryUrl = `https://github.com/ggerganov/whisper.cpp/releases/download/${version}/whisper-cpp-${version}-linux-x64.tar.gz`;
        const tempFile = path.join(this.tempDir, 'whisper-binary.tar.gz');
        
        try {
            await this.downloadWithRetry(binaryUrl, tempFile);
            const extractDir = path.dirname(this.whisperPath);
            await spawnAsync('tar', ['-xzf', tempFile, '-C', extractDir, '--strip-components=1']);
            await spawnAsync('chmod', ['+x', this.whisperPath]);
            await fsPromises.unlink(tempFile);
            console.log('[WhisperService] Whisper installed successfully on Linux');
            return true;
        } catch (error) {
            console.error('[WhisperService] Linux installation failed:', error);
            throw new Error(`Failed to install Whisper on Linux: ${error.message}`);
        }
    }

    async shutdownMacOS(force) {
        return true;
    }

    async shutdownWindows(force) {
        return true;
    }

    async shutdownLinux(force) {
        return true;
    }
}

module.exports = { WhisperService };
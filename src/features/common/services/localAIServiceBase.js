const { exec } = require('child_process');
const { promisify } = require('util');
const { EventEmitter } = require('events');
const path = require('path');
const os = require('os');
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');

const execAsync = promisify(exec);

class LocalAIServiceBase extends EventEmitter {
    constructor(serviceName) {
        super();
        this.serviceName = serviceName;
        this.baseUrl = null;
        this.installationProgress = new Map();
    }

    getPlatform() {
        return process.platform;
    }

    async checkCommand(command) {
        try {
            const platform = this.getPlatform();
            const checkCmd = platform === 'win32' ? 'where' : 'which';
            const { stdout } = await execAsync(`${checkCmd} ${command}`);
            return stdout.trim();
        } catch (error) {
            return null;
        }
    }

    async isInstalled() {
        throw new Error('isInstalled() must be implemented by subclass');
    }

    async isServiceRunning() {
        throw new Error('isServiceRunning() must be implemented by subclass');
    }

    async startService() {
        throw new Error('startService() must be implemented by subclass');
    }

    async stopService() {
        throw new Error('stopService() must be implemented by subclass');
    }

    async waitForService(checkFn, maxAttempts = 30, delayMs = 1000) {
        for (let i = 0; i < maxAttempts; i++) {
            if (await checkFn()) {
                console.log(`[${this.serviceName}] Service is ready`);
                return true;
            }
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
        throw new Error(`${this.serviceName} service failed to start within timeout`);
    }

    getInstallProgress(modelName) {
        return this.installationProgress.get(modelName) || 0;
    }

    setInstallProgress(modelName, progress) {
        this.installationProgress.set(modelName, progress);
        this.emit('install-progress', { model: modelName, progress });
    }

    clearInstallProgress(modelName) {
        this.installationProgress.delete(modelName);
    }

    async autoInstall(onProgress) {
        const platform = this.getPlatform();
        console.log(`[${this.serviceName}] Starting auto-installation for ${platform}`);
        
        try {
            switch(platform) {
                case 'darwin':
                    return await this.installMacOS(onProgress);
                case 'win32':
                    return await this.installWindows(onProgress);
                case 'linux':
                    return await this.installLinux();
                default:
                    throw new Error(`Unsupported platform: ${platform}`);
            }
        } catch (error) {
            console.error(`[${this.serviceName}] Auto-installation failed:`, error);
            throw error;
        }
    }

    async installMacOS() {
        throw new Error('installMacOS() must be implemented by subclass');
    }

    async installWindows() {
        throw new Error('installWindows() must be implemented by subclass');
    }

    async installLinux() {
        throw new Error('installLinux() must be implemented by subclass');
    }

    // parseProgress method removed - using proper REST API now

    async shutdown(force = false) {
        console.log(`[${this.serviceName}] Starting ${force ? 'forced' : 'graceful'} shutdown...`);
        
        const isRunning = await this.isServiceRunning();
        if (!isRunning) {
            console.log(`[${this.serviceName}] Service not running, nothing to shutdown`);
            return true;
        }

        const platform = this.getPlatform();
        
        try {
            switch(platform) {
                case 'darwin':
                    return await this.shutdownMacOS(force);
                case 'win32':
                    return await this.shutdownWindows(force);
                case 'linux':
                    return await this.shutdownLinux(force);
                default:
                    console.warn(`[${this.serviceName}] Unsupported platform for shutdown: ${platform}`);
                    return false;
            }
        } catch (error) {
            console.error(`[${this.serviceName}] Error during shutdown:`, error);
            return false;
        }
    }

    async shutdownMacOS(force) {
        throw new Error('shutdownMacOS() must be implemented by subclass');
    }

    async shutdownWindows(force) {
        throw new Error('shutdownWindows() must be implemented by subclass');
    }

    async shutdownLinux(force) {
        throw new Error('shutdownLinux() must be implemented by subclass');
    }

    async downloadFile(url, destination, options = {}) {
        const { 
            onProgress = null,
            headers = { 'User-Agent': 'Glass-App' },
            timeout = 300000 // 5 minutes default
        } = options;

        return new Promise((resolve, reject) => {
            const file = fs.createWriteStream(destination);
            let downloadedSize = 0;
            let totalSize = 0;

            const request = https.get(url, { headers }, (response) => {
                // Handle redirects (301, 302, 307, 308)
                if ([301, 302, 307, 308].includes(response.statusCode)) {
                    file.close();
                    fs.unlink(destination, () => {});
                    
                    if (!response.headers.location) {
                        reject(new Error('Redirect without location header'));
                        return;
                    }
                    
                    console.log(`[${this.serviceName}] Following redirect from ${url} to ${response.headers.location}`);
                    this.downloadFile(response.headers.location, destination, options)
                        .then(resolve)
                        .catch(reject);
                    return;
                }

                if (response.statusCode !== 200) {
                    file.close();
                    fs.unlink(destination, () => {});
                    reject(new Error(`Download failed: ${response.statusCode} ${response.statusMessage}`));
                    return;
                }

                totalSize = parseInt(response.headers['content-length'], 10) || 0;

                response.on('data', (chunk) => {
                    downloadedSize += chunk.length;
                    
                    if (onProgress && totalSize > 0) {
                        const progress = Math.round((downloadedSize / totalSize) * 100);
                        onProgress(progress, downloadedSize, totalSize);
                    }
                });

                response.pipe(file);

                file.on('finish', () => {
                    file.close(() => {
                        this.emit('download-complete', { url, destination, size: downloadedSize });
                        resolve({ success: true, size: downloadedSize });
                    });
                });
            });

            request.on('timeout', () => {
                request.destroy();
                file.close();
                fs.unlink(destination, () => {});
                reject(new Error('Download timeout'));
            });

            request.on('error', (err) => {
                file.close();
                fs.unlink(destination, () => {});
                this.emit('download-error', { url, error: err });
                reject(err);
            });

            request.setTimeout(timeout);

            file.on('error', (err) => {
                fs.unlink(destination, () => {});
                reject(err);
            });
        });
    }

    async downloadWithRetry(url, destination, options = {}) {
        const { maxRetries = 3, retryDelay = 1000, expectedChecksum = null, ...downloadOptions } = options;
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const result = await this.downloadFile(url, destination, downloadOptions);
                
                if (expectedChecksum) {
                    const isValid = await this.verifyChecksum(destination, expectedChecksum);
                    if (!isValid) {
                        fs.unlinkSync(destination);
                        throw new Error('Checksum verification failed');
                    }
                    console.log(`[${this.serviceName}] Checksum verified successfully`);
                }
                
                return result;
            } catch (error) {
                if (attempt === maxRetries) {
                    throw error;
                }
                
                console.log(`Download attempt ${attempt} failed, retrying in ${retryDelay}ms...`);
                await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
            }
        }
    }

    async verifyChecksum(filePath, expectedChecksum) {
        return new Promise((resolve, reject) => {
            const hash = crypto.createHash('sha256');
            const stream = fs.createReadStream(filePath);
            
            stream.on('data', (data) => hash.update(data));
            stream.on('end', () => {
                const fileChecksum = hash.digest('hex');
                console.log(`[${this.serviceName}] File checksum: ${fileChecksum}`);
                console.log(`[${this.serviceName}] Expected checksum: ${expectedChecksum}`);
                resolve(fileChecksum === expectedChecksum);
            });
            stream.on('error', reject);
        });
    }
}

module.exports = LocalAIServiceBase;
const crypto = require('crypto');
const { app } = require('electron');
const os = require('os');

class CryptoService {
    constructor() {
        this.algorithm = 'aes-256-gcm';
        this.saltLength = 32;
        this.tagLength = 16;
        this.ivLength = 16;
        this.iterations = 100000;
        this.keyLength = 32;
        this._derivedKey = null;
    }

    _getMachineId() {
        const machineInfo = `${os.hostname()}-${os.platform()}-${os.arch()}`;
        const appPath = app.getPath('userData');
        return crypto.createHash('sha256').update(machineInfo + appPath).digest('hex');
    }

    _deriveKey() {
        if (this._derivedKey) return this._derivedKey;
        
        const machineId = this._getMachineId();
        const salt = crypto.createHash('sha256').update('pickle-glass-salt').digest();
        this._derivedKey = crypto.pbkdf2Sync(machineId, salt, this.iterations, this.keyLength, 'sha256');
        return this._derivedKey;
    }

    encrypt(text) {
        if (!text) return null;
        
        try {
            const iv = crypto.randomBytes(this.ivLength);
            const salt = crypto.randomBytes(this.saltLength);
            const key = this._deriveKey();
            
            const cipher = crypto.createCipheriv(this.algorithm, key, iv);
            
            const encrypted = Buffer.concat([
                cipher.update(text, 'utf8'),
                cipher.final()
            ]);
            
            const tag = cipher.getAuthTag();
            
            const combined = Buffer.concat([salt, iv, tag, encrypted]);
            return combined.toString('base64');
        } catch (error) {
            console.error('[CryptoService] Encryption failed:', error.message);
            throw new Error('Encryption failed');
        }
    }

    decrypt(encryptedData) {
        if (!encryptedData) return null;
        
        try {
            const combined = Buffer.from(encryptedData, 'base64');
            
            const salt = combined.slice(0, this.saltLength);
            const iv = combined.slice(this.saltLength, this.saltLength + this.ivLength);
            const tag = combined.slice(this.saltLength + this.ivLength, this.saltLength + this.ivLength + this.tagLength);
            const encrypted = combined.slice(this.saltLength + this.ivLength + this.tagLength);
            
            const key = this._deriveKey();
            
            const decipher = crypto.createDecipheriv(this.algorithm, key, iv);
            decipher.setAuthTag(tag);
            
            const decrypted = Buffer.concat([
                decipher.update(encrypted),
                decipher.final()
            ]);
            
            return decrypted.toString('utf8');
        } catch (error) {
            console.error('[CryptoService] Decryption failed:', error.message);
            throw new Error('Decryption failed');
        }
    }

    clearCache() {
        this._derivedKey = null;
    }
}

module.exports = new CryptoService();
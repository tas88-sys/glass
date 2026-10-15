// Encrypted OmniRoute backup into a synced folder (Google Drive).
//
//   node backup-to-drive.mjs                               make a backup
//   node backup-to-drive.mjs decrypt <backup folder> <out> decrypt into <out> (never into the live data folder)
//
// What goes in: the database snapshot (omniroute backup create, safe while the server runs) and
// .env (it holds STORAGE_ENCRYPTION_KEY, without which the provider credentials in the database
// cannot be read). Both are encrypted with AES-256-GCM, passphrase in ~/.omniroute/backup.key, which
// is created on the first run and never leaves this machine: copy it to a password manager.
// File format, same as omniroute's own --encrypt: salt(16) + iv(12) + authTag(16) + ciphertext.

import { execFileSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = join(homedir(), '.omniroute');
const DEST_ROOT = process.env.OMNIROUTE_BACKUP_DIR || 'G:/My Drive/Software/glass/omniroute-backups';
const KEEP = 14;
const KEY_FILE = join(DATA_DIR, 'backup.key');

function passphrase() {
    if (!existsSync(KEY_FILE)) writeFileSync(KEY_FILE, randomBytes(32).toString('base64'), { flag: 'wx' });
    return readFileSync(KEY_FILE, 'utf8').trim();
}

function encrypt(plain, pass) {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', scryptSync(pass, salt, 32), iv);
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([salt, iv, cipher.getAuthTag(), body]);
}

function decrypt(buf, pass) {
    const decipher = createDecipheriv('aes-256-gcm', scryptSync(pass, buf.subarray(0, 16), 32), buf.subarray(16, 28));
    decipher.setAuthTag(buf.subarray(28, 44));
    return Buffer.concat([decipher.update(buf.subarray(44)), decipher.final()]);
}

function backup() {
    if (!existsSync(join(DEST_ROOT, '..'))) throw new Error(`destination folder not found (is Google Drive running?): ${DEST_ROOT}`);
    const pass = passphrase();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const staging = `stage-${stamp}`;
    const cmd = join(process.env.APPDATA || '', 'npm', 'omniroute.cmd');
    // Run from the data folder: omniroute reads .env from the current folder too.
    execFileSync('cmd.exe', ['/c', cmd, 'backup', 'create', '--name', staging], { cwd: DATA_DIR, stdio: 'pipe' });
    const stagingDir = join(DATA_DIR, 'backups', `omniroute-backup-${staging}`);
    try {
        const db = readFileSync(join(stagingDir, 'storage.sqlite'));
        const out = join(DEST_ROOT, stamp);
        mkdirSync(out, { recursive: true });
        writeFileSync(join(out, 'storage.sqlite.enc'), encrypt(db, pass));
        writeFileSync(join(out, 'env.enc'), encrypt(readFileSync(join(DATA_DIR, '.env')), pass));
        writeFileSync(join(out, 'manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(), files: ['storage.sqlite.enc', 'env.enc'], cipher: 'aes-256-gcm' }, null, 2));
        const old = readdirSync(DEST_ROOT).filter(n => /^\d{4}-\d\d-\d\dT/.test(n)).sort().reverse().slice(KEEP);
        for (const n of old) rmSync(join(DEST_ROOT, n), { recursive: true, force: true });
        console.log(`backup ok: ${out} (${db.length} bytes of database, ${old.length} old removed)`);
    } finally {
        rmSync(stagingDir, { recursive: true, force: true });
    }
}

function restoreTo(from, to) {
    const pass = passphrase();
    mkdirSync(to, { recursive: true });
    writeFileSync(join(to, 'storage.sqlite'), decrypt(readFileSync(join(from, 'storage.sqlite.enc')), pass));
    writeFileSync(join(to, '.env'), decrypt(readFileSync(join(from, 'env.enc')), pass));
    console.log(`decrypted into ${to}. Stop OmniRoute, then copy both files into ${DATA_DIR} (and delete storage.sqlite-wal and -shm there).`);
}

try {
    const [mode, from, to] = process.argv.slice(2);
    if (mode === 'decrypt') {
        if (!from || !to) throw new Error('usage: decrypt <backup folder> <out folder>');
        restoreTo(from, to);
    } else {
        backup();
    }
} catch (err) {
    console.error(`backup failed: ${err.message}`);
    process.exit(1);
}

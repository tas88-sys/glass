'use strict';

// Where the app keeps its career vectors: Electron's userData for this app
// (app.getPath('userData')) plus career-kb, as embedder.js uses it. The eval
// and ask scripts share it, so neither embeds the notes a second time.

const os = require('node:os');
const path = require('node:path');

function appCacheDir() {
    let name = 'Glass';
    try {
        const pkg = require('../package.json');
        name = pkg.productName || pkg.name || name;
    } catch {
        /* keep the default */
    }
    const home = os.homedir();
    const base = process.platform === 'win32' ? process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
        : process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
            : process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    return path.join(base, name, 'career-kb');
}

module.exports = { appCacheDir };

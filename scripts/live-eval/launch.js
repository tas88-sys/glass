'use strict';

// npm run eval:live -- [options]: runs run.js with the Node inside Electron
// (ELECTRON_RUN_AS_NODE), the runtime the app's main process uses. Its
// better-sqlite3 build loads there, so run.js can read the app's settings.

const { spawn } = require('node:child_process');
const path = require('node:path');

const electron = require('electron');
const child = spawn(electron, [path.join(__dirname, 'run.js'), ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});
child.on('exit', code => process.exit(code == null ? 2 : code));
child.on('error', err => {
    process.stderr.write(`could not start Electron: ${err.message}\n`);
    process.exit(2);
});

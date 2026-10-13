'use strict';

// The Ask scenarios' "screenshots": an SVG fixture rendered to the JPEG the
// app sends on Windows (askService captureScreenshot: desktopCapturer
// thumbnail 1920x1080, toJPEG(70)), as base64.

const fs = require('node:fs');
const path = require('node:path');

/**
 * @param {string} svgFile
 * @param {string} [saveTo] - also write the JPEG here (for the report)
 * @returns {Promise<{ base64: string, bytes: number, width: number, height: number }>}
 */
async function renderScreenshot(svgFile, saveTo) {
    const sharp = require('sharp');
    const jpeg = await sharp(fs.readFileSync(svgFile), { density: 96 })
        .resize({ width: 1920, height: 1080, fit: 'contain', background: '#000' })
        .flatten({ background: '#000' })
        .jpeg({ quality: 70 })
        .toBuffer();
    if (saveTo) {
        fs.mkdirSync(path.dirname(saveTo), { recursive: true });
        fs.writeFileSync(saveTo, jpeg);
    }
    return { base64: jpeg.toString('base64'), bytes: jpeg.length, width: 1920, height: 1080 };
}

module.exports = { renderScreenshot };

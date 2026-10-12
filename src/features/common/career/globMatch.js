'use strict';

// Minimal glob support for the KB manifest (spec C6: Electron 30 runs Node 20,
// which has no fs.glob). Supports `*` (within one path segment), `**` (any
// depth) and `?`. Paths are relative to the KB root and use forward slashes.

const ALWAYS_EXCLUDED = ['**/.git/**', '**/node_modules/**'];

/**
 * @param {string} glob
 * @returns {RegExp} anchored at both ends
 */
function globToRegExp(glob) {
    const g = String(glob);
    let re = '';
    let i = 0;
    while (i < g.length) {
        const c = g[i];
        if (c === '*' && g[i + 1] === '*') {
            if (g[i + 2] === '/') {
                re += '(?:.*/)?';               // "**/" → zero or more directories
                i += 3;
            } else {
                re += '.*';
                i += 2;
            }
            continue;
        }
        if (c === '/' && g.slice(i) === '/**') {
            re += '(?:/.*)?';                   // trailing "/**" → the folder and anything under it
            break;
        }
        if (c === '*') re += '[^/]*';
        else if (c === '?') re += '[^/]';
        else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        i++;
    }
    return new RegExp(`^${re}$`);
}

/**
 * Keep manifest entries that are relative paths inside the root (E4): drops
 * non-strings, absolute paths, drive letters and any ".." segment. Backslashes
 * become forward slashes and a leading "./" is removed.
 * @param {unknown} list
 * @returns {string[]}
 */
function sanitizePatterns(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const raw of list) {
        if (typeof raw !== 'string') continue;
        const p = raw.trim().replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
        if (!p || p.startsWith('/') || /^[a-zA-Z]:/.test(p)) continue;
        if (p.split('/').includes('..')) continue;
        out.push(p);
    }
    return out;
}

/**
 * Include/exclude filter for KB paths. Exclude wins; `.git` and `node_modules`
 * are always excluded.
 * @param {string[]} include
 * @param {string[]} exclude
 */
function compilePathFilter(include, exclude) {
    const inc = include.map(globToRegExp);
    const exc = exclude.concat(ALWAYS_EXCLUDED).map(globToRegExp);
    const excluded = p => exc.some(re => re.test(p));
    return {
        matchesFile: relPath => !excluded(relPath) && inc.some(re => re.test(relPath)),
        // Prune a directory only when an exclude pattern covers everything under
        // it at any depth ("drafts/**"), probed with a name no literal can match.
        excludesDir: relDir => excluded(`${relDir}/\0/\0`),
    };
}

module.exports = { globToRegExp, sanitizePatterns, compilePathFilter };

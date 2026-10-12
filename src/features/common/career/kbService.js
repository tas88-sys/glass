'use strict';

// Knowledge-base loader (FR-001, FR-002, FR-004, FR-005, FR-016, FR-017).
// Reads the optional glass-kb.json manifest, walks the KB folder, chunks the
// included notes and builds the BM25 index. A refresh re-reads only files whose
// mtime or size changed, and drops deleted ones. Never throws: per-file errors
// skip that file; an unusable root yields null.

const fsp = require('node:fs/promises');
const nodePath = require('node:path');

const { chunkMarkdown, MARKER_RE } = require('./chunker');
const { buildBm25 } = require('./bm25');
const { sanitizePatterns, compilePathFilter } = require('./globMatch');
const { slugify } = require('./textNormalize');

const MANIFEST_FILE = 'glass-kb.json';
const DEFAULT_INCLUDE = ['**/*.md', '**/*.txt'];
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const strings = list => (Array.isArray(list) ? list.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()) : []);

/**
 * Normalize the manifest text. Invalid JSON, a non-object or an unknown
 * version → defaults with valid=false (E3). Paths escaping the root are
 * dropped (E4).
 * @param {string|null} raw
 */
function parseManifest(raw) {
    const defaults = { valid: false, include: DEFAULT_INCLUDE.slice(), exclude: [], core: [], entities: [], companies: null };
    if (typeof raw !== 'string') return defaults;
    let m;
    try {
        m = JSON.parse(raw);
    } catch {
        return defaults;
    }
    if (!m || typeof m !== 'object' || m.version !== 1) return defaults;

    const include = sanitizePatterns(m.include);
    let companies = null;
    const c = m.companies;
    if (c && typeof c === 'object') {
        const [root] = sanitizePatterns([c.root]);
        if (root) {
            const aliases = {};
            if (c.aliases && typeof c.aliases === 'object') {
                for (const [folder, names] of Object.entries(c.aliases)) aliases[folder] = strings(names);
            }
            companies = { root: root.replace(/\/+$/, ''), skip: strings(c.skip), aliases };
        }
    }
    return {
        valid: true,
        include: include.length ? include : DEFAULT_INCLUDE.slice(),
        exclude: sanitizePatterns(m.exclude),
        core: sanitizePatterns(m.core),
        entities: strings(m.entities),
        companies,
    };
}

function fileLabel(rel) {
    return rel.split('/').pop().replace(/\.[^.]+$/, '');
}

/** FR-005 company set for a KB-relative path. */
function companiesFor(rel, companies) {
    if (!companies) return [];
    const prefix = `${companies.root}/`;
    if (!rel.startsWith(prefix)) return [];
    const parts = rel.slice(prefix.length).split('/');
    if (parts.length < 2) return [];                       // a file directly under the root
    const folder = parts[0];
    if (companies.skip.includes(folder)) return [];
    const names = companies.aliases[folder];
    if (!names || names.length === 0) return [folder];
    const fileSlug = slugify(fileLabel(rel));
    const narrowed = names.filter(n => {
        const s = slugify(n);
        return s && fileSlug.includes(s);
    });
    return narrowed.length ? narrowed : names.slice();
}

/** Names interviewers may say, one per slug: aliases, or the folder name. */
function companyNamesFor(folders, companies) {
    if (!companies) return [];
    const bySlug = new Map();
    for (const folder of folders) {
        if (companies.skip.includes(folder)) continue;
        const names = companies.aliases[folder];
        for (const n of names && names.length ? names : [folder]) {
            const s = slugify(n);
            if (s && !bySlug.has(s)) bySlug.set(s, n);
        }
    }
    return [...bySlug.values()];
}

/**
 * @param {{ root: string, fs?: typeof fsp, log?: (line: string) => void }} opts
 */
function createKbService({ root, fs = fsp, log = () => {} }) {
    const absRoot = nodePath.resolve(root);
    /** @type {Map<string, {mtimeMs:number, size:number, chunks:object[]}>} */
    let cache = new Map();
    let manifestRaw;                // undefined until the first refresh
    let snap = null;

    async function readText(abs) {
        const text = await fs.readFile(abs, 'utf8');
        return text.replace(/^\uFEFF/, '');
    }

    async function walk(filter, onFile, onCompanyFolder, companies) {
        const stack = [''];
        while (stack.length) {
            const relDir = stack.pop();
            let entries;
            try {
                entries = await fs.readdir(relDir ? nodePath.join(absRoot, relDir) : absRoot, { withFileTypes: true });
            } catch (err) {
                if (!relDir) throw err;
                log(`[career] skip folder (${err.code || 'error'})`);
                continue;
            }
            for (const e of entries) {
                const rel = relDir ? `${relDir}/${e.name}` : e.name;
                if (e.isDirectory()) {
                    if (filter.excludesDir(rel)) continue;
                    if (companies && relDir === companies.root) onCompanyFolder(e.name);
                    stack.push(rel);
                } else if (e.isFile()) {
                    onFile(rel);
                }
            }
        }
    }

    async function refresh() {
        try {
            const stat = await fs.stat(absRoot);
            if (!stat.isDirectory()) return (snap = null);
        } catch {
            return (snap = null);
        }

        let raw = null;
        try {
            raw = await readText(nodePath.join(absRoot, MANIFEST_FILE));
        } catch {
            raw = null;
        }
        const manifest = parseManifest(raw);
        if (raw !== null && !manifest.valid) log('[career] glass-kb.json ignored (invalid JSON or unknown version); using defaults');
        if (raw !== manifestRaw) {
            cache = new Map();          // tags and filters depend on the manifest
            manifestRaw = raw;
        }

        const filter = compilePathFilter(manifest.include, manifest.exclude);
        const coreSet = new Set(manifest.core);
        const files = [];
        const companyFolders = [];
        try {
            await walk(filter, rel => {
                if (rel === MANIFEST_FILE || coreSet.has(rel)) return;
                if (filter.matchesFile(rel)) files.push(rel);
            }, folder => companyFolders.push(folder), manifest.companies);
        } catch {
            return (snap = null);
        }
        files.sort();

        let changed = !snap;
        const next = new Map();
        for (const rel of files) {
            const abs = nodePath.join(absRoot, rel);
            try {
                const st = await fs.stat(abs);
                if (st.size > MAX_FILE_BYTES) {
                    log(`[career] skip large file (${st.size} bytes)`);
                    continue;
                }
                const prev = cache.get(rel);
                if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) {
                    next.set(rel, prev);
                    continue;
                }
                const text = await readText(abs);
                const chunks = chunkMarkdown(rel, text, {
                    mtime: Math.round(st.mtimeMs),
                    companiesOf: p => companiesFor(p, manifest.companies),
                });
                next.set(rel, { mtimeMs: st.mtimeMs, size: st.size, chunks });
                changed = true;
            } catch (err) {
                log(`[career] skip file (${err.code || err.name || 'error'})`);   // E5
            }
        }
        if (next.size !== cache.size) changed = true;
        cache = next;

        const coreParts = [];
        for (const rel of manifest.core) {
            try {
                const text = await readText(nodePath.join(absRoot, rel));
                coreParts.push(text.split(/\r?\n/).filter(l => !MARKER_RE.test(l)).join('\n').trim());
            } catch (err) {
                log(`[career] core file unreadable (${err.code || 'error'})`);
            }
        }
        const core = coreParts.filter(Boolean).join('\n\n');

        const entities = manifest.entities;
        const companyNames = companyNamesFor(companyFolders.sort(), manifest.companies);
        if (!changed && snap && snap.core === core) {
            snap = { ...snap, entities, companyNames, refreshedAt: Date.now() };
            return snap;
        }

        const chunks = [];
        for (const rel of files) {
            const entry = cache.get(rel);
            if (entry) chunks.push(...entry.chunks);
        }
        snap = {
            root: absRoot,
            files: cache.size,
            chunks,
            bm25: changed || !snap ? buildBm25(chunks) : snap.bm25,
            core,
            entities,
            companyNames,
            refreshedAt: Date.now(),
        };
        return snap;
    }

    return {
        root: absRoot,
        refresh: async () => {
            try {
                return await refresh();
            } catch (err) {
                log(`[career] refresh failed (${err.name || 'error'})`);
                return (snap = null);
            }
        },
        snapshot: () => snap,
    };
}

module.exports = { createKbService, parseManifest, companiesFor, MANIFEST_FILE };

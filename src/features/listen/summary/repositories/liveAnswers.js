'use strict';

// Live answers kept on this machine (spec 2026-10-13-live-answer-history).
// One row per answer the Listen lane started: the interviewer's turn, the
// answer as it last stood on screen, how it ended, the model, the career route
// and the notes it drew on. Local SQLite only: never synced, skipped while
// signed in to Firebase (whose sessions live elsewhere), deleted with the
// session. LIVE_ANSWER_HISTORY=0 turns it off.

const crypto = require('node:crypto');

const STATUSES = ['answer', 'passive', 'empty', 'replaced', 'error'];
const MAX_TEXT_CHARS = 20000;

const clip = v => (typeof v === 'string' ? (v.length > MAX_TEXT_CHARS ? v.slice(0, MAX_TEXT_CHARS) : v) : null);
const int = v => (Number.isFinite(v) ? Math.round(v) : null);
const json = v => (Array.isArray(v) && v.length ? clip(JSON.stringify(v)) : null);

/**
 * @param {{ getDb: () => { prepare: Function }, isLocal?: () => boolean, env?: object, now?: () => number }} deps
 */
function createLiveAnswerRepository({ getDb, isLocal = () => true, env = process.env, now = Date.now }) {
    const enabled = () => env.LIVE_ANSWER_HISTORY !== '0' && !!isLocal();

    /**
     * @param {{ sessionId: string, askedAt?: number, turn?: string, question?: string, answer?: string,
     *           status: string, error?: string, model?: string, route?: string, routeSource?: string,
     *           cue?: string, sources?: string[], unverified?: string[], firstTokenMs?: number, totalMs?: number }} r
     * @returns {{ id: string }|null} null when off, signed in, or the row has no session
     */
    function save(r) {
        if (!r || typeof r.sessionId !== 'string' || !r.sessionId || !enabled()) return null;
        const status = STATUSES.includes(r.status) ? r.status : 'error';
        const id = crypto.randomUUID();
        const t = now();
        getDb().prepare(
            `INSERT INTO live_answers (id, session_id, asked_at_ms, turn, question, answer, status, error, model,
                route, route_source, cue, sources_json, unverified_json, first_token_ms, total_ms, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
            id, r.sessionId, int(r.askedAt) ?? t, clip(r.turn), clip(r.question), clip(r.answer) ?? '', status,
            clip(r.error), clip(r.model), clip(r.route), clip(r.routeSource), clip(r.cue),
            json(r.sources), json(r.unverified), int(r.firstTokenMs), int(r.totalMs), Math.floor(t / 1000)
        );
        return { id };
    }

    /** The session's answers in the order they were asked. */
    function getBySessionId(sessionId) {
        return getDb().prepare('SELECT * FROM live_answers WHERE session_id = ? ORDER BY asked_at_ms ASC, created_at ASC').all(sessionId);
    }

    return { save, getBySessionId, enabled };
}

let shared = null;
/** The app's repository: the app DB, local sessions only. */
function liveAnswerRepository() {
    if (!shared) {
        const sqliteClient = require('../../../common/services/sqliteClient');
        const authService = require('../../../common/services/authService');
        shared = createLiveAnswerRepository({
            getDb: () => sqliteClient.getDb(),
            isLocal: () => {
                const user = authService.getCurrentUser();
                return !(user && user.isLoggedIn);
            },
        });
    }
    return shared;
}

module.exports = { createLiveAnswerRepository, liveAnswerRepository, STATUSES, MAX_TEXT_CHARS };

/**
 * LiveAnswerView.js
 *
 * Lit element <live-answer-view> — renders the streaming live answer lane
 * (FR-014/FR-015/FR-016) as an in-session, newest-first HISTORY of answers.
 *
 * Design rules (LOCKED — do not re-derive):
 *   Render model: render() emits each answer's body as an EMPTY container
 *           (<div class="answer-body" data-answer-id> — NO Lit child binding);
 *           updated() → renderAnswers() owns its content: plain text until the
 *           markdown libs load, then sanitized markdown. The body is
 *           deliberately NOT a Lit `${text}` child — binding the text in the
 *           template AND overwriting innerHTML is a Lit anti-pattern that, under
 *           per-token streaming, corrupts the child binding and freezes the
 *           answer mid-stream (only a full re-render recovered it). Lit owns
 *           ONLY the attribute; renderAnswers owns the children — no conflict.
 *           Source of truth is `this.answers`, NOT the DOM, so a re-show (the
 *           transcript↔insights toggle) re-renders from state and never blanks.
 *   History: newest answer on top; each answer keyed by a stable `id` from the
 *           service (streaming deltas update the same entry; a new question
 *           pushes a new entry). Capped to MAX_ANSWERS. In-session only — NOT
 *           persisted (spec C8); resetAnswer() clears it on session reset.
 *   Safety: answer text NEVER logged to any capturable sink.
 *   FR-013: subscribes via window.api.summaryView.onLiveAnswerUpdate.
 *   FR-016: resetAnswer() clears the panel on explicit session reset ONLY.
 */

import { html, css, LitElement } from '../../assets/lit-core-2.7.4.min.js';
import { applyLiveAnswerUpdate } from './liveAnswerHistory.js';

export class LiveAnswerView extends LitElement {
    static styles = css`
        :host {
            display: block;
            width: 100%;
        }

        .live-answer-container {
            padding: 8px 16px 12px;
            max-height: 280px;
            overflow-y: auto;
        }

        .live-answer-container::-webkit-scrollbar {
            width: 8px;
        }
        .live-answer-container::-webkit-scrollbar-track {
            background: rgba(0, 0, 0, 0.1);
            border-radius: 4px;
        }
        .live-answer-container::-webkit-scrollbar-thumb {
            background: rgba(255, 255, 255, 0.3);
            border-radius: 4px;
        }

        .live-answer-container pre {
            background: rgba(0, 0, 0, 0.4) !important;
            border-radius: 8px !important;
            padding: 12px !important;
            margin: 8px 0 !important;
            overflow-x: auto !important;
            border: 1px solid rgba(255, 255, 255, 0.1) !important;
            white-space: pre !important;
            word-wrap: normal !important;
            word-break: normal !important;
        }

        .live-answer-container code {
            font-family: 'Monaco', 'Menlo', 'Consolas', monospace !important;
            font-size: 11px !important;
            background: transparent !important;
            white-space: pre !important;
            word-wrap: normal !important;
            word-break: normal !important;
        }

        .live-answer-container pre code {
            white-space: pre !important;
            word-wrap: normal !important;
            word-break: normal !important;
            display: block !important;
        }

        .live-answer-container p {
            margin: 4px 0;
            line-height: 1.5;
        }

        .live-answer-container ul,
        .live-answer-container ol {
            padding-left: 16px;
            margin: 4px 0;
        }

        .live-answer-container li {
            margin: 2px 0;
            line-height: 1.4;
        }

        .live-answer-container h1,
        .live-answer-container h2,
        .live-answer-container h3 {
            font-size: 13px;
            font-weight: 600;
            margin: 6px 0 4px;
            color: #f8f8f2;
        }

        .live-answer-container strong {
            font-weight: 600;
            color: #f8f8f2;
        }

        .live-answer-container em {
            font-style: italic;
            color: #f1fa8c;
        }

        .lane-eyebrow {
            font-size: 10px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            color: rgba(255, 255, 255, 0.45);
            margin-bottom: 8px;
        }

        .answer-block {
            padding-bottom: 10px;
            margin-bottom: 10px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        }

        .answer-block:last-child {
            border-bottom: none;
            padding-bottom: 0;
            margin-bottom: 0;
        }

        .answer-question {
            display: -webkit-box;
            -webkit-line-clamp: 2;
            -webkit-box-orient: vertical;
            overflow: hidden;
            font-size: 11px;
            font-style: italic;
            color: rgba(255, 255, 255, 0.55);
            margin-bottom: 4px;
        }

        .answer-question::before {
            content: 'Q: ';
            font-style: normal;
            font-weight: 600;
            color: rgba(255, 255, 255, 0.4);
        }

        .answer-body {
            font-size: 12px;
            line-height: 1.5;
            color: rgba(255, 255, 255, 0.9);
            word-break: break-word;
        }

        /* Past answers fade back so the current one reads first. */
        .answer-block.past .answer-body {
            opacity: 0.72;
        }
    `;

    static properties = {
        /** Reactive: newest-first list of { id, question, text, ts }. */
        answers: { type: Array },
        /** Reactive: visibility, bound to viewMode === 'insights'. */
        isVisible: { type: Boolean },
    };

    constructor() {
        super();
        this.answers = [];
        this.isVisible = true;

        // Markdown/sanitizer library handles (mirroring SummaryView pattern)
        this.marked = null;
        this.hljs = null;
        this.DOMPurify = null;
        this.isLibrariesLoaded = false;
        this.isDOMPurifyLoaded = false;

        this.loadLibraries();
    }

    connectedCallback() {
        super.connectedCallback();
        if (window.api) {
            window.api.summaryView.onLiveAnswerUpdate((event, data) => {
                const next = applyLiveAnswerUpdate(this.answers, data);
                if (next === this.answers) return; // no-op payload (no answer text)
                this.answers = next; // new ref → reactive
                this.requestUpdate();
            });
        }
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        if (window.api) {
            window.api.summaryView.removeAllLiveAnswerUpdateListeners();
        }
    }

    /**
     * FR-016 — clears the whole history on explicit session reset.
     * The panel empties ONLY here, not between answers (C5/Q1/G3/FR-015).
     */
    resetAnswer() {
        this.answers = [];
        this.requestUpdate();
    }

    /**
     * Best-effort markdown library loader. content.html already loads `marked`
     * globally via <script src="../assets/marked-4.3.0.min.js">; we additionally
     * fetch highlight + DOMPurify RELATIVE TO content.html (src/ui/app/) — i.e.
     * `../assets/`, NOT `../../../assets/`. The old `../../../assets/` resolved to
     * the repo root (glass/assets/), 404'd, and the throw aborted the loader
     * before isLibrariesLoaded was set — so markdown never rendered (raw ** / -).
     * Each load is independent (one failure never aborts the rest), and markdown
     * renders as long as `marked` is present — hljs only adds code highlighting.
     */
    async loadLibraries() {
        const tryLoad = async (src) => {
            try {
                await this.loadScript(src);
            } catch (err) {
                console.warn('[live-answer] could not load', src, err && err.message);
            }
        };

        if (!window.marked) await tryLoad('../assets/marked-4.3.0.min.js');
        if (!window.hljs) await tryLoad('../assets/highlight-11.9.0.min.js');
        if (!window.DOMPurify) await tryLoad('../assets/dompurify-3.0.7.min.js');

        this.marked = window.marked || null;
        this.hljs = window.hljs || null;
        this.DOMPurify = window.DOMPurify || null;

        if (this.marked) {
            const options = { breaks: true, gfm: true, pedantic: false, smartypants: false, xhtml: false };
            if (this.hljs) {
                options.highlight = (code, lang) => {
                    if (lang && this.hljs.getLanguage(lang)) {
                        try {
                            return this.hljs.highlight(code, { language: lang }).value;
                        } catch (err) {
                            console.warn('[live-answer] Highlight error:', err);
                        }
                    }
                    try {
                        return this.hljs.highlightAuto(code).value;
                    } catch (err) {
                        console.warn('[live-answer] Auto highlight error:', err);
                    }
                    return code;
                };
            }
            this.marked.setOptions(options);
            this.isLibrariesLoaded = true; // markdown needs only marked
        }
        if (this.DOMPurify) this.isDOMPurifyLoaded = true;

        // Libs may arrive after the first render — re-render to upgrade fallback → markdown.
        this.requestUpdate();
    }

    loadScript(src) {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = src;
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
        });
    }

    /**
     * Render every answer block's body from `this.answers` (the source of
     * truth). Runs UNCONDITIONALLY on each update so a streaming delta or a
     * re-show always re-renders. Until the markdown libs load it fills the body
     * with plain text (never blank); once loaded it upgrades to sanitized
     * markdown. The body div carries NO Lit child binding, so writing its
     * innerHTML here never fights Lit's reconciliation (see class header).
     *
     * SAFETY: answer text is NEVER logged.
     */
    renderAnswers() {
        const textById = new Map(this.answers.map(a => [a.id, a.text]));
        const blocks = this.shadowRoot.querySelectorAll('.answer-body');

        blocks.forEach(el => {
            const id = el.getAttribute('data-answer-id');
            const text = textById.get(id);
            if (!text) return;

            // Libraries not loaded yet → plain-text fallback (never blank).
            if (!this.isLibrariesLoaded || !this.marked) {
                el.textContent = text;
                return;
            }

            // Without DOMPurify we must NOT inject unsanitized LLM markdown via
            // innerHTML (XSS) — fall back to safe plain text.
            if (!this.isDOMPurifyLoaded || !this.DOMPurify) {
                el.textContent = text;
                return;
            }

            try {
                // marked v4 UMD exposes a NAMESPACE object (window.marked = {parse, setOptions,…}),
                // NOT a callable — so `this.marked(text)` throws. Use .parse() when present;
                // fall back to calling it directly for builds where marked itself is the function.
                const rawHtml = typeof this.marked.parse === 'function'
                    ? this.marked.parse(text)
                    : this.marked(text);
                const parsedHTML = this.DOMPurify.sanitize(rawHtml);
                if (this.DOMPurify.removed && this.DOMPurify.removed.length > 0) {
                    console.warn('[live-answer] Unsafe content sanitized — showing plain text');
                    el.textContent = '⚠️ ' + text;
                    return;
                }
                el.innerHTML = parsedHTML;
            } catch (error) {
                console.error('[live-answer] Render error:', error);
                el.textContent = text;
            }
        });
    }

    updated(changedProperties) {
        super.updated(changedProperties);
        // renderAnswers() owns the body content (the template renders an empty
        // container). Runs on every update so streaming deltas and re-shows
        // both re-render from this.answers — plain text until libs load, then
        // sanitized markdown.
        this.renderAnswers();
        // Tell ListenView to re-measure + resize the listen window as the answer
        // streams/grows. Without this, the window is only resized on a viewMode
        // toggle, so a long streaming answer stays clipped until you toggle.
        // Mirrors stt-view's @stt-messages-updated → adjustWindowHeightThrottled.
        this.dispatchEvent(new CustomEvent('live-answer-updated', { bubbles: true, composed: true }));
    }

    render() {
        if (!this.isVisible || this.answers.length === 0) return html``;

        return html`
            <div class="live-answer-container">
                <div class="lane-eyebrow">Live Answer</div>
                ${this.answers.map(
                    (a, i) => html`
                        <div class="answer-block ${i === 0 ? 'current' : 'past'}">
                            ${a.question ? html`<div class="answer-question">${a.question}</div>` : ''}
                            <div class="answer-body" data-answer-id="${a.id}"></div>
                        </div>
                    `
                )}
            </div>
        `;
    }
}

customElements.define('live-answer-view', LiveAnswerView);

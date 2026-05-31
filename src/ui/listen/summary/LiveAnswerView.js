/**
 * LiveAnswerView.js
 *
 * Lit element <live-answer-view> — renders the streaming live answer lane
 * (FR-014/FR-015/FR-016).
 *
 * Design rules (LOCKED — do not re-derive):
 *   C5/FR-015: hold-last render, single innerHTML assignment, NEVER blank
 *   FR-017: structural clone of SummaryView's loader+render path — do NOT
 *           subclass or edit SummaryView
 *   Safety: answer text NEVER logged to any capturable sink
 *   FR-013: subscribes via window.api.summaryView.onLiveAnswerUpdate (new
 *           live-answer-update channel beside the existing summary-update)
 *   FR-016: resetAnswer() clears the panel on explicit session reset ONLY
 */

import { html, css, LitElement } from '../../assets/lit-core-2.7.4.min.js';

export class LiveAnswerView extends LitElement {
    static styles = css`
        :host {
            display: block;
            width: 100%;
        }

        .live-answer-container {
            padding: 8px 0 12px;
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

        .answer-content {
            font-size: 12px;
            line-height: 1.5;
            color: rgba(255, 255, 255, 0.9);
            word-break: break-word;
        }

        .answer-label {
            font-size: 10px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            color: rgba(255, 255, 255, 0.45);
            margin-bottom: 6px;
        }
    `;

    static properties = {
        /** Reactive: full accumulated answer markdown (bound from IPC). */
        liveAnswer: { type: String },
        /** Reactive: visibility, bound to viewMode === 'insights'. */
        isVisible: { type: Boolean },
    };

    constructor() {
        super();
        this.liveAnswer = '';
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
                if (data && data.answer) {
                    this.liveAnswer = data.answer;
                    this.requestUpdate();
                }
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
     * FR-016 — clears the rendered answer on explicit session reset.
     * Panel empties ONLY here, not between answers (C5/Q1/G3/FR-015).
     */
    resetAnswer() {
        this.liveAnswer = '';
        this.requestUpdate();
    }

    /**
     * Idempotent library loader (mirroring SummaryView.loadLibraries:291-307).
     * Guarded by if (!window.marked) etc.
     */
    async loadLibraries() {
        try {
            if (!window.marked) {
                await this.loadScript('../../../assets/marked-4.3.0.min.js');
            }
            if (!window.hljs) {
                await this.loadScript('../../../assets/highlight-11.9.0.min.js');
            }
            if (!window.DOMPurify) {
                await this.loadScript('../../../assets/dompurify-3.0.7.min.js');
            }

            this.marked = window.marked;
            this.hljs = window.hljs;
            this.DOMPurify = window.DOMPurify;

            if (this.marked && this.hljs) {
                this.marked.setOptions({
                    highlight: (code, lang) => {
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
                    },
                    breaks: true,
                    gfm: true,
                    pedantic: false,
                    smartypants: false,
                    xhtml: false,
                });
                this.isLibrariesLoaded = true;
            }

            if (this.DOMPurify) {
                this.isDOMPurifyLoaded = true;
            }
        } catch (error) {
            console.error('[live-answer] Failed to load libraries:', error);
        }
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
     * Render streamed markdown into the answer container.
     * Mirrors SummaryView.renderMarkdownContent (SummaryView.js:375-403).
     *
     * C5/FR-015 invariants:
     *   - Single innerHTML swap per frame
     *   - Never blank to empty between answers (only resetAnswer() empties)
     *   - DOMPurify.sanitize on every render
     *   - '⚠️ '+plain-text when DOMPurify.removed is non-empty
     *   - Escaped plain-text fallback when libs not yet attached
     *
     * SAFETY: answer text is NEVER logged.
     */
    renderAnswerContent(container, answerText) {
        if (!container || !answerText) return;

        if (!this.isLibrariesLoaded || !this.marked) {
            // Libs not yet loaded — plain-text escaped fallback (FR-015)
            container.textContent = answerText;
            return;
        }

        try {
            let parsedHTML = this.marked(answerText);

            if (this.isDOMPurifyLoaded && this.DOMPurify) {
                parsedHTML = this.DOMPurify.sanitize(parsedHTML);

                if (this.DOMPurify.removed && this.DOMPurify.removed.length > 0) {
                    console.warn('[live-answer] Unsafe content sanitized — showing plain text');
                    container.textContent = '⚠️ ' + answerText;
                    return;
                }
            }

            // Single innerHTML swap — never blank (C5)
            container.innerHTML = parsedHTML;
        } catch (error) {
            console.error('[live-answer] Render error:', error);
            container.textContent = answerText;
        }
    }

    updated(changedProperties) {
        super.updated(changedProperties);
        // Re-inject on liveAnswer change OR when the panel becomes visible again
        // (transcript→insights toggle) — render() emits an empty .answer-content
        // div, so without this a held answer would blank on re-show (FR-015).
        if (
            (changedProperties.has('liveAnswer') || changedProperties.has('isVisible')) &&
            this.isVisible &&
            this.liveAnswer
        ) {
            const container = this.shadowRoot.querySelector('.answer-content');
            if (container) {
                this.renderAnswerContent(container, this.liveAnswer);
            }
        }
    }

    render() {
        if (!this.isVisible) return html``;

        return html`
            <div class="live-answer-container">
                <div class="answer-label">Live Answer</div>
                <div class="answer-content"></div>
            </div>
        `;
    }
}

customElements.define('live-answer-view', LiveAnswerView);

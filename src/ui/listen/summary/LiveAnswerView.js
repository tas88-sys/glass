/**
 * LiveAnswerView.js
 *
 * Lit element <live-answer-view> — renders the streaming live answer lane
 * (FR-014/FR-015/FR-016) as an in-session, newest-first HISTORY of answers.
 *
 * Design rules (LOCKED — do not re-derive):
 *   Render model: DECLARATIVE — render() emits every answer's text into the
 *           template (plain-text fallback) and updated() UNCONDITIONALLY
 *           upgrades each block to sanitized markdown. This mirrors
 *           SummaryView's proven loader+render path (the earlier empty-
 *           container + guarded-innerHTML approach blanked on the
 *           transcript↔insights toggle because the answer lived only in a DOM
 *           node that render() destroyed). Source of truth is `this.answers`,
 *           NOT the DOM — so re-show always re-renders and never blanks.
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

            // Libraries arrived after the first render — upgrade the plain-text
            // fallback already in the DOM to rendered markdown.
            this.requestUpdate();
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
     * Upgrade every answer block's plain-text fallback to sanitized markdown.
     * Mirrors SummaryView.renderMarkdownContent (SummaryView.js:375-403):
     * runs UNCONDITIONALLY on each update so a re-show or a streaming delta
     * always re-renders from `this.answers` (the source of truth). When the
     * libraries are not yet loaded it no-ops, leaving the template's escaped
     * plain text in place (FR-015) — it NEVER blanks.
     *
     * SAFETY: answer text is NEVER logged.
     */
    renderAnswers() {
        if (!this.isLibrariesLoaded || !this.marked) return;

        const textById = new Map(this.answers.map(a => [a.id, a.text]));
        const blocks = this.shadowRoot.querySelectorAll('.answer-body');

        blocks.forEach(el => {
            const id = el.getAttribute('data-answer-id');
            const text = textById.get(id);
            if (!text) return;

            try {
                let parsedHTML = this.marked(text);

                if (this.isDOMPurifyLoaded && this.DOMPurify) {
                    parsedHTML = this.DOMPurify.sanitize(parsedHTML);

                    if (this.DOMPurify.removed && this.DOMPurify.removed.length > 0) {
                        console.warn('[live-answer] Unsafe content sanitized — showing plain text');
                        el.textContent = '⚠️ ' + text;
                        return;
                    }
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
        // Unconditional upgrade — same contract as SummaryView. The declarative
        // template already carries the text, so even if this is skipped the
        // panel shows plain text rather than blanking.
        this.renderAnswers();
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
                            <div class="answer-body" data-answer-id="${a.id}">${a.text}</div>
                        </div>
                    `
                )}
            </div>
        `;
    }
}

customElements.define('live-answer-view', LiveAnswerView);

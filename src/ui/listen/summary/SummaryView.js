import { html, css, LitElement } from '../../assets/lit-core-2.7.4.min.js';

export class SummaryView extends LitElement {
    static styles = css`
        :host {
            display: block;
            width: 100%;
        }

        /* Inherit font styles from parent */

        /* highlight.js 스타일 추가 */
        .insights-container pre {
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

        .insights-container code {
            font-family: 'Monaco', 'Menlo', 'Consolas', monospace !important;
            font-size: 11px !important;
            background: transparent !important;
            white-space: pre !important;
            word-wrap: normal !important;
            word-break: normal !important;
        }

        .insights-container pre code {
            white-space: pre !important;
            word-wrap: normal !important;
            word-break: normal !important;
            display: block !important;
        }

        .insights-container p code {
            background: rgba(255, 255, 255, 0.1) !important;
            padding: 2px 4px !important;
            border-radius: 3px !important;
            color: #ffd700 !important;
        }

        .hljs-keyword {
            color: #ff79c6 !important;
        }
        .hljs-string {
            color: #f1fa8c !important;
        }
        .hljs-comment {
            color: #6272a4 !important;
        }
        .hljs-number {
            color: #bd93f9 !important;
        }
        .hljs-function {
            color: #50fa7b !important;
        }
        .hljs-variable {
            color: #8be9fd !important;
        }
        .hljs-built_in {
            color: #ffb86c !important;
        }
        .hljs-title {
            color: #50fa7b !important;
        }
        .hljs-attr {
            color: #50fa7b !important;
        }
        .hljs-tag {
            color: #ff79c6 !important;
        }

        .insights-container {
            overflow-y: auto;
            padding: 12px 16px 16px 16px;
            position: relative;
            z-index: 1;
            min-height: 150px;
            max-height: 600px;
            flex: 1;
        }

        /* Visibility handled by parent component */

        .insights-container::-webkit-scrollbar {
            width: 8px;
        }
        .insights-container::-webkit-scrollbar-track {
            background: rgba(0, 0, 0, 0.1);
            border-radius: 4px;
        }
        .insights-container::-webkit-scrollbar-thumb {
            background: rgba(255, 255, 255, 0.3);
            border-radius: 4px;
        }
        .insights-container::-webkit-scrollbar-thumb:hover {
            background: rgba(255, 255, 255, 0.5);
        }

        insights-title {
            color: rgba(255, 255, 255, 0.8);
            font-size: 15px;
            font-weight: 500;
            font-family: 'Helvetica Neue', sans-serif;
            margin: 12px 0 8px 0;
            display: block;
        }

        .insights-container h4 {
            color: #ffffff;
            font-size: 12px;
            font-weight: 600;
            margin: 12px 0 8px 0;
            padding: 4px 8px;
            border-radius: 4px;
            background: transparent;
            cursor: default;
        }

        .insights-container h4:hover {
            background: transparent;
        }

        .insights-container h4:first-child {
            margin-top: 0;
        }

        .outline-item {
            color: #ffffff;
            font-size: 11px;
            line-height: 1.4;
            margin: 4px 0;
            padding: 6px 8px;
            border-radius: 4px;
            background: transparent;
            transition: background-color 0.15s ease;
            cursor: pointer;
            word-wrap: break-word;
        }

        .outline-item:hover {
            background: rgba(255, 255, 255, 0.1);
        }

        .request-item {
            color: #ffffff;
            font-size: 12px;
            line-height: 1.2;
            margin: 4px 0;
            padding: 6px 8px;
            border-radius: 4px;
            background: transparent;
            cursor: default;
            word-wrap: break-word;
            transition: background-color 0.15s ease;
        }

        .request-item.clickable {
            cursor: pointer;
            transition: all 0.15s ease;
        }
        .request-item.clickable:hover {
            background: rgba(255, 255, 255, 0.1);
            transform: translateX(2px);
        }

        /* 마크다운 렌더링된 콘텐츠 스타일 */
        .markdown-content {
            color: #ffffff;
            font-size: 11px;
            line-height: 1.4;
            margin: 4px 0;
            padding: 6px 8px;
            border-radius: 4px;
            background: transparent;
            cursor: pointer;
            word-wrap: break-word;
            transition: all 0.15s ease;
        }

        .markdown-content:hover {
            background: rgba(255, 255, 255, 0.1);
            transform: translateX(2px);
        }

        .markdown-content p {
            margin: 4px 0;
        }

        .markdown-content ul,
        .markdown-content ol {
            margin: 4px 0;
            padding-left: 16px;
        }

        .markdown-content li {
            margin: 2px 0;
        }

        .markdown-content a {
            color: #8be9fd;
            text-decoration: none;
        }

        .markdown-content a:hover {
            text-decoration: underline;
        }

        .markdown-content strong {
            font-weight: 600;
            color: #f8f8f2;
        }

        .markdown-content em {
            font-style: italic;
            color: #f1fa8c;
        }

        .empty-state {
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100px;
            color: rgba(255, 255, 255, 0.6);
            font-size: 12px;
            font-style: italic;
        }
    `;

    static properties = {
        structuredData: { type: Object },
        isVisible: { type: Boolean },
        hasCompletedRecording: { type: Boolean },
    };

    constructor() {
        super();
        this.structuredData = {
            summary: [],
            topic: { header: '', bullets: [] },
            actions: [],
            followUps: [],
        };
        this.isVisible = true;
        this.hasCompletedRecording = false;

        // 마크다운 라이브러리 초기화
        this.marked = null;
        this.hljs = null;
        this.isLibrariesLoaded = false;
        this.DOMPurify = null;
        this.isDOMPurifyLoaded = false;

        this.loadLibraries();
    }

    connectedCallback() {
        super.connectedCallback();
        if (window.api) {
            window.api.summaryView.onSummaryUpdate((event, data) => {
                this.structuredData = data;
                this.requestUpdate();
            });
        }
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        if (window.api) {
            window.api.summaryView.removeAllSummaryUpdateListeners();
        }
    }

    // Handle session reset from parent
    resetAnalysis() {
        this.structuredData = {
            summary: [],
            topic: { header: '', bullets: [] },
            actions: [],
            followUps: [],
        };
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
                console.warn('[summary] could not load', src, err && err.message);
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
                            console.warn('[summary] Highlight error:', err);
                        }
                    }
                    try {
                        return this.hljs.highlightAuto(code).value;
                    } catch (err) {
                        console.warn('[summary] Auto highlight error:', err);
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

    parseMarkdown(text) {
        if (!text) return '';

        if (!this.isLibrariesLoaded || !this.marked) {
            return text;
        }

        try {
            // marked v4 UMD exposes a NAMESPACE object (window.marked = {parse, setOptions,…}),
            // NOT a callable — so `this.marked(text)` throws. Use .parse() when present;
            // fall back to calling it directly for builds where marked itself is the function.
            return typeof this.marked.parse === 'function'
                ? this.marked.parse(text)
                : this.marked(text);
        } catch (error) {
            console.error('Markdown parsing error:', error);
            return text;
        }
    }

    handleMarkdownClick(originalText) {
        this.handleRequestClick(originalText);
    }

    renderMarkdownContent() {
        // Libraries not loaded yet → leave the template's escaped plain-text
        // fallback (`${bullet}`) in place. It NEVER blanks.
        if (!this.isLibrariesLoaded || !this.marked) {
            return;
        }

        const markdownElements = this.shadowRoot.querySelectorAll('[data-markdown-id]');
        markdownElements.forEach(element => {
            const originalText = element.getAttribute('data-original-text');
            if (!originalText) return;

            // Without DOMPurify we must NOT inject unsanitized LLM markdown via
            // innerHTML (XSS) — fall back to safe plain text.
            if (!this.isDOMPurifyLoaded || !this.DOMPurify) {
                element.textContent = originalText;
                return;
            }

            try {
                const parsedHTML = this.DOMPurify.sanitize(this.parseMarkdown(originalText));

                if (this.DOMPurify.removed && this.DOMPurify.removed.length > 0) {
                    console.warn('Unsafe content detected in insights, showing plain text');
                    element.textContent = '⚠️ ' + originalText;
                    return;
                }

                element.innerHTML = parsedHTML;
            } catch (error) {
                console.error('Error rendering markdown for element:', error);
                element.textContent = originalText;
            }
        });
    }

    async handleRequestClick(requestText) {
        console.log('Analysis request clicked:', requestText);

        if (window.api) {
            try {
                const result = await window.api.summaryView.sendQuestionFromSummary(requestText);

                if (result && result.success) {
                    console.log('Question sent to AskView successfully');
                } else {
                    // Surface the error to the user — includes the Ask-mode block message (spec §7.4)
                    console.error('Failed to send question to AskView:', result && result.error);
                    alert(result?.error || 'Failed to send question.');
                }
            } catch (error) {
                console.error('Error in handleRequestClick:', error);
                alert('Failed to send question. See logs.');
            }
        }
    }

    getSummaryText() {
        const data = this.structuredData || { summary: [], topic: { header: '', bullets: [] }, actions: [] };
        let sections = [];

        if (data.summary && data.summary.length > 0) {
            sections.push(`Current Summary:\n${data.summary.map(s => `• ${s}`).join('\n')}`);
        }

        if (data.topic && data.topic.header && data.topic.bullets.length > 0) {
            sections.push(`\n${data.topic.header}:\n${data.topic.bullets.map(b => `• ${b}`).join('\n')}`);
        }

        if (data.actions && data.actions.length > 0) {
            sections.push(`\nActions:\n${data.actions.map(a => `▸ ${a}`).join('\n')}`);
        }

        if (data.followUps && data.followUps.length > 0) {
            sections.push(`\nFollow-Ups:\n${data.followUps.map(f => `▸ ${f}`).join('\n')}`);
        }

        return sections.join('\n\n').trim();
    }

    updated(changedProperties) {
        super.updated(changedProperties);
        this.renderMarkdownContent();
        // Tell ListenView to re-measure + resize the listen window as the summary
        // grows. Without this, the window is only resized on a viewMode toggle, so
        // a long summary (e.g. content after the "Actions" heading) stays clipped
        // with no scroll until you toggle. Mirrors LiveAnswerView's
        // live-answer-updated → adjustWindowHeightThrottled.
        this.dispatchEvent(new CustomEvent('summary-updated', { bubbles: true, composed: true }));
    }

    render() {
        if (!this.isVisible) {
            return html`<div style="display: none;"></div>`;
        }

        const data = this.structuredData || {
            summary: [],
            topic: { header: '', bullets: [] },
            actions: [],
        };

        const hasAnyContent = data.summary.length > 0 || data.topic.bullets.length > 0 || data.actions.length > 0;

        return html`
            <div class="insights-container">
                ${!hasAnyContent
                    ? html`<div class="empty-state">No insights yet...</div>`
                    : html`
                        <insights-title>Current Summary</insights-title>
                        ${data.summary.length > 0
                            ? data.summary
                                  .slice(0, 5)
                                  .map(
                                      (bullet, index) => html`
                                          <div
                                              class="markdown-content"
                                              data-markdown-id="summary-${index}"
                                              data-original-text="${bullet}"
                                              @click=${() => this.handleMarkdownClick(bullet)}
                                          >
                                              ${bullet}
                                          </div>
                                      `
                                  )
                            : html` <div class="request-item">No content yet...</div> `}
                        ${data.topic.header
                            ? html`
                                  <insights-title>${data.topic.header}</insights-title>
                                  ${data.topic.bullets
                                      .slice(0, 3)
                                      .map(
                                          (bullet, index) => html`
                                              <div
                                                  class="markdown-content"
                                                  data-markdown-id="topic-${index}"
                                                  data-original-text="${bullet}"
                                                  @click=${() => this.handleMarkdownClick(bullet)}
                                              >
                                                  ${bullet}
                                              </div>
                                          `
                                      )}
                              `
                            : ''}
                        ${data.actions.length > 0
                            ? html`
                                  <insights-title>Actions</insights-title>
                                  ${data.actions
                                      .slice(0, 5)
                                      .map(
                                          (action, index) => html`
                                              <div
                                                  class="markdown-content"
                                                  data-markdown-id="action-${index}"
                                                  data-original-text="${action}"
                                                  @click=${() => this.handleMarkdownClick(action)}
                                              >
                                                  ${action}
                                              </div>
                                          `
                                      )}
                              `
                            : ''}
                        ${this.hasCompletedRecording && data.followUps && data.followUps.length > 0
                            ? html`
                                  <insights-title>Follow-Ups</insights-title>
                                  ${data.followUps.map(
                                      (followUp, index) => html`
                                          <div
                                              class="markdown-content"
                                              data-markdown-id="followup-${index}"
                                              data-original-text="${followUp}"
                                              @click=${() => this.handleMarkdownClick(followUp)}
                                          >
                                              ${followUp}
                                          </div>
                                      `
                                  )}
                              `
                            : ''}
                    `}
            </div>
        `;
    }
}

customElements.define('summary-view', SummaryView); 
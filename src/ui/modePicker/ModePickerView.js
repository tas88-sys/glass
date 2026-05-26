import { html, css, LitElement } from '../assets/lit-core-2.7.4.min.js';

/**
 * ModePickerView — Lit element for the Ask mode picker popup window.
 *
 * Renders 4 mode buttons. On click:
 *   1. await setAskMode(mode)   — IPC round-trip to persist the new mode
 *   2. await closeWindow()      — hide the window
 * This ordering prevents a race between the IPC completion and the window close
 * (per spec §8 clarify IMPL GAP 3).
 *
 * On window blur (user clicks away), the window is also closed (spec §8.4 hardening).
 */
class ModePickerView extends LitElement {
    static properties = {
        activeMode: { type: String, state: true },
    };

    static styles = css`
        :host {
            display: block;
            width: 160px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            color: rgba(255, 255, 255, 0.9);
            user-select: none;
        }

        .mode-list {
            list-style: none;
            margin: 0;
            padding: 4px 0;
        }

        .mode-item {
            display: flex;
            align-items: center;
            height: 34px;
            padding: 0 12px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 400;
            border-radius: 0;
            gap: 8px;
            transition: background 0.1s ease;
        }

        .mode-item:hover,
        .mode-item:focus {
            background: rgba(255, 255, 255, 0.1);
            outline: none;
        }

        .mode-item:first-child {
            border-radius: 8px 8px 0 0;
        }

        .mode-item:last-child {
            border-radius: 0 0 8px 8px;
        }

        .checkmark {
            width: 14px;
            font-size: 13px;
            flex-shrink: 0;
        }

        .mode-label {
            flex: 1;
        }
    `;

    constructor() {
        super();
        this.activeMode = 'default';
        this._handleBlur = this._onWindowBlur.bind(this);
        this._handleHostEnter = this._onHostEnter.bind(this);
        this._handleHostLeave = this._onHostLeave.bind(this);
    }

    async connectedCallback() {
        super.connectedCallback();
        // Fetch initial mode from settings via IPC
        try {
            if (window.api && window.api.mainHeader) {
                this.activeMode = await window.api.mainHeader.getAskMode() ?? 'default';
            }
        } catch (err) {
            console.warn('[ModePickerView] Failed to fetch askMode on mount, defaulting to "default"', err);
            this.activeMode = 'default';
        }

        // Blur fallback: close the window if focus leaves the picker window (spec §8.4)
        window.addEventListener('blur', this._handleBlur);

        // Hover bridge: cancel pending hide when mouse enters the picker, start hide on leave.
        // Mirrors SettingsView's handleMouseEnter/handleMouseLeave pattern.
        this.addEventListener('mouseenter', this._handleHostEnter);
        this.addEventListener('mouseleave', this._handleHostLeave);
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        window.removeEventListener('blur', this._handleBlur);
        this.removeEventListener('mouseenter', this._handleHostEnter);
        this.removeEventListener('mouseleave', this._handleHostLeave);
    }

    _onHostEnter() {
        if (window.api && window.api.mainHeader) {
            try { window.api.mainHeader.cancelHideModePicker(); } catch {}
        }
    }

    _onHostLeave() {
        if (window.api && window.api.modePicker) {
            try { window.api.modePicker.closeWindow(); } catch {}
        }
    }

    async _onWindowBlur() {
        await this._closeWindow();
    }

    async _selectMode(mode) {
        try {
            // Step 1: persist the mode (must complete before window closes — no race)
            if (window.api && window.api.mainHeader) {
                await window.api.mainHeader.setAskMode(mode);
            }
        } catch (err) {
            console.error('[ModePickerView] setAskMode failed', err);
        }

        // Step 2: close the window
        await this._closeWindow();
    }

    async _closeWindow() {
        try {
            if (window.api && window.api.modePicker) {
                await window.api.modePicker.closeWindow();
            }
        } catch (err) {
            console.warn('[ModePickerView] closeWindow failed', err);
        }
    }

    _handleKeydown(event, mode) {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            this._selectMode(mode);
        }
    }

    _renderMode(label, modeKey) {
        const isActive = this.activeMode === modeKey;
        return html`
            <li
                class="mode-item"
                tabindex="0"
                role="option"
                aria-selected="${isActive}"
                @click=${() => this._selectMode(modeKey)}
                @keydown=${(e) => this._handleKeydown(e, modeKey)}
            >
                <span class="checkmark">${isActive ? '✓' : ''}</span>
                <span class="mode-label">${label}</span>
            </li>
        `;
    }

    render() {
        return html`
            <ul class="mode-list" role="listbox" aria-label="Ask mode">
                ${this._renderMode('Default', 'default')}
                ${this._renderMode('Code', 'code')}
                ${this._renderMode('Debug', 'debug')}
                ${this._renderMode('System Design', 'system_design')}
            </ul>
        `;
    }
}

customElements.define('mode-picker-view', ModePickerView);

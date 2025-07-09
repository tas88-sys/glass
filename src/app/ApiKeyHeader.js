import { html, css, LitElement } from "../assets/lit-core-2.7.4.min.js"

export class ApiKeyHeader extends LitElement {
  //////// after_modelStateService ////////
  static properties = {
    llmApiKey: { type: String },
    sttApiKey: { type: String },
    llmProvider: { type: String },
    sttProvider: { type: String },
    isLoading: { type: Boolean },
    errorMessage: { type: String },
    providers: { type: Object, state: true },
  }
  //////// after_modelStateService ////////

  static styles = css`
        :host {
          display: block;
          transition: opacity 0.3s ease-in, transform 0.3s ease-in;
          will-change: opacity, transform;
        }

        :host(.sliding-out) {
            opacity: 0;
            transform: translateY(-20px);
        }

        :host(.hidden) {
            opacity: 0;
            pointer-events: none;
        }

        * {
            font-family: 'Helvetica Neue', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            cursor: default;
            user-select: none;
            box-sizing: border-box;
        }

        .container {
            -webkit-app-region: drag;
            width: 350px;
            min-height: 260px;
            padding: 18px 20px;
            background: rgba(0, 0, 0, 0.3);
            border-radius: 16px;
            overflow: visible;
            position: relative;
            display: flex;
            flex-direction: column;
            align-items: center;
        }

        .container::after {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            border-radius: 16px;
            padding: 1px;
            background: linear-gradient(169deg, rgba(255, 255, 255, 0.5) 0%, rgba(255, 255, 255, 0) 50%, rgba(255, 255, 255, 0.5) 100%);
            -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
            -webkit-mask-composite: destination-out;
            mask-composite: exclude;
            pointer-events: none;
        }

        .close-button {
            -webkit-app-region: no-drag;
            position: absolute;
            top: 10px;
            right: 10px;
            width: 14px;
            height: 14px;
            background: rgba(255, 255, 255, 0.1);
            border: none;
            border-radius: 3px;
            color: rgba(255, 255, 255, 0.7);
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.15s ease;
            z-index: 10;
            font-size: 14px;
            line-height: 1;
            padding: 0;
        }

        .close-button:hover {
            background: rgba(255, 255, 255, 0.2);
            color: rgba(255, 255, 255, 0.9);
        }

        .close-button:active {
            transform: scale(0.95);
        }

        .title {
            color: white;
            font-size: 16px;
            font-weight: 500; /* Medium */
            margin: 0;
            text-align: center;
            flex-shrink: 0;
        }

        .form-content {
            display: flex;
            flex-direction: column;
            align-items: center;
            width: 100%;
            margin-top: auto;
        }

        .error-message {
            color: rgba(239, 68, 68, 0.9);
            font-weight: 500;
            font-size: 11px;
            height: 14px;
            text-align: center;
            margin-bottom: 4px;
        }

        .api-input {
            -webkit-app-region: no-drag;
            width: 100%;
            height: 34px;
            background: rgba(255, 255, 255, 0.1);
            border-radius: 10px;
            border: none;
            padding: 0 10px;
            color: white;
            font-size: 12px;
            font-weight: 400; /* Regular */
            margin-bottom: 6px;
            text-align: center;
            user-select: text;
            cursor: text;
        }

        .api-input::placeholder {
            color: rgba(255, 255, 255, 0.6);
        }

        .api-input:focus {
            outline: none;
        }

        .providers-container { display: flex; gap: 12px; width: 100%; }
        .provider-column { flex: 1; display: flex; flex-direction: column; align-items: center; }
        .provider-label { color: rgba(255, 255, 255, 0.7); font-size: 11px; font-weight: 500; margin-bottom: 6px; }
        .api-input, .provider-select {
            -webkit-app-region: no-drag;
            width: 100%;
            height: 34px;
            text-align: center;
            background: rgba(255, 255, 255, 0.1);
            border-radius: 10px;
            border: 1px solid rgba(255, 255, 255, 0.2);
            padding: 0 10px;
            color: white;
            font-size: 12px;
            margin-bottom: 6px;
        }
        .provider-select option { background: #1a1a1a; color: white; }

        .provider-select:hover {
            background-color: rgba(255, 255, 255, 0.15);
            border-color: rgba(255, 255, 255, 0.3);
        }

        .provider-select:focus {
            outline: none;
            background-color: rgba(255, 255, 255, 0.15);
            border-color: rgba(255, 255, 255, 0.4);
        }


        .action-button {
            -webkit-app-region: no-drag;
            width: 100%;
            height: 34px;
            background: rgba(255, 255, 255, 0.2);
            border: none;
            border-radius: 10px;
            color: white;
            font-size: 12px;
            font-weight: 500; /* Medium */
            cursor: pointer;
            transition: background 0.15s ease;
            position: relative;
            overflow: visible;
        }

        .action-button::after {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            border-radius: 10px;
            padding: 1px;
            background: linear-gradient(169deg, rgba(255, 255, 255, 0.5) 0%, rgba(255, 255, 255, 0) 50%, rgba(255, 255, 255, 0.5) 100%);
            -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
            -webkit-mask-composite: destination-out;
            mask-composite: exclude;
            pointer-events: none;
        }

        .action-button:hover {
            background: rgba(255, 255, 255, 0.3);
        }

        .action-button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .or-text {
            color: rgba(255, 255, 255, 0.5);
            font-size: 12px;
            font-weight: 500; /* Medium */
            margin: 10px 0;
        }
    `

  constructor() {
    super()
    this.isLoading = false
    this.errorMessage = ""
    //////// after_modelStateService ////////
    this.llmApiKey = "";
    this.sttApiKey = "";
    this.llmProvider = "openai";
    this.sttProvider = "openai";
    this.providers = { llm: [], stt: [] }; // 초기화
    this.loadProviderConfig();
    //////// after_modelStateService ////////

    this.handleKeyPress = this.handleKeyPress.bind(this)
    this.handleSubmit = this.handleSubmit.bind(this)
    this.handleInput = this.handleInput.bind(this)
    this.handleAnimationEnd = this.handleAnimationEnd.bind(this)
    this.handleUsePicklesKey = this.handleUsePicklesKey.bind(this)
    this.handleProviderChange = this.handleProviderChange.bind(this)
  }

  reset() {
    this.apiKey = ""
    this.isLoading = false
    this.errorMessage = ""
    this.validatedApiKey = null
    this.selectedProvider = "openai"
    this.requestUpdate()
  }

  async loadProviderConfig() {
    if (!window.require) return;
    const { ipcRenderer } = window.require('electron');
    const config = await ipcRenderer.invoke('model:get-provider-config');
    
    const llmProviders = [];
    const sttProviders = [];

    for (const id in config) {
        // 'openai-glass' 같은 가상 Provider는 UI에 표시하지 않음
        if (id.includes('-glass')) continue;

        if (config[id].llmModels.length > 0) {
            llmProviders.push({ id, name: config[id].name });
        }
        if (config[id].sttModels.length > 0) {
            sttProviders.push({ id, name: config[id].name });
        }
    }
    
    this.providers = { llm: llmProviders, stt: sttProviders };
    
    // 기본 선택 값 설정
    if (llmProviders.length > 0) this.llmProvider = llmProviders[0].id;
    if (sttProviders.length > 0) this.sttProvider = sttProviders[0].id;
    
    this.requestUpdate();
  }

  handleInput(e) {
    this.apiKey = e.target.value
    this.errorMessage = ""
    console.log("Input changed:", this.apiKey?.length || 0, "chars")

    this.requestUpdate()
    this.updateComplete.then(() => {
      const inputField = this.shadowRoot?.querySelector(".apikey-input")
      if (inputField && this.isInputFocused) {
        inputField.focus()
      }
    })
  }

  handleProviderChange(e) {
    this.selectedProvider = e.target.value
    this.errorMessage = ""
    console.log("Provider changed to:", this.selectedProvider)
    this.requestUpdate()
  }

  handlePaste(e) {
    e.preventDefault()
    this.errorMessage = ""
    const clipboardText = (e.clipboardData || window.clipboardData).getData("text")
    console.log("Paste event detected:", clipboardText?.substring(0, 10) + "...")

    if (clipboardText) {
      this.apiKey = clipboardText.trim()

      const inputElement = e.target
      inputElement.value = this.apiKey
    }

    this.requestUpdate()
    this.updateComplete.then(() => {
      const inputField = this.shadowRoot?.querySelector(".apikey-input")
      if (inputField) {
        inputField.focus()
        inputField.setSelectionRange(inputField.value.length, inputField.value.length)
      }
    })
  }

  handleKeyPress(e) {
    if (e.key === "Enter") {
      e.preventDefault()
      this.handleSubmit()
    }
  }

  //////// after_modelStateService ////////
  async handleSubmit() {
    console.log('[ApiKeyHeader] handleSubmit: Submitting API keys...');
    if (this.isLoading || !this.llmApiKey.trim() || !this.sttApiKey.trim()) {
        this.errorMessage = "Please enter keys for both LLM and STT.";
        return;
    }

    this.isLoading = true;
    this.errorMessage = "";
    this.requestUpdate();

    const { ipcRenderer } = window.require('electron');

    console.log('[ApiKeyHeader] handleSubmit: Validating LLM key...');
    const llmValidation = ipcRenderer.invoke('model:validate-key', { provider: this.llmProvider, key: this.llmApiKey.trim() });
    const sttValidation = ipcRenderer.invoke('model:validate-key', { provider: this.sttProvider, key: this.sttApiKey.trim() });

    const [llmResult, sttResult] = await Promise.all([llmValidation, sttValidation]);

    if (llmResult.success && sttResult.success) {
        console.log('[ApiKeyHeader] handleSubmit: Both LLM and STT keys are valid.');
        this.startSlideOutAnimation();
    } else {
        console.log('[ApiKeyHeader] handleSubmit: Validation failed.');
        let errorParts = [];
        if (!llmResult.success) errorParts.push(`LLM Key: ${llmResult.error || 'Invalid'}`);
        if (!sttResult.success) errorParts.push(`STT Key: ${sttResult.error || 'Invalid'}`);
        this.errorMessage = errorParts.join(' | ');
    }

    this.isLoading = false;
    this.requestUpdate();
}
//////// after_modelStateService ////////


  startSlideOutAnimation() {
    console.log('[ApiKeyHeader] startSlideOutAnimation: Starting slide out animation.');
    this.classList.add("sliding-out")
  }

  handleUsePicklesKey(e) {
    e.preventDefault()

    console.log("Requesting Firebase authentication from main process...")
    if (window.require) {
      window.require("electron").ipcRenderer.invoke("start-firebase-auth")
    }
  }

  handleClose() {
    console.log("Close button clicked")
    if (window.require) {
      window.require("electron").ipcRenderer.invoke("quit-application")
    }
  }


  //////// after_modelStateService ////////
  handleAnimationEnd(e) {
    if (e.target !== this || !this.classList.contains('sliding-out')) return;
    this.classList.remove("sliding-out");
    this.classList.add("hidden");
    window.require('electron').ipcRenderer.invoke('get-current-user').then(userState => {
        console.log('[ApiKeyHeader] handleAnimationEnd: User state updated:', userState);
        this.stateUpdateCallback?.(userState);
    });
  }
//////// after_modelStateService ////////

  connectedCallback() {
    super.connectedCallback()
    this.addEventListener("animationend", this.handleAnimationEnd)
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    this.removeEventListener("animationend", this.handleAnimationEnd)
  }

  render() {
    const isButtonDisabled = this.isLoading || !this.llmApiKey.trim() || !this.sttApiKey.trim();

    return html`
        <div class="container">
            <h1 class="title">Enter Your API Keys</h1>

            <div class="providers-container">
                <div class="provider-column">
                    <div class="provider-label"></div>
                    <select class="provider-select" .value=${this.llmProvider} @change=${e => this.llmProvider = e.target.value} ?disabled=${this.isLoading}>
                        ${this.providers.llm.map(p => html`<option value=${p.id}>${p.name}</option>`)}
                    </select>
                    <input type="password" class="api-input" placeholder="LLM Provider API Key" .value=${this.llmApiKey} @input=${e => this.llmApiKey = e.target.value} ?disabled=${this.isLoading}>
                </div>

                <div class="provider-column">
                    <div class="provider-label"></div>
                    <select class="provider-select" .value=${this.sttProvider} @change=${e => this.sttProvider = e.target.value} ?disabled=${this.isLoading}>
                        ${this.providers.stt.map(p => html`<option value=${p.id}>${p.name}</option>`)}
                    </select>
                    <input type="password" class="api-input" placeholder="STT Provider API Key" .value=${this.sttApiKey} @input=${e => this.sttApiKey = e.target.value} ?disabled=${this.isLoading}>
                </div>
            </div>
            
            <div class="error-message">${this.errorMessage}</div>

            <button class="action-button" @click=${this.handleSubmit} ?disabled=${isButtonDisabled}>
                ${this.isLoading ? "Validating..." : "Confirm"}
            </button>
            <div class="or-text">or</div>
            <button class="action-button" @click=${this.handleUsePicklesKey}>Use Pickle's Key (Login)</button>
        </div>
    `;
}
}

customElements.define("apikey-header", ApiKeyHeader)

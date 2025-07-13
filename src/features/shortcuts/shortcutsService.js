const { globalShortcut, screen } = require('electron');
const shortcutsRepository = require('./repositories');
const internalBridge = require('../../bridge/internalBridge');
const askService = require('../ask/askService');


class ShortcutsService {
    constructor() {
        this.lastVisibleWindows = new Set(['header']);
        this.mouseEventsIgnored = false;
        this.movementManager = null;
        this.windowPool = null;
    }

    initialize(movementManager, windowPool) {
        this.movementManager = movementManager;
        this.windowPool = windowPool;
        internalBridge.on('reregister-shortcuts', () => {
            console.log('[ShortcutsService] Reregistering shortcuts due to header state change.');
            this.registerShortcuts();
        });
        console.log('[ShortcutsService] Initialized with dependencies and event listener.');
    }

    getDefaultKeybinds() {
        const isMac = process.platform === 'darwin';
        return {
            moveUp: isMac ? 'Cmd+Up' : 'Ctrl+Up',
            moveDown: isMac ? 'Cmd+Down' : 'Ctrl+Down',
            moveLeft: isMac ? 'Cmd+Left' : 'Ctrl+Left',
            moveRight: isMac ? 'Cmd+Right' : 'Ctrl+Right',
            toggleVisibility: isMac ? 'Cmd+\\' : 'Ctrl+\\',
            toggleClickThrough: isMac ? 'Cmd+M' : 'Ctrl+M',
            nextStep: isMac ? 'Cmd+Enter' : 'Ctrl+Enter',
            manualScreenshot: isMac ? 'Cmd+Shift+S' : 'Ctrl+Shift+S',
            previousResponse: isMac ? 'Cmd+[' : 'Ctrl+[',
            nextResponse: isMac ? 'Cmd+]' : 'Ctrl+]',
            scrollUp: isMac ? 'Cmd+Shift+Up' : 'Ctrl+Shift+Up',
            scrollDown: isMac ? 'Cmd+Shift+Down' : 'Ctrl+Shift+Down',
        };
    }

    async loadKeybinds() {
        let keybindsArray = await shortcutsRepository.getAllKeybinds();

        if (!keybindsArray || keybindsArray.length === 0) {
            console.log(`[Shortcuts] No keybinds found. Loading defaults.`);
            const defaults = this.getDefaultKeybinds();
            await this.saveKeybinds(defaults); 
            return defaults;
        }

        const keybinds = {};
        keybindsArray.forEach(k => {
            keybinds[k.action] = k.accelerator;
        });

        const defaults = this.getDefaultKeybinds();
        let needsUpdate = false;
        for (const action in defaults) {
            if (!keybinds[action]) {
                keybinds[action] = defaults[action];
                needsUpdate = true;
            }
        }

        if (needsUpdate) {
            console.log('[Shortcuts] Updating missing keybinds with defaults.');
            await this.saveKeybinds(keybinds);
        }

        return keybinds;
    }

    async handleSaveShortcuts(newKeybinds) {
        try {
            await this.saveKeybinds(newKeybinds);
            const shortcutEditor = this.windowPool.get('shortcut-settings');
            if (shortcutEditor && !shortcutEditor.isDestroyed()) {
                shortcutEditor.close(); // This will trigger re-registration on 'closed' event in windowManager
            } else {
                // If editor wasn't open, re-register immediately
                await this.registerShortcuts();
            }
            return { success: true };
        } catch (error) {
            console.error("Failed to save shortcuts:", error);
            // On failure, re-register old shortcuts to be safe
            await this.registerShortcuts();
            return { success: false, error: error.message };
        }
    }

    async handleRestoreDefaults() {
        const defaults = this.getDefaultKeybinds();
        await this.saveKeybinds(defaults);
        await this.registerShortcuts();
        return defaults;
    }

    async saveKeybinds(newKeybinds) {
        const keybindsToSave = [];
        for (const action in newKeybinds) {
            if (Object.prototype.hasOwnProperty.call(newKeybinds, action)) {
                keybindsToSave.push({
                    action: action,
                    accelerator: newKeybinds[action],
                });
            }
        }
        await shortcutsRepository.upsertKeybinds(keybindsToSave);
        console.log(`[Shortcuts] Saved keybinds.`);
    }

    toggleAllWindowsVisibility(windowPool) {
        const header = windowPool.get('header');
        if (!header) return;
      
        if (header.isVisible()) {
            this.lastVisibleWindows.clear();
      
            windowPool.forEach((win, name) => {
                if (win && !win.isDestroyed() && win.isVisible()) {
                    this.lastVisibleWindows.add(name);
                }
            });
      
            this.lastVisibleWindows.forEach(name => {
                if (name === 'header') return;
                const win = windowPool.get(name);
                if (win && !win.isDestroyed()) win.hide();
            });
            header.hide();
      
            return;
        }
      
        this.lastVisibleWindows.forEach(name => {
            const win = windowPool.get(name);
            if (win && !win.isDestroyed()) {
                win.show();
            }
        });
    }

    async registerShortcuts() {
        if (!this.movementManager || !this.windowPool) {
            console.error('[Shortcuts] Service not initialized. Cannot register shortcuts.');
            return;
        }
        const keybinds = await this.loadKeybinds();
        globalShortcut.unregisterAll();
        
        const header = this.windowPool.get('header');
        const mainWindow = header;

        const sendToRenderer = (channel, ...args) => {
            this.windowPool.forEach(win => {
                if (win && !win.isDestroyed()) {
                    try {
                        win.webContents.send(channel, ...args);
                    } catch (e) {
                        // Ignore errors for destroyed windows
                    }
                }
            });
        };
        
        sendToRenderer('shortcuts-updated', keybinds);

        // --- Hardcoded shortcuts ---
        const isMac = process.platform === 'darwin';
        const modifier = isMac ? 'Cmd' : 'Ctrl';
        
        // Monitor switching
        const displays = screen.getAllDisplays();
        if (displays.length > 1) {
            displays.forEach((display, index) => {
                const key = `${modifier}+Shift+${index + 1}`;
                globalShortcut.register(key, () => this.movementManager.moveToDisplay(display.id));
            });
        }

        // Edge snapping
        const edgeDirections = [
            { key: `${modifier}+Shift+Left`, direction: 'left' },
            { key: `${modifier}+Shift+Right`, direction: 'right' },
        ];
        edgeDirections.forEach(({ key, direction }) => {
            globalShortcut.register(key, () => {
                if (header && header.isVisible()) this.movementManager.moveToEdge(direction);
            });
        });

        // --- User-configurable shortcuts ---
        if (header?.currentHeaderState === 'apikey') {
            if (keybinds.toggleVisibility) {
                globalShortcut.register(keybinds.toggleVisibility, () => this.toggleAllWindowsVisibility(this.windowPool));
            }
            console.log('[Shortcuts] ApiKeyHeader is active, only toggleVisibility shortcut is registered.');
            return;
        }

        for (const action in keybinds) {
            const accelerator = keybinds[action];
            if (!accelerator) continue;

            let callback;
            switch(action) {
                case 'toggleVisibility':
                    callback = () => this.toggleAllWindowsVisibility(this.windowPool);
                    break;
                case 'nextStep':
                    callback = () => askService.toggleAskButton();
                    break;
                case 'scrollUp':
                    callback = () => {
                        const askWindow = this.windowPool.get('ask');
                        if (askWindow && !askWindow.isDestroyed() && askWindow.isVisible()) {
                            askWindow.webContents.send('scroll-response-up');
                        }
                    };
                    break;
                case 'scrollDown':
                    callback = () => {
                        const askWindow = this.windowPool.get('ask');
                        if (askWindow && !askWindow.isDestroyed() && askWindow.isVisible()) {
                            askWindow.webContents.send('scroll-response-down');
                        }
                    };
                    break;
                case 'moveUp':
                    callback = () => { if (header && header.isVisible()) this.movementManager.moveStep('up'); };
                    break;
                case 'moveDown':
                    callback = () => { if (header && header.isVisible()) this.movementManager.moveStep('down'); };
                    break;
                case 'moveLeft':
                    callback = () => { if (header && header.isVisible()) this.movementManager.moveStep('left'); };
                    break;
                case 'moveRight':
                    callback = () => { if (header && header.isVisible()) this.movementManager.moveStep('right'); };
                    break;
                case 'toggleClickThrough':
                     callback = () => {
                        this.mouseEventsIgnored = !this.mouseEventsIgnored;
                        if(mainWindow && !mainWindow.isDestroyed()){
                            mainWindow.setIgnoreMouseEvents(this.mouseEventsIgnored, { forward: true });
                            mainWindow.webContents.send('click-through-toggled', this.mouseEventsIgnored);
                        }
                     };
                     break;
                case 'manualScreenshot':
                    callback = () => {
                        if(mainWindow && !mainWindow.isDestroyed()) {
                             mainWindow.webContents.executeJavaScript('window.captureManualScreenshot && window.captureManualScreenshot();');
                        }
                    };
                    break;
                case 'previousResponse':
                    callback = () => sendToRenderer('navigate-previous-response');
                    break;
                case 'nextResponse':
                    callback = () => sendToRenderer('navigate-next-response');
                    break;
            }
            
            if (callback) {
                try {
                    globalShortcut.register(accelerator, callback);
                } catch(e) {
                    console.error(`[Shortcuts] Failed to register shortcut for "${action}" (${accelerator}):`, e.message);
                }
            }
        }
        console.log('[Shortcuts] All shortcuts have been registered.');
    }

    unregisterAll() {
        globalShortcut.unregisterAll();
        console.log('[Shortcuts] All shortcuts have been unregistered.');
    }
}

module.exports = new ShortcutsService(); 
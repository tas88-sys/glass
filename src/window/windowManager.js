const { BrowserWindow, globalShortcut, screen, app, shell } = require('electron');
const WindowLayoutManager = require('./windowLayoutManager');
const SmoothMovementManager = require('./smoothMovementManager');
const path = require('node:path');
const os = require('os');
const shortcutsService = require('../features/shortcuts/shortcutsService');
const internalBridge = require('../bridge/internalBridge');
const permissionRepository = require('../features/common/repositories/permission');

/* ────────────────[ GLASS BYPASS ]─────────────── */
let liquidGlass;
const isLiquidGlassSupported = () => {
    if (process.platform !== 'darwin') {
        return false;
    }
    const majorVersion = parseInt(os.release().split('.')[0], 10);
    // return majorVersion >= 25; // macOS 26+ (Darwin 25+)
    return majorVersion >= 26; // See you soon!
};
let shouldUseLiquidGlass = isLiquidGlassSupported();
if (shouldUseLiquidGlass) {
    try {
        liquidGlass = require('electron-liquid-glass');
    } catch (e) {
        console.warn('Could not load optional dependency "electron-liquid-glass". The feature will be disabled.');
        shouldUseLiquidGlass = false;
    }
}
/* ────────────────[ GLASS BYPASS ]─────────────── */

let isContentProtectionOn = true;
let lastVisibleWindows = new Set(['header']);

let currentHeaderState = 'apikey';
const windowPool = new Map();

let settingsHideTimer = null;


let layoutManager = null;
let movementManager = null;

/**
 * @param {BrowserWindow} win
 * @param {number} from
 * @param {number} to
 * @param {number} duration
 * @param {Function=} onComplete 
 */
function fadeWindow(win, from, to, duration = 250, onComplete) {
  if (!win || win.isDestroyed()) return;

  const FPS   = 60;
  const steps       = Math.max(1, Math.round(duration / (1000 / FPS)));
  let   currentStep = 0;

  win.setOpacity(from);

  const timer = setInterval(() => {
    if (win.isDestroyed()) { clearInterval(timer); return; }

    currentStep += 1;
    const progress = currentStep / steps;
    const eased    = progress < 1
      ? 1 - Math.pow(1 - progress, 3)
      : 1;

    win.setOpacity(from + (to - from) * eased);

    if (currentStep >= steps) {
      clearInterval(timer);
      win.setOpacity(to);
      onComplete && onComplete();
    }
  }, 1000 / FPS);
}

const showSettingsWindow = () => {
    internalBridge.emit('window:requestVisibility', { name: 'settings', visible: true });
};

const hideSettingsWindow = () => {
    internalBridge.emit('window:requestVisibility', { name: 'settings', visible: false });
};

const cancelHideSettingsWindow = () => {
    internalBridge.emit('window:requestVisibility', { name: 'settings', visible: true });
};

const moveWindowStep = (direction) => {
    internalBridge.emit('window:moveStep', { direction });
};

const resizeHeaderWindow = ({ width, height }) => {
    internalBridge.emit('window:resizeHeaderWindow', { width, height });
};

const handleHeaderAnimationFinished = (state) => {
    internalBridge.emit('window:headerAnimationFinished', state);
};

const getHeaderPosition = () => {
    internalBridge.emit('window:getHeaderPosition');
};

const moveHeaderTo = (newX, newY) => {
    internalBridge.emit('window:moveHeaderTo', { newX, newY });
};

const adjustWindowHeight = (sender, targetHeight) => {
    internalBridge.emit('window:adjustWindowHeight', { sender, targetHeight });
};


function setupWindowController(windowPool, layoutManager, movementManager) {
    internalBridge.on('window:requestVisibility', ({ name, visible }) => {
        handleWindowVisibilityRequest(windowPool, layoutManager, movementManager, name, visible);
    });
    internalBridge.on('window:requestToggleAllWindowsVisibility', ({ targetVisibility }) => {
        changeAllWindowsVisibility(windowPool, targetVisibility);
    });
    internalBridge.on('window:moveToDisplay', ({ displayId }) => {
        movementManager.moveToDisplay(displayId);
    });
    internalBridge.on('window:moveToEdge', ({ direction }) => {
        movementManager.moveToEdge(direction);
    });
    internalBridge.on('window:moveStep', ({ direction }) => {
        movementManager.moveStep(direction);
    });
    internalBridge.on('window:resizeHeaderWindow', ({ width, height }) => {
        resizingHeaderWindow(layoutManager, movementManager, { width, height });
    });
    internalBridge.on('window:headerAnimationFinished', (state) => {
        handlingHeaderAnimationFinished(windowPool, layoutManager, state);
    });
    internalBridge.on('window:getHeaderPosition', () => {
        gettingHeaderPosition(layoutManager);
    });
    internalBridge.on('window:moveHeaderTo', ({ newX, newY }) => {
        movingHeaderTo(layoutManager, newX, newY);
    });
    internalBridge.on('window:adjustWindowHeight', ({ sender, targetHeight }) => {
        adjustingWindowHeight(layoutManager, sender, targetHeight);
    });
}

function changeAllWindowsVisibility(windowPool, targetVisibility) {
    const header = windowPool.get('header');
    if (!header) return;

    if (typeof targetVisibility === 'boolean' &&
        header.isVisible() === targetVisibility) {
        return;
    }
  
    if (header.isVisible()) {
      lastVisibleWindows.clear();
  
      windowPool.forEach((win, name) => {
        if (win && !win.isDestroyed() && win.isVisible()) {
          lastVisibleWindows.add(name);
        }
      });
  
      lastVisibleWindows.forEach(name => {
        if (name === 'header') return;
        const win = windowPool.get(name);
        if (win && !win.isDestroyed()) win.hide();
      });
      header.hide();
  
      return;
    }
  
    lastVisibleWindows.forEach(name => {
      const win = windowPool.get(name);
      if (win && !win.isDestroyed())
        win.show();
    });
  }

/**
 * 
 * @param {Map<string, BrowserWindow>} windowPool
 * @param {WindowLayoutManager} layoutManager 
 * @param {SmoothMovementManager} movementManager
 * @param {'listen' | 'ask' | 'settings' | 'shortcut-settings'} name 
 * @param {boolean} shouldBeVisible 
 */
async function handleWindowVisibilityRequest(windowPool, layoutManager, movementManager, name, shouldBeVisible) {
    console.log(`[WindowManager] Request: set '${name}' visibility to ${shouldBeVisible}`);
    const win = windowPool.get(name);

    if (!win || win.isDestroyed()) {
        console.warn(`[WindowManager] Window '${name}' not found or destroyed.`);
        return;
    }

    if (name !== 'settings') {
        const isCurrentlyVisible = win.isVisible();
        if (isCurrentlyVisible === shouldBeVisible) {
            console.log(`[WindowManager] Window '${name}' is already in the desired state.`);
            return;
        }
    }

    const disableClicks = (selectedWindow) => {
        for (const [name, win] of windowPool) {
            if (win !== selectedWindow && !win.isDestroyed()) {
                win.setIgnoreMouseEvents(true, { forward: true });
            }
        }
    };

    const restoreClicks = () => {
        for (const [, win] of windowPool) {
            if (!win.isDestroyed()) win.setIgnoreMouseEvents(false);
        }
    };

    if (name === 'settings') {
        if (shouldBeVisible) {
            // Cancel any pending hide operations
            if (settingsHideTimer) {
                clearTimeout(settingsHideTimer);
                settingsHideTimer = null;
            }
            const position = layoutManager.calculateSettingsWindowPosition();
            if (position) {
                win.setBounds(position);
                win.__lockedByButton = true;
                win.show();
                win.moveTop();
                win.setAlwaysOnTop(true);
            } else {
                console.warn('[WindowManager] Could not calculate settings window position.');
            }
        } else {
            // Hide after a delay
            if (settingsHideTimer) {
                clearTimeout(settingsHideTimer);
            }
            settingsHideTimer = setTimeout(() => {
                if (win && !win.isDestroyed()) {
                    win.setAlwaysOnTop(false);
                    win.hide();
                }
                settingsHideTimer = null;
            }, 200);

            win.__lockedByButton = false;
        }
        return;
    }


    if (name === 'shortcut-settings') {
        if (shouldBeVisible) {
            layoutManager.positionShortcutSettingsWindow();
            if (process.platform === 'darwin') {
                win.setAlwaysOnTop(true, 'screen-saver');
            } else {
                win.setAlwaysOnTop(true);
            }
            // globalShortcut.unregisterAll();
            disableClicks(win);
            win.show();
        } else {
            if (process.platform === 'darwin') {
                win.setAlwaysOnTop(false, 'screen-saver');
            } else {
                win.setAlwaysOnTop(false);
            }
            restoreClicks();
            win.hide();
        }
        return;
    }

    if (name === 'listen' || name === 'ask') {
        const otherName = name === 'listen' ? 'ask' : 'listen';
        const otherWin = windowPool.get(otherName);
        const isOtherWinVisible = otherWin && !otherWin.isDestroyed() && otherWin.isVisible();

        const ANIM_OFFSET_X = 50; 
        const ANIM_OFFSET_Y = 20;

        if (shouldBeVisible) {
            win.setOpacity(0);

            if (name === 'listen') {
                if (!isOtherWinVisible) {
                    const targets = layoutManager.getTargetBoundsForFeatureWindows({ listen: true, ask: false });
                    if (!targets.listen) return;

                    const startPos = { x: targets.listen.x - ANIM_OFFSET_X, y: targets.listen.y };
                    win.setBounds(startPos);
                    win.show();
                    fadeWindow(win, 0, 1);
                    movementManager.animateWindow(win, targets.listen.x, targets.listen.y);

                } else {
                    const targets = layoutManager.getTargetBoundsForFeatureWindows({ listen: true, ask: true });
                    if (!targets.listen || !targets.ask) return;

                    const startListenPos = { x: targets.listen.x - ANIM_OFFSET_X, y: targets.listen.y };
                    win.setBounds(startListenPos);

                    win.show();
                    fadeWindow(win, 0, 1);
                    movementManager.animateWindow(otherWin, targets.ask.x, targets.ask.y);
                    movementManager.animateWindow(win, targets.listen.x, targets.listen.y);
                }
            } else if (name === 'ask') {
                if (!isOtherWinVisible) {
                    const targets = layoutManager.getTargetBoundsForFeatureWindows({ listen: false, ask: true });
                    if (!targets.ask) return;

                    const startPos = { x: targets.ask.x, y: targets.ask.y - ANIM_OFFSET_Y };
                    win.setBounds(startPos);
                    win.show();
                    fadeWindow(win, 0, 1);
                    movementManager.animateWindow(win, targets.ask.x, targets.ask.y);

                } else {
                    const targets = layoutManager.getTargetBoundsForFeatureWindows({ listen: true, ask: true });
                    if (!targets.listen || !targets.ask) return;

                    const startAskPos = { x: targets.ask.x, y: targets.ask.y - ANIM_OFFSET_Y };
                    win.setBounds(startAskPos);

                    win.show();
                    fadeWindow(win, 0, 1);
                    movementManager.animateWindow(otherWin, targets.listen.x, targets.listen.y);
                    movementManager.animateWindow(win, targets.ask.x, targets.ask.y);
                }
            }
        } else {
            const currentBounds = win.getBounds();
            fadeWindow(
                win, 1, 0, 250,
                () => win.hide()
            );
            if (name === 'listen') {
                if (!isOtherWinVisible) {
                    const targetX = currentBounds.x - ANIM_OFFSET_X;
                    movementManager.animateWindow(win, targetX, currentBounds.y);
                } else {
                    const targetX = currentBounds.x - ANIM_OFFSET_X;
                    movementManager.animateWindow(win, targetX, currentBounds.y);
                }
            } else if (name === 'ask') {
                if (!isOtherWinVisible) {
                    const targetY = currentBounds.y - ANIM_OFFSET_Y;
                    movementManager.animateWindow(win, currentBounds.x, targetY);
                } else {
                    const targetAskY = currentBounds.y - ANIM_OFFSET_Y;
                    movementManager.animateWindow(win, currentBounds.x, targetAskY);

                    const targets = layoutManager.getTargetBoundsForFeatureWindows({ listen: true, ask: false });
                    if (targets.listen) {
                        movementManager.animateWindow(otherWin, targets.listen.x, targets.listen.y);
                    }
                }
            }
        }
    }
}


const setContentProtection = (status) => {
    isContentProtectionOn = status;
    console.log(`[Protection] Content protection toggled to: ${isContentProtectionOn}`);
    windowPool.forEach(win => {
        if (win && !win.isDestroyed()) {
            win.setContentProtection(isContentProtectionOn);
        }
    });
};

const getContentProtectionStatus = () => isContentProtectionOn;

const toggleContentProtection = () => {
    const newStatus = !getContentProtectionStatus();
    setContentProtection(newStatus);
    return newStatus;
};


const openLoginPage = () => {
    const webUrl = process.env.pickleglass_WEB_URL || 'http://localhost:3000';
    const personalizeUrl = `${webUrl}/personalize?desktop=true`;
    shell.openExternal(personalizeUrl);
    console.log('Opening personalization page:', personalizeUrl);
};


function createFeatureWindows(header, namesToCreate) {
    // if (windowPool.has('listen')) return;

    const commonChildOptions = {
        parent: header,
        show: false,
        frame: false,
        transparent: true,
        vibrancy: false,
        hasShadow: false,
        skipTaskbar: true,
        hiddenInMissionControl: true,
        resizable: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, '../preload.js'),
        },
    };

    const createFeatureWindow = (name) => {
        if (windowPool.has(name)) return;
        
        switch (name) {
            case 'listen': {
                const listen = new BrowserWindow({
                    ...commonChildOptions, width:400,minWidth:400,maxWidth:900,
                    maxHeight:900,
                });
                listen.setContentProtection(isContentProtectionOn);
                listen.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true});
                if (process.platform === 'darwin') {
                    listen.setWindowButtonVisibility(false);
                }
                const listenLoadOptions = { query: { view: 'listen' } };
                if (!shouldUseLiquidGlass) {
                    listen.loadFile(path.join(__dirname, '../ui/app/content.html'), listenLoadOptions);
                }
                else {
                    listenLoadOptions.query.glass = 'true';
                    listen.loadFile(path.join(__dirname, '../ui/app/content.html'), listenLoadOptions);
                    listen.webContents.once('did-finish-load', () => {
                        const viewId = liquidGlass.addView(listen.getNativeWindowHandle());
                        if (viewId !== -1) {
                            liquidGlass.unstable_setVariant(viewId, liquidGlass.GlassMaterialVariant.bubbles);
                            // liquidGlass.unstable_setScrim(viewId, 1);
                            // liquidGlass.unstable_setSubdued(viewId, 1);
                        }
                    });
                }
                if (!app.isPackaged) {
                    listen.webContents.openDevTools({ mode: 'detach' });
                }
                windowPool.set('listen', listen);
                break;
            }

            // ask
            case 'ask': {
                const ask = new BrowserWindow({ ...commonChildOptions, width:600 });
                ask.setContentProtection(isContentProtectionOn);
                ask.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true});
                if (process.platform === 'darwin') {
                    ask.setWindowButtonVisibility(false);
                }
                const askLoadOptions = { query: { view: 'ask' } };
                if (!shouldUseLiquidGlass) {
                    ask.loadFile(path.join(__dirname, '../ui/app/content.html'), askLoadOptions);
                }
                else {
                    askLoadOptions.query.glass = 'true';
                    ask.loadFile(path.join(__dirname, '../ui/app/content.html'), askLoadOptions);
                    ask.webContents.once('did-finish-load', () => {
                        const viewId = liquidGlass.addView(ask.getNativeWindowHandle());
                        if (viewId !== -1) {
                            liquidGlass.unstable_setVariant(viewId, liquidGlass.GlassMaterialVariant.bubbles);
                            // liquidGlass.unstable_setScrim(viewId, 1);
                            // liquidGlass.unstable_setSubdued(viewId, 1);
                        }
                    });
                }
                
                // Open DevTools in development
                if (!app.isPackaged) {
                    ask.webContents.openDevTools({ mode: 'detach' });
                }
                windowPool.set('ask', ask);
                break;
            }

            // settings
            case 'settings': {
                const settings = new BrowserWindow({ ...commonChildOptions, width:240, maxHeight:400, parent:undefined });
                settings.setContentProtection(isContentProtectionOn);
                settings.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true});
                if (process.platform === 'darwin') {
                    settings.setWindowButtonVisibility(false);
                }
                const settingsLoadOptions = { query: { view: 'settings' } };
                if (!shouldUseLiquidGlass) {
                    settings.loadFile(path.join(__dirname,'../ui/app/content.html'), settingsLoadOptions)
                        .catch(console.error);
                }
                else {
                    settingsLoadOptions.query.glass = 'true';
                    settings.loadFile(path.join(__dirname,'../ui/app/content.html'), settingsLoadOptions)
                        .catch(console.error);
                    settings.webContents.once('did-finish-load', () => {
                        const viewId = liquidGlass.addView(settings.getNativeWindowHandle());
                        if (viewId !== -1) {
                            liquidGlass.unstable_setVariant(viewId, liquidGlass.GlassMaterialVariant.bubbles);
                            // liquidGlass.unstable_setScrim(viewId, 1);
                            // liquidGlass.unstable_setSubdued(viewId, 1);
                        }
                    });
                }
                windowPool.set('settings', settings);  

                if (!app.isPackaged) {
                    settings.webContents.openDevTools({ mode: 'detach' });
                }
                break;
            }

            case 'shortcut-settings': {
                const shortcutEditor = new BrowserWindow({
                    ...commonChildOptions,
                    width: 353,
                    height: 720,
                    modal: false,
                    parent: undefined,
                    alwaysOnTop: true,
                    titleBarOverlay: false,
                });

                shortcutEditor.setContentProtection(isContentProtectionOn);
                shortcutEditor.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true});
                if (process.platform === 'darwin') {
                    shortcutEditor.setWindowButtonVisibility(false);
                }

                const loadOptions = { query: { view: 'shortcut-settings' } };
                if (!shouldUseLiquidGlass) {
                    shortcutEditor.loadFile(path.join(__dirname, '../ui/app/content.html'), loadOptions);
                } else {
                    loadOptions.query.glass = 'true';
                    shortcutEditor.loadFile(path.join(__dirname, '../ui/app/content.html'), loadOptions);
                    shortcutEditor.webContents.once('did-finish-load', () => {
                        const viewId = liquidGlass.addView(shortcutEditor.getNativeWindowHandle());
                        if (viewId !== -1) {
                            liquidGlass.unstable_setVariant(viewId, liquidGlass.GlassMaterialVariant.bubbles);
                        }
                    });
                }

                windowPool.set('shortcut-settings', shortcutEditor);
                if (!app.isPackaged) {
                    shortcutEditor.webContents.openDevTools({ mode: 'detach' });
                }
                break;
            }
        }
    };

    if (Array.isArray(namesToCreate)) {
        namesToCreate.forEach(name => createFeatureWindow(name));
    } else if (typeof namesToCreate === 'string') {
        createFeatureWindow(namesToCreate);
    } else {
        createFeatureWindow('listen');
        createFeatureWindow('ask');
        createFeatureWindow('settings');
        createFeatureWindow('shortcut-settings');
    }
}

function destroyFeatureWindows() {
    const featureWindows = ['listen','ask','settings','shortcut-settings'];
    if (settingsHideTimer) {
        clearTimeout(settingsHideTimer);
        settingsHideTimer = null;
    }
    featureWindows.forEach(name=>{
        const win = windowPool.get(name);
        if (win && !win.isDestroyed()) win.destroy();
        windowPool.delete(name);
    });
}



function getCurrentDisplay(window) {
    if (!window || window.isDestroyed()) return screen.getPrimaryDisplay();

    const windowBounds = window.getBounds();
    const windowCenter = {
        x: windowBounds.x + windowBounds.width / 2,
        y: windowBounds.y + windowBounds.height / 2,
    };

    return screen.getDisplayNearestPoint(windowCenter);
}



function createWindows() {
    const HEADER_HEIGHT        = 47;
    const DEFAULT_WINDOW_WIDTH = 353;

    const primaryDisplay = screen.getPrimaryDisplay();
    const { y: workAreaY, width: screenWidth } = primaryDisplay.workArea;

    const initialX = Math.round((screenWidth - DEFAULT_WINDOW_WIDTH) / 2);
    const initialY = workAreaY + 21;
        
    const header = new BrowserWindow({
        width: DEFAULT_WINDOW_WIDTH,
        height: HEADER_HEIGHT,
        x: initialX,
        y: initialY,
        frame: false,
        transparent: true,
        vibrancy: false,
        hasShadow: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        hiddenInMissionControl: true,
        resizable: false,
        focusable: true,
        acceptFirstMouse: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, '../preload.js'),
            backgroundThrottling: false,
            webSecurity: false,
            enableRemoteModule: false,
            // Ensure proper rendering and prevent pixelation
            experimentalFeatures: false,
        },
        // Prevent pixelation and ensure proper rendering
        useContentSize: true,
        disableAutoHideCursor: true,
    });
    if (process.platform === 'darwin') {
        header.setWindowButtonVisibility(false);
    }
    const headerLoadOptions = {};
    if (!shouldUseLiquidGlass) {
        header.loadFile(path.join(__dirname, '../ui/app/header.html'), headerLoadOptions);
    }
    else {
        headerLoadOptions.query = { glass: 'true' };
        header.loadFile(path.join(__dirname, '../ui/app/header.html'), headerLoadOptions);
        header.webContents.once('did-finish-load', () => {
            const viewId = liquidGlass.addView(header.getNativeWindowHandle());
            if (viewId !== -1) {
                liquidGlass.unstable_setVariant(viewId, liquidGlass.GlassMaterialVariant.bubbles);
                // liquidGlass.unstable_setScrim(viewId, 1); 
                // liquidGlass.unstable_setSubdued(viewId, 1);
            }
        });
    }
    windowPool.set('header', header);
    layoutManager = new WindowLayoutManager(windowPool);
    movementManager = new SmoothMovementManager(windowPool, layoutManager);

    header.on('moved', () => layoutManager.updateLayout());

    header.webContents.once('dom-ready', () => {
        shortcutsService.initialize(windowPool);
        shortcutsService.registerShortcuts();
    });

    setupIpcHandlers(movementManager, layoutManager);
    setupWindowController(windowPool, layoutManager, movementManager);

    if (currentHeaderState === 'main') {
        createFeatureWindows(header, ['listen', 'ask', 'settings', 'shortcut-settings']);
    }

    header.setContentProtection(isContentProtectionOn);
    header.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    
    // Open DevTools in development
    if (!app.isPackaged) {
        header.webContents.openDevTools({ mode: 'detach' });
    }

    header.on('focus', () => {
        console.log('[WindowManager] Header gained focus');
    });

    header.on('blur', () => {
        console.log('[WindowManager] Header lost focus');
    });

    header.webContents.on('before-input-event', (event, input) => {
        if (input.type === 'mouseDown') {
            const target = input.target;
            if (target && (target.includes('input') || target.includes('apikey'))) {
                header.focus();
            }
        }
    });

    header.on('resize', () => {
        console.log('[WindowManager] Header resize event triggered');
        layoutManager.updateLayout();
    });

    return windowPool;
}

function setupIpcHandlers(movementManager, layoutManager) {
    // quit-application handler moved to windowBridge.js to avoid duplication
    screen.on('display-added', (event, newDisplay) => {
        console.log('[Display] New display added:', newDisplay.id);
    });

    screen.on('display-removed', (event, oldDisplay) => {
        console.log('[Display] Display removed:', oldDisplay.id);
        const header = windowPool.get('header');
        if (header && getCurrentDisplay(header).id === oldDisplay.id) {
            const primaryDisplay = screen.getPrimaryDisplay();
            movementManager.moveToDisplay(primaryDisplay.id);
        }
    });

    screen.on('display-metrics-changed', (event, display, changedMetrics) => {
        // console.log('[Display] Display metrics changed:', display.id, changedMetrics);
        layoutManager.updateLayout();
    });
}


const handleHeaderStateChanged = (state) => {
    console.log(`[WindowManager] Header state changed to: ${state}`);
    currentHeaderState = state;

    if (state === 'main') {
        createFeatureWindows(windowPool.get('header'));
    } else {         // 'apikey' | 'permission'
        destroyFeatureWindows();
    }
    internalBridge.emit('reregister-shortcuts');
};


const resizingHeaderWindow = (layoutManager, movementManager, { width, height }) => {
    if (movementManager.isAnimating) {
        console.log('[WindowManager] Skipping resize during animation');
        return { success: false, error: 'Cannot resize during animation' };
      }

    return layoutManager.resizeHeaderWindow({ width, height });
};

const handlingHeaderAnimationFinished = (windowPool, layoutManager, state) => {
    const header = windowPool.get('header');
    if (!header || header.isDestroyed()) return;

    if (state === 'hidden') {
        header.hide();
        console.log('[WindowManager] Header hidden after animation.');
    } else if (state === 'visible') {
        console.log('[WindowManager] Header shown after animation.');
        layoutManager.updateLayout();
    }
};

const gettingHeaderPosition = (layoutManager) => {
    return layoutManager.getHeaderPosition();
};

const movingHeaderTo = (layoutManager, newX, newY) => {
    layoutManager.moveHeaderTo(newX, newY);
};

const adjustingWindowHeight = (layoutManager, sender, targetHeight) => {
    layoutManager.adjustWindowHeight(sender, targetHeight);
};


module.exports = {
    createWindows,
    windowPool,
    toggleContentProtection,
    resizeHeaderWindow,
    getContentProtectionStatus,
    showSettingsWindow,
    hideSettingsWindow,
    cancelHideSettingsWindow,
    openLoginPage,
    moveWindowStep,
    handleHeaderStateChanged,
    handleHeaderAnimationFinished,
    getHeaderPosition,
    moveHeaderTo,
    adjustWindowHeight,
};
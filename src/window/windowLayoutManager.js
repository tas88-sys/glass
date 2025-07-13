const { screen } = require('electron');

/**
 * 
 * @param {BrowserWindow} window 
 * @returns {Display}
 */
function getCurrentDisplay(window) {
    if (!window || window.isDestroyed()) return screen.getPrimaryDisplay();

    const windowBounds = window.getBounds();
    const windowCenter = {
        x: windowBounds.x + windowBounds.width / 2,
        y: windowBounds.y + windowBounds.height / 2,
    };

    return screen.getDisplayNearestPoint(windowCenter);
}

class WindowLayoutManager {
    /**
     * @param {Map<string, BrowserWindow>} windowPool - 관리할 창들의 맵
     */
    constructor(windowPool) {
        this.windowPool = windowPool;
        this.isUpdating = false;
        this.PADDING = 80;
    }

    updateLayout() {
        if (this.isUpdating) return;
        this.isUpdating = true;

        setImmediate(() => {
            this.positionWindows();
            this.isUpdating = false;
        });
    }

    /**
     * 
     * @param {object} [visibilityOverride] - { listen: true, ask: true }
     * @returns {{listen: {x:number, y:number}|null, ask: {x:number, y:number}|null}}
     */
    getTargetBoundsForFeatureWindows(visibilityOverride = {}) {
        const header = this.windowPool.get('header');
        if (!header?.getBounds) return {};
 
        const headerBounds = header.getBounds();
        const display = getCurrentDisplay(header);
        const { width: screenWidth, height: screenHeight } = display.workAreaSize;
        const { x: workAreaX, y: workAreaY } = display.workArea;
 
        const ask = this.windowPool.get('ask');
        const listen = this.windowPool.get('listen');
 
        const askVis = visibilityOverride.ask !== undefined ?
            visibilityOverride.ask :
            (ask && ask.isVisible() && !ask.isDestroyed());
        const listenVis = visibilityOverride.listen !== undefined ?
            visibilityOverride.listen :
            (listen && listen.isVisible() && !listen.isDestroyed());
 
        if (!askVis && !listenVis) return {};
 
        const PAD = 8;
        const headerTopRel = headerBounds.y - workAreaY;
        const headerBottomRel = headerTopRel + headerBounds.height;
        const headerCenterXRel = headerBounds.x - workAreaX + headerBounds.width / 2;
        
        const relativeX = headerCenterXRel / screenWidth;
        const relativeY = (headerBounds.y - workAreaY) / screenHeight;
        const strategy = this.determineLayoutStrategy(headerBounds, screenWidth, screenHeight, relativeX, relativeY, workAreaX, workAreaY);
 
        const askB = ask ? ask.getBounds() : null;
        const listenB = listen ? listen.getBounds() : null;
 
        const result = { listen: null, ask: null };
 
        if (askVis && listenVis) {
            let askXRel = headerCenterXRel - (askB.width / 2);
            let listenXRel = askXRel - listenB.width - PAD;
 
            if (listenXRel < PAD) {
                listenXRel = PAD;
                askXRel = listenXRel + listenB.width + PAD;
            }
            if (askXRel + askB.width > screenWidth - PAD) {
                askXRel = screenWidth - PAD - askB.width;
                listenXRel = askXRel - listenB.width - PAD;
            }
            
            // [수정] 'above'일 경우 하단 정렬, 'below'일 경우 상단 정렬
            if (strategy.primary === 'above') {
                const windowBottomAbs = headerBounds.y - PAD;
                const askY = windowBottomAbs - askB.height;
                const listenY = windowBottomAbs - listenB.height;
                result.ask = { x: Math.round(askXRel + workAreaX), y: Math.round(askY) };
                result.listen = { x: Math.round(listenXRel + workAreaX), y: Math.round(listenY) };
            } else { // 'below'
                const yPos = headerBottomRel + PAD;
                const yAbs = yPos + workAreaY;
                result.ask = { x: Math.round(askXRel + workAreaX), y: Math.round(yAbs) };
                result.listen = { x: Math.round(listenXRel + workAreaX), y: Math.round(yAbs) };
            }
 
        } else { // 한 창만 보일 때는 기존 로직 유지 (정상 동작 확인)
            const winB = askVis ? askB : listenB;
            let xRel = headerCenterXRel - winB.width / 2;
            xRel = Math.max(PAD, Math.min(screenWidth - winB.width - PAD, xRel));

            let yPos;
            if (strategy.primary === 'above') {
                const windowBottomRel = headerTopRel - PAD;
                yPos = windowBottomRel - winB.height;
            } else { // 'below'
                yPos = headerBottomRel + PAD;
            }
            
            const abs = { x: Math.round(xRel + workAreaX), y: Math.round(yPos + workAreaY) };
            if (askVis) result.ask = abs;
            if (listenVis) result.listen = abs;
        }
        return result;
    }

    positionWindows() {
        const header = this.windowPool.get('header');
        if (!header?.getBounds) return;

        const headerBounds = header.getBounds();
        const display = getCurrentDisplay(header);
        const { width: screenWidth, height: screenHeight } = display.workAreaSize;
        const { x: workAreaX, y: workAreaY } = display.workArea;

        const headerCenterX = headerBounds.x - workAreaX + headerBounds.width / 2;
        const headerCenterY = headerBounds.y - workAreaY + headerBounds.height / 2;

        const relativeX = headerCenterX / screenWidth;
        const relativeY = headerCenterY / screenHeight;

        const strategy = this.determineLayoutStrategy(headerBounds, screenWidth, screenHeight, relativeX, relativeY, workAreaX, workAreaY);

        this.positionFeatureWindows(headerBounds, strategy, screenWidth, screenHeight, workAreaX, workAreaY);
        this.positionSettingsWindow(headerBounds, strategy, screenWidth, screenHeight, workAreaX, workAreaY);
    }

    /**
     * 
     * @returns {{name: string, primary: string, secondary: string}}
     */
    determineLayoutStrategy(headerBounds, screenWidth, screenHeight, relativeX, relativeY, workAreaX, workAreaY) {
        const headerRelX = headerBounds.x - workAreaX;
        const headerRelY = headerBounds.y - workAreaY;

        const spaceBelow = screenHeight - (headerRelY + headerBounds.height);
        const spaceAbove = headerRelY;
        const spaceLeft = headerRelX;
        const spaceRight = screenWidth - (headerRelX + headerBounds.width);

        if (spaceBelow >= 400) {
            return { name: 'below', primary: 'below', secondary: relativeX < 0.5 ? 'right' : 'left' };
        } else if (spaceAbove >= 400) {
            return { name: 'above', primary: 'above', secondary: relativeX < 0.5 ? 'right' : 'left' };
        } else if (relativeX < 0.3 && spaceRight >= 800) {
            return { name: 'right-side', primary: 'right', secondary: spaceBelow > spaceAbove ? 'below' : 'above' };
        } else if (relativeX > 0.7 && spaceLeft >= 800) {
            return { name: 'left-side', primary: 'left', secondary: spaceBelow > spaceAbove ? 'below' : 'above' };
        } else {
            return { name: 'adaptive', primary: spaceBelow > spaceAbove ? 'below' : 'above', secondary: spaceRight > spaceLeft ? 'right' : 'left' };
        }
    }


    positionFeatureWindows(headerBounds, strategy, screenWidth, screenHeight, workAreaX, workAreaY) {
        const ask = this.windowPool.get('ask');
        const listen = this.windowPool.get('listen');
        const askVisible = ask && ask.isVisible() && !ask.isDestroyed();
        const listenVisible = listen && listen.isVisible() && !listen.isDestroyed();

        if (!askVisible && !listenVisible) return;

        const PAD = 8;
        const headerTopRel = headerBounds.y - workAreaY;
        const headerBottomRel = headerTopRel + headerBounds.height;
        const headerCenterXRel = headerBounds.x - workAreaX + headerBounds.width / 2;
        
        let askBounds = askVisible ? ask.getBounds() : null;
        let listenBounds = listenVisible ? listen.getBounds() : null;

        if (askVisible && listenVisible) {
            let askXRel = headerCenterXRel - (askBounds.width / 2);
            let listenXRel = askXRel - listenBounds.width - PAD;

            if (listenXRel < PAD) {
                listenXRel = PAD;
                askXRel = listenXRel + listenBounds.width + PAD;
            }
            if (askXRel + askBounds.width > screenWidth - PAD) {
                askXRel = screenWidth - PAD - askBounds.width;
                listenXRel = askXRel - listenBounds.width - PAD;
            }

            // [수정] 'above'일 경우 하단 정렬, 'below'일 경우 상단 정렬
            if (strategy.primary === 'above') {
                const windowBottomAbs = headerBounds.y - PAD;
                const askY = windowBottomAbs - askBounds.height;
                const listenY = windowBottomAbs - listenBounds.height;
                ask.setBounds({ x: Math.round(askXRel + workAreaX), y: Math.round(askY), width: askBounds.width, height: askBounds.height });
                listen.setBounds({ x: Math.round(listenXRel + workAreaX), y: Math.round(listenY), width: listenBounds.width, height: listenBounds.height });
            } else { // 'below'
                const yPos = headerBottomRel + PAD;
                const yAbs = yPos + workAreaY;
                ask.setBounds({ x: Math.round(askXRel + workAreaX), y: Math.round(yAbs), width: askBounds.width, height: askBounds.height });
                listen.setBounds({ x: Math.round(listenXRel + workAreaX), y: Math.round(yAbs), width: listenBounds.width, height: listenBounds.height });
            }
        
        } else { // 한 창만 보일 때는 기존 로직 유지 (정상 동작 확인)
            const win = askVisible ? ask : listen;
            const winBounds = askVisible ? askBounds : listenBounds;
            let xRel = headerCenterXRel - winBounds.width / 2;
            xRel = Math.max(PAD, Math.min(screenWidth - winBounds.width - PAD, xRel));

            let yPos;
            if (strategy.primary === 'above') {
                const windowBottomRel = headerTopRel - PAD;
                yPos = windowBottomRel - winBounds.height;
            } else { // 'below'
                yPos = headerBottomRel + PAD;
            }
            const yAbs = yPos + workAreaY;

            win.setBounds({ x: Math.round(xRel + workAreaX), y: Math.round(yAbs), width: winBounds.width, height: winBounds.height });
        }
    }

    positionSettingsWindow(headerBounds, strategy, screenWidth, screenHeight, workAreaX, workAreaY) {
        const settings = this.windowPool.get('settings');
        if (!settings?.getBounds || !settings.isVisible()) return;

        if (settings.__lockedByButton) {
            const headerDisplay = getCurrentDisplay(this.windowPool.get('header'));
            const settingsDisplay = getCurrentDisplay(settings);
            if (headerDisplay.id !== settingsDisplay.id) {
                settings.__lockedByButton = false;
            } else {
                return;
            }
        }

        const settingsBounds = settings.getBounds();
        const PAD = 5;
        const buttonPadding = 17;
        let x = headerBounds.x + headerBounds.width - settingsBounds.width - buttonPadding;
        let y = headerBounds.y + headerBounds.height + PAD;

        const otherVisibleWindows = [];
        ['listen', 'ask'].forEach(name => {
            const win = this.windowPool.get(name);
            if (win && win.isVisible() && !win.isDestroyed()) {
                otherVisibleWindows.push({ name, bounds: win.getBounds() });
            }
        });

        const settingsNewBounds = { x, y, width: settingsBounds.width, height: settingsBounds.height };
        let hasOverlap = otherVisibleWindows.some(otherWin => this.boundsOverlap(settingsNewBounds, otherWin.bounds));

        if (hasOverlap) {
            x = headerBounds.x + headerBounds.width + PAD;
            y = headerBounds.y;
            if (x + settingsBounds.width > screenWidth - 10) {
                x = headerBounds.x - settingsBounds.width - PAD;
            }
            if (x < 10) {
                x = headerBounds.x + headerBounds.width - settingsBounds.width - buttonPadding;
                y = headerBounds.y - settingsBounds.height - PAD;
                if (y < 10) {
                    x = headerBounds.x + headerBounds.width - settingsBounds.width;
                    y = headerBounds.y + headerBounds.height + PAD;
                }
            }
        }

        x = Math.max(workAreaX + 10, Math.min(workAreaX + screenWidth - settingsBounds.width - 10, x));
        y = Math.max(workAreaY + 10, Math.min(workAreaY + screenHeight - settingsBounds.height - 10, y));

        settings.setBounds({ x: Math.round(x), y: Math.round(y) });
        settings.moveTop();
    }
    
    /**
     * @param {Rectangle} bounds1
     * @param {Rectangle} bounds2
     * @returns {boolean}
     */
    boundsOverlap(bounds1, bounds2) {
        const margin = 10;
        return !(
            bounds1.x + bounds1.width + margin < bounds2.x ||
            bounds2.x + bounds2.width + margin < bounds1.x ||
            bounds1.y + bounds1.height + margin < bounds2.y ||
            bounds2.y + bounds2.height + margin < bounds1.y
        );
    }
}

module.exports = WindowLayoutManager;
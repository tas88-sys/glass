const { screen } = require('electron');

// Window height traces run on every content change (thousands of lines a
// session); they print only with GLASS_LAYOUT_DEBUG=1.
const layoutDebug = (...args) => {
    if (process.env.GLASS_LAYOUT_DEBUG === '1') console.log(...args);
};

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

// Electron's DIP layout on Windows with mixed scale factors can leave small
// gaps or overlaps between display bounds.
const ADJACENT_TOLERANCE = 8;

// A step animates for 300 ms (SmoothMovementManager); a little more is kept.
const STEP_ANIMATION_MS = 350;

/**
 * The nearest display touching `display`'s edge in `direction` and sharing
 * part of that edge, or null.
 * @param {Display} display
 * @param {'left'|'right'|'up'|'down'} direction
 * @returns {Display|null}
 */
function adjacentDisplay(display, direction) {
    const a = display.bounds;
    let best = null;
    let bestGap = Infinity;
    for (const d of screen.getAllDisplays()) {
        if (d.id === display.id) continue;
        const b = d.bounds;
        const sharesRows = b.y < a.y + a.height && b.y + b.height > a.y;
        const sharesColumns = b.x < a.x + a.width && b.x + b.width > a.x;
        let gap;
        switch (direction) {
            case 'left': gap = sharesRows ? a.x - (b.x + b.width) : Infinity; break;
            case 'right': gap = sharesRows ? b.x - (a.x + a.width) : Infinity; break;
            case 'up': gap = sharesColumns ? a.y - (b.y + b.height) : Infinity; break;
            case 'down': gap = sharesColumns ? b.y - (a.y + a.height) : Infinity; break;
            default: gap = Infinity;
        }
        if (Math.abs(gap) <= ADJACENT_TOLERANCE && Math.abs(gap) < bestGap) {
            best = d;
            bestGap = Math.abs(gap);
        }
    }
    return best;
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

    getHeaderPosition = () => {
        const header = this.windowPool.get('header');
        if (header) {
            const [x, y] = header.getPosition();
            return { x, y };
        }
        return { x: 0, y: 0 };
    };


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



    /**
     * @returns {{x: number, y: number} | null}
     */
    calculateSettingsWindowPosition() {
        const header = this.windowPool.get('header');
        const settings = this.windowPool.get('settings');

        if (!header || header.isDestroyed() || !settings || settings.isDestroyed()) {
            return null;
        }

        const headerBounds = header.getBounds();
        const settingsBounds = settings.getBounds();
        const display = getCurrentDisplay(header);
        const { x: workAreaX, y: workAreaY, width: screenWidth, height: screenHeight } = display.workArea;

        const PAD = 5;
        const buttonPadding = 170;

        const x = headerBounds.x + headerBounds.width - settingsBounds.width + buttonPadding;
        const y = headerBounds.y + headerBounds.height + PAD;

        const clampedX = Math.max(workAreaX + 10, Math.min(workAreaX + screenWidth - settingsBounds.width - 10, x));
        const clampedY = Math.max(workAreaY + 10, Math.min(workAreaY + screenHeight - settingsBounds.height - 10, y));

        return { x: Math.round(clampedX), y: Math.round(clampedY) };
    }


    /**
     * Calculate position of the mode-picker window below the caret in the header.
     * Mirrors calculateSettingsWindowPosition — anchors below the header with PAD=5.
     * CARET_RIGHT_OFFSET is the caret's CSS distance from the right edge of the header
     * (placeholder 40px; tuned visually during P5 QA).
     * @returns {{x: number, y: number, width: number, height: number} | null}
     */
    calculateModePickerWindowPosition() {
        const header = this.windowPool.get('header');
        const modePicker = this.windowPool.get('mode-picker');

        if (!header || header.isDestroyed() || !modePicker || modePicker.isDestroyed()) {
            return null;
        }

        const headerBounds = header.getBounds();
        const modePickerBounds = modePicker.getBounds();
        const display = getCurrentDisplay(header);
        const { x: workAreaX, y: workAreaY, width: screenWidth, height: screenHeight } = display.workArea;

        const PAD = 5;
        const CARET_RIGHT_OFFSET = 40; // px from right edge of header to caret center; tuned in P5.6

        const x = headerBounds.x + headerBounds.width - CARET_RIGHT_OFFSET - (modePickerBounds.width / 2);
        const y = headerBounds.y + headerBounds.height + PAD;

        const clampedX = Math.max(workAreaX + 10, Math.min(workAreaX + screenWidth - modePickerBounds.width - 10, x));
        const clampedY = Math.max(workAreaY + 10, Math.min(workAreaY + screenHeight - modePickerBounds.height - 10, y));

        return {
            x: Math.round(clampedX),
            y: Math.round(clampedY),
            width: modePickerBounds.width,
            height: modePickerBounds.height,
        };
    }

    calculateHeaderResize(header, { width, height }) {
        if (!header) return null;
        const currentBounds = header.getBounds();
        const centerX = currentBounds.x + currentBounds.width / 2;
        const newX = Math.round(centerX - width / 2);
        const display = getCurrentDisplay(header);
        const { x: workAreaX, width: workAreaWidth } = display.workArea;
        const clampedX = Math.max(workAreaX, Math.min(workAreaX + workAreaWidth - width, newX));
        return { x: clampedX, y: currentBounds.y, width, height };
    }
    
    calculateClampedPosition(header, { x: newX, y: newY }) {
        if (!header) return null;
        const headerBounds = header.getBounds();
        // The display under the header's center, not its top-left corner: the
        // corner reaches a monitor on the left at once but never one on the right.
        const targetDisplay = screen.getDisplayNearestPoint({
            x: newX + headerBounds.width / 2,
            y: newY + headerBounds.height / 2,
        });
        const { x: workAreaX, y: workAreaY, width, height } = targetDisplay.workArea;
        const clampedX = Math.max(workAreaX, Math.min(newX, workAreaX + width - headerBounds.width));
        const clampedY = Math.max(workAreaY, Math.min(newY, workAreaY + height - headerBounds.height));
        return { x: clampedX, y: clampedY };
    }
    
    calculateWindowHeightAdjustment(senderWindow, targetHeight) {
        if (!senderWindow) return null;
        const currentBounds = senderWindow.getBounds();
        const minHeight = senderWindow.getMinimumSize()[1];
        const maxHeight = senderWindow.getMaximumSize()[1];
        let adjustedHeight = Math.max(minHeight, targetHeight);
        if (maxHeight > 0) {
            adjustedHeight = Math.min(maxHeight, adjustedHeight);
        }
        layoutDebug(`[Layout Debug] calculateWindowHeightAdjustment: targetHeight=${targetHeight}`);
        return { ...currentBounds, height: adjustedHeight };
    }
    
    // 기존 getTargetBoundsForFeatureWindows를 이 함수로 대체합니다.
    calculateFeatureWindowLayout(visibility, headerBoundsOverride = null) {
        const header = this.windowPool.get('header');
        const headerBounds = headerBoundsOverride || (header ? header.getBounds() : null);

        if (!headerBounds) return {};

        let display;
        if (headerBoundsOverride) {
            const boundsCenter = {
                x: headerBounds.x + headerBounds.width / 2,
                y: headerBounds.y + headerBounds.height / 2,
            };
            display = screen.getDisplayNearestPoint(boundsCenter);
        } else {
            display = getCurrentDisplay(header);
        }
    
        const { width: screenWidth, height: screenHeight, x: workAreaX, y: workAreaY } = display.workArea;
    
        const ask = this.windowPool.get('ask');
        const listen = this.windowPool.get('listen');
    
        const askVis = visibility.ask && ask && !ask.isDestroyed();
        const listenVis = visibility.listen && listen && !listen.isDestroyed();
    
        if (!askVis && !listenVis) return {};
    
        const PAD = 8;
        const headerTopRel = headerBounds.y - workAreaY;
        const headerBottomRel = headerTopRel + headerBounds.height;
        const headerCenterXRel = headerBounds.x - workAreaX + headerBounds.width / 2;
        
        const relativeX = headerCenterXRel / screenWidth;
        const relativeY = (headerBounds.y - workAreaY) / screenHeight;
        const strategy = this.determineLayoutStrategy(headerBounds, screenWidth, screenHeight, relativeX, relativeY, workAreaX, workAreaY);
    
        const askB = askVis ? ask.getBounds() : null;
        const listenB = listenVis ? listen.getBounds() : null;

        if (askVis) {
            layoutDebug(`[Layout Debug] Ask Window Bounds: height=${askB.height}, width=${askB.width}`);
        }
        if (listenVis) {
            layoutDebug(`[Layout Debug] Listen Window Bounds: height=${listenB.height}, width=${listenB.width}`);
        }
    
        const layout = {};
    
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
            
            if (strategy.primary === 'above') {
                const windowBottomAbs = headerBounds.y - PAD;
                layout.ask = { x: Math.round(askXRel + workAreaX), y: Math.round(windowBottomAbs - askB.height), width: askB.width, height: askB.height };
                layout.listen = { x: Math.round(listenXRel + workAreaX), y: Math.round(windowBottomAbs - listenB.height), width: listenB.width, height: listenB.height };
            } else { // 'below'
                const yAbs = headerBounds.y + headerBounds.height + PAD;
                layout.ask = { x: Math.round(askXRel + workAreaX), y: Math.round(yAbs), width: askB.width, height: askB.height };
                layout.listen = { x: Math.round(listenXRel + workAreaX), y: Math.round(yAbs), width: listenB.width, height: listenB.height };
            }
        } else { // Single window
            const winName = askVis ? 'ask' : 'listen';
            const winB = askVis ? askB : listenB;
            if (!winB) return {};
    
            let xRel = headerCenterXRel - winB.width / 2;
            xRel = Math.max(PAD, Math.min(screenWidth - winB.width - PAD, xRel));
    
            let yPos;
            if (strategy.primary === 'above') {
                yPos = (headerBounds.y - workAreaY) - PAD - winB.height;
            } else { // 'below'
                yPos = (headerBounds.y - workAreaY) + headerBounds.height + PAD;
            }
            
            layout[winName] = { x: Math.round(xRel + workAreaX), y: Math.round(yPos + workAreaY), width: winB.width, height: winB.height };
        }
        return layout;
    }
    
    /**
     * Where the open windows that hang from the header go when it is dragged:
     * the panels (Ask, Listen) and the popups (settings, mode picker).
     * @returns {Object<string, {x: number, y: number}>}
     */
    calculateHeaderFollowLayout() {
        const isOpen = (name) => {
            const win = this.windowPool.get(name);
            return !!win && !win.isDestroyed() && win.isVisible();
        };
        const layout = this.calculateFeatureWindowLayout({ ask: isOpen('ask'), listen: isOpen('listen') });
        if (isOpen('settings')) {
            const position = this.calculateSettingsWindowPosition();
            if (position) layout.settings = position;
        }
        if (isOpen('mode-picker')) {
            const position = this.calculateModePickerWindowPosition();
            if (position) layout['mode-picker'] = position;
        }
        return layout;
    }

    calculateShortcutSettingsWindowPosition() {
        const header = this.windowPool.get('header');
        const shortcutSettings = this.windowPool.get('shortcut-settings');
        if (!header || !shortcutSettings) return null;
    
        const headerBounds = header.getBounds();
        const shortcutBounds = shortcutSettings.getBounds();
        const { workArea } = getCurrentDisplay(header);
    
        let newX = Math.round(headerBounds.x + (headerBounds.width / 2) - (shortcutBounds.width / 2));
        let newY = Math.round(headerBounds.y);
    
        newX = Math.max(workArea.x, Math.min(newX, workArea.x + workArea.width - shortcutBounds.width));
        newY = Math.max(workArea.y, Math.min(newY, workArea.y + workArea.height - shortcutBounds.height));
    
        return { x: newX, y: newY, width: shortcutBounds.width, height: shortcutBounds.height };
    }

    /**
     * Where the next step starts from. A held key repeats every ~30 ms while
     * the previous step still animates (300 ms), so the header's own bounds
     * are mid-flight: never flush with an edge, and each step would restart
     * from there. While the header is on its way to the last step's target,
     * that target is the starting point.
     */
    _stepStart(header) {
        const current = header.getBounds();
        const p = this._pendingStep;
        if (!p || Date.now() > p.until) return current;
        const within = (v, a, b) => v >= Math.min(a, b) - 1 && v <= Math.max(a, b) + 1;
        if (!within(current.x, p.from.x, p.to.x) || !within(current.y, p.from.y, p.to.y)) return current;
        return { ...current, x: p.to.x, y: p.to.y };
    }

    calculateStepMovePosition(header, direction) {
        if (!header) return null;
        const currentBounds = this._stepStart(header);
        const from = header.getBounds();
        const target = this._calculateStepTarget(header, currentBounds, direction);
        this._pendingStep = {
            from: { x: from.x, y: from.y },
            to: target,
            until: Date.now() + STEP_ANIMATION_MS,
        };
        return target;
    }

    _calculateStepTarget(header, currentBounds, direction) {
        const stepSize = 80; // 이동 간격
        let targetX = currentBounds.x;
        let targetY = currentBounds.y;
    
        switch (direction) {
            case 'left': targetX -= stepSize; break;
            case 'right': targetX += stepSize; break;
            case 'up': targetY -= stepSize; break;
            case 'down': targetY += stepSize; break;
        }

        const clamped = this.calculateClampedPosition(header, { x: targetX, y: targetY });
        const horizontal = direction === 'left' || direction === 'right';
        const blocked = horizontal ? clamped.x === currentBounds.x : clamped.y === currentBounds.y;
        if (!blocked) return clamped;

        // Flush with the edge: cross to the next display, flush with its near edge.
        const neighbor = adjacentDisplay(
            screen.getDisplayNearestPoint({
                x: currentBounds.x + currentBounds.width / 2,
                y: currentBounds.y + currentBounds.height / 2,
            }),
            direction,
        );
        if (!neighbor) return clamped;
        const { x: wx, y: wy, width: ww, height: wh } = neighbor.workArea;
        const clampX = (x) => Math.max(wx, Math.min(x, wx + ww - currentBounds.width));
        const clampY = (y) => Math.max(wy, Math.min(y, wy + wh - currentBounds.height));
        switch (direction) {
            case 'left': return { x: wx + ww - currentBounds.width, y: clampY(currentBounds.y) };
            case 'right': return { x: wx, y: clampY(currentBounds.y) };
            case 'up': return { x: clampX(currentBounds.x), y: wy + wh - currentBounds.height };
            case 'down': return { x: clampX(currentBounds.x), y: wy };
        }
        return clamped;
    }
    
    calculateEdgePosition(header, direction) {
        if (!header) return null;
        const display = getCurrentDisplay(header);
        const { workArea } = display;
        const currentBounds = header.getBounds();
    
        let targetX = currentBounds.x;
        let targetY = currentBounds.y;
    
        switch (direction) {
            case 'left': targetX = workArea.x; break;
            case 'right': targetX = workArea.x + workArea.width - currentBounds.width; break;
            case 'up': targetY = workArea.y; break;
            case 'down': targetY = workArea.y + workArea.height - currentBounds.height; break;
        }
        return { x: targetX, y: targetY };
    }
    
    calculateNewPositionForDisplay(window, targetDisplayId) {
        if (!window) return null;
    
        const targetDisplay = screen.getAllDisplays().find(d => d.id === targetDisplayId);
        if (!targetDisplay) return null;
    
        const currentBounds = window.getBounds();
        const currentDisplay = getCurrentDisplay(window);
    
        if (currentDisplay.id === targetDisplay.id) return { x: currentBounds.x, y: currentBounds.y };
    
        const relativeX = (currentBounds.x - currentDisplay.workArea.x) / currentDisplay.workArea.width;
        const relativeY = (currentBounds.y - currentDisplay.workArea.y) / currentDisplay.workArea.height;
        
        const targetX = targetDisplay.workArea.x + targetDisplay.workArea.width * relativeX;
        const targetY = targetDisplay.workArea.y + targetDisplay.workArea.height * relativeY;
    
        const clampedX = Math.max(targetDisplay.workArea.x, Math.min(targetX, targetDisplay.workArea.x + targetDisplay.workArea.width - currentBounds.width));
        const clampedY = Math.max(targetDisplay.workArea.y, Math.min(targetY, targetDisplay.workArea.y + targetDisplay.workArea.height - currentBounds.height));
    
        return { x: Math.round(clampedX), y: Math.round(clampedY) };
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
const { screen } = require('electron');

class SmoothMovementManager {
    constructor(windowPool, getDisplayById, getCurrentDisplay, updateLayout) {
        this.windowPool = windowPool;
        this.getDisplayById = getDisplayById;
        this.getCurrentDisplay = getCurrentDisplay;
        this.updateLayout = updateLayout;
        this.stepSize = 80;
        this.animationDuration = 300;
        this.headerPosition = { x: 0, y: 0 };
        this.isAnimating = false;
        this.hiddenPosition = null;
        this.lastVisiblePosition = null;
        this.currentDisplayId = null;
        this.animationFrameId = null;
    }

    /**
     * @param {BrowserWindow} win
     * @returns {boolean}
     */
    _isWindowValid(win) {
        if (!win || win.isDestroyed()) {
            if (this.isAnimating) {
                console.warn('[MovementManager] Window destroyed mid-animation. Halting.');
                this.isAnimating = false;
                if (this.animationFrameId) {
                    clearTimeout(this.animationFrameId);
                    this.animationFrameId = null;
                }
            }
            return false;
        }
        return true;
    }

    moveToDisplay(displayId) {
        const header = this.windowPool.get('header');
        if (!this._isWindowValid(header) || !header.isVisible() || this.isAnimating) return;

        const targetDisplay = this.getDisplayById(displayId);
        if (!targetDisplay) return;

        const currentBounds = header.getBounds();
        const currentDisplay = this.getCurrentDisplay(header);

        if (currentDisplay.id === targetDisplay.id) return;

        const relativeX = (currentBounds.x - currentDisplay.workArea.x) / currentDisplay.workAreaSize.width;
        const relativeY = (currentBounds.y - currentDisplay.workArea.y) / currentDisplay.workAreaSize.height;
        const targetX = targetDisplay.workArea.x + targetDisplay.workAreaSize.width * relativeX;
        const targetY = targetDisplay.workArea.y + targetDisplay.workAreaSize.height * relativeY;

        const finalX = Math.max(targetDisplay.workArea.x, Math.min(targetDisplay.workArea.x + targetDisplay.workAreaSize.width - currentBounds.width, targetX));
        const finalY = Math.max(targetDisplay.workArea.y, Math.min(targetDisplay.workArea.y + targetDisplay.workAreaSize.height - currentBounds.height, targetY));

        this.headerPosition = { x: currentBounds.x, y: currentBounds.y };
        this.animateToPosition(header, finalX, finalY);
        this.currentDisplayId = targetDisplay.id;
    }

    hideToEdge(edge, callback, { instant = false } = {}) {
        const header = this.windowPool.get('header');
        if (!header || header.isDestroyed()) {
            if (typeof callback === 'function') callback();
            return;
        }
      
        const { x, y } = header.getBounds();
        this.lastVisiblePosition = { x, y };
        this.hiddenPosition     = { edge };
      
        if (instant) {
            header.hide();
            if (typeof callback === 'function') callback();
            return;
        }

        header.webContents.send('window-hide-animation');
      
        setTimeout(() => {
            if (!header.isDestroyed()) header.hide();
            if (typeof callback === 'function') callback();
        }, 5);
    }
      
    showFromEdge(callback) {
        const header = this.windowPool.get('header');
        if (!header || header.isDestroyed()) {
            if (typeof callback === 'function') callback();
            return;
        }
      
        // 숨기기 전에 기억해둔 위치 복구
        if (this.lastVisiblePosition) {
            header.setPosition(
                this.lastVisiblePosition.x,
                this.lastVisiblePosition.y,
                false   // animate: false
            );
        }
      
        header.show();
        header.webContents.send('window-show-animation');
      
        // 내부 상태 초기화
        this.hiddenPosition      = null;
        this.lastVisiblePosition = null;
      
        if (typeof callback === 'function') callback();
    }

    moveStep(direction) {
        const header = this.windowPool.get('header');
        if (!this._isWindowValid(header) || !header.isVisible() || this.isAnimating) return;

        const currentBounds = header.getBounds();
        this.headerPosition = { x: currentBounds.x, y: currentBounds.y };
        let targetX = this.headerPosition.x;
        let targetY = this.headerPosition.y;

        console.log(`[MovementManager] Moving ${direction} from (${targetX}, ${targetY})`);

        switch (direction) {
            case 'left': targetX -= this.stepSize; break;
            case 'right': targetX += this.stepSize; break;
            case 'up': targetY -= this.stepSize; break;
            case 'down': targetY += this.stepSize; break;
            default: return;
        }

        // Find the display that contains or is nearest to the target position
        const nearestDisplay = screen.getDisplayNearestPoint({ x: targetX, y: targetY });
        const { x: workAreaX, y: workAreaY, width: workAreaWidth, height: workAreaHeight } = nearestDisplay.workArea;
        
        // Only clamp if the target position would actually go out of bounds
        let clampedX = targetX;
        let clampedY = targetY;
        
        // Check horizontal bounds
        if (targetX < workAreaX) {
            clampedX = workAreaX;
        } else if (targetX + currentBounds.width > workAreaX + workAreaWidth) {
            clampedX = workAreaX + workAreaWidth - currentBounds.width;
        }
        
        // Check vertical bounds
        if (targetY < workAreaY) {
            clampedY = workAreaY;
            console.log(`[MovementManager] Clamped Y to top edge: ${clampedY}`);
        } else if (targetY + currentBounds.height > workAreaY + workAreaHeight) {
            clampedY = workAreaY + workAreaHeight - currentBounds.height;
            console.log(`[MovementManager] Clamped Y to bottom edge: ${clampedY}`);
        }

        console.log(`[MovementManager] Final position: (${clampedX}, ${clampedY}), Work area: ${workAreaX},${workAreaY} ${workAreaWidth}x${workAreaHeight}`);

        // Only move if there's an actual change in position
        if (clampedX === this.headerPosition.x && clampedY === this.headerPosition.y) {
            console.log(`[MovementManager] No position change, skipping animation`);
            return;
        }
        
        this.animateToPosition(header, clampedX, clampedY);
    }

    animateToPosition(header, targetX, targetY) {
        if (!this._isWindowValid(header)) return;
        
        this.isAnimating = true;
        const startX = this.headerPosition.x;
        const startY = this.headerPosition.y;
        const startTime = Date.now();

        if (!Number.isFinite(targetX) || !Number.isFinite(targetY) || !Number.isFinite(startX) || !Number.isFinite(startY)) {
            this.isAnimating = false;
            return;
        }

        const animate = () => {
            if (!this._isWindowValid(header)) return;

            const elapsed = Date.now() - startTime;
            const progress = Math.min(elapsed / this.animationDuration, 1);
            const eased = 1 - Math.pow(1 - progress, 3);
            const currentX = startX + (targetX - startX) * eased;
            const currentY = startY + (targetY - startY) * eased;

            if (!Number.isFinite(currentX) || !Number.isFinite(currentY)) {
                this.isAnimating = false;
                return;
            }

            if (!this._isWindowValid(header)) return;
            header.setPosition(Math.round(currentX), Math.round(currentY));

            if (progress < 1) {
                this.animationFrameId = setTimeout(animate, 8);
            } else {
                this.animationFrameId = null;
                this.isAnimating = false;
                if (Number.isFinite(targetX) && Number.isFinite(targetY)) {
                    if (!this._isWindowValid(header)) return;
                    header.setPosition(Math.round(targetX), Math.round(targetY));
                    // Update header position to the actual final position
                    this.headerPosition = { x: Math.round(targetX), y: Math.round(targetY) };
                }
                this.updateLayout();
            }
        };
        animate();
    }

    moveToEdge(direction) {
        const header = this.windowPool.get('header');
        if (!this._isWindowValid(header) || !header.isVisible() || this.isAnimating) return;

        const display = this.getCurrentDisplay(header);
        const { width, height } = display.workAreaSize;
        const { x: workAreaX, y: workAreaY } = display.workArea;
        const headerBounds = header.getBounds();
        const currentBounds = header.getBounds();
        let targetX = currentBounds.x;
        let targetY = currentBounds.y;

        switch (direction) {
            case 'left': targetX = workAreaX; break;
            case 'right': targetX = workAreaX + width - headerBounds.width; break;
            case 'up': targetY = workAreaY; break;
            case 'down': targetY = workAreaY + height - headerBounds.height; break;
        }

        this.headerPosition = { x: currentBounds.x, y: currentBounds.y };
        this.animateToPosition(header, targetX, targetY);
    }

    destroy() {
        if (this.animationFrameId) {
            clearTimeout(this.animationFrameId);
            this.animationFrameId = null;
        }
        this.isAnimating = false;
        console.log('[Movement] Manager destroyed');
    }
}

module.exports = SmoothMovementManager;
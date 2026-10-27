const { screen } = require('electron');

class SmoothMovementManager {
    constructor(windowPool) {
        this.windowPool = windowPool;
        this.stepSize = 80;
        this.animationDuration = 300;
        this.headerPosition = { x: 0, y: 0 };
        this.isAnimating = false;
        this.hiddenPosition = null;
        this.lastVisiblePosition = null;
        this.currentDisplayId = null;
        this.animationFrameId = null;

        this.animationTimers = new Map();
        this.animationCompletions = new Map();
        this.intendedSizes = new WeakMap();
    }

    /**
     * The size a window should have, in DIP. Its own bounds are not reliable
     * while it moves between monitors with different scale factors (125% and
     * 100%): Windows rescales it for a moment in the frame it crosses, and
     * rounds sizes on the scaled monitor. A move that starts from those bounds
     * keeps the wrong size, and the header shrank a little at every crossing.
     * Sizes change only through animateWindowBounds; every move keeps this one.
     * @param {BrowserWindow} win
     * @returns {{width: number, height: number}}
     */
    intendedSize(win) {
        let size = this.intendedSizes.get(win);
        if (!size) {
            const { width, height } = win.getBounds();
            size = { width, height };
            this.intendedSizes.set(win, size);
        }
        return { ...size };
    }

    /** The window's position with its intended size. */
    intendedBounds(win) {
        const { x, y } = win.getBounds();
        return { x, y, ...this.intendedSize(win) };
    }

    /**
     * Moves a window at once (mouse drag), keeping its intended size.
     * BrowserWindow.setPosition would resend the current, possibly rescaled, size.
     * A running animation of the window ends here, at the size it was headed to
     * (Ask grows while an answer streams in): left running, it would put the
     * window back where it started on its next frame.
     */
    setPosition(win, { x, y }) {
        if (!this._isWindowValid(win)) return;
        const onComplete = this._stopAnimation(win);
        win.setBounds({ x, y, ...this.intendedSize(win) });
        if (onComplete) onComplete();
    }

    /** True while `win` itself is animating, whatever other windows do. */
    isAnimatingWindow(win) {
        return this.animationTimers.has(win);
    }

    /**
     * Cancels the window's animation, if any.
     * @returns {function|undefined} its onComplete, for the caller to run once the window is placed
     */
    _stopAnimation(win) {
        if (!this.animationTimers.has(win)) return undefined;
        clearTimeout(this.animationTimers.get(win));
        const onComplete = this.animationCompletions.get(win);
        this._finishTimer(win);
        return onComplete;
    }

    _finishTimer(win) {
        this.animationTimers.delete(win);
        this.animationCompletions.delete(win);
        this.isAnimating = this.animationTimers.size > 0;
    }

    /**
     * @param {BrowserWindow} win
     * @returns {boolean}
     */
    _isWindowValid(win) {
        if (!win || win.isDestroyed()) {
            // 해당 창의 타이머가 있으면 정리
            if (this.animationTimers.has(win)) {
                clearTimeout(this.animationTimers.get(win));
                this._finishTimer(win);
            }
            return false;
        }
        return true;
    }

    /**
     * 
     * @param {BrowserWindow} win
     * @param {number} targetX
     * @param {number} targetY
     * @param {object} [options]
     * @param {object} [options.sizeOverride]
     * @param {function} [options.onComplete]
     * @param {number} [options.duration]
     */
    animateWindow(win, targetX, targetY, options = {}) {
        if (!this._isWindowValid(win)) {
            if (options.onComplete) options.onComplete();
            return;
        }

        const { sizeOverride, onComplete, duration: animDuration } = options;
        const start = win.getBounds();
        const startTime = Date.now();
        const duration = animDuration || this.animationDuration;
        const { width, height } = sizeOverride || start;

        const step = () => {
            if (!this._isWindowValid(win)) {
                if (onComplete) onComplete();
                return;
            }

            const p = Math.min((Date.now() - startTime) / duration, 1);
            const eased = 1 - Math.pow(1 - p, 3); // ease-out-cubic
            const x = start.x + (targetX - start.x) * eased;
            const y = start.y + (targetY - start.y) * eased;

            win.setBounds({ x: Math.round(x), y: Math.round(y), width, height });

            if (p < 1) {
                setTimeout(step, 8);
            } else {
                this.layoutManager.updateLayout();
                if (onComplete) {
                    onComplete();
                }
            }
        };
        step();
    }

    fade(win, { from, to, duration = 250, onComplete }) {
        if (!this._isWindowValid(win)) {
          if (onComplete) onComplete();
          return;
        }
        const startOpacity = from ?? win.getOpacity();
        const startTime = Date.now();
        
        const step = () => {
            if (!this._isWindowValid(win)) {
                if (onComplete) onComplete(); return;
            }
            const progress = Math.min(1, (Date.now() - startTime) / duration);
            const eased = 1 - Math.pow(1 - progress, 3);
            win.setOpacity(startOpacity + (to - startOpacity) * eased);
    
            if (progress < 1) {
                setTimeout(step, 8);
            } else {
                win.setOpacity(to);
                if (onComplete) onComplete();
            }
        };
        step();
    }
    
    animateWindowBounds(win, targetBounds, options = {}) {
        if (this.animationTimers.has(win)) {
            clearTimeout(this.animationTimers.get(win));
        }

        if (!this._isWindowValid(win)) {
            if (options.onComplete) options.onComplete();
            return;
        }

        this.isAnimating = true;

        const startBounds = this.intendedBounds(win);
        targetBounds = {
            ...targetBounds,
            width: targetBounds.width ?? startBounds.width,
            height: targetBounds.height ?? startBounds.height,
        };
        this.intendedSizes.set(win, { width: targetBounds.width, height: targetBounds.height });
        this.animationCompletions.set(win, options.onComplete);
        const startTime = Date.now();
        const duration = options.duration || this.animationDuration;
    
        const step = () => {
            if (!this._isWindowValid(win)) {
                if (options.onComplete) options.onComplete();
                return;
            }
            
            const progress = Math.min(1, (Date.now() - startTime) / duration);
            const eased = 1 - Math.pow(1 - progress, 3);
    
            const newBounds = {
                x: Math.round(startBounds.x + (targetBounds.x - startBounds.x) * eased),
                y: Math.round(startBounds.y + (targetBounds.y - startBounds.y) * eased),
                width: Math.round(startBounds.width + (targetBounds.width - startBounds.width) * eased),
                height: Math.round(startBounds.height + (targetBounds.height - startBounds.height) * eased),
            };
            win.setBounds(newBounds);
    
            if (progress < 1) {
                const timerId = setTimeout(step, 8);
                this.animationTimers.set(win, timerId);
            } else {
                win.setBounds(targetBounds);
                this._finishTimer(win);
                if (options.onComplete) options.onComplete();
            }
        };
        step();
    }
    
    animateWindowPosition(win, targetPosition, options = {}) {
        if (!this._isWindowValid(win)) {
            if (options.onComplete) options.onComplete();
            return;
        }
        // Position only: a width or height in targetPosition is ignored.
        const targetBounds = { x: targetPosition.x, y: targetPosition.y, ...this.intendedSize(win) };
        this.animateWindowBounds(win, targetBounds, options);
    }
    
    animateLayout(layout, animated = true) {
        if (!layout) return;
        for (const winName in layout) {
            const win = this.windowPool.get(winName);
            const targetBounds = layout[winName];
            if (win && !win.isDestroyed() && targetBounds) {
                // A layout places windows; their sizes come from their bounds,
                // so the intended sizes are kept.
                if (animated) {
                    this.animateWindowPosition(win, targetBounds);
                } else {
                    this.setPosition(win, targetBounds);
                }
            }
        }
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

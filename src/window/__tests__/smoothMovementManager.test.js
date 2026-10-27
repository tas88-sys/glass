/**
 * smoothMovementManager.test.js
 *
 * Windows keep their size while they move between monitors with different
 * scale factors (specs/2026-10-15-multi-monitor-step-move, D7). The fake
 * window reproduces what Electron did on the owner's monitors on 2026-10-15:
 * on the 125% monitor a DIP size comes back 1 px larger, and in the frame the
 * window crosses back to the 100% monitor Windows leaves it 13 px shorter.
 * The panels and popups follow a header dragged by hand, also while one of
 * them is animating (specs/2026-10-27-header-drag-follow).
 * Run: node --test src/window/__tests__/smoothMovementManager.test.js
 */

'use strict';

const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

function display(id, x, y, width, height, scaleFactor) {
  return {
    id,
    scaleFactor,
    bounds: { x, y, width, height },
    workArea: { x, y, width, height: height - 48 },
  };
}

// The owner's monitors, as Electron reported them.
const displays = [display(1, 0, 0, 1920, 1080, 1), display(2, -1536, 216, 1536, 864, 1.25)];

function nearest(p) {
  const inside = displays.find(
    (d) => p.x >= d.bounds.x && p.x < d.bounds.x + d.bounds.width && p.y >= d.bounds.y && p.y < d.bounds.y + d.bounds.height,
  );
  if (inside) return inside;
  const dist = (d) =>
    Math.hypot(
      Math.max(d.bounds.x - p.x, 0, p.x - (d.bounds.x + d.bounds.width - 1)),
      Math.max(d.bounds.y - p.y, 0, p.y - (d.bounds.y + d.bounds.height - 1)),
    );
  return displays.reduce((a, b) => (dist(b) < dist(a) ? b : a));
}

const screen = {
  getAllDisplays: () => displays,
  getPrimaryDisplay: () => displays[0],
  getDisplayNearestPoint: nearest,
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { screen };
  return originalLoad.call(this, request, parent, isMain);
};

const SmoothMovementManager = require('../smoothMovementManager');
const WindowLayoutManager = require('../windowLayoutManager');

const scaleAt = (b) => nearest({ x: b.x + b.width / 2, y: b.y + b.height / 2 }).scaleFactor;

function fakeWindow(bounds, { visible = true } = {}) {
  let current = { ...bounds };
  let destroyed = false;
  return {
    isVisible: () => visible,
    destroy: () => {
      destroyed = true;
    },
    getBounds: () => ({ ...current }),
    setBounds(b) {
      const before = scaleAt(current);
      let { width, height } = b;
      const after = scaleAt({ ...b, width, height });
      if (after !== 1) {
        width += 1;
        height += 1;
      }
      if (before !== 1 && after === 1) height -= 13;
      current = { x: b.x, y: b.y, width, height };
    },
    setPosition(x, y) {
      this.setBounds({ x, y, width: current.width, height: current.height });
    },
    isDestroyed: () => destroyed,
  };
}

const REPEAT_MS = 33;

let win;
let movement;
let layout;

function hold(direction, ms) {
  for (let t = 0; t < ms; t += REPEAT_MS) {
    movement.animateWindowPosition(win, layout.calculateStepMovePosition(win, direction));
    mock.timers.tick(REPEAT_MS);
  }
  mock.timers.tick(400);
}

beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  win = fakeWindow({ x: 1000, y: 400, width: 393, height: 47 });
  const pool = new Map([['header', win]]);
  movement = new SmoothMovementManager(pool);
  layout = new WindowLayoutManager(pool);
});

afterEach(() => mock.timers.reset());

describe('moves across monitors with different scale factors keep the size', () => {
  it('three round trips holding Ctrl+arrow end at 393×47 on the primary monitor', () => {
    for (let trip = 0; trip < 3; trip++) {
      hold('left', 3000);
      assert.equal(scaleAt(win.getBounds()), 1.25, `trip ${trip}: reached the left monitor`);
      hold('right', 3000);
      assert.equal(scaleAt(win.getBounds()), 1, `trip ${trip}: came back`);
    }
    const { width, height } = win.getBounds();
    assert.deepEqual({ width, height }, { width: 393, height: 47 });
  });

  it('three round trips dragging the header end at 393×47 on the primary monitor', () => {
    for (let trip = 0; trip < 3; trip++) {
      for (let x = 1000; x >= -1500; x -= 25) {
        movement.setPosition(win, layout.calculateClampedPosition(win, { x, y: 400 }));
      }
      for (let x = -1500; x <= 1000; x += 25) {
        movement.setPosition(win, layout.calculateClampedPosition(win, { x, y: 400 }));
      }
    }
    const { x, width, height } = win.getBounds();
    assert.deepEqual({ x, width, height }, { x: 1000, width: 393, height: 47 });
  });

  it('a resize sets the size later moves keep', () => {
    movement.animateWindowBounds(win, { x: 1000, y: 400, width: 456, height: 200 });
    mock.timers.tick(400);
    hold('left', 3000);
    hold('right', 3000);
    const { width, height } = win.getBounds();
    assert.deepEqual({ width, height }, { width: 456, height: 200 });
  });

  it('a layout moves windows without taking the sizes it carries', () => {
    movement.animateLayout({ header: { x: 900, y: 300, width: 380, height: 30 } });
    mock.timers.tick(400);
    assert.deepEqual(win.getBounds(), { x: 900, y: 300, width: 393, height: 47 });
    movement.animateLayout({ header: { x: 800, y: 300, width: 380, height: 30 } }, false);
    assert.deepEqual(win.getBounds(), { x: 800, y: 300, width: 393, height: 47 });
  });

  it('a position with a width and height moves the window only', () => {
    movement.animateWindowPosition(win, { x: 700, y: 400, width: 10, height: 10 });
    mock.timers.tick(400);
    assert.deepEqual(win.getBounds(), { x: 700, y: 400, width: 393, height: 47 });
  });
});

describe('a drag wins over a running animation', () => {
  it('stops the window where its animation was headed and runs its onComplete once', () => {
    const onComplete = mock.fn();
    movement.animateWindowBounds(win, { x: 1000, y: 400, width: 456, height: 200 }, { onComplete });
    mock.timers.tick(100);
    movement.setPosition(win, { x: 600, y: 300 });
    assert.deepEqual(win.getBounds(), { x: 600, y: 300, width: 456, height: 200 });
    assert.equal(onComplete.mock.callCount(), 1);
    assert.equal(movement.isAnimating, false);
    mock.timers.tick(400);
    assert.deepEqual(win.getBounds(), { x: 600, y: 300, width: 456, height: 200 }, 'the animation did not come back');
    assert.equal(onComplete.mock.callCount(), 1);
  });

  it('isAnimatingWindow is true only for the window that animates', () => {
    const other = fakeWindow({ x: 100, y: 100, width: 200, height: 100 });
    movement.animateWindowPosition(win, { x: 700, y: 400 });
    assert.equal(movement.isAnimatingWindow(win), true);
    assert.equal(movement.isAnimatingWindow(other), false);
    mock.timers.tick(400);
    assert.equal(movement.isAnimatingWindow(win), false);
  });

  it('a window destroyed mid-animation does not leave isAnimating stuck', () => {
    movement.animateWindowPosition(win, { x: 700, y: 400 });
    mock.timers.tick(50);
    win.destroy();
    mock.timers.tick(400);
    assert.equal(movement.isAnimating, false);
  });
});

describe('windows hanging from the header follow a drag', () => {
  let ask;
  let picker;
  let settings;
  let pool;

  // What the header's 'move' handler does after every setBounds of a drag.
  function drag(toX, toY) {
    const header = pool.get('header');
    const from = header.getBounds();
    for (let i = 1; i <= 10; i++) {
      const x = Math.round(from.x + ((toX - from.x) * i) / 10);
      const y = Math.round(from.y + ((toY - from.y) * i) / 10);
      movement.setPosition(header, layout.calculateClampedPosition(header, { x, y }));
      movement.animateLayout(layout.calculateHeaderFollowLayout(), false);
    }
  }

  function assertAskUnderHeader() {
    const h = pool.get('header').getBounds();
    const a = ask.getBounds();
    assert.equal(a.x, Math.round(h.x + h.width / 2 - a.width / 2), 'Ask centered under the header');
    assert.equal(a.y, h.y + h.height + 8, 'Ask right below the header');
  }

  beforeEach(() => {
    win = fakeWindow({ x: 700, y: 100, width: 393, height: 47 });
    ask = fakeWindow({ x: 600, y: 155, width: 600, height: 400 });
    picker = fakeWindow({ x: 1000, y: 152, width: 160, height: 120 });
    settings = fakeWindow({ x: 900, y: 152, width: 240, height: 300 }, { visible: false });
    pool = new Map([['header', win], ['ask', ask], ['mode-picker', picker], ['settings', settings]]);
    movement = new SmoothMovementManager(pool);
    layout = new WindowLayoutManager(pool);
  });

  it('Ask and the open mode picker stay under the header; a hidden popup is left alone', () => {
    drag(300, 200);
    assertAskUnderHeader();
    const p = picker.getBounds();
    const expected = layout.calculateModePickerWindowPosition();
    assert.deepEqual({ x: p.x, y: p.y }, { x: expected.x, y: expected.y });
    assert.deepEqual(settings.getBounds(), { x: 900, y: 152, width: 240, height: 300 });
  });

  it('Ask follows while its height is animating, and keeps the new height', () => {
    movement.animateWindowBounds(ask, { ...ask.getBounds(), height: 500 });
    mock.timers.tick(50);
    drag(1200, 150);
    assertAskUnderHeader();
    assert.equal(ask.getBounds().height, 500);
    mock.timers.tick(400);
    assertAskUnderHeader();
  });
});

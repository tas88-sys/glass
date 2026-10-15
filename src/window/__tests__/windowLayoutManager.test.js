/**
 * windowLayoutManager.test.js
 *
 * Header moves across monitors (specs/2026-10-15-multi-monitor-step-move):
 * Ctrl+arrow steps must reach a neighboring display and come back, in every
 * direction, and a mouse drag must keep following the cursor at the border.
 * electron's screen is mocked; the layouts are plain DIP rectangles, the
 * first one as Electron reported the owner's two monitors on 2026-10-15.
 * Run: node --test src/window/__tests__/windowLayoutManager.test.js
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

let displays = [];

function display(id, x, y, width, height, taskbar = 48) {
  return {
    id,
    bounds: { x, y, width, height },
    workArea: { x, y, width, height: height - taskbar },
  };
}

function contains(r, p) {
  return p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
}

function distance(r, p) {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.width - 1));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.height - 1));
  return Math.hypot(dx, dy);
}

const screen = {
  getAllDisplays: () => displays,
  getPrimaryDisplay: () => displays[0],
  getDisplayNearestPoint: (p) =>
    displays.find((d) => contains(d.bounds, p)) ||
    displays.reduce((a, b) => (distance(b.bounds, p) < distance(a.bounds, p) ? b : a)),
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { screen };
  return originalLoad.call(this, request, parent, isMain);
};

const WindowLayoutManager = require('../windowLayoutManager');

// The owner's monitors: the primary one, and a 1920×1080 one at 125% on its
// left, bottom-aligned (Electron's DIP layout).
const OWNER = () => [display(1, 0, 0, 1920, 1080), display(2, -1536, 216, 1536, 864)];
const RIGHT = () => [display(1, 0, 0, 1920, 1080), display(2, 1920, 0, 1536, 864)];
const ABOVE = () => [display(1, 0, 0, 1920, 1080), display(2, 0, -1080, 1920, 1080, 0)];
const ONE = () => [display(1, 0, 0, 1920, 1080)];

const W = 400;
const H = 47;

let bounds;
let header;
let layout;

function place(x, y) {
  bounds = { x, y, width: W, height: H };
}

function displayOf(b) {
  return screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 }).id;
}

// Presses one arrow up to `max` times, stopping when the header no longer
// moves. Returns every position it rested at.
function press(direction, max = 60) {
  const trail = [];
  for (let i = 0; i < max; i++) {
    const before = { ...bounds };
    const next = layout.calculateStepMovePosition(header, direction);
    bounds = { ...bounds, ...next };
    trail.push({ ...bounds });
    if (bounds.x === before.x && bounds.y === before.y) break;
  }
  return trail;
}

function assertInsideWorkArea(b) {
  const d = displays.find((x) => x.id === displayOf(b));
  const wa = d.workArea;
  assert.ok(
    b.x >= wa.x && b.y >= wa.y && b.x + b.width <= wa.x + wa.width && b.y + b.height <= wa.y + wa.height,
    `header ${JSON.stringify(b)} not inside display ${d.id} work area ${JSON.stringify(wa)}`,
  );
}

// Each step moves at most 80 px, unless it changes display.
function assertSteps(start, trail) {
  let prev = start;
  for (const b of trail) {
    assertInsideWorkArea(b);
    if (displayOf(b) === displayOf(prev)) {
      assert.ok(
        Math.abs(b.x - prev.x) <= 80 && Math.abs(b.y - prev.y) <= 80,
        `step from ${prev.x},${prev.y} to ${b.x},${b.y} is longer than 80 px`,
      );
    }
    prev = b;
  }
}

beforeEach(() => {
  header = { getBounds: () => ({ ...bounds }), isDestroyed: () => false };
  layout = new WindowLayoutManager(new Map([['header', header]]));
});

describe('calculateStepMovePosition across monitors', () => {
  it("owner's layout: left onto the left monitor, then right all the way back", () => {
    displays = OWNER();
    place(700, 20);

    let start = { ...bounds };
    let trail = press('left');
    assertSteps(start, trail);
    assert.equal(displayOf(bounds), 2, 'reached the left monitor');
    assert.equal(bounds.x, -1536, 'stopped at its far edge');

    start = { ...bounds };
    trail = press('right');
    assertSteps(start, trail);
    assert.equal(displayOf(bounds), 1, 'came back to the primary monitor');
    assert.equal(bounds.x, 1920 - W, 'stopped at its far edge');
  });

  it("owner's layout: one step from the left monitor's right edge crosses back", () => {
    displays = OWNER();
    place(-W, 500);
    const next = layout.calculateStepMovePosition(header, 'right');
    assert.deepEqual(next, { x: 0, y: 500 });
  });

  it("owner's layout: crossing keeps y, clamped to the new work area", () => {
    displays = OWNER();
    place(0, 20);
    const next = layout.calculateStepMovePosition(header, 'left');
    assert.deepEqual(next, { x: -W, y: 216 });
  });

  it('monitor on the right: right onto it, then left back', () => {
    displays = RIGHT();
    place(700, 20);

    let start = { ...bounds };
    let trail = press('right');
    assertSteps(start, trail);
    assert.equal(displayOf(bounds), 2);
    assert.equal(bounds.x, 1920 + 1536 - W);

    start = { ...bounds };
    trail = press('left');
    assertSteps(start, trail);
    assert.equal(displayOf(bounds), 1);
    assert.equal(bounds.x, 0);
  });

  it('monitor above: up onto it, then down back', () => {
    displays = ABOVE();
    place(700, 500);

    let start = { ...bounds };
    let trail = press('up');
    assertSteps(start, trail);
    assert.equal(displayOf(bounds), 2);
    assert.equal(bounds.y, -1080);

    start = { ...bounds };
    trail = press('down');
    assertSteps(start, trail);
    assert.equal(displayOf(bounds), 1);
    assert.equal(bounds.y, 1080 - 48 - H);
  });

  it('a small gap between the DIP bounds still counts as adjacent', () => {
    displays = [display(1, 0, 0, 1920, 1080), display(2, -1538, 216, 1536, 864)];
    place(0, 500);
    const next = layout.calculateStepMovePosition(header, 'left');
    assert.deepEqual(next, { x: -2 - W, y: 500 });
  });

  it('one monitor: the header stops at every edge', () => {
    displays = ONE();
    for (const [direction, x, y] of [
      ['left', 0, 500],
      ['right', 1920 - W, 500],
      ['up', 700, 0],
      ['down', 700, 1080 - 48 - H],
    ]) {
      place(x, y);
      assert.deepEqual(layout.calculateStepMovePosition(header, direction), { x, y }, direction);
    }
  });

  it('one monitor: a step near the edge stops at the edge', () => {
    displays = ONE();
    place(30, 500);
    assert.deepEqual(layout.calculateStepMovePosition(header, 'left'), { x: 0, y: 500 });
  });

  it('no display in that direction: the header stays', () => {
    displays = OWNER();
    place(1920 - W, 500);
    assert.deepEqual(layout.calculateStepMovePosition(header, 'right'), { x: 1920 - W, y: 500 });
  });
});

describe('calculateClampedPosition (mouse drag) across monitors', () => {
  it("owner's layout: the header lags the cursor by at most half its width at the border", () => {
    displays = OWNER();
    place(300, 500);
    for (const direction of [-1, 1]) {
      for (let i = 0; i <= 120; i++) {
        const requested = direction < 0 ? { x: 300 - i * 10, y: 500 } : { x: -900 + i * 10, y: 500 };
        const got = layout.calculateClampedPosition(header, requested);
        assert.ok(
          Math.abs(got.x - requested.x) <= W / 2,
          `asked x=${requested.x}, got x=${got.x}`,
        );
        bounds = { ...bounds, ...got };
        assertInsideWorkArea(bounds);
      }
    }
  });
});

describe('holding Ctrl+arrow (key repeat while the previous step still animates)', () => {
  const { mock } = require('node:test');
  const SmoothMovementManager = require('../smoothMovementManager');
  const REPEAT_MS = 33;

  // The real animation over a fake window, on a fake clock.
  function hold(direction, ms) {
    const win = {
      getBounds: () => ({ ...bounds }),
      setBounds: (b) => { bounds = { ...bounds, ...b }; },
      isDestroyed: () => false,
    };
    const movement = new SmoothMovementManager(new Map([['header', win]]));
    for (let t = 0; t < ms; t += REPEAT_MS) {
      const next = layout.calculateStepMovePosition(win, direction);
      movement.animateWindowPosition(win, next);
      mock.timers.tick(REPEAT_MS);
    }
    mock.timers.tick(400); // let the last animation finish
  }

  beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 }));
  afterEach(() => mock.timers.reset());

  it("owner's layout: holding left crosses to the left monitor", () => {
    displays = OWNER();
    place(700, 400);
    hold('left', 4000);
    assert.equal(displayOf(bounds), 2, `stopped at x=${bounds.x}`);
    assert.equal(bounds.x, -1536);
  });

  it("owner's layout: holding right brings it back to the primary monitor", () => {
    displays = OWNER();
    place(-1536, 400);
    hold('right', 4000);
    assert.equal(displayOf(bounds), 1, `stopped at x=${bounds.x}`);
    assert.equal(bounds.x, 1920 - W);
  });

  it('ten key repeats move exactly ten steps, not fewer', () => {
    displays = OWNER();
    place(1200, 400);
    hold('left', 10 * REPEAT_MS);
    assert.equal(bounds.x, 1200 - 10 * 80);
  });

  it('a drag right after a step does not leave the old target behind', () => {
    displays = OWNER();
    place(1200, 400);
    const win = { getBounds: () => ({ ...bounds }) };
    bounds = { ...bounds, ...layout.calculateStepMovePosition(win, 'left') }; // target 1120
    mock.timers.tick(100);
    place(300, 700); // the user drags the header somewhere else
    assert.deepEqual(layout.calculateStepMovePosition(win, 'left'), { x: 220, y: 700 });
  });
});

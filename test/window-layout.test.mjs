import test from "node:test";
import assert from "node:assert/strict";
import {
  badgeBoundsForDrag,
  clampWindowBounds,
  defaultBadgeBounds,
  panelBoundsNearBadge,
  panelVerticalAlignment,
} from "../desktop/window-layout.mjs";

const workArea = { x: 0, y: 0, width: 1920, height: 1080 };

test("default badge sits inside the lower-right work area", () => {
  assert.deepEqual(defaultBadgeBounds(workArea, 112, 26), {
    x: 1782,
    y: 942,
    width: 112,
    height: 112,
  });
});

test("saved badge bounds are clamped onto the visible display", () => {
  assert.deepEqual(
    clampWindowBounds({ x: 2000, y: -100, width: 112, height: 112 }, workArea),
    { x: 1808, y: 0, width: 112, height: 112 },
  );
});

test("task panel is positioned beside the badge and remains on screen", () => {
  assert.deepEqual(
    panelBoundsNearBadge(
      { x: 1782, y: 942, width: 112, height: 112 },
      { width: 480, height: 700 },
      workArea,
    ),
    { x: 1290, y: 354, width: 480, height: 700 },
  );
});

test("empty and single-card panels align near the pet head", () => {
  assert.equal(panelVerticalAlignment(0, 58, 112), "head");
  assert.equal(panelVerticalAlignment(1, 100, 112), "head");
  assert.equal(panelVerticalAlignment(2, 100, 112), "bottom");
  assert.equal(panelVerticalAlignment(1, 180, 112), "bottom");

  assert.deepEqual(
    panelBoundsNearBadge(
      { x: 1782, y: 942, width: 112, height: 112 },
      { width: 480, height: 58 },
      workArea,
      12,
      "head",
    ),
    { x: 1290, y: 920, width: 480, height: 58 },
  );
});

test("head-aligned task panel is clamped at the top screen edge", () => {
  assert.deepEqual(
    panelBoundsNearBadge(
      { x: 400, y: 0, width: 112, height: 112 },
      { width: 350, height: 100 },
      workArea,
      12,
      "head",
    ),
    { x: 38, y: 0, width: 350, height: 100 },
  );
});

test("badge dragging uses absolute cursor displacement without feedback", () => {
  assert.deepEqual(
    badgeBoundsForDrag(
      { x: 1700, y: 900, width: 112, height: 112 },
      { x: 1740, y: 920 },
      { x: 1540, y: 720 },
      workArea,
    ),
    { x: 1500, y: 700, width: 112, height: 112 },
  );
});

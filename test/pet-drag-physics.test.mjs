import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceInertia,
  appendVelocitySample,
  crossedDragThreshold,
  releaseVelocity,
} from "../desktop/pet/pet-drag-physics.mjs";

test("pet drag starts only after the four pixel threshold", () => {
  assert.equal(crossedDragThreshold({ x: 0, y: 0 }, { x: 3, y: 0 }), false);
  assert.equal(crossedDragThreshold({ x: 0, y: 0 }, { x: 3, y: 4 }), true);
});

test("pet release velocity uses recent qualified samples and clamps speed", () => {
  let samples = [];
  samples = appendVelocitySample(samples, { x: 0, y: 0, time: 0 });
  samples = appendVelocitySample(samples, { x: 2, y: 0, time: 4 });
  samples = appendVelocitySample(samples, { x: 80, y: 0, time: 50 });
  samples = appendVelocitySample(samples, { x: 200, y: 0, time: 100 });
  const velocity = releaseVelocity(samples);
  assert.equal(samples.length, 3);
  assert.equal(velocity.speed, 1600);
  assert.equal(velocity.x, 1600);
});

test("pet inertia decays and bounces inside the work area", () => {
  const next = advanceInertia(
    { x: 905, y: 400, velocityX: 1000, velocityY: 0, durationMs: 0 },
    16,
    { x: 0, y: 0, width: 1000, height: 800 },
    { width: 100, height: 100 },
  );
  assert.equal(next.x, 900);
  assert.ok(next.velocityX < 0);
  assert.equal(next.done, false);
});

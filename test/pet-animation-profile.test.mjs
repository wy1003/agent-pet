import test from "node:test";
import assert from "node:assert/strict";
import {
  frameAtElapsedTime,
  lookDirectionFrame,
  spriteFramePosition,
} from "../desktop/pet/pet-animation-profile.mjs";

test("pet sprite coordinates support v1 and v2 atlases", () => {
  assert.deepEqual(spriteFramePosition(7, 8, 1), {
    xPercent: 100,
    yPercent: 100,
    backgroundSize: "800% 900%",
  });
  assert.deepEqual(spriteFramePosition(7, 10, 2), {
    xPercent: 100,
    yPercent: 100,
    backgroundSize: "800% 1100%",
  });
});

test("pet animation timing advances frames and counts loops", () => {
  assert.deepEqual(frameAtElapsedTime("waving", 0), {
    column: 0,
    row: 3,
    completedLoops: 0,
    cycleDuration: 700,
  });
  assert.equal(frameAtElapsedTime("waving", 141).column, 1);
  assert.equal(frameAtElapsedTime("waving", 701).completedLoops, 1);
});

test("look directions map clockwise into the two v2 rows", () => {
  assert.deepEqual(lookDirectionFrame(0), { direction: 0, row: 9, column: 0 });
  assert.deepEqual(lookDirectionFrame(90), { direction: 4, row: 9, column: 4 });
  assert.deepEqual(lookDirectionFrame(180), { direction: 8, row: 10, column: 0 });
  assert.deepEqual(lookDirectionFrame(337.5), { direction: 15, row: 10, column: 7 });
});

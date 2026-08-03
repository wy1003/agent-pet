import test from "node:test";
import assert from "node:assert/strict";
import {
  createPetWindowState,
  petWindowSize,
  restorePetWindowBounds,
} from "../desktop/pet/pet-window-state.mjs";

const primary = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
};
const secondary = {
  id: 2,
  bounds: { x: -1280, y: 0, width: 1280, height: 1024 },
  workArea: { x: -1280, y: 0, width: 1280, height: 984 },
};

test("pet window size preserves the sprite aspect ratio with padding", () => {
  assert.deepEqual(petWindowSize(112, 4), { width: 120, height: 129, petWidth: 112, padding: 4 });
});

test("pet window state restores the saved display anchor", () => {
  const size = petWindowSize(112, 4);
  const state = createPetWindowState({}, { x: -300, y: 400, ...size }, secondary, {
    selectedPetId: "xiaobai",
    width: 112,
  });
  assert.deepEqual(restorePetWindowBounds(state, [primary, secondary], primary, size), {
    x: -300,
    y: 400,
    width: 120,
    height: 129,
  });
  assert.equal(state.pet.selectedPetId, "xiaobai");
});

test("legacy badge bounds migrate and clamp into a visible work area", () => {
  const size = petWindowSize(112, 4);
  assert.deepEqual(
    restorePetWindowBounds({ badgeBounds: { x: 1900, y: 1000, width: 112, height: 112 } }, [primary], primary, size),
    { x: 1800, y: 911, width: 120, height: 129 },
  );
});

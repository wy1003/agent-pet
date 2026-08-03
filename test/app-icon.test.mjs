import assert from "node:assert/strict";
import test from "node:test";
import { agentPetIconPngBuffer } from "../desktop/app-icon.mjs";

test("Agent Pet icon is a transparent-capable 32px PNG", () => {
  const icon = agentPetIconPngBuffer();

  assert.deepEqual([...icon.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(icon.readUInt32BE(16), 32);
  assert.equal(icon.readUInt32BE(20), 32);
  assert.equal(icon[25], 6, "PNG should use an alpha-capable RGBA color type");
});

test("each icon request returns an independent buffer", () => {
  assert.notEqual(agentPetIconPngBuffer(), agentPetIconPngBuffer());
});

import assert from "node:assert/strict";
import test from "node:test";
import { formatResetTime, formatSyncTime, formatUsageWindow } from "../public/usage-meter.mjs";

test("usage meter formats provider windows for compact cards", () => {
  assert.equal(formatUsageWindow(10_080), "每周使用限额");
  assert.equal(formatUsageWindow(300), "5 小时使用限额");
  assert.match(formatResetTime("2026-08-17T07:00:00.000Z"), /^重置于 /);
  assert.match(formatSyncTime("2026-08-17T07:00:00.000Z"), /^已同步 · /);
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const moduleUrl = new URL("../desktop/usage/claude-usage-provider.mjs", import.meta.url);
const { ClaudeUsageProvider } = await import(moduleUrl).catch((error) => {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  return {};
});
const now = Date.parse("2026-11-04T08:00:00Z");
const sample = (rate_limits) => ({ capturedAt: new Date(now).toISOString(), rate_limits });

test("Claude usage provider exists", () => assert.equal(typeof ClaudeUsageProvider, "function"));
test("missing Claude quota is unavailable, not zero usage", async () => {
  const provider = new ClaudeUsageProvider({ readUsage: async () => null, now: () => now });
  const value = await provider.getUsage();
  assert.equal(value.providerId, "claude");
  assert.equal(value.status, "unavailable");
  assert.deepEqual(value.windows, []);
});
test("Claude five-hour and seven-day windows preserve percentages and reset times", async () => {
  const provider = new ClaudeUsageProvider({ now: () => now, readUsage: async () => sample({
    five_hour: { used_percentage: 25, resets_at: now / 1000 + 60 },
    seven_day: { used_percentage: 0, resets_at: now / 1000 + 600 },
  }) });
  const value = await provider.getUsage();
  assert.equal(value.status, "ready");
  assert.deepEqual(value.windows.map((item) => [item.id, item.usedPercent, item.remainingPercent]), [["primary", 25, 75], ["secondary", 0, 100]]);
  assert.equal(value.windows[0].resetsAt, new Date(now + 60_000).toISOString());
});
test("absent, invalid and expired percentages are not coerced to zero", async () => {
  for (const used_percentage of [undefined, null, "", "50", -1, 101]) {
    const provider = new ClaudeUsageProvider({ now: () => now, readUsage: async () => sample({ five_hour: { used_percentage } }) });
    assert.equal((await provider.getUsage()).status, "unavailable");
  }
  const provider = new ClaudeUsageProvider({ now: () => now, readUsage: async () => sample({ five_hour: { used_percentage: 90, resets_at: now / 1000 - 1 } }) });
  assert.deepEqual((await provider.getUsage()).windows, []);
});
test("stale quota is explicitly stale, with no live quota windows", async () => {
  const provider = new ClaudeUsageProvider({ now: () => now + 600_000, maxAgeMs: 60_000, readUsage: async () => sample({ five_hour: { used_percentage: 25 } }) });
  const value = await provider.getUsage();
  assert.equal(value.status, "stale");
  assert.deepEqual(value.windows, []);
});
test("force refresh and expired-window checks do not show stale cached quota", async () => {
  let clock = now;
  let calls = 0;
  const provider = new ClaudeUsageProvider({ now: () => clock, readUsage: async () => { calls++; return sample({ five_hour: { used_percentage: 20, resets_at: now / 1000 + 1 } }); } });
  await provider.getUsage();
  await provider.getUsage();
  assert.equal(calls, 1);
  await provider.getUsage({ force: true });
  assert.equal(calls, 2);
  clock += 2000;
  assert.deepEqual((await provider.getUsage()).windows, []);
});
test("SDK rate limit observations use real utilization, never inferred usage", async () => {
  const provider = new ClaudeUsageProvider({ now: () => now, readUsage: async () => null });
  provider.recordRateLimit({ rate_limit_info: { rateLimitType: "five_hour", utilization: 0.7, resetsAt: now / 1000 + 100 } });
  const value = await provider.getUsage();
  assert.equal(value.windows[0].usedPercent, 70);
  assert.equal(value.source, "sdk");
});
for (const [error, status, code] of [
  [{ status: 401, code: "authentication", message: "FAKE_SECRET" }, "auth_required", "claude_usage_authentication"],
  [{ status: 403, message: "FAKE_SECRET" }, "auth_required", "claude_usage_forbidden"],
  [new SyntaxError("FAKE_SECRET"), "error", "claude_usage_invalid_json"],
  [new Error("FAKE_SECRET"), "error", "claude_usage_read_failed"],
]) {
  test(`usage classifies ${code} without exposing source errors`, async () => {
    const provider = new ClaudeUsageProvider({ readUsage: async () => { throw error; }, now: () => now });
    const value = await provider.getUsage();
    assert.equal(value.status, status);
    assert.equal(value.diagnostic?.code, code);
    assert.deepEqual(value.windows, []);
    assert.equal(JSON.stringify(value).includes("FAKE_SECRET"), false);
  });
}

test("local usage file reads report malformed JSON without exposing content", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "claude-usage-"));
  try {
    const usagePath = path.join(dir, "usage.json");
    const provider = new ClaudeUsageProvider({ usagePath, now: () => now });
    assert.equal((await provider.getUsage()).status, "unavailable");
    await writeFile(usagePath, "private invalid JSON");
    const value = await provider.getUsage({ force: true });
    assert.equal(value.status, "error");
    assert.equal(JSON.stringify(value).includes("private invalid JSON"), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

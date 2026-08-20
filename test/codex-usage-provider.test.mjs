import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CodexUsageProvider,
  normalizeCodexRateLimits,
  selectGeneralCodexRateLimit,
} from "../desktop/usage/codex-usage-provider.mjs";

test("Codex usage normalization exposes general quota fields but no session content", () => {
  const snapshot = normalizeCodexRateLimits({
    limitId: "codex",
    limitName: null,
    planType: "plus",
    primary: { usedPercent: 8, windowDurationMins: 10_080, resetsAt: 1_800_000_000 },
    secondary: { usedPercent: 28.4, windowDurationMins: 300, resetsAt: 1_799_000_000 },
    credits: { hasCredits: true, unlimited: false, balance: "12" },
  }, "2026-08-17T07:00:00.000Z");

  assert.equal(snapshot.providerId, "codex");
  assert.equal(snapshot.viewType, "codex-quota");
  assert.equal(snapshot.limitScope, "general");
  assert.equal(snapshot.limitId, "codex");
  assert.equal(snapshot.limitName, "");
  assert.equal(snapshot.planLabel, "Plus");
  assert.deepEqual(snapshot.windows.map((entry) => entry.remainingPercent), [92, 71.6]);
  assert.equal(JSON.stringify(snapshot).includes("用户请求"), false);
});

test("Codex provider selects the general account limit instead of the Spark limit", async () => {
  const generic = {
    limitId: "codex",
    limitName: null,
    planType: "pro",
    primary: { usedPercent: 34, windowDurationMins: 10_080, resetsAt: 1_800_000_000 },
  };
  const spark = {
    limitId: "codex_bengalfox",
    limitName: "GPT-5.3-Codex-Spark",
    planType: "pro",
    primary: { usedPercent: 0, windowDurationMins: 10_080, resetsAt: 1_800_000_000 },
  };
  assert.equal(selectGeneralCodexRateLimit({
    rateLimitsByLimitId: { codex_bengalfox: spark, codex: generic },
  }), generic);

  const provider = new CodexUsageProvider({
    codexHome: path.join(os.tmpdir(), "unused-agent-pet-codex-home"),
    now: () => Date.parse("2026-08-17T07:00:00.000Z"),
    readRateLimits: async () => ({
      rateLimits: generic,
      rateLimitsByLimitId: { codex_bengalfox: spark, codex: generic },
    }),
  });
  const snapshot = await provider.getUsage();
  assert.equal(snapshot.windows[0].usedPercent, 34);
  assert.equal(snapshot.windows[0].remainingPercent, 66);
  assert.equal(snapshot.planLabel, "Pro");
  assert.equal(JSON.stringify(snapshot).includes("Spark"), false);
});

test("Codex usage provider falls back to the newest generic local event and caches it", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-pet-usage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const day = path.join(root, "sessions", "2026", "08", "17");
  await mkdir(day, { recursive: true });
  const file = path.join(day, "rollout-2026-08-17T14-00-00-test.jsonl");
  const events = [
    { timestamp: "2026-08-17T06:00:00.000Z", payload: { rate_limits: {
      limit_id: "codex",
      primary: { used_percent: 40, window_minutes: 10_080, resets_at: 1_800_000_000 },
    } } },
    { timestamp: "2026-08-17T07:00:00.000Z", payload: { rate_limits: {
      limit_id: "codex",
      primary: { used_percent: 8, window_minutes: 10_080, resets_at: 1_800_100_000 },
    } } },
  ];
  await writeFile(file, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);

  const provider = new CodexUsageProvider({
    codexHome: root,
    cacheMs: 60_000,
    now: () => 100,
    readRateLimits: async () => { throw new Error("offline"); },
  });
  const first = await provider.getUsage();
  assert.equal(first.windows[0].usedPercent, 8);
  assert.equal(first.windows[0].remainingPercent, 92);

  await writeFile(file, `${JSON.stringify({
    timestamp: "2026-08-17T08:00:00.000Z",
    payload: { rate_limits: {
      limit_id: "codex",
      primary: { used_percent: 9, window_minutes: 10_080, resets_at: 1_800_100_000 },
    } },
  })}\n`, { flag: "a" });
  assert.equal((await provider.getUsage()).windows[0].usedPercent, 8);
  assert.equal((await provider.getUsage({ force: true })).windows[0].usedPercent, 9);
});

test("Codex usage provider never presents a Spark-only event as general quota", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-pet-usage-spark-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const day = path.join(root, "sessions", "2026", "08", "17");
  await mkdir(day, { recursive: true });
  await writeFile(path.join(day, "rollout-test.jsonl"), `${JSON.stringify({
    timestamp: "2026-08-17T08:00:00.000Z",
    payload: { rate_limits: {
      limit_id: "codex_bengalfox",
      limit_name: "GPT-5.3-Codex-Spark",
      primary: { used_percent: 0, window_minutes: 10_080 },
    } },
  })}\n`);
  const snapshot = await new CodexUsageProvider({
    codexHome: root,
    readRateLimits: async () => { throw new Error("offline"); },
  }).getUsage();
  assert.equal(snapshot.status, "error");
  assert.deepEqual(snapshot.windows, []);
});

test("Codex usage provider reports an empty state when the account has no limits", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-pet-usage-empty-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = await new CodexUsageProvider({
    codexHome: root,
    readRateLimits: async () => ({}),
  }).getUsage();
  assert.equal(snapshot.status, "empty");
  assert.deepEqual(snapshot.windows, []);
});

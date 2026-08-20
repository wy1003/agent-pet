import assert from "node:assert/strict";
import test from "node:test";
import { UsageProviderRegistry } from "../desktop/usage/usage-provider-registry.mjs";

test("usage providers are selected by id without coupling the host to a vendor", async () => {
  const registry = new UsageProviderRegistry({ activeProviderId: "codex" })
    .register({ id: "codex", getUsage: async () => ({ viewType: "codex-quota" }) })
    .register({ id: "deepseek", getUsage: async () => ({ viewType: "deepseek-balance" }) });

  assert.equal((await registry.getCurrentUsage()).viewType, "codex-quota");
  registry.setActiveProvider("deepseek");
  assert.equal((await registry.getCurrentUsage()).viewType, "deepseek-balance");
});

test("usage provider registry returns an explicit unavailable view", async () => {
  const registry = new UsageProviderRegistry({ activeProviderId: "future-provider" });
  const snapshot = await registry.getCurrentUsage();
  assert.equal(snapshot.status, "unavailable");
  assert.equal(snapshot.viewType, "unavailable");
});

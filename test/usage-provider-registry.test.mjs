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

test("all usage providers start concurrently regardless of the legacy active id", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const calls = [];
  const options = { force: true };
  const registry = new UsageProviderRegistry({ activeProviderId: "claude" })
    .register({ id: "codex", getUsage: async value => {
      calls.push(["codex", value]);
      await gate;
      return { providerId: "codex", status: "ok", viewType: "codex-quota" };
    } })
    .register({ id: "claude", getUsage: async value => {
      calls.push(["claude", value]);
      return { providerId: "claude", status: "ok", viewType: "claude-quota" };
    } });
  assert.equal(typeof registry.getAllUsage, "function");
  const pending = registry.getAllUsage(options);
  try { assert.deepEqual(calls, [["codex", options], ["claude", options]]); }
  finally { release(); }
  assert.deepEqual((await pending).providers.map(value => value.providerId), ["codex", "claude"]);
  assert.equal((await registry.getCurrentUsage()).providerId, "claude");
});

for (const failed of ["codex", "claude"]) {
  test(`all usage isolates ${failed} failure and does not expose local error details`, async () => {
    const registry = new UsageProviderRegistry();
    for (const id of ["codex", "claude"]) registry.register({ id, getUsage() {
      if (id === failed) throw new Error("private C:/Users/person/secret.json");
      return Promise.resolve({ providerId: id, status: "ok", viewType: `${id}-quota` });
    } });
    assert.equal(typeof registry.getAllUsage, "function");
    const result = await registry.getAllUsage();
    assert.deepEqual(result.providers.map(value => value.providerId), ["codex", "claude"]);
    assert.deepEqual(result.providers.map(value => value.status), ["codex", "claude"].map(id => id === failed ? "unavailable" : "ok"));
    assert.equal(result.providers.find(value => value.providerId === failed).viewType, "unavailable");
    assert.doesNotMatch(JSON.stringify(result), /private|secret|Users/);
  });
}

test("usage provider registry returns an explicit unavailable view", async () => {
  const registry = new UsageProviderRegistry({ activeProviderId: "future-provider" });
  const snapshot = await registry.getCurrentUsage();
  assert.equal(snapshot.status, "unavailable");
  assert.equal(snapshot.viewType, "unavailable");
});

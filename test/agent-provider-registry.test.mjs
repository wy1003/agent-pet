import assert from "node:assert/strict";
import test from "node:test";
import { AgentProviderRegistry } from "../desktop/agents/agent-provider-registry.mjs";

test("agent provider registry keeps its legacy selection API without selecting a collection source", () => {
  const registry = new AgentProviderRegistry({ activeProviderId: "codex" })
    .register({
      id: "codex",
      displayName: "Codex",
      iconUrl: "/assets/agents/codex.svg",
      usageProviderId: "codex",
      capabilities: { tasks: true, usage: true, remoteControl: true },
    })
    .register({
      id: "deepseek",
      displayName: "DeepSeek",
      usageProviderId: "deepseek",
      capabilities: { tasks: true, usage: true },
    });

  assert.equal(registry.current().id, "codex");
  assert.equal(registry.current().iconUrl, "/assets/agents/codex.svg");
  const before = registry.snapshot().providers;
  assert.deepEqual(before.map(item => [item.id, item.state]), [["codex", "disconnected"], ["deepseek", "disconnected"]]);
  assert.ok(before.every(item => !Object.hasOwn(item, "selected")));
  registry.setActiveProvider("deepseek");
  assert.equal(registry.current().usageProviderId, "deepseek");
  assert.deepEqual(registry.snapshot().providers, before, "legacy selection cannot change automatic collection state");
});

test("agent provider registry rejects unknown connections", () => {
  const registry = new AgentProviderRegistry().register({ id: "codex", displayName: "Codex" });
  assert.throws(() => registry.setActiveProvider("unknown"), /Unknown agent provider/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import vm from "node:vm";
import { resolveAiConnection, AI_CONNECTIONS } from "../desktop/ai/preferences.mjs";
import os from "node:os";
import path from "node:path";
import { normalizePreferences } from "../desktop/preferences.mjs";
import { isCompatibleCollectorHealth, DESKTOP_COLLECTOR_IDENTITY } from "../src/collector-service-identity.mjs";
import { RemoteTaskRegistry } from "../desktop/remote-task-registry.mjs";
import { RemoteControlController } from "../desktop/remote-control-controller.mjs";
import { RemoteExecutorRouter } from "../desktop/agents/remote-executor-router.mjs";

const fixtureCleanups = new WeakMap();
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-pet-desktop-"));
  const cleanups = [];
  fixtureCleanups.set(t, cleanups);
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    await rm(root, { recursive: true, force: true, maxRetries: 2 });
  });
  return root;
}
const beforeFixtureRemoval = (t, cleanup) => fixtureCleanups.get(t).push(cleanup);
async function waitFor(check) {
  const deadline = Date.now() + 1500;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
const runtime = () => import("../desktop/agents/desktop-runtime.mjs");

test("desktop factory forwards the same auxiliary-project exclusions to both collectors", async () => {
  const source = await readFile(new URL("../desktop/agents/desktop-runtime.mjs", import.meta.url), "utf8");
  const factory = source.slice(source.indexOf("export function createDesktopCollectors("), source.indexOf("export function createDesktopProviders(")).replace("export function", "function");
  class Collector { constructor(options) { this.options = options; } }
  const context = { path, CodexActivityCollector: Collector, ClaudeActivityCollector: Collector, MultiAgentCollector: class {} };
  vm.runInNewContext(factory, context);
  const ignoredProjectPaths = ["C:/private/auxiliary"];
  const transcriptsDir = "C:/fixture/projects";
  const { codex, claude } = context.createDesktopCollectors({ codexHome: "C:/fixture/codex", userData: "C:/fixture", claudeRoot: "C:/fixture/claude", ignoredProjectPaths, transcriptsDir });
  assert.equal(codex.options.ignoredProjectPaths, ignoredProjectPaths);
  assert.equal(claude.options.ignoredProjectPaths, ignoredProjectPaths);
  assert.equal(claude.options.transcriptsDir, transcriptsDir);
});

test("automatic source snapshots preserve both legacy AI alias resolutions and pinned models", async t => {
  const root = await fixture(t);
  const { createDesktopProviders } = await runtime();
  assert.equal(AI_CONNECTIONS.some(item => item.id === "agent"), false);
  for (const activeProviderId of ["codex", "claude"]) {
    const preferences = normalizePreferences({ agent: { activeProviderId }, ai: { connectionId: "agent", modelMode: "pinned", modelId: "original-model" }, remoteControl: { defaultProviderId: "claude" } });
    const before = JSON.stringify(preferences);
    const providers = createDesktopProviders({ codexHome: root, workingDirectory: root, usagePath: path.join(root, "missing.json"), getPreferences: () => preferences });
    providers.agents.setActiveProvider(activeProviderId);
    assert.deepEqual(providers.agents.snapshot().providers.map(p => p.state), ["disconnected", "disconnected"]);
    assert.match(providers.agents.snapshot().providers.find(p => p.id === "claude").description, /连接后发现.*采集任务状态/);
    assert.equal(resolveAiConnection(preferences), activeProviderId);
    assert.equal(JSON.stringify(preferences), before);
  }
});

test("desktop factory composes both collectors and independent text/usage sources without probing auth", async t => {
  const root = await fixture(t);
  const { createDesktopCollectors, createDesktopProviders } = await runtime();
  const { collector, claude } = createDesktopCollectors({ codexHome: path.join(root, "codex"), userData: root, transcriptsDir: path.join(root, "projects"), claudeRoot: path.join(root, "claude") });
  const providers = createDesktopProviders({ codexHome: path.join(root, "codex"), workingDirectory: root, usagePath: path.join(root, "usage.json"), getPreferences: () => normalizePreferences({}) });
  assert.deepEqual(providers.agents.snapshot().providers.map(p => p.id), ["codex", "claude"]);
  assert.notEqual(providers.agents.snapshot().providers.find(p => p.id === "claude").state, "connected");
  assert.equal(providers.text.has("claude"), true);
  providers.usage.setActiveProvider("claude");
  assert.equal((await providers.usage.getCurrentUsage()).status, "unavailable");
  await collector.start();
  beforeFixtureRemoval(t, () => collector.stop());
  await claude.ingest({ hook_event_name: "UserPromptSubmit", session_id: "factory", prompt: "任务", cwd: root, event_id: "factory" });
  assert.equal(collector.getTasks()[0].sessionId, "claude:factory");
  assert.equal(collector.getSessions()[0].sourceLabel, "Claude Code");
});

test("desktop executor publishes SDK lifecycle into the inbox after durable session registration", async t => {
  const root = await fixture(t);
  const { createDesktopCollectors, createDesktopExecutor } = await runtime();
  const claudeRoot = path.join(root, "claude");
  const { claude } = createDesktopCollectors({ codexHome: path.join(root, "codex"), userData: root, transcriptsDir: path.join(root, "projects"), claudeRoot });
  let persisted = false, nativeId;
  const executor = createDesktopExecutor({ codex: {}, getPreferences: () => normalizePreferences({ remoteControl: { defaultProviderId: "claude" } }),
    eventsDir: path.join(claudeRoot, "events"), isSessionActive: () => false, query: ({ options }) => {
      assert.equal(persisted, true);
      nativeId = options.sessionId;
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: nativeId };
        yield { type: "result", subtype: "success", session_id: nativeId, result: "完成", num_turns: 1 };
      })();
    }, resolveExecutable: async () => "" });
  const result = await executor.start({ cwd: root, prompt: "整理说明", onThreadStarted: async () => { persisted = true; } });
  assert.equal(result.sessionId, `claude:${nativeId}`);
  await claude.scanOnce();
  assert.equal(claude.getTasks()[0].status, "completed");
  assert.equal(claude.isSessionActive(nativeId), false);
});

test("desktop-owned SDK request is cancelled at controller shutdown without terminating external processes", async t => {
  const root = await fixture(t);
  const { createDesktopExecutor } = await runtime();
  const registry = new RemoteTaskRegistry(path.join(root, "registry.json"));
  await registry.load();
  await registry.registerRemoteSession({ sessionId: "old", cwd: root, status: { state: "completed" } });
  let interrupted = 0, initialized = false;
  const executor = createDesktopExecutor({ codex: {}, getPreferences: () => normalizePreferences({ remoteControl: { defaultProviderId: "claude" } }),
    eventsDir: path.join(root, "events"), resolveExecutable: async () => "", query: ({ options }) => ({
      interrupt: async () => { interrupted++; },
      [Symbol.asyncIterator]() { return this; },
      next: async () => {
        if (!initialized) { initialized = true; return { done: false, value: { type: "system", subtype: "init", session_id: options.sessionId } }; }
        return new Promise(() => {});
      }, return: async () => ({ done: true }),
    }) });
  const controller = new RemoteControlController({ registry, executor, getDefaultProvider: () => "claude", getPolicy: () => ({ enabled: true }), reply: async () => {}, logger: { warn() {} } });
  beforeFixtureRemoval(t, () => controller.stop());
  await controller.handleInbound(inbound("shutdown", "/P001 新任务：整理说明"));
  await waitFor(() => initialized && controller.status().active.length === 1);
  await controller.stop();
  assert.equal(interrupted, 1);
  assert.deepEqual(controller.status().active, []);
});

test("failed registration aborts the desktop SDK request and does not publish a visible task", async t => {
  const root = await fixture(t);
  const { createDesktopExecutor, createDesktopCollectors } = await runtime();
  const claudeRoot = path.join(root, "claude");
  const { claude } = createDesktopCollectors({ codexHome: root, userData: root, transcriptsDir: path.join(root, "projects"), claudeRoot });
  let advanced = false;
  const executor = createDesktopExecutor({ codex: {}, getPreferences: () => normalizePreferences({ remoteControl: { defaultProviderId: "claude" } }),
    eventsDir: path.join(claudeRoot, "events"), resolveExecutable: async () => "", query: () => (async function* () {
      yield { type: "system", subtype: "init", session_id: "persist-failure" };
      advanced = true;
    })() });
  await assert.rejects(() => executor.start({ cwd: root, prompt: "整理说明", onThreadStarted: async () => { throw new Error("disk full"); } }));
  await claude.scanOnce();
  assert.equal(advanced, false);
  assert.deepEqual(claude.getTasks(), []);
});

test("external collector ownership is unknown; only owned collectors may prove an inactive session", async () => {
  const { claudeSessionActivity } = await runtime();
  const claude = { isSessionActive: id => id === "claude:id" ? false : null };
  assert.equal(await claudeSessionActivity({ owned: false, claude }, "id"), null);
  assert.equal(await claudeSessionActivity({ owned: true, claude }, "id"), false);
});

test("task-source selection keeps the previously resolved text connection and pinned model", async () => {
  const { agentSelectionPatch } = await runtime();
  const before = normalizePreferences({ ai: { connectionId: "agent", modelMode: "pinned", modelId: "existing-model" } });
  const patch = agentSelectionPatch(before, "claude");
  assert.equal(patch.agent.activeProviderId, "claude");
  const after = normalizePreferences({ ...before, ...patch });
  assert.equal(after.ai.connectionId, "codex");
  assert.equal(after.ai.modelId, "existing-model");
});

const inbound = (id, text) => ({ channelId: "test", accountId: "test", messageId: id,
  dedupeKey: `test:${id}`, senderId: "user", conversationId: "user", conversationType: "private", text });

test("legacy preferences retain Codex defaults while Claude fields survive normalization independently of text AI", () => {
  const legacy = normalizePreferences({ version: 20 });
  assert.equal(legacy.remoteControl.defaultProviderId, "codex");
  assert.equal(legacy.agent.usageProviderId, "active");
  assert.deepEqual(legacy.claude, { executablePath: "", nodePath: "", enableStatusline: false, autoLifecycleHooks: true });
  assert.equal(normalizePreferences({ claude: { autoLifecycleHooks: false } }).claude.autoLifecycleHooks, false);
  const next = normalizePreferences({ ...legacy, agent: { activeProviderId: "claude", usageProviderId: "codex" },
    remoteControl: { defaultProviderId: "claude" }, claude: { executablePath: " C:/tools/claude.exe ", nodePath: "C:/node/node.exe", enableStatusline: true } });
  assert.equal(next.remoteControl.defaultProviderId, "claude");
  assert.equal(next.agent.usageProviderId, "codex");
  assert.equal(next.claude.executablePath, "C:/tools/claude.exe");
  assert.equal(next.claude.enableStatusline, true);
  assert.deepEqual(next.ai, legacy.ai);
  assert.equal(normalizePreferences({ remoteControl: { defaultProviderId: "other" } }).remoteControl.defaultProviderId, "codex");
});

test("desktop automatic discovery rejects an older Hook-only dual collector", async () => {
  const { DUAL_COLLECTOR_IDENTITY } = await runtime();
  assert.ok(DUAL_COLLECTOR_IDENTITY.capabilities.includes("tasks:claude:auto-discovery"));
  const hookOnly = { ok: true, ...DESKTOP_COLLECTOR_IDENTITY, capabilities: ["tasks:codex", "tasks:claude"] };
  assert.equal(isCompatibleCollectorHealth(hookOnly, DUAL_COLLECTOR_IDENTITY), false);
  assert.equal(isCompatibleCollectorHealth({ ok: true, ...DUAL_COLLECTOR_IDENTITY }, DUAL_COLLECTOR_IDENTITY), true);
});

test("capability-aware identity rejects a same-version single-source collector without breaking legacy callers", () => {
  const old = { ok: true, ...DESKTOP_COLLECTOR_IDENTITY };
  const expected = { ...DESKTOP_COLLECTOR_IDENTITY, capabilities: ["tasks:codex", "tasks:claude"] };
  assert.equal(isCompatibleCollectorHealth(old), true);
  assert.equal(isCompatibleCollectorHealth(old, expected), false);
  assert.equal(isCompatibleCollectorHealth({ ...old, capabilities: ["tasks:claude", "tasks:codex"] }, expected), true);
});

test("registry preserves separate source identities, legacy codes and native IDs across restart", async t => {
  const root = await fixture(t);
  const file = path.join(root, "registry.json");
  const registry = new RemoteTaskRegistry(file);
  await registry.load();
  const codex = await registry.registerRemoteSession({ sessionId: "same", cwd: root, title: "Codex" });
  const claude = await registry.registerRemoteSession({ sessionId: "claude:same", cwd: root, title: "Claude" });
  const restored = new RemoteTaskRegistry(file);
  await restored.load();
  assert.equal(restored.resolveSession(codex.code).providerId, "codex");
  assert.equal(restored.resolveSession(codex.code).nativeSessionId, "same");
  assert.equal(restored.resolveSession(claude.code).providerId, "claude");
  assert.equal(restored.resolveSession(claude.code).nativeSessionId, "same");
  assert.notEqual(codex.code, claude.code);
});

test("new jobs freeze provider at enqueue; later defaults do not change pending jobs or existing-session routing", async t => {
  const root = await fixture(t);
  const registry = new RemoteTaskRegistry(path.join(root, "registry.json"));
  await registry.load();
  await registry.registerRemoteSession({ sessionId: "legacy", cwd: root, title: "old", status: { state: "completed" } });
  let selected = "claude", release;
  const blocked = new Promise(resolve => { release = resolve; });
  const starts = [], resumes = [], replies = [];
  const executor = id => ({ start: async value => {
    starts.push(id);
    const sessionId = id === "claude" ? `claude:new-${starts.length}` : `new-${starts.length}`;
    await value.onThreadStarted(sessionId);
    if (starts.length === 1) await blocked;
    return { sessionId, finalResponse: "done" };
  }, resume: async value => { resumes.push([id, value.sessionId]); return { finalResponse: "resumed" }; } });
  const controller = new RemoteControlController({ registry,
    executor: new RemoteExecutorRouter({ codex: executor("codex"), claude: executor("claude"), getDefaultProvider: () => selected }),
    getDefaultProvider: () => selected, getPolicy: () => ({ enabled: true }), reply: async (_, msg) => replies.push(msg.text), pollMs: 10 });
  beforeFixtureRemoval(t, async () => { release(); await controller.stop(); });
  await controller.handleInbound(inbound("1", "/P001 新任务：整理说明"));
  await waitFor(() => starts.length === 1);
  assert.ok(replies.some(text => text.includes("等待提交到 Claude Code（SDK）")));
  await controller.handleInbound(inbound("2", "/P001 新任务：补充说明"));
  selected = "codex";
  release();
  await waitFor(() => replies.filter(text => text.includes("结果摘要：done")).length === 2);
  assert.deepEqual(starts, ["claude", "claude"]);
  selected = "claude";
  await controller.handleInbound(inbound("3", "/S0001 整理说明"));
  await waitFor(() => resumes.length === 1);
  assert.deepEqual(resumes, [["codex", "legacy"]]);
});

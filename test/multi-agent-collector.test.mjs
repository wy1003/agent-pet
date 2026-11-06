import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MultiAgentCollector } from "../src/multi-agent-collector.mjs";
import { ClaudeActivityCollector } from "../src/claude-collector.mjs";
import { CodexActivityCollector } from "../src/collector.mjs";

class Source extends EventEmitter {
  constructor(prefix, tasks = []) { super(); this.prefix = prefix; this.tasks = tasks; this.starts = 0; this.stops = 0; this.sessions = new Map([[prefix, { sessionId: prefix, status: { petStatus: "idle" } }]]); }
  async start() { this.starts++; if (this.failStart) throw new Error("source offline"); }
  async stop() { this.stops++; }
  async scanOnce() { this.scanned = true; }
  getTasks(options) { this.options = options; return this.tasks; }
  getTask(id) { return this.tasks.find((task) => task.taskId === id) || null; }
  getSessions() { return [...this.sessions.values()]; }
  getSession(id) { return this.sessions.get(id) || null; }
  markRead(id) { this.readId = id; return this.getSession(id); }
  async dismissTask(id) { this.dismissed = id; return { ok: true, task: this.getTask(id) }; }
  async dismissAllTasks() { return { ok: true, tasks: this.tasks }; }
}

test("MultiAgent globally sorts tasks and routes IDs without touching other sources", async () => {
  const old = { taskId: "codex:chat:p1", sessionId: "chat", status: "running", lastActivityAt: "2026-01-01" };
  const newer = { taskId: "claude:chat:p1", sessionId: "claude:chat", status: "running", lastActivityAt: "2026-01-02" };
  const waiting = { taskId: "claude:chat:p2", sessionId: "claude:chat", status: "needs_input" };
  const codex = new Source("chat", [old]), claude = new Source("claude:chat", [newer, waiting]);
  const c = new MultiAgentCollector([codex, claude]);
  await c.start();
  assert.deepEqual(c.getTasks({ scope: "all" }), [waiting, newer, old]);
  assert.equal(codex.options.scope, "all");
  assert.equal(c.sessions.size, 2);
  assert.equal(c.getSessions().length, 2);
  assert.equal(c.getTask(newer.taskId), newer);
  assert.equal(c.getTask("missing"), null);
  assert.equal(c.getSession("claude:chat").sessionId, "claude:chat");
  assert.equal(c.markRead("claude:chat").sessionId, "claude:chat");
  assert.equal(codex.readId, undefined);
  await c.dismissTask(newer.taskId);
  assert.equal(claude.dismissed, newer.taskId);
  assert.equal(codex.dismissed, undefined);
  assert.equal((await c.dismissTask("missing")).reason, "visible_task_not_found");
  assert.equal((await c.dismissAllTasks()).tasks.length, 3);
  await c.scanOnce();
  assert.equal(codex.scanned, true);
  await c.stop();
});

test("start isolates source errors, stop unbinds, restart never duplicates forwarding", async () => {
  const good = new Source("chat"), broken = new Source("claude:chat");
  broken.failStart = true;
  const c = new MultiAgentCollector([broken, good]);
  const diagnostics = [], notifications = [];
  c.on("diagnostic", (value) => diagnostics.push(value));
  c.on("task.updated", (value) => notifications.push(value));
  await Promise.all([c.start(), c.start()]);
  assert.equal(good.starts, 1);
  assert.equal(diagnostics.length, 1);
  good.emit("task.updated", { taskId: "codex:chat:p1" });
  assert.equal(notifications.length, 1);
  await c.stop();
  assert.equal(good.listenerCount("task.updated"), 0);
  assert.equal(broken.stops, 1);
  await c.start();
  good.emit("task.updated", { taskId: "codex:chat:p2" });
  good.emit("session.updated", { sessionId: "another", status: { petStatus: "idle" } });
  assert.equal(notifications.length, 2);
  assert.equal(c.sessions.size, 3);
  await c.stop();
  await c.stop();
  assert.equal(good.stops, 2);
});

test("stop drains collectors even before aggregate start and awaits all failing sources", async () => {
  const first = new Source("a"), second = new Source("b");
  let drained = false;
  first.stop = async () => { throw new Error("write failure"); };
  second.stop = async () => { await new Promise((resolve) => setTimeout(resolve, 10)); drained = true; };
  const c = new MultiAgentCollector([first, second]);
  const diagnostics = [];
  c.on("diagnostic", (value) => diagnostics.push(value));
  await assert.rejects(c.stop(), /stop failed/);
  assert.equal(drained, true);
  assert.equal(diagnostics.length, 1);
});

test("provider read failures are isolated at construction and during aggregation", async () => {
  const broken = new Source("claude:bad"), good = new Source("good", [{ taskId: "good:task", status: "running" }]);
  for (const method of ["getTasks", "getSessions", "getTask", "getSession"]) broken[method] = () => { throw new Error("FAKE_SECRET"); };
  const c = new MultiAgentCollector([broken, good]);
  const diagnostics = [];
  c.on("diagnostic", (value) => diagnostics.push(value));
  await c.start();
  try {
    assert.equal(c.getTasks().length, 1);
    assert.equal(c.getSessions().length, 1);
    assert.equal(c.getTask("good:task").taskId, "good:task");
    assert.equal(c.getSession("good").sessionId, "good");
    assert.equal(c.markRead("good").sessionId, "good");
    assert.equal((await c.dismissTask("good:task")).ok, true);
    assert.throws(() => c.getTask("claude:bad:task"), { code: "collector_unavailable" });
    assert.throws(() => c.getSession("claude:bad"), { code: "collector_unavailable" });
    assert.equal(c.isSessionActive("claude:bad"), true);
    assert.ok(diagnostics.length);
    assert.equal(JSON.stringify(diagnostics).includes("FAKE_SECRET"), false);
  } finally { await c.stop(); }
});

test("cached failed-provider rows become unknown instead of idle and recover after reads resume", async () => {
  const source = new Source("claude:bad", [{ taskId: "claude:bad:task", sessionId: "claude:bad", status: "completed" }]);
  source.isSessionActive = () => false;
  const c = new MultiAgentCollector([source]);
  c.getTasks();
  const getTasks = source.getTasks, getSessions = source.getSessions;
  source.getTasks = source.getSessions = () => { throw new Error("offline"); };
  assert.equal(c.getTasks()[0].status, "unknown");
  assert.equal(c.getTasks()[0].dataUnavailable, true);
  assert.equal(c.getSessions()[0].status.petStatus, "unknown");
  assert.equal(c.sessions.get("claude:bad").status.petStatus, "unknown");
  assert.equal(c.isSessionActive("claude:bad"), true);
  assert.throws(() => c.getSession("claude:bad"), { code: "collector_unavailable" });
  assert.throws(() => c.getTask("claude:bad:task"), { code: "collector_unavailable" });
  assert.throws(() => c.markRead("claude:bad"), { code: "collector_unavailable" });
  await assert.rejects(c.dismissTask("claude:bad:task"), { code: "collector_unavailable" });
  source.getTasks = getTasks;
  source.getSessions = getSessions;
  assert.equal(c.getTasks()[0].status, "completed");
  assert.equal(c.getSessions()[0].status.petStatus, "idle");
  assert.equal(c.isSessionActive("claude:bad"), false);
  assert.equal(c.isSessionActive("missing"), true);
});

test("real Codex and Claude empty fixtures remain isolated and Codex IDs stay unchanged", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-pet-multi-"));
  const codex = new CodexActivityCollector({ codexHome: root, statePath: path.join(root, "codex-state.json") });
  const claude = new ClaudeActivityCollector({ eventsDir: path.join(root, "events"), statePath: path.join(root, "claude-state.json"), transcriptsDir: path.join(root, "transcripts") });
  const c = new MultiAgentCollector([codex, claude]);
  t.after(async () => { await c.stop(); await rm(root, { recursive: true, force: true }); });
  await c.start();
  await claude.ingest({ session_id: "same", prompt_id: "one", hook_event_name: "UserPromptSubmit", prompt: "hello" });
  assert.equal(c.getTasks()[0].taskId, "claude:same:one");
  assert.equal(c.getSession("same"), null);
  assert.equal(c.sessions.size, 1);
  assert.deepEqual(codex.getTasks(), []);
});

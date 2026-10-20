import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setImmediate as flushEvents } from "node:timers/promises";
import { CodexActivityCollector } from "../src/collector.mjs";
import { NotificationOrchestrator } from "../desktop/notification-orchestrator.mjs";
import { createDefaultPreferences } from "../desktop/preferences.mjs";
import { PetStateController } from "../desktop/pet/pet-state-controller.mjs";

function line(type, payload) {
  return JSON.stringify({ type, payload, timestamp: new Date().toISOString() }) + "\n";
}

const question = "任务结束后通知我";
function userItem(turnId = "turn-1") {
  return line("event_msg", {
    type: "item_completed",
    thread_id: "typed-session",
    turn_id: turnId,
    item: {
      type: "UserMessage",
      id: `user-${turnId}`,
      content: [{ type: "text", text: question }],
    },
  });
}

async function fixture(t) {
  const base = path.resolve(os.tmpdir());
  const root = await mkdtemp(path.join(base, "agent-pet-typed-notification-"));
  const collector = new CodexActivityCollector({ codexHome: root, statePath: false });
  const windows = [];
  const mobile = [];
  const history = [];
  const events = [];
  const preferences = createDefaultPreferences();
  preferences.notifications.mobile.enabled = true;
  const notifier = new NotificationOrchestrator({
    getPreferences: () => preferences,
    phraseStore: { getPhrases: async () => ({}) },
    composer: { compose: (_pool, event, task) => `${task.question}: ${event}` },
    voiceQueue: {
      prepare: async () => {},
      enqueue: () => true,
      dropTask() {},
      cancelPending() {},
      stop: async () => {},
    },
    remoteQueue: {
      enqueue: (item) => { mobile.push(item); return true; },
      dropTask() {},
      stop: async () => {},
    },
    showWindowsNotification: (item) => { windows.push(item); return { ok: true }; },
    recordHistory: async (record) => { history.push(record); },
  });
  t.after(async () => {
    await collector.stop();
    await notifier.stop();
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), base);
    assert.ok(path.basename(resolved).startsWith("agent-pet-typed-notification-"));
    await rm(resolved, { recursive: true, force: true });
  });
  const dir = path.join(root, "sessions");
  await mkdir(dir);
  const file = path.join(dir, "rollout.jsonl");
  await writeFile(file, line("session_meta", {
    id: "typed-session",
    cwd: root,
    originator: "Codex Desktop",
    thread_source: "user",
  }));
  function subscribe() {
    notifier.seed(collector.getTasks());
    for (const kind of ["task.created", "task.updated", "task.removed"]) {
      collector.on(kind, (value) => {
        events.push({ kind, value });
        notifier.handleEvent(kind, value);
      });
    }
  }
  return { file, collector, subscribe, windows, mobile, history, events };
}

for (const singleScan of [false, true]) {
  test(`typed task completion notifies both channels once (${singleScan ? "single" : "separate"} scan)`, async (t) => {
    const { file, collector, subscribe, windows, mobile, history, events } = await fixture(t);
    await collector.scanOnce();
    subscribe();
    await appendFile(file, line("event_msg", { type: "task_started", turn_id: "turn-1" }) + userItem());
    if (!singleScan) {
      await collector.scanOnce();
      assert.equal(collector.getTasks()[0].question, question);
      assert.equal(collector.getTasks()[0].status, "running");
      assert.equal(windows.length, 0);
    }
    const completion = line("event_msg", {
      type: "task_complete",
      turn_id: "turn-1",
      last_agent_message: "已完成",
    });
    await appendFile(file, completion);
    await collector.scanOnce();
    await flushEvents();

    const [task] = collector.getTasks();
    assert.ok(task, "completed typed task must remain visible");
    assert.equal(task.status, "completed");
    assert.equal(task.question, question);
    assert.equal(task.latestResponse, "已完成");
    assert.equal(events.some(({ kind }) => kind === "task.removed"), false);
    assert.equal(windows.length, 1);
    assert.equal(mobile.length, 1);
    assert.equal(windows[0].task.question, question);
    assert.ok(mobile[0].text.includes(question));
    assert.equal(history.at(-1).source, "task");
    assert.equal(history.at(-1).event, "completed");

    await appendFile(file, userItem() + completion);
    await collector.scanOnce();
    await flushEvents();
    assert.equal(collector.getTasks().length, 1);
    assert.equal(windows.length, 1);
    assert.equal(mobile.length, 1);
  });
}

test("startup replay recognizes historical typed tasks without sending historical notifications", async (t) => {
  const { file, collector, subscribe, windows, mobile } = await fixture(t);
  await appendFile(file,
    line("event_msg", { type: "task_started", turn_id: "turn-1" })
    + userItem()
    + line("event_msg", { type: "task_complete", turn_id: "turn-1", last_agent_message: "已完成" }),
  );
  await collector.scanOnce();
  subscribe();
  await collector.scanOnce();
  await flushEvents();
  const [task] = collector.getTasks({ scope: "all" });
  assert.ok(task, "history must retain the typed user question");
  assert.equal(task.question, question);
  assert.equal(task.status, "completed");
  assert.deepEqual(collector.getTasks(), []);
  assert.equal(windows.length, 0);
  assert.equal(mobile.length, 0);
});

test("continuing a chat updates the pet count and only notifies for the new completion", async (t) => {
  const { file, collector, subscribe, windows, mobile } = await fixture(t);
  const pet = new PetStateController();
  await collector.scanOnce();
  subscribe();
  pet.handleEvent("snapshot", { tasks: collector.getTasks() });
  for (const kind of ["task.created", "task.updated", "task.removed"]) {
    collector.on(kind, (value) => pet.handleEvent(kind, value));
  }
  await appendFile(file, line("event_msg", { type: "task_started", turn_id: "turn-1" }) + userItem());
  await collector.scanOnce();
  await appendFile(file, line("event_msg", { type: "task_complete", turn_id: "turn-1" }));
  await collector.scanOnce();
  await flushEvents();
  assert.equal(pet.snapshot().count, 1);
  assert.equal(windows.length, 1);
  assert.equal(mobile.length, 1);

  await appendFile(file,
    line("event_msg", { type: "task_started", turn_id: "turn-2" }) + userItem("turn-2"),
  );
  await collector.scanOnce();
  await flushEvents();
  assert.deepEqual(collector.getTasks().map((task) => task.turnId), ["turn-2"]);
  assert.equal(pet.snapshot().count, 1);
  assert.equal(windows.length, 1);
  assert.equal(mobile.length, 1);

  await appendFile(file, line("event_msg", { type: "task_complete", turn_id: "turn-2" }));
  await collector.scanOnce();
  await flushEvents();
  assert.equal(pet.snapshot().count, 1);
  assert.equal(windows.length, 2);
  assert.equal(mobile.length, 2);
  assert.equal(collector.getTasks()[0].status, "completed");
});

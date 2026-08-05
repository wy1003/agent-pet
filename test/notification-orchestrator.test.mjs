import test from "node:test";
import assert from "node:assert/strict";
import {
  NotificationOrchestrator,
  isQuietTime,
} from "../desktop/notification-orchestrator.mjs";
import { NOTIFICATION_EVENTS } from "../desktop/phrase-renderer.mjs";

function preferences(overrides = {}) {
  return {
    rules: Object.fromEntries(NOTIFICATION_EVENTS.map((event) => [event, true])),
    notifications: {
      windows: { enabled: true },
      voice: {
        enabled: true,
        engine: "gpt-sovits",
        contentLevel: "standard",
        style: { addressee: "", assistantName: "", includeProjectName: true },
      },
      mobile: { enabled: false, provider: "weixin", contentLevel: "standard" },
    },
    quietHours: { enabled: false, start: "22:00", end: "08:00", allowUrgent: true },
    ...overrides,
  };
}

function fixture(getPreferences = () => preferences()) {
  const prepared = [];
  const enqueued = [];
  const windows = [];
  const records = [];
  const remote = [];
  const voiceQueue = {
    prepare: (item) => prepared.push(item),
    enqueue: (item) => {
      enqueued.push(item);
      return true;
    },
    clearPrepared() {},
    cancelPending() {},
    dropTask() {},
    async stop() {},
  };
  const phrases = Object.fromEntries(
    NOTIFICATION_EVENTS.map((event) => [event, [`{项目名}的任务：${event}`]]),
  );
  const orchestrator = new NotificationOrchestrator({
    getPreferences,
    phraseStore: { async getPhrases() { return phrases; } },
    voiceQueue,
    remoteQueue: {
      enqueue: (item) => {
        remote.push(item);
        return true;
      },
      dropTask() {},
      async stop() {},
    },
    showWindowsNotification: (item) => windows.push(item),
    recordHistory: async (record) => records.push(record),
  });
  return { orchestrator, prepared, enqueued, windows, records, remote };
}

test("initial snapshot establishes a baseline and active tasks are pre-generated", async () => {
  const { orchestrator, prepared, enqueued, windows } = fixture();
  const task = { taskId: "task-1", status: "running", projectName: "项目甲" };
  orchestrator.handleEvent("snapshot", { tasks: [task] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prepared.length, 5);
  assert.equal(enqueued.length, 0);
  assert.equal(windows.length, 0);
});

test("a real terminal transition notifies once and uses the prepared phrase plan", async () => {
  const { orchestrator, enqueued, windows } = fixture();
  const running = { taskId: "task-2", status: "running", projectName: "项目乙" };
  orchestrator.handleEvent("snapshot", { tasks: [running] });
  await orchestrator.handleTask({ ...running, status: "completed" });
  await orchestrator.handleTask({ ...running, status: "completed" });
  assert.equal(windows.length, 1);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].text, "项目乙的任务：completed");
});

test("a remote-control turn does not enqueue a second remote completion", async () => {
  const { orchestrator, remote, records } = fixture(() => preferences({
    notifications: {
      windows: { enabled: false },
      voice: {
        enabled: false,
        engine: "windows",
        contentLevel: "standard",
        style: { addressee: "", assistantName: "", includeProjectName: true },
      },
      mobile: { enabled: true, provider: "weixin", contentLevel: "standard" },
    },
  }));
  const running = {
    taskId: "remote-turn-1",
    status: "running",
    requestOrigin: "agent-pet-remote",
    question: "收到",
  };
  orchestrator.seed([running]);

  await orchestrator.handleTask({ ...running, status: "completed", latestResponse: "收到。" });

  assert.equal(remote.length, 0);
  assert.equal(records.at(-1).remote, "skipped");
  assert.equal(records.at(-1).result, "skipped");
  assert.equal(records.at(-1).reason, "remote_control_reply_owned_by_controller");
});

test("quiet hours suppress normal completion but allow urgent failures", async () => {
  const quietPreferences = () => preferences({
    quietHours: { enabled: true, start: "22:00", end: "08:00", allowUrgent: true },
  });
  const { orchestrator, windows } = fixture(quietPreferences);
  orchestrator.now = () => new Date(2026, 7, 3, 23, 30);
  orchestrator.seed([
    { taskId: "task-3", status: "running" },
    { taskId: "task-4", status: "running" },
  ]);
  await orchestrator.handleTask({ taskId: "task-3", status: "completed" });
  await orchestrator.handleTask({ taskId: "task-4", status: "failed" });
  assert.deepEqual(windows.map((item) => item.event), ["failed"]);
});

test("quiet-hour calculation supports ranges across midnight", () => {
  const settings = { enabled: true, start: "22:00", end: "08:00" };
  assert.equal(isQuietTime(settings, new Date(2026, 7, 3, 23, 0)), true);
  assert.equal(isQuietTime(settings, new Date(2026, 7, 3, 7, 59)), true);
  assert.equal(isQuietTime(settings, new Date(2026, 7, 3, 12, 0)), false);
});

test("test reminder uses current phrase settings and both enabled channels", async () => {
  const { orchestrator, enqueued, windows } = fixture();
  const result = await orchestrator.sendTestReminder("completed");
  assert.equal(result.ok, true);
  assert.deepEqual(result.channels, ["windows", "voice"]);
  assert.equal(result.text, "Agent Pet的任务：completed");
  assert.equal(windows.length, 1);
  assert.equal(enqueued.length, 1);
  assert.match(enqueued[0].taskId, /^notification-test:/);
  assert.equal(result.record.result, "pending");
});

test("test reminder reports when its event rule is disabled", async () => {
  const { orchestrator, enqueued, windows } = fixture(() => preferences({
    rules: Object.fromEntries(NOTIFICATION_EVENTS.map((event) => [event, event !== "completed"])),
  }));
  const result = await orchestrator.sendTestReminder("completed");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "rule_disabled");
  assert.equal(result.event, "completed");
  assert.deepEqual(result.channels, []);
  assert.equal(result.record.result, "skipped");
  assert.equal(windows.length, 0);
  assert.equal(enqueued.length, 0);
});

test("voice delivery updates the persisted notification result and failure reason", async () => {
  const { orchestrator, records } = fixture();
  const result = await orchestrator.sendTestReminder("completed");
  await orchestrator.handleVoiceDelivery({
    notificationId: result.record.id,
    status: "failed",
    error: "audio_playback_failed",
  });
  assert.equal(records.at(-1).voice, "failed");
  assert.equal(records.at(-1).result, "partial");
  assert.equal(records.at(-1).reason, "audio_playback_failed");
});

test("remote delivery is queued with its own content level and updates history", async () => {
  const { orchestrator, remote, records } = fixture(() => preferences({
    notifications: {
      windows: { enabled: false },
      voice: {
        enabled: false,
        engine: "windows",
        contentLevel: "standard",
        style: { addressee: "", assistantName: "", includeProjectName: true },
      },
      mobile: { enabled: true, provider: "weixin", contentLevel: "detailed" },
    },
  }));
  const result = await orchestrator.sendTestReminder("completed");
  assert.deepEqual(result.channels, ["remote"]);
  assert.equal(result.record.remote, "queued");
  assert.match(remote[0].text, /Agent Pet · 任务已完成/);
  await orchestrator.handleRemoteDelivery({
    notificationId: result.record.id,
    status: "sent",
    attempts: 2,
  });
  assert.equal(records.at(-1).remote, "sent");
  assert.equal(records.at(-1).remoteAttempts, 2);
  assert.equal(records.at(-1).result, "success");
});

test("remote delivery starts only after the queued history state is durable", async () => {
  let historyPersisted = false;
  let enqueuedAfterHistory = false;
  const orchestrator = new NotificationOrchestrator({
    getPreferences: () => preferences({
      notifications: {
        windows: { enabled: false },
        voice: {
          enabled: false,
          engine: "windows",
          contentLevel: "standard",
          style: { addressee: "", assistantName: "", includeProjectName: true },
        },
        mobile: { enabled: true, provider: "weixin", contentLevel: "standard" },
      },
    }),
    phraseStore: { async getPhrases() { return { completed: ["完成"] }; } },
    voiceQueue: { enqueue: () => false, dropTask() {}, async stop() {} },
    remoteQueue: {
      enqueue() {
        enqueuedAfterHistory = historyPersisted;
        return true;
      },
      dropTask() {},
      async stop() {},
    },
    recordHistory: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      historyPersisted = true;
    },
  });

  await orchestrator.sendTestReminder("completed");
  assert.equal(enqueuedAfterHistory, true);
});

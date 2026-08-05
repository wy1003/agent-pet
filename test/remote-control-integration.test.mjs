import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NotificationOrchestrator } from "../desktop/notification-orchestrator.mjs";
import { RemoteControlController } from "../desktop/remote-control-controller.mjs";
import { RemoteNotificationQueue } from "../desktop/remote-notification-queue.mjs";
import { RemoteTaskRegistry } from "../desktop/remote-task-registry.mjs";

function preferences() {
  return {
    rules: {
      needs_input: true,
      completed: true,
      failed: true,
      interrupted: true,
      unknown: true,
    },
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
    quietHours: { enabled: false, start: "22:00", end: "08:00", allowUrgent: true },
  };
}

function quotedInbound(id, text, referencedText, referencedMessageId) {
  return {
    channelId: "weixin",
    accountId: "primary",
    messageId: id,
    dedupeKey: `weixin:primary:${id}`,
    senderId: "bound-user",
    conversationId: "bound-user",
    conversationType: "private",
    text,
    reference: {
      messageId: referencedMessageId,
      text: referencedText,
    },
  };
}

async function waitFor(predicate, timeout = 1_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out");
}

test("an explicit session command resumes the exact registered Codex session once", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-pet-remote-e2e-"));
  const registry = new RemoteTaskRegistry(path.join(directory, "registry.json"));
  await registry.load();

  const sessionId = "019fcafe-real-session-id";
  const taskId = `${sessionId}:turn-1`;
  const projectKey = directory.replace(/\\/g, "/").toLowerCase();
  const runningTask = {
    taskId,
    sessionId,
    projectKey,
    projectName: "Agent Pet",
    cwd: directory,
    title: "修复远程通知闭环",
    status: "running",
    lastActivityAt: "2026-08-04T09:00:00.000Z",
  };
  const completedTask = {
    ...runningTask,
    status: "completed",
    lastActivityAt: "2026-08-04T09:01:00.000Z",
  };

  // The collector snapshot establishes the durable P/S mapping before the
  // terminal transition is rendered and queued for Weixin.
  await registry.observeSnapshot({ tasks: [runningTask] });

  const outbound = [];
  let orchestrator;
  const remoteQueue = new RemoteNotificationQueue({
    idFactory: () => "provider-client-1",
    retryDelays: [0],
    sendMessage: async (item, options) => {
      outbound.push({ item: structuredClone(item), options: { ...options, signal: undefined } });
      return {
        ok: true,
        messageId: "wx-outbound-1",
        clientId: options.clientId,
        channelId: "weixin",
        accountId: "primary",
        conversationId: "bound-user",
      };
    },
    onDelivery: async (delivery) => {
      if (delivery.status === "sent") await registry.recordDelivery(delivery);
      await orchestrator.handleRemoteDelivery(delivery);
    },
    logger: { warn() {} },
  });
  const voiceQueue = {
    enqueue() { return false; },
    prepare() {},
    cancelPending() {},
    dropTask() {},
    async stop() {},
  };
  orchestrator = new NotificationOrchestrator({
    getPreferences: preferences,
    phraseStore: { async getPhrases() { return { completed: ["任务完成"] }; } },
    voiceQueue,
    remoteQueue,
    resolveRemoteRoute: (task) => registry.observeTask(task),
    recordHistory: async () => {},
    logger: { warn() {} },
  });
  orchestrator.seed([runningTask]);
  await orchestrator.handleTask(completedTask);
  await remoteQueue.whenIdle();

  assert.equal(outbound.length, 1);
  const sent = outbound[0].item;
  assert.match(sent.text, /结果摘要：/);
  assert.match(sent.text, /继续处理此任务：\n\/S0001 你的要求/);
  assert.equal((sent.text.match(/\/S0001/g) || []).length, 1);
  assert.equal(sent.sessionId, sessionId);
  assert.equal(sent.projectKey, projectKey);
  assert.equal(outbound[0].options.clientId, "provider-client-1");
  const delivery = registry.findDelivery({ remoteMessageId: "wx-outbound-1" });
  assert.deepEqual({ ...delivery, sentAt: undefined }, {
    notificationId: sent.notificationId,
    channelId: "weixin",
    accountId: "primary",
    conversationId: "bound-user",
    remoteMessageId: "wx-outbound-1",
    taskId,
    projectCode: "P001",
    sessionCode: "S0001",
    sentAt: undefined,
  });
  assert.equal(typeof delivery.sentAt, "string");

  const resumes = [];
  const replies = [];
  const controller = new RemoteControlController({
    registry,
    executor: {
      start: async () => { throw new Error("unexpected new task"); },
      resume: async (value) => {
        resumes.push(value);
        return { sessionId: value.sessionId, finalResponse: "远程续问已完成" };
      },
    },
    sendReply: async (text) => replies.push(text),
    getPolicy: () => ({ enabled: true }),
    isAuthorizedSender: (value) => value === "bound-user",
    pollMs: 10,
    logger: { warn() {} },
  });
  t.after(async () => {
    await controller.stop();
    await orchestrator.stop();
    await rm(directory, { recursive: true, force: true });
  });

  const inbound = quotedInbound(
    "wx-inbound-1",
    "/S0001 继续：补充重复消息保护测试",
    "Agent Pet · 任务已完成（引用摘要已截断）",
    "wx-outbound-1",
  );
  const accepted = await controller.handleInbound(inbound);
  const duplicate = await controller.handleInbound(inbound);
  assert.equal(accepted.queued, true);
  assert.equal(duplicate.reason, "duplicate_message");

  await waitFor(() => replies.some((text) => text.includes("远程续问已完成")));
  assert.equal(resumes.length, 1);
  assert.equal(resumes[0].sessionId, sessionId);
  assert.equal(resumes[0].cwd, directory);
  assert.equal(resumes[0].prompt, "补充重复消息保护测试");
});

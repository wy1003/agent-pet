import test from "node:test";
import assert from "node:assert/strict";
import { RemoteNotificationQueue } from "../desktop/remote-notification-queue.mjs";

test("remote queue serializes by priority and deduplicates pending notifications", async () => {
  const sent = [];
  const deliveries = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const queue = new RemoteNotificationQueue({
    retryDelays: [0],
    sendMessage: async (item) => {
      if (item.notificationId === "first") await gate;
      sent.push(item.notificationId);
      return { ok: true };
    },
    onDelivery: (value) => deliveries.push(value),
  });
  assert.equal(queue.enqueue({ notificationId: "first", text: "1", priority: 1 }), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queue.enqueue({ notificationId: "low", text: "2", priority: 1 }), true);
  assert.equal(queue.enqueue({ notificationId: "high", text: "3", priority: 10 }), true);
  assert.equal(queue.enqueue({ notificationId: "high", text: "duplicate" }), false);
  release();
  await queue.whenIdle();
  assert.deepEqual(sent, ["first", "high", "low"]);
  assert.deepEqual(deliveries.map((item) => item.status), ["sent", "sent", "sent"]);
});

test("remote queue retries transient errors and reports the final attempt", async () => {
  let attempts = 0;
  const clientIds = [];
  const deliveries = [];
  const queue = new RemoteNotificationQueue({
    idFactory: () => "provider-retry-1",
    retryDelays: [0, 0, 0],
    sendMessage: async (item, options) => {
      attempts += 1;
      clientIds.push([item.providerClientId, options.clientId]);
      if (attempts < 3) throw new Error("temporary_network_error");
      return { ok: true, clientId: options.clientId };
    },
    onDelivery: (value) => deliveries.push(value),
  });
  queue.enqueue({ notificationId: "retry", text: "message" });
  await queue.whenIdle();
  assert.equal(attempts, 3);
  assert.deepEqual(clientIds, [
    ["provider-retry-1", "provider-retry-1"],
    ["provider-retry-1", "provider-retry-1"],
    ["provider-retry-1", "provider-retry-1"],
  ]);
  assert.equal(deliveries[0].status, "sent");
  assert.equal(deliveries[0].attempts, 3);
  assert.equal(deliveries[0].remoteMessageId, "provider-retry-1");
});

test("remote queue does not retry an unbound WeChat session", async () => {
  let attempts = 0;
  const deliveries = [];
  const queue = new RemoteNotificationQueue({
    retryDelays: [0, 0, 0],
    sendMessage: async () => {
      attempts += 1;
      const error = new Error("remote_not_bound");
      error.code = "remote_not_bound";
      throw error;
    },
    onDelivery: (value) => deliveries.push(value),
  });
  queue.enqueue({ notificationId: "unbound", text: "message" });
  await queue.whenIdle();
  assert.equal(attempts, 1);
  assert.equal(deliveries[0].status, "failed");
  assert.equal(deliveries[0].error, "remote_not_bound");
});

test("remote queue does not retry an invalid WeChat reply context", async () => {
  let attempts = 0;
  const deliveries = [];
  const queue = new RemoteNotificationQueue({
    retryDelays: [0, 0, 0],
    sendMessage: async () => {
      attempts += 1;
      const error = new Error("请在微信中发送任意消息恢复通知");
      error.code = "reply_context_invalid";
      throw error;
    },
    onDelivery: (value) => deliveries.push(value),
  });
  queue.enqueue({ notificationId: "invalid-context", text: "message" });
  await queue.whenIdle();
  assert.equal(attempts, 1);
  assert.equal(deliveries[0].status, "failed");
  assert.match(deliveries[0].error, /reply_context_invalid/);
});

test("remote queue keeps both Tencent error code and diagnostic message", async () => {
  const deliveries = [];
  const queue = new RemoteNotificationQueue({
    retryDelays: [0],
    maxAttempts: 1,
    sendMessage: async () => {
      const error = new Error("bad context");
      error.code = -2;
      throw error;
    },
    onDelivery: (value) => deliveries.push(value),
  });
  queue.enqueue({ notificationId: "diagnostic", text: "message" });
  await queue.whenIdle();
  assert.equal(deliveries[0].status, "failed");
  assert.equal(deliveries[0].error, "-2: bad context");
});

test("remote queue preserves the Weixin message-to-task route after delivery", async () => {
  const deliveries = [];
  const queue = new RemoteNotificationQueue({
    retryDelays: [0],
    sendMessage: async () => ({
      ok: true,
      messageId: "wx-message-1",
      channelId: "weixin",
      accountId: "primary",
      conversationId: "bound-user",
    }),
    onDelivery: (value) => deliveries.push(value),
  });
  queue.enqueue({
    notificationId: "notification-route",
    taskId: "task-route",
    text: "编号：P001/S0002",
    channelId: "weixin",
    accountId: "primary",
    conversationId: "bound-user",
    projectCode: "P001",
    sessionCode: "S0002",
    sessionId: "session-2",
    projectKey: "d:/project/agent-pet",
  });
  await queue.whenIdle();
  assert.deepEqual(deliveries[0], {
    notificationId: "notification-route",
    taskId: "task-route",
    status: "sent",
    attempts: 1,
    remoteMessageId: "wx-message-1",
    channelId: "weixin",
    accountId: "primary",
    conversationId: "bound-user",
    text: "编号：P001/S0002",
    projectCode: "P001",
    sessionCode: "S0002",
    sessionId: "session-2",
    projectKey: "d:/project/agent-pet",
  });
});

test("remote queue isolates channels and allows the same notification id per channel", async () => {
  const sent = [];
  let releaseWeixin;
  const weixinGate = new Promise((resolve) => { releaseWeixin = resolve; });
  const queue = new RemoteNotificationQueue({
    retryDelays: [0],
    sendMessage: async (item) => {
      if (item.channelId === "weixin") await weixinGate;
      sent.push(item.channelId);
      return { ok: true, messageId: `${item.channelId}-message` };
    },
  });

  assert.equal(queue.enqueue({
    notificationId: "shared-notification",
    text: "微信通知",
    channelId: "weixin",
    accountId: "primary",
    conversationId: "wx-user",
  }), true);
  assert.equal(queue.enqueue({
    notificationId: "shared-notification",
    text: "飞书通知",
    channelId: "feishu",
    accountId: "primary",
    conversationId: "fs-user",
  }), true);

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, ["feishu"]);
  releaseWeixin();
  await queue.whenIdle();
  assert.deepEqual(sent, ["feishu", "weixin"]);
});

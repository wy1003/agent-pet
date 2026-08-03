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
  const deliveries = [];
  const queue = new RemoteNotificationQueue({
    retryDelays: [0, 0, 0],
    sendMessage: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("temporary_network_error");
      return { ok: true };
    },
    onDelivery: (value) => deliveries.push(value),
  });
  queue.enqueue({ notificationId: "retry", text: "message" });
  await queue.whenIdle();
  assert.equal(attempts, 3);
  assert.equal(deliveries[0].status, "sent");
  assert.equal(deliveries[0].attempts, 3);
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

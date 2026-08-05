import { randomUUID } from "node:crypto";

const NON_RETRYABLE_CODES = new Set([
  "remote_not_connected",
  "remote_not_bound",
  "remote_disabled",
  "reply_context_invalid",
  "session_expired",
]);

function wait(ms, signal) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason || new Error("remote_delivery_cancelled"));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

function deliveryError(error) {
  const code = String(error?.code || "").trim();
  const message = String(error?.message || "").trim();
  if (code && message && message !== code) return `${code}: ${message}`.slice(0, 300);
  return String(code || message || "remote_delivery_failed").slice(0, 300);
}

function laneKey(value = {}) {
  return `${String(value.channelId || "default")}\u0000${String(value.accountId || "default")}`;
}

function pendingKey(value = {}) {
  return [
    String(value.channelId || "default"),
    String(value.accountId || "default"),
    String(value.conversationId || "default"),
    String(value.notificationId || ""),
  ].join("\u0000");
}

export class RemoteNotificationQueue {
  constructor(options = {}) {
    if (typeof options.sendMessage !== "function") {
      throw new TypeError("RemoteNotificationQueue requires sendMessage");
    }
    this.sendMessage = options.sendMessage;
    this.idFactory = options.idFactory || randomUUID;
    this.onDelivery = options.onDelivery || (() => {});
    this.logger = options.logger || console;
    this.maxAttempts = Math.max(1, Math.min(5, Number(options.maxAttempts || 5)));
    this.retryDelays = options.retryDelays || [0, 2_000, 5_000, 10_000, 20_000];
    this.requestTimeoutMs = Math.max(1_000, Number(options.requestTimeoutMs || 15_000));
    this.lanes = new Map();
    this.pendingIds = new Set();
    this.stopped = false;
    this.abortController = new AbortController();
    this.idleWaiters = [];
  }

  enqueue(value = {}) {
    const notificationId = String(value.notificationId || "").trim();
    const text = String(value.text || "").trim();
    if (this.stopped || !notificationId || !text) return false;
    const item = {
      notificationId,
      providerClientId: String(value.providerClientId || this.idFactory()).trim().slice(0, 200),
      taskId: String(value.taskId || ""),
      event: String(value.event || "unknown"),
      text: text.slice(0, 2_000),
      priority: Number(value.priority || 0),
      channelId: String(value.channelId || value.provider || "").trim().toLowerCase().slice(0, 40),
      accountId: String(value.accountId || "").trim().slice(0, 200),
      conversationId: String(value.conversationId || "").trim().slice(0, 200),
      projectCode: String(value.projectCode || "").slice(0, 20),
      sessionCode: String(value.sessionCode || "").slice(0, 20),
      sessionId: String(value.sessionId || "").slice(0, 200),
      projectKey: String(value.projectKey || "").slice(0, 2_000),
      enqueuedAt: Date.now(),
    };
    const id = pendingKey(item);
    if (this.pendingIds.has(id)) return false;
    this.pendingIds.add(id);
    const key = laneKey(item);
    const lane = this.lanes.get(key) || { items: [], running: false };
    lane.items.push(item);
    lane.items.sort((left, right) => (
      right.priority - left.priority || left.enqueuedAt - right.enqueuedAt
    ));
    this.lanes.set(key, lane);
    queueMicrotask(() => this.#drainLane(key, lane));
    return true;
  }

  async #report(value) {
    try {
      await this.onDelivery(value);
    } catch (error) {
      this.logger.warn("[remote] unable to report delivery state", error);
    }
  }

  async #deliver(item) {
    let lastError = null;
    let attempts = 0;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      if (this.abortController.signal.aborted) break;
      attempts = attempt;
      try {
        await wait(Number(this.retryDelays[attempt - 1] || 0), this.abortController.signal);
        const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
        const result = await this.sendMessage(item, {
          signal: timeoutSignal,
          attempt,
          clientId: item.providerClientId,
        });
        if (result?.ok === false) {
          const error = new Error(result.error || result.reason || "remote_delivery_failed");
          error.code = result.code || result.reason;
          error.transient = result.transient;
          throw error;
        }
        await this.#report({
          notificationId: item.notificationId,
          taskId: item.taskId,
          status: "sent",
          attempts: attempt,
          remoteMessageId: String(result?.messageId || result?.clientId || ""),
          channelId: String(result?.channelId || item.channelId || ""),
          accountId: String(result?.accountId || item.accountId || ""),
          conversationId: String(result?.conversationId || item.conversationId || ""),
          text: item.text,
          projectCode: item.projectCode,
          sessionCode: item.sessionCode,
          sessionId: item.sessionId,
          projectKey: item.projectKey,
        });
        return;
      } catch (error) {
        lastError = error;
        const retryable = error?.transient !== false
          && !NON_RETRYABLE_CODES.has(String(error?.code || error?.message || ""));
        if (!retryable || attempt >= this.maxAttempts) break;
      }
    }
    const cancelled = this.abortController.signal.aborted;
    await this.#report({
      notificationId: item.notificationId,
      taskId: item.taskId,
      status: cancelled ? "cancelled" : "failed",
      error: cancelled ? "remote_delivery_cancelled" : deliveryError(lastError),
      attempts,
      channelId: item.channelId,
      accountId: item.accountId,
      conversationId: item.conversationId,
    });
  }

  #isIdle() {
    return [...this.lanes.values()].every((lane) => !lane.running && !lane.items.length);
  }

  #resolveIdle() {
    if (!this.#isIdle()) return;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  async #drainLane(key, lane) {
    if (lane.running || this.stopped || this.lanes.get(key) !== lane) return;
    lane.running = true;
    try {
      while (!this.stopped && lane.items.length) {
        const item = lane.items.shift();
        await this.#deliver(item);
        this.pendingIds.delete(pendingKey(item));
      }
    } finally {
      lane.running = false;
      if (!lane.items.length && this.lanes.get(key) === lane) this.lanes.delete(key);
      this.#resolveIdle();
    }
  }

  dropTask(taskId) {
    const removed = [];
    for (const [key, lane] of this.lanes) {
      removed.push(...lane.items.filter((item) => item.taskId === taskId));
      lane.items = lane.items.filter((item) => item.taskId !== taskId);
      if (!lane.running && !lane.items.length) this.lanes.delete(key);
    }
    for (const item of removed) {
      this.pendingIds.delete(pendingKey(item));
      this.#report({
        notificationId: item.notificationId,
        taskId: item.taskId,
        status: "cancelled",
        error: "task_removed",
        attempts: 0,
        channelId: item.channelId,
        accountId: item.accountId,
        conversationId: item.conversationId,
      });
    }
    this.#resolveIdle();
  }

  whenIdle() {
    if (this.#isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    const pending = [];
    for (const lane of this.lanes.values()) pending.push(...lane.items.splice(0));
    this.abortController.abort(new Error("remote_delivery_cancelled"));
    for (const item of pending) {
      this.pendingIds.delete(pendingKey(item));
      await this.#report({
        notificationId: item.notificationId,
        taskId: item.taskId,
        status: "cancelled",
        error: "remote_delivery_cancelled",
        attempts: 0,
        channelId: item.channelId,
        accountId: item.accountId,
        conversationId: item.conversationId,
      });
    }
    await this.whenIdle();
  }
}

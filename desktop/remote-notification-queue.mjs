const NON_RETRYABLE_CODES = new Set([
  "remote_not_connected",
  "remote_not_bound",
  "remote_disabled",
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
  return String(error?.code || error?.message || "remote_delivery_failed").slice(0, 300);
}

export class RemoteNotificationQueue {
  constructor(options = {}) {
    if (typeof options.sendMessage !== "function") {
      throw new TypeError("RemoteNotificationQueue requires sendMessage");
    }
    this.sendMessage = options.sendMessage;
    this.onDelivery = options.onDelivery || (() => {});
    this.logger = options.logger || console;
    this.maxAttempts = Math.max(1, Math.min(5, Number(options.maxAttempts || 5)));
    this.retryDelays = options.retryDelays || [0, 2_000, 5_000, 10_000, 20_000];
    this.requestTimeoutMs = Math.max(1_000, Number(options.requestTimeoutMs || 15_000));
    this.items = [];
    this.pendingIds = new Set();
    this.running = false;
    this.stopped = false;
    this.abortController = new AbortController();
    this.idleWaiters = [];
  }

  enqueue(value = {}) {
    const notificationId = String(value.notificationId || "").trim();
    const text = String(value.text || "").trim();
    if (this.stopped || !notificationId || !text || this.pendingIds.has(notificationId)) return false;
    const item = {
      notificationId,
      taskId: String(value.taskId || ""),
      event: String(value.event || "unknown"),
      text: text.slice(0, 2_000),
      priority: Number(value.priority || 0),
      enqueuedAt: Date.now(),
    };
    this.pendingIds.add(notificationId);
    this.items.push(item);
    this.items.sort((left, right) => (
      right.priority - left.priority || left.enqueuedAt - right.enqueuedAt
    ));
    queueMicrotask(() => this.#drain());
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
        const result = await this.sendMessage(item, { signal: timeoutSignal, attempt });
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
    });
  }

  async #drain() {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      while (!this.stopped && this.items.length) {
        const item = this.items.shift();
        await this.#deliver(item);
        this.pendingIds.delete(item.notificationId);
      }
    } finally {
      this.running = false;
      if (!this.items.length) {
        for (const resolve of this.idleWaiters.splice(0)) resolve();
      }
    }
  }

  dropTask(taskId) {
    const removed = this.items.filter((item) => item.taskId === taskId);
    this.items = this.items.filter((item) => item.taskId !== taskId);
    for (const item of removed) {
      this.pendingIds.delete(item.notificationId);
      this.#report({
        notificationId: item.notificationId,
        taskId: item.taskId,
        status: "cancelled",
        error: "task_removed",
        attempts: 0,
      });
    }
  }

  whenIdle() {
    if (!this.running && !this.items.length) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    const pending = this.items.splice(0);
    this.abortController.abort(new Error("remote_delivery_cancelled"));
    for (const item of pending) {
      this.pendingIds.delete(item.notificationId);
      await this.#report({
        notificationId: item.notificationId,
        taskId: item.taskId,
        status: "cancelled",
        error: "remote_delivery_cancelled",
        attempts: 0,
      });
    }
    await this.whenIdle();
  }
}

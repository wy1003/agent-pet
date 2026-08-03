import { NOTIFICATION_EVENTS, PhraseComposer } from "./phrase-renderer.mjs";
import { renderRemoteMessage } from "./remote-message-renderer.mjs";

const ACTIVE_STATUSES = new Set(["submitted", "queued", "running"]);
const NOTIFICATION_EVENT_SET = new Set(NOTIFICATION_EVENTS);
const URGENT_EVENTS = new Set(["needs_input", "failed"]);
const PRIORITY = Object.freeze({
  needs_input: 100,
  failed: 90,
  interrupted: 80,
  unknown: 70,
  completed: 50,
});

function minutes(value) {
  const [hour, minute] = String(value || "").split(":").map(Number);
  return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : 0;
}

export function isQuietTime(quietHours, date = new Date()) {
  if (!quietHours?.enabled) return false;
  const start = minutes(quietHours.start);
  const end = minutes(quietHours.end);
  if (start === end) return true;
  const current = date.getHours() * 60 + date.getMinutes();
  return start < end
    ? current >= start && current < end
    : current >= start || current < end;
}

export class NotificationOrchestrator {
  constructor(options) {
    this.getPreferences = options.getPreferences;
    this.phraseStore = options.phraseStore;
    this.voiceQueue = options.voiceQueue;
    this.remoteQueue = options.remoteQueue || {
      enqueue: () => false,
      dropTask() {},
      async stop() {},
    };
    this.showWindowsNotification = options.showWindowsNotification || (() => {});
    this.recordHistory = options.recordHistory || (async () => {});
    this.composer = options.composer || new PhraseComposer();
    this.now = options.now || (() => new Date());
    this.logger = options.logger || console;
    this.statusByTask = new Map();
    this.tasks = new Map();
    this.notifiedEvents = new Set();
    this.plans = new Map();
    this.historyRecords = new Map();
    this.initialized = false;
  }

  seed(tasks = []) {
    for (const task of tasks) {
      if (!task?.taskId || task.threadSource === "subagent") continue;
      this.tasks.set(task.taskId, task);
      this.statusByTask.set(task.taskId, task.status);
      if (ACTIVE_STATUSES.has(task.status)) this.#prepareTask(task);
    }
    this.initialized = true;
  }

  handleEvent(event, value) {
    if (event === "snapshot") {
      if (!this.initialized) this.seed(value?.tasks);
      else this.#reconcileSnapshot(value?.tasks);
      return;
    }
    if (event === "task.removed") {
      this.removeTask(value?.taskId);
      return;
    }
    if (["task.created", "task.updated"].includes(event)) {
      this.handleTask(value).catch((error) => {
        this.logger.warn("[notifications] task notification failed", error);
      });
    }
  }

  #reconcileSnapshot(tasks = []) {
    const currentIds = new Set();
    for (const task of tasks) {
      if (!task?.taskId || task.threadSource === "subagent") continue;
      currentIds.add(task.taskId);
      this.handleTask(task).catch((error) => {
        this.logger.warn("[notifications] snapshot reconciliation failed", error);
      });
    }
    for (const taskId of this.statusByTask.keys()) {
      if (!currentIds.has(taskId)) this.removeTask(taskId);
    }
  }

  async handleTask(task) {
    if (!task?.taskId || task.threadSource === "subagent") return;
    this.tasks.set(task.taskId, task);
    const previousStatus = this.statusByTask.get(task.taskId);
    this.statusByTask.set(task.taskId, task.status);

    if (ACTIVE_STATUSES.has(task.status)) {
      if (previousStatus !== task.status) this.#prepareTask(task);
      return;
    }
    if (!NOTIFICATION_EVENT_SET.has(task.status) || previousStatus === task.status) return;

    const notificationKey = `${task.taskId}:${task.status}`;
    if (this.notifiedEvents.has(notificationKey)) return;
    this.notifiedEvents.add(notificationKey);

    await this.#dispatch(task, task.status, "task");
  }

  async sendTestReminder(event = "completed") {
    if (!NOTIFICATION_EVENT_SET.has(event)) throw new Error("不支持的测试提醒事件");
    const task = {
      taskId: `notification-test:${Date.now()}`,
      status: event,
      projectName: "Agent Pet",
      title: "测试任务提醒",
      question: "测试任务提醒",
    };
    return this.#dispatch(task, event, "test");
  }

  async #saveHistory(record) {
    const next = { ...record, updatedAt: this.now().toISOString() };
    this.historyRecords.set(next.id, next);
    try {
      await this.recordHistory(next);
    } catch (error) {
      this.logger.warn("[notifications] unable to persist notification history", error);
    }
    return next;
  }

  #resultFor(record) {
    const statuses = [record.windows, record.voice, record.remote];
    if (statuses.some((status) => ["pending", "queued", "synthesizing", "playing", "sending"].includes(status))) {
      return "pending";
    }
    const success = statuses.some((status) => ["sent", "played"].includes(status));
    const failed = statuses.some((status) => status === "failed");
    if (success && failed) return "partial";
    if (success) return "success";
    if (failed) return "failed";
    return "skipped";
  }

  async #dispatch(task, event, source) {
    const preferences = this.getPreferences();
    const createdAt = this.now().toISOString();
    let record = {
      id: `${source}:${Date.now()}:${Math.random().toString(36).slice(2, 9)}`,
      createdAt,
      updatedAt: createdAt,
      source,
      taskId: task.taskId,
      taskTitle: task.title || task.question || "未命名任务",
      projectName: task.projectName || "",
      event,
      text: "",
      result: "skipped",
      reason: "",
      windows: preferences.notifications.windows.enabled ? "pending" : "disabled",
      voice: preferences.notifications.voice.enabled ? "pending" : "disabled",
      remote: preferences.notifications.mobile.enabled ? "pending" : "disabled",
      remoteProvider: preferences.notifications.mobile.provider || "weixin",
      remoteAttempts: 0,
    };

    if (!preferences.rules?.[event]) {
      record = await this.#saveHistory({
        ...record,
        windows: "skipped",
        voice: "skipped",
        remote: "skipped",
        reason: "rule_disabled",
      });
      return { ok: false, reason: record.reason, event, channels: [], record };
    }
    if (isQuietTime(preferences.quietHours, this.now())
      && !(preferences.quietHours.allowUrgent && URGENT_EVENTS.has(event))) {
      record = await this.#saveHistory({
        ...record,
        windows: "skipped",
        voice: "skipped",
        remote: "skipped",
        reason: "quiet_hours",
      });
      return { ok: false, reason: record.reason, event, channels: [], record };
    }

    const pool = await this.phraseStore.getPhrases(preferences.notifications.voice.style);
    record.text = this.composer.compose(pool, event, task, preferences);
    this.historyRecords.set(record.id, record);

    if (preferences.notifications.windows.enabled) {
      try {
        const delivery = this.showWindowsNotification({ task, event, text: record.text, preferences });
        record.windows = delivery?.ok === false ? (delivery.status || "failed") : "sent";
        if (delivery?.ok === false) record.reason = delivery.reason || "windows_notification_failed";
      } catch (error) {
        record.windows = "failed";
        record.reason = error?.message || "windows_notification_failed";
      }
    }

    const voiceItem = preferences.notifications.voice.enabled ? {
        notificationId: record.id,
        taskId: task.taskId,
        event,
        text: record.text,
        priority: PRIORITY[event] || 0,
      } : null;
    if (voiceItem) record.voice = "queued";

    let remoteItem = null;
    if (preferences.notifications.mobile.enabled) {
      const remoteText = renderRemoteMessage(
        task,
        event,
        preferences.notifications.mobile.contentLevel,
      );
      remoteItem = {
        notificationId: record.id,
        taskId: task.taskId,
        event,
        text: remoteText,
        priority: PRIORITY[event] || 0,
      };
      record.remote = "queued";
    }

    if (record.windows === "disabled" && record.voice === "disabled" && record.remote === "disabled") {
      record.reason = "no_channels";
    }
    record.result = this.#resultFor(record);
    record = await this.#saveHistory(record);

    let queueRejected = false;
    if (voiceItem && !this.voiceQueue.enqueue(voiceItem)) {
      record.voice = "failed";
      if (!record.reason) record.reason = "voice_queue_rejected";
      queueRejected = true;
    }
    if (remoteItem && !this.remoteQueue.enqueue(remoteItem)) {
      record.remote = "failed";
      if (!record.reason) record.reason = "remote_queue_rejected";
      queueRejected = true;
    }
    if (queueRejected) {
      record.result = this.#resultFor(record);
      record = await this.#saveHistory(record);
    }
    const channels = [];
    if (record.windows === "sent") channels.push("windows");
    if (["queued", "synthesizing", "playing", "played"].includes(record.voice)) channels.push("voice");
    if (["queued", "sending", "sent"].includes(record.remote)) channels.push("remote");
    const ok = ["pending", "success", "partial"].includes(record.result);
    return { ok, reason: ok ? "" : record.reason, event, text: record.text, channels, record };
  }

  async handleVoiceDelivery(delivery) {
    const record = this.historyRecords.get(delivery?.notificationId);
    if (!record) return;
    const next = {
      ...record,
      voice: delivery.status,
      reason: delivery.error || (delivery.status === "played" ? "" : record.reason),
    };
    next.result = this.#resultFor(next);
    await this.#saveHistory(next);
    this.#releaseFinishedRecord(next);
  }

  async handleRemoteDelivery(delivery) {
    const record = this.historyRecords.get(delivery?.notificationId);
    if (!record) return;
    const next = {
      ...record,
      remote: delivery.status,
      remoteAttempts: Math.max(0, Number(delivery.attempts || 0)),
      reason: delivery.error || record.reason,
    };
    next.result = this.#resultFor(next);
    await this.#saveHistory(next);
    this.#releaseFinishedRecord(next);
  }

  #releaseFinishedRecord(record) {
    const voiceFinished = ["disabled", "skipped", "played", "failed", "cancelled"].includes(record.voice);
    const remoteFinished = ["disabled", "skipped", "sent", "failed", "cancelled"].includes(record.remote);
    if (voiceFinished && remoteFinished) this.historyRecords.delete(record.id);
  }

  async #ensurePlan(task) {
    const existing = this.plans.get(task.taskId);
    if (existing) return existing;
    const pending = (async () => {
      const preferences = this.getPreferences();
      const pool = await this.phraseStore.getPhrases(preferences.notifications.voice.style);
      return Object.fromEntries(NOTIFICATION_EVENTS.map((event) => [
        event,
        this.composer.compose(pool, event, task, preferences),
      ]));
    })();
    this.plans.set(task.taskId, pending);
    return pending;
  }

  #prepareTask(task) {
    const preferences = this.getPreferences();
    if (!preferences.notifications.voice.enabled) return;
    if (preferences.notifications.voice.engine !== "gpt-sovits") return;
    this.#ensurePlan(task)
      .then((plan) => {
        for (const event of NOTIFICATION_EVENTS) {
          if (!preferences.rules?.[event]) continue;
          this.voiceQueue.prepare({
            taskId: task.taskId,
            event,
            text: plan[event],
            priority: PRIORITY[event] || 0,
          });
        }
      })
      .catch((error) => this.logger.warn("[notifications] audio preparation skipped", error));
  }

  preferencesChanged() {
    this.plans.clear();
    this.voiceQueue.cancelPending();
    for (const [taskId, status] of this.statusByTask) {
      if (!ACTIVE_STATUSES.has(status)) continue;
      this.voiceQueue.dropTask(taskId);
      const task = this.tasks.get(taskId);
      if (task) this.#prepareTask(task);
    }
  }

  removeTask(taskId) {
    if (!taskId) return;
    this.statusByTask.delete(taskId);
    this.tasks.delete(taskId);
    this.plans.delete(taskId);
    for (const event of NOTIFICATION_EVENTS) this.notifiedEvents.delete(`${taskId}:${event}`);
    this.voiceQueue.dropTask(taskId);
    this.remoteQueue.dropTask(taskId);
  }

  async stop() {
    this.statusByTask.clear();
    this.tasks.clear();
    this.plans.clear();
    this.notifiedEvents.clear();
    this.historyRecords.clear();
    this.initialized = false;
    await Promise.all([this.voiceQueue.stop(), this.remoteQueue.stop()]);
  }
}

import { EventEmitter } from "node:events";

const EVENTS = ["task.created", "task.updated", "task.removed", "session.updated", "diagnostic"];
const TASK_PRIORITY = { needs_input: 0, failed: 1, running: 2, queued: 3, submitted: 4, interrupted: 5, completed: 6, unknown: 7 };
const SESSION_PRIORITY = { needs_input: 0, blocked: 1, ready: 2, running: 3, unknown: 4, idle: 5 };
const time = (value) => Date.parse(value) || 0;

export class MultiAgentCollector extends EventEmitter {
  constructor(collectors = []) {
    super();
    this.collectors = [...new Set(collectors)];
    this.sessions = new Map();
    this.bindings = [];
    this.started = false;
    this.stopped = false;
    this.pending = Promise.resolve();
    this.readCache = new Map();
    this.readFailures = new Map();
    this.startFailures = new Set();
    this.#refreshSessions();
  }
  #diagnostic() { this.emit("diagnostic", { level: "error", code: "collector_unavailable", message: "Collector provider unavailable" }); }
  #unavailable() { return Object.assign(new Error("Collector provider unavailable"), { code: "collector_unavailable" }); }
  #read(collector, method, argument) {
    let failures = this.readFailures.get(collector);
    if (!failures) this.readFailures.set(collector, failures = new Set());
    try {
      const value = collector[method](argument);
      failures.delete(method);
      return value;
    } catch {
      failures.add(method);
      this.#diagnostic();
      throw this.#unavailable();
    }
  }
  #list(collector, method, options) {
    let cache = this.readCache.get(collector);
    if (!cache) this.readCache.set(collector, cache = new Map());
    const key = `${method}:${JSON.stringify(options)}`;
    try {
      const rows = this.#read(collector, method, options);
      if (!Array.isArray(rows)) throw this.#unavailable();
      cache.set(key, structuredClone(rows));
      return rows;
    } catch {
      return (cache.get(key) || []).map((row) => method === "getTasks"
        ? { ...row, status: "unknown", phase: "unknown", dataUnavailable: true, canAcknowledge: false }
        : { ...row, dataUnavailable: true, status: { ...row.status, petStatus: "unknown", executionStatus: "unknown", confidence: "unknown" } });
    }
  }
  #owner(method, id) {
    let failed = false;
    for (const collector of this.collectors) {
      try {
        const value = this.#read(collector, method, id);
        if (value) {
          if (this.startFailures.has(collector) || this.readFailures.get(collector)?.size) throw this.#unavailable();
          return { collector, value };
        }
      } catch { failed = true; }
    }
    if (failed) throw this.#unavailable();
    return null;
  }
  #enqueue(operation) {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => {});
    return result;
  }
  #refreshSessions() { this.getSessions(); }
  start() {
    return this.#enqueue(async () => {
      if (this.started) return;
      this.started = true;
      this.stopped = false;
      for (const collector of this.collectors) {
        for (const event of EVENTS) {
          const handler = (value) => {
            if (event === "session.updated") this.sessions.set(value.sessionId, value);
            this.emit(event, value);
          };
          collector.on(event, handler);
          this.bindings.push([collector, event, handler]);
        }
      }
      await Promise.all(this.collectors.map(async (collector) => {
        try { await collector.start(); this.startFailures.delete(collector); }
        catch { this.startFailures.add(collector); this.#diagnostic(); }
      }));
      this.#refreshSessions();
    });
  }
  stop() {
    return this.#enqueue(async () => {
      if (this.stopped) return;
      this.stopped = true;
      this.started = false;
      for (const [collector, event, handler] of this.bindings) collector.off(event, handler);
      this.bindings = [];
      const results = await Promise.allSettled(this.collectors.map((collector) => Promise.resolve().then(() => collector.stop())));
      const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
      for (const error of errors) this.#diagnostic(error);
      if (errors.length) throw new AggregateError(errors, "Collector stop failed");
    });
  }
  scanOnce() {
    return this.#enqueue(async () => {
      await Promise.all(this.collectors.map(async (collector) => {
        try { await collector.scanOnce(); } catch (error) { this.#diagnostic(error); }
      }));
      this.#refreshSessions();
    });
  }
  getTasks(options = {}) {
    return this.collectors.flatMap((collector) => this.#list(collector, "getTasks", options)).sort((a, b) =>
      (TASK_PRIORITY[a.status] ?? 99) - (TASK_PRIORITY[b.status] ?? 99)
      || time(b.lastActivityAt || b.submittedAt) - time(a.lastActivityAt || a.submittedAt));
  }
  getSessions(options = {}) {
    const sessions = this.collectors.flatMap((collector) => this.#list(collector, "getSessions", options)).sort((a, b) =>
      (SESSION_PRIORITY[a.status?.petStatus] ?? 99) - (SESSION_PRIORITY[b.status?.petStatus] ?? 99)
      || time(b.status?.lastActivityAt || b.updatedAt || b.createdAt) - time(a.status?.lastActivityAt || a.updatedAt || a.createdAt));
    this.sessions.clear();
    for (const session of sessions) this.sessions.set(session.sessionId, session);
    return sessions;
  }
  getTask(taskId) { return this.#owner("getTask", taskId)?.value ?? null; }
  getSession(sessionId) { return this.#owner("getSession", sessionId)?.value ?? null; }
  isSessionActive(sessionId) {
    try {
      const owner = this.#owner("getSession", sessionId);
      if (!owner || this.startFailures.has(owner.collector) || this.readFailures.get(owner.collector)?.size) return true;
      if (typeof owner.collector.isSessionActive !== "function") return true;
      return this.#read(owner.collector, "isSessionActive", sessionId) !== false;
    } catch { return true; }
  }
  markRead(sessionId) {
    const owner = this.#owner("getSession", sessionId)?.collector;
    return owner ? owner.markRead(sessionId) : null;
  }
  async dismissTask(taskId) {
    const owner = this.#owner("getTask", taskId)?.collector;
    return owner ? owner.dismissTask(taskId) : { ok: false, reason: "visible_task_not_found" };
  }
  async dismissAllTasks(options = {}) {
    const results = await Promise.all(this.collectors.map((collector) => collector.dismissAllTasks(options)));
    const failed = results.find((result) => !result.ok);
    return { ...(failed || { ok: true }), tasks: results.filter((result) => result.ok).flatMap((result) => result.tasks) };
  }
}

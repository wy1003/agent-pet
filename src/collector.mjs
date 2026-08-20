import { EventEmitter } from "node:events";
import { mkdir, open, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  applyIndexedTitle,
  applyRecord,
  createSession,
  expireStalePendingTask,
  markPendingTaskQueued,
  markSessionRead,
  markSessionStale,
  sessionTaskSnapshots,
  sessionSnapshot,
} from "./model.mjs";
import { defaultIgnoredProjectPaths, normalizeProjectPath } from "./internal-projects.mjs";

const READ_CHUNK_BYTES = 64 * 1024;
const SUBAGENT_FAST_SKIP_BYTES = 8 * 1024 * 1024;
const INITIAL_HISTORY_MS = 24 * 60 * 60 * 1000;
const OWNER_SCAN_BYTES = 1024 * 1024;
const MAX_BUFFERED_LINE_BYTES = 1024 * 1024;

async function listJsonlFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) files.push(fullPath);
    }
  }
  return files.sort();
}

function splitCompleteLines(buffer) {
  const lines = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0x0a) continue;
    let end = index;
    if (end > start && buffer[end - 1] === 0x0d) end -= 1;
    lines.push(buffer.subarray(start, end));
    start = index + 1;
  }
  return { lines, pending: buffer.subarray(start) };
}

function recordTypePrefix(line) {
  const prefix = Buffer.isBuffer(line)
    ? line.subarray(0, Math.min(line.length, 2048)).toString("utf8")
    : String(line || "").slice(0, 2048);
  return {
    prefix,
    type: /"type"\s*:\s*"([^"]+)"/.exec(prefix)?.[1] || "",
  };
}

function lineCanAffectSession(line, ownerResolved) {
  if (!ownerResolved) return true;
  const { prefix, type } = recordTypePrefix(line);
  if (["session_meta", "turn_context", "event_msg"].includes(type)) return true;
  if (type !== "response_item") return false;
  return /"type"\s*:\s*"(?:function_call|custom_tool_call|tool_search_call)"/.test(prefix);
}

function activityTime(session) {
  return Date.parse(session.status.lastActivityAt || session.updatedAt || session.createdAt) || 0;
}

const STATUS_PRIORITY = {
  needs_input: 0,
  blocked: 1,
  ready: 2,
  running: 3,
  unknown: 4,
  idle: 5,
};

const TASK_STATUS_PRIORITY = {
  needs_input: 0,
  failed: 1,
  running: 2,
  queued: 3,
  submitted: 4,
  interrupted: 5,
  completed: 6,
  unknown: 7,
};

const ACTIVE_TASK_STATUSES = new Set(["submitted", "queued", "running", "needs_input"]);
const DISMISSIBLE_TASK_STATUSES = new Set(["completed", "failed", "interrupted", "unknown"]);

function taskActivityTime(task) {
  return Date.parse(task.lastActivityAt || task.submittedAt || 0) || 0;
}

function userFacingTaskSnapshots(session) {
  return sessionTaskSnapshots(session).filter((task) => (
    String(task.question || "").trim() || ACTIVE_TASK_STATUSES.has(task.status)
  ));
}

export class CodexActivityCollector extends EventEmitter {
  constructor(options = {}) {
    super();
    if (!options.codexHome) throw new Error("codexHome is required");
    this.codexHome = path.resolve(options.codexHome);
    this.sessionsDir = path.join(this.codexHome, "sessions");
    this.sessionIndexPath = path.join(this.codexHome, "session_index.jsonl");
    this.pollIntervalMs = Math.max(50, Number(options.pollIntervalMs || 750));
    this.staleAfterMs = Math.max(1_000, Number(options.staleAfterMs || 15 * 60 * 1000));
    this.pendingExpiryMs = Math.max(
      1_000,
      Number(options.pendingExpiryMs || 24 * 60 * 60 * 1000),
    );
    this.queuedAfterMs = Math.max(0, Number(options.queuedAfterMs ?? 1_000));
    this.includeSubagents = Boolean(options.includeSubagents);
    this.subagentFastSkipBytes = Math.max(
      1,
      Number(options.subagentFastSkipBytes ?? SUBAGENT_FAST_SKIP_BYTES),
    );
    this.initialHistoryMs = Math.max(
      0,
      Number(options.initialHistoryMs ?? INITIAL_HISTORY_MS),
    );
    this.ignoredProjectPaths = new Set(
      (options.ignoredProjectPaths || defaultIgnoredProjectPaths())
        .filter(Boolean)
        .map((value) => normalizeProjectPath(value)),
    );
    this.statePath =
      options.statePath === false
        ? null
        : path.resolve(options.statePath || path.join(this.codexHome, "activity-collector-state.json"));
    this.sessions = new Map();
    this.files = new Map();
    this.indexTitles = new Map();
    this.indexSignature = "";
    this.changedSessionIds = new Set();
    this.lastDigests = new Map();
    this.lastTaskDigests = new Map();
    this.taskIdsBySession = new Map();
    this.visibleTaskIds = new Set();
    this.stateLoaded = false;
    this.stateDirty = false;
    this.stateWritePromise = Promise.resolve();
    this.initialized = false;
    this.timer = null;
    this.scanning = false;
  }

  async start() {
    await this.scanOnce();
    if (!this.timer) {
      this.timer = setInterval(() => {
        this.scanOnce().catch((error) => this.emit("diagnostic", { level: "error", error }));
      }, this.pollIntervalMs);
      this.timer.unref?.();
    }
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.scanning) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await this.#persistVisibilityState();
  }

  async scanOnce() {
    if (this.scanning) return;
    this.scanning = true;
    try {
      await this.#loadVisibilityState();
      await this.#loadSessionIndex();
      const files = await listJsonlFiles(this.sessionsDir);
      if (!this.initialized) {
        const visibleSessionIds = new Set(
          [...this.visibleTaskIds]
            .map((taskId) => /^codex:([^:]+):/.exec(taskId)?.[1] || "")
            .filter(Boolean),
        );
        const recentCutoff = Date.now() - this.initialHistoryMs;
        for (const filePath of files) {
          const info = await stat(filePath);
          const fileName = path.basename(filePath);
          const restoresVisibleTask = [...visibleSessionIds].some((sessionId) => (
            fileName.includes(sessionId)
          ));
          if (restoresVisibleTask || info.mtimeMs >= recentCutoff) {
            await this.#readAppended(filePath, info);
          } else {
            await this.#bootstrapHistoricalFile(filePath, info);
          }
        }
      } else {
        for (const filePath of files) {
          await this.#readAppended(filePath);
        }
      }
      this.#applyIndexTitles();
      const now = Date.now();
      for (const session of this.sessions.values()) {
        if (expireStalePendingTask(session, now, this.pendingExpiryMs)) {
          this.changedSessionIds.add(session.sessionId);
        } else if (markPendingTaskQueued(session, now, this.queuedAfterMs)) {
          this.changedSessionIds.add(session.sessionId);
        }
        if (markSessionStale(session, now, this.staleAfterMs)) {
          this.changedSessionIds.add(session.sessionId);
        }
      }
      if (!this.initialized) {
        const visibleSessions = [...this.sessions.values()]
          .filter((session) => this.includeSubagents || session.threadSource !== "subagent");
        const knownTaskIds = new Set(
          visibleSessions
            .flatMap(userFacingTaskSnapshots)
            .map((task) => task.taskId),
        );
        for (const taskId of this.visibleTaskIds) {
          if (knownTaskIds.has(taskId)) continue;
          this.visibleTaskIds.delete(taskId);
          this.stateDirty = true;
        }
        for (const session of visibleSessions) {
          for (const task of userFacingTaskSnapshots(session)) {
            if (ACTIVE_TASK_STATUSES.has(task.status)) this.#trackVisibleTask(task.taskId);
          }
        }
        this.initialized = true;
      }
      this.#flushChanges();
      try {
        await this.#persistVisibilityState();
      } catch {
        // Keep collecting and retry on a later scan. Acknowledge requests report write failures.
      }
    } finally {
      this.scanning = false;
    }
  }

  getSessions(options = {}) {
    const includeSubagents = Boolean(options.includeSubagents);
    return [...this.sessions.values()]
      .filter((session) => includeSubagents || session.threadSource !== "subagent")
      .sort((left, right) => {
        const priority =
          (STATUS_PRIORITY[left.status.petStatus] ?? 99) -
          (STATUS_PRIORITY[right.status.petStatus] ?? 99);
        return priority || activityTime(right) - activityTime(left);
      })
      .map(sessionSnapshot);
  }

  getSession(sessionId) {
    const session = this.sessions.get(String(sessionId));
    return session ? sessionSnapshot(session) : null;
  }

  getTasks(options = {}) {
    const includeSubagents = Boolean(options.includeSubagents);
    const scope = options.scope || "current";
    return [...this.sessions.values()]
      .filter((session) => includeSubagents || session.threadSource !== "subagent")
      .flatMap(userFacingTaskSnapshots)
      .filter((task) => {
        if (scope === "all") return true;
        if (scope === "active") return ACTIVE_TASK_STATUSES.has(task.status);
        return this.visibleTaskIds.has(task.taskId);
      })
      .sort((left, right) => {
        const priority =
          (TASK_STATUS_PRIORITY[left.status] ?? 99) -
          (TASK_STATUS_PRIORITY[right.status] ?? 99);
        return priority || taskActivityTime(right) - taskActivityTime(left);
      });
  }

  getTask(taskId) {
    const id = String(taskId);
    for (const session of this.sessions.values()) {
      if (session.threadSource === "subagent") continue;
      const task = userFacingTaskSnapshots(session).find((item) => item.taskId === id);
      if (task) return task;
    }
    return null;
  }

  async dismissTask(taskId) {
    const id = String(taskId);
    const task = this.getTask(id);
    if (!task || !this.visibleTaskIds.has(id)) {
      return { ok: false, reason: "visible_task_not_found" };
    }
    if (!DISMISSIBLE_TASK_STATUSES.has(task.status)) {
      return { ok: false, reason: "task_not_terminal", task };
    }
    this.visibleTaskIds.delete(id);
    this.stateDirty = true;
    try {
      await this.#persistVisibilityState();
    } catch (error) {
      this.visibleTaskIds.add(id);
      this.stateDirty = true;
      return { ok: false, reason: "state_persist_failed", task, error };
    }
    this.emit("task.removed", { taskId: id, sessionId: task.sessionId });
    return { ok: true, task };
  }

  async dismissAllTasks(options = {}) {
    const includeSubagents = options.includeSubagents === undefined
      ? this.includeSubagents
      : Boolean(options.includeSubagents);
    const tasks = this.getTasks({
      includeSubagents,
    }).filter((task) => DISMISSIBLE_TASK_STATUSES.has(task.status));
    if (!tasks.length) return { ok: true, tasks: [] };

    for (const task of tasks) this.visibleTaskIds.delete(task.taskId);
    this.stateDirty = true;
    try {
      await this.#persistVisibilityState();
    } catch (error) {
      for (const task of tasks) this.visibleTaskIds.add(task.taskId);
      this.stateDirty = true;
      return { ok: false, reason: "state_persist_failed", tasks, error };
    }
    for (const task of tasks) {
      this.emit("task.removed", { taskId: task.taskId, sessionId: task.sessionId });
    }
    return { ok: true, tasks };
  }

  markRead(sessionId) {
    const session = this.sessions.get(String(sessionId));
    if (!session) return null;
    markSessionRead(session);
    this.changedSessionIds.add(session.sessionId);
    this.#flushChanges();
    return sessionSnapshot(session);
  }

  #trackVisibleTask(taskId) {
    const size = this.visibleTaskIds.size;
    this.visibleTaskIds.add(String(taskId));
    if (this.visibleTaskIds.size !== size) this.stateDirty = true;
  }

  async #loadVisibilityState() {
    if (this.stateLoaded) return;
    this.stateLoaded = true;
    if (!this.statePath) return;
    try {
      const content = await readFile(this.statePath, "utf8");
      const state = JSON.parse(content);
      if (!Array.isArray(state.unacknowledgedTaskIds)) {
        throw new Error("state has no unacknowledgedTaskIds array");
      }
      for (const taskId of state.unacknowledgedTaskIds) {
        if (typeof taskId === "string" && taskId) this.visibleTaskIds.add(taskId);
      }
    } catch (error) {
      if (error?.code === "ENOENT") return;
      this.emit("diagnostic", {
        level: "warn",
        message: `Ignored invalid collector state at ${this.statePath}`,
        error,
      });
    }
  }

  async #persistVisibilityState() {
    if (!this.statePath || !this.stateDirty) return this.stateWritePromise;
    this.stateWritePromise = this.stateWritePromise.catch(() => {}).then(async () => {
      if (!this.stateDirty) return;
      this.stateDirty = false;
      const directory = path.dirname(this.statePath);
      const temporaryPath = `${this.statePath}.${process.pid}.tmp`;
      const state = {
        version: 1,
        updatedAt: new Date().toISOString(),
        unacknowledgedTaskIds: [...this.visibleTaskIds].sort(),
      };
      try {
        await mkdir(directory, { recursive: true });
        await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
        await rename(temporaryPath, this.statePath);
      } catch (error) {
        this.stateDirty = true;
        this.emit("diagnostic", {
          level: "error",
          message: `Failed to persist collector state at ${this.statePath}`,
          error,
        });
        throw error;
      }
    });
    return this.stateWritePromise;
  }

  async #loadSessionIndex() {
    let info;
    try {
      info = await stat(this.sessionIndexPath);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    const signature = `${info.size}:${info.mtimeMs}`;
    if (signature === this.indexSignature) return;

    const content = await readFile(this.sessionIndexPath, "utf8");
    const titles = new Map();
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        if (item.id && item.thread_name) titles.set(String(item.id), String(item.thread_name));
      } catch (error) {
        this.emit("diagnostic", {
          level: "warn",
          message: "Skipped malformed session_index line",
          error,
        });
      }
    }
    this.indexTitles = titles;
    this.indexSignature = signature;
  }

  async #bootstrapHistoricalFile(filePath, info) {
    if (this.files.has(filePath)) return;
    const fileState = {
      offset: info.size,
      pending: Buffer.alloc(0),
      skippingLine: false,
      sessionId: null,
      ownerResolved: false,
      ignored: false,
      contentSkipped: false,
    };
    this.files.set(filePath, fileState);
    if (!info.size) return;

    const handle = await open(filePath, "r");
    try {
      let position = 0;
      let pending = Buffer.alloc(0);
      while (position < Math.min(info.size, OWNER_SCAN_BYTES) && !fileState.ownerResolved) {
        const length = Math.min(READ_CHUNK_BYTES, info.size - position, OWNER_SCAN_BYTES - position);
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        if (!bytesRead) break;
        position += bytesRead;
        const current = buffer.subarray(0, bytesRead);
        const complete = pending.length ? Buffer.concat([pending, current]) : current;
        const split = splitCompleteLines(complete);
        pending = Buffer.from(split.pending);
        for (const line of split.lines) {
          if (!line.length) continue;
          this.#processLine(filePath, fileState, line);
          if (fileState.ownerResolved) break;
        }
      }
    } finally {
      await handle.close();
    }
  }

  #applyIndexTitles() {
    for (const [sessionId, title] of this.indexTitles) {
      const session = this.sessions.get(sessionId);
      if (session && applyIndexedTitle(session, title)) this.changedSessionIds.add(sessionId);
    }
  }

  async #readAppended(filePath, knownInfo = null) {
    let info = knownInfo;
    if (!info) {
      try {
        info = await stat(filePath);
      } catch (error) {
        if (error?.code === "ENOENT") return;
        throw error;
      }
    }

    let fileState = this.files.get(filePath);
    if (!fileState) {
      fileState = {
        offset: 0,
        pending: Buffer.alloc(0),
        skippingLine: false,
        sessionId: null,
        ownerResolved: false,
        ignored: false,
        contentSkipped: false,
      };
      this.files.set(filePath, fileState);
    }
    if (info.size < fileState.offset) {
      fileState.offset = 0;
      fileState.pending = Buffer.alloc(0);
      fileState.skippingLine = false;
      fileState.sessionId = null;
      fileState.ownerResolved = false;
      fileState.ignored = false;
      fileState.contentSkipped = false;
    }
    if (fileState.ignored || fileState.contentSkipped) {
      fileState.offset = info.size;
      fileState.pending = Buffer.alloc(0);
      fileState.skippingLine = false;
      return;
    }
    if (info.size === fileState.offset) return;

    const handle = await open(filePath, "r");
    try {
      let position = fileState.offset;
      let pending = fileState.pending;
      while (position < info.size) {
        const length = Math.min(READ_CHUNK_BYTES, info.size - position);
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        if (!bytesRead) break;
        position += bytesRead;
        let current = buffer.subarray(0, bytesRead);
        if (fileState.skippingLine) {
          const newline = current.indexOf(0x0a);
          if (newline === -1) continue;
          fileState.skippingLine = false;
          current = current.subarray(newline + 1);
          if (!current.length) continue;
        }
        const complete = pending.length ? Buffer.concat([pending, current]) : current;
        const split = splitCompleteLines(complete);
        pending = Buffer.from(split.pending);
        if (pending.length > MAX_BUFFERED_LINE_BYTES
          && !lineCanAffectSession(pending, fileState.ownerResolved)) {
          pending = Buffer.alloc(0);
          fileState.skippingLine = true;
        }
        let skipRemainder = false;
        for (const line of split.lines) {
          if (!line.length || !lineCanAffectSession(line, fileState.ownerResolved)) continue;
          this.#processLine(filePath, fileState, line);
          const owner = fileState.sessionId ? this.sessions.get(fileState.sessionId) : null;
          if (fileState.ignored || (
            !this.includeSubagents
            && info.size >= this.subagentFastSkipBytes
            && owner?.threadSource === "subagent"
          )) {
            fileState.contentSkipped = !fileState.ignored;
            skipRemainder = true;
            break;
          }
        }
        if (skipRemainder) {
          position = info.size;
          pending = Buffer.alloc(0);
          break;
        }
      }
      fileState.offset = position;
      fileState.pending = Buffer.from(pending);
    } finally {
      await handle.close();
    }
  }

  #processLine(filePath, fileState, line) {
    let record;
    try {
      record = JSON.parse(Buffer.isBuffer(line) ? line.toString("utf8") : line);
    } catch (error) {
      this.emit("diagnostic", {
        level: "warn",
        message: `Skipped malformed JSONL line in ${filePath}`,
        error,
      });
      return;
    }

    if (record.type === "session_meta") {
      // A spawned Codex rollout may contain a copied root session_meta after
      // its own child metadata. The first metadata record owns the whole file;
      // allowing later copies to switch sessionId merges child execution into
      // the user's root task and creates duplicate task cards.
      if (fileState.ownerResolved) return;
      const id = String(record.payload?.id || record.payload?.session_id || "");
      if (!id) return;
      fileState.ownerResolved = true;
      const cwd = String(record.payload?.cwd || "");
      if (cwd && this.ignoredProjectPaths.has(normalizeProjectPath(cwd))) {
        fileState.sessionId = null;
        fileState.ignored = true;
        return;
      }
      fileState.ignored = false;
      fileState.sessionId = id;
      if (!this.sessions.has(id)) {
        try {
          this.sessions.set(id, createSession(record.payload, filePath, record.timestamp));
          this.changedSessionIds.add(id);
        } catch (error) {
          this.emit("diagnostic", { level: "error", message: error.message, error });
        }
      }
      return;
    }

    if (fileState.ignored) return;
    const sessionId = fileState.sessionId;
    const session = sessionId ? this.sessions.get(sessionId) : null;
    if (!session) return;
    const before = JSON.stringify(sessionSnapshot(session));
    applyRecord(session, record);
    if (this.initialized && (this.includeSubagents || session.threadSource !== "subagent")) {
      for (const task of userFacingTaskSnapshots(session)) {
        if (ACTIVE_TASK_STATUSES.has(task.status)) this.#trackVisibleTask(task.taskId);
      }
    }
    const after = JSON.stringify(sessionSnapshot(session));
    if (before !== after) this.changedSessionIds.add(sessionId);
  }

  #flushChanges() {
    for (const sessionId of this.changedSessionIds) {
      const session = this.sessions.get(sessionId);
      if (!session) continue;

      const tasks = this.includeSubagents || session.threadSource !== "subagent"
        ? userFacingTaskSnapshots(session)
        : [];
      const currentTaskIds = new Set(tasks.map((task) => task.taskId));
      const previousTaskIds = this.taskIdsBySession.get(sessionId) || new Set();
      for (const taskId of previousTaskIds) {
        if (currentTaskIds.has(taskId)) continue;
        this.lastTaskDigests.delete(taskId);
        if (this.visibleTaskIds.delete(taskId)) {
          this.stateDirty = true;
          this.emit("task.removed", { taskId, sessionId });
        }
      }
      for (const task of tasks) {
        const digest = JSON.stringify(task);
        const previousDigest = this.lastTaskDigests.get(task.taskId);
        if (previousDigest === digest) continue;
        this.lastTaskDigests.set(task.taskId, digest);
        if (this.visibleTaskIds.has(task.taskId)) {
          this.emit(previousDigest === undefined ? "task.created" : "task.updated", task);
        }
      }
      this.taskIdsBySession.set(sessionId, currentTaskIds);

      const snapshot = sessionSnapshot(session);
      const digest = JSON.stringify(snapshot);
      if (this.lastDigests.get(sessionId) === digest) continue;
      this.lastDigests.set(sessionId, digest);
      this.emit("session.updated", snapshot);
    }
    this.changedSessionIds.clear();
  }
}

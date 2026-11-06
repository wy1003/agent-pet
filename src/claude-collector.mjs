import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, rm } from "node:fs/promises";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { readStoppedTurnText } from "./claude-transcript.mjs";
import { ClaudeTranscriptDiscovery } from "./claude-discovery.mjs";
import { makeTitle } from "./text.mjs";
import { parseRemoteRequest } from "./remote-request.mjs";

const LIMIT = 1024 * 1024, SEEN_LIMIT = 10_000, STATE_LIMIT = 16 * LIMIT;
const stateTooLarge = () => Object.assign(new Error("Claude state exceeds byte budget"), { code: "claude_state_too_large" });
async function readState(file) {
  const handle = await open(file, "r");
  try {
    const info = await handle.stat();
    if (info.size > STATE_LIMIT) throw stateTooLarge();
    const buffer = Buffer.alloc(Math.min(info.size + 1, STATE_LIMIT + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > STATE_LIMIT) throw stateTooLarge();
    try { return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")); }
    catch { throw new Error("Invalid Claude collector state"); }
  } finally { await handle.close(); }
}
const TERMINAL = new Set(["completed", "failed", "interrupted", "unknown"]);
const PRIORITY = { needs_input: 0, failed: 1, running: 2, queued: 3, submitted: 4, interrupted: 5, completed: 6, unknown: 7 };
const SESSION_PRIORITY = { needs_input: 0, blocked: 1, ready: 2, running: 3, unknown: 4, idle: 5 };
const HOOKS = new Set(["SessionStart", "UserPromptSubmit", "PermissionRequest", "Notification", "PostToolUse", "Stop", "StopFailure", "SessionEnd", "TranscriptResponse"]);
const HOOK_ORDER = { SessionStart: 0, UserPromptSubmit: 1, PermissionRequest: 2, Notification: 2, PostToolUse: 3, Stop: 4, StopFailure: 5, SessionEnd: 6 };
const execution = (status) => ({ running: "in_progress", needs_input: "waiting_input" }[status] || status);
const time = (value) => Date.parse(value) || 0;
const copy = (value) => value == null ? null : structuredClone(value);
const promptHash = event => event.agent_pet_source === "transcript" && /^[a-f0-9]{64}$/.test(event.prompt_hash || "")
  ? event.prompt_hash : createHash("sha256").update(event.prompt || "").digest("hex");
function validate(input) {
  const text = typeof input === "string" ? input : JSON.stringify(input);
  if (!text || Buffer.byteLength(text) > LIMIT) throw new Error("Hook event exceeds 1 MiB or is empty");
  const event = JSON.parse(text);
  if (!event || Array.isArray(event) || typeof event.session_id !== "string" || !event.session_id.trim()) throw new Error("Hook event requires session_id");
  if (event.prompt_id != null && (typeof event.prompt_id !== "string" || !event.prompt_id.trim())) throw new Error("Invalid prompt_id");
  return event;
}
function publicSession(session, tasks) {
  const { _counter, _latest, _owned, _activity, _prompt, _pendingTranscript, _transcriptTurns, _hookTurns, _hookLatest, _releasedAt, ...snapshot } = session;
  const turn = tasks.get(`claude:${session.nativeSessionId}:${_latest}`);
  const publicTurn = turn ? { turnId: turn.turnId, executionStatus: execution(turn.status), phase: turn.phase,
    submittedAt: turn.submittedAt, startedAt: turn.startedAt, completedAt: turn.completedAt, lastActivityAt: turn.lastActivityAt, error: turn.error } : null;
  return copy({ ...snapshot, activeTurn: turn && !TERMINAL.has(turn.status) ? publicTurn : null, lastTurn: publicTurn });
}
function createSession(event, timestamp) {
  const sessionId = `claude:${event.session_id}`, cwd = typeof event.cwd === "string" ? event.cwd : "";
  const client = String(event.client || event.client_name || event.source || "").toLowerCase();
  const known = ["vscode", "vs_code", "claude-vscode"].includes(client) ? "vscode" : client === "cli" ? "cli" : "";
  return { sessionId, nativeSessionId: event.session_id, providerId: "claude", sessionKey: sessionId, rootSessionId: sessionId,
    sourceKind: known ? `claude-${known}` : "claude", sourceLabel: `Claude Code${known === "vscode" ? " VS Code" : known === "cli" ? " CLI" : ""}`,
    sourceConfidence: known ? "high" : "unknown", sourceRaw: { client: known || null }, cwd,
    projectName: cwd ? path.basename(cwd.replace(/\\/g, "/")) : "未知项目", projectKind: "project",
    projectKey: cwd ? path.resolve(cwd).replace(/\\/g, "/").toLowerCase() : "", threadSource: "user", parentSessionId: null,
    title: "未命名会话", latestUserText: "", latestAssistantText: "", createdAt: timestamp, updatedAt: timestamp,
    status: { petStatus: "idle", executionStatus: "unknown", phase: "unknown", waitingFor: null, unread: false, confidence: "high", lastActivityAt: timestamp },
    _counter: 0, _latest: null, _owned: event.hook_event_name !== "SessionEnd", _activity: timestamp };
}

export class ClaudeActivityCollector extends EventEmitter {
  constructor({ eventsDir, statePath, transcriptsDir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects"), ignoredProjectPaths = [], pollIntervalMs = 750, now = Date.now } = {}) {
    super();
    if (!eventsDir) throw new Error("eventsDir is required");
    this.eventsDir = path.resolve(eventsDir);
    this.transcriptsDir = path.resolve(transcriptsDir);
    this.statePath = statePath === null ? null : path.resolve(statePath || path.join(this.eventsDir, "..", "claude-collector-state.json"));
    this.pollIntervalMs = pollIntervalMs; this.now = now;
    this.discovery = new ClaudeTranscriptDiscovery({ transcriptsDir: this.transcriptsDir, ignoredProjectPaths, now });
    this.sessions = new Map(); this.tasks = new Map(); this.visibleTaskIds = new Set(); this.seen = new Set();
    this.loaded = false; this.revision = 0; this.savedRevision = 0; this.timer = null;
    this.pending = Promise.resolve(); this.taskDigests = new Map(); this.sessionDigests = new Map(); this.publishedVisible = new Set();
  }
  #diagnostic(error) { this.emit("diagnostic", { level: "error", message: error.message, error, providerId: "claude" }); }
  #enqueue(operation) {
    const result = this.pending.then(async () => { await this.#load(); return operation(); });
    this.pending = result.catch((error) => { this.#diagnostic(error); });
    return result;
  }
  async #load() {
    if (this.loaded) return;
    let data;
    try { if (this.statePath) data = await readState(this.statePath); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (data !== undefined) {
      if (!data || data.version !== 1 || ![data.sessions, data.tasks, data.visibleTaskIds, data.eventIds].every(Array.isArray)) throw new Error("Invalid Claude collector state");
      this.sessions = new Map(data.sessions.map((session) => [session.sessionId, session]));
      this.tasks = new Map(data.tasks.map((task) => [task.taskId, task]));
      this.visibleTaskIds = new Set(data.visibleTaskIds); this.seen = new Set(data.eventIds.slice(-SEEN_LIMIT));
      this.discovery.restore(data.transcriptFiles);
      this.#publish(false);
      for (const session of this.sessions.values()) if (session._owned) this.#ownershipWarning(session.sessionId);
    }
    this.loaded = true;
  }
  #ownershipWarning(sessionId) {
    this.emit("diagnostic", { level: "warn", providerId: "claude", sessionId, code: "claude_ownership_unconfirmed",
      message: "Claude ownership is unconfirmed; resume remains blocked until an explicit SessionEnd. No lease expiry or process termination is inferred." });
  }
  #stateData() {
    return JSON.stringify({ version: 1, sessions: [...this.sessions.values()], tasks: [...this.tasks.values()],
      visibleTaskIds: [...this.visibleTaskIds], eventIds: [...this.seen], transcriptFiles: this.discovery.snapshot() });
  }
  #boundedState() {
    let data = this.#stateData();
    if (Buffer.byteLength(data) <= STATE_LIMIT / 2) return data;
    // Discovery can encounter a large recent history at once. Keep durable IDs
    // and cursors, but retain bounded previews rather than duplicate full logs.
    const discovered = [...this.tasks.values()].filter(task => task.evidenceSource === "transcript")
      .sort((a, b) => time(a.lastActivityAt) - time(b.lastActivityAt));
    const preview = value => typeof value === "string" && value.length > 2048 ? `${value.slice(0, 2048)}…` : value;
    for (const task of discovered) {
      task.question = preview(task.question); task.latestResponse = preview(task.latestResponse); task.textTruncated = true;
      const session = this.sessions.get(task.sessionId);
      if (session?._latest === task.turnId) {
        session.latestUserText = preview(session.latestUserText); session.latestAssistantText = preview(session.latestAssistantText);
        session._prompt = preview(session._prompt);
      }
    }
    data = this.#stateData();
    // If previews alone are insufficient, age out oldest terminal discovery
    // records. Unknown ownership stays conservative when a session is absent.
    const terminal = discovered.filter(task => TERMINAL.has(task.status));
    while (Buffer.byteLength(data) > STATE_LIMIT * 0.75 && terminal.length) {
      for (const task of terminal.splice(0, 64)) {
        this.tasks.delete(task.taskId); this.visibleTaskIds.delete(task.taskId); this.taskDigests.delete(task.taskId);
        if (![...this.tasks.values()].some(value => value.sessionId === task.sessionId)) {
          this.sessions.delete(task.sessionId); this.sessionDigests.delete(task.sessionId);
        }
      }
      data = this.#stateData();
    }
    return data;
  }
  // markRead is a synchronous HTTP contract. All state writes are synchronous
  // atomic replacements, so an older queued write cannot overwrite a read ack.
  #persist() {
    while (this.savedRevision !== this.revision) {
      const revision = this.revision;
      if (this.statePath) {
        mkdirSync(path.dirname(this.statePath), { recursive: true });
        const temporary = `${this.statePath}.${randomUUID()}.tmp`;
        try {
          const data = this.#boundedState();
          if (Buffer.byteLength(data) > STATE_LIMIT) throw stateTooLarge();
          writeFileSync(temporary, data, { flag: "wx", mode: 0o600 });
          renameSync(temporary, this.statePath);
        } catch (error) {
          try { rmSync(temporary, { force: true }); } catch (cleanupError) { this.#diagnostic(cleanupError); }
          throw error;
        }
      }
      this.savedRevision = revision;
    }
    this.#publish();
  }
  #publish(emit = true) {
    for (const id of this.publishedVisible) if (!this.visibleTaskIds.has(id) && emit) this.emit("task.removed", { taskId: id, sessionId: this.tasks.get(id)?.sessionId });
    for (const task of this.tasks.values()) {
      const digest = JSON.stringify(task), previous = this.taskDigests.get(task.taskId);
      this.taskDigests.set(task.taskId, digest);
      if (emit && previous !== digest && this.visibleTaskIds.has(task.taskId)) this.emit(previous === undefined ? "task.created" : "task.updated", copy(task));
    }
    this.publishedVisible = new Set(this.visibleTaskIds);
    for (const session of this.sessions.values()) {
      const snapshot = publicSession(session, this.tasks), digest = JSON.stringify(snapshot), previous = this.sessionDigests.get(session.sessionId);
      this.sessionDigests.set(session.sessionId, digest);
      if (emit && previous !== digest) this.emit("session.updated", snapshot);
    }
  }
  start() {
    return this.#enqueue(async () => {
      await this.#scan();
      if (!this.timer) { this.timer = setInterval(() => { this.scanOnce().catch(() => {}); }, this.pollIntervalMs); this.timer.unref?.(); }
    });
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return this.#enqueue(async () => { if (this.timer) clearInterval(this.timer); this.timer = null; await this.#persist(); });
  }
  scanOnce() { return this.#enqueue(() => this.#scan()); }
  async #scan() {
    await mkdir(this.eventsDir, { recursive: true });
    const root = await realpath(this.eventsDir), records = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.name.endsWith(".json")) continue;
      const file = path.join(root, entry.name);
      if (path.resolve(file) === this.statePath) continue;
      try {
        const info = await lstat(file);
        if (!info.isFile() || info.isSymbolicLink() || path.dirname(await realpath(file)) !== root) throw new Error("Event path escapes inbox or is not a regular file");
        if (info.size > LIMIT) throw new Error("Hook event exceeds 1 MiB");
        const handle = await open(file, "r");
        let buffer;
        try { buffer = Buffer.alloc(LIMIT + 1); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); buffer = buffer.subarray(0, bytesRead); }
        finally { await handle.close(); }
        const event = validate(buffer.toString("utf8"));
        event.timestamp = new Date(event.timestamp ?? this.now()).toISOString();
        records.push({ file, event });
      } catch (error) {
        this.#diagnostic(error);
        // Invalid input is discarded, but unreadable files are retained for retry.
        if (!error.code) { try { await rm(file, { force: true }); } catch (cleanupError) { this.#diagnostic(cleanupError); } }
      }
    }
    records.sort((a, b) => time(a.event.timestamp) - time(b.event.timestamp)
      || (HOOK_ORDER[a.event.hook_event_name] ?? 99) - (HOOK_ORDER[b.event.hook_event_name] ?? 99));
    for (const { file, event } of records) {
      try { await this.#accept(event); await rm(file, { force: true }); }
      catch (error) { this.#diagnostic(error); }
    }
    try {
      const batch = await this.discovery.scan();
      for (const event of batch.events) await this.#accept(event);
      if (JSON.stringify(batch.state) !== JSON.stringify(this.discovery.snapshot())) {
        this.discovery.commit(batch.state);
        this.revision++;
      }
    } catch (error) {
      this.#diagnostic(Object.assign(new Error("Claude automatic discovery failed"), { code: "claude_discovery_failed" }));
    }
    await this.#supplementResponses();
    try { await this.#persist(); } catch (error) { this.#diagnostic(error); }
  }
  async #supplementResponses() {
    for (const session of this.sessions.values()) {
      const pending = session._pendingTranscript;
      if (!pending) continue;
      const task = this.tasks.get(pending.taskId);
      if (!task || task.turnId !== session._latest || task.status !== "completed" || task.latestResponse) continue;
      try {
        const text = await readStoppedTurnText({ transcriptsDir: this.transcriptsDir, transcriptPath: pending.path,
          sessionId: session.nativeSessionId, prompt: session._prompt, submittedAt: task.submittedAt, completedAt: task.completedAt });
        if (!text) continue;
        task.latestResponse = text; session.latestAssistantText = text;
        delete session._pendingTranscript;
        this.revision++;
      } catch (error) { this.#diagnostic(error); }
    }
  }
  ingest(input) { return this.#enqueue(() => this.#accept(validate(input))); }
  async #accept(event) {
    if (event.event_id && this.seen.has(event.event_id)) { await this.#persist(); return false; }
    if (event.agent_id || event.agent_pet_auxiliary === true || event.AGENT_PET_AUXILIARY === "1" || event.metadata?.agent_pet_auxiliary === true) return false;
    const hook = event.hook_event_name;
    if (!HOOKS.has(hook) || (hook === "Notification" && !["permission_prompt", "elicitation_dialog"].includes(event.notification_type))) return false;
    const timestamp = new Date(event.timestamp ?? this.now()).toISOString();
    let session = this.sessions.get(`claude:${event.session_id}`);
    if (!session) { session = createSession(event, timestamp); this.sessions.set(session.sessionId, session); }
    event = this.#correlate(session, event);
    this.#apply(session, event, timestamp);
    if (event.event_id) this.seen.add(event.event_id);
    while (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value);
    this.revision++;
    await this.#persist();
    return true;
  }
  #correlate(session, event) {
    const transcript = event.agent_pet_source === "transcript";
    const aliases = transcript ? (session._transcriptTurns ||= []) : (session._hookTurns ||= []);
    const alias = event.prompt_id && aliases.find(([id]) => id === event.prompt_id);
    if (alias) return { ...event, prompt_id: alias[1] };
    if (event.hook_event_name !== "UserPromptSubmit") {
      if (!transcript && !event.prompt_id && session._latest && event.hook_event_name !== "SessionEnd") {
        const latest = this.tasks.get(`claude:${session.nativeSessionId}:${session._latest}`);
        return { ...event, prompt_id: session._hookLatest || (latest?.evidenceSource !== "transcript" ? session._latest : "unmatched-hook-turn") };
      }
      return event;
    }
    const question = parseRemoteRequest(event.prompt || "")?.request || event.prompt || "";
    const digest = promptHash(event);
    const candidates = [...this.tasks.values()].filter(task => task.sessionId === session.sessionId && (task.promptHash ? task.promptHash === digest : task.question === question)
      && Math.abs(time(task.submittedAt) - time(event.timestamp)) <= 10_000
      && (transcript ? task.evidenceSource !== "transcript" && !task.transcriptTurnId : task.evidenceSource === "transcript" && !task.hookObserved))
      .sort((a, b) => Math.abs(time(a.submittedAt) - time(event.timestamp)) - Math.abs(time(b.submittedAt) - time(event.timestamp)));
    const task = candidates[0];
    if (!task || (candidates[1] && Math.abs(time(task.submittedAt) - time(event.timestamp)) === Math.abs(time(candidates[1].submittedAt) - time(event.timestamp)))) return event;
    if (transcript) task.transcriptTurnId = event.prompt_id;
    else { task.hookObserved = true; session._hookLatest = task.turnId; }
    if (event.prompt_id) aliases.push([event.prompt_id, task.turnId]);
    return { ...event, prompt_id: task.turnId };
  }
  #apply(session, event, timestamp) {
    const hook = event.hook_event_name, prefix = `claude:${session.nativeSessionId}:`;
    const backfill = event.agent_pet_source === "transcript" && hook === "UserPromptSubmit" && !session._latest;
    if (time(timestamp) < time(session._activity) && !backfill) return;
    if (hook === "SessionStart") { session._owned = true; session._activity = timestamp; session.updatedAt = timestamp; return; }
    let id = event.prompt_id || session._latest, task = this.tasks.get(prefix + id);
    if (hook === "UserPromptSubmit") {
      if (event.prompt_id && task) return;
      if (!event.prompt_id) { do { id = `turn-${++session._counter}`; } while (this.tasks.has(prefix + id)); }
      const remote = parseRemoteRequest(event.prompt || ""), question = remote?.request || event.prompt || "";
      task = { ...publicSession(session, this.tasks), taskId: prefix + id, turnId: id, title: question ? makeTitle(question) : "未命名任务", question,
        requestOrigin: remote?.origin || "", latestResponse: "", status: "running", canAcknowledge: false, phase: "thinking", waitingFor: null,
        submittedAt: timestamp, startedAt: timestamp, completedAt: null, lastActivityAt: timestamp, error: null,
        evidenceSource: event.agent_pet_source === "transcript" ? "transcript" : "hook", hookObserved: event.agent_pet_source !== "transcript", promptHash: promptHash(event) };
      for (const key of ["sessionKey", "status", "activeTurn", "lastTurn", "createdAt", "updatedAt", "latestUserText", "latestAssistantText"]) if (key !== "status") delete task[key];
      const previous = this.tasks.get(prefix + session._latest);
      if (previous && !TERMINAL.has(previous.status)) Object.assign(previous, { status: "unknown", canAcknowledge: true, phase: "unknown", waitingFor: null });
      if (String(question).trim()) for (const older of this.tasks.values()) if (older.sessionId === session.sessionId && TERMINAL.has(older.status)) this.visibleTaskIds.delete(older.taskId);
      this.tasks.set(task.taskId, task); this.visibleTaskIds.add(task.taskId);
      const releasedAt = session._releasedAt || (backfill && session._owned === false ? session._activity : null);
      session._latest = id; session._owned = !(releasedAt && time(releasedAt) >= time(timestamp)); session.latestUserText = question; session.title = task.title;
      if (releasedAt) session._releasedAt = releasedAt;
      if (event.agent_pet_source !== "transcript") session._hookLatest = id;
      session._prompt = event.prompt || ""; delete session._pendingTranscript;
    } else {
      if (event.prompt_id && event.prompt_id !== session._latest) return;
      if (hook === "SessionEnd") { session._owned = false; session._releasedAt = timestamp; }
      const unresolvedTranscript = task?.status === "unknown" && task.evidenceSource === "transcript" && task.turnId === session._latest;
      if (!task || (TERMINAL.has(task.status) && !unresolvedTranscript)) { session._activity = timestamp; session.updatedAt = timestamp; return; }
      if (hook === "TranscriptResponse") {
        // A text message without end_turn is not proof the turn finished.
        if (task.hookObserved) return;
        Object.assign(task, { status: "unknown", phase: "unknown", completionPending: true, canAcknowledge: true, waitingFor: null, latestResponse: event.last_assistant_message || "" });
      } else if (hook === "PermissionRequest" || hook === "Notification") {
        Object.assign(task, { status: "needs_input", phase: event.notification_type === "elicitation_dialog" ? "waiting_answer" : "waiting_approval", waitingFor: "user" });
      } else if (hook === "PostToolUse") Object.assign(task, { status: "running", phase: "working", waitingFor: null, canAcknowledge: false });
      else if (["Stop", "StopFailure", "SessionEnd"].includes(hook)) {
        Object.assign(task, { status: hook === "Stop" ? "completed" : hook === "StopFailure" ? "failed" : "interrupted", phase: hook === "Stop" ? "finished" : hook === "StopFailure" ? "failed" : "interrupted",
          completionPending: false, waitingFor: null, completedAt: timestamp, canAcknowledge: true, error: event.error || null });
        if (typeof event.last_assistant_message === "string") task.latestResponse = event.last_assistant_message;
        if (hook === "Stop" && !task.latestResponse && typeof event.transcript_path === "string") {
          session._pendingTranscript = { taskId: task.taskId, path: event.transcript_path };
        }
      }
    }
    task.lastActivityAt = timestamp;
    session.latestAssistantText = task.latestResponse;
    session._activity = timestamp; session.updatedAt = timestamp;
    session.status = { petStatus: task.status === "completed" ? "ready" : task.status === "failed" ? "blocked" : task.status,
      executionStatus: execution(task.status), phase: task.phase, waitingFor: task.waitingFor, unread: task.status !== "running", confidence: task.status === "unknown" ? "low" : "high", lastActivityAt: timestamp };
  }
  getTasks({ scope = "current" } = {}) {
    return [...this.tasks.values()].filter((task) => scope === "all" || (scope === "active" ? !TERMINAL.has(task.status) : this.visibleTaskIds.has(task.taskId)))
      .sort((a, b) => (PRIORITY[a.status] ?? 99) - (PRIORITY[b.status] ?? 99) || time(b.lastActivityAt || b.submittedAt) - time(a.lastActivityAt || a.submittedAt)).map(copy);
  }
  getTask(taskId) { return copy(this.tasks.get(String(taskId))); }
  getSessions() {
    return [...this.sessions.values()].sort((a, b) => (SESSION_PRIORITY[a.status.petStatus] ?? 99) - (SESSION_PRIORITY[b.status.petStatus] ?? 99)
      || time(b.status.lastActivityAt || b.updatedAt) - time(a.status.lastActivityAt || a.updatedAt)).map((session) => publicSession(session, this.tasks));
  }
  getSession(sessionId) { const session = this.sessions.get(String(sessionId)); return session ? publicSession(session, this.tasks) : null; }
  isSessionActive(sessionId) {
    const id = String(sessionId), key = id.startsWith("claude:") ? id : `claude:${id}`;
    const session = this.sessions.get(key);
    if (!this.loaded || !session) { this.#ownershipWarning(key); return true; }
    return session._owned !== false;
  }
  dismissTask(taskId) {
    return this.#enqueue(async () => {
      const task = this.getTask(taskId);
      if (!task || !this.visibleTaskIds.has(task.taskId)) return { ok: false, reason: "visible_task_not_found" };
      if (!TERMINAL.has(task.status)) return { ok: false, reason: "task_not_terminal", task };
      const result = await this.#dismiss([task]);
      const { tasks, ...rest } = result;
      return { ...rest, task };
    });
  }
  dismissAllTasks() { return this.#enqueue(() => this.#dismiss(this.getTasks().filter((task) => TERMINAL.has(task.status)))); }
  async #dismiss(tasks) {
    if (!tasks.length) return { ok: true, tasks };
    for (const task of tasks) this.visibleTaskIds.delete(task.taskId);
    this.revision++;
    try { await this.#persist(); }
    catch (error) {
      for (const task of tasks) this.visibleTaskIds.add(task.taskId);
      this.revision++; this.#diagnostic(error);
      return { ok: false, reason: "state_persist_failed", tasks, error };
    }
    return { ok: true, tasks };
  }
  markRead(sessionId) {
    const session = this.sessions.get(String(sessionId));
    if (!session) return null;
    const previousStatus = { ...session.status }, previousUpdatedAt = session.updatedAt;
    session.status.unread = false;
    if (["ready", "blocked"].includes(session.status.petStatus)) session.status.petStatus = "idle";
    session.updatedAt = new Date(this.now()).toISOString(); this.revision++;
    try { this.#persist(); }
    catch {
      session.status = previousStatus; session.updatedAt = previousUpdatedAt; this.revision++;
      const error = Object.assign(new Error("Claude state persistence failed"), { code: "state_persist_failed" });
      this.#diagnostic(error);
      throw error;
    }
    return publicSession(session, this.tasks);
  }
}

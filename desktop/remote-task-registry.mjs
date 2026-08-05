import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

const REGISTRY_VERSION = 3;
const MAX_DELIVERIES = 1_000;
const MAX_PROCESSED_MESSAGES = 2_000;

function clean(value, limit = 500) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function normalizedProjectKey(value, cwd, name) {
  const explicit = clean(value, 2_000);
  if (explicit) return explicit.replace(/\\/g, "/").toLowerCase();
  const directory = clean(cwd, 2_000);
  if (directory) return path.resolve(directory).replace(/\\/g, "/").toLowerCase();
  const label = clean(name, 100).toLowerCase();
  return label ? `name:${label}` : "";
}

function normalizedProjectKind(value) {
  return value === "projectless" ? "projectless" : "project";
}

function positiveInteger(value, fallback = 1) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function formatCode(prefix, value, width) {
  return `${prefix}${String(positiveInteger(value)).padStart(width, "0")}`;
}

function normalizeChannelId(value, fallback = "") {
  return clean(value || fallback, 80).toLowerCase();
}

function hashMessageKey(value) {
  const normalized = clean(value, 200);
  if (!normalized) return "";
  if (/^sha256:[a-f0-9]{64}$/i.test(normalized)) return normalized.toLowerCase();
  return `sha256:${createHash("sha256").update(normalized).digest("hex")}`;
}

function normalizeDelivery(item, storedVersion) {
  if (!item || (!item.notificationId && !item.remoteMessageId)) return null;
  const legacyChannel = storedVersion < 2 ? "weixin" : "";
  return {
    notificationId: clean(item.notificationId, 200),
    channelId: normalizeChannelId(item.channelId || item.channel, legacyChannel),
    accountId: clean(item.accountId, 200),
    conversationId: clean(item.conversationId, 300),
    remoteMessageId: clean(item.remoteMessageId, 200),
    taskId: clean(item.taskId, 300),
    projectCode: normalizeProjectCode(item.projectCode),
    sessionCode: normalizeSessionCode(item.sessionCode),
    sentAt: clean(item.sentAt, 50),
  };
}

function normalizeStored(value = {}) {
  const storedVersion = Number.isSafeInteger(Number(value.version))
    ? Number(value.version)
    : 1;
  const projects = Array.isArray(value.projects) ? value.projects : [];
  const sessions = Array.isArray(value.sessions) ? value.sessions : [];
  const deliveries = Array.isArray(value.deliveries) ? value.deliveries : [];
  const processedMessages = Array.isArray(value.processedMessages) ? value.processedMessages : [];
  const maxCode = (items, prefix) => items.reduce((maximum, item) => {
    const match = String(item?.code || "").match(new RegExp(`^${prefix}0*(\\d+)$`, "i"));
    return match ? Math.max(maximum, Number(match[1]) || 0) : maximum;
  }, 0);
  let nextSessionNumber = Math.max(
    positiveInteger(value.nextSessionNumber),
    maxCode(sessions, "[CS]") + 1,
  );
  const usedSessionCodes = new Set();
  const usedSessionIds = new Set();
  const sessionRouteMap = new Map();
  const ambiguousSessionRoutes = new Set();
  const normalizedSessions = [];
  for (const item of sessions) {
    const sessionId = clean(item?.sessionId, 200);
    const projectCode = normalizeProjectCode(item?.projectCode);
    if (!item || !sessionId || !projectCode || usedSessionIds.has(sessionId)) continue;
    const originalCode = normalizeSessionCode(item.code);
    let code = originalCode;
    if (!code || usedSessionCodes.has(code)) {
      do {
        code = formatCode("S", nextSessionNumber, 4);
        nextSessionNumber += 1;
      } while (usedSessionCodes.has(code));
    }
    usedSessionCodes.add(code);
    usedSessionIds.add(sessionId);
    if (originalCode) {
      const routeKey = `${projectCode}\u0000${originalCode}`;
      if (sessionRouteMap.has(routeKey)) ambiguousSessionRoutes.add(routeKey);
      else sessionRouteMap.set(routeKey, code);
    }
    normalizedSessions.push({ ...item, sessionId, projectCode, code });
  }
  const normalizedDeliveries = deliveries
    .map((item) => normalizeDelivery(item, storedVersion))
    .filter(Boolean)
    .map((item) => {
      const routeKey = `${item.projectCode}\u0000${item.sessionCode}`;
      return {
        ...item,
        // Corrupt legacy data can contain the same code twice in one project.
        // Do not guess which session a historical notification referred to.
        sessionCode: ambiguousSessionRoutes.has(routeKey)
          ? ""
          : (sessionRouteMap.get(routeKey) || item.sessionCode),
      };
    })
    .slice(-MAX_DELIVERIES);
  return {
    version: REGISTRY_VERSION,
    nextProjectNumber: Math.max(positiveInteger(value.nextProjectNumber), maxCode(projects, "P") + 1),
    nextSessionNumber,
    projects: projects.filter((item) => item && item.projectKey && item.code),
    sessions: normalizedSessions,
    deliveries: normalizedDeliveries,
    processedMessages: processedMessages.map((item) => ({
      key: hashMessageKey(item?.key),
      receivedAt: clean(item?.receivedAt, 50),
    })).filter((item) => item.key)
      .slice(-MAX_PROCESSED_MESSAGES),
  };
}

export function normalizeProjectCode(value) {
  const match = String(value || "").trim().match(/^P0*(\d{1,6})$/i);
  const number = Number(match?.[1]);
  return match && Number.isSafeInteger(number) && number > 0
    ? formatCode("P", number, 3)
    : "";
}

export function normalizeSessionCode(value) {
  const match = String(value || "").trim().match(/^[SC]0*(\d{1,8})$/i);
  const number = Number(match?.[1]);
  return match && Number.isSafeInteger(number) && number > 0
    ? formatCode("S", number, 4)
    : "";
}

export class RemoteTaskRegistry {
  constructor(filePath, options = {}) {
    if (!filePath) throw new TypeError("RemoteTaskRegistry requires a file path");
    this.filePath = path.resolve(filePath);
    this.now = options.now || (() => new Date());
    this.logger = options.logger || console;
    this.state = normalizeStored();
    this.loaded = false;
    this.writeQueue = Promise.resolve();
  }

  async load() {
    let requiresMigration = false;
    try {
      const stored = JSON.parse(await readFile(this.filePath, "utf8"));
      this.state = normalizeStored(stored);
      const persisted = {
        version: stored?.version,
        nextProjectNumber: stored?.nextProjectNumber,
        nextSessionNumber: stored?.nextSessionNumber,
        projects: stored?.projects,
        sessions: stored?.sessions,
        deliveries: stored?.deliveries,
        processedMessages: stored?.processedMessages,
      };
      requiresMigration = Number(stored?.version || 1) <= REGISTRY_VERSION
        && !isDeepStrictEqual(this.state, persisted);
    } catch (error) {
      if (error?.code !== "ENOENT" && error instanceof SyntaxError === false) {
        this.logger.warn?.("[remote-control] unable to load task registry", error);
      }
      this.state = normalizeStored();
    }
    this.loaded = true;
    if (requiresMigration) await this.#save();
    return this.snapshot();
  }

  snapshot() {
    return structuredClone(this.state);
  }

  listProjects() {
    return structuredClone(this.state.projects)
      .filter((item) => normalizedProjectKind(item.kind) !== "projectless")
      .sort((left, right) => left.code.localeCompare(right.code));
  }

  listSessions(projectCode = "") {
    const normalized = normalizeProjectCode(projectCode);
    return structuredClone(this.state.sessions)
      .filter((item) => !normalized || item.projectCode === normalized)
      .sort((left, right) => Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0));
  }

  async observeSnapshot(value = {}) {
    let changed = false;
    for (const session of Array.isArray(value.sessions) ? value.sessions : []) {
      changed = this.#observeSession(session) || changed;
    }
    for (const task of Array.isArray(value.tasks) ? value.tasks : []) {
      changed = this.#observeTask(task) || changed;
    }
    if (changed) await this.#save();
    return this.snapshot();
  }

  async observeSession(session = {}) {
    const changed = this.#observeSession(session);
    if (changed) await this.#save();
    return this.resolveSessionById(session.sessionId);
  }

  async observeTask(task = {}) {
    const changed = this.#observeTask(task);
    if (changed) await this.#save();
    return this.routeForTask(task);
  }

  #observeProject(value = {}) {
    const projectKey = normalizedProjectKey(value.projectKey, value.cwd, value.projectName);
    if (!projectKey) return { project: null, changed: false };
    const kind = normalizedProjectKind(value.projectKind);
    const now = this.now().toISOString();
    let project = this.state.projects.find((item) => item.projectKey === projectKey);
    if (!project) {
      project = {
        code: formatCode("P", this.state.nextProjectNumber, 3),
        projectKey,
        name: clean(value.projectName, 100) || path.basename(clean(value.cwd, 2_000)) || "未命名项目",
        kind,
        cwd: clean(value.cwd, 2_000),
        createdAt: now,
        updatedAt: now,
      };
      this.state.nextProjectNumber += 1;
      this.state.projects.push(project);
      return { project, changed: true };
    }
    const nextName = clean(value.projectName, 100) || project.name;
    const nextCwd = clean(value.cwd, 2_000) || project.cwd;
    if (nextName === project.name && nextCwd === project.cwd && kind === project.kind) {
      return { project, changed: false };
    }
    Object.assign(project, { name: nextName, kind, cwd: nextCwd, updatedAt: now });
    return { project, changed: true };
  }

  #observeSession(session = {}) {
    const sessionId = clean(session.sessionId, 200);
    if (!sessionId || session.threadSource === "subagent") return false;
    const projectResult = this.#observeProject(session);
    if (!projectResult.project) return projectResult.changed;
    const now = this.now().toISOString();
    let record = this.state.sessions.find((item) => item.sessionId === sessionId);
    const next = {
      projectCode: projectResult.project.code,
      projectKey: projectResult.project.projectKey,
      projectName: projectResult.project.name,
      projectKind: projectResult.project.kind,
      cwd: clean(session.cwd, 2_000) || projectResult.project.cwd,
      title: clean(session.title || session.latestUserText, 160) || "未命名会话",
      status: clean(session.status?.execution || session.status?.state, 40),
      updatedAt: clean(session.updatedAt, 50) || now,
    };
    if (!record) {
      record = {
        code: formatCode("S", this.state.nextSessionNumber, 4),
        sessionId,
        ...next,
        createdAt: clean(session.createdAt, 50) || now,
      };
      this.state.nextSessionNumber += 1;
      this.state.sessions.push(record);
      return true;
    }
    const changed = Object.entries(next).some(([key, value]) => record[key] !== value);
    if (changed) Object.assign(record, next);
    return projectResult.changed || changed;
  }

  #observeTask(task = {}) {
    if (!task?.sessionId || task.threadSource === "subagent") return false;
    const changed = this.#observeSession({
      sessionId: task.sessionId,
      projectKey: task.projectKey,
      projectName: task.projectName,
      projectKind: task.projectKind,
      cwd: task.cwd,
      title: task.title || task.question,
      updatedAt: task.lastActivityAt,
    });
    const session = this.state.sessions.find((item) => item.sessionId === String(task.sessionId));
    if (!session) return changed;
    const nextTaskId = clean(task.taskId, 300);
    const nextStatus = clean(task.status, 40);
    const nextTitle = clean(task.title || task.question, 160) || session.title;
    const nextUpdatedAt = clean(task.lastActivityAt, 50) || this.now().toISOString();
    const taskChanged = session.taskId !== nextTaskId
      || session.status !== nextStatus
      || session.title !== nextTitle
      || session.updatedAt !== nextUpdatedAt;
    if (taskChanged) {
      Object.assign(session, {
        taskId: nextTaskId,
        status: nextStatus,
        title: nextTitle,
        updatedAt: nextUpdatedAt,
      });
    }
    return changed || taskChanged;
  }

  async registerRemoteSession(value = {}) {
    const sessionId = clean(value.sessionId, 200);
    if (!sessionId) throw new TypeError("Remote session requires sessionId");
    const changed = this.#observeSession({
      ...value,
      sessionId,
      title: value.title || value.prompt,
      updatedAt: this.now().toISOString(),
    });
    if (changed) await this.#save();
    return this.resolveSessionById(sessionId);
  }

  routeForTask(task = {}) {
    const session = this.resolveSessionById(task.sessionId);
    if (!session) return null;
    return {
      projectCode: session.projectCode,
      sessionCode: session.code,
      projectKey: session.projectKey,
      sessionId: session.sessionId,
      taskId: clean(task.taskId, 300) || session.taskId || "",
      cwd: session.cwd,
      projectName: session.projectName,
      projectKind: session.projectKind,
      sessionTitle: session.title,
    };
  }

  resolveProject(code) {
    const normalized = normalizeProjectCode(code);
    const project = this.state.projects.find((item) => item.code === normalized);
    return project ? structuredClone(project) : null;
  }

  resolveSession(code) {
    const normalized = normalizeSessionCode(code);
    const session = this.state.sessions.find((item) => item.code === normalized);
    return session ? structuredClone(session) : null;
  }

  resolveSessionById(sessionId) {
    const session = this.state.sessions.find((item) => item.sessionId === String(sessionId || ""));
    return session ? structuredClone(session) : null;
  }

  resolveRoute(projectCode, sessionCode = "") {
    const project = this.resolveProject(projectCode);
    if (!project) return null;
    if (!sessionCode) return { project, session: null };
    const session = this.resolveSession(sessionCode);
    if (!session || session.projectCode !== project.code) return null;
    return { project, session };
  }

  async recordDelivery(value = {}) {
    const notificationId = clean(value.notificationId, 200);
    const remoteMessageId = clean(value.remoteMessageId, 200);
    if (!notificationId && !remoteMessageId) return null;
    const record = {
      notificationId,
      channelId: normalizeChannelId(value.channelId || value.channel, "weixin"),
      accountId: clean(value.accountId, 200),
      conversationId: clean(value.conversationId, 300),
      remoteMessageId,
      taskId: clean(value.taskId, 300),
      projectCode: normalizeProjectCode(value.projectCode),
      sessionCode: normalizeSessionCode(value.sessionCode),
      sentAt: clean(value.sentAt, 50) || this.now().toISOString(),
    };
    this.state.deliveries.push(record);
    this.state.deliveries = this.state.deliveries.slice(-MAX_DELIVERIES);
    await this.#save();
    return structuredClone(record);
  }

  findDelivery(value = {}) {
    const remoteMessageId = clean(
      value.remoteMessageId || value.referencedMessageId || value.messageId,
      200,
    );
    const notificationId = clean(value.notificationId, 200);
    if (!remoteMessageId && !notificationId) return null;

    const requestedChannel = normalizeChannelId(value.channelId || value.channel);
    const requestedAccount = clean(value.accountId, 200);
    const requestedConversation = clean(value.conversationId, 300);
    const candidates = [...this.state.deliveries].reverse().filter((item) => (
      (!remoteMessageId || item.remoteMessageId === remoteMessageId)
      && (!notificationId || item.notificationId === notificationId)
      && (!requestedChannel || item.channelId === requestedChannel)
    ));
    if (!candidates.length) return null;

    const exact = candidates.filter((item) => (
      (!requestedAccount || item.accountId === requestedAccount)
      && (!requestedConversation || item.conversationId === requestedConversation)
    ));
    if (exact.length) {
      if (requestedChannel && requestedAccount && requestedConversation) {
        return structuredClone(exact[0]);
      }
      return exact.length === 1 ? structuredClone(exact[0]) : null;
    }

    // Version 1 records have no account or conversation scope. They remain usable
    // only when there is one unambiguous legacy-compatible result.
    const compatible = candidates.filter((item) => (
      (!requestedAccount || !item.accountId || item.accountId === requestedAccount)
      && (!requestedConversation || !item.conversationId || item.conversationId === requestedConversation)
    ));
    return compatible.length === 1 ? structuredClone(compatible[0]) : null;
  }

  findDeliveryRoute(value = {}) {
    const delivery = this.findDelivery(value);
    if (!delivery?.projectCode) return null;
    const route = this.resolveRoute(delivery.projectCode, delivery.sessionCode);
    if (!route) return null;
    return {
      ...delivery,
      project: route.project,
      session: route.session,
    };
  }

  async claimInboundMessage(key, metadata = {}) {
    const digest = hashMessageKey(key);
    if (!digest) return false;
    if (this.state.processedMessages.some((item) => item.key === digest)) return false;
    this.state.processedMessages.push({
      key: digest,
      receivedAt: clean(metadata.receivedAt, 50) || this.now().toISOString(),
    });
    this.state.processedMessages = this.state.processedMessages.slice(-MAX_PROCESSED_MESSAGES);
    await this.#save();
    return true;
  }

  async #save() {
    if (!this.loaded) this.loaded = true;
    const payload = `${JSON.stringify(this.state, null, 2)}\n`;
    const operation = this.writeQueue.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(temporary, payload, { encoding: "utf8", mode: 0o600 });
      try {
        await rename(temporary, this.filePath);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
    });
    this.writeQueue = operation.catch(() => {});
    await operation;
  }
}

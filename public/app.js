import {
  ACTIVE_STATUS_NAMES,
  PHASE_LABELS,
  STATUS_LABELS,
  buildCompactTaskPresentation,
  collapsedSessionTasks,
} from "./compact-task-presentation.mjs";

const tasks = new Map();
const activeStatuses = new Set(ACTIVE_STATUS_NAMES);
const companionMode = new URLSearchParams(window.location.search).get("companion") === "1";
if (companionMode) document.body.classList.add("companion-mode");

const statusLabels = STATUS_LABELS;
const phaseLabels = PHASE_LABELS;

const taskList = document.querySelector("#task-list");
const emptyState = document.querySelector("#empty-state");
const countBadge = document.querySelector("#task-count");
const connection = document.querySelector("#connection");
const connectionLabel = document.querySelector("#connection-label");
const reconnectButton = document.querySelector("#reconnect-button");
const panelClose = document.querySelector("#panel-close");
const panelSettings = document.querySelector("#panel-settings");
const compactToolbar = document.querySelector("#compact-toolbar");
const acknowledgeAllButton = document.querySelector("#acknowledge-all");
const toast = document.querySelector("#toast");
const taskPanel = document.querySelector(".task-panel");

let eventSource = null;
let toastTimer = null;
let resizeFrame = null;
let emptyPanelCloseTimer = null;
let visiblePanelItemCount = 0;
const expandedSessionIds = new Set();

function acknowledgeSymbol(status) {
  if (status === "failed") return "×";
  if (status === "interrupted") return "!";
  if (status === "unknown") return "?";
  return "✓";
}

function cancelEmptyPanelClose() {
  clearTimeout(emptyPanelCloseTimer);
  emptyPanelCloseTimer = null;
}

function scheduleEmptyPanelClose() {
  cancelEmptyPanelClose();
  if (!companionMode || tasks.size !== 0) return;
  emptyPanelCloseTimer = setTimeout(() => {
    emptyPanelCloseTimer = null;
    if (tasks.size === 0) window.companion?.hidePanel();
  }, 2000);
}

function requestPanelResize() {
  if (!companionMode || !window.companion?.resizePanel) return;
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    window.companion.resizePanel({
      height: Math.ceil(taskPanel.getBoundingClientRect().height),
      itemCount: visiblePanelItemCount,
    });
  });
}

function setConnection(state, label) {
  connection.dataset.state = state;
  connectionLabel.textContent = label;
  reconnectButton.hidden = state !== "offline";
}

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 4200);
}

function timeValue(task) {
  return Date.parse(task.lastActivityAt || task.completedAt || task.startedAt || task.submittedAt || 0);
}

function formatTime(task) {
  const value = timeValue(task);
  if (!Number.isFinite(value) || value <= 0) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function createTaskCard(task) {
  const active = activeStatuses.has(task.status);
  const card = element("article", "task-card");
  card.dataset.taskId = task.taskId;
  card.dataset.status = task.status;
  card.dataset.active = String(active);

  const main = element("div", "card-main");
  const content = element("div", "card-content");
  const meta = element("div", "card-meta");

  const source = element("span", "source-chip", task.sourceLabel || "Codex");
  source.dataset.source = task.sourceKind || "unknown";
  meta.append(source);

  if (task.projectName) meta.append(element("span", "project-name", task.projectName));
  const taskTime = formatTime(task);
  if (taskTime) meta.append(element("time", "task-time", taskTime));

  const question = element("h2", "task-question", task.question || task.title || "未命名任务");
  content.append(meta, question);

  if (task.latestResponse) {
    content.append(element("p", "task-response", task.latestResponse));
  }

  const state = element("div", "card-state");
  const status = element("span", "status-chip");
  status.dataset.status = task.status;
  status.append(
    element("span", "status-indicator"),
    document.createTextNode(statusLabels[task.status] || task.status),
  );
  state.append(status);

  const phase = element("span", "phase-label", phaseLabels[task.phase] || task.phase || "");
  state.append(phase);

  if (task.canAcknowledge) {
    const button = element("button", "acknowledge-button", acknowledgeSymbol(task.status));
    button.type = "button";
    button.dataset.status = task.status;
    button.title = "确认并从列表移除";
    button.setAttribute("aria-label", `确认任务：${task.question || task.title || "未命名任务"}`);
    button.addEventListener("click", () => acknowledgeTask(task, button));
    state.append(button);
  }

  main.append(content, state);
  card.append(main);
  return card;
}

function createCompactTaskCard(task) {
  const active = activeStatuses.has(task.status);
  const presentation = buildCompactTaskPresentation(task);
  const card = element("article", "task-card compact-task");
  card.dataset.taskId = task.taskId;
  card.dataset.status = task.status;
  card.dataset.active = String(active);

  const content = element("div", "compact-content");
  const title = element("h3", "compact-title", presentation.title);
  title.title = presentation.fullTitle;
  content.append(title);

  const detail = element("p", "compact-detail");
  const state = element("span", "compact-state", presentation.state);
  state.dataset.status = task.status;
  detail.append(state);

  if (presentation.context) {
    const context = element("span", "compact-context", presentation.context);
    context.title = presentation.fullContext;
    detail.append(element("span", "compact-detail-separator", "·"), context);
  }

  if (presentation.preview) {
    const preview = element("span", "compact-preview", presentation.preview);
    preview.title = presentation.fullPreview;
    detail.append(element("span", "compact-detail-separator", "·"), preview);
  }

  content.append(detail);
  card.append(content);

  if (task.canAcknowledge) {
    const symbol = acknowledgeSymbol(task.status);
    const button = element("button", "compact-acknowledge", symbol);
    button.type = "button";
    button.dataset.status = task.status;
    button.title = "确认并移除这项任务";
    button.setAttribute("aria-label", `确认任务：${task.question || task.title || "未命名任务"}`);
    button.addEventListener("click", () => acknowledgeTask(task, button));
    card.append(button);
  }

  return card;
}

function taskSessionKey(task) {
  return String(task.sessionId || task.rootSessionId || task.taskId);
}

function groupTasksBySession(orderedTasks) {
  const groups = new Map();
  for (const task of orderedTasks) {
    const key = taskSessionKey(task);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(task);
  }
  return [...groups.entries()].map(([sessionId, sessionTasks]) => ({ sessionId, sessionTasks }));
}

function sessionIdentityTask(sessionTasks) {
  return sessionTasks.reduce((latest, task) => (
    !latest || timeValue(task) > timeValue(latest) ? task : latest
  ), null) || sessionTasks[0];
}

function createSessionHeader({ sessionId, sessionTasks, historyCount, expanded }) {
  const identityTask = sessionIdentityTask(sessionTasks);
  const projectName = String(identityTask?.projectName || "").trim();
  const sourceLabel = String(identityTask?.sourceLabel || "").trim();
  const identityLabel = [projectName, sourceLabel]
    .filter((value, index, values) => value && values.indexOf(value) === index)
    .join(" · ") || "任务会话";

  const header = element("header", "session-header");
  const identity = element("div", "session-identity");
  identity.title = identityLabel;
  if (projectName) identity.append(element("span", "session-project", projectName));
  if (sourceLabel && sourceLabel !== projectName) {
    if (projectName) identity.append(element("span", "session-identity-separator", "·"));
    identity.append(element("span", "session-source", sourceLabel));
  }
  if (!identity.childNodes.length) identity.append(element("span", "session-source", "任务会话"));
  header.append(identity);

  if (historyCount > 0) {
    const toggle = element(
      "button",
      "session-history-toggle",
      expanded ? "收起" : `展开 ${sessionTasks.length}`,
    );
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.setAttribute(
      "aria-label",
      expanded ? "收起当前会话的历史任务" : `展开当前会话的 ${historyCount} 条历史任务`,
    );
    toggle.addEventListener("click", () => {
      if (expanded) expandedSessionIds.delete(sessionId);
      else expandedSessionIds.add(sessionId);
      render();
    });
    header.append(toggle);
  }

  return { header, identityLabel };
}

function createCompanionSessionGroup({ sessionId, sessionTasks }) {
  const group = element("section", "session-group");
  group.dataset.sessionId = sessionId;

  const collapsedTasks = collapsedSessionTasks(sessionTasks);
  const historyCount = Math.max(0, sessionTasks.length - collapsedTasks.length);
  const expanded = historyCount > 0 && expandedSessionIds.has(sessionId);
  group.classList.toggle("is-session-collapsed", historyCount > 0 && !expanded);
  group.classList.toggle("is-session-expanded", expanded);

  const { header, identityLabel } = createSessionHeader({
    sessionId,
    sessionTasks,
    historyCount,
    expanded,
  });
  group.setAttribute("aria-label", `${identityLabel}，${sessionTasks.length} 项任务`);

  const cards = element("div", "session-cards");
  const displayedTasks = historyCount > 0 && !expanded ? collapsedTasks : sessionTasks;

  if (historyCount > 0 && !expanded) {
    cards.dataset.stackDepth = String(Math.min(historyCount, 2));
  }

  const renderedCards = displayedTasks.map(createCompactTaskCard);

  cards.append(...renderedCards);
  group.append(header, cards);
  return group;
}

function render() {
  const ordered = [...tasks.values()].sort((left, right) => {
    const leftActive = activeStatuses.has(left.status) ? 0 : 1;
    const rightActive = activeStatuses.has(right.status) ? 0 : 1;
    return leftActive - rightActive || timeValue(right) - timeValue(left);
  });

  let renderedTasks;
  if (companionMode) {
    const sessionGroups = groupTasksBySession(ordered);
    const currentSessionIds = new Set(sessionGroups.map((group) => group.sessionId));
    for (const sessionId of expandedSessionIds) {
      if (!currentSessionIds.has(sessionId)) expandedSessionIds.delete(sessionId);
    }
    renderedTasks = sessionGroups.map(createCompanionSessionGroup);
  } else {
    renderedTasks = ordered.map(createTaskCard);
  }
  taskList.replaceChildren(...renderedTasks);
  visiblePanelItemCount = Math.max(
    renderedTasks.length,
    taskList.querySelectorAll(".compact-task").length,
  );
  taskList.setAttribute("aria-busy", "false");
  emptyState.hidden = ordered.length !== 0 || (companionMode && !usageMeterSlot.hidden);
  countBadge.textContent = String(ordered.length);
  countBadge.setAttribute("aria-label", `${ordered.length} 项任务`);
  if (companionMode) {
    const acknowledgeableCount = ordered.filter((task) => task.canAcknowledge).length;
    compactToolbar.hidden = acknowledgeableCount === 0;
    acknowledgeAllButton.hidden = acknowledgeableCount === 0;
    acknowledgeAllButton.textContent = acknowledgeableCount > 1
      ? `全部已读 ${acknowledgeableCount}`
      : "全部已读";
    acknowledgeAllButton.setAttribute("aria-label", `将 ${acknowledgeableCount} 项已结束任务标记为已读`);
  }
  requestPanelResize();
}

async function acknowledgeAllTasks() {
  const targets = [...tasks.values()].filter((task) => task.canAcknowledge);
  if (!targets.length || acknowledgeAllButton.disabled) return;
  acknowledgeAllButton.disabled = true;
  acknowledgeAllButton.textContent = "处理中…";
  try {
    const response = await fetch("/api/v1/tasks/acknowledge-all", { method: "POST" });
    if (!response.ok) throw new Error("read_state_persist_failed");
    const result = await response.json();
    for (const taskId of result.taskIds || []) tasks.delete(taskId);
  } catch {
    showToast("暂时无法保存已读状态，请稍后重试");
  } finally {
    acknowledgeAllButton.disabled = false;
    render();
  }
}

async function acknowledgeTask(task, button) {
  if (!task.canAcknowledge || button.disabled) return;
  button.disabled = true;
  button.textContent = "…";
  try {
    const response = await fetch(
      `/api/v1/tasks/${encodeURIComponent(task.taskId)}/acknowledge`,
      { method: "POST" },
    );
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.message || `确认失败（${response.status}）`);
    }
    tasks.delete(task.taskId);
    render();
  } catch (error) {
    button.disabled = false;
    button.textContent = acknowledgeSymbol(task.status);
    showToast(error.message || "暂时无法确认任务，请稍后重试");
  }
}

function applySnapshot(snapshot) {
  tasks.clear();
  for (const task of snapshot.tasks || []) tasks.set(task.taskId, task);
  if (tasks.size > 0) cancelEmptyPanelClose();
  render();
}

function applyTask(task) {
  if (!task?.taskId) return;
  tasks.set(task.taskId, task);
  cancelEmptyPanelClose();
  render();
}

function removeTask(event) {
  if (!event?.taskId) return;
  tasks.delete(event.taskId);
  render();
}

function parseEvent(event, handler) {
  try {
    handler(JSON.parse(event.data));
  } catch {
    showToast("收到了一条无法识别的任务更新");
  }
}

function connect() {
  eventSource?.close();
  setConnection("connecting", "正在连接");
  eventSource = new EventSource("/api/v1/events");
  eventSource.addEventListener("open", () => setConnection("online", "实时连接"));
  eventSource.addEventListener("snapshot", (event) => parseEvent(event, applySnapshot));
  eventSource.addEventListener("task.created", (event) => parseEvent(event, applyTask));
  eventSource.addEventListener("task.updated", (event) => parseEvent(event, applyTask));
  eventSource.addEventListener("task.removed", (event) => parseEvent(event, removeTask));
  eventSource.addEventListener("error", () => {
    setConnection("offline", "连接中断");
  });
}

reconnectButton.addEventListener("click", connect);
panelClose.addEventListener("click", () => window.companion?.togglePanel());
panelSettings.addEventListener("click", () => window.companion?.openSettings());
acknowledgeAllButton.addEventListener("click", acknowledgeAllTasks);
if (companionMode && "ResizeObserver" in window) {
  new ResizeObserver(requestPanelResize).observe(taskPanel);
}
window.addEventListener("beforeunload", () => eventSource?.close());
window.companion?.onPanelShown?.(() => {
  scheduleEmptyPanelClose();
});
connect();

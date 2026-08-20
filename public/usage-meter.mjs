const usageRenderers = new Map();

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function percentage(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : 0;
}

export function formatUsageWindow(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value <= 0) return "使用限额";
  if (value === 10_080) return "每周使用限额";
  if (value % 10_080 === 0) return `${value / 10_080} 周使用限额`;
  if (value % 1_440 === 0) return `${value / 1_440} 天使用限额`;
  if (value % 60 === 0) return `${value / 60} 小时使用限额`;
  return `${value} 分钟使用限额`;
}

export function formatResetTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "重置时间未知";
  return `重置于 ${new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date)}`;
}

export function formatSyncTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "等待同步";
  return `已同步 · ${new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date)}`;
}

export function registerUsageRenderer(viewType, renderer) {
  usageRenderers.set(viewType, renderer);
}

function createMeter(windowData) {
  const used = percentage(windowData.usedPercent);
  const remaining = percentage(windowData.remainingPercent);
  const meter = node("section", "usage-meter-row");
  const heading = node("div", "usage-meter-heading");
  heading.append(
    node("span", "usage-window-label", formatUsageWindow(windowData.windowMinutes)),
    node("strong", "usage-remaining", `剩余 ${remaining}%`),
  );
  const track = node("div", "usage-progress-track");
  track.setAttribute("role", "progressbar");
  track.setAttribute("aria-label", `${formatUsageWindow(windowData.windowMinutes)}剩余`);
  track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", "100");
  track.setAttribute("aria-valuenow", String(remaining));
  const bar = node("span", "usage-progress-bar");
  bar.style.width = `${remaining}%`;
  track.append(bar);
  const details = node("div", "usage-meter-details");
  details.append(
    node("span", "usage-used", `已用 ${used}%`),
    node("span", "usage-reset", windowData.resetsAt ? formatResetTime(windowData.resetsAt) : "重置时间未知"),
  );
  meter.append(heading, track, details);
  return meter;
}

function renderCodexQuota(snapshot, { onRefresh }) {
  const card = node("article", "usage-card usage-card-codex");
  card.dataset.status = snapshot.status || "unknown";
  const header = node("header", "usage-card-header");
  const identity = node("div", "usage-card-identity");
  identity.append(node("strong", "usage-provider-name", snapshot.displayName || "Codex"));
  if (snapshot.planLabel) identity.append(node("span", "usage-plan-badge", snapshot.planLabel));
  const refresh = node("button", "usage-refresh", "↻");
  refresh.type = "button";
  refresh.title = "刷新额度";
  refresh.setAttribute("aria-label", "刷新 Codex 通用额度");
  refresh.addEventListener("click", async () => {
    refresh.disabled = true;
    refresh.classList.add("is-refreshing");
    try {
      await onRefresh();
    } finally {
      refresh.disabled = false;
      refresh.classList.remove("is-refreshing");
    }
  });
  header.append(identity, refresh);
  card.append(header);

  if (snapshot.status === "ready" && snapshot.windows?.length) {
    const meters = node("div", "usage-meter-list");
    meters.append(...snapshot.windows.map(createMeter));
    card.append(meters);
  } else {
    card.append(node("p", "usage-empty-message", snapshot.message || "暂无通用额度数据。"));
  }

  const footer = node("footer", "usage-card-footer");
  footer.append(
    node("span", "usage-sync-dot"),
    node("span", "usage-sync-label", formatSyncTime(snapshot.syncedAt)),
  );
  card.append(footer);
  return card;
}

function renderUnavailable(snapshot) {
  const card = node("article", "usage-card usage-card-unavailable");
  card.append(
    node("strong", "usage-provider-name", snapshot.providerId || "当前连接"),
    node("p", "usage-empty-message", snapshot.message || "当前连接尚未提供额度信息。"),
  );
  return card;
}

registerUsageRenderer("codex-quota", renderCodexQuota);
registerUsageRenderer("unavailable", renderUnavailable);

export function renderUsageMeter(snapshot, options) {
  const renderer = usageRenderers.get(snapshot?.viewType) || renderUnavailable;
  return renderer(snapshot || {}, options);
}

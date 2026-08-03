const EVENT_LABELS = Object.freeze({
  needs_input: "任务正在等待你的确认",
  completed: "任务已完成",
  failed: "任务执行失败",
  interrupted: "任务已中断",
  unknown: "任务状态需要检查",
});

function clean(value, limit) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

export function renderRemoteMessage(task, event, contentLevel = "standard") {
  const level = ["brief", "standard", "detailed"].includes(contentLevel)
    ? contentLevel
    : "standard";
  const status = EVENT_LABELS[event] || "任务状态已更新";
  if (level === "brief") return status;

  const project = clean(task?.projectName, 80);
  const title = clean(task?.title || task?.question, 160);
  const lines = [`Agent Pet · ${status}`];
  if (project) lines.push(`项目：${project}`);
  if (title) lines.push(`任务：${title}`);

  if (level === "detailed") {
    const response = clean(task?.latestResponse || task?.summary || task?.lastResponse, 500);
    if (response && response !== title) lines.push(`结果：${response}`);
  }
  return lines.join("\n").slice(0, 900);
}

export function remoteEventLabel(event) {
  return EVENT_LABELS[event] || "任务状态已更新";
}

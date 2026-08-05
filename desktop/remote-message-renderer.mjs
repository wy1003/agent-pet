import {
  normalizeProjectCode,
  normalizeSessionCode,
} from "./remote-task-registry.mjs";
import { parseRemoteRequest } from "../src/remote-request.mjs";

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

function resultText(value) {
  const raw = String(value || "").trim().slice(0, 8_000);
  if (!raw) return "";
  const withoutCodeBlocks = raw.replace(/```[\s\S]*?```/g, " ");
  const normalize = (source) => source
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*|__|~~/g, "")
    .replace(/\s+/g, " ")
    .replace(/([。！？；：])\s+(?=[\u3400-\u9fff])/g, "$1")
    .trim();
  return normalize(withoutCodeBlocks) || normalize(raw.replace(/```/g, ""));
}

export function summarizeRemoteResult(value, limit = 180) {
  const source = resultText(value);
  if (!source) return "";
  const maximum = Math.max(80, Math.min(500, Number(limit) || 180));
  if (source.length <= maximum) return source;
  const preview = source.slice(0, maximum);
  const minimumBoundary = Math.floor(maximum * 0.55);
  let boundary = -1;
  for (const match of preview.matchAll(/[。！？!?；;]/g)) {
    const candidate = Number(match.index) + 1;
    if (candidate >= minimumBoundary) boundary = candidate;
  }
  if (boundary > 0) return source.slice(0, boundary).trim();
  return `${preview.replace(/[\s，,、：:；;]+$/g, "").trim()}…`;
}

function routeLine(route = {}) {
  route = route || {};
  const projectCode = normalizeProjectCode(route.projectCode);
  const sessionCode = normalizeSessionCode(route.sessionCode);
  if (sessionCode) return `会话：/${sessionCode}`;
  if (projectCode) return `项目指令：/${projectCode}`;
  return "";
}

export function renderRemoteMessage(task, event, contentLevel = "standard", route = {}) {
  const level = ["brief", "standard", "detailed"].includes(contentLevel)
    ? contentLevel
    : "standard";
  const status = EVENT_LABELS[event] || "任务状态已更新";
  const routing = routeLine(route);
  if (level === "brief") return [`Agent Pet · ${status}`, routing].filter(Boolean).join("\n");

  const project = clean(task?.projectName, 80);
  const projectless = task?.projectKind === "projectless";
  const rawTitle = task?.question || task?.title;
  const title = clean(parseRemoteRequest(rawTitle)?.request || rawTitle, 160);
  const lines = [`Agent Pet · ${status}`];
  const projectCode = normalizeProjectCode(route?.projectCode);
  const sessionCode = normalizeSessionCode(route?.sessionCode);
  // A project-only route still needs to be actionable. Session notifications
  // keep their one copyable command at the bottom instead of repeating the id.
  if (!sessionCode && projectCode) lines.push(routing);
  if (projectless) lines.push("类型：普通对话");
  else if (project) lines.push(`项目：${project}`);
  if (title) lines.push(`任务：${title}`);
  const response = summarizeRemoteResult(
    task?.latestResponse || task?.summary || task?.lastResponse,
    level === "detailed" ? 360 : 180,
  );
  if (response && response !== title) {
    const label = event === "needs_input" ? "当前回复" : "结果摘要";
    lines.push(`${label}：${response}`);
  } else if (event === "completed") {
    lines.push("结果摘要：任务已完成，详细结果请在电脑端查看。");
  }
  if (sessionCode) {
    lines.push("", "继续处理此任务：", `/${sessionCode} 你的要求`);
  }
  return lines.join("\n").slice(0, 900);
}

export function remoteEventLabel(event) {
  return EVENT_LABELS[event] || "任务状态已更新";
}

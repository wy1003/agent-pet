export const NOTIFICATION_EVENTS = Object.freeze([
  "needs_input",
  "completed",
  "failed",
  "interrupted",
  "unknown",
]);

const FALLBACK_TEXT = Object.freeze({
  needs_input: "任务正在等待你的确认。",
  completed: "任务已经完成。",
  failed: "任务没有顺利完成，请检查一下。",
  interrupted: "任务已经中断。",
  unknown: "任务状态暂时无法确认，请检查一下。",
});

function contextFor(task, style, contentLevel) {
  const level = ["brief", "standard", "detailed"].includes(contentLevel)
    ? contentLevel
    : "standard";
  const projectName = style?.includeProjectName === false || level === "brief"
    ? ""
    : String(task?.projectName || "").trim().slice(0, 80);
  const taskName = level === "detailed"
    ? String(task?.title || task?.question || "").trim().slice(0, 100)
    : "";
  return {
    addressee: String(style?.addressee || "").trim().slice(0, 24),
    assistantName: String(style?.assistantName || "").trim().slice(0, 24),
    projectName,
    taskName,
  };
}

export function renderPhrase(template, task, style = {}, contentLevel = "standard", event = "unknown") {
  const context = contextFor(task, style, contentLevel);
  let text = String(template || "").trim();
  text = text
    .replaceAll("{项目名}的任务", context.projectName ? `${context.projectName}的任务` : "任务")
    .replaceAll("{称呼}", context.addressee)
    .replaceAll("{助手自称}", context.assistantName)
    .replaceAll("{项目名}", context.projectName)
    .replaceAll("{任务名}", context.taskName)
    .replace(/^[\s，、；：]+/, "")
    .replace(/[，、；：]{2,}/g, "，")
    .replace(/，\s*[。！？]/g, "。")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || /^[。！？]+$/.test(text)) text = FALLBACK_TEXT[event] || FALLBACK_TEXT.unknown;
  return text.slice(0, 220);
}

export class PhraseComposer {
  constructor(options = {}) {
    this.random = options.random || Math.random;
    this.previousByEvent = new Map();
  }

  choose(pool, event) {
    const phrases = Array.isArray(pool?.[event]) ? pool[event].filter(Boolean) : [];
    if (!phrases.length) return FALLBACK_TEXT[event] || FALLBACK_TEXT.unknown;
    const previous = this.previousByEvent.get(event);
    const candidates = phrases.length > 1 ? phrases.filter((phrase) => phrase !== previous) : phrases;
    const index = Math.min(candidates.length - 1, Math.floor(this.random() * candidates.length));
    const selected = candidates[Math.max(0, index)];
    this.previousByEvent.set(event, selected);
    return selected;
  }

  compose(pool, event, task, preferences) {
    const voice = preferences?.notifications?.voice || {};
    return renderPhrase(
      this.choose(pool, event),
      task,
      voice.style,
      voice.contentLevel,
      event,
    );
  }
}

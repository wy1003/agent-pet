export const ACTIVE_STATUS_NAMES = Object.freeze([
  "submitted",
  "queued",
  "running",
  "needs_input",
]);

export const STATUS_LABELS = Object.freeze({
  submitted: "已提交",
  queued: "等待开始",
  running: "执行中",
  needs_input: "等待你",
  completed: "已完成",
  failed: "失败",
  interrupted: "已中断",
  unknown: "状态未知",
});

export const PHASE_LABELS = Object.freeze({
  waiting_start: "正在排队",
  reasoning: "正在思考",
  tool_running: "正在使用工具",
  responding: "正在整理回复",
  waiting_approval: "需要批准",
  waiting_answer: "需要回答",
  finished: "等待确认",
  unknown: "未收到结束事件",
});

const ACTIVE_STATUSES = new Set(ACTIVE_STATUS_NAMES);
const FILE_EXTENSION_PATTERN =
  "md|mdx|txt|json|ya?ml|toml|ini|js|mjs|cjs|jsx|ts|tsx|py|go|rs|java|kt|kts|cs|cpp|c|h|hpp|vue|svelte|css|scss|less|html?|svg|png|jpe?g|gif|webp|avif|pdf|docx?|xlsx?|pptx?|zip|7z|rar|wav|mp3|flac|ogg|pth|ckpt";
const LEADING_FILE_PATTERN = new RegExp(
  `^((?:(?:[A-Za-z]:)?[\\\\/])?(?:[^\\s\\\\/:：,，;；!?！？\`"“”‘’「」『』《》]+[\\\\/])*[^\\s\\\\/:：,，;；!?！？\`"“”‘’「」『』《》]{1,120}?\\.(?:${FILE_EXTENSION_PATTERN}))(?![A-Za-z0-9_])`,
  "i",
);

export function normalizeCompactText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function truncateCompactText(value, maximumLength) {
  const text = normalizeCompactText(value);
  if (text.length <= maximumLength) return text;
  return `${text.slice(0, Math.max(1, maximumLength - 1)).trimEnd()}…`;
}

function basename(filePath) {
  const normalized = String(filePath || "").replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).at(-1) || normalized;
}

function stripLeadingListMarker(text) {
  return text.replace(/^(?:#{1,6}\s+|[-*+]\s+|[>＞]\s*)/, "").trimStart();
}

function stripFileWrapper(text) {
  return text.replace(/^[\`"'“‘「『《]+/, "");
}

function stripContextSeparator(text) {
  return text
    .replace(/^[\`"'”’」』》\])}]+/, "")
    .replace(/^[\s,，、;；:：·|+—-]+/, "")
    .trimStart();
}

function matchLeadingFile(text) {
  const candidate = stripFileWrapper(stripLeadingListMarker(text));
  const match = candidate.match(LEADING_FILE_PATTERN);
  if (!match) return null;

  const remainder = candidate.slice(match[0].length);
  if (/^[A-Za-z0-9_]/.test(remainder)) return null;
  return {
    filePath: match[1],
    remainder: stripContextSeparator(remainder),
  };
}

export function extractLeadingFileContext(value) {
  const original = normalizeCompactText(value);
  if (!original) return { files: [], context: "", remainder: "" };

  const files = [];
  let remainder = original;
  for (let index = 0; index < 4; index += 1) {
    const match = matchLeadingFile(remainder);
    if (!match) break;
    files.push(basename(match.filePath));
    if (match.remainder === remainder) break;
    remainder = match.remainder;
  }

  if (!files.length) return { files: [], context: "", remainder: original };
  const context = files.length === 1 ? files[0] : `${files[0]} +${files.length - 1}`;
  return { files, context, remainder };
}

export function compactTaskState(task) {
  if (ACTIVE_STATUSES.has(task?.status)) {
    if (task.status === "needs_input") {
      return PHASE_LABELS[task.phase] || "正在等待你的操作";
    }
    if (["submitted", "queued"].includes(task.status)) {
      return PHASE_LABELS[task.phase] || "正在等待开始";
    }
    return PHASE_LABELS[task.phase] || "正在处理中";
  }
  return STATUS_LABELS[task?.status] || task?.status || "状态已更新";
}

export function collapsedSessionTasks(tasks) {
  const sessionTasks = Array.isArray(tasks) ? tasks : [];
  const activeTasks = sessionTasks.filter((task) => ACTIVE_STATUSES.has(task?.status));
  return activeTasks.length ? activeTasks : sessionTasks.slice(0, 1);
}

export function buildCompactTaskPresentation(task) {
  const originalTitle = normalizeCompactText(task?.question || task?.title || "未命名任务");
  const extracted = extractLeadingFileContext(originalTitle);
  const fallbackTitle = extracted.context ? `查看 ${extracted.context}` : "未命名任务";
  const fullTitle = normalizeCompactText(extracted.remainder) || fallbackTitle;

  const response = normalizeCompactText(
    task?.latestResponse || (task?.status === "failed" ? task?.errorMessage || task?.error : ""),
  );
  const preview = response && response !== originalTitle && response !== fullTitle
    ? truncateCompactText(response, 120)
    : "";

  return {
    title: truncateCompactText(fullTitle, 82),
    fullTitle,
    context: truncateCompactText(extracted.context, 42),
    fullContext: extracted.context,
    state: compactTaskState(task),
    preview,
    fullPreview: response,
  };
}

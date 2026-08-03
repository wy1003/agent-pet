const BLOCK_TAGS = [
  "agents-instructions",
  "environment_context",
  "permissions",
  "permissions instructions",
  "permissions_instructions",
  "apps_instructions",
  "plugins_instructions",
  "skills_instructions",
  "app-context",
  "in-app-browser-context",
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function toText(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part?.text === "string") return part.text;
        if (typeof part?.content === "string") return part.content;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof value?.text === "string") return value.text;
  if (typeof value?.message === "string") return value.message;
  return "";
}

export function cleanUserText(value) {
  let text = toText(value).replace(/^\uFEFF/, "");

  for (const tag of BLOCK_TAGS) {
    const escaped = escapeRegExp(tag);
    text = text.replace(
      new RegExp(`<${escaped}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${escaped}>`, "gi"),
      "\n",
    );
  }

  // Desktop messages with attachments wrap the actual prompt after this
  // marker. Prefer the explicit request and discard generated file metadata.
  const requestMarker = /(?:^|\n)## My request for Codex:\s*(?:\n|$)/i;
  const requestMatch = requestMarker.exec(text);
  if (requestMatch) text = text.slice(requestMatch.index + requestMatch[0].length);

  // Some clients prepend Markdown headings instead of XML wrappers.
  text = text.replace(
    /^# Project Instructions(?:.|\r?\n)*?(?=\r?\n\r?\n[^#\s]|$)/im,
    "\n",
  );

  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function normalizeMessageText(value) {
  return toText(value)
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

export function makeTitle(text, maxLength = 80) {
  const compact = cleanUserText(text).replace(/\s+/g, " ").trim();
  if (!compact) return "未命名会话";
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

export function makePreview(text, maxLength = 160) {
  const compact = normalizeMessageText(text).replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

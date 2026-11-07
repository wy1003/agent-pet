// Native transcripts carry provenance; older Hook payloads only carry text.
// Prefer explicit human provenance so a user's XML example stays a request.
export function claudeInputKind(input, text = input.prompt || "") {
  const origin = input.origin?.kind;
  if (origin === "human" || input.turnOrigin === "human") return "human";
  if (origin === "task-notification" || input.turnOrigin === "task_notification") return "continuation";
  if (["peer", "auto-continuation", "observer", "observer-activity"].includes(origin)
    || ["peer", "auto_continuation"].includes(input.turnOrigin)) return "continuation";
  if (/^\s*(?:<task-notification>|<agent-message\b|<teammate-message\b|Another Claude session sent a message:\s*<agent-message\b)/.test(text)) return "continuation";
  if (/^\s*<(?:command-name|local-command-stdout|local-command-stderr|local-command-caveat)>/.test(text)) return "local";
  return "human";
}

export function finishedBackgroundTask(text) {
  if (!/^\s*<task-notification>/.test(text)) return null;
  const id = text.match(/<task-id>([A-Za-z0-9_-]{1,128})<\/task-id>/)?.[1];
  const status = text.match(/<status>(completed|failed|stopped|killed)<\/status>/)?.[1];
  return id && status ? id : null;
}

export function backgroundToolUseId(text) {
  return text.match(/<tool-use-id>([A-Za-z0-9_-]{1,256})<\/tool-use-id>/)?.[1] || null;
}

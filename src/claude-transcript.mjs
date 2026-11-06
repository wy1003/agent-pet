import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

const TAIL_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 64 * TAIL_BYTES;
const MAX_TEXT_BYTES = 64 * 1024;

function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
}

// A hook path is untrusted. Only <configured projects>/<project>/<session>.jsonl
// is eligible, and both the project directory and file must be non-symlinks.
export async function readStoppedTurnText({ transcriptsDir, transcriptPath, sessionId, prompt, submittedAt, completedAt }) {
  if (typeof transcriptPath !== "string" || !path.isAbsolute(transcriptPath) || !/^[A-Za-z0-9_-]+$/.test(sessionId)) return null;
  const root = path.resolve(transcriptsDir), file = path.resolve(transcriptPath);
  const relative = path.relative(root, file).split(path.sep);
  if (relative.length !== 2 || relative[0] === ".." || relative[1] !== `${sessionId}.jsonl`) return null;
  let handle;
  try {
    const canonicalRoot = await realpath(root), project = path.dirname(file);
    const projectInfo = await lstat(project), fileInfo = await lstat(file);
    if (!projectInfo.isDirectory() || projectInfo.isSymbolicLink() || !fileInfo.isFile() || fileInfo.isSymbolicLink()) return null;
    if (path.dirname(await realpath(project)) !== canonicalRoot || path.dirname(await realpath(file)) !== await realpath(project)) return null;
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const info = await handle.stat();
    if (!info.isFile() || info.ino !== fileInfo.ino || info.dev !== fileInfo.dev || info.size > MAX_FILE_BYTES) return null;
    const offset = Math.max(0, info.size - TAIL_BYTES), buffer = Buffer.alloc(Math.min(info.size, TAIL_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (offset) text = text.slice(text.indexOf("\n") + 1);
    // A final line without newline may still be being written. Retry next scan.
    const lines = text.split("\n"); lines.pop();
    let matched = false, answer = null;
    const started = Date.parse(submittedAt), stopped = Date.parse(completedAt);
    for (const line of lines) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row?.sessionId !== sessionId || row.isSidechain || row.agentId) continue;
      const timestamp = Date.parse(row.timestamp), content = messageText(row.message);
      if (row.type === "user" && row.message?.role === "user" && content) {
        // Each real user message is a new boundary; tool_result blocks aren't.
        matched = content === prompt && timestamp >= started && timestamp <= stopped;
        answer = null;
      } else if (matched && row.type === "assistant" && row.message?.role === "assistant"
        && row.message.stop_reason === "end_turn" && timestamp >= started && timestamp <= stopped + 120_000) {
        const finalText = content.trim();
        if (finalText && Buffer.byteLength(finalText) <= MAX_TEXT_BYTES) answer = finalText;
      }
    }
    return answer;
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "ELOOP", "EACCES", "EPERM"].includes(error.code)) return null;
    throw Object.assign(new Error("Claude transcript read failed"), { code: "claude_transcript_read_failed" });
  } finally { await handle?.close(); }
}

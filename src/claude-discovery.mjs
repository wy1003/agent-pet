import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

const READ_BYTES = 1024 * 1024, TEXT_BYTES = 64 * 1024, HISTORY_MS = 24 * 60 * 60 * 1000;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const hash = value => createHash("sha256").update(value).digest("hex");
const stamp = value => new Date(value).getTime();
const projectKey = value => path.resolve(value).replace(/\\/g, "/").toLowerCase().replace(/\/$/, "");
const textOf = message => typeof message?.content === "string" ? message.content : Array.isArray(message?.content)
  ? message.content.filter(block => block?.type === "text" && typeof block.text === "string").map(block => block.text).join("\n") : "";
const limited = value => Buffer.byteLength(value) <= TEXT_BYTES ? value : `${Buffer.from(value).subarray(0, TEXT_BYTES).toString("utf8")}…`;
const excluded = row => row.isSidechain || row.agentId || row.agent_id || row.agent_pet_auxiliary === true || row.metadata?.agent_pet_auxiliary === true;
async function consumedAnchor(handle, offset) {
  const size = Math.min(offset, 256), buffer = Buffer.alloc(size);
  const { bytesRead } = await handle.read(buffer, 0, size, offset - size);
  return hash(buffer.subarray(0, bytesRead));
}

// Reads only main-session transcripts; never installs Hooks or writes client files.
// Cursors are committed by the collector only AFTER all returned events persist.
export class ClaudeTranscriptDiscovery {
  constructor({ transcriptsDir, ignoredProjectPaths = [], now = Date.now }) {
    this.root = path.resolve(transcriptsDir);
    this.ignoredProjects = ignoredProjectPaths.map(projectKey);
    this.now = now;
    this.files = {};
    this.nextIndex = 0;
  }
  restore(state) {
    this.files = state && typeof state === "object" && !Array.isArray(state) ? state : {};
  }
  snapshot() { return this.files; }
  commit(state) { this.files = state; }

  async scan() {
    let root;
    try { root = await realpath(this.root); }
    catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return { events: [], state: this.files }; throw error; }
    const candidates = [];
    for (const project of await readdir(root, { withFileTypes: true })) {
      if (!project.isDirectory() || project.isSymbolicLink()) continue;
      const directory = path.join(root, project.name);
      try {
        if (path.dirname(await realpath(directory)) !== root) continue;
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".jsonl")) continue;
          const sessionId = entry.name.slice(0, -6);
          if (ID.test(sessionId)) candidates.push({ file: path.join(directory, entry.name), key: `${project.name}/${entry.name}`, sessionId });
        }
      } catch (error) { if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code)) throw error; }
    }
    candidates.sort((a, b) => a.key.localeCompare(b.key));
    const present = new Set(candidates.map(candidate => candidate.key));
    const state = Object.fromEntries(Object.entries(this.files).filter(([key]) => present.has(key)));
    const events = [];
    // Rotate through large histories, limiting each polling cycle to 8 MiB of data.
    let budget = 8 * READ_BYTES, visited = 0;
    while (visited < candidates.length && budget > 0) {
      const candidate = candidates[(this.nextIndex + visited) % candidates.length];
      const batch = await this.#read(candidate, state[candidate.key], budget);
      if (batch) { state[candidate.key] = batch.cursor; events.push(...batch.events); budget -= batch.bytes; }
      visited++;
    }
    this.nextIndex = candidates.length ? (this.nextIndex + visited) % candidates.length : 0;
    events.sort((a, b) => stamp(a.timestamp) - stamp(b.timestamp));
    return { events, state };
  }

  async #read({ file, sessionId }, previous, budget) {
    let handle;
    try {
      const before = await lstat(file);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1 || path.dirname(await realpath(file)) !== path.dirname(file)) return null;
      handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const info = await handle.stat();
      if (!info.isFile() || info.nlink > 1 || info.ino !== before.ino || info.dev !== before.dev) return null;
      const prefixSize = Math.min(previous?.prefixSize || 256, info.size);
      const prefix = Buffer.alloc(prefixSize);
      await handle.read(prefix, 0, prefix.length, 0);
      const prefixHash = hash(prefix);
      const valid = previous && Number.isSafeInteger(previous.offset) && previous.offset >= 0 && previous.offset <= info.size
        && previous.ino === info.ino && previous.dev === info.dev && previous.prefixHash === prefixHash
        && previous.anchorHash === await consumedAnchor(handle, previous.offset)
        && !(previous.size === info.size && previous.mtime !== info.mtimeMs);
      const cursor = valid ? structuredClone(previous) : {
        offset: Math.max(0, info.size - READ_BYTES), skipLine: info.size > READ_BYTES, turn: null,
        ino: info.ino, dev: info.dev, prefixSize, prefixHash,
      };
      const bytes = Math.min(READ_BYTES, budget, info.size - cursor.offset), buffer = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(buffer, 0, bytes, cursor.offset);
      const chunk = buffer.subarray(0, bytesRead), end = chunk.lastIndexOf(10), events = [];
      let start = 0;
      if (cursor.skipLine) {
        const newline = chunk.indexOf(10);
        if (newline < 0) { cursor.offset += bytesRead; start = bytesRead; }
        else { start = newline + 1; cursor.skipLine = false; }
      }
      if (end >= start) {
        for (const line of chunk.subarray(start, end).toString("utf8").split("\n")) {
          let row;
          try { row = JSON.parse(line); } catch { continue; }
          const event = this.#record(row, cursor, sessionId, file);
          if (event) events.push(event);
        }
        cursor.offset += end + 1;
      } else if (!cursor.skipLine && bytesRead === READ_BYTES && end < 0) {
        // Discard an oversized record, including its remainder in later reads.
        cursor.offset += bytesRead; cursor.skipLine = true; cursor.turn = null;
      }
      cursor.anchorHash = await consumedAnchor(handle, cursor.offset);
      cursor.size = info.size; cursor.mtime = info.mtimeMs;
      return { cursor, events, bytes: bytesRead };
    } catch (error) {
      if (["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(error.code)) return null;
      throw Object.assign(new Error("Claude automatic discovery failed"), { code: "claude_discovery_read_failed" });
    } finally { await handle?.close(); }
  }

  #record(row, cursor, sessionId, file) {
    if (!row || row.sessionId !== sessionId || typeof row.uuid !== "string" || !ID.test(row.uuid) || excluded(row)) return null;
    const timestamp = stamp(row.timestamp);
    if (!Number.isFinite(timestamp)) return null;
    const cwd = typeof row.cwd === "string" ? row.cwd : "";
    const ignored = cwd && this.ignoredProjects.some(project => projectKey(cwd) === project || projectKey(cwd).startsWith(`${project}/`));
    if (ignored) { cursor.turn = null; return null; }
    const content = textOf(row.message);
    const base = { session_id: sessionId, timestamp: new Date(timestamp).toISOString(), cwd,
      transcript_path: file, agent_pet_source: "transcript", event_id: `transcript:${sessionId}:${row.uuid}:${hash(JSON.stringify(row.message ?? null))}` };
    const blocks = row.message?.content;
    const toolResult = Array.isArray(blocks) && blocks.some(block => block?.type === "tool_result");
    if (row.type === "user" && row.message?.role === "user" && content.trim() && !toolResult && !row.isMeta && !row.isCompactSummary) {
      cursor.turn = { id: row.uuid, started: timestamp, ancestors: [row.uuid], eligible: timestamp >= stamp(this.now()) - HISTORY_MS };
      if (!cursor.turn.eligible) return null;
      return { ...base, hook_event_name: "UserPromptSubmit", prompt_id: row.uuid, prompt: limited(content), prompt_hash: hash(content) };
    }
    const turn = cursor.turn;
    if (!turn || !turn.eligible || timestamp < turn.started) return null;
    if (row.parentUuid && !turn.ancestors.includes(row.parentUuid)) return null;
    if (!turn.ancestors.includes(row.uuid)) turn.ancestors = [...turn.ancestors, row.uuid].slice(-256);
    if (row.type !== "assistant" || row.message?.role !== "assistant") return null;
    const toolUse = row.message.stop_reason === "tool_use" || (Array.isArray(blocks) && blocks.some(block => block?.type === "tool_use"));
    if (toolUse) return { ...base, hook_event_name: "PostToolUse", prompt_id: turn.id };
    if (row.message.stop_reason === "end_turn") return { ...base, hook_event_name: "Stop", prompt_id: turn.id, last_assistant_message: limited(content.trim()) };
    if (content.trim()) return { ...base, hook_event_name: "TranscriptResponse", prompt_id: turn.id, last_assistant_message: limited(content.trim()) };
    return null;
  }
}

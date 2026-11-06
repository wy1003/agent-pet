import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const MAX_BYTES = 1024 * 1024;
const DEFAULT_RETENTION = { maxFiles: 2048, maxBytes: 64 * MAX_BYTES, maxAgeMs: 7 * 24 * 60 * 60 * 1000 };
const EVENT_NAME = /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}\.json$/;

function policy(options) {
  return Object.fromEntries(Object.entries(DEFAULT_RETENTION).map(([key, limit]) => {
    const value = options?.[key] ?? limit;
    if (!Number.isSafeInteger(value) || value < 1 || value > limit) throw new Error("Invalid retention budget");
    return [key, value];
  }));
}

// A directory lock serializes reservation + rename across independent hook processes.
// Never steal a lock: an interrupted writer may require local cleanup, but cannot
// cause another writer to delete its temporary file or bypass the inbox budget.
async function lockDirectory(directory) {
  const lock = path.join(directory, ".agent-pet-hook.lock");
  const deadline = Date.now() + 2000;
  for (;;) {
    try { await mkdir(lock); return lock; }
    catch (error) {
      // Windows can briefly reject mkdir while another writer removes the lock.
      // Retry only known contention errors; never remove a lock we do not own.
      const contended = error.code === "EEXIST"
        || (process.platform === "win32" && ["EPERM", "EBUSY"].includes(error.code));
      if (!contended || Date.now() >= deadline) throw Object.assign(new Error("Hook inbox busy", { cause: error }), { code: error.code });
      await delay(10);
    }
  }
}

async function reserve(directory, retention, bytes, now) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !EVENT_NAME.test(entry.name)) continue;
    const file = path.join(directory, entry.name);
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) continue;
      const handle = await open(file, "r");
      let buffer;
      try {
        buffer = Buffer.alloc(Math.min(info.size + 1, MAX_BYTES + 1));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        buffer = buffer.subarray(0, bytesRead);
      } finally { await handle.close(); }
      if (buffer.length > MAX_BYTES) continue;
      let event;
      try { event = JSON.parse(buffer.toString("utf8")); } catch { continue; }
      if (!event || (event.agent_pet_bridge != null && event.agent_pet_bridge !== 1) || `${event.event_id}.json` !== entry.name
        || typeof event.session_id !== "string" || !event.session_id.trim() || !Number.isFinite(Date.parse(event.timestamp))) continue;
      const timestamp = Date.parse(event.timestamp);
      if (now - timestamp > retention.maxAgeMs) await rm(file, { force: true });
      else files.push({ file, size: info.size, timestamp });
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  files.sort((a, b) => a.timestamp - b.timestamp || a.file.localeCompare(b.file));
  let total = files.reduce((sum, file) => sum + file.size, bytes);
  while (files.length >= retention.maxFiles || total > retention.maxBytes) {
    const oldest = files.shift();
    await rm(oldest.file, { force: true });
    total -= oldest.size;
  }
}

export async function writeHookEvent(input, { eventsDir, env = process.env, now = Date.now, retention: options } = {}) {
  if (env.AGENT_PET_AUXILIARY === "1") return null;
  if (!input || Array.isArray(input) || typeof input !== "object"
    || typeof input.session_id !== "string" || !input.session_id.trim()) {
    throw new Error("Hook event requires session_id");
  }
  if (!eventsDir) throw new Error("--events-dir is required");
  const timestamp = now();
  const event = { ...input, agent_pet_bridge: 1, event_id: randomUUID(), timestamp: new Date(timestamp).toISOString() };
  const data = JSON.stringify(event), bytes = Buffer.byteLength(data);
  if (bytes > MAX_BYTES) throw new Error("Hook event exceeds 1 MiB");
  const retention = policy(options);
  if (bytes > retention.maxBytes) throw new Error("Hook event exceeds retention byte budget");
  const directory = path.resolve(eventsDir);
  await mkdir(directory, { recursive: true });
  const lock = await lockDirectory(directory);
  const file = path.join(directory, `${event.event_id}.json`);
  const temporary = path.join(directory, `.${randomUUID()}.tmp`);
  try {
    await reserve(directory, retention, bytes, new Date(timestamp).getTime());
    await writeFile(temporary, data, { flag: "wx", mode: 0o600 });
    await rename(temporary, file);
  } finally {
    try { await rm(temporary, { force: true }); }
    finally { await rm(lock, { recursive: true, force: true }); }
  }
  return file;
}

async function main() {
  if (process.env.AGENT_PET_AUXILIARY === "1") return;
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--events-dir" || !args[1]) {
    throw new Error("Usage: hook-bridge.mjs --events-dir PATH");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error("Hook stdin exceeds 1 MiB");
    chunks.push(chunk);
  }
  await writeHookEvent(JSON.parse(Buffer.concat(chunks).toString("utf8")), { eventsDir: args[1] });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => {
    process.stderr.write("Agent Pet hook bridge: hook_event_rejected\n");
    process.exitCode = 1;
  });
}

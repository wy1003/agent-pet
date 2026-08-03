import { appendFile, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

const HISTORY_SUFFIX = ".jsonl";

function cleanText(value, limit) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function normalizedRecord(value = {}) {
  const timestamp = new Date(value.updatedAt || value.createdAt || Date.now());
  const iso = Number.isNaN(timestamp.getTime()) ? new Date().toISOString() : timestamp.toISOString();
  return {
    version: 2,
    id: cleanText(value.id, 160),
    createdAt: cleanText(value.createdAt || iso, 40),
    updatedAt: iso,
    source: value.source === "test" ? "test" : "task",
    taskId: cleanText(value.taskId, 300),
    taskTitle: cleanText(value.taskTitle, 160),
    projectName: cleanText(value.projectName, 100),
    event: cleanText(value.event, 40),
    text: cleanText(value.text, 220),
    result: cleanText(value.result, 40),
    reason: cleanText(value.reason, 300),
    windows: cleanText(value.windows, 40),
    voice: cleanText(value.voice, 40),
    remote: cleanText(value.remote, 40),
    remoteProvider: cleanText(value.remoteProvider, 40),
    remoteAttempts: Math.max(0, Math.min(99, Number(value.remoteAttempts || 0))),
  };
}

function monthName(iso) {
  return String(iso).slice(0, 7);
}

export class NotificationHistoryStore {
  constructor(rootPath) {
    this.rootPath = path.resolve(rootPath);
    this.writeQueue = Promise.resolve();
  }

  async append(value) {
    const record = normalizedRecord(value);
    if (!record.id) throw new Error("通知记录缺少 ID");
    const filePath = path.join(this.rootPath, `${monthName(record.updatedAt)}${HISTORY_SUFFIX}`);
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(this.rootPath, { recursive: true });
      await appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
    });
    await this.writeQueue;
    return record;
  }

  async list(options = {}) {
    await this.writeQueue;
    const limit = Math.max(1, Math.min(1000, Number(options.limit || 100)));
    let files;
    try {
      files = (await readdir(this.rootPath, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith(HISTORY_SUFFIX))
        .map((entry) => entry.name)
        .sort()
        .reverse();
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }

    const latest = new Map();
    for (const file of files) {
      const lines = (await readFile(path.join(this.rootPath, file), "utf8")).split(/\r?\n/);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (!lines[index]) continue;
        try {
          const record = normalizedRecord(JSON.parse(lines[index]));
          if (record.id && !latest.has(record.id)) latest.set(record.id, record);
        } catch {}
      }
      if (latest.size >= limit) break;
    }
    return [...latest.values()]
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, limit);
  }

  async ensureDirectory() {
    await mkdir(this.rootPath, { recursive: true });
    return this.rootPath;
  }

  async clear() {
    await this.writeQueue;
    await rm(this.rootPath, { recursive: true, force: true });
    await mkdir(this.rootPath, { recursive: true });
    return { ok: true };
  }
}

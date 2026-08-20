import { spawn } from "node:child_process";
import { access, open, readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const DEFAULT_CACHE_MS = 60_000;
const DEFAULT_QUERY_TIMEOUT_MS = 15_000;
const MAX_SESSION_FILES = 120;
const MAX_TAIL_BYTES = 512 * 1024;

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizePlanLabel(value) {
  const plan = String(value || "").trim().toLowerCase();
  if (!plan || plan === "unknown") return "";
  const labels = {
    free: "Free",
    go: "Go",
    plus: "Plus",
    pro: "Pro",
    prolite: "Pro",
    team: "Team",
    business: "Business",
    enterprise: "Enterprise",
    edu: "Edu",
  };
  return labels[plan] || plan.replace(/(^|[_-])([a-z])/g, (_match, prefix, letter) => (
    `${prefix ? " " : ""}${letter.toUpperCase()}`
  ));
}

function normalizeWindow(value, id) {
  if (!value || typeof value !== "object") return null;
  const usedPercent = finiteNumber(value.usedPercent ?? value.used_percent);
  const windowMinutes = finiteNumber(value.windowDurationMins ?? value.window_minutes);
  const resetsAtSeconds = finiteNumber(value.resetsAt ?? value.resets_at);
  if (usedPercent === null && windowMinutes === null && resetsAtSeconds === null) return null;
  const normalizedUsed = Math.max(0, Math.min(100, usedPercent ?? 0));
  return {
    id,
    usedPercent: normalizedUsed,
    remainingPercent: Math.max(0, 100 - normalizedUsed),
    windowMinutes,
    resetsAt: resetsAtSeconds === null ? null : new Date(resetsAtSeconds * 1000).toISOString(),
  };
}

function normalizeCredits(value) {
  if (!value || typeof value !== "object") return null;
  return {
    hasCredits: Boolean(value.hasCredits ?? value.has_credits),
    unlimited: Boolean(value.unlimited),
    balance: value.balance === null || value.balance === undefined ? null : String(value.balance),
  };
}

function rateLimitId(value) {
  return String(value?.limitId ?? value?.limit_id ?? "").trim().toLowerCase();
}

function rateLimitName(value) {
  return String(value?.limitName ?? value?.limit_name ?? "").trim();
}

export function isGeneralCodexRateLimit(value, key = "") {
  const id = rateLimitId(value) || String(key || "").trim().toLowerCase();
  const name = rateLimitName(value).toLowerCase();
  return id === "codex" || (!name && !id.includes("bengalfox"));
}

export function selectGeneralCodexRateLimit(response) {
  const byId = response?.rateLimitsByLimitId ?? response?.rate_limits_by_limit_id;
  if (byId && typeof byId === "object") {
    if (byId.codex) return byId.codex;
    const entry = Object.entries(byId).find(([key, value]) => isGeneralCodexRateLimit(value, key));
    if (entry) return entry[1];
  }
  const legacy = response?.rateLimits ?? response?.rate_limits;
  return isGeneralCodexRateLimit(legacy) ? legacy : null;
}

export function normalizeCodexRateLimits(rateLimits, timestamp) {
  if (!rateLimits || typeof rateLimits !== "object") return null;
  const windows = [
    normalizeWindow(rateLimits.primary, "primary"),
    normalizeWindow(rateLimits.secondary, "secondary"),
  ].filter(Boolean);
  if (!windows.length && !rateLimits.credits) return null;
  const syncedAt = Number.isFinite(Date.parse(timestamp))
    ? new Date(timestamp).toISOString()
    : new Date().toISOString();
  return {
    providerId: "codex",
    viewType: "codex-quota",
    status: "ready",
    displayName: "Codex",
    limitScope: "general",
    limitId: rateLimitId(rateLimits) || "codex",
    planLabel: normalizePlanLabel(rateLimits.planType ?? rateLimits.plan_type),
    limitName: "",
    windows,
    credits: normalizeCredits(rateLimits.credits),
    syncedAt,
  };
}

function platformCodexPackage() {
  const key = `${process.platform}-${process.arch}`;
  return {
    "darwin-arm64": ["@openai/codex-darwin-arm64", "aarch64-apple-darwin", "codex"],
    "darwin-x64": ["@openai/codex-darwin-x64", "x86_64-apple-darwin", "codex"],
    "linux-arm64": ["@openai/codex-linux-arm64", "aarch64-unknown-linux-gnu", "codex"],
    "linux-x64": ["@openai/codex-linux-x64", "x86_64-unknown-linux-musl", "codex"],
    "win32-arm64": ["@openai/codex-win32-arm64", "aarch64-pc-windows-msvc", "codex.exe"],
    "win32-x64": ["@openai/codex-win32-x64", "x86_64-pc-windows-msvc", "codex.exe"],
  }[key] || null;
}

function unpackedAsarPath(value) {
  return value.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
}

async function installedCodexCandidates() {
  if (process.platform !== "win32" || !process.env.LOCALAPPDATA) return [];
  const root = path.join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin");
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const candidates = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const executable = path.join(root, entry.name, "codex.exe");
    const information = await stat(executable).catch(() => null);
    return information ? { executable, modifiedAt: information.mtimeMs } : null;
  }));
  return candidates.filter(Boolean)
    .sort((left, right) => right.modifiedAt - left.modifiedAt)
    .map((entry) => entry.executable);
}

export async function resolveCodexExecutable(explicitPath = "") {
  const candidates = [];
  if (explicitPath) candidates.push(path.resolve(explicitPath));
  if (process.env.AGENT_PET_CODEX_EXECUTABLE) {
    candidates.push(path.resolve(process.env.AGENT_PET_CODEX_EXECUTABLE));
  }
  const platformPackage = platformCodexPackage();
  if (platformPackage) {
    try {
      const [packageName, target, executableName] = platformPackage;
      const packageRoot = path.dirname(require.resolve(`${packageName}/package.json`));
      candidates.push(unpackedAsarPath(path.join(
        packageRoot,
        "vendor",
        target,
        "bin",
        executableName,
      )));
    } catch {
      // The optional platform package may be unavailable on unsupported installations.
    }
  }
  candidates.push(...await installedCodexCandidates());
  for (const candidate of candidates) {
    if (candidate && await access(candidate).then(() => true).catch(() => false)) return candidate;
  }
  return process.platform === "win32" ? "codex.exe" : "codex";
}

export async function readCodexAccountRateLimits(options = {}) {
  const executable = await resolveCodexExecutable(options.executablePath);
  const timeoutMs = Math.max(1_000, Number(options.timeoutMs) || DEFAULT_QUERY_TIMEOUT_MS);
  const spawnProcess = options.spawnProcess || spawn;
  return new Promise((resolve, reject) => {
    const child = spawnProcess(executable, ["app-server", "--stdio"], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let settled = false;
    let stdout = "";
    let stderr = "";
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin?.end();
      child.kill();
      if (error) reject(error);
      else resolve(value);
    };
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const timer = setTimeout(() => {
      finish(new Error("Codex 额度查询超时"));
    }, timeoutMs);
    child.once("error", (error) => finish(error));
    child.stderr?.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-2_000);
    });
    child.once("exit", (code) => {
      if (!settled) finish(new Error(stderr.trim() || `Codex app-server 已退出（${code}）`));
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      let newline = stdout.indexOf("\n");
      while (newline >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        newline = stdout.indexOf("\n");
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1) {
          send({ method: "initialized" });
          send({ id: 2, method: "account/rateLimits/read", params: null });
        } else if (message.id === 2) {
          if (message.error) finish(new Error(message.error.message || "Codex 额度查询失败"));
          else finish(null, message.result || {});
        }
      }
    });
    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "agent-pet", title: "Agent Pet", version: "0.1.1" },
        capabilities: { experimentalApi: true },
      },
    });
  });
}

async function sessionFiles(codexHome) {
  const sessionsRoot = path.join(codexHome, "sessions");
  const years = await readdir(sessionsRoot, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const year of years.filter((entry) => entry.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) {
    const yearPath = path.join(sessionsRoot, year.name);
    const months = await readdir(yearPath, { withFileTypes: true }).catch(() => []);
    for (const month of months.filter((entry) => entry.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) {
      const monthPath = path.join(yearPath, month.name);
      const days = await readdir(monthPath, { withFileTypes: true }).catch(() => []);
      for (const day of days.filter((entry) => entry.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) {
        const dayPath = path.join(monthPath, day.name);
        const entries = await readdir(dayPath, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
            files.push(path.join(dayPath, entry.name));
          }
        }
        if (files.length >= MAX_SESSION_FILES) break;
      }
      if (files.length >= MAX_SESSION_FILES) break;
    }
    if (files.length >= MAX_SESSION_FILES) break;
  }
  return files.sort((left, right) => path.basename(right).localeCompare(path.basename(left)))
    .slice(0, MAX_SESSION_FILES);
}

async function readTail(filePath) {
  const fileStat = await stat(filePath);
  const length = Math.min(fileStat.size, MAX_TAIL_BYTES);
  if (!length) return "";
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, fileStat.size - length);
    let text = buffer.toString("utf8");
    if (fileStat.size > length) text = text.slice(text.indexOf("\n") + 1);
    return text;
  } finally {
    await handle.close();
  }
}

async function latestGeneralRateLimitSnapshot(codexHome) {
  let latest = null;
  for (const filePath of await sessionFiles(codexHome)) {
    const lines = (await readTail(filePath).catch(() => "")).split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (!lines[index].includes("rate_limits")) continue;
      try {
        const event = JSON.parse(lines[index]);
        const rateLimits = event?.payload?.rate_limits || event?.payload?.info?.rate_limits;
        if (!isGeneralCodexRateLimit(rateLimits)) continue;
        const normalized = normalizeCodexRateLimits(rateLimits, event?.timestamp);
        if (!normalized) continue;
        if (!latest || Date.parse(normalized.syncedAt) > Date.parse(latest.syncedAt)) latest = normalized;
        break;
      } catch {
        // Ignore a partially-written JSONL line and continue with the previous complete event.
      }
    }
  }
  return latest;
}

function emptySnapshot(status = "empty") {
  return {
    providerId: "codex",
    viewType: "codex-quota",
    status,
    displayName: "Codex",
    limitScope: "general",
    message: status === "error"
      ? "暂时无法读取 Codex 通用额度，请稍后刷新。"
      : "尚未读取到 Codex 通用额度。",
    windows: [],
    syncedAt: null,
  };
}

export class CodexUsageProvider {
  constructor({
    codexHome,
    cacheMs = DEFAULT_CACHE_MS,
    now = () => Date.now(),
    readRateLimits = readCodexAccountRateLimits,
    executablePath = "",
  }) {
    this.id = "codex";
    this.codexHome = codexHome;
    this.cacheMs = cacheMs;
    this.now = now;
    this.readRateLimits = readRateLimits;
    this.executablePath = executablePath;
    this.cachedAt = 0;
    this.cachedValue = null;
  }

  async getUsage({ force = false } = {}) {
    if (!force && this.cachedValue && this.now() - this.cachedAt < this.cacheMs) {
      return this.cachedValue;
    }
    let queryFailed = false;
    let nextValue = null;
    try {
      const response = await this.readRateLimits({ executablePath: this.executablePath });
      const general = selectGeneralCodexRateLimit(response);
      nextValue = normalizeCodexRateLimits(general, new Date(this.now()).toISOString());
    } catch {
      queryFailed = true;
    }
    if (!nextValue) {
      nextValue = await latestGeneralRateLimitSnapshot(this.codexHome).catch(() => null)
        || emptySnapshot(queryFailed ? "error" : "empty");
    }
    this.cachedValue = nextValue;
    this.cachedAt = this.now();
    return this.cachedValue;
  }
}

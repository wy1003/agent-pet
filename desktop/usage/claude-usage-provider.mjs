import { readFile, stat } from "node:fs/promises";

const WINDOWS = [
  ["five_hour", "primary", 300],
  ["seven_day", "secondary", 10_080],
];
const finite = (value) => typeof value === "number" && Number.isFinite(value);

function snapshot(value, now, maxAgeMs, source) {
  const base = {
    providerId: "claude", displayName: "Claude Code", viewType: "claude-quota",
    status: "unavailable", limitScope: "general", limitId: "claude", planLabel: "",
    windows: [], credits: null, syncedAt: null, source,
    message: "尚无可靠的 Claude 配额数据。可启用额度采集，或等待受控会话返回配额事件。",
  };
  const captured = Date.parse(value?.capturedAt || "");
  if (!Number.isFinite(captured) || captured > now + 60_000) return base;
  base.syncedAt = new Date(captured).toISOString();
  if (now - captured > maxAgeMs) {
    return { ...base, status: "stale", message: "Claude 配额数据已过期，等待新的采集数据。" };
  }
  for (const [key, id, windowMinutes] of WINDOWS) {
    const window = value?.rate_limits?.[key];
    if (!window || !finite(window.used_percentage) || window.used_percentage < 0 || window.used_percentage > 100) continue;
    const reset = window.resets_at;
    if (reset != null && (!finite(reset) || reset * 1000 <= now || reset * 1000 > 8.64e15)) continue;
    base.windows.push({ id, usedPercent: window.used_percentage, remainingPercent: 100 - window.used_percentage,
      windowMinutes, resetsAt: reset == null ? null : new Date(reset * 1000).toISOString() });
  }
  if (base.windows.length) {
    base.status = "ready";
    base.message = "配额来自 Claude Code 观测数据；不是账单或按 token 推算的余额。";
  }
  return base;
}

export class ClaudeUsageProvider {
  constructor({ usagePath, readUsage, now = () => Date.now(), cacheMs = 15_000, maxAgeMs = 300_000 } = {}) {
    this.id = "claude";
    this.now = now;
    this.cacheMs = cacheMs;
    this.maxAgeMs = maxAgeMs;
    this.cachedAt = null;
    this.cached = null;
    this.observed = null;
    this.readUsage = readUsage || (async () => {
      if (!usagePath) return null;
      try {
        if ((await stat(usagePath)).size > 1024 * 1024) throw new Error("usage_file_too_large");
        return JSON.parse(await readFile(usagePath, "utf8"));
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    });
  }

  recordRateLimit(event) {
    const info = event?.rate_limit_info;
    if (!WINDOWS.some(([key]) => key === info?.rateLimitType) || !finite(info.utilization) || info.utilization < 0 || info.utilization > 1) return;
    this.observed = { capturedAt: new Date(this.now()).toISOString(), rate_limits: {
      [info.rateLimitType]: { used_percentage: info.utilization * 100, resets_at: info.resetsAt },
    } };
  }

  async getUsage({ force = false } = {}) {
    const now = this.now();
    let readFailure = null;
    if (force || this.cachedAt === null || now - this.cachedAt >= this.cacheMs) {
      try {
        this.cached = await this.readUsage();
        this.cachedAt = now;
      } catch (error) {
        this.cached = null;
        this.cachedAt = null;
        const status = error?.status;
        readFailure = status === 401 ? "claude_usage_authentication"
          : status === 403 ? "claude_usage_forbidden"
          : error instanceof SyntaxError ? "claude_usage_invalid_json" : "claude_usage_read_failed";
      }
    }
    const useObserved = this.observed && (!this.cached || Date.parse(this.observed.capturedAt) >= Date.parse(this.cached.capturedAt || ""));
    const result = snapshot(useObserved ? this.observed : this.cached, now, this.maxAgeMs, useObserved ? "sdk" : "statusline");
    if (readFailure) {
      const diagnostic = { code: readFailure };
      if (result.status === "ready") return { ...result, diagnostic };
      const auth = ["claude_usage_authentication", "claude_usage_forbidden"].includes(readFailure);
      return { ...result, diagnostic, status: auth ? "auth_required" : "error",
        message: auth ? "Claude 配额认证失效或访问被拒绝，请检查登录与授权状态。"
          : readFailure === "claude_usage_invalid_json" ? "Claude 配额采集文件格式无效，等待新的采集数据。"
          : "无法读取 Claude 配额采集文件，请检查本地连接配置。" };
    }
    return result;
  }
}

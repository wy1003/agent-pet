import * as fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CodexRpc } from "../../ai/codex-rpc.mjs";
import { resolveCodexExecutable } from "../../codex-runtime.mjs";

const NAME = "agent-pet-notebook";
const matches = (entry, desired) => entry?.command === desired.command
  && JSON.stringify(entry.args) === JSON.stringify(desired.args)
  && entry.env?.ELECTRON_RUN_AS_NODE === "1" && entry.enabled !== false
  && (!entry.environment_id || entry.environment_id === "local");

/** Configures one MCP entry through Codex's own version-checked configuration API. */
export class NotebookCodexConnection {
  #pending = null;
  constructor({ getConfig, workingDirectory, resolveExecutable = resolveCodexExecutable,
    createRpc = (file, options) => new CodexRpc(file, options), io = fs }) {
    Object.assign(this, { getConfig, workingDirectory, resolveExecutable, createRpc, io });
  }
  async #session(operation) {
    const executable = await this.resolveExecutable();
    const rpc = this.createRpc(executable, { cwd: this.workingDirectory, timeoutMs: 15_000 });
    try { await rpc.initialize(); return await operation(rpc); }
    finally { rpc.close(); }
  }
  async #read(rpc) {
    return rpc.request("config/read", { includeLayers: true, cwd: this.workingDirectory });
  }
  async status() {
    return this.#session(async rpc => {
      const read = await this.#read(rpc), desired = this.getConfig().mcpServers[NAME];
      return { configured: matches(read.config?.mcp_servers?.[NAME], desired) };
    });
  }
  connect() {
    if (!this.#pending) this.#pending = this.#session(async rpc => {
      const read = await this.#read(rpc), desired = this.getConfig().mcpServers[NAME];
      const existing = read.config?.mcp_servers?.[NAME];
      if (matches(existing, desired)) return { configured: true, changed: false };
      if (existing && (existing.url || !String(existing.args?.[0] || "").replaceAll("\\", "/").endsWith("/notebook/mcp/stdio.mjs"))) {
        throw new Error("Codex 中同名连接已用于其他服务。请先重命名该连接，再重试。");
      }
      const layer = read.layers?.find(item => item.name?.type === "user" && !item.name.profile);
      if (!layer?.name.file || !layer.version) throw new Error("当前 Codex 未提供可写的用户配置，请更新 Codex 后重试，或使用复制配置。");
      let backup = "";
      let contents;
      try { contents = await this.io.readFile(layer.name.file); }
      catch (error) { if (error.code !== "ENOENT") throw new Error("无法备份 Codex 配置，未进行修改。请检查目录权限。"); }
      try {
        if (contents !== undefined) {
          const directory = path.join(this.workingDirectory, "mcp-config-backups");
          await this.io.mkdir(directory, { recursive: true });
          backup = path.join(directory, `codex-${Date.now()}-${randomUUID()}.toml`);
          await this.io.writeFile(backup, contents, { flag: "wx", mode: 0o600 });
        }
      } catch { throw new Error("无法备份 Codex 配置，未进行修改。请检查目录权限。"); }
      const fields = { command: desired.command, args: desired.args, "env.ELECTRON_RUN_AS_NODE": "1", enabled: true, environment_id: "local" };
      const result = await rpc.request("config/batchWrite", {
        filePath: layer.name.file, expectedVersion: layer.version,
        edits: Object.entries(fields).map(([key, value]) => ({ keyPath: `mcp_servers.${NAME}.${key}`, value, mergeStrategy: "replace" })),
      });
      const after = await this.#read(rpc);
      if (result.status !== "ok" || !matches(after.config?.mcp_servers?.[NAME], desired)) {
        throw new Error("配置已写入，但被其他 Codex 配置覆盖。请在 Codex 中检查连接状态。");
      }
      return { configured: true, changed: true, backup };
    }).finally(() => { this.#pending = null; });
    return this.#pending;
  }
}

export function installNotebookConnectionIpc({ ipcMain, requireSettingsMainFrame, getConnection }) {
  ipcMain.handle("notebook:codex-connection", async (event, action) => {
    requireSettingsMainFrame(event);
    if (!["status", "connect"].includes(action)) throw new Error("不支持的连接操作。");
    try { return { ok: true, ...await getConnection()[action]() }; }
    catch (error) {
      // Do not forward raw config diagnostics, which can contain unrelated credentials.
      const message = /^(Codex 中同名连接|当前 Codex 未提供|无法备份 Codex 配置|配置已写入)/.test(error.message) ? error.message
        : action === "status" ? "暂时无法检查 Codex 配置，可点击连接重试。"
          : "配置未能完成。请确认 Codex 已安装且配置有效，然后重试；也可使用复制配置。";
      return { ok: false, message };
    }
  });
}

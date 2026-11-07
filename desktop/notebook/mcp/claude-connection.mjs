import { getClaudeNotebookStatus, installClaudeNotebook } from "../../claude/integration.mjs";

/** MCP-only host facade. Integration owns config scope, detection and safe writes. */
export class NotebookClaudeConnection {
  #pending = null;
  constructor({ getConfig, getOptions = () => ({}),
    integration = { status: getClaudeNotebookStatus, install: installClaudeNotebook } }) {
    Object.assign(this, { getConfig, getOptions, integration });
  }
  async #options() {
    return { ...await this.getOptions(), notebookMcpConfig: this.getConfig().mcpServers["agent-pet-notebook"] };
  }
  async status() {
    return this.integration.status(await this.#options());
  }
  connect() {
    if (!this.#pending) this.#pending = Promise.resolve().then(async () =>
      this.integration.install(await this.#options())
    ).finally(() => { this.#pending = null; });
    return this.#pending;
  }
}

const messages = {
  installed: "记事板配置已就绪。请新开 Claude Code 会话或重载扩展；使用时保持 Agent Pet 运行。",
  "not-installed": "尚未配置记事板。可点击一键连接 Claude Code。",
  "not-detected": "未检测到 Claude Code 的用户配置。请先安装并启动 Claude Code，再重试。",
  conflict: "Claude Code 记事板配置存在同名连接或管理记录冲突，未覆盖现有配置。请检查并处理冲突后重试。",
  error: "暂时无法完成 Claude Code 配置操作。请检查配置文件是否有效、目录权限是否可写，并确认 Agent Pet 记事板已就绪后重试。",
};
function publicResult(result) {
  // Only host-owned diagnostics cross IPC; even backup paths stay in the main process.
  const state = Object.hasOwn(messages, result?.state) ? result.state : "error";
  return { ok: result?.ok === true && state !== "error" && state !== "conflict", state,
    configured: state === "installed" && result?.configured === true,
    changed: result?.changed === true, message: messages[state] };
}

export function installNotebookClaudeConnectionIpc({ ipcMain, requireSettingsMainFrame, getConnection }) {
  let pending = null;
  ipcMain.handle("notebook:claude-connection", async (event, action) => {
    requireSettingsMainFrame(event);
    if (!["status", "connect"].includes(action)) throw new Error("不支持的连接操作。");
    if (action === "status") {
      try { return publicResult(await getConnection().status()); }
      catch { return publicResult({ ok: false, state: "error" }); }
    }
    // Coalesce direct installs. Every caller is authorized above, including repeats.
    if (!pending) pending = Promise.resolve().then(async () => {
      try {
        return publicResult(await getConnection().connect());
      } catch { return publicResult({ ok: false, state: "error" }); }
    }).finally(() => { pending = null; });
    return pending;
  });
}

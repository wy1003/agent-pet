import { mkdir } from "node:fs/promises";
import { resolveCodexExecutable } from "../codex-runtime.mjs";
import { CodexRpc } from "./codex-rpc.mjs";
import { aiError } from "./errors.mjs";

export class CodexTextProvider {
  constructor({ workingDirectory, resolveExecutable = resolveCodexExecutable, createRpc = (file, options) => new CodexRpc(file, options) }) {
    this.workingDirectory = workingDirectory;
    this.resolveExecutable = resolveExecutable;
    this.createRpc = createRpc;
  }

  async open(_config, { signal } = {}) {
    await mkdir(this.workingDirectory, { recursive: true });
    const executable = await this.resolveExecutable();
    signal?.throwIfAborted();
    const rpc = this.createRpc(executable, { cwd: this.workingDirectory, signal });
    try {
      const initialized = await rpc.initialize();
      const configuration = await rpc.request("config/read", { includeLayers: false, cwd: this.workingDirectory });
      const auth = await rpc.request("account/read", { refreshToken: false });
      if (auth.requiresOpenaiAuth && !auth.account) throw aiError("authentication", "Codex 尚未登录，请先在 Codex 中登录后重新检查。");
      const config = configuration.config || {};
      const models = [];
      let cursor = null;
      const cursors = new Set();
      do {
        const page = await rpc.request("model/list", { limit: 100, includeHidden: true, cursor });
        if (!Array.isArray(page.data)) throw aiError("catalog_invalid", "Codex 未返回有效模型列表，请检查运行程序版本。");
        for (const entry of page.data) {
          const id = String(entry.model || entry.id || "");
          if (!id || models.some((item) => item.id === id)) continue;
          models.push({
            id, name: String(entry.displayName || id), isDefault: entry.isDefault === true,
            efforts: (entry.supportedReasoningEfforts || []).map((item) => item.reasoningEffort),
            defaultEffort: entry.defaultReasoningEffort,
          });
        }
        cursor = page.nextCursor || null;
        if (cursor && (cursors.has(cursor) || cursors.size >= 100)) throw aiError("catalog_invalid", "Codex 模型列表分页异常。");
        if (cursor) cursors.add(cursor);
      } while (cursor);
      const runtimeVersion = String(initialized.userAgent || "").match(/\d+\.\d+\.\d+[^\s)]*/)?.[0] || "";
      const defaultModelId = config.models?.new_thread?.model || config.model || models.find((item) => item.isDefault)?.id || "";
      const modelProvider = config.model_provider || "openai";
      return {
        catalog: { models, defaultModelId, runtimeVersion, modelProvider, name: "Codex" },
        generate: async ({ model, prompt, schema, signal: requestSignal }) => {
          requestSignal?.throwIfAborted();
          const started = await rpc.request("thread/start", {
            cwd: this.workingDirectory, model: model.id, modelProvider,
            approvalPolicy: "never", sandbox: "read-only", ephemeral: true,
            developerInstructions: "仅根据用户提供的文字生成指定 JSON。不要调用工具、读取文件或执行命令。",
            config: { web_search: "disabled", "features.shell_tool": false },
          });
          if (started.model !== model.id || started.modelProvider !== modelProvider) {
            throw aiError("model_changed", "Codex 实际选择的模型或服务与检查结果不一致，请重新检查连接。");
          }
          const threadId = started.thread?.id;
          if (!threadId) throw aiError("invalid_response", "Codex 未返回有效会话。");
          let finalText = "";
          let settle;
          let fail;
          const completed = new Promise((resolve, reject) => { settle = resolve; fail = reject; });
          // A completion notification can arrive before turn/start's response.
          const onNotification = ({ method, params }) => {
            if (params?.threadId !== threadId) return;
            if (method === "item/completed" && params.item?.type === "agentMessage") finalText = params.item.text || "";
            if (method === "turn/completed") {
              if (params.turn?.status === "completed") settle(finalText);
              else fail(new Error(params.turn?.error?.message || "Codex generation failed"));
            }
            if (method === "error" && !params.willRetry) fail(new Error(params.error?.message || "Codex generation failed"));
          };
          rpc.on("notification", onNotification);
          rpc.once("closed", fail);
          // Attach rejection handler immediately, including if turn/start fails.
          completed.catch(() => {});
          try {
            await rpc.request("turn/start", {
              threadId, input: [{ type: "text", text: prompt }], outputSchema: schema,
              ...(model.efforts.includes("low") ? { effort: "low" } : model.defaultEffort ? { effort: model.defaultEffort } : {}),
            });
            return { text: await completed };
          } finally {
            rpc.off("notification", onNotification);
            rpc.off("closed", fail);
          }
        },
        close: () => rpc.close(),
      };
    } catch (error) { rpc.close(); throw error; }
  }
}

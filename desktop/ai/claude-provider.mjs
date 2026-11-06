import { mkdir } from "node:fs/promises";
import { aiError } from "./errors.mjs";

export class ClaudeTextProvider {
  constructor({ workingDirectory, query, executablePath = "" }) {
    Object.assign(this, { workingDirectory, query, executablePath });
  }

  async open(_config, { signal } = {}) {
    signal?.throwIfAborted();
    await mkdir(this.workingDirectory, { recursive: true });
    const query = this.query || (await import("@anthropic-ai/claude-agent-sdk")).query;
    signal?.throwIfAborted();
    const options = {
      cwd: this.workingDirectory, tools: [], mcpServers: {}, strictMcpConfig: true,
      settingSources: ["user"], settings: { disableAllHooks: true },
      skills: [], persistSession: false, permissionMode: "dontAsk",
      env: { ...process.env, AGENT_PET_AUXILIARY: "1" },
      systemPrompt: "仅根据用户提供的文字生成指定 JSON。不要调用工具、读取文件或执行命令。",
      ...(this.executablePath ? { pathToClaudeCodeExecutable: this.executablePath } : {}),
    };
    // Hold stdin open for metadata only; checking a connection never sends a prompt.
    let releaseInput;
    const inputClosed = new Promise((resolve) => { releaseInput = resolve; });
    const prompt = (async function* () { await inputClosed; })();
    const catalogController = new AbortController();
    const inspection = query({ prompt, options: { ...options, abortController: catalogController } });
    const cancelInspection = () => { catalogController.abort(); inspection.close(); releaseInput(); };
    signal?.addEventListener("abort", cancelInspection, { once: true });
    let models;
    try {
      signal?.throwIfAborted();
      const [available, account] = await Promise.all([inspection.supportedModels(), inspection.accountInfo()]);
      signal?.throwIfAborted();
      if (!account?.tokenSource && !account?.apiKeySource && !account?.email) {
        throw aiError("authentication", "Claude Code 尚未提供登录信息，请先检查 Claude Code 登录状态。");
      }
      if (!Array.isArray(available)) throw aiError("catalog_invalid", "Claude Code 未返回有效模型列表，请检查运行程序版本。");
      models = [{ id: "default", name: "跟随 Claude Code 默认模型", efforts: [] }];
      for (const entry of available) {
        if (!entry.value || models.some((item) => item.id === entry.value)) continue;
        models.push({ id: entry.value, name: entry.displayName || entry.value,
          resolvedModel: entry.resolvedModel, efforts: entry.supportedEffortLevels || [] });
      }
    } finally {
      signal?.removeEventListener("abort", cancelInspection);
      releaseInput();
      inspection.close();
    }
    let closed = false;
    const active = new Set();
    return {
      catalog: { models, defaultModelId: "default", name: "Claude Code", modelProvider: "claude", runtimeVersion: "" },
      generate: async ({ model, prompt: text, schema, signal: requestSignal }) => {
        if (closed) throw aiError("cancelled", "Claude 文本连接已关闭。");
        requestSignal?.throwIfAborted();
        const abortController = new AbortController();
        const running = query({ prompt: text, options: { ...options, abortController,
          ...(model.id !== "default" ? { model: model.id } : {}),
          outputFormat: { type: "json_schema", schema },
        } });
        const operation = { abortController, running };
        active.add(operation);
        const abort = () => { abortController.abort(); running.close(); };
        requestSignal?.addEventListener("abort", abort, { once: true });
        try {
          requestSignal?.throwIfAborted();
          for await (const event of running) {
            requestSignal?.throwIfAborted();
            if (event.type === "system" && event.subtype === "init" && model.id !== "default"
              && event.model && ![model.id, model.resolvedModel].includes(event.model)) {
              throw aiError("model_changed", "Claude 实际模型与选择不一致，请重新检查连接。");
            }
            if (event.type !== "result") continue;
            if (event.subtype !== "success" || event.is_error) {
              throw aiError("invalid_response", "Claude 文本生成未成功，请检查连接或额度后重试。");
            }
            if (event.structured_output !== undefined) return { text: JSON.stringify(event.structured_output) };
            if (typeof event.result === "string" && event.result.trim()) return { text: event.result };
            break;
          }
          throw aiError("invalid_response", "Claude 未返回完整生成结果。");
        } finally {
          requestSignal?.removeEventListener("abort", abort);
          active.delete(operation);
          running.close();
        }
      },
      close: () => {
        closed = true;
        for (const { abortController, running } of active) { abortController.abort(); running.close(); }
        active.clear();
      },
    };
  }
}

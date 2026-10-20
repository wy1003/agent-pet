import { stat, realpath } from "node:fs/promises";
import { Codex } from "@openai/codex-sdk";
import { buildRemoteRequest } from "../src/remote-request.mjs";
import { resolveCodexExecutable } from "./codex-runtime.mjs";

function promptText(value) {
  return String(value || "").trim().slice(0, 4_000);
}

function safeThreadOptions(cwd) {
  return {
    workingDirectory: cwd,
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    networkAccessEnabled: false,
    webSearchMode: "disabled",
    skipGitRepoCheck: true,
  };
}

async function verifiedDirectory(value) {
  const requested = String(value || "").trim();
  if (!requested) throw new TypeError("授权项目目录不能为空");
  try {
    const cwd = await realpath(requested);
    const information = await stat(cwd);
    if (!information.isDirectory()) throw new Error("not_a_directory");
    return cwd;
  } catch (error) {
    if (error instanceof TypeError && error.message === "授权项目目录不能为空") throw error;
    throw new Error("授权项目目录不存在或不可访问", { cause: error });
  }
}

function remotePrompt(value) {
  return buildRemoteRequest(promptText(value));
}

function executionError(value, options = {}) {
  const source = value instanceof Error ? value : null;
  const message = String(source?.message || value || "Codex 远程任务执行失败").trim();
  const error = new Error(message || "Codex 远程任务执行失败", source ? { cause: source } : undefined);
  if (/already has an active writer|thread.+(?:is busy|is locked)/i.test(message)) {
    error.code = "codex_thread_busy";
  } else if (/thread history projection.+expected ordinal|unknown variant `(?:token_usage_record|item_completed)`/i.test(message)) {
    error.code = "codex_history_incompatible";
  } else if (/request timed out|timed out|timeout|deadline exceeded/i.test(message)) {
    error.code = "codex_response_timeout";
    error.transient = true;
  } else {
    error.code = source?.code || "codex_execution_failed";
    error.transient = source?.transient === true;
  }
  error.turnStarted = options.turnStarted === true || source?.turnStarted === true;
  return error;
}

export function isCodexResponseTimeout(error) {
  if (["codex_thread_busy", "codex_history_incompatible"].includes(error?.code)) return false;
  return error?.code === "codex_response_timeout"
    || /request timed out|timed out|timeout|deadline exceeded/i.test(String(error?.message || ""));
}

async function consumeThread(thread, input, options = {}) {
  let streamed;
  try {
    streamed = await thread.runStreamed(input, { signal: options.signal });
  } catch (error) {
    throw executionError(error);
  }
  let finalResponse = "";
  let usage = null;
  let startedId = "";
  let turnStarted = false;
  let completed = false;
  let lastStreamError = null;
  try {
    for await (const event of streamed.events) {
      if (event.type === "thread.started") {
        const eventId = String(event.thread_id || "").trim();
        if (!eventId) throw new Error("Codex 未返回有效的会话 ID");
        if (startedId && startedId !== eventId) {
          throw new Error("Codex 返回了不一致的会话 ID");
        }
        if (!startedId) {
          startedId = eventId;
          // Do not consume another event until the durable registry callback has
          // completed. This makes a new thread resumable even if the process exits
          // while the first turn is still running.
          await options.onThreadStarted?.(eventId);
        }
      } else if (event.type === "turn.started") {
        turnStarted = true;
      } else if (event.type === "item.completed" && event.item?.type === "agent_message") {
        finalResponse = String(event.item.text || "");
      } else if (event.type === "turn.completed") {
        usage = event.usage || null;
        completed = true;
      } else if (event.type === "turn.failed") {
        throw executionError(event.error?.message, { turnStarted });
      } else if (event.type === "error") {
        // Reconnect attempts are emitted as ordinary `error` events even when
        // the SDK can still recover (for example by falling back to HTTPS).
        // Preserve the latest error for diagnostics, but keep consuming until
        // the stream reports a real terminal event.
        lastStreamError = executionError(event.message, { turnStarted });
      }
    }
  } catch (error) {
    if (error?.name === "AbortError" || error?.code === "ABORT_ERR") throw error;
    throw executionError(error, { turnStarted });
  }
  if (options.requireThreadStarted && !startedId) {
    throw new Error("Codex 未返回新会话 ID，任务未被保存");
  }
  if (options.signal?.aborted) {
    throw options.signal.reason || new DOMException("Aborted", "AbortError");
  }
  if (!completed) {
    if (lastStreamError) throw lastStreamError;
    throw new Error("Codex 远程任务在完成前意外结束");
  }
  return {
    sessionId: startedId || thread.id || "",
    finalResponse: finalResponse.trim(),
    usage,
  };
}

export class CodexRemoteExecutor {
  constructor(options = {}) {
    this.codex = options.codex || null;
    this.codexOptions = options.codexOptions || {};
    this.resolveExecutable = options.resolveExecutable || resolveCodexExecutable;
    this.createCodex = options.createCodex || ((value) => new Codex(value));
    this.onDiagnostic = options.onDiagnostic || (() => {});
    this.desktop = options.desktop || null;
  }

  async #client() {
    if (this.codex) return this.codex;
    const codexPathOverride = await this.resolveExecutable(this.codexOptions.codexPathOverride, {
      env: this.codexOptions.env || process.env,
    });
    this.executablePath = codexPathOverride;
    await this.#diagnostic({ stage: "runtime", executable: codexPathOverride });
    return this.createCodex({ ...this.codexOptions, codexPathOverride });
  }

  async #diagnostic(value) {
    try { await this.onDiagnostic(value); } catch {}
  }

  async #run(operation, value, callback) {
    try {
      return await callback();
    } catch (error) {
      // Persist only a bounded diagnostic, never the prompt, environment, or
      // raw CLI stderr (which can include credentials and conversation data).
      await this.#diagnostic({
        stage: "failed",
        operation,
        route: error?.route || "sdk",
        executable: this.executablePath || "",
        sessionId: value.sessionId || "",
        code: error?.code || "codex_execution_failed",
        turnStarted: error?.turnStarted === true,
      });
      throw error;
    }
  }

  async start(value = {}) {
    const cwd = await verifiedDirectory(value.cwd);
    if (typeof value.onThreadStarted !== "function") {
      throw new TypeError("新建远程任务必须提供会话持久化回调");
    }
    return this.#run("start", value, async () => {
      const thread = (await this.#client()).startThread(safeThreadOptions(cwd));
      return consumeThread(thread, remotePrompt(value.prompt), {
        signal: value.signal,
        onThreadStarted: value.onThreadStarted,
        requireThreadStarted: true,
      });
    });
  }

  async resume(value = {}) {
    const sessionId = String(value.sessionId || "").trim();
    if (!sessionId) throw new TypeError("恢复任务缺少 Codex 会话 ID");
    const cwd = await verifiedDirectory(value.cwd);
    return this.#run("resume", value, async () => {
      const input = remotePrompt(value.prompt);
      if (this.desktop) {
        try {
          const result = await this.desktop.tryResume({
            ...value, sessionId, cwd, input,
            onDiagnostic: (entry) => this.#diagnostic(entry),
          });
          if (result) return result;
        } catch (error) {
          error.route = "desktop";
          throw error;
        }
      }
      const thread = (await this.#client()).resumeThread(sessionId, safeThreadOptions(cwd));
      return consumeThread(thread, input, {
        signal: value.signal,
        onThreadStarted: value.onThreadStarted,
      });
    });
  }
}

export { remotePrompt, safeThreadOptions };

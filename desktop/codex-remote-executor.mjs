import { stat, realpath } from "node:fs/promises";
import { Codex } from "@openai/codex-sdk";
import { buildRemoteRequest } from "../src/remote-request.mjs";

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
  if (/request timed out|timed out|timeout|deadline exceeded/i.test(message)) {
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
    this.codex = options.codex || new Codex(options.codexOptions);
  }

  async start(value = {}) {
    const cwd = await verifiedDirectory(value.cwd);
    if (typeof value.onThreadStarted !== "function") {
      throw new TypeError("新建远程任务必须提供会话持久化回调");
    }
    const thread = this.codex.startThread(safeThreadOptions(cwd));
    return consumeThread(thread, remotePrompt(value.prompt), {
      signal: value.signal,
      onThreadStarted: value.onThreadStarted,
      requireThreadStarted: true,
    });
  }

  async resume(value = {}) {
    const sessionId = String(value.sessionId || "").trim();
    if (!sessionId) throw new TypeError("恢复任务缺少 Codex 会话 ID");
    const cwd = await verifiedDirectory(value.cwd);
    const thread = this.codex.resumeThread(sessionId, safeThreadOptions(cwd));
    return consumeThread(thread, remotePrompt(value.prompt), {
      signal: value.signal,
      onThreadStarted: value.onThreadStarted,
    });
  }
}

export { remotePrompt, safeThreadOptions };

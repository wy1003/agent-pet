import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { CodexDesktopClient } from "./codex-desktop-client.mjs";

function desktopError(code, message, turnStarted = false) {
  return Object.assign(new Error(message), { code, turnStarted });
}

function checkAborted(signal) {
  if (signal?.aborted) throw signal.reason || new DOMException("Aborted", "AbortError");
}

export class CodexDesktopExecutor {
  constructor(options = {}) {
    this.createClient = options.createClient || (() => new CodexDesktopClient());
    this.getTask = options.getTask;
    this.pollMs = options.pollMs ?? 1_000;
    this.resultTimeoutMs = options.resultTimeoutMs ?? 2 * 60 * 60 * 1_000;
    this.observationTimeoutMs = options.observationTimeoutMs ?? 30_000;
  }

  // null means no Desktop owner exists and a standalone SDK may resume.
  // Once start-turn is dispatched, every failure is returned without fallback.
  async tryResume(value) {
    checkAborted(value.signal);
    const client = this.createClient();
    let turnId = "";
    let ownerId = "";
    let dispatched = false;
    try {
      try {
        await client.connect();
      } catch (error) {
        if (["ENOENT", "ECONNREFUSED"].includes(error?.code)) return null;
        throw error;
      }
      const owner = await client.request("thread-owner-discovery", {
        hostId: "local", conversationId: value.sessionId,
      }, { version: 1, timeoutMs: 5_000 });
      if (owner.resultType === "error" && owner.error === "no-client-found") return null;
      if (owner.resultType !== "success" || !owner.handledByClientId) {
        throw desktopError("codex_desktop_unavailable", "未能确认 Codex 桌面端会话状态，请稍后再试");
      }
      if (typeof this.getTask !== "function") throw new TypeError("缺少 Codex 轮次结果读取器");
      ownerId = owner.handledByClientId;
      checkAborted(value.signal);
      await value.onDiagnostic?.({ stage: "runtime", route: "desktop", sessionId: value.sessionId });
      checkAborted(value.signal);
      dispatched = true;
      // Do not cancel this acknowledgement when the user stops: first obtain
      // the exact turn ID, then interrupt only that turn.
      const response = await client.request("thread-follower-start-turn", {
        conversationId: value.sessionId,
        turnStart: {
          request: {
            threadId: value.sessionId,
            clientUserMessageId: randomUUID(),
            // Desktop renders this input before app-server normalizes it.
            // Its text-element readers require an array even for plain text.
            input: [{ type: "text", text: value.input, text_elements: [] }],
            cwd: value.cwd,
            approvalPolicy: "never",
            permissions: null,
            sandboxPolicy: {
              type: "workspaceWrite", writableRoots: [value.cwd],
              networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false,
            },
          },
          context: { inheritThreadSettings: true, useAppServerPermissionDefault: false },
        },
      }, { version: 2, targetClientId: ownerId });
      const turn = response.result?.result?.turn;
      if (response.resultType !== "success" || typeof turn?.id !== "string" || !turn.id) {
        throw desktopError("codex_desktop_submission_unconfirmed",
          "未能确认桌面端提交结果，请先检查该会话，避免重复发送");
      }
      turnId = turn.id;
      await value.onDiagnostic?.({
        stage: "submitted", route: "desktop", sessionId: value.sessionId, turnId,
      });
      return await this.#waitForResult(value, turnId);
    } catch (error) {
      if (value.signal?.aborted && turnId) {
        try {
          const stopped = await client.request("thread-follower-interrupt-turn", {
            conversationId: value.sessionId, mode: "user-stop", expectedTurnId: turnId,
          }, { version: 4, targetClientId: ownerId, timeoutMs: 5_000 });
          if (stopped.resultType !== "success" || stopped.result?.ok !== true) throw new Error();
        } catch {
          throw desktopError("codex_desktop_stop_unconfirmed",
            "未能确认桌面端已停止这次请求，请在电脑端检查", true);
        }
        throw value.signal.reason || new DOMException("Aborted", "AbortError");
      }
      if (dispatched && !turnId) {
        throw desktopError("codex_desktop_submission_unconfirmed",
          "未能确认桌面端提交结果，请先检查该会话，避免重复发送");
      }
      throw error;
    } finally {
      client.close();
    }
  }

  async #waitForResult(value, turnId) {
    const deadline = Date.now() + this.resultTimeoutMs;
    let lastObserved = Date.now();
    const taskId = `codex:${value.sessionId}:${turnId}`;
    while (Date.now() < deadline) {
      checkAborted(value.signal);
      let task;
      try {
        task = await this.getTask(taskId, value.signal);
      } catch {
        checkAborted(value.signal);
      }
      if (task?.sessionId === value.sessionId && task?.turnId === turnId) {
        lastObserved = Date.now();
        if (task.status === "completed") {
          return { sessionId: value.sessionId, finalResponse: task.latestResponse || "", usage: null };
        }
        if (task.status === "failed") {
          throw desktopError("codex_execution_failed", "Codex 本次任务执行失败，请查看电脑端详情", true);
        }
        if (task.status === "interrupted") throw new DOMException("Codex 本次任务已中断", "AbortError");
      }
      if (Date.now() - lastObserved >= this.observationTimeoutMs) break;
      await delay(this.pollMs, undefined, { signal: value.signal });
    }
    throw desktopError("codex_desktop_result_unconfirmed",
      "消息已提交到桌面端，但暂时无法确认完成状态，请查看该会话；请勿重复发送", true);
  }
}

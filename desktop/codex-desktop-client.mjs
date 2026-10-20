import net from "node:net";
import { randomUUID } from "node:crypto";

// Codex Desktop's local follower protocol (Desktop 26.1013).
// Keep the versions explicit: incompatible owners must fail before submitting.
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

function ipcError(code, message = "无法连接 Codex 桌面端会话") {
  return Object.assign(new Error(message), { code });
}

export class CodexDesktopClient {
  constructor(options = {}) {
    this.endpoint = options.endpoint || "\\\\.\\pipe\\codex-ipc";
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
    this.socket = null;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.clientId = "initializing-client";
  }

  async connect() {
    this.socket = net.createConnection(this.endpoint);
    this.socket.on("data", (chunk) => this.#receive(chunk));
    this.socket.on("error", (error) => this.#fail(error));
    this.socket.on("close", () => this.#fail(ipcError("codex_desktop_disconnected")));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.close();
        reject(ipcError("codex_desktop_connect_timeout"));
      }, this.connectTimeoutMs);
      const finish = (error) => {
        clearTimeout(timer);
        this.socket.off("connect", connected);
        this.socket.off("error", failed);
        error ? reject(error) : resolve();
      };
      const connected = () => finish();
      const failed = (error) => finish(error);
      this.socket.once("connect", connected);
      this.socket.once("error", failed);
    });
    const response = await this.request("initialize", { clientType: "agent-pet" }, {
      version: 0, timeoutMs: this.connectTimeoutMs,
    });
    if (response.resultType !== "success" || typeof response.result?.clientId !== "string") {
      throw ipcError("codex_desktop_protocol", "Codex 桌面端通信协议不匹配，请检查版本");
    }
    this.clientId = response.result.clientId;
  }

  request(method, params, options = {}) {
    const requestId = randomUUID();
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(ipcError("codex_desktop_request_timeout", "等待 Codex 桌面端确认超时"));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer, method });
      try {
        this.#write({
          type: "request", requestId, sourceClientId: this.clientId,
          version: options.version, method, params, timeoutMs,
          ...(options.targetClientId ? { targetClientId: options.targetClientId } : {}),
        });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  #write(message) {
    if (!this.socket || this.socket.destroyed) throw ipcError("codex_desktop_disconnected");
    const payload = Buffer.from(JSON.stringify(message), "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length);
    this.socket.write(Buffer.concat([header, payload]));
  }

  #receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      while (this.buffer.length >= 4) {
        const length = this.buffer.readUInt32LE(0);
        if (!length || length > MAX_FRAME_BYTES) throw ipcError("codex_desktop_protocol");
        if (this.buffer.length < length + 4) return;
        const message = JSON.parse(this.buffer.subarray(4, length + 4).toString("utf8"));
        this.buffer = this.buffer.subarray(length + 4);
        if (message.type === "client-discovery-request") {
          // This client submits requests only; it never claims ownership.
          this.#write({
            type: "client-discovery-response", requestId: message.requestId,
            response: { canHandle: false },
          });
        } else if (message.type === "response") {
          const pending = this.pending.get(message.requestId);
          if (!pending) continue;
          this.pending.delete(message.requestId);
          clearTimeout(pending.timer);
          if (message.resultType === "success" && message.method !== pending.method) {
            pending.reject(ipcError("codex_desktop_protocol"));
          } else {
            pending.resolve(message);
          }
        }
      }
    } catch {
      this.#fail(ipcError("codex_desktop_protocol", "Codex 桌面端返回了无法识别的数据"));
      this.socket.destroy();
    }
  }

  #fail(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    this.#fail(ipcError("codex_desktop_disconnected"));
    this.socket?.destroy();
  }
}

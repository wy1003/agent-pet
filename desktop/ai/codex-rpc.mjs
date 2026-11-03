import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { aiError } from "./errors.mjs";

// One bounded, disposable stdio connection. No native window access, no shell.
export class CodexRpc extends EventEmitter {
  constructor(executable, { cwd, signal, spawnProcess = spawn, timeoutMs = 30_000 } = {}) {
    super();
    this.pending = new Map();
    this.nextId = 0;
    this.buffer = "";
    this.timeoutMs = timeoutMs;
    this.closed = false;
    signal?.throwIfAborted();
    this.child = spawnProcess(executable, ["app-server", "--listen", "stdio://"], {
      cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.receive(chunk));
    this.child.stderr.on("data", () => {});
    this.child.stdin.on("error", () => this.close(aiError("connection_failed", "无法向 Codex 发送请求。")));
    this.child.on("error", () => this.close(aiError("runtime_unavailable", "无法启动 Codex，请检查本机安装。")));
    this.child.on("exit", () => this.close(aiError("runtime_disconnected", "Codex 连接已中断，请重新检查。")));
    this.signal = signal;
    this.abort = () => this.close(new DOMException("Aborted", "AbortError"));
    signal?.addEventListener("abort", this.abort, { once: true });
  }

  async initialize() {
    return this.request("initialize", {
      clientInfo: { name: "agent_pet", title: "Agent Pet", version: "1.0.0" },
    }).then((result) => { this.write({ method: "initialized" }); return result; });
  }

  write(value) {
    if (this.closed) throw aiError("runtime_disconnected", "Codex 连接已关闭。");
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  request(method, params) {
    if (this.closed) return Promise.reject(aiError("runtime_disconnected", "Codex 连接已关闭。"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(aiError("connection_timeout", "等待 Codex 响应超时，请检查连接。")), this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (error) { this.close(error); }
    });
  }

  receive(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > 8 * 1024 * 1024) return this.close(aiError("invalid_response", "Codex 响应超过允许大小。"));
    let newline;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let value;
      try { value = JSON.parse(line); } catch { this.close(aiError("invalid_response", "Codex 返回了无法识别的数据。")); return; }
      if (value.method && value.id !== undefined) {
        // Background text generation cannot grant approvals or invoke user tools.
        this.write({ id: value.id, error: { code: -32601, message: "Interactive tools are unavailable" } });
      } else if (value.id !== undefined) {
        const pending = this.pending.get(value.id);
        if (!pending) continue;
        this.pending.delete(value.id);
        clearTimeout(pending.timer);
        value.error ? pending.reject(new Error(String(value.error.message || "Codex request failed"))) : pending.resolve(value.result);
      } else if (value.method) {
        this.emit("notification", value);
      }
    }
  }

  close(error = aiError("runtime_disconnected", "Codex 连接已关闭。")) {
    if (this.closed) return;
    this.closed = true;
    this.signal?.removeEventListener("abort", this.abort);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.child.stdin.destroy();
    this.child.kill();
    this.emit("closed", error);
  }
}

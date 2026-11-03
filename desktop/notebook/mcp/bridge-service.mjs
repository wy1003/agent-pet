import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { NotebookError } from "../notebook-store.mjs";

const MAX_BODY = 128 * 1024;
const send = (response, status, body) => { response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); response.end(JSON.stringify(body)); };

/** Private loopback bridge. MCP processes never open or write notebook files. */
export class NotebookMcpBridge {
  #server; #connection; #tools;
  constructor({ connectionFile, tools }) { this.connectionFile = connectionFile; this.#tools = tools; }
  async start() {
    if (this.#server) return;
    const token = randomBytes(32).toString("hex");
    const server = http.createServer(async (request, response) => {
      const expected = Buffer.from(`Bearer ${token}`), supplied = Buffer.from(request.headers.authorization || "");
      if (request.headers.origin || request.headers.host !== `127.0.0.1:${server.address()?.port}`
        || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { send(response, 403, { error: "连接未授权。" }); return; }
      if (request.method !== "POST" || request.url !== "/tools/call") { send(response, 404, { error: "接口不存在。" }); return; }
      if (!(request.headers["content-type"] || "").startsWith("application/json")) { send(response, 415, { error: "需要 JSON 请求。" }); return; }
      try {
        let size = 0; const chunks = [];
        for await (const chunk of request) {
          size += chunk.length;
          if (size > MAX_BODY) { send(response, 413, { error: "请求内容过大。" }); return; }
          chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const result = await this.#tools.call(body?.name, body?.arguments);
        send(response, 200, { ok: true, result });
      } catch (error) {
        send(response, 400, { ok: false, error: error instanceof NotebookError ? error.message
          : error instanceof SyntaxError ? "请求格式无效。" : "记事板保存失败，请检查本地存档后重试。" });
      }
    });
    server.requestTimeout = 15_000; server.headersTimeout = 10_000;
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    this.#server = server;
    this.#connection = { version: 1, port: server.address().port, token };
    const temporary = `${this.connectionFile}.${process.pid}.tmp`;
    try {
      await mkdir(path.dirname(this.connectionFile), { recursive: true });
      await writeFile(temporary, JSON.stringify(this.#connection), { mode: 0o600 });
      await rename(temporary, this.connectionFile);
    } catch (error) { await this.stop(); throw error; }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
  get ready() { return Boolean(this.#server); }
  async stop() {
    const server = this.#server; this.#server = null;
    if (server) await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
    try {
      const current = JSON.parse(await readFile(this.connectionFile, "utf8"));
      if (current.token === this.#connection?.token) await rm(this.connectionFile, { force: true });
    } catch {}
    this.#connection = null;
  }
}

export function notebookMcpConfig({ executable, entry, connectionFile }) {
  return { mcpServers: { "agent-pet-notebook": { command: executable, args: [entry, "--connection", connectionFile], env: { ELECTRON_RUN_AS_NODE: "1" } } } };
}

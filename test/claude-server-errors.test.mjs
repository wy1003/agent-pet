import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createCollectorServer } from "../src/server.mjs";

function response() {
  return { headersSent: false, writableEnded: false, destroyed: false, headers: [], body: "",
    writeHead(status, headers) { assert.equal(this.headersSent, false, "headers are written only once"); this.headersSent = true; this.headers.push([status, headers]); },
    write(text) { this.body += text; },
    end(text = "") { this.body += text; this.writableEnded = true; },
    destroy() { this.destroyed = true; },
  };
}
async function fixture(t) {
  const collector = Object.assign(new EventEmitter(), { sessions: new Map(), getTasks: () => [], getSessions: () => [], markRead: () => null,
    dismissAllTasks: async () => ({ ok: true, tasks: [] }), dismissTask: async () => ({ ok: true }), getTask: () => null });
  const service = createCollectorServer(collector, { port: 0 });
  t.after(() => service.stop());
  const handler = service.server.listeners("request")[0];
  const request = async (url, method = "GET") => {
    const result = response();
    await handler(Object.assign(new EventEmitter(), { url, method, headers: {} }), result);
    return result;
  };
  return { collector, request };
}

for (const [method, url, verb] of [
  ["markRead", "/api/v1/sessions/claude%3Achat/read", "POST"],
  ["getTask", "/api/v1/tasks/claude%3Achat%3Aone", "GET"],
  ["dismissAllTasks", "/api/v1/tasks/acknowledge-all", "POST"],
]) {
  test(`server sanitizes ${method} errors and continues serving subsequent requests`, async (t) => {
    const { collector, request } = await fixture(t);
    collector[method] = method === "dismissAllTasks"
      ? async () => { throw new Error("FAKE_SECRET_TOKEN_987"); }
      : () => { throw new Error("FAKE_SECRET_TOKEN_987"); };
    const result = await request(url, verb);
    assert.equal(result.headers[0][0], 500);
    assert.deepEqual(JSON.parse(result.body), { error: "collector_request_failed" });
    assert.equal(result.body.includes("FAKE_SECRET"), false);
    assert.equal((await request("/health")).headers[0][0], 200);
  });
}

test("SSE snapshot failure closes its stream without writing a second header or leaking errors", async (t) => {
  const { collector, request } = await fixture(t);
  collector.getSessions = () => { throw new Error("FAKE_SECRET_TOKEN_987"); };
  const result = await request("/api/v1/events");
  assert.equal(result.headers.length, 1);
  assert.equal(result.headers[0][0], 200);
  assert.ok(result.destroyed || result.writableEnded);
  assert.equal(result.body.includes("FAKE_SECRET"), false);
  collector.getSessions = () => [];
  assert.equal((await request("/api/v1/sessions")).headers[0][0], 200);
});

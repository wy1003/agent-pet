import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HttpTextProvider, normalizeAiBaseUrl } from "../desktop/ai/http-provider.mjs";
import { CodexTextProvider } from "../desktop/ai/codex-provider.mjs";
import { CodexRpc } from "../desktop/ai/codex-rpc.mjs";

test("compatible API discovers models without inventing a default, sends fixed model and JSON request", async () => {
  const requests = [];
  const provider = new HttpTextProvider({ id: "deepseek", name: "DeepSeek",
    loadKey: async () => ({ baseUrl: "https://api.example.com/v1", apiKey: "test-key" }),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return Response.json(url.endsWith("/models")
        ? { data: [{ id: "first" }, { id: "second" }] }
        : { choices: [{ finish_reason: "stop", message: { content: '{"text":"ok"}' } }] });
    },
  });
  const connection = await provider.open({ baseUrl: "https://api.example.com/v1/" });
  assert.equal(connection.catalog.defaultModelId, "");
  await connection.generate({ model: { id: "second" }, prompt: "sample", schema: { type: "object" } });
  assert.equal(requests[1].url, "https://api.example.com/v1/chat/completions");
  assert.equal(requests[1].options.redirect, "error");
  assert.equal(requests[1].options.headers.Authorization, "Bearer test-key");
  const body = JSON.parse(requests[1].options.body);
  assert.equal(body.model, "second");
  assert.equal(body.response_format.type, "json_object");
  assert.equal(body.stream, false);
  assert.doesNotMatch(JSON.stringify(connection.catalog), /test-key/);
});

test("endpoint changes do not forward credentials and insecure remote addresses are rejected", async () => {
  let calls = 0;
  const provider = new HttpTextProvider({ id: "compatible", name: "test", loadKey: async () => ({ baseUrl: "https://old.example", apiKey: "secret" }), fetchImpl: () => { calls++; } });
  await assert.rejects(provider.open({ baseUrl: "https://new.example" }), { code: "authentication" });
  assert.equal(calls, 0);
  for (const url of ["http://remote.example", "https://user:pass@example.com", "https://example.com?key=secret", "file:///test"]) {
    assert.throws(() => normalizeAiBaseUrl(url), { code: "configuration" });
  }
  assert.equal(normalizeAiBaseUrl("http://127.0.0.1:1234/v1/"), "http://127.0.0.1:1234/v1");
});

test("provider errors discard raw response bodies and truncated output is not accepted", async () => {
  for (const [status, code] of [[401, "authentication"], [429, "rate_limit"], [400, "incompatible"], [503, "connection_failed"]]) {
    const provider = new HttpTextProvider({ id: "test", name: "test", loadKey: async () => ({ baseUrl: "https://api.example.com", apiKey: "key" }), fetchImpl: async () => new Response("private upstream body", { status }) });
    await assert.rejects(provider.open({ baseUrl: "https://api.example.com" }), error => error.code === code && !error.message.includes("private"));
  }
  const provider = new HttpTextProvider({ id: "test", name: "test", loadKey: async () => ({ baseUrl: "https://api.example.com", apiKey: "key" }), fetchImpl: async (url) => Response.json(url.endsWith("/models") ? { data: [{ id: "a", is_default: true }] } : { choices: [{ finish_reason: "length", message: { content: "{}" } }] }) });
  const connection = await provider.open({ baseUrl: "https://api.example.com" });
  assert.equal(connection.catalog.defaultModelId, "a");
  await assert.rejects(connection.generate({ model: { id: "a" }, prompt: "x", schema: {} }), { code: "invalid_output" });
});

class FakeRpc extends EventEmitter {
  constructor() { super(); this.calls = []; this.closed = false; }
  async initialize() { return { userAgent: "codex/0.166.0 test" }; }
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === "config/read") return { config: { model: "configured", model_provider: "custom", models: { new_thread: { model: "preferred" } } } };
    if (method === "account/read") return { account: null, requiresOpenaiAuth: false };
    if (method === "model/list") return params.cursor
      ? { data: [{ id: "preferred", displayName: "Preferred", supportedReasoningEfforts: [{ reasoningEffort: "high" }], defaultReasoningEffort: "high" }] }
      : { data: [{ id: "configured" }], nextCursor: "next" };
    if (method === "thread/start") return { thread: { id: "internal" }, model: params.model, modelProvider: params.modelProvider };
    if (method === "turn/start") {
      this.emit("notification", { method: "item/completed", params: { threadId: "internal", item: { type: "agentMessage", text: '{"text":"done"}' } } });
      this.emit("notification", { method: "turn/completed", params: { threadId: "internal", turn: { status: "completed" } } });
      return { turn: { id: "turn-1" } };
    }
    throw new Error(method);
  }
  close() { this.closed = true; }
}

test("Codex uses resolved runtime, paginated server catalog and effective default; generation is ephemeral and read-only", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-ai-provider-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rpc = new FakeRpc();
  const provider = new CodexTextProvider({ workingDirectory: root, resolveExecutable: async () => "selected-codex", createRpc: file => { assert.equal(file, "selected-codex"); return rpc; } });
  const connection = await provider.open({});
  assert.equal(connection.catalog.defaultModelId, "preferred");
  assert.equal(connection.catalog.models.length, 2);
  assert.equal(connection.catalog.runtimeVersion, "0.166.0");
  assert.deepEqual(await connection.generate({ model: connection.catalog.models[1], prompt: "text", schema: {} }), { text: '{"text":"done"}' });
  const thread = rpc.calls.find(c => c.method === "thread/start").params;
  assert.equal(thread.model, "preferred");
  assert.equal(thread.modelProvider, "custom");
  assert.equal(thread.ephemeral, true);
  assert.equal(thread.sandbox, "read-only");
  assert.equal(thread.approvalPolicy, "never");
  assert.equal(rpc.calls.find(c => c.method === "turn/start").params.effort, "high");
  connection.close();
  assert.equal(rpc.closed, true);
});

test("Codex detects missing login and rejects model substitution before starting a turn", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-ai-provider-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const mode of ["auth", "substitution"]) {
    const rpc = new FakeRpc();
    const original = rpc.request.bind(rpc);
    rpc.request = async (method, params) => {
      if (mode === "auth" && method === "account/read") return { requiresOpenaiAuth: true, account: null };
      if (mode === "substitution" && method === "thread/start") return { model: "other", modelProvider: "custom", thread: { id: "unexpected" } };
      return original(method, params);
    };
    const provider = new CodexTextProvider({ workingDirectory: root, resolveExecutable: async () => "codex", createRpc: () => rpc });
    if (mode === "auth") { await assert.rejects(provider.open({}), { code: "authentication" }); assert.equal(rpc.closed, true); }
    else {
      const connection = await provider.open({});
      await assert.rejects(connection.generate({ model: connection.catalog.models[1], prompt: "text", schema: {} }), { code: "model_changed" });
      assert.equal(rpc.calls.some(c => c.method === "turn/start"), false);
      connection.close();
    }
  }
});

test("stdio transport handles chunking, cancellation and rejects interactive tool requests", async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let killed = false;
  child.kill = () => { killed = true; };
  let sent = "";
  child.stdin.on("data", data => { sent += data; });
  const abort = new AbortController();
  const rpc = new CodexRpc("codex", { signal: abort.signal, spawnProcess: (_file, _args, options) => { assert.equal(options.windowsHide, true); return child; } });
  const pending = rpc.request("model/list", {});
  child.stdout.write('{"id":1,"res'); child.stdout.write('ult":{"data":[]}}\n');
  assert.deepEqual(await pending, { data: [] });
  child.stdout.write('{"id":99,"method":"item/tool/call","params":{}}\n');
  assert.match(sent, /Interactive tools are unavailable/);
  const cancelled = rpc.request("config/read", {});
  abort.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  assert.equal(killed, true);
  assert.equal(rpc.pending.size, 0);
});

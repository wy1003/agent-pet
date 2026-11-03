import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { NotebookStore } from "../desktop/notebook/notebook-store.mjs";
import { createNotebookTools } from "../desktop/notebook/mcp/notebook-tools.mjs";
import { NotebookMcpBridge } from "../desktop/notebook/mcp/bridge-service.mjs";
import { callNotebookBridge } from "../desktop/notebook/mcp/stdio.mjs";
import { createNotebookSource } from "../public/notebook-source.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-pet-mcp-"));
  let notifications = 0;
  const store = new NotebookStore(path.join(root, "notebook"), { onChange: () => notifications++ });
  const tools = createNotebookTools(store), connectionFile = path.join(root, "connection.json");
  const bridge = new NotebookMcpBridge({ connectionFile, tools }); await bridge.start();
  t.after(async () => { await bridge.stop(); await store.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, store, tools, bridge, connectionFile, notifications: () => notifications };
}

test("real MCP stdio discovery and tool calls use the app's single writer, preserve original text and return saved records", async t => {
  const f = await fixture(t);
  const client = new Client({ name: "notebook-test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL("../desktop/notebook/mcp/stdio.mjs", import.meta.url)), "--connection", f.connectionFile], stderr: "pipe" });
  let errors = ""; transport.stderr.on("data", data => { errors += data; });
  await client.connect(transport); t.after(() => client.close());
  const { tools } = await client.listTools(); assert.equal(tools.length, 6);
  assert.ok(tools.find(tool => tool.name === "notebook_add_plan").inputSchema.properties.requestId);
  const call = (name, args) => client.callTool({ name, arguments: args });
  const added = await call("notebook_add_plan", { requestId: "plan-request-1", title: "AI 整理的计划", detail: "第一步\n第二步" });
  assert.equal(added.isError, undefined); assert.equal(added.structuredContent.saved, true);
  const plan = added.structuredContent.record;
  assert.equal(plan.deadline, ""); assert.equal(plan.deadlineTime, ""); assert.equal(plan.important, false); assert.equal(plan.origin, "ai");
  const ideaReply = await call("notebook_add_idea", { requestId: "idea-request-1", originalText: "微信随手记一句", content: "微信收集灵感\n下一步：明确收集范围。" });
  const idea = ideaReply.structuredContent.record;
  await f.store.execute({ type: "edit-idea", id: idea.id, revision: idea.revision, value: "我手动完善的内容" });
  const read = (await call("notebook_get", { kind: "idea", id: idea.id })).structuredContent;
  assert.equal(read.originalText, "微信随手记一句"); assert.equal(read.content, "我手动完善的内容");
  assert.equal(read.events.at(-1).actor, "manual"); assert.equal(read.events.at(-1).before.content, idea.content);
  assert.equal((await call("notebook_list", { kind: "plan", query: "整理", limit: 1 })).structuredContent.records[0].id, plan.id);
  assert.ok(f.notifications() >= 3); assert.equal(errors, "");
});

test("manual/AI edits share revision checks and retain full history without changing creation/completion records", async t => {
  const f = await fixture(t);
  const plan = (await f.tools.call("notebook_add_plan", { requestId: "p", title: "原计划" })).record;
  await f.store.execute({ type: "edit-plan", id: plan.id, revision: plan.revision, value: { detail: "我手动写的内容" } });
  await assert.rejects(f.tools.call("notebook_update_plan", { id: plan.id, revision: 1, changes: { detail: "过期 AI 修改" } }), /发生变化/);
  const updated = (await f.tools.call("notebook_update_plan", { id: plan.id, revision: 2, changes: { detail: "AI 补充后的内容", deadline: "2026-11-10", deadlineTime: "16:30" } })).record;
  assert.equal(updated.events.at(-1).before.detail, "我手动写的内容"); assert.equal(updated.events.at(-1).actor, "ai");
  assert.equal(updated.createdAt, plan.createdAt); assert.deepEqual(updated.completions, []);
  await assert.rejects(f.store.execute({ type: "edit-plan", id: plan.id, revision: 2, value: { title: "旧手动草稿" } }), /发生变化/);
  await f.store.execute({ type: "set-completed", id: plan.id, done: true });
  await f.store.execute({ type: "archive", ids: [plan.id] });
  const archived = (await f.store.snapshot()).plans[0];
  await assert.rejects(f.tools.call("notebook_update_plan", { id: plan.id, revision: archived.revision, changes: { title: "覆盖归档" } }), /移回/);
  assert.equal((await f.tools.call("notebook_list", {})).total, 0);
  assert.equal((await f.tools.call("notebook_list", { scope: "archived" })).total, 1);
});

test("AI create retry is idempotent after reload, reused IDs with different content are rejected", async t => {
  const f = await fixture(t), args = { requestId: "same-call", originalText: "一句话", content: "标题\n整理内容" };
  const a = await f.tools.call("notebook_add_idea", args), b = await f.tools.call("notebook_add_idea", args);
  assert.equal(a.record.id, b.record.id); assert.equal(b.duplicate, true);
  const reopened = new NotebookStore(path.join(f.root, "notebook")); t.after(() => reopened.close());
  assert.equal((await createNotebookTools(reopened).call("notebook_add_idea", args)).record.id, a.record.id);
  await assert.rejects(f.tools.call("notebook_add_idea", { ...args, content: "另外的内容" }), /请求编号/);
  assert.equal((await f.store.snapshot()).ideas.length, 1);
});

test("tool validation blocks arbitrary fields, missing original text, invalid dates, revisions and destructive operations", async t => {
  const f = await fixture(t), before = await f.store.snapshot();
  for (const [name, args] of [
    ["notebook_add_plan", { requestId: "bad", title: "计划", deadlineTime: "12:00" }],
    ["notebook_add_plan", { requestId: "bad", title: "计划", deadline: "2026-02-30" }],
    ["notebook_add_plan", { requestId: "bad", title: "计划", done: true }],
    ["notebook_add_idea", { requestId: "bad", content: "内容" }],
    ["notebook_update_plan", { id: "../../file", revision: 1, changes: { title: "内容" } }],
    ["notebook_delete", {}],
  ]) await assert.rejects(f.tools.call(name, args));
  assert.deepEqual(await f.store.snapshot(), before);
});

test("bridge denies unauthenticated requests and browser origins; restart is discovered without a client config change", async t => {
  const f = await fixture(t), connection = JSON.parse(await fs.readFile(f.connectionFile, "utf8"));
  const url = `http://127.0.0.1:${connection.port}/tools/call`, body = JSON.stringify({ name: "notebook_list", arguments: {} });
  assert.equal((await fetch(url, { method: "POST", body })).status, 403);
  assert.equal((await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${connection.token}`, Origin: "https://example.com" }, body })).status, 403);
  assert.equal((await callNotebookBridge(f.connectionFile, "notebook_list", {})).total, 0);
  await f.bridge.stop();
  await assert.rejects(callNotebookBridge(f.connectionFile, "notebook_list", {}), /启动 Agent Pet/);
  await f.bridge.start();
  assert.notEqual(JSON.parse(await fs.readFile(f.connectionFile, "utf8")).token, connection.token);
  assert.equal((await callNotebookBridge(f.connectionFile, "notebook_list", {})).total, 0);
});

test("an older renderer read cannot replace a newer acknowledged manual save", async () => {
  let resolve;
  const old = new Promise(done => { resolve = done; });
  const source = createNotebookSource({ getNotebook: () => old, updateNotebook: async () => ({ ok: true, snapshot: { plans: [{ id: "new" }], ideas: [], warnings: [] } }) });
  const loading = source.load(); await source.add("plans", {});
  resolve({ ok: true, snapshot: { plans: [], ideas: [], warnings: [] } }); await loading;
  assert.equal(source.getSnapshot().plans[0].id, "new");
});

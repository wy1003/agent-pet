import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ClaudeActivityCollector } from "../src/claude-collector.mjs";

const epoch = 1_800_000_000_000;
const at = n => new Date(epoch + n * 1000).toISOString();
const hook = (name, n, extra = {}) => ({ session_id: "chat", hook_event_name: name, timestamp: at(n), event_id: `h-${n}`, ...extra });
const row = (type, n, message, extra = {}) => ({ type, sessionId: "chat", uuid: `r${n}`, parentUuid: `r${n - 1}`, timestamp: at(n), message, ...extra });
const user = (n, content, extra) => row("user", n, { role: "user", content }, extra);
const answer = n => row("assistant", n, { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "最终回复" }] });
const notice = (id, status = "completed") => `<task-notification>\n<task-id>${id}</task-id>\n<status>${status}</status>\n<summary>子任务结果</summary>\n</task-notification>`;
const jsonl = rows => rows.map(r => `${JSON.stringify(r)}\n`).join("");
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pet-background-"));
  const file = path.join(root, "projects", "project", "chat.jsonl");
  await mkdir(path.dirname(file), { recursive: true });
  const options = { eventsDir: path.join(root, "events"), statePath: path.join(root, "state.json"), transcriptsDir: path.join(root, "projects"), now: () => epoch + 100_000 };
  const instances = [];
  const create = () => { const c = new ClaudeActivityCollector(options); instances.push(c); return c; };
  t.after(async () => { for (const c of instances) await c.stop(); await rm(root, { recursive: true, force: true }); });
  return { c: create(), create, file, options };
}

for (const prompt of [notice("child"), 'Another Claude session sent a message:\n<agent-message from="child">进度</agent-message>']) {
  test(`automatic Hook delivery stays in the original user task: ${prompt.slice(0, 30)}`, async t => {
    const { c } = await fixture(t);
    await c.ingest(hook("UserPromptSubmit", 1, { prompt: "用户请求", prompt_id: "human" }));
    await c.ingest(hook("UserPromptSubmit", 2, { prompt, prompt_id: "automatic" }));
    assert.equal(c.getTasks({ scope: "all" }).length, 1);
    assert.equal(c.getTasks()[0].question, "用户请求");
    await c.ingest(hook("Stop", 3, { prompt_id: "automatic", last_assistant_message: "最终回复" }));
    assert.equal(c.getTasks()[0].status, "completed");
  });
}

test("automatic transcript delivery and local command output never become user tasks", async t => {
  const { c, file } = await fixture(t);
  await writeFile(file, jsonl([
    user(1, "<command-name>/model</command-name>"), user(2, "<local-command-stdout>model</local-command-stdout>"),
    user(3, "用户请求", { origin: { kind: "human" } }),
    user(4, notice("child"), { origin: { kind: "task-notification" }, turnOrigin: "task_notification", promptSource: "system" }),
    user(5, '<agent-message from="child">进度</agent-message>', { isMeta: true, origin: { kind: "peer" }, promptSource: "system" }), answer(6),
  ]));
  await c.scanOnce();
  assert.equal(c.getTasks({ scope: "all" }).length, 1);
  assert.equal(c.getTasks()[0].question, "用户请求");
  assert.equal(c.getTasks()[0].status, "completed");
});

for (const stopSource of ["hook", "transcript"]) {
  test(`${stopSource} Stop waits for background agents through restart and only completes once`, async t => {
    const { c, file, create } = await fixture(t);
    const completions = [];
    c.on("task.updated", task => { if (task.status === "completed") completions.push(task); });
    await writeFile(file, jsonl([
      user(1, "用户请求"),
      row("assistant", 2, { role: "assistant", content: [{ type: "tool_use", id: "call-agent", name: "Agent", input: {} }] }),
      row("user", 3, { role: "user", content: [{ type: "tool_result", tool_use_id: "call-agent", content: "launched" }] }, { toolUseResult: { status: "async_launched", isAsync: true, agentId: "child" } }),
    ]));
    await c.scanOnce();
    if (stopSource === "hook") {
      const intermediate = answer(4);
      intermediate.message.stop_reason = null;
      await appendFile(file, jsonl([intermediate]));
      await c.scanOnce();
      await c.ingest(hook("UserPromptSubmit", 1, { prompt: "用户请求", prompt_id: "human" }));
      await c.ingest(hook("Stop", 4, { last_assistant_message: "等待子代理" }));
    } else { await appendFile(file, jsonl([answer(4)])); await c.scanOnce(); }
    assert.equal(c.getTasks()[0].status, "running");
    assert.equal(completions.length, 0);
    await c.stop();
    const next = create();
    next.on("task.updated", task => { if (task.status === "completed") completions.push(task); });
    await next.scanOnce();
    assert.equal(next.getTasks()[0].status, "running");
    await appendFile(file, jsonl([user(5, notice("child"), { origin: { kind: "task-notification" } })]));
    await next.scanOnce();
    assert.equal(next.getTasks()[0].status, "running", "a child finishing does not finish the parent");
    await appendFile(file, jsonl([answer(6)]));
    await next.scanOnce();
    await next.ingest(hook("Stop", 7, { last_assistant_message: "最终回复" }));
    await next.scanOnce();
    assert.equal(next.getTasks({ scope: "all" }).length, 1);
    assert.equal(next.getTasks()[0].status, "completed");
    assert.equal(completions.length, 1);
  });
}

test("automatic notifications alone do not create orphan tasks", async t => {
  const { c } = await fixture(t);
  await c.ingest(hook("UserPromptSubmit", 1, { prompt: notice("child") }));
  await c.ingest(hook("Stop", 2));
  assert.deepEqual(c.getTasks({ scope: "all" }), []);
});

test("explicit human provenance preserves XML examples as a real request", async t => {
  const { c, file } = await fixture(t);
  await writeFile(file, jsonl([user(1, notice("example"), { origin: { kind: "human" }, turnOrigin: "human" }), answer(2)]));
  await c.scanOnce();
  assert.equal(c.getTasks()[0].question, notice("example"));
});

test("a Stop already in the inbox sees background work discovered in the same poll", async t => {
  const { c, file, options } = await fixture(t);
  await writeFile(file, jsonl([
    user(1, "用户请求"),
    row("assistant", 2, { role: "assistant", content: [{ type: "tool_use", id: "call", name: "Agent", input: {} }] }),
    row("user", 3, { role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: "launched" }] }, { toolUseResult: { status: "async_launched", agentId: "child" } }),
  ]));
  await mkdir(options.eventsDir, { recursive: true });
  await writeFile(path.join(options.eventsDir, "submit.json"), JSON.stringify(hook("UserPromptSubmit", 1, { prompt: "用户请求", prompt_id: "human" })));
  await writeFile(path.join(options.eventsDir, "stop.json"), JSON.stringify(hook("Stop", 4)));
  const completed = [];
  for (const name of ["task.created", "task.updated"]) c.on(name, task => { if (task.status === "completed") completed.push(task); });
  await c.scanOnce();
  assert.equal(c.getTasks({ scope: "all" }).length, 1);
  assert.equal(c.getTasks()[0].status, "running");
  assert.deepEqual(completed, []);
});

test("all background tasks must settle, while peer messages and unrelated completions do not settle them", async t => {
  const { c, file } = await fixture(t);
  const result = (n, id, bash = false) => row("user", n, { role: "user", content: [{ type: "tool_result", tool_use_id: `call-${n}`, content: "launched" }] },
    { toolUseResult: bash ? { backgroundTaskId: id } : { status: "async_launched", isAsync: true, agentId: id } });
  await writeFile(file, jsonl([user(1, "用户请求"), result(2, "child-a"), result(3, "child-b", true),
    user(4, '<agent-message from="child-a">进度</agent-message>', { isMeta: true, origin: { kind: "peer" } }),
    user(5, notice("unrelated")), answer(6)]));
  await c.scanOnce();
  assert.equal(c.getTasks()[0].status, "running");
  await appendFile(file, jsonl([user(7, notice("child-a", "failed")), answer(8)]));
  await c.scanOnce();
  assert.equal(c.getTasks()[0].status, "running");
  await appendFile(file, jsonl([user(9, notice("child-b", "stopped")), answer(10)]));
  await c.scanOnce();
  assert.equal(c.getTasks()[0].status, "completed");
  assert.equal(c.getTasks({ scope: "all" }).length, 1);
});

test("subagent Stop cannot complete the parent and a fresh human prompt still creates a new task", async t => {
  const { c } = await fixture(t);
  await c.ingest(hook("UserPromptSubmit", 1, { prompt: "用户请求" }));
  await c.ingest(hook("Stop", 2, { agentId: "child" }));
  await c.ingest(hook("Stop", 3, { isSidechain: true }));
  assert.equal(c.getTasks()[0].status, "running");
  await c.ingest(hook("Stop", 4));
  await c.ingest(hook("UserPromptSubmit", 5, { prompt: "下一个请求" }));
  assert.equal(c.getTasks({ scope: "all" }).length, 2);
  assert.equal(c.getTasks()[0].question, "下一个请求");
});

test("late queued attachment settles background work without moving the activity clock backwards", async t => {
  const { c, file } = await fixture(t);
  await writeFile(file, jsonl([user(1, "用户请求"),
    row("user", 2, { role: "user", content: [{ type: "tool_result", tool_use_id: "launch", content: "launched" }] }, { toolUseResult: { status: "async_launched", agentId: "child" } }), answer(3)]));
  await c.scanOnce();
  await c.ingest(hook("UserPromptSubmit", 1, { prompt: "用户请求", prompt_id: "human" }));
  await c.ingest(hook("Stop", 5));
  assert.equal(c.getTasks()[0].status, "running");
  await appendFile(file, jsonl([
    row("attachment", 4, undefined, { parentUuid: "r3", attachment: { type: "queued_command", origin: { kind: "task-notification" }, prompt: notice("child") } }),
  ]));
  await c.scanOnce();
  assert.deepEqual(c.getTasks()[0].pendingBackgroundTasks, []);
  assert.equal(c.getTasks()[0].lastActivityAt, at(5));
  assert.equal(c.getTasks()[0].status, "running");
  await appendFile(file, jsonl([{ ...answer(6), parentUuid: "r4" }]));
  await c.scanOnce();
  assert.equal(c.getTasks()[0].status, "completed");
});

test("resumed agent needs its new completion, even if the previous run reports late", async t => {
  const { c, file } = await fixture(t);
  const settled = (n, call) => row("attachment", n, undefined, { attachment: { type: "queued_command", origin: { kind: "task-notification" },
    prompt: notice("child").replace("<status>", `<tool-use-id>${call}</tool-use-id><status>`) } });
  await writeFile(file, jsonl([user(1, "用户请求"),
    row("user", 2, { role: "user", content: [{ type: "tool_result", tool_use_id: "old-call", content: "launched" }] }, { toolUseResult: { status: "async_launched", agentId: "child" } }),
    settled(3, "old-call"),
    row("user", 4, { role: "user", content: [{ type: "tool_result", tool_use_id: "new-call", content: "sent" }] }, { toolUseResult: { success: true, resumedAgentId: "child", revivedAgentId: "child" } }),
    settled(5, "old-call"), answer(6),
  ]));
  await c.scanOnce();
  assert.equal(c.getTasks()[0].status, "running");
  assert.deepEqual(c.getTasks()[0].pendingBackgroundTasks, ["child"]);
  await appendFile(file, jsonl([settled(7, "new-call"), answer(8)]));
  await c.scanOnce();
  assert.equal(c.getTasks()[0].status, "completed");
});

test("an attachment enqueued before the user prompt preserves the following tool ancestry", async t => {
  const { c, file } = await fixture(t);
  await writeFile(file, jsonl([user(1, "用户请求"),
    row("attachment", 2, undefined, { timestamp: at(0), attachment: { type: "model" } }),
    row("user", 3, { role: "user", content: [{ type: "tool_result", tool_use_id: "launch", content: "launched" }] }, { toolUseResult: { status: "async_launched", agentId: "child" } }),
    answer(4),
  ]));
  await c.scanOnce();
  assert.equal(c.getTasks()[0].status, "running");
  assert.deepEqual(c.getTasks()[0].pendingBackgroundTasks, ["child"]);
  await appendFile(file, jsonl([user(5, notice("child")), answer(6)]));
  await c.scanOnce();
  assert.equal(c.getTasks()[0].status, "completed");
});

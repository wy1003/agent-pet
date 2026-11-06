import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ClaudeActivityCollector } from "../src/claude-collector.mjs";

const epoch = 1_800_000_000_000;
const at = n => new Date(epoch + n * 1000).toISOString();
const user = (n = 1, text = "自动发现", uuid = `u${n}`) => ({ type: "user", uuid, sessionId: "chat", timestamp: at(n), cwd: "D:/项目", message: { role: "user", content: text } });
const answer = (n = 2, stop = "end_turn", parentUuid = "u1") => ({ type: "assistant", uuid: `a${n}`, parentUuid, sessionId: "chat", timestamp: at(n), message: {
  role: "assistant", stop_reason: stop, content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "自动完成" }],
} });
const jsonl = (...rows) => rows.map(row => `${JSON.stringify(row)}\n`).join("");
async function fixture(t, extra = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pet-discovery-"));
  const projects = path.join(root, "配置 中文", "projects"), file = path.join(projects, "项目 空格", "chat.jsonl");
  await mkdir(path.dirname(file), { recursive: true });
  const options = { eventsDir: path.join(root, "app-events"), statePath: path.join(root, "app-state.json"), transcriptsDir: projects, now: () => epoch + 100_000, ...extra };
  const instances = [];
  const create = () => { const c = new ClaudeActivityCollector(options); instances.push(c); return c; };
  t.after(async () => { for (const c of instances) await c.stop().catch(() => {}); await rm(root, { recursive: true, force: true }); });
  return { root, projects, file, options, create, c: create() };
}
const hook = (name, n, extra = {}) => ({ session_id: "chat", hook_event_name: name, timestamp: at(n), event_id: `h-${name}-${n}`, ...extra });

test("without installing Hooks, a native transcript discovers and completes a task read-only", async t => {
  const { c, file, options } = await fixture(t);
  const source = jsonl(user(), answer());
  await writeFile(file, source);
  await c.scanOnce();
  assert.equal(c.getTasks().length, 1);
  const task = c.getTasks()[0];
  assert.equal(task.sessionId, "claude:chat");
  assert.equal(task.question, "自动发现");
  assert.equal(task.latestResponse, "自动完成");
  assert.equal(task.status, "completed");
  assert.equal(c.isSessionActive("claude:chat"), true, "end_turn is not proof the original client released the session");
  assert.equal(await readFile(file, "utf8"), source);
  assert.deepEqual(await readdir(options.eventsDir), []);
});

test("incremental partial UTF-8 lines wait for newline and emit completion only once", async t => {
  const { c, file } = await fixture(t);
  const completions = [];
  for (const event of ["task.created", "task.updated"]) c.on(event, task => { if (task.status === "completed") completions.push(task); });
  await writeFile(file, jsonl(user()));
  await c.scanOnce();
  assert.equal(c.getTasks()[0].status, "running");
  const bytes = Buffer.from(JSON.stringify(answer()));
  await appendFile(file, bytes.subarray(0, bytes.length - 3));
  await c.scanOnce();
  assert.equal(c.getTasks()[0].status, "running");
  await appendFile(file, bytes.subarray(bytes.length - 3));
  await c.scanOnce();
  assert.equal(c.getTasks()[0].status, "running");
  await appendFile(file, "\n");
  await c.scanOnce();
  await c.scanOnce();
  assert.equal(completions.length, 1);
});

test("assistant text without explicit end_turn is unknown, never a completion inferred from silence", async t => {
  const { c, file } = await fixture(t);
  await writeFile(file, jsonl(user(), answer(2, null)));
  await c.scanOnce();
  await c.scanOnce();
  assert.equal(c.getTasks()[0].status, "unknown");
  assert.equal(c.getTasks()[0].completionPending, true);
  assert.equal(c.getTasks()[0].latestResponse, "自动完成");
  await appendFile(file, jsonl(answer(3, "end_turn", "a2")));
  await c.scanOnce();
  assert.equal(c.getTasks()[0].status, "completed");
});

test("tool use and tool_result do not create another user turn or a completion", async t => {
  const { c, file } = await fixture(t);
  await writeFile(file, jsonl(user(), { ...answer(2, "tool_use"), message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "tool", name: "Read", input: {} }] } },
    { ...user(3), parentUuid: "a2", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool", content: "data" }] } }));
  await c.scanOnce();
  assert.equal(c.getTasks({ scope: "all" }).length, 1);
  assert.equal(c.getTasks()[0].status, "running");
  await appendFile(file, jsonl(answer(4, "end_turn", "u3")));
  await c.scanOnce();
  assert.equal(c.getTasks()[0].status, "completed");
});

test("sidechains, meta/compact messages, wrong session and auxiliary projects are excluded", async t => {
  const { c, file } = await fixture(t, { ignoredProjectPaths: ["D:/aux"] });
  await writeFile(file, jsonl({ ...user(), isSidechain: true }, { ...user(2), isMeta: true }, { ...user(3), isCompactSummary: true },
    { ...user(4), sessionId: "wrong" }, { ...user(5), agentId: "subagent" }, { ...user(6), cwd: "D:/aux" },
    { ...user(7), metadata: { agent_pet_auxiliary: true } }));
  await c.scanOnce();
  assert.deepEqual(c.getTasks(), []);
});

test("a delayed old branch answer cannot finish the latest user turn", async t => {
  const { c, file } = await fixture(t);
  await writeFile(file, jsonl(user(), user(2, "第二轮"), answer(3, "end_turn", "u1")));
  await c.scanOnce();
  assert.equal(c.getTasks()[0].question, "第二轮");
  assert.equal(c.getTasks()[0].status, "running");
  await appendFile(file, jsonl(answer(4, "end_turn", "u2")));
  await c.scanOnce();
  assert.equal(c.getTasks()[0].status, "completed");
});

test("startup omits old history but follows a new turn appended to the same file", async t => {
  const { c, file } = await fixture(t);
  await writeFile(file, jsonl(user(-100000), answer(-99999, "end_turn", "u-100000")));
  await c.scanOnce();
  assert.equal(c.getTasks().length, 0);
  await appendFile(file, jsonl(user(), answer()));
  await c.scanOnce();
  assert.equal(c.getTasks().length, 1);
});

test("read and dismissed transcript tasks stay acknowledged after restart", async t => {
  const { c, create, file } = await fixture(t);
  await writeFile(file, jsonl(user(), answer()));
  await c.scanOnce();
  c.markRead("claude:chat");
  await c.dismissTask(c.getTasks()[0].taskId);
  await c.stop();
  const next = create(), events = [];
  next.on("task.created", task => events.push(task));
  await next.scanOnce();
  assert.equal(next.getSession("claude:chat").status.unread, false);
  assert.equal(next.getTasks().length, 0);
  assert.equal(events.length, 0);
  await appendFile(file, jsonl(user(3, "新一轮"), answer(4, "end_turn", "u3")));
  await next.scanOnce();
  assert.equal(next.getTasks()[0].question, "新一轮");
});

test("truncation restarts bounded scanning without duplicating known UUID turns", async t => {
  const { c, file } = await fixture(t);
  await writeFile(file, jsonl(user(), answer()));
  await c.scanOnce();
  await writeFile(file, jsonl(user()));
  await c.scanOnce();
  await appendFile(file, jsonl(answer(), user(3, "重写后"), answer(4, "end_turn", "u3")));
  await c.scanOnce();
  assert.equal(c.getTasks({ scope: "all" }).length, 2);
  assert.equal(c.getTasks()[0].question, "重写后");
});

for (const order of ["hook-first", "transcript-first"]) {
  test(`${order}: optional Hook and transcript evidence share one task and completion`, async t => {
    const { c, file } = await fixture(t);
    const events = [], created = [];
    c.on("task.created", task => created.push(task));
    for (const name of ["task.created", "task.updated"]) c.on(name, task => events.push(task));
    if (order === "hook-first") await c.ingest(hook("UserPromptSubmit", 1, { prompt: "自动发现", prompt_id: "hook-turn" }));
    await writeFile(file, jsonl(user(), answer()));
    await c.scanOnce();
    assert.equal(c.getTasks()[0].status, "completed", "transcript completion works before the optional Stop hook");
    if (order === "transcript-first") await c.ingest(hook("UserPromptSubmit", 1, { prompt: "自动发现", prompt_id: "hook-turn" }));
    await c.ingest(hook("Stop", 3, { prompt_id: "hook-turn", last_assistant_message: "自动完成" }));
    await c.scanOnce();
    assert.equal(c.getTasks({ scope: "all" }).length, 1);
    assert.equal(c.getTasks()[0].status, "completed");
    assert.equal(created.length, 1);
    assert.equal(events.filter((task, index) => task.status === "completed" && events[index - 1]?.status !== "completed").length, 1);
  });
}

test("identical questions with distinct UUIDs remain distinct turns", async t => {
  const { c, file } = await fixture(t);
  await writeFile(file, jsonl(user(), answer(), user(3), answer(4, "end_turn", "u3")));
  await c.scanOnce();
  assert.equal(c.getTasks({ scope: "all" }).length, 2);
  assert.equal(c.getTasks().length, 1);
});

test("project junctions and hardlinked session files are not read", async t => {
  const { c, file, projects, root } = await fixture(t);
  const outside = path.join(root, "outside");
  await mkdir(outside);
  const target = path.join(outside, "chat.jsonl");
  await writeFile(target, jsonl(user(), answer()));
  await link(target, file);
  try { await symlink(outside, path.join(projects, "linked"), process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (error.code !== "EPERM") throw error; }
  await c.scanOnce();
  assert.equal(c.getTasks().length, 0);
});

test("invalid native UUID types and oversized records cannot synthesize user turns", async t => {
  const { c, file } = await fixture(t);
  await writeFile(file, jsonl({ ...user(), uuid: 42 }));
  await c.scanOnce();
  assert.equal(c.getTasks().length, 0);
  await appendFile(file, "x".repeat(2 * 1024 * 1024) + "\n" + jsonl(user(3), answer(4, "end_turn", "u3")));
  for (let i = 0; i < 4; i++) await c.scanOnce();
  assert.equal(c.getTasks({ scope: "all" }).length, 1);
  assert.equal(c.getTasks()[0].status, "completed");
});

test("initial tail without a user anchor cannot attach an old answer to a new task", async t => {
  const { c, file } = await fixture(t);
  await writeFile(file, jsonl(user()) + "x".repeat(2 * 1024 * 1024) + "\n" + jsonl(answer()));
  await c.scanOnce();
  assert.equal(c.getTasks().length, 0);
  await appendFile(file, jsonl(user(3), answer(4, "end_turn", "u3")));
  await c.scanOnce();
  assert.equal(c.getTasks()[0].status, "completed");
});

test("a late unnumbered Stop follows its Hook turn, not the newest transcript turn", async t => {
  const { c, file } = await fixture(t);
  await writeFile(file, jsonl(user(), answer(), user(3, "新问题")));
  await c.scanOnce();
  await c.ingest(hook("UserPromptSubmit", 1, { prompt: "自动发现" }));
  await c.ingest(hook("Stop", 4, { last_assistant_message: "OLD ANSWER" }));
  assert.equal(c.getTasks()[0].question, "新问题");
  assert.equal(c.getTasks()[0].status, "running");
  assert.notEqual(c.getTasks()[0].latestResponse, "OLD ANSWER");
});

test("an orphan Stop does not suppress automatic discovery of an unregistered turn", async t => {
  const { c, file } = await fixture(t);
  await writeFile(file, jsonl(user(), answer()));
  await c.ingest(hook("Stop", 3));
  await c.scanOnce();
  assert.equal(c.getTasks().length, 1);
  assert.equal(c.getTasks()[0].status, "completed");
});

test("historical backfill preserves a newer SessionEnd release until a genuinely newer prompt", async t => {
  const { c, file } = await fixture(t);
  await c.ingest(hook("SessionEnd", 3));
  assert.equal(c.isSessionActive("chat"), false);
  await writeFile(file, jsonl(user(), answer()));
  await c.scanOnce();
  assert.equal(c.getTasks()[0].status, "completed");
  assert.equal(c.isSessionActive("chat"), false);
  await appendFile(file, jsonl(user(4, "真正的新请求")));
  await c.scanOnce();
  assert.equal(c.isSessionActive("chat"), true);
});

test("truncate and regrow with an unchanged prefix checks the consumed-position anchor", async t => {
  const { c, file } = await fixture(t);
  const prefix = jsonl({ padding: "p".repeat(300) });
  await writeFile(file, prefix + jsonl(user(), answer()));
  await c.scanOnce();
  await writeFile(file, prefix + jsonl(user(), user(3, "重写的新问题".repeat(200)), answer(4, "end_turn", "u3")));
  await c.scanOnce();
  assert.equal(c.getTasks({ scope: "all" }).length, 2);
  assert.equal(c.getTasks()[0].turnId, "u3");
  assert.equal(c.getTasks()[0].status, "completed");
});

test("long prompt correlation uses the original digest rather than truncated display text", async t => {
  const { c, file } = await fixture(t);
  const prompt = "x".repeat(66000);
  await writeFile(file, jsonl(user(1, prompt)));
  await c.scanOnce();
  await c.ingest(hook("UserPromptSubmit", 1, { prompt }));
  await c.ingest(hook("Stop", 2, { last_assistant_message: "结束" }));
  assert.equal(c.getTasks({ scope: "all" }).length, 1);
  assert.equal(c.getTasks()[0].status, "completed");
});

test("large recent transcript history stays bounded and does not block later tasks or read acknowledgements", async t => {
  const { c, file, projects, options } = await fixture(t);
  const text = "x".repeat(65536);
  for (let n = 0; n < 60; n++) {
    const sessionId = `large-${n}`;
    await writeFile(path.join(projects, "项目 空格", `${sessionId}.jsonl`), jsonl(
      { ...user(1, text), sessionId }, { ...answer(), sessionId, message: { role: "assistant", stop_reason: "end_turn", content: text } }));
  }
  await c.scanOnce();
  await writeFile(file, jsonl(user(3, "后来的短问题"), answer(4, "end_turn", "u3")));
  await c.scanOnce();
  assert.ok(c.getTasks().some(task => task.question === "后来的短问题"));
  assert.ok(c.markRead("claude:chat"));
  assert.ok((await readFile(options.statePath)).length < 16 * 1024 * 1024);
});

for (const type of ["attachment", "progress", "system"]) test(`native ${type} records without message do not abort discovery while Claude is thinking`, async t => {
  const { c, file } = await fixture(t);
  const diagnostics = [];
  c.on("diagnostic", value => diagnostics.push(value));
  await writeFile(file, jsonl(user(), {
    type, uuid: "progress-1", parentUuid: "u1", sessionId: "chat", timestamp: at(2),
    data: { type: "hook_progress", hookEvent: "UserPromptSubmit" },
  }));
  await c.scanOnce();
  assert.equal(c.getTasks().length, 1);
  assert.equal(c.getTasks()[0].status, "running");
  await appendFile(file, jsonl({ ...answer(3, null, "progress-1"), message: { role: "assistant", content: [{ type: "thinking", thinking: "not public" }] } }));
  await c.scanOnce();
  assert.equal(c.getTasks()[0].status, "running");
  assert.deepEqual(diagnostics, []);
  await appendFile(file, jsonl(answer(4, "end_turn", "a3")));
  await c.scanOnce();
  assert.equal(c.getTasks()[0].status, "completed");
});

test("missing Claude projects is a normal empty source, not created by the scanner", async t => {
  const { c, projects } = await fixture(t);
  await rm(projects, { recursive: true });
  await c.scanOnce();
  assert.deepEqual(c.getTasks(), []);
  await assert.rejects(readdir(projects), { code: "ENOENT" });
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, appendFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ClaudeActivityCollector } from "../src/claude-collector.mjs";

const at = (n) => new Date(1_800_000_000_000 + n * 1000).toISOString();
const event = (hook, n, extra = {}) => ({ hook_event_name: hook, session_id: "chat", timestamp: at(n), event_id: `e${n}`, ...extra });
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-pet-claude-"));
  const options = { eventsDir: path.join(root, "events"), transcriptsDir: path.join(root, "transcripts 中文"), statePath: path.join(root, "state.json"), now: () => at(99) };
  const collectors = [];
  const create = () => { const c = new ClaudeActivityCollector(options); collectors.push(c); return c; };
  await mkdir(options.eventsDir);
  t.after(async () => { for (const c of collectors) await c.stop().catch(() => {}); await rm(root, { recursive: true, force: true }); });
  return { root, options, create, c: create() };
}

// Local fixtures use Claude Code JSONL's outer sessionId/type/timestamp and
// message.role/content/stop_reason. Only explicit Stop changes lifecycle state.
const transcriptUser = (n = 1, text = "问题") => ({ type: "user", sessionId: "chat", timestamp: at(n), message: { role: "user", content: text } });
const transcriptAnswer = (n = 2, text = "最终 回答") => ({ type: "assistant", sessionId: "chat", timestamp: at(n), message: {
  role: "assistant", stop_reason: "end_turn", content: [{ type: "thinking", thinking: "not public" }, { type: "text", text }],
} });
const jsonl = (...records) => records.map((record) => JSON.stringify(record) + "\n").join("");
async function transcriptFixture(t) {
  const value = await fixture(t);
  const transcript = path.join(value.options.transcriptsDir, "项目 空格", "chat.jsonl");
  await mkdir(path.dirname(transcript), { recursive: true });
  await writeFile(transcript, jsonl(transcriptUser()));
  return { ...value, transcript };
}

test("Stop response is supplemented after delayed JSONL append, only once and read-only", async (t) => {
  const { c, transcript } = await transcriptFixture(t);
  const updates = [];
  c.on("task.updated", (value) => updates.push(value));
  await c.ingest(event("UserPromptSubmit", 1, { prompt: "问题" }));
  await c.ingest(event("Stop", 2, { transcript_path: transcript }));
  await c.scanOnce();
  assert.equal(c.getTasks()[0].status, "completed");
  assert.equal(c.getTasks()[0].latestResponse, "");
  await appendFile(transcript, JSON.stringify(transcriptAnswer()));
  await c.scanOnce();
  assert.equal(c.getTasks()[0].latestResponse, "", "partial final line is retried later");
  await appendFile(transcript, "\n");
  const original = await readFile(transcript, "utf8");
  await c.scanOnce();
  await c.scanOnce();
  assert.equal(c.getTasks()[0].latestResponse, "最终 回答");
  assert.equal(c.getSession("claude:chat").latestAssistantText, "最终 回答");
  assert.equal(updates.filter((row) => row.latestResponse).length, 1);
  assert.equal(updates.length, 2, "one Stop update and one enrichment, with no new completion transition");
  assert.equal(await readFile(transcript, "utf8"), original);
});

test("pending transcript enrichment survives restart and replay without re-creating completion", async (t) => {
  const { c, create, transcript } = await transcriptFixture(t);
  await c.ingest(event("UserPromptSubmit", 1, { prompt: "问题" }));
  await c.ingest(event("Stop", 2, { transcript_path: transcript }));
  await c.stop();
  await appendFile(transcript, jsonl(transcriptAnswer()));
  const next = create(), created = [], updated = [];
  next.on("task.created", (value) => created.push(value));
  next.on("task.updated", (value) => updated.push(value));
  await next.scanOnce();
  await next.ingest(event("Stop", 2, { transcript_path: transcript }));
  await next.scanOnce();
  assert.equal(next.getTasks()[0].latestResponse, "最终 回答");
  assert.equal(created.length, 0);
  assert.equal(updated.length, 1);
});

test("transcripts never infer completion or overwrite a newer turn or explicit Stop text", async (t) => {
  const { c, transcript } = await transcriptFixture(t);
  await c.ingest(event("UserPromptSubmit", 1, { prompt: "问题", transcript_path: transcript }));
  await appendFile(transcript, jsonl(transcriptAnswer()));
  await c.scanOnce();
  assert.equal(c.getTasks()[0].status, "running");
  assert.equal(c.getTasks()[0].latestResponse, "");
  await c.ingest(event("Stop", 2, { transcript_path: transcript }));
  await c.ingest(event("UserPromptSubmit", 3, { prompt: "新问题" }));
  await c.scanOnce();
  assert.equal(c.getTasks()[0].latestResponse, "");
  assert.equal(c.getSession("claude:chat").latestAssistantText, "");
  await c.ingest(event("Stop", 4, { transcript_path: transcript, last_assistant_message: "明确结果" }));
  await c.scanOnce();
  assert.equal(c.getTasks()[0].latestResponse, "明确结果");
});

for (const [name, records] of [
  ["wrong session", [transcriptUser(), { ...transcriptAnswer(), sessionId: "other" }]],
  ["old turn", [transcriptUser(0), transcriptAnswer(0)]],
  ["different question", [transcriptUser(1, "别的问题"), transcriptAnswer()]],
  ["tool use is not final text", [transcriptUser(), { ...transcriptAnswer(), message: { ...transcriptAnswer().message, stop_reason: "tool_use" } }]],
  ["new user boundary", [transcriptUser(), transcriptUser(3, "下一轮"), transcriptAnswer(4)]],
  ["user anchor outside bounded tail", [transcriptUser(), { padding: "x".repeat(1024 * 1024) }, transcriptAnswer()]],
]) {
  test(`transcript enrichment rejects ${name}`, async (t) => {
    const { c, transcript } = await transcriptFixture(t);
    await writeFile(transcript, jsonl(...records));
    await c.ingest(event("UserPromptSubmit", 1, { prompt: "问题" }));
    await c.ingest(event("Stop", 2, { transcript_path: transcript }));
    await c.scanOnce();
    assert.equal(c.getTasks()[0].latestResponse, "");
    assert.equal(c.getTasks()[0].status, "completed");
  });
}

test("forged transcript path outside configured projects root is never used", async (t) => {
  const { c, root } = await transcriptFixture(t);
  const outside = path.join(root, "chat.jsonl");
  await writeFile(outside, jsonl(transcriptUser(), transcriptAnswer()));
  await c.ingest(event("UserPromptSubmit", 1, { prompt: "问题" }));
  await c.ingest(event("Stop", 2, { transcript_path: outside }));
  await c.scanOnce();
  assert.equal(c.getTasks()[0].latestResponse, "");
});

test("transcript project symlinks cannot escape the allowed root", async (t) => {
  const { c, root, options } = await transcriptFixture(t);
  const outside = path.join(root, "outside-project");
  await mkdir(outside);
  await writeFile(path.join(outside, "chat.jsonl"), jsonl(transcriptUser(), transcriptAnswer()));
  const link = path.join(options.transcriptsDir, "linked-project");
  try { await symlink(outside, link, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (error.code === "EPERM") return t.skip("symlink privilege unavailable"); throw error; }
  await c.ingest(event("UserPromptSubmit", 1, { prompt: "问题" }));
  await c.ingest(event("Stop", 2, { transcript_path: path.join(link, "chat.jsonl") }));
  await c.scanOnce();
  assert.equal(c.getTasks()[0].latestResponse, "");
});

test("Claude lifecycle exposes task/session contract and active ownership through Stop", async (t) => {
  const { c } = await fixture(t);
  const emitted = [];
  for (const name of ["task.created", "task.updated", "session.updated"]) c.on(name, (value) => emitted.push([name, value]));
  await c.ingest(event("SessionStart", 0, { cwd: "D:/项目", source: "startup" }));
  assert.equal(c.isSessionActive("chat"), true);
  assert.equal(c.getSession("claude:chat").sourceLabel, "Claude Code");
  await c.ingest(event("UserPromptSubmit", 1, { prompt_id: "p1", prompt: "请修复测试" }));
  const task = c.getTask("claude:chat:p1");
  assert.equal(task.sessionId, "claude:chat");
  assert.equal(task.nativeSessionId, "chat");
  assert.equal(task.providerId, "claude");
  assert.equal(task.question, "请修复测试");
  assert.equal(task.status, "running");
  assert.equal(task.canAcknowledge, false);
  assert.equal((await c.dismissTask(task.taskId)).reason, "task_not_terminal");
  await c.ingest(event("PermissionRequest", 2));
  assert.equal(c.getTasks()[0].phase, "waiting_approval");
  assert.equal(c.getTasks()[0].status, "needs_input");
  await c.ingest(event("PostToolUse", 3));
  assert.equal(c.getTasks()[0].status, "running");
  await c.ingest(event("Stop", 4, { last_assistant_message: "已完成" }));
  assert.equal(c.getTasks()[0].latestResponse, "已完成");
  assert.equal(c.getTasks()[0].status, "completed");
  assert.equal(c.isSessionActive("claude:chat"), true);
  const session = c.getSession("claude:chat");
  assert.equal(session.status.executionStatus, "completed");
  assert.equal(session.lastTurn.turnId, "p1");
  assert.equal(session.activeTurn, null);
  assert.equal(session.sessionKey, "claude:chat");
  assert.equal(c.markRead(session.sessionId).status.petStatus, "idle");
  assert.equal(c.getTasks().length, 1, "session read is not task acknowledgement, like Codex");
  await c.ingest(event("SessionEnd", 5));
  assert.equal(c.isSessionActive("chat"), false);
  assert.equal(emitted.filter(([name]) => name === "task.created").length, 1);
});

for (const [hook, extra, phase] of [["Notification", { notification_type: "permission_prompt" }, "waiting_approval"], ["Notification", { notification_type: "elicitation_dialog" }, "waiting_answer"]]) {
  test(`Claude ${extra.notification_type} waits until tool activity`, async (t) => {
    const { c } = await fixture(t);
    await c.ingest(event("UserPromptSubmit", 1, { prompt: "test" }));
    await c.ingest(event(hook, 2, extra));
    assert.equal(c.getTasks()[0].phase, phase);
    assert.equal(c.getTasks()[0].waitingFor, "user");
    await c.ingest(event("PostToolUse", 3));
    assert.equal(c.getTasks()[0].waitingFor, null);
  });
}

for (const [hook, status] of [["StopFailure", "failed"], ["SessionEnd", "interrupted"]]) {
  test(`Claude ${hook} does not claim success`, async (t) => {
    const { c } = await fixture(t);
    await c.ingest(event("UserPromptSubmit", 1, { prompt: "test" }));
    await c.ingest(event(hook, 2, { error: "connection lost" }));
    assert.equal(c.getTasks()[0].status, status);
    assert.equal(c.getTasks()[0].canAcknowledge, true);
    assert.equal((await c.dismissAllTasks()).tasks.length, 1);
    assert.deepEqual(c.getTasks(), []);
  });
}

test("generated turns persist, new questions auto-read old turns and replay cannot revive them", async (t) => {
  const { c, create } = await fixture(t);
  await c.ingest(event("UserPromptSubmit", 1, { prompt: "one" }));
  const firstId = c.getTasks()[0].taskId;
  await c.ingest(event("Stop", 2));
  await c.stop();
  const next = create();
  const notices = [];
  next.on("task.created", (value) => notices.push(value));
  await next.scanOnce();
  assert.equal(next.isSessionActive("chat"), true);
  await next.ingest(event("UserPromptSubmit", 3, { prompt: "two" }));
  const secondId = next.getTasks()[0].taskId;
  assert.notEqual(secondId, firstId);
  await next.ingest(event("Stop", 4));
  await next.ingest(event("Stop", 2));
  await next.ingest(event("StopFailure", 5, { prompt_id: firstId.split(":").at(-1) }));
  assert.deepEqual(next.getTasks().map((task) => task.taskId), [secondId]);
  assert.equal(next.getTasks({ scope: "all" }).length, 2);
  assert.equal(next.getTasks({ scope: "active" }).length, 0);
  assert.equal(notices.length, 1);
  assert.equal((await next.dismissTask(secondId)).ok, true);
  await next.stop();
  const last = create();
  await last.scanOnce();
  await last.ingest(event("Stop", 4));
  assert.deepEqual(last.getTasks(), []);
  assert.equal(last.getTasks({ scope: "all" }).length, 2);
});

test("deduplication, stale timestamps and old prompt events never replace the newest task", async (t) => {
  const { c } = await fixture(t);
  await c.ingest(event("UserPromptSubmit", 1, { prompt_id: "a", prompt: "one" }));
  await c.ingest(event("Stop", 2, { prompt_id: "a" }));
  await c.ingest(event("UserPromptSubmit", 3, { prompt_id: "b", prompt: "two" }));
  await c.ingest(event("UserPromptSubmit", 3, { prompt_id: "b", prompt: "two" }));
  await c.ingest(event("PermissionRequest", 2, { event_id: "late", prompt_id: "b" }));
  await c.ingest(event("SessionEnd", 9, { prompt_id: "a" }));
  await c.ingest(event("Stop", 8, { prompt_id: "a" }));
  assert.equal(c.getTasks()[0].status, "running");
  assert.equal(c.getTasks()[0].turnId, "b");
  assert.equal(c.isSessionActive("chat"), true);
});

test("subagents and explicitly marked auxiliary events cannot terminate the parent", async (t) => {
  const { c } = await fixture(t);
  await c.ingest(event("UserPromptSubmit", 1, { prompt: "parent" }));
  await c.ingest(event("Stop", 2, { agent_id: "child" }));
  await c.ingest(event("SessionEnd", 3, { agent_id: "child" }));
  await c.ingest(event("Stop", 4, { agent_pet_auxiliary: true }));
  await c.ingest(event("UserPromptSubmit", 5, { session_id: "aux", AGENT_PET_AUXILIARY: "1" }));
  assert.equal(c.getTasks()[0].status, "running");
  assert.equal(c.getSessions().length, 1);
});

test("explicit clients are labelled but unknown source is never guessed", async (t) => {
  const { c } = await fixture(t);
  for (const [client, label] of [["vscode", "Claude Code VS Code"], ["cli", "Claude Code CLI"], ["unknown", "Claude Code"]]) {
    await c.ingest(event("SessionStart", client.length, { session_id: client, event_id: client, client }));
    assert.equal(c.getSession(`claude:${client}`).sourceLabel, label);
  }
});

test("scan sorts event timestamps, removes consumed inbox files and serializes concurrent ingestion", async (t) => {
  const { c, options } = await fixture(t);
  await writeFile(path.join(options.eventsDir, "z.json"), JSON.stringify(event("UserPromptSubmit", 1, { prompt: "test" })));
  await writeFile(path.join(options.eventsDir, "a.json"), JSON.stringify(event("Stop", 2)));
  await Promise.all([c.scanOnce(), c.ingest(event("UserPromptSubmit", 3, { session_id: "other", prompt: "other" })), c.scanOnce()]);
  assert.equal(c.getTasks({ scope: "all" }).length, 2);
  assert.equal(c.getTasks({ scope: "all" }).find((task) => task.nativeSessionId === "chat").status, "completed");
  assert.deepEqual(await readdir(options.eventsDir), []);
  await c.stop();
  const state = JSON.parse(await readFile(options.statePath, "utf8"));
  assert.ok(state);
});

test("invalid and oversized events are diagnosed, logical IDs never become paths", async (t) => {
  const { c, options } = await fixture(t);
  const diagnostics = [];
  c.on("diagnostic", (value) => diagnostics.push(value));
  await writeFile(path.join(options.eventsDir, "bad.json"), "{");
  await writeFile(path.join(options.eventsDir, "large.json"), " ".repeat(1024 * 1024 + 1));
  await writeFile(path.join(options.eventsDir, "empty.json"), JSON.stringify({ hook_event_name: "Stop" }));
  await c.scanOnce();
  assert.ok(diagnostics.length >= 3);
  assert.deepEqual(c.getTasks(), []);
  await assert.rejects(c.ingest({ hook_event_name: "Stop" }), /session/i);
  await c.ingest(event("UserPromptSubmit", 1, { session_id: "../../outside", prompt_id: "../../turn", prompt: "safe logical identifiers" }));
  assert.equal(c.getTasks()[0].nativeSessionId, "../../outside");
  assert.deepEqual(await readdir(options.eventsDir), []);
});

test("inbox symlinks cannot read events outside the configured directory", async (t) => {
  const { c, root, options } = await fixture(t);
  const outside = path.join(root, "outside.json");
  await writeFile(outside, JSON.stringify(event("UserPromptSubmit", 1, { prompt: "outside" })));
  try { await symlink(outside, path.join(options.eventsDir, "escape.json")); }
  catch (error) { if (error.code === "EPERM") return t.skip("Windows symlink privilege unavailable"); throw error; }
  const diagnostics = [];
  c.on("diagnostic", (value) => diagnostics.push(value));
  await c.scanOnce();
  assert.deepEqual(c.getTasks(), []);
  assert.ok(diagnostics.length);
  assert.ok(await readFile(outside));
});

test("failed acknowledgement persists nothing and keeps the visible task", async (t) => {
  const { c, options } = await fixture(t);
  await c.ingest(event("UserPromptSubmit", 1, { prompt: "test" }));
  await c.ingest(event("Stop", 2));
  const diagnostics = [];
  c.on("diagnostic", (value) => diagnostics.push(value));
  await rm(options.statePath);
  await mkdir(options.statePath);
  assert.equal((await c.dismissTask(c.getTasks()[0].taskId)).reason, "state_persist_failed");
  assert.equal((await c.dismissAllTasks()).reason, "state_persist_failed");
  assert.equal(c.getTasks().length, 1);
  assert.ok(diagnostics.length >= 2);
  await rm(options.statePath, { recursive: true });
});

test("ingestion write failure retains inbox and task, then retries without duplicate notifications", async (t) => {
  const { c, options } = await fixture(t);
  await c.scanOnce();
  await mkdir(options.statePath);
  const notices = [], diagnostics = [];
  c.on("task.created", (value) => notices.push(value));
  c.on("diagnostic", (value) => diagnostics.push(value));
  await writeFile(path.join(options.eventsDir, "event.json"), JSON.stringify(event("UserPromptSubmit", 1, { prompt: "keep" })));
  await c.scanOnce();
  assert.equal(c.getTasks().length, 1);
  assert.equal((await readdir(options.eventsDir)).length, 1);
  assert.ok(diagnostics.length);
  await rm(options.statePath, { recursive: true });
  await c.scanOnce();
  assert.deepEqual(await readdir(options.eventsDir), []);
  assert.equal(notices.length, 1);
});

test("corrupt state is diagnosed and never silently overwritten", async (t) => {
  const { c, options } = await fixture(t);
  await writeFile(options.statePath, "{broken");
  const diagnostics = [];
  c.on("diagnostic", (value) => diagnostics.push(value));
  await assert.rejects(c.scanOnce());
  assert.ok(diagnostics.length);
  assert.equal(await readFile(options.statePath, "utf8"), "{broken");
  assert.equal(c.isSessionActive("chat"), true, "unloaded ownership is conservative");
});

test("scan applies default timestamps before ordering untimestamped events", async (t) => {
  const { c, options } = await fixture(t);
  await writeFile(path.join(options.eventsDir, "prompt.json"), JSON.stringify(event("UserPromptSubmit", 1, { prompt: "first" })));
  await writeFile(path.join(options.eventsDir, "stop.json"), JSON.stringify({ hook_event_name: "Stop", session_id: "chat", event_id: "stop-now" }));
  await c.scanOnce();
  assert.equal(c.getTasks()[0]?.status, "completed");
  assert.equal(c.getTasks()[0]?.completedAt, at(99));
});

test("equal timestamp inbox events order lifecycle start before completion", async (t) => {
  const { c, options } = await fixture(t);
  await writeFile(path.join(options.eventsDir, "z-prompt.json"), JSON.stringify(event("UserPromptSubmit", 1, { prompt_id: "p1", prompt: "test" })));
  await writeFile(path.join(options.eventsDir, "a-stop.json"), JSON.stringify(event("Stop", 1, { prompt_id: "p1", event_id: "stop" })));
  await c.scanOnce();
  assert.equal(c.getTasks()[0]?.status, "completed");
});

test("event deduplication has a persisted upper bound", async (t) => {
  const { c, create, options } = await fixture(t);
  await c.ingest(event("SessionStart", 0));
  const state = JSON.parse(await readFile(options.statePath, "utf8"));
  state.eventIds = Array.from({ length: 10_050 }, (_, n) => `old-${n}`);
  await writeFile(options.statePath, JSON.stringify(state));
  const next = create();
  await next.ingest(event("UserPromptSubmit", 1, { prompt: "bounded" }));
  const saved = JSON.parse(await readFile(options.statePath, "utf8"));
  assert.ok(saved.eventIds.length <= 10_000);
  assert.ok(saved.eventIds.includes("e1"));
});

test("markRead persists synchronously before publishing, without requiring stop to flush", async (t) => {
  const { c, options } = await fixture(t);
  await c.ingest(event("UserPromptSubmit", 1, { prompt: "read" }));
  await c.ingest(event("Stop", 2));
  const saved = [];
  c.on("session.updated", (value) => saved.push(value));
  const result = c.markRead("claude:chat");
  assert.equal(result.status.unread, false);
  // Capture disk immediately: no yielding to the collector queue.
  const { readFileSync } = await import("node:fs");
  assert.equal(JSON.parse(readFileSync(options.statePath, "utf8")).sessions[0].status.unread, false);
  assert.equal(saved.length, 1);
});

test("failed markRead rolls back memory and emits no false read or removal", async (t) => {
  const { c, options } = await fixture(t);
  await c.ingest(event("UserPromptSubmit", 1, { prompt: "read" }));
  await c.ingest(event("Stop", 2));
  const before = c.getSession("claude:chat"), updates = [], removals = [];
  c.on("session.updated", (value) => updates.push(value));
  c.on("task.removed", (value) => removals.push(value));
  await rm(options.statePath);
  await mkdir(options.statePath);
  assert.throws(() => c.markRead("claude:chat"), { code: "state_persist_failed" });
  assert.deepEqual(c.getSession("claude:chat"), before);
  assert.deepEqual(updates, []);
  assert.equal((await c.dismissTask(c.getTasks()[0].taskId)).reason, "state_persist_failed");
  assert.equal(c.getTasks().length, 1);
  assert.deepEqual(removals, []);
  await rm(options.statePath, { recursive: true });
  await c.scanOnce();
  assert.equal(JSON.parse(await readFile(options.statePath, "utf8")).sessions[0].status.unread, true);
  assert.deepEqual(updates, []);
  assert.equal((await readdir(path.dirname(options.statePath))).some((name) => name.endsWith(".tmp")), false);
});

test("session read state survives restart without clearing task visibility", async (t) => {
  const { c, create } = await fixture(t);
  await c.ingest(event("UserPromptSubmit", 1, { prompt: "read" }));
  await c.ingest(event("Stop", 2));
  c.markRead("claude:chat");
  await c.stop();
  const next = create();
  await next.scanOnce();
  assert.equal(next.getSession("claude:chat").status.unread, false);
  assert.equal(next.getTasks().length, 1);
});

test("orphan activity conservatively owns a session, but a late Stop cannot reopen an ended session", async (t) => {
  const { c } = await fixture(t);
  await c.ingest(event("Stop", 1));
  assert.equal(c.isSessionActive("chat"), true);
  await c.ingest(event("SessionEnd", 2));
  await c.ingest(event("Stop", 3));
  assert.equal(c.isSessionActive("chat"), false);
  assert.deepEqual(c.getTasks(), []);
});

test("oversized state is rejected rather than loaded or overwritten", async (t) => {
  const { c, options } = await fixture(t);
  await writeFile(options.statePath, JSON.stringify({ version: 1, sessions: [], tasks: [], visibleTaskIds: [], eventIds: [], padding: "x".repeat(16 * 1024 * 1024) }));
  await assert.rejects(c.scanOnce(), { code: "claude_state_too_large" });
  assert.equal(c.loaded, false);
});

test("state writes have a hard byte cap and preserve the last durable unread state", async (t) => {
  const { c, options } = await fixture(t);
  await c.ingest(event("UserPromptSubmit", 1, { prompt: "read" }));
  await c.ingest(event("Stop", 2));
  c.tasks.values().next().value.latestResponse = "x".repeat(16 * 1024 * 1024);
  assert.throws(() => c.markRead("claude:chat"), { code: "state_persist_failed" });
  assert.equal(JSON.parse(await readFile(options.statePath, "utf8")).sessions[0].status.unread, true);
  assert.equal(c.getSession("claude:chat").status.unread, true);
});

test("JSON null is corrupt state rather than an empty, writable baseline", async (t) => {
  const { c, options } = await fixture(t);
  await writeFile(options.statePath, "null");
  await assert.rejects(c.ingest(event("UserPromptSubmit", 1, { prompt: "do not overwrite" })), /state/i);
  assert.equal(await readFile(options.statePath, "utf8"), "null");
});

test("restored active ownership warns without inventing an end, and unknown ownership blocks resume", async (t) => {
  const { c, create } = await fixture(t);
  await c.ingest(event("SessionStart", 0));
  await c.stop();
  const next = create(), diagnostics = [];
  next.on("diagnostic", (value) => diagnostics.push(value));
  await next.scanOnce();
  assert.equal(next.isSessionActive("chat"), true);
  assert.ok(diagnostics.some((value) => value.code === "claude_ownership_unconfirmed"));
  assert.equal(next.isSessionActive("unknown-chat"), true);
  assert.equal(next.getSession("claude:unknown-chat"), null);
  await next.ingest(event("SessionEnd", 1));
  assert.equal(next.isSessionActive("chat"), false);
});

test("missing timestamps use now; repeated start and stop wait for pending writes", async (t) => {
  const { c, create } = await fixture(t);
  await Promise.all([c.start(), c.start()]);
  const pending = c.ingest({ hook_event_name: "UserPromptSubmit", session_id: "chat", prompt: "test" });
  await c.stop();
  await pending;
  const next = create();
  await next.scanOnce();
  assert.equal(next.getTasks()[0].submittedAt, at(99));
  await c.start();
  await c.stop();
});

import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexActivityCollector } from "../src/collector.mjs";

const at = (second) => new Date(Date.now() - 60_000 + second * 1_000).toISOString();
const event = (type, turnId, second, extra = {}) => ({
  type: "event_msg",
  timestamp: at(second),
  payload: { type, turn_id: turnId, ...extra },
});
const user = (sessionId, turnId, second) => event("item_completed", turnId, second, {
  thread_id: sessionId,
  item: { type: "UserMessage", id: `user-${turnId}`, content: [{ type: "text", text: turnId }] },
});
const serialize = (records) => records.map((record) => JSON.stringify(record) + "\n").join("");
const taskId = (sessionId, turnId) => `codex:${sessionId}:${turnId}`;

async function fixture(t) {
  const base = path.resolve(os.tmpdir());
  const root = await mkdtemp(path.join(base, "agent-pet-auto-read-"));
  const statePath = path.join(root, "state.json");
  const options = { codexHome: root, statePath, staleAfterMs: Number.MAX_SAFE_INTEGER };
  const collectors = [];
  function createCollector() {
    const collector = new CodexActivityCollector(options);
    collectors.push(collector);
    return collector;
  }
  const dir = path.join(root, "sessions");
  await mkdir(dir);
  const file = (id) => path.join(dir, `rollout-${id}.jsonl`);
  async function addSession(id, extra = {}) {
    await writeFile(file(id), serialize([{
      type: "session_meta",
      timestamp: at(0),
      payload: { id, cwd: root, thread_source: "user", ...extra },
    }]));
  }
  async function append(id, ...records) {
    await appendFile(file(id), serialize(records));
  }
  t.after(async () => {
    for (const collector of collectors) await collector.stop();
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), base);
    assert.ok(path.basename(resolved).startsWith("agent-pet-auto-read-"));
    await rm(resolved, { recursive: true, force: true });
  });
  return { statePath, createCollector, addSession, append };
}

for (const terminalEvent of ["task_complete", "task_failed", "turn_aborted"]) {
  test(`a new user turn auto-reads the previous ${terminalEvent} in the same session`, async (t) => {
    const { statePath, createCollector, addSession, append } = await fixture(t);
    await addSession("chat");
    const collector = createCollector();
    await collector.scanOnce();
    await append("chat", event("task_started", "first", 1), user("chat", "first", 2));
    await collector.scanOnce();
    await append("chat", event(terminalEvent, "first", 3));
    await collector.scanOnce();
    assert.equal(collector.getTasks().length, 1);

    const removed = [];
    collector.on("task.removed", (value) => removed.push(value.taskId));
    await append("chat", event("task_started", "second", 4));
    await collector.scanOnce();
    assert.equal(collector.getTasks().length, 2, "lifecycle start alone is not a read signal");
    await append("chat", user("chat", "second", 5));
    await collector.scanOnce();
    assert.deepEqual(collector.getTasks().map((task) => task.turnId), ["second"]);
    assert.deepEqual(removed, [taskId("chat", "first")]);
    assert.equal(collector.getTasks({ scope: "all" }).length, 2);
    assert.deepEqual(
      JSON.parse(await readFile(statePath, "utf8")).unacknowledgedTaskIds,
      [taskId("chat", "second")],
    );

    await append("chat", event("task_complete", "second", 6));
    await collector.scanOnce();
    const restarted = createCollector();
    await restarted.scanOnce();
    assert.deepEqual(restarted.getTasks().map((task) => task.turnId), ["second"]);
    assert.equal(restarted.getTasks()[0].status, "completed");
    assert.equal(restarted.getTasks({ scope: "all" }).length, 2);
  });
}

test("other chats, child tasks and internal lifecycle turns do not auto-read a chat", async (t) => {
  const { createCollector, addSession, append } = await fixture(t);
  await addSession("chat");
  await addSession("other");
  await addSession("child", { source: { subagent: { parent_thread_id: "chat" } } });
  const collector = createCollector();
  await collector.scanOnce();
  await append("chat", event("task_started", "first", 1), user("chat", "first", 2));
  await collector.scanOnce();
  await append("chat", event("task_complete", "first", 3));
  await collector.scanOnce();
  await append("other", event("task_started", "other-turn", 4), user("other", "other-turn", 5));
  await append("child", event("task_started", "child-turn", 4), user("child", "child-turn", 5));
  await append("chat", event("task_started", "internal", 4), event("task_complete", "internal", 6));
  await collector.scanOnce();
  assert.deepEqual(
    collector.getTasks().map((task) => task.taskId).sort(),
    [taskId("chat", "first"), taskId("other", "other-turn")].sort(),
  );

  await append("chat", event("task_started", "second", 7), user("chat", "second", 8));
  await collector.scanOnce();
  assert.deepEqual(
    collector.getTasks().map((task) => task.taskId).sort(),
    [taskId("chat", "second"), taskId("other", "other-turn")].sort(),
  );
});

test("startup clears accumulated older unread turns and keeps each chat's latest reminder", async (t) => {
  const { statePath, createCollector, addSession, append } = await fixture(t);
  await addSession("chat");
  await addSession("other");
  for (const [index, turnId] of ["first", "second", "latest"].entries()) {
    await append("chat",
      event("task_started", turnId, index * 3 + 1),
      user("chat", turnId, index * 3 + 2),
      event("task_complete", turnId, index * 3 + 3),
    );
  }
  await append("other",
    event("task_started", "other-turn", 1),
    user("other", "other-turn", 2),
    event("task_complete", "other-turn", 3),
  );
  await writeFile(statePath, JSON.stringify({
    version: 1,
    unacknowledgedTaskIds: [
      ...["first", "second", "latest"].map((turnId) => taskId("chat", turnId)),
      taskId("other", "other-turn"),
    ],
  }));
  const collector = createCollector();
  await collector.scanOnce();
  const expected = [taskId("chat", "latest"), taskId("other", "other-turn")].sort();
  assert.deepEqual(collector.getTasks().map((task) => task.taskId).sort(), expected);
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")).unacknowledgedTaskIds, expected);
  assert.equal(collector.getTasks({ scope: "all" }).length, 4);
});

test("replayed older completion cannot hide the latest unread turn or restore an auto-read task", async (t) => {
  const { createCollector, addSession, append } = await fixture(t);
  await addSession("chat");
  const collector = createCollector();
  await collector.scanOnce();
  for (const [index, turnId] of ["first", "latest"].entries()) {
    await append("chat",
      event("task_started", turnId, index * 3 + 1),
      user("chat", turnId, index * 3 + 2),
      event("task_complete", turnId, index * 3 + 3),
    );
    await collector.scanOnce();
  }
  assert.deepEqual(collector.getTasks().map((task) => task.turnId), ["latest"]);
  await append("chat", user("chat", "first", 10), event("task_complete", "first", 11));
  await collector.scanOnce();
  assert.deepEqual(collector.getTasks().map((task) => task.turnId), ["latest"]);
  assert.equal(collector.getTasks({ scope: "all" }).length, 2);
});

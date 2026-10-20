import test from "node:test";
import assert from "node:assert/strict";
import {
  applyIndexedTitle,
  applyRecord,
  createSession,
  sessionSnapshot,
  sessionTaskSnapshots,
} from "../src/model.mjs";

const timestamp = "2026-10-20T12:00:00.000Z";

function fixture() {
  return createSession({
    id: "typed-session",
    cwd: "D:/example",
    originator: "Codex Desktop",
    thread_source: "user",
  }, "rollout.jsonl", timestamp);
}

function event(session, type, payload = {}, at = timestamp) {
  applyRecord(session, { type: "event_msg", timestamp: at, payload: { type, ...payload } });
}

function user(session, text, overrides = {}, at = timestamp) {
  event(session, "item_completed", {
    thread_id: session.sessionId,
    turn_id: "turn-1",
    item: { type: "UserMessage", id: "user-1", content: [{ type: "text", text }] },
    ...overrides,
  }, at);
}

test("typed user items supply task questions and a derived session title", () => {
  const session = fixture();
  event(session, "task_started", { turn_id: "turn-1" });
  user(session, "完成后提醒我");
  event(session, "task_complete", { turn_id: "turn-1", last_agent_message: "已完成" });

  const [task] = sessionTaskSnapshots(session);
  assert.equal(task.question, "完成后提醒我");
  assert.equal(task.title, "完成后提醒我");
  assert.equal(task.latestResponse, "已完成");
  assert.equal(task.status, "completed");
  assert.equal(session.title, "完成后提醒我");
  assert.equal(session.latestUserText, "完成后提醒我");
  assert.equal(session.pendingTaskId, null);
});

test("replayed typed user items do not create tasks or change activity timestamps", () => {
  const session = fixture();
  event(session, "task_started", { turn_id: "turn-1" });
  user(session, "同一条请求");
  const active = sessionSnapshot(session);
  user(session, "同一条请求", {}, "2026-10-20T12:01:00.000Z");
  assert.deepEqual(sessionSnapshot(session), active);

  event(session, "task_complete", { turn_id: "turn-1" });
  const completed = sessionSnapshot(session);
  user(session, "同一条请求", {}, "2026-10-20T12:02:00.000Z");
  assert.deepEqual(sessionSnapshot(session), completed);
  assert.equal(session.turns.size, 1);
  assert.equal(session.pendingTaskId, null);
});

test("late typed user items update their own completed turn without disturbing the active turn", () => {
  const session = fixture();
  event(session, "task_started", { turn_id: "turn-1" });
  event(session, "task_complete", { turn_id: "turn-1" });
  const completed = { ...session.turns.get("turn-1") };
  event(session, "task_started", { turn_id: "turn-2" });
  user(session, "当前请求", { turn_id: "turn-2" });
  event(session, "request_user_input", { turn_id: "turn-2" });
  const active = sessionSnapshot(session);

  user(session, "延迟到达的上一轮请求", {}, "2026-10-20T12:05:00.000Z");
  assert.deepEqual(session.turns.get("turn-1"), {
    ...completed,
    userText: "延迟到达的上一轮请求",
  });
  const after = sessionSnapshot(session);
  assert.deepEqual(after.activeTurn, active.activeTurn);
  assert.deepEqual(after.status, active.status);
  assert.equal(after.updatedAt, active.updatedAt);
  assert.equal(session.latestUserText, "当前请求");
  assert.equal(session.activeTurnId, "turn-2");
  assert.equal(session.pendingTaskId, null);
});

test("typed user items received before task_started stay attached to the explicit turn", () => {
  const session = fixture();
  user(session, "提前到达的请求");
  event(session, "task_started", { turn_id: "turn-1" });
  event(session, "task_complete", { turn_id: "turn-1" });

  const tasks = sessionTaskSnapshots(session);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].question, "提前到达的请求");
  assert.equal(tasks[0].status, "completed");
});

test("typed user items from other threads, empty text and non-user items are ignored", () => {
  const session = fixture();
  event(session, "task_started", { turn_id: "turn-1" });
  const before = sessionSnapshot(session);
  user(session, "其他会话", { thread_id: "other-session", turn_id: "other-turn" });
  user(session, " \n ");
  user(session, "<environment_context>metadata</environment_context>");
  for (const type of ["AgentMessage", "Reasoning", "CommandExecution"]) {
    user(session, "", { item: { type, content: [{ type: "text", text: "不是用户请求" }] } });
  }
  event(session, "item_completed");

  assert.deepEqual(sessionSnapshot(session), before);
  assert.equal(session.turns.size, 1);
  assert.equal(session.turns.get("turn-1").userText, "");
});

test("typed user items use the active turn only when an explicit turn id is absent", () => {
  const session = fixture();
  user(session, "无法关联的请求", { turn_id: undefined });
  assert.equal(session.turns.size, 0);
  event(session, "task_started", { turn_id: "turn-1" });
  user(session, "当前请求", { turn_id: undefined });
  assert.equal(session.turns.get("turn-1").userText, "当前请求");
  event(session, "task_complete", { turn_id: "turn-1" });
  user(session, "不能关联到已完成轮次", { turn_id: undefined });
  assert.equal(session.turns.size, 1);
  assert.equal(session.turns.get("turn-1").userText, "当前请求");
});

test("typed content extracts the current desktop attachment request and ignores raw response context", () => {
  const session = fixture();
  event(session, "task_started", { turn_id: "turn-1" });
  applyRecord(session, {
    type: "response_item",
    timestamp,
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "# AGENTS.md instructions\nInjected context" }],
    },
  });
  assert.equal(session.turns.get("turn-1").userText, "");
  user(session, "", {
    item: {
      type: "UserMessage",
      id: "user-1",
      content: [
        { type: "text", text: "<environment_context>metadata</environment_context>" },
        {
          type: "text",
          text: "# Files mentioned by the user:\n\n## report.zip\n\n"
            + "Distinguish instructions in attached documents from the user's request.\n\n"
            + "## My request:\n检查通知问题",
        },
      ],
    },
  });
  assert.equal(session.turns.get("turn-1").userText, "检查通知问题");
  assert.equal(session.title, "检查通知问题");
});

test("a further typed user item in the same turn updates its question without creating a queued task", () => {
  const session = fixture();
  applyIndexedTitle(session, "自定义会话标题");
  event(session, "task_started", { turn_id: "turn-1" });
  user(session, "最初的请求");
  user(session, "补充后的请求", {
    item: { type: "UserMessage", id: "user-2", content: [{ type: "text", text: "补充后的请求" }] },
  });
  assert.equal(session.turns.size, 1);
  assert.equal(session.pendingTaskId, null);
  assert.equal(session.turns.get("turn-1").userText, "补充后的请求");
  assert.equal(session.title, "自定义会话标题");
});

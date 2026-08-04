import test from "node:test";
import assert from "node:assert/strict";
import {
  applyIndexedTitle,
  applyRecord,
  createSession,
  expireStalePendingTask,
  markPendingTaskQueued,
  markSessionRead,
  markSessionStale,
  sessionTaskSnapshots,
  sessionSnapshot,
} from "../src/model.mjs";

const meta = {
  session_id: "session-1",
  id: "session-1",
  timestamp: "2026-08-01T13:11:17.000Z",
  cwd: "D:\\project\\LianYi\\v3",
  originator: "codex_sdk_ts",
  source: "exec",
  thread_source: "user",
};

function event(type, payload, timestamp = "2026-08-01T13:11:18.000Z") {
  return { timestamp, type, payload };
}

test("reduces CC GUI content and lifecycle into a session snapshot", () => {
  const session = createSession(meta, "session.jsonl", meta.timestamp);
  applyRecord(session, event("event_msg", { type: "task_started", turn_id: "turn-1" }));
  applyRecord(
    session,
    event("event_msg", {
      type: "user_message",
      message: "<agents-instructions>project rules</agents-instructions>\n介绍一下你自己",
    }),
  );
  applyRecord(
    session,
    event("event_msg", {
      type: "agent_message",
      message: "我正在准备自我介绍。",
      phase: "commentary",
    }),
  );

  let snapshot = sessionSnapshot(session);
  assert.equal(snapshot.sourceKind, "cc-gui");
  assert.equal(snapshot.sourceLabel, "CC GUI");
  assert.equal(snapshot.projectName, "v3");
  assert.equal(snapshot.title, "介绍一下你自己");
  assert.equal(snapshot.latestUserText, "介绍一下你自己");
  assert.equal(snapshot.latestAssistantText, "我正在准备自我介绍。");
  assert.equal(snapshot.status.petStatus, "running");
  assert.equal(snapshot.status.executionStatus, "in_progress");
  assert.equal(snapshot.status.phase, "responding");
  assert.equal(snapshot.activeTurn.turnId, "turn-1");

  applyRecord(
    session,
    event(
      "event_msg",
      {
        type: "task_complete",
        turn_id: "turn-1",
        last_agent_message: "你好，我是 Codex。",
      },
      "2026-08-01T13:13:47.000Z",
    ),
  );
  snapshot = sessionSnapshot(session);
  assert.equal(snapshot.status.petStatus, "ready");
  assert.equal(snapshot.status.executionStatus, "completed");
  assert.equal(snapshot.status.unread, true);
  assert.equal(snapshot.activeTurn, null);
  assert.equal(snapshot.lastTurn.assistantFinal, "你好，我是 Codex。");

  markSessionRead(session, "2026-08-01T13:14:00.000Z");
  snapshot = sessionSnapshot(session);
  assert.equal(snapshot.status.petStatus, "idle");
  assert.equal(snapshot.status.unread, false);
});

test("legacy and repository folder names use the Agent Pet display brand", () => {
  const legacy = createSession(
    { id: "legacy-brand", cwd: "D:\\project\\CodexActivityCompanion" },
    "rollout.jsonl",
    "2026-08-03T00:00:00.000Z",
  );
  const repository = createSession(
    { id: "repository-brand", cwd: "D:\\project\\agent-pet" },
    "rollout.jsonl",
    "2026-08-03T00:00:00.000Z",
  );
  assert.equal(legacy.projectName, "Agent Pet");
  assert.equal(repository.projectName, "Agent Pet");
});

test("task_complete with an embedded error is classified as failed", () => {
  const session = createSession(meta, "session.jsonl", meta.timestamp);
  applyRecord(session, event("event_msg", { type: "task_started", turn_id: "turn-error" }));
  applyRecord(session, event("event_msg", { type: "user_message", message: "test failure" }));
  applyRecord(
    session,
    event("event_msg", {
      type: "task_complete",
      turn_id: "turn-error",
      last_agent_message: null,
      error: {
        message: "stream disconnected before completion",
        codex_error_info: "other",
      },
    }),
  );

  const snapshot = sessionSnapshot(session);
  assert.equal(snapshot.status.petStatus, "blocked");
  assert.equal(snapshot.status.executionStatus, "failed");
  assert.equal(snapshot.lastTurn.error, "stream disconnected before completion");
  assert.equal(sessionTaskSnapshots(session)[0].status, "failed");
});

test("remote compaction failure is attributed to the interrupted user task", () => {
  const session = createSession(meta, "session.jsonl", meta.timestamp);
  applyRecord(
    session,
    event(
      "event_msg",
      { type: "task_started", turn_id: "user-turn" },
      "2026-08-04T10:00:00.000Z",
    ),
  );
  applyRecord(
    session,
    event(
      "event_msg",
      { type: "user_message", message: "did the upload finish" },
      "2026-08-04T10:00:01.000Z",
    ),
  );
  applyRecord(
    session,
    event(
      "event_msg",
      { type: "turn_aborted", turn_id: "user-turn", reason: "interrupted" },
      "2026-08-04T10:00:10.000Z",
    ),
  );
  applyRecord(
    session,
    event(
      "event_msg",
      { type: "task_started", turn_id: "compact-turn" },
      "2026-08-04T10:00:10.010Z",
    ),
  );
  applyRecord(
    session,
    event(
      "event_msg",
      {
        type: "task_complete",
        turn_id: "compact-turn",
        error: { message: "Error running remote compact task: stream disconnected before completion" },
      },
      "2026-08-04T10:01:40.000Z",
    ),
  );

  const tasks = sessionTaskSnapshots(session);
  assert.equal(tasks.find((task) => task.turnId === "user-turn").status, "failed");
  assert.match(tasks.find((task) => task.turnId === "user-turn").error, /remote compact task/);
  assert.equal(tasks.find((task) => task.turnId === "compact-turn").status, "failed");
  assert.equal(sessionSnapshot(session).lastTurn.turnId, "user-turn");
  assert.equal(sessionSnapshot(session).status.executionStatus, "failed");
});

test("session index title overrides a derived title", () => {
  const session = createSession(meta, "session.jsonl", meta.timestamp);
  applyRecord(session, event("event_msg", { type: "user_message", message: "原始问题" }));
  assert.equal(applyIndexedTitle(session, "桌面应用标题"), true);
  assert.equal(sessionSnapshot(session).title, "桌面应用标题");
});

test("a user message written before task_started is attached only to the next turn", () => {
  const session = createSession(meta, "session.jsonl", meta.timestamp);
  applyRecord(session, event("event_msg", { type: "user_message", message: "提前写入的问题" }));
  applyRecord(session, event("event_msg", { type: "task_started", turn_id: "turn-early" }));
  let snapshot = sessionSnapshot(session);
  assert.equal(snapshot.activeTurn.userText, "提前写入的问题");

  applyRecord(
    session,
    event("event_msg", { type: "task_complete", turn_id: "turn-early", last_agent_message: "完成" }),
  );
  applyRecord(session, event("event_msg", { type: "task_started", turn_id: "turn-next" }));
  snapshot = sessionSnapshot(session);
  assert.equal(snapshot.activeTurn.userText, "");
});

test("subagent metadata preserves its parent relationship", () => {
  const session = createSession(
    {
      ...meta,
      id: "child-1",
      session_id: "parent-1",
      thread_source: "subagent",
      source: {
        subagent: {
          thread_spawn: { parent_thread_id: "parent-1", agent_nickname: "Kepler" },
        },
      },
    },
    "child.jsonl",
    meta.timestamp,
  );
  const snapshot = sessionSnapshot(session);
  assert.equal(snapshot.threadSource, "subagent");
  assert.equal(snapshot.parentSessionId, "parent-1");
  assert.equal(snapshot.rootSessionId, "parent-1");
  assert.equal(snapshot.sessionId, "child-1");
  assert.equal(snapshot.sourceKind, "subagent");
});

test("subagent source markers override missing or incorrect thread_source values", () => {
  const sourceMarked = createSession(
    {
      ...meta,
      id: "child-source-marked",
      session_id: "parent-source-marked",
      thread_source: "user",
      source: { subagent: { parent_thread_id: "parent-source-marked" } },
    },
    "child-source-marked.jsonl",
    meta.timestamp,
  );
  assert.equal(sessionSnapshot(sourceMarked).threadSource, "subagent");
  assert.equal(sessionSnapshot(sourceMarked).parentSessionId, "parent-source-marked");

  const relationshipOnly = createSession(
    {
      ...meta,
      id: "child-relationship-only",
      session_id: "parent-relationship-only",
      thread_source: "user",
      source: "vscode",
    },
    "child-relationship-only.jsonl",
    meta.timestamp,
  );
  assert.equal(sessionSnapshot(relationshipOnly).threadSource, "subagent");
  assert.equal(sessionSnapshot(relationshipOnly).parentSessionId, "parent-relationship-only");
});

test("lifecycle-only turns never inherit the session title", () => {
  const session = createSession(meta, "session.jsonl", meta.timestamp);
  applyIndexedTitle(session, "读取一下交接文档");
  applyRecord(session, event("event_msg", { type: "task_started", turn_id: "internal-run" }));
  applyRecord(
    session,
    event("event_msg", { type: "task_complete", turn_id: "internal-run" }),
  );

  const task = sessionTaskSnapshots(session)[0];
  assert.equal(task.question, "");
  assert.equal(task.title, "未命名任务");
});

test("every turn remains an independent task and terminal states never become idle", () => {
  const session = createSession(meta, "session.jsonl", meta.timestamp);

  applyRecord(session, event("event_msg", { type: "task_started", turn_id: "turn-1" }));
  applyRecord(session, event("event_msg", { type: "user_message", message: "first question" }));
  applyRecord(
    session,
    event("event_msg", {
      type: "task_complete",
      turn_id: "turn-1",
      last_agent_message: "first answer",
    }),
  );

  applyRecord(session, event("event_msg", { type: "task_started", turn_id: "turn-2" }));
  applyRecord(session, event("event_msg", { type: "user_message", message: "second question" }));

  let tasks = sessionTaskSnapshots(session);
  assert.deepEqual(
    tasks.map((task) => [task.turnId, task.status]),
    [
      ["turn-1", "completed"],
      ["turn-2", "running"],
    ],
  );

  applyRecord(
    session,
    event("event_msg", {
      type: "task_complete",
      turn_id: "turn-2",
      last_agent_message: "second answer",
    }),
  );
  markSessionRead(session);
  tasks = sessionTaskSnapshots(session);
  assert.deepEqual(tasks.map((task) => task.status), ["completed", "completed"]);
  assert.equal(tasks.some((task) => task.status === "idle"), false);
});

test("a question can be submitted, queued, and then adopted by the real turn", () => {
  const session = createSession(meta, "session.jsonl", meta.timestamp);
  applyRecord(
    session,
    event(
      "event_msg",
      { type: "user_message", message: "question waiting for execution" },
      "2026-08-01T13:11:18.000Z",
    ),
  );
  assert.equal(sessionTaskSnapshots(session)[0].status, "submitted");
  assert.equal(
    markPendingTaskQueued(session, Date.parse("2026-08-01T13:11:20.000Z"), 1_000),
    true,
  );
  assert.equal(sessionTaskSnapshots(session)[0].status, "queued");

  applyRecord(
    session,
    event(
      "event_msg",
      { type: "task_started", turn_id: "turn-real" },
      "2026-08-01T13:11:21.000Z",
    ),
  );
  const task = sessionTaskSnapshots(session)[0];
  assert.equal(task.turnId, "turn-real");
  assert.equal(task.status, "running");
  assert.equal(task.question, "question waiting for execution");
});

test("a user message submitted during an active turn remains a separate queued task", () => {
  const session = createSession(meta, "session.jsonl", meta.timestamp);
  applyRecord(session, event("event_msg", { type: "task_started", turn_id: "turn-active" }));
  applyRecord(session, event("event_msg", { type: "user_message", message: "current question" }));
  applyRecord(
    session,
    event(
      "event_msg",
      { type: "user_message", message: "question queued while the current turn is running" },
      "2026-08-01T13:11:18.000Z",
    ),
  );

  let tasks = sessionTaskSnapshots(session);
  assert.deepEqual(
    tasks.map((task) => [task.question, task.status]),
    [
      ["current question", "running"],
      ["question queued while the current turn is running", "submitted"],
    ],
  );
  assert.equal(
    markPendingTaskQueued(session, Date.parse("2026-08-01T13:11:20.000Z"), 1_000),
    true,
  );
  tasks = sessionTaskSnapshots(session);
  assert.deepEqual(tasks.map((task) => task.status), ["running", "queued"]);

  applyRecord(
    session,
    event(
      "event_msg",
      { type: "task_complete", turn_id: "turn-active", last_agent_message: "current answer" },
      "2026-08-01T13:11:21.000Z",
    ),
  );
  applyRecord(
    session,
    event(
      "event_msg",
      { type: "task_started", turn_id: "turn-next" },
      "2026-08-01T13:11:22.000Z",
    ),
  );
  tasks = sessionTaskSnapshots(session);
  const adopted = tasks.find((task) => task.turnId === "turn-next");
  assert.equal(adopted.status, "running");
  assert.equal(adopted.question, "question queued while the current turn is running");
});

test("a user message following turn_context belongs to that active turn", () => {
  const session = createSession(meta, "session.jsonl", meta.timestamp);
  applyRecord(
    session,
    event("event_msg", { type: "user_message", message: "tentative queued text" }),
  );
  applyRecord(session, event("event_msg", { type: "task_started", turn_id: "turn-context" }));
  applyRecord(
    session,
    event(
      "turn_context",
      { turn_id: "turn-context" },
      "2026-08-01T13:11:18.100Z",
    ),
  );
  applyRecord(
    session,
    event(
      "event_msg",
      { type: "user_message", message: "canonical current question" },
      "2026-08-01T13:11:18.110Z",
    ),
  );

  const tasks = sessionTaskSnapshots(session);
  assert.deepEqual(tasks.map((task) => [task.turnId, task.question, task.status]), [
    ["turn-context", "canonical current question", "running"],
  ]);
  assert.equal(session.pendingTaskId, null);
});

test("an orphaned pending task expires without becoming historical work", () => {
  const session = createSession(meta, "session.jsonl", meta.timestamp);
  applyRecord(session, event("event_msg", { type: "task_started", turn_id: "turn-active" }));
  applyRecord(session, event("event_msg", { type: "user_message", message: "current question" }));
  applyRecord(
    session,
    event(
      "event_msg",
      { type: "user_message", message: "orphaned pending question" },
      "2026-08-01T13:12:00.000Z",
    ),
  );
  applyRecord(
    session,
    event(
      "event_msg",
      { type: "task_complete", turn_id: "turn-active", last_agent_message: "done" },
      "2026-08-01T13:13:00.000Z",
    ),
  );
  markPendingTaskQueued(session, Date.parse("2026-08-01T13:13:01.000Z"), 0);

  assert.equal(
    expireStalePendingTask(
      session,
      Date.parse("2026-08-01T13:30:00.000Z"),
      15 * 60 * 1000,
    ),
    true,
  );
  assert.equal(session.pendingTaskId, null);
  assert.deepEqual(
    sessionTaskSnapshots(session).map((task) => [task.question, task.status]),
    [["current question", "completed"]],
  );
});

test("stale detection is applied to every unfinished task, not only the latest turn", () => {
  const session = createSession(meta, "session.jsonl", meta.timestamp);
  applyRecord(session, event("event_msg", { type: "task_started", turn_id: "turn-old" }));
  applyRecord(session, event("event_msg", { type: "user_message", message: "old question" }));
  applyRecord(
    session,
    event(
      "event_msg",
      { type: "task_started", turn_id: "turn-current" },
      "2026-08-01T13:20:00.000Z",
    ),
  );
  let tasks = sessionTaskSnapshots(session);
  assert.equal(tasks.find((task) => task.turnId === "turn-old").status, "unknown");
  assert.equal(tasks.find((task) => task.turnId === "turn-current").status, "running");

  assert.equal(
    markSessionStale(session, Date.parse("2026-08-01T13:40:00.000Z"), 15 * 60 * 1000),
    true,
  );
  tasks = sessionTaskSnapshots(session);
  assert.equal(tasks.find((task) => task.turnId === "turn-current").status, "unknown");
});

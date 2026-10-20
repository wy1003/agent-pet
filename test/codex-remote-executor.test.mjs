import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CodexRemoteExecutor,
  isCodexResponseTimeout,
} from "../desktop/codex-remote-executor.mjs";

function fakeThread(id, events) {
  return {
    id,
    async runStreamed(_input, options) {
      assert.equal(options.signal instanceof AbortSignal, true);
      return {
        events: (async function* stream() {
          for (const event of events) yield event;
        }()),
      };
    },
  };
}

test("Codex remote executor uses safe options and persists a new thread as soon as it starts", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-pet-codex-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const calls = [];
  const thread = fakeThread("session-new", [
    { type: "thread.started", thread_id: "session-new" },
    { type: "item.completed", item: { type: "agent_message", text: "完成了" } },
    { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
  ]);
  const executor = new CodexRemoteExecutor({
    codex: {
      startThread(options) {
        calls.push(options);
        return thread;
      },
    },
  });
  let started = "";
  const result = await executor.start({
    cwd,
    prompt: "检查设置页",
    signal: new AbortController().signal,
    onThreadStarted: (id) => { started = id; },
  });
  assert.equal(started, "session-new");
  assert.equal(result.finalResponse, "完成了");
  assert.equal(calls[0].sandboxMode, "workspace-write");
  assert.equal(calls[0].approvalPolicy, "never");
  assert.equal(calls[0].networkAccessEnabled, false);
  assert.equal(calls[0].webSearchMode, "disabled");
  assert.equal(calls[0].workingDirectory, await import("node:fs/promises").then(({ realpath }) => realpath(cwd)));
});

test("Codex remote executor resumes the exact saved session", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-pet-codex-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  let resumed = "";
  const executor = new CodexRemoteExecutor({
    codex: {
      resumeThread(id) {
        resumed = id;
        return fakeThread(id, [
          { type: "item.completed", item: { type: "agent_message", text: "继续完成" } },
          { type: "turn.completed", usage: {} },
        ]);
      },
    },
  });
  const result = await executor.resume({
    sessionId: "saved-session",
    cwd,
    prompt: "继续",
    signal: new AbortController().signal,
  });
  assert.equal(resumed, "saved-session");
  assert.equal(result.finalResponse, "继续完成");
});

test("Codex remote executor continues after reconnect errors and completes successfully", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-pet-codex-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const executor = new CodexRemoteExecutor({
    codex: {
      resumeThread(id) {
        return fakeThread(id, [
          { type: "turn.started" },
          { type: "error", message: "Reconnecting... 2/5 (request timed out)" },
          { type: "error", message: "Reconnecting... 5/5 (request timed out)" },
          { type: "item.completed", item: { type: "agent_message", text: "HTTPS fallback succeeded" } },
          { type: "turn.completed", usage: { input_tokens: 2, output_tokens: 3 } },
        ]);
      },
    },
  });

  const result = await executor.resume({
    sessionId: "saved-session",
    cwd,
    prompt: "继续",
    signal: new AbortController().signal,
  });

  assert.equal(result.finalResponse, "HTTPS fallback succeeded");
  assert.deepEqual(result.usage, { input_tokens: 2, output_tokens: 3 });
});

test("Codex remote executor reports the last reconnect error when the stream ends without completion", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-pet-codex-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const executor = new CodexRemoteExecutor({
    codex: {
      resumeThread(id) {
        return fakeThread(id, [
          { type: "turn.started" },
          { type: "error", message: "Reconnecting... 2/5 (request timed out)" },
        ]);
      },
    },
  });

  await assert.rejects(
    executor.resume({
      sessionId: "saved-session",
      cwd,
      prompt: "继续",
      signal: new AbortController().signal,
    }),
    (error) => {
      assert.equal(isCodexResponseTimeout(error), true);
      assert.equal(error.code, "codex_response_timeout");
      assert.equal(error.transient, true);
      assert.equal(error.turnStarted, true);
      return true;
    },
  );
});

test("Codex remote executor still treats turn.failed as a terminal failure", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-pet-codex-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const executor = new CodexRemoteExecutor({
    codex: {
      resumeThread(id) {
        return fakeThread(id, [
          { type: "turn.started" },
          { type: "turn.failed", error: { message: "request timed out" } },
          { type: "turn.completed", usage: {} },
        ]);
      },
    },
  });

  await assert.rejects(
    executor.resume({
      sessionId: "saved-session",
      cwd,
      prompt: "继续",
      signal: new AbortController().signal,
    }),
    (error) => {
      assert.equal(isCodexResponseTimeout(error), true);
      assert.equal(error.turnStarted, true);
      return true;
    },
  );
});

test("Codex remote executor blocks stream consumption until thread.started is durably recorded", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-pet-codex-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  let persisted = false;
  const executor = new CodexRemoteExecutor({
    codex: {
      startThread() {
        return {
          id: null,
          async runStreamed() {
            return {
              events: (async function* stream() {
                yield { type: "thread.started", thread_id: "durable-session" };
                assert.equal(persisted, true);
                yield { type: "turn.completed", usage: {} };
              }()),
            };
          },
        };
      },
    },
  });
  const result = await executor.start({
    cwd,
    prompt: "检查持久化顺序",
    onThreadStarted: async () => {
      await Promise.resolve();
      persisted = true;
    },
  });
  assert.equal(result.sessionId, "durable-session");
});

test("Codex remote executor refuses a new thread that never reports thread.started", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-pet-codex-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const executor = new CodexRemoteExecutor({
    codex: {
      startThread() {
        return fakeThread("late-only-id", [
          { type: "turn.completed", usage: {} },
        ]);
      },
    },
  });
  await assert.rejects(
    executor.start({
      cwd,
      prompt: "不能成为无法恢复的任务",
      signal: new AbortController().signal,
      onThreadStarted: async () => {},
    }),
    /未返回新会话 ID/,
  );
});

test("Codex remote executor validates the working directory before starting Codex", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-pet-codex-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  let started = false;
  const executor = new CodexRemoteExecutor({
    codex: {
      startThread() {
        started = true;
        throw new Error("must not be called");
      },
    },
  });
  await assert.rejects(
    executor.start({ cwd: path.join(cwd, "missing"), prompt: "检查" }),
    { message: "授权项目目录不存在或不可访问" },
  );
  assert.equal(started, false);
});

test("remote execution resolves the Desktop runtime for each request and preserves SDK configuration", async () => {
  let options;
  let resolutions = 0;
  const diagnostics = [];
  const executor = new CodexRemoteExecutor({
    codexOptions: { config: { model: "test-model" } },
    resolveExecutable: async () => { resolutions += 1; return "desktop-codex.exe"; },
    createCodex: (value) => {
      options = value;
      return { resumeThread: (id) => fakeThread(id, [{ type: "turn.completed" }]) };
    },
    onDiagnostic: (entry) => diagnostics.push(entry),
  });
  for (let i = 0; i < 2; i += 1) {
    await executor.resume({ sessionId: "saved", cwd: os.tmpdir(), prompt: "test", signal: new AbortController().signal });
  }
  assert.equal(resolutions, 2);
  assert.equal(options.codexPathOverride, "desktop-codex.exe");
  assert.equal(options.config.model, "test-model");
  assert.equal(diagnostics[0].executable, "desktop-codex.exe");
});

test("startup history and writer errors are not disguised by incidental timeout warnings", async () => {
  for (const [message, code] of [
    ["models request timed out; thread history projection expected ordinal 19, got 20", "codex_history_incompatible"],
    ["request timed out; thread abc already has an active writer", "codex_thread_busy"],
    ["request timed out", "codex_response_timeout"],
  ]) {
    const diagnostics = [];
    const executor = new CodexRemoteExecutor({
      codex: { resumeThread: () => fakeThread("saved", [{ type: "error", message }]) },
      onDiagnostic: (entry) => { diagnostics.push(entry); throw new Error("diagnostic unavailable"); },
    });
    await assert.rejects(executor.resume({
      sessionId: "saved", cwd: os.tmpdir(), prompt: "private prompt", signal: new AbortController().signal,
    }), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.turnStarted, false);
      assert.equal(isCodexResponseTimeout(error), code === "codex_response_timeout");
      return true;
    });
    assert.equal(diagnostics[0].code, code);
    assert.equal(JSON.stringify(diagnostics).includes("private prompt"), false);
    assert.equal(JSON.stringify(diagnostics).includes(message), false);
  }
});

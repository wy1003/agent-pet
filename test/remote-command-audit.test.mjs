import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RemoteTaskRegistry } from "../desktop/remote-task-registry.mjs";
import { RemoteControlController } from "../desktop/remote-control-controller.mjs";
import { parseRemoteCommand } from "../desktop/remote-command-parser.mjs";

async function waitFor(predicate) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("command did not reach its expected terminal state");
}

async function fixture(t, { status = "completed", blocking = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-pet-command-audit-"));
  const registry = new RemoteTaskRegistry(path.join(directory, "registry.json"));
  await registry.load();
  for (const index of [1, 2]) {
    await registry.observeTask({
      taskId: `codex:audit-session-${index}:turn-1`,
      sessionId: `audit-session-${index}`,
      projectKey: `audit-project-${index}`,
      projectName: `测试项目${index}`,
      cwd: directory,
      title: `测试任务${index}`,
      status: index === 1 ? status : "completed",
    });
  }
  const calls = [];
  const replies = [];
  let aborted = false;
  const controller = new RemoteControlController({
    registry,
    executor: {
      resume: async (value) => {
        calls.push({ kind: "resume", ...value });
        if (blocking) {
          return new Promise((_resolve, reject) => {
            const abort = () => { aborted = true; reject(value.signal.reason); };
            if (value.signal.aborted) abort();
            else value.signal.addEventListener("abort", abort, { once: true });
          });
        }
        return { finalResponse: "审计续问完成" };
      },
      start: async (value) => {
        calls.push({ kind: "start", ...value });
        await value.onThreadStarted("audit-session-new");
        return { sessionId: "audit-session-new", finalResponse: "审计新任务完成" };
      },
    },
    sendReply: async (text) => replies.push(text),
    getPolicy: () => ({ enabled: true }),
    isAuthorizedSender: (sender) => sender === "test-user",
    pollMs: 10,
    logger: { warn() {} },
  });
  t.after(async () => {
    await controller.stop();
    await rm(directory, { recursive: true, force: true });
  });
  let sequence = 0;
  const send = (text) => controller.handleInbound({
    channelId: "weixin", accountId: "test-account",
    messageId: String(++sequence), dedupeKey: `audit:${sequence}`,
    senderId: "test-user", conversationId: "test-user",
    conversationType: "private", text,
  });
  return { send, registry, calls, replies, controller, directory, wasAborted: () => aborted };
}

// This table is also checked against the guide: every advertised command must
// exercise the real controller, registry and queue, with only transport mocked.
const documentedCommands = [
  ["/help", "help"],
  ["/projects", "projects"],
  ["/sessions", "sessions"],
  ["/sessions P001", "sessions"],
  ["/S0001 请补充测试", "continue"],
  ["/P001 新任务：检查构建结果", "new"],
  ["/S0001 状态", "status"],
  ["/S0001 停止", "stop"],
  ["/S0001 重试", "retry"],
];

test("every command advertised in the guide has an execution check", async () => {
  const guide = await readFile(new URL("../docs/WEIXIN_REMOTE_CONTROL.md", import.meta.url), "utf8");
  const section = guide.split("## 支持的指令")[1].split("## ")[0];
  const commands = [...section.matchAll(/^\| `([^`]+)` \|/gm)].map((match) => match[1]);
  assert.deepEqual(commands, documentedCommands.map(([command]) => command));
});

for (const [command, action] of documentedCommands) {
  test(`documented command works: ${command}`, async (t) => {
    const f = await fixture(t, {
      status: action === "retry" ? "interrupted" : "completed",
      blocking: action === "stop",
    });
    if (action === "stop") {
      await f.send("/S0001 检查测试覆盖率");
      await waitFor(() => f.calls.length === 1);
      await f.send("/S0001 再检查边界条件");
    }
    const result = await f.send(command);
    assert.equal(result.ok, true);
    assert.equal(result.action, action);
    if (["continue", "new", "retry"].includes(action)) {
      assert.equal(result.queued, true);
      await waitFor(() => f.replies.some((reply) => reply.includes("Agent Pet · 已完成")));
      assert.equal(f.calls.length, 1);
      assert.equal(f.calls[0].cwd, f.directory);
      if (action === "new") {
        assert.equal(f.calls[0].kind, "start");
        assert.equal(f.calls[0].prompt, "检查构建结果");
        const session = f.registry.resolveSessionById("audit-session-new");
        assert.equal(session.projectCode, "P001");
        assert.equal(session.status, "completed");
        assert.match(f.replies.at(-1), /\/S0003 你的要求/);
      } else {
        assert.equal(f.calls[0].sessionId, "audit-session-1");
        assert.equal(f.registry.resolveSession("S0001").status, "completed");
        if (action === "continue") assert.equal(f.calls[0].prompt, "请补充测试");
        else assert.match(f.calls[0].prompt, /最后一条尚未完成的真实用户请求/);
      }
    } else if (action === "stop") {
      assert.equal(result.queuedCancelled, 1);
      await waitFor(() => f.wasAborted() && f.controller.status().active.length === 0);
      assert.equal(f.calls.length, 1);
      assert.equal(f.registry.resolveSession("S0001").status, "interrupted");
    } else {
      assert.equal(f.calls.length, 0);
      const reply = f.replies.at(-1);
      if (action === "help") {
        for (const token of ["/help", "/projects", "/sessions", "/P001", "/S0001", "状态", "停止", "重试"]) {
          assert.ok(reply.includes(token), token);
        }
      } else if (action === "projects") {
        assert.match(reply, /\/P001.*测试项目1/);
        assert.match(reply, /\/P002.*测试项目2/);
      } else if (action === "sessions") {
        assert.match(reply, /\/S0001/);
        if (command.endsWith("P001")) assert.doesNotMatch(reply, /\/S0002/);
        else assert.match(reply, /\/S0002/);
      } else assert.equal(result.state, "completed");
    }
  });
}

test("mixed project and session routes are rejected regardless of their order", async (t) => {
  const f = await fixture(t);
  for (const command of [
    "/S1 /P2/S2 状态", "/S1 /P2/C2 检查页面", "/P1 /S2 检查页面",
    "/S1 /P2 检查页面", "/P1/S1 /P2/S2 状态",
  ]) {
    assert.equal(parseRemoteCommand({ text: command }).reason, "multiple_routes", command);
    assert.equal((await f.send(command)).reason, "multiple_routes", command);
  }
  assert.equal(f.calls.length, 0);
});

test("unknown session commands report a missing route instead of requiring a new project", async (t) => {
  const f = await fixture(t);
  for (const command of ["/S9999 状态", "/S9999 请补充测试", "/C9999 重试"]) {
    assert.equal((await f.send(command)).reason, "route_not_found", command);
    assert.match(f.replies.at(-1), /编号不存在/);
    assert.doesNotMatch(f.replies.at(-1), /缺少项目编号/);
  }
  assert.equal(f.calls.length, 0);
});

test("missing new-task requirements return a usable slash command", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.send("/P001 新任务")).reason, "prompt_required");
  const suggestion = f.replies.at(-1).match(/请使用“([^”]+)”/)[1];
  assert.ok(suggestion.startsWith("/"));
  assert.equal((await f.send(suggestion)).action, "new");
  await waitFor(() => f.replies.some((reply) => reply.includes("审计新任务完成")));
  assert.equal(f.calls.length, 1);
});

test("ordinary requirement text is not consumed as command keywords", async (t) => {
  const f = await fixture(t);
  for (const prompt of ["新任务按钮需要修复", "继续按钮需要修复", "接着检查边界条件", "状态页面需要优化", "停止按钮样式有问题"]) {
    const result = await f.send(`/S0001 ${prompt}`);
    assert.equal(result.action, "continue", prompt);
    await waitFor(() => f.calls.at(-1)?.prompt === prompt
      && f.registry.resolveSession("S0001").status === "completed");
    assert.equal(f.calls.at(-1).sessionId, "audit-session-1");
  }
});

test("catalog aliases and legacy full routes remain usable", async (t) => {
  const f = await fixture(t);
  for (const [command, action] of [["/帮助", "help"], ["/项目", "projects"], ["/会话 /P1", "sessions"], ["/HELP", "help"]]) {
    assert.equal((await f.send(command)).action, action);
  }
  for (const command of ["/C1 继续：补充测试", "/P1/C1 继续：补充测试"]) {
    const count = f.calls.length;
    assert.equal((await f.send(command)).action, "continue");
    await waitFor(() => f.calls.length === count + 1 && f.registry.resolveSession("S0001").status === "completed");
    assert.equal(f.calls.at(-1).sessionId, "audit-session-1");
    assert.equal(f.calls.at(-1).prompt, "补充测试");
  }
});

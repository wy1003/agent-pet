import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RemoteTaskRegistry } from "../desktop/remote-task-registry.mjs";
import {
  RemoteControlController,
  assessRemotePromptRisk,
} from "../desktop/remote-control-controller.mjs";

function inbound(id, text, referenceText = "", referencedMessageId = "") {
  return {
    channelId: "weixin",
    accountId: "primary",
    messageId: String(id),
    dedupeKey: `weixin:primary:${id}`,
    senderId: "bound-user",
    conversationId: "bound-user",
    conversationType: "private",
    text,
    reference: {
      messageId: referencedMessageId,
      text: referenceText,
    },
  };
}

async function fixture(t, executor = {}, policy = { enabled: true }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-pet-controller-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = new RemoteTaskRegistry(path.join(directory, "registry.json"));
  await registry.load();
  await registry.observeTask({
    taskId: "codex:session-1:turn-1",
    sessionId: "session-1",
    projectKey: directory.replace(/\\/g, "/").toLowerCase(),
    projectName: "Agent Pet",
    cwd: directory,
    title: "原任务",
    status: "completed",
  });
  const replies = [];
  const controller = new RemoteControlController({
    registry,
    executor: {
      resume: executor.resume || (async () => ({ finalResponse: "续问完成" })),
      start: executor.start || (async (value) => {
        await value.onThreadStarted("session-new");
        return { sessionId: "session-new", finalResponse: "新任务完成" };
      }),
    },
    sendReply: async (text) => replies.push(text),
    getPolicy: () => policy,
    isAuthorizedSender: (value) => value === "bound-user",
    pollMs: 10,
    logger: { warn() {} },
  });
  return { controller, registry, replies, directory };
}

async function waitFor(predicate, timeout = 1_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out");
}

test("controller resumes the exact session selected by a legacy C slash command", async (t) => {
  let resumed;
  const { controller, replies } = await fixture(t, {
    resume: async (value) => {
      resumed = value;
      return { finalResponse: "已经改好了" };
    },
  });
  const result = await controller.handleInbound(inbound(
    1,
    "/C0001 继续：把设置页简化",
  ));
  assert.equal(result.queued, true);
  await waitFor(() => replies.some((value) => value.includes("已经改好了")));
  assert.equal(resumed.sessionId, "session-1");
  assert.equal(resumed.prompt, "把设置页简化");
  assert.deepEqual(replies, [
    "Agent Pet · 已提交\n会话：/S0001",
    "Agent Pet · 已完成\n结果摘要：已经改好了\n\n继续处理此任务：\n/S0001 你的要求",
  ]);
});

test("controller creates a new managed session and assigns a short code", async (t) => {
  const { controller, registry, replies } = await fixture(t);
  const result = await controller.handleInbound(inbound(2, "/P001 新任务：检查发布流程"));
  assert.equal(result.queued, true);
  await waitFor(() => replies.some((value) => value.includes("新任务完成")));
  assert.equal(registry.resolveSessionById("session-new").code, "S0002");
  assert.ok(replies.some((value) => value.includes("继续处理此任务：\n/S0002 你的要求")));
});

test("ordinary messages only refresh the connection and never produce replies", async (t) => {
  const { controller, replies } = await fixture(t, {}, { enabled: false });
  const first = await controller.handleInbound(inbound(3, "随便发一句，只用于刷新连接"));
  const repeated = await controller.handleInbound(inbound(3, "随便发一句，只用于刷新连接"));
  assert.deepEqual(first, { ok: true, action: "connection_refresh", ignored: true });
  assert.deepEqual(repeated, first);
  assert.deepEqual(replies, []);
});

test("connection events reply with the short guide once while ordinary refreshes stay silent", async (t) => {
  const { controller, replies } = await fixture(t, {}, { enabled: false });

  for (const [index, connectionEvent] of ["connected", "restored"].entries()) {
    const message = {
      ...inbound(30 + index, "你好"),
      connectionEvent,
    };
    assert.equal((await controller.handleInbound(message)).action, "connection_guide");
    assert.equal((await controller.handleInbound(message)).reason, "duplicate_message");
  }

  assert.equal(replies.length, 2);
  for (const reply of replies) {
    assert.match(reply, /Agent Pet 已连接/);
    assert.match(reply, /\/projects 查看项目/);
    assert.match(reply, /\/sessions 查看会话/);
    assert.match(reply, /\/help 查看全部指令/);
    assert.match(reply, /普通消息不会执行任务/);
  }

  assert.deepEqual(
    await controller.handleInbound(inbound(32, "只是再次刷新连接")),
    { ok: true, action: "connection_refresh", ignored: true },
  );
  assert.equal(replies.length, 2);
});

test("exact help keywords return the full catalog even when command operation is disabled", async (t) => {
  const { controller, replies } = await fixture(t, {}, { enabled: false });
  const keywords = ["帮助", "指令", "怎么用", "help"];

  for (const [index, keyword] of keywords.entries()) {
    assert.equal(
      (await controller.handleInbound(inbound(40 + index, keyword))).action,
      "help",
    );
  }

  assert.equal(replies.length, keywords.length);
  for (const reply of replies) {
    assert.match(reply, /\/projects/);
    assert.match(reply, /\/sessions/);
    assert.match(reply, /\/S0001/);
    assert.match(reply, /\/P001/);
    assert.match(reply, /指令操作.*未开启/s);
  }

  assert.deepEqual(
    await controller.handleInbound(inbound(44, "帮我检查一下")),
    { ok: true, action: "connection_refresh", ignored: true },
  );
  assert.equal(replies.length, keywords.length);
});

test("route-like messages missing the leading slash receive only a format hint", async (t) => {
  const { controller, replies } = await fixture(t, {}, { enabled: false });
  const malformed = [
    "S0001 继续检查",
    "P001 新任务：检查测试",
    "C0001 继续处理",
  ];

  for (const [index, text] of malformed.entries()) {
    assert.equal(
      (await controller.handleInbound(inbound(50 + index, text))).reason,
      "missing_command_slash",
    );
  }

  assert.equal(replies.length, malformed.length);
  for (const reply of replies) {
    assert.match(reply, /缺少.*\//s);
    assert.match(reply, /\/S0001 你的要求/);
    assert.match(reply, /\/help/);
  }
});

test("disabled command operation replies to an explicit command once and deduplicates it", async (t) => {
  const { controller, replies } = await fixture(t, {}, { enabled: false });
  assert.equal((await controller.handleInbound(inbound(4, "/S0001 状态"))).reason, "remote_control_disabled");
  assert.equal((await controller.handleInbound(inbound(4, "/S0001 状态"))).reason, "duplicate_message");
  assert.equal(replies.length, 1);
  assert.ok(replies[0].includes("指令操作未开启"));
});

test("enabled command operation still rejects ambiguous and unknown explicit routes", async (t) => {
  const { controller, replies } = await fixture(t);
  assert.equal((await controller.handleInbound(inbound(5, "/继续一下"))).reason, "route_required");
  assert.equal((await controller.handleInbound(inbound(6, "/P999 新任务：继续"))).reason, "route_not_found");
  assert.ok(replies.some((value) => value.includes("无法确定")));
  assert.ok(replies.some((value) => value.includes("编号不存在")));
});

test("controller rejects a route that conflicts with the quoted message mapping", async (t) => {
  const { controller, registry } = await fixture(t);
  await registry.recordDelivery({
    notificationId: "notification-quoted",
    channelId: "weixin",
    accountId: "primary",
    conversationId: "bound-user",
    remoteMessageId: "outbound-quoted",
    projectCode: "P001",
    sessionCode: "S0001",
  });

  const result = await controller.handleInbound(inbound(
    41,
    "/S0002 继续处理",
    "被截断的任务通知",
    "outbound-quoted",
  ));
  assert.equal(result.reason, "route_conflict");
});

test("controller rejects empty and repeated slash commands without dispatching Codex", async (t) => {
  let dispatches = 0;
  const { controller } = await fixture(t, {
    resume: async () => {
      dispatches += 1;
      return { finalResponse: "不应执行" };
    },
  });

  assert.equal((await controller.handleInbound(inbound(42, "/S0001"))).reason, "prompt_required");
  assert.equal(
    (await controller.handleInbound(inbound(43, "/S0001 /S0002 修改页面"))).reason,
    "multiple_routes",
  );
  assert.equal(dispatches, 0);
});

test("controller lists every recognized project and recent session without leaking local ids", async (t) => {
  const { controller, registry, replies, directory } = await fixture(t);
  await registry.observeTask({
    taskId: "codex:secret-session:turn-1",
    sessionId: "secret-session",
    projectKey: `${directory}/secret`,
    projectName: "第二项目",
    cwd: `${directory}/secret`,
    title: "第二项目任务",
    status: "completed",
  });

  assert.equal((await controller.handleInbound(inbound(
    44,
    "/help",
    "会话指令：/S9999",
    "unrelated-reference",
  ))).action, "help");
  assert.equal((await controller.handleInbound(inbound(45, "/projects"))).action, "projects");
  assert.equal((await controller.handleInbound(inbound(46, "/sessions P001"))).action, "sessions");
  assert.equal((await controller.handleInbound(inbound(47, "/sessions P002"))).action, "sessions");

  assert.ok(replies.some((value) => value.includes("/help · 查看这份帮助")));
  assert.ok(replies.some((value) => value.includes("/P001 · Agent Pet")));
  assert.ok(replies.some((value) => value.includes("/P002 · 第二项目")));
  assert.ok(replies.some((value) => value.includes("/S0001 · 已完成 · Agent Pet · 原任务")));
  assert.ok(replies.some((value) => value.includes("/S0002 · 已完成 · 第二项目 · 第二项目任务")));
  assert.equal(replies.join("\n").includes(directory), false);
  assert.equal(replies.join("\n").includes("session-1"), false);
  assert.equal((await controller.handleInbound(inbound(48, "/sessions P999"))).action, "sessions");
});

test("controller serializes jobs in one session", async (t) => {
  const order = [];
  let releaseFirst;
  const first = new Promise((resolve) => { releaseFirst = resolve; });
  let call = 0;
  const { controller, replies } = await fixture(t, {
    resume: async () => {
      call += 1;
      const current = call;
      order.push(`start-${current}`);
      if (current === 1) await first;
      order.push(`end-${current}`);
      return { finalResponse: `完成${current}` };
    },
  });
  await controller.handleInbound(inbound(5, "/S0001 第一个"));
  await controller.handleInbound(inbound(6, "/S0001 第二个"));
  await waitFor(() => order.includes("start-1"));
  assert.deepEqual(order, ["start-1"]);
  releaseFirst();
  await waitFor(() => replies.some((value) => value.includes("完成2")));
  assert.deepEqual(order, ["start-1", "end-1", "start-2", "end-2"]);
});

test("a timed-out Codex response is reported as written and can be explicitly retried", async (t) => {
  const prompts = [];
  let attempt = 0;
  const { controller, registry, replies } = await fixture(t, {
    resume: async (value) => {
      prompts.push(value.prompt);
      attempt += 1;
      if (attempt === 1) {
        const error = new Error("Reconnecting... 2/5 (request timed out)");
        error.code = "codex_response_timeout";
        error.turnStarted = true;
        throw error;
      }
      return { finalResponse: "已从中断处继续完成" };
    },
  });

  await controller.handleInbound(inbound(60, "/S0001 了解了"));
  await waitFor(() => replies.some((value) => value.includes("Codex 回复超时")));
  assert.equal(registry.resolveSession("S0001").status, "interrupted");
  assert.ok(replies.some((value) => value.includes("消息已经写入 Codex 会话")));
  assert.ok(replies.some((value) => value.includes("重新打开该会话")));
  assert.ok(replies.some((value) => value.includes("/S0001 重试")));

  const retry = await controller.handleInbound(inbound(61, "/S0001 重试"));
  assert.equal(retry.action, "retry");
  assert.equal(retry.queued, true);
  await waitFor(() => replies.some((value) => value.includes("已从中断处继续完成")));
  assert.equal(registry.resolveSession("S0001").status, "completed");
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /最后一条尚未完成的真实用户请求/);
  assert.match(prompts[1], /避免重复产生副作用/);
});

test("retry is rejected for a completed session", async (t) => {
  let dispatches = 0;
  const { controller, replies } = await fixture(t, {
    resume: async () => {
      dispatches += 1;
      return { finalResponse: "不应执行" };
    },
  });
  const result = await controller.handleInbound(inbound(62, "/S0001 重试"));
  assert.equal(result.reason, "retry_not_available");
  assert.equal(dispatches, 0);
  assert.ok(replies.some((value) => value.includes("当前任务无需重试")));
});

test("a continuation waits for a newly-created remote session to finish", async (t) => {
  const order = [];
  let releaseNew;
  const firstTurn = new Promise((resolve) => { releaseNew = resolve; });
  const { controller, registry, replies } = await fixture(t, {
    start: async ({ onThreadStarted }) => {
      order.push("new-start");
      await onThreadStarted("session-created-remotely");
      order.push("new-registered");
      await firstTurn;
      order.push("new-end");
      return { sessionId: "session-created-remotely", finalResponse: "新会话完成" };
    },
    resume: async () => {
      order.push("continue-start");
      return { finalResponse: "续问完成" };
    },
  });

  await controller.handleInbound(inbound(50, "/P001 新任务：先完成第一步"));
  await waitFor(() => registry.resolveSessionById("session-created-remotely"));
  assert.equal(registry.resolveSessionById("session-created-remotely").status, "running");
  await controller.handleInbound(inbound(51, "/S0002 继续：再完成第二步"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(order, ["new-start", "new-registered"]);

  releaseNew();
  await waitFor(() => replies.some((value) => value.includes("续问完成")));
  assert.deepEqual(order, ["new-start", "new-registered", "new-end", "continue-start"]);
  assert.equal(registry.resolveSession("S0002").status, "completed");
});

test("status queries neither create lanes nor expose local paths or raw session IDs", async (t) => {
  const { controller, replies, directory } = await fixture(t);
  const localStatus = JSON.stringify(controller.status());
  assert.equal(localStatus.includes(directory), false);
  assert.equal(localStatus.includes("session-1"), false);
  assert.equal(controller.lanes.size, 0);

  const result = await controller.handleInbound(inbound(52, "/S0001 状态"));
  assert.equal(result.ok, true);
  assert.equal(controller.lanes.size, 0);
  const reply = replies.at(-1);
  assert.equal(reply.includes(directory), false);
  assert.equal(reply.includes("session-1"), false);
  assert.match(reply, /会话：\/S0001/);
});

test("stopping a session aborts its active remote turn and clears queued turns", async (t) => {
  let calls = 0;
  let aborted = false;
  const { controller, registry } = await fixture(t, {
    resume: ({ signal }) => {
      calls += 1;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(signal.reason);
        }, { once: true });
      });
    },
  });
  await controller.handleInbound(inbound(53, "/S0001 第一项"));
  await waitFor(() => controller.status().active.length === 1);
  await controller.handleInbound(inbound(54, "/S0001 第二项"));
  const stopped = await controller.handleInbound(inbound(55, "/S0001 停止"));
  assert.equal(stopped.ok, true);
  assert.equal(stopped.queuedCancelled, 1);
  await waitFor(() => aborted && controller.status().active.length === 0);
  assert.equal(calls, 1);
  assert.equal(registry.resolveSession("S0001").status, "interrupted");
});

test("controller stop waits for an in-flight drain to finish abort cleanup", async (t) => {
  let abortObserved = false;
  let cleanupFinished = false;
  let releaseCleanup;
  const cleanupGate = new Promise((resolve) => { releaseCleanup = resolve; });
  const { controller, registry } = await fixture(t, {
    resume: ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", async () => {
        abortObserved = true;
        await cleanupGate;
        cleanupFinished = true;
        reject(signal.reason);
      }, { once: true });
    }),
  });
  await controller.handleInbound(inbound(57, "/S0001 继续运行"));
  await waitFor(() => controller.status().active.length === 1);

  let stopSettled = false;
  const stopping = controller.stop().then(() => { stopSettled = true; });
  await waitFor(() => abortObserved);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(stopSettled, false);
  assert.equal(cleanupFinished, false);

  releaseCleanup();
  await stopping;
  assert.equal(cleanupFinished, true);
  assert.equal(stopSettled, true);
  assert.equal(controller.status().active.length, 0);
  assert.equal(registry.resolveSession("S0001").status, "interrupted");
});

test("controller aborts an Agent Pet remote run but does not claim it can stop a desktop run", async (t) => {
  let aborted = false;
  const { controller, registry, replies } = await fixture(t, {
    resume: ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(signal.reason);
      }, { once: true });
    }),
  });
  await controller.handleInbound(inbound(7, "/S0001 继续运行"));
  await waitFor(() => controller.status().active.length === 1);
  assert.equal((await controller.handleInbound(inbound(8, "/S0001 停止"))).ok, true);
  await waitFor(() => aborted && controller.status().active.length === 0);

  await registry.observeTask({
    taskId: "codex:session-1:turn-desktop",
    sessionId: "session-1",
    projectKey: registry.resolveProject("P001").projectKey,
    projectName: "Agent Pet",
    cwd: registry.resolveProject("P001").cwd,
    title: "桌面任务",
    status: "running",
  });
  assert.equal((await controller.handleInbound(inbound(9, "/S0001 停止"))).reason, "desktop_stop_required");
  assert.ok(replies.some((value) => value.includes("电脑端")));
});

test("high-risk remote prompts require desktop approval before executor dispatch", () => {
  assert.equal(assessRemotePromptRisk("git push origin main").risky, true);
  assert.equal(assessRemotePromptRisk("删除整个数据库").risky, true);
  assert.equal(assessRemotePromptRisk("修改设置页的 CSS").risky, false);
});

test("high-risk prompts are rejected before the executor is dispatched", async (t) => {
  let dispatches = 0;
  const { controller } = await fixture(t, {
    resume: async () => {
      dispatches += 1;
      return { finalResponse: "不应执行" };
    },
  });
  const result = await controller.handleInbound(inbound(
    56,
    "/S0001 继续：git push origin main",
  ));
  assert.equal(result.reason, "desktop_approval_required");
  assert.equal(dispatches, 0);
});

test("high-risk new project tasks also require desktop approval", async (t) => {
  let dispatches = 0;
  const { controller } = await fixture(t, {
    start: async () => {
      dispatches += 1;
      return { sessionId: "should-not-start", finalResponse: "不应执行" };
    },
  });
  const result = await controller.handleInbound(inbound(
    57,
    "/P001 新任务：git push origin main",
  ));
  assert.equal(result.reason, "desktop_approval_required");
  assert.equal(dispatches, 0);
});

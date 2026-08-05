import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  normalizeProjectCode,
  normalizeSessionCode,
  RemoteTaskRegistry,
} from "../desktop/remote-task-registry.mjs";

test("remote route normalizers reject zero instead of aliasing the first route", () => {
  assert.equal(normalizeProjectCode("P0"), "");
  assert.equal(normalizeSessionCode("S0"), "");
  assert.equal(normalizeSessionCode("C0000"), "");
  assert.equal(normalizeSessionCode("C12"), "S0012");
});

test("remote task registry keeps stable project codes and globally unique session codes", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-pet-routes-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "registry.json");
  const now = new Date("2026-08-04T10:00:00.000Z");
  const registry = new RemoteTaskRegistry(filePath, { now: () => now });
  await registry.load();
  const first = await registry.observeTask({
    taskId: "codex:session-a:turn-1",
    sessionId: "session-a",
    projectKey: "d:/project/agent-pet",
    projectName: "Agent Pet",
    cwd: "D:/project/agent-pet",
    title: "Connect a remote channel",
    status: "completed",
  });
  assert.equal(first.projectCode, "P001");
  assert.equal(first.sessionCode, "S0001");

  await registry.observeTask({
    taskId: "codex:session-a:turn-2",
    sessionId: "session-a",
    projectKey: "d:/project/agent-pet",
    projectName: "Agent Pet",
    cwd: "D:/project/agent-pet",
    title: "Continue improving",
    status: "running",
  });
  assert.equal(registry.resolveSessionById("session-a").code, "S0001");
  assert.equal(registry.resolveSession("S1").taskId, "codex:session-a:turn-2");
  assert.equal(registry.resolveSession("C1").code, "S0001");

  const secondProject = await registry.observeTask({
    taskId: "codex:session-b:turn-1",
    sessionId: "session-b",
    projectKey: "d:/project/another-agent",
    projectName: "Another Agent",
    cwd: "D:/project/another-agent",
    title: "Use a globally unique session code",
    status: "running",
  });
  assert.equal(secondProject.projectCode, "P002");
  assert.equal(secondProject.sessionCode, "S0002");
  assert.equal(new Set(registry.listSessions().map((item) => item.code)).size, 2);

  const restarted = new RemoteTaskRegistry(filePath);
  await restarted.load();
  assert.equal(restarted.resolveProject("P1").code, "P001");
  assert.equal(restarted.resolveSession("S1").code, "S0001");
  assert.equal(restarted.resolveSession("S2").projectCode, "P002");
});

test("remote task registry preserves projectless conversation classification", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-pet-routes-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = new RemoteTaskRegistry(path.join(directory, "registry.json"));
  await registry.load();

  const route = await registry.observeTask({
    taskId: "codex:projectless:turn-1",
    sessionId: "projectless",
    projectKey: "c:/users/tester/documents/codex/2026-08-04/1-1",
    projectName: "普通对话",
    projectKind: "projectless",
    cwd: "C:/Users/tester/Documents/Codex/2026-08-04/1-1",
    title: "查询订阅价格",
    status: "completed",
  });

  assert.equal(route.projectKind, "projectless");
  assert.equal(registry.resolveProject(route.projectCode).kind, "projectless");
  assert.equal(registry.resolveSession(route.sessionCode).projectKind, "projectless");
  assert.equal(registry.listProjects().length, 0);
  assert.equal(registry.listSessions().length, 1);
});

test("remote task registry uses channel-scoped delivery mappings", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-pet-routes-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = new RemoteTaskRegistry(path.join(directory, "registry.json"));
  await registry.load();
  await registry.observeTask({
    taskId: "task-1",
    sessionId: "session-a",
    projectKey: "d:/project/agent-pet",
    projectName: "Agent Pet",
    cwd: "D:/project/agent-pet",
    title: "Remote routing",
    status: "completed",
  });
  await registry.recordDelivery({
    notificationId: "notification-1",
    channelId: "weixin",
    accountId: "wx-account",
    conversationId: "wx-conversation",
    remoteMessageId: "shared-message",
    taskId: "task-1",
    projectCode: "P1",
    sessionCode: "S1",
  });
  await registry.recordDelivery({
    notificationId: "notification-2",
    channelId: "qq",
    accountId: "qq-account",
    conversationId: "qq-conversation",
    remoteMessageId: "shared-message",
    taskId: "task-2",
    projectCode: "P1",
    sessionCode: "S1",
  });
  await registry.recordDelivery({
    notificationId: "notification-3",
    channelId: "weixin",
    accountId: "other-wx-account",
    conversationId: "other-wx-conversation",
    remoteMessageId: "shared-message",
    taskId: "task-3",
    projectCode: "P1",
    sessionCode: "S1",
  });
  await registry.recordDelivery({
    notificationId: "notification-4",
    channelId: "feishu",
    accountId: "wx-account",
    conversationId: "wx-conversation",
    remoteMessageId: "shared-message",
    taskId: "task-4",
    projectCode: "P1",
    sessionCode: "S1",
  });

  assert.equal(registry.findDelivery({ remoteMessageId: "shared-message" }), null);
  assert.equal(registry.findDelivery({
    accountId: "wx-account",
    conversationId: "wx-conversation",
    remoteMessageId: "shared-message",
  }), null);
  assert.equal(registry.findDelivery({
    channelId: "weixin",
    remoteMessageId: "shared-message",
  }), null);
  assert.equal(registry.findDelivery({
    channelId: "weixin",
    accountId: "wx-account",
    conversationId: "wx-conversation",
    remoteMessageId: "shared-message",
  }).notificationId, "notification-1");
  assert.equal(registry.findDelivery({
    channelId: "qq",
    accountId: "qq-account",
    conversationId: "qq-conversation",
    remoteMessageId: "shared-message",
  }).notificationId, "notification-2");

  const route = registry.findDeliveryRoute({
    channelId: "weixin",
    accountId: "wx-account",
    conversationId: "wx-conversation",
    messageId: "shared-message",
  });
  assert.equal(route.project.code, "P001");
  assert.equal(route.session.sessionId, "session-a");
});

test("remote task registry hashes and deduplicates inbound message keys", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-pet-routes-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = new RemoteTaskRegistry(path.join(directory, "registry.json"));
  await registry.load();
  assert.equal(await registry.claimInboundMessage("weixin:10", { fromUserId: "user" }), true);
  assert.equal(await registry.claimInboundMessage("weixin:10", { fromUserId: "user" }), false);
  assert.match(registry.snapshot().processedMessages[0].key, /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(registry.snapshot()).includes("weixin:10"), false);
});

test("remote task registry migrates version 1 delivery and processed-message records", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-pet-routes-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "registry.json");
  await writeFile(filePath, JSON.stringify({
    version: 1,
    nextProjectNumber: 2,
    nextSessionNumber: 2,
    projects: [{
      code: "P001",
      projectKey: "d:/project/agent-pet",
      name: "Agent Pet",
      cwd: "D:/project/agent-pet",
    }],
    sessions: [{
      code: "C0001",
      sessionId: "legacy-session",
      projectCode: "P001",
      projectKey: "d:/project/agent-pet",
      projectName: "Agent Pet",
      cwd: "D:/project/agent-pet",
    }],
    deliveries: [{
      notificationId: "legacy-notification",
      remoteMessageId: "legacy-message",
      projectCode: "P001",
      sessionCode: "C0001",
    }],
    processedMessages: [{ key: "legacy-inbound-body", receivedAt: "2026-08-04T00:00:00.000Z" }],
  }));

  const registry = new RemoteTaskRegistry(filePath);
  await registry.load();
  const route = registry.findDeliveryRoute({
    channelId: "weixin",
    accountId: "current-account",
    conversationId: "current-conversation",
    referencedMessageId: "legacy-message",
  });
  assert.equal(route.channelId, "weixin");
  assert.equal(route.accountId, "");
  assert.equal(route.conversationId, "");
  assert.equal(route.session.sessionId, "legacy-session");
  assert.equal(route.session.code, "S0001");
  assert.equal(registry.findDelivery({
    channelId: "qq",
    accountId: "current-account",
    conversationId: "current-conversation",
    remoteMessageId: "legacy-message",
  }), null);
  assert.equal(await registry.claimInboundMessage("legacy-inbound-body"), false);

  const migrated = JSON.parse(await readFile(filePath, "utf8"));
  assert.equal(migrated.version, 3);
  assert.equal(migrated.deliveries[0].channelId, "weixin");
  assert.equal(migrated.deliveries[0].sessionCode, "S0001");
  assert.equal(migrated.sessions[0].code, "S0001");
  assert.equal(JSON.stringify(migrated).includes("legacy-inbound-body"), false);
  assert.match(migrated.processedMessages[0].key, /^sha256:[a-f0-9]{64}$/);
});

test("remote task registry migrates version 2 C codes to globally unique S codes", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-pet-routes-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "registry.json");
  await writeFile(filePath, JSON.stringify({
    version: 2,
    nextProjectNumber: 3,
    nextSessionNumber: 3,
    projects: [
      {
        code: "P001",
        projectKey: "d:/project/one",
        name: "Project One",
        cwd: "D:/project/one",
      },
      {
        code: "P002",
        projectKey: "d:/project/two",
        name: "Project Two",
        cwd: "D:/project/two",
      },
    ],
    sessions: [
      {
        code: "C0001",
        sessionId: "project-one-session",
        projectCode: "P001",
        projectKey: "d:/project/one",
      },
      {
        code: "C0001",
        sessionId: "project-two-legacy-duplicate",
        projectCode: "P002",
        projectKey: "d:/project/two",
      },
      {
        code: "C0002",
        sessionId: "project-two-session",
        projectCode: "P002",
        projectKey: "d:/project/two",
      },
    ],
    deliveries: [
      {
        notificationId: "project-one-notification",
        channelId: "weixin",
        remoteMessageId: "project-one-message",
        projectCode: "P001",
        sessionCode: "C0001",
      },
      {
        notificationId: "project-two-notification",
        channelId: "weixin",
        remoteMessageId: "project-two-message",
        projectCode: "P002",
        sessionCode: "C0001",
      },
    ],
  }));

  const registry = new RemoteTaskRegistry(filePath);
  await registry.load();
  assert.equal(registry.resolveSessionById("project-one-session").code, "S0001");
  assert.equal(registry.resolveSessionById("project-two-session").code, "S0002");
  assert.equal(registry.resolveSessionById("project-two-legacy-duplicate").code, "S0003");
  const codes = registry.listSessions().map((item) => item.code);
  assert.equal(new Set(codes).size, codes.length);

  assert.equal(registry.findDeliveryRoute({
    channelId: "weixin",
    referencedMessageId: "project-one-message",
  }).session.sessionId, "project-one-session");
  assert.equal(registry.findDeliveryRoute({
    channelId: "weixin",
    referencedMessageId: "project-two-message",
  }).session.sessionId, "project-two-legacy-duplicate");

  const migrated = JSON.parse(await readFile(filePath, "utf8"));
  assert.equal(migrated.version, 3);
  assert.deepEqual(
    migrated.sessions.map((item) => item.code).sort(),
    ["S0001", "S0002", "S0003"],
  );
  assert.deepEqual(
    migrated.deliveries.map((item) => item.sessionCode),
    ["S0001", "S0003"],
  );
});

test("remote task registry persists repairs for duplicate version 3 session codes", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-pet-routes-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "registry.json");
  await writeFile(filePath, JSON.stringify({
    version: 3,
    nextProjectNumber: 3,
    nextSessionNumber: 2,
    projects: [
      { code: "P001", projectKey: "project:one", name: "One" },
      { code: "P002", projectKey: "project:two", name: "Two" },
    ],
    sessions: [
      { code: "S0001", sessionId: "session-one", projectCode: "P001" },
      { code: "S0001", sessionId: "session-two", projectCode: "P002" },
    ],
    deliveries: [],
    processedMessages: [],
  }));

  const registry = new RemoteTaskRegistry(filePath);
  await registry.load();
  assert.equal(registry.resolveSessionById("session-one").code, "S0001");
  assert.equal(registry.resolveSessionById("session-two").code, "S0002");

  const persisted = JSON.parse(await readFile(filePath, "utf8"));
  assert.deepEqual(persisted.sessions.map((item) => item.code), ["S0001", "S0002"]);
  assert.equal(persisted.nextSessionNumber, 3);

  const restarted = new RemoteTaskRegistry(filePath);
  await restarted.load();
  assert.equal(restarted.resolveSessionById("session-two").code, "S0002");
});

test("remote task registry does not guess ambiguous same-project legacy deliveries", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-pet-routes-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "registry.json");
  await writeFile(filePath, JSON.stringify({
    version: 2,
    nextProjectNumber: 2,
    nextSessionNumber: 2,
    projects: [{ code: "P001", projectKey: "project:one", name: "One" }],
    sessions: [
      { code: "C0001", sessionId: "session-one", projectCode: "P001" },
      { code: "C0001", sessionId: "session-two", projectCode: "P001" },
    ],
    deliveries: [{
      notificationId: "ambiguous-notification",
      channelId: "weixin",
      remoteMessageId: "ambiguous-message",
      projectCode: "P001",
      sessionCode: "C0001",
    }],
    processedMessages: [],
  }));

  const registry = new RemoteTaskRegistry(filePath);
  await registry.load();
  const delivery = registry.findDelivery({
    channelId: "weixin",
    remoteMessageId: "ambiguous-message",
  });
  assert.equal(delivery.sessionCode, "");
  assert.equal(registry.findDeliveryRoute({
    channelId: "weixin",
    remoteMessageId: "ambiguous-message",
  }).session, null);
});

test("remote task registry rejects ambiguous legacy delivery fallbacks", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-pet-routes-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "registry.json");
  await writeFile(filePath, JSON.stringify({
    version: 1,
    deliveries: [
      { notificationId: "legacy-1", remoteMessageId: "reused-message" },
      { notificationId: "legacy-2", remoteMessageId: "reused-message" },
    ],
  }));
  const registry = new RemoteTaskRegistry(filePath);
  await registry.load();
  assert.equal(registry.findDelivery({
    channelId: "weixin",
    accountId: "account",
    conversationId: "conversation",
    remoteMessageId: "reused-message",
  }), null);
});

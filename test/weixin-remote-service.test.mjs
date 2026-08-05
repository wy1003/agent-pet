import test from "node:test";
import assert from "node:assert/strict";
import {
  WeixinIlinkError,
} from "../desktop/weixin-ilink-client.mjs";
import { WeixinRemoteService } from "../desktop/weixin-remote-service.mjs";

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}

function waitUntilAbort(signal) {
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => {
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

test("remote service renders Tencent QR content as a local data image", async () => {
  const service = new WeixinRemoteService({
    client: {
      getBotQrCode: async () => ({
        qrcode: "qr-secret",
        qrcode_img_content: "https://weixin.qq.com/x/agent-pet-test",
      }),
      getQrCodeStatus: ({ signal }) => waitUntilAbort(signal),
    },
    logger: { warn() {} },
  });
  const status = await service.beginConnection();
  assert.match(status.qrCodeUrl, /^data:image\/png;base64,/);
  assert.equal(status.qrCodeUrl.includes("weixin.qq.com"), false);
  await service.stop();
});

test("remote service saves QR credentials, binds the first inbound context and sends text", async () => {
  const saved = [];
  const statusEvents = [];
  const sendCalls = [];
  let updateCalls = 0;
  const client = {
    getBotQrCode: async () => ({
      qrcode: "qr-secret",
      qrcode_img_content: "https://qr.example/one",
    }),
    getQrCodeStatus: async () => ({
      status: "confirmed",
      bot_token: "bot-token",
      ilink_bot_id: "bot-account",
      baseurl: "https://edge.weixin.example",
      ilink_user_id: "scanner-user",
    }),
    getUpdates: async ({ signal }) => {
      updateCalls += 1;
      if (updateCalls === 1) {
        return {
          ret: 0,
          get_updates_buf: "cursor-1",
          msgs: [{
            message_type: 1,
            from_user_id: "scanner-user",
            context_token: "context-1",
          }],
        };
      }
      return waitUntilAbort(signal);
    },
    sendText: async (value) => {
      sendCalls.push(value);
      return { ok: true, clientId: value.clientId };
    },
  };
  const service = new WeixinRemoteService({
    client,
    loadCredentials: async () => null,
    saveCredentials: async (value) => saved.push(value),
    onStatus: (value) => statusEvents.push(value),
    logger: { warn() {} },
    qrPollDelayMs: 10,
    encodeQrCode: async (content) => `data:image/png;base64,${Buffer.from(content).toString("base64")}`,
  });

  const connecting = await service.beginConnection();
  assert.equal(connecting.state, "waiting_scan");
  assert.match(connecting.qrCodeUrl, /^data:image\/png;base64,/);
  await waitFor(() => service.status().state === "connected");
  assert.equal(service.status().bound, true);
  assert.equal(service.status().sendAvailable, true);
  assert.equal(service.status().deliveryState, "ready");
  assert.equal(service.status().accountLabel, "已连接的微信");
  assert.equal("botToken" in service.status(), false);
  assert.equal("userId" in service.status(), false);
  assert.ok(saved.some((value) => value.botToken === "bot-token"));
  assert.ok(saved.some((value) => value.contextToken === "context-1"));
  assert.ok(saved.some((value) => value.contextUpdatedAt));
  assert.ok(statusEvents.some((value) => value.state === "waiting_bind"));

  assert.deepEqual(await service.sendText("任务完成", {
    clientId: "provider-message-1",
  }), { ok: true, clientId: "provider-message-1" });
  assert.ok(service.status().lastSendSuccessAt);
  assert.deepEqual(sendCalls[0], {
    botToken: "bot-token",
    baseUrl: "https://edge.weixin.example",
    toUserId: "scanner-user",
    contextToken: "context-1",
    text: "任务完成",
    clientId: "provider-message-1",
    signal: undefined,
  });
  await service.stop();
});

test("remote service marks the first bound text after process startup as restored", async () => {
  const saved = [];
  const inboundMessages = [];
  let updateCalls = 0;
  const quotedMessage = {
    message_type: 1,
    message_id: "inbound-1",
    from_user_id: "bound-user",
    context_token: "context-new",
    item_list: [{
      type: 1,
      text_item: { text: "继续优化" },
      ref_msg: {
        message_item: {
          msg_id: "outbound-1",
          text_item: { text: "任务完成\n编号：P001/C0001" },
        },
      },
    }],
  };
  const service = new WeixinRemoteService({
    client: {
      getUpdates: ({ signal }) => {
        updateCalls += 1;
        if (updateCalls === 1) {
          return Promise.resolve({
            ret: 0,
            get_updates_buf: "cursor-new",
            msgs: [quotedMessage],
          });
        }
        return waitUntilAbort(signal);
      },
    },
    loadCredentials: async () => ({
      botToken: "token",
      accountId: "account",
      baseUrl: "https://edge.weixin.example",
      userId: "bound-user",
      contextToken: "context-old",
      getUpdatesBuf: "cursor-old",
    }),
    saveCredentials: async (value) => saved.push(value),
    onInbound: async (message, metadata) => inboundMessages.push({ message, metadata }),
    logger: { warn() {} },
  });

  await service.start();
  await waitFor(() => inboundMessages.length === 1);
  await waitFor(() => saved.some((value) => value.getUpdatesBuf === "cursor-new"));
  assert.equal(service.isBoundUser("bound-user"), true);
  assert.equal(service.isBoundUser("other-user"), false);
  assert.equal(inboundMessages[0].message, quotedMessage);
  assert.deepEqual(inboundMessages[0].metadata, { connectionEvent: "restored" });
  assert.equal("agent_pet_connection_event" in quotedMessage, false);
  const contextSaveIndex = saved.findIndex((value) => (
    value.contextToken === "context-new" && value.getUpdatesBuf === "cursor-old"
  ));
  const cursorSaveIndex = saved.findIndex((value) => value.getUpdatesBuf === "cursor-new");
  assert.ok(contextSaveIndex >= 0);
  assert.ok(cursorSaveIndex > contextSaveIndex);
  await service.stop();
});

test("remote service dispatches the first binding text as connected and filters other users and groups", async () => {
  const saved = [];
  const inboundMessages = [];
  let updateCalls = 0;
  const service = new WeixinRemoteService({
    client: {
      getUpdates: ({ signal }) => {
        updateCalls += 1;
        if (updateCalls === 1) {
          return Promise.resolve({
            ret: 0,
            get_updates_buf: "cursor-1",
            msgs: [{
              message_type: 1,
              message_id: "binding-message",
              from_user_id: "scanner-user",
              context_token: "context-1",
              item_list: [{ type: 1, text_item: { text: "绑定" } }],
            }, {
              message_type: 1,
              message_id: "other-message",
              from_user_id: "other-user",
              context_token: "other-context",
              item_list: [{ type: 1, text_item: { text: "不应处理" } }],
            }, {
              message_type: 1,
              message_id: "group-message",
              from_user_id: "scanner-user",
              group_id: "group-1",
              context_token: "group-context",
              item_list: [{ type: 1, text_item: { text: "群消息" } }],
            }],
          });
        }
        return waitUntilAbort(signal);
      },
    },
    loadCredentials: async () => ({
      botToken: "token",
      accountId: "account",
      baseUrl: "https://edge.weixin.example",
      scannerUserId: "scanner-user",
    }),
    saveCredentials: async (value) => saved.push(value),
    onInbound: async (message, metadata) => inboundMessages.push({ message, metadata }),
    logger: { warn() {} },
  });

  await service.start();
  await waitFor(() => saved.some((value) => value.getUpdatesBuf === "cursor-1"));
  assert.equal(service.isBoundUser("scanner-user"), true);
  assert.equal(inboundMessages.length, 1);
  assert.equal(inboundMessages[0].message.message_id, "binding-message");
  assert.deepEqual(inboundMessages[0].metadata, { connectionEvent: "connected" });
  assert.equal(saved.some((value) => value.contextToken === "other-context"), false);
  assert.equal(saved.some((value) => value.contextToken === "group-context"), false);
  await service.stop();
});

test("remote service retries an inbound batch without advancing its cursor when dispatch fails", async () => {
  const saved = [];
  const requestedCursors = [];
  let inboundCalls = 0;
  const service = new WeixinRemoteService({
    client: {
      getUpdates: async (options) => {
        requestedCursors.push(options.getUpdatesBuf);
        return {
          ret: 0,
          get_updates_buf: "cursor-new",
          msgs: [{
            message_type: 1,
            message_id: "retry-message",
            from_user_id: "bound-user",
            context_token: "context-new",
            item_list: [{ type: 1, text_item: { text: "只交给上层处理" } }],
          }],
        };
      },
    },
    loadCredentials: async () => ({
      botToken: "token",
      accountId: "account",
      baseUrl: "https://edge.weixin.example",
      userId: "bound-user",
      contextToken: "context-old",
      getUpdatesBuf: "cursor-old",
    }),
    saveCredentials: async (value) => saved.push(value),
    onInbound: async () => {
      inboundCalls += 1;
      throw new Error("controller unavailable");
    },
    logger: { warn() {} },
    retryMs: 10,
    retryMaxMs: 10,
  });

  await service.start();
  await waitFor(() => inboundCalls >= 2);
  assert.ok(requestedCursors.length >= 2);
  assert.ok(requestedCursors.every((value) => value === "cursor-old"));
  assert.ok(saved.some((value) => (
    value.contextToken === "context-new" && value.getUpdatesBuf === "cursor-old"
  )));
  assert.equal(saved.some((value) => value.getUpdatesBuf === "cursor-new"), false);
  assert.equal(JSON.stringify(saved).includes("只交给上层处理"), false);
  await service.stop();
});

test("remote service exposes send degradation and clears it after a fresh inbound context", async () => {
  let releaseInbound;
  const inboundGate = new Promise((resolve) => { releaseInbound = resolve; });
  let updateCalls = 0;
  const saved = [];
  const inboundMessages = [];
  const client = {
    notifyStart: async () => ({ ok: true }),
    notifyStop: async () => ({ ok: true }),
    getUpdates: async ({ signal }) => {
      updateCalls += 1;
      if (updateCalls === 1) {
        await inboundGate;
        return {
          ret: 0,
          get_updates_buf: "cursor-2",
          msgs: [{
            message_type: 1,
            message_id: "context-restored-message",
            from_user_id: "user",
            context_token: "context-2",
            item_list: [{ type: 1, text_item: { text: "恢复连接" } }],
          }],
        };
      }
      return waitUntilAbort(signal);
    },
    sendText: async () => {
      throw new WeixinIlinkError("bad context", {
        code: -2,
        ret: -2,
        errcode: -2,
        errmsg: "bad context",
        endpoint: "ilink/bot/sendmessage",
      });
    },
  };
  const service = new WeixinRemoteService({
    client,
    loadCredentials: async () => ({
      botToken: "token",
      accountId: "account",
      baseUrl: "https://edge.weixin.example",
      scannerUserId: "user",
      userId: "user",
      contextToken: "context-1",
    }),
    saveCredentials: async (value) => saved.push(value),
    onInbound: async (message, metadata) => inboundMessages.push({ message, metadata }),
    logger: { warn() {} },
  });

  await service.start();
  await waitFor(() => service.status().state === "connected");
  await assert.rejects(
    () => service.sendText("任务完成"),
    (error) => error?.code === "reply_context_invalid" && error?.transient === false,
  );
  assert.equal(service.status().deliveryState, "reply_context_invalid");
  assert.equal(service.status().sendAvailable, false);
  assert.equal(service.status().replyContextInvalid, true);
  assert.match(service.status().lastSendError, /长时间未与 Agent Pet 对话/);
  assert.match(service.status().lastSendError, /无需重新扫码/);

  releaseInbound();
  await waitFor(() => service.status().deliveryState === "ready");
  await waitFor(() => inboundMessages.length === 1);
  assert.equal(service.status().sendAvailable, true);
  assert.equal(service.status().lastSendError, "");
  assert.ok(saved.some((value) => value.contextToken === "context-2" && value.contextUpdatedAt));
  assert.equal(inboundMessages[0].message.message_id, "context-restored-message");
  assert.deepEqual(inboundMessages[0].metadata, { connectionEvent: "restored" });
  assert.equal("agent_pet_connection_event" in inboundMessages[0].message, false);
  await service.stop();
});

test("remote service lets Tencent decide context validity instead of assuming a fixed timeout", async () => {
  const now = Date.parse("2026-08-04T10:00:00.000Z");
  let sendCalls = 0;
  const service = new WeixinRemoteService({
    client: {
      notifyStart: async () => ({ ok: true }),
      notifyStop: async () => ({ ok: true }),
      getUpdates: ({ signal }) => waitUntilAbort(signal),
      sendText: async () => {
        sendCalls += 1;
        return { ok: true };
      },
    },
    loadCredentials: async () => ({
      botToken: "token",
      accountId: "account",
      baseUrl: "https://edge.weixin.example",
      userId: "user",
      contextToken: "context",
      contextUpdatedAt: "2026-08-03T09:59:59.000Z",
    }),
    now: () => now,
    logger: { warn() {} },
  });

  await service.start();
  await waitFor(() => service.status().state === "connected");
  assert.equal(service.status().deliveryState, "ready");
  assert.equal(service.status().replyContextInvalid, false);
  assert.deepEqual(await service.sendText("任务完成"), { ok: true });
  assert.equal(sendCalls, 1);
  await service.stop();
});

test("remote service restores credentials and waits for a binding message", async () => {
  const client = {
    getUpdates: ({ signal }) => waitUntilAbort(signal),
  };
  const service = new WeixinRemoteService({
    client,
    loadCredentials: async () => ({
      botToken: "token",
      accountId: "account",
      baseUrl: "edge.weixin.example",
    }),
    logger: { warn() {} },
  });

  const state = await service.start();
  assert.equal(state.state, "waiting_bind");
  assert.equal(state.connected, false);
  assert.equal(state.bound, false);
  await service.stop();
});

test("remote service accepts QR verification codes without exposing login secrets", async () => {
  const statusCalls = [];
  let resolveConfirmed;
  const confirmed = new Promise((resolve) => { resolveConfirmed = resolve; });
  const client = {
    getBotQrCode: async () => ({ qrcode: "qr", qrcode_img_content: "https://qr" }),
    getQrCodeStatus: async (options) => {
      statusCalls.push(options);
      if (statusCalls.length === 1) return { status: "need_verifycode" };
      resolveConfirmed();
      return {
        status: "confirmed",
        bot_token: "token",
        ilink_bot_id: "account",
        baseurl: "https://edge.weixin.example",
      };
    },
    getUpdates: ({ signal }) => waitUntilAbort(signal),
  };
  const service = new WeixinRemoteService({
    client,
    saveCredentials: async () => {},
    logger: { warn() {} },
    qrPollDelayMs: 10,
    encodeQrCode: async (content) => `data:image/png;base64,${Buffer.from(content).toString("base64")}`,
  });
  await service.beginConnection();
  await waitFor(() => service.status().state === "verification_required");
  await service.submitVerifyCode("2468");
  await confirmed;
  assert.equal(statusCalls[1].verifyCode, "2468");
  await waitFor(() => service.status().state === "waiting_bind");
  await service.stop();
});

test("remote service clears expired credentials after iLink error -14", async () => {
  let clearCount = 0;
  const client = {
    getUpdates: async () => {
      throw new WeixinIlinkError("expired", { code: -14, sessionExpired: true });
    },
  };
  const service = new WeixinRemoteService({
    client,
    loadCredentials: async () => ({
      botToken: "token",
      accountId: "account",
      baseUrl: "https://edge.weixin.example",
      userId: "user",
      contextToken: "context",
    }),
    clearCredentials: async () => { clearCount += 1; },
    logger: { warn() {} },
  });

  await service.start();
  await waitFor(() => service.status().state === "error");
  assert.equal(clearCount, 1);
  assert.equal(service.status().connected, false);
  assert.equal(service.status().bound, false);
  assert.match(service.status().lastError, /重新扫码/);
  await service.stop();
});

test("remote service exposes reconnecting state and recovers the long-poll lifecycle", async () => {
  const statuses = [];
  let updateCalls = 0;
  let notifyStartCalls = 0;
  let releaseReconnect;
  const reconnectGate = new Promise((resolve) => { releaseReconnect = resolve; });
  const client = {
    notifyStart: async () => {
      notifyStartCalls += 1;
      if (notifyStartCalls === 2) await reconnectGate;
      return { ok: true };
    },
    notifyStop: async () => ({ ok: true }),
    getUpdates: async ({ signal }) => {
      updateCalls += 1;
      if (updateCalls === 1) throw new Error("temporary network failure");
      return waitUntilAbort(signal);
    },
    sendText: async () => ({ ok: true }),
  };
  const service = new WeixinRemoteService({
    client,
    loadCredentials: async () => ({
      botToken: "token",
      accountId: "account",
      baseUrl: "https://edge.weixin.example",
      userId: "user",
      contextToken: "context",
    }),
    onStatus: (status) => statuses.push(status),
    logger: { warn() {} },
    retryMs: 10,
    retryMaxMs: 20,
  });

  await service.start();
  await waitFor(() => service.status().state === "reconnecting");
  await assert.rejects(
    () => service.sendText("queued message"),
    (error) => error?.code === "remote_reconnecting" && error?.transient === true,
  );
  releaseReconnect();
  await waitFor(() => service.status().state === "connected");
  assert.ok(statuses.some((status) => status.state === "connected"));
  assert.ok(statuses.some((status) => status.state === "reconnecting"));
  assert.equal(notifyStartCalls, 2);
  await service.stop();
});

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
      return { ok: true };
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
  assert.equal(service.status().accountLabel, "已连接的微信");
  assert.equal("botToken" in service.status(), false);
  assert.equal("userId" in service.status(), false);
  assert.ok(saved.some((value) => value.botToken === "bot-token"));
  assert.ok(saved.some((value) => value.contextToken === "context-1"));
  assert.ok(statusEvents.some((value) => value.state === "waiting_bind"));

  assert.deepEqual(await service.sendText("任务完成"), { ok: true });
  assert.deepEqual(sendCalls[0], {
    botToken: "bot-token",
    baseUrl: "https://edge.weixin.example",
    toUserId: "scanner-user",
    contextToken: "context-1",
    text: "任务完成",
    signal: undefined,
  });
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

import test from "node:test";
import assert from "node:assert/strict";
import {
  WeixinIlinkClient,
  isWeixinSessionExpiredError,
} from "../desktop/weixin-ilink-client.mjs";

function jsonResponse(value, options = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    text: async () => JSON.stringify(value),
  };
}

test("iLink client requests a QR code with the current POST protocol", async () => {
  const calls = [];
  const client = new WeixinIlinkClient({
    fetchImpl: async (...args) => {
      calls.push(args);
      return jsonResponse({ qrcode: "qr-secret", qrcode_img_content: "https://qr.example/1" });
    },
    randomBytesImpl: () => Buffer.from([0, 0, 0, 1]),
  });

  const result = await client.getBotQrCode({ localTokenList: [" old-token ", ""] });
  assert.equal(result.qrcode, "qr-secret");
  assert.equal(calls.length, 1);
  const [url, request] = calls[0];
  assert.equal(url, "https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3");
  assert.equal(request.method, "POST");
  assert.equal(request.headers["Content-Type"], "application/json");
  assert.equal(request.headers.AuthorizationType, "ilink_bot_token");
  assert.equal(request.headers["X-WECHAT-UIN"], "MQ==");
  assert.equal(request.headers["iLink-App-Id"], "bot");
  assert.equal(request.headers["iLink-App-ClientVersion"], "256");
  assert.deepEqual(JSON.parse(request.body), { local_token_list: ["old-token"] });
});

test("iLink client polls every documented QR status and submits verification code", async () => {
  const statuses = [
    "wait",
    "scaned",
    "confirmed",
    "expired",
    "scaned_but_redirect",
    "need_verifycode",
    "verify_code_blocked",
    "binded_redirect",
  ];
  const calls = [];
  const client = new WeixinIlinkClient({
    fetchImpl: async (url, request) => {
      calls.push([url, request]);
      return jsonResponse({ status: statuses[calls.length - 1] });
    },
  });

  const results = [];
  for (const status of statuses) {
    const value = await client.getQrCodeStatus({
      qrcode: "qr value",
      verifyCode: status === "need_verifycode" ? "123456" : "",
    });
    results.push(value.status);
  }
  assert.deepEqual(results, statuses);
  assert.ok(calls.every(([, request]) => request.method === "GET"));
  assert.match(calls[0][0], /qrcode=qr\+value/);
  assert.match(calls[5][0], /verify_code=123456/);
});

test("iLink client formats getUpdates and text delivery requests", async () => {
  const calls = [];
  const client = new WeixinIlinkClient({
    fetchImpl: async (url, request) => {
      calls.push([url, request]);
      if (url.endsWith("/getupdates")) {
        return jsonResponse({ ret: 0, msgs: [], get_updates_buf: "next" });
      }
      return jsonResponse({ ret: 0 });
    },
    randomBytesImpl: () => Buffer.from([0, 0, 0, 2]),
    generateClientId: () => "client-message-1",
  });

  const updates = await client.getUpdates({
    botToken: "bot-token",
    baseUrl: "https://edge.weixin.example",
    getUpdatesBuf: "cursor",
  });
  assert.equal(updates.get_updates_buf, "next");
  const delivery = await client.sendText({
    botToken: "bot-token",
    baseUrl: "https://edge.weixin.example",
    toUserId: "user-1",
    contextToken: "context-1",
    text: "任务完成",
  });
  assert.deepEqual(delivery, {
    ok: true,
    messageId: "client-message-1",
    clientId: "client-message-1",
  });

  assert.equal(calls[0][0], "https://edge.weixin.example/ilink/bot/getupdates");
  assert.equal(calls[0][1].headers.Authorization, "Bearer bot-token");
  assert.deepEqual(JSON.parse(calls[0][1].body), {
    get_updates_buf: "cursor",
    base_info: { channel_version: "0.1.0", bot_agent: "AgentPet/0.1.0" },
  });
  assert.deepEqual(JSON.parse(calls[1][1].body), {
    msg: {
      from_user_id: "",
      client_id: "client-message-1",
      to_user_id: "user-1",
      message_type: 2,
      message_state: 2,
      context_token: "context-1",
      item_list: [{ type: 1, text_item: { text: "任务完成" } }],
    },
    base_info: { channel_version: "0.1.0", bot_agent: "AgentPet/0.1.0" },
  });
});

test("iLink client registers and unregisters the notification lifecycle", async () => {
  const calls = [];
  const client = new WeixinIlinkClient({
    fetchImpl: async (url, request) => {
      calls.push([url, request]);
      return jsonResponse({ ret: 0 });
    },
  });

  await client.notifyStart({ botToken: "token", baseUrl: "https://edge.weixin.example" });
  await client.notifyStop({ botToken: "token", baseUrl: "https://edge.weixin.example" });

  assert.deepEqual(calls.map(([url]) => url), [
    "https://edge.weixin.example/ilink/bot/msg/notifystart",
    "https://edge.weixin.example/ilink/bot/msg/notifystop",
  ]);
  assert.ok(calls.every(([, request]) => (
    request.headers.Authorization === "Bearer token"
    && JSON.parse(request.body).base_info.bot_agent === "AgentPet/0.1.0"
  )));
});

test("iLink client exposes session expiry code -14 without leaking the token", async () => {
  const client = new WeixinIlinkClient({
    fetchImpl: async () => jsonResponse({ ret: 0, errcode: -14, errmsg: "expired" }),
  });
  await assert.rejects(
    () => client.getUpdates({ botToken: "secret-token" }),
    (error) => {
      assert.equal(error.code, -14);
      assert.equal(error.ret, 0);
      assert.equal(error.errcode, -14);
      assert.equal(error.errmsg, "expired");
      assert.equal(error.sessionExpired, true);
      assert.equal(isWeixinSessionExpiredError(error), true);
      assert.doesNotMatch(error.message, /secret-token/);
      return true;
    },
  );
});

test("QR long-poll timeout is a normal wait result and external abort is preserved", async () => {
  const fetchImpl = async (_url, request) => new Promise((_resolve, reject) => {
    request.signal.addEventListener("abort", () => {
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
  const client = new WeixinIlinkClient({ fetchImpl, qrTimeoutMs: 10 });
  assert.deepEqual(await client.getQrCodeStatus({ qrcode: "q" }), { status: "wait" });

  const controller = new AbortController();
  const pending = client.getQrCodeStatus({ qrcode: "q", signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error) => error?.name === "AbortError");
});

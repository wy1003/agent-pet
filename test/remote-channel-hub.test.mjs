import test from "node:test";
import assert from "node:assert/strict";
import {
  RemoteChannelError,
  RemoteChannelHub,
  normalizeRemoteInbound,
} from "../desktop/remote-channel-hub.mjs";

function inbound(changes = {}) {
  return {
    channelId: "weixin",
    accountId: "wx-account",
    conversationId: "wx-user",
    conversationType: "private",
    messageId: "msg-1",
    senderId: "wx-user",
    text: "P001/C0001 继续：优化页面",
    reference: { messageId: "notice-1", text: "编号：P001/C0001" },
    ...changes,
  };
}

test("hub passes a standard inbound envelope to the controller and routes its reply", async () => {
  const sent = [];
  let handled;
  const controller = {
    async handleInbound(message, context) {
      handled = message;
      assert.deepEqual(context.capabilities, {
        maxTextLength: 2_000,
        supportsQuote: true,
        supportsMarkdown: false,
        supportsCards: false,
      });
      await context.reply("已提交");
      return { ok: true };
    },
  };
  const hub = new RemoteChannelHub({ controller, logger: { warn() {} } });
  hub.register({
    channelId: "Weixin",
    accountId: "wx-account",
    capabilities: { maxTextLength: 2_000, supportsQuote: true },
    send: async (message) => {
      sent.push(message);
      return { messageId: "reply-1" };
    },
  });

  assert.deepEqual(await hub.handleInbound(inbound()), { ok: true });
  assert.equal(handled.channelId, "weixin");
  assert.equal(handled.reference.text, "编号：P001/C0001");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channelId, "weixin");
  assert.equal(sent[0].accountId, "wx-account");
  assert.equal(sent[0].conversationId, "wx-user");
  assert.equal(sent[0].replyToMessageId, "msg-1");
  assert.equal(sent[0].text, "已提交");
});

test("hub selects adapters by channel and account without crossing conversations", async () => {
  const deliveries = [];
  const hub = new RemoteChannelHub({
    controller: { handleInbound: async () => ({ ok: true }) },
    logger: { warn() {} },
  });
  for (const [channelId, accountId] of [
    ["weixin", "wx-a"],
    ["weixin", "wx-b"],
    ["feishu", "fs-a"],
  ]) {
    hub.register({
      channelId,
      accountId,
      send: async (message) => deliveries.push(`${channelId}:${accountId}:${message.conversationId}`),
    });
  }

  await hub.send({
    channelId: "weixin",
    accountId: "wx-b",
    conversationId: "person-2",
    text: "微信消息",
  });
  await hub.send({
    channelId: "feishu",
    accountId: "fs-a",
    conversationId: "chat-9",
    text: "飞书消息",
  });
  assert.deepEqual(deliveries, ["weixin:wx-b:person-2", "feishu:fs-a:chat-9"]);
  assert.throws(
    () => hub.getCapabilities("weixin"),
    (error) => error instanceof RemoteChannelError && error.code === "channel_account_required",
  );
});

test("capabilities are normalized and returned as copies", () => {
  const hub = new RemoteChannelHub({
    controller: { handleInbound: async () => ({ ok: true }) },
  });
  hub.register({
    channelId: "qq",
    accountId: "bot-1",
    capabilities: {
      maxTextLength: 4_096,
      supportsQuote: true,
      supportsMarkdown: true,
      supportsCards: true,
    },
    send: async () => ({}),
  });
  const first = hub.getCapabilities("qq", "bot-1");
  first.supportsCards = false;
  assert.deepEqual(hub.getCapabilities("qq", "bot-1"), {
    maxTextLength: 4_096,
    supportsQuote: true,
    supportsMarkdown: true,
    supportsCards: true,
  });
});

test("a failing channel does not poison another registered channel", async () => {
  const delivered = [];
  const hub = new RemoteChannelHub({
    controller: { handleInbound: async () => ({ ok: true }) },
    logger: { warn() {} },
  });
  hub.register({
    channelId: "weixin",
    accountId: "broken",
    send: async () => { throw new Error("provider unavailable"); },
  });
  hub.register({
    channelId: "feishu",
    accountId: "healthy",
    send: async (message) => delivered.push(message.text),
  });

  await assert.rejects(
    hub.send({
      channelId: "weixin",
      accountId: "broken",
      conversationId: "user",
      text: "first",
    }),
    (error) => error instanceof RemoteChannelError && error.code === "channel_send_failed",
  );
  await hub.send({
    channelId: "feishu",
    accountId: "healthy",
    conversationId: "chat",
    text: "second",
  });
  assert.deepEqual(delivered, ["second"]);
});

test("adapter subscriptions feed normalized messages into the controller and unregister cleanly", async () => {
  const received = [];
  let listener;
  let unsubscribed = false;
  const hub = new RemoteChannelHub({
    controller: {
      handleInbound: async (message) => received.push(message),
    },
  });
  const unregister = hub.register({
    channelId: "qq",
    accountId: "qq-bot",
    subscribeInbound(value) {
      listener = value;
      return () => { unsubscribed = true; };
    },
    send: async () => ({}),
  });
  await listener(inbound({
    channelId: undefined,
    accountId: undefined,
    conversationId: "qq-user",
  }));
  assert.equal(received[0].channelId, "qq");
  assert.equal(received[0].accountId, "qq-bot");
  assert.equal(unregister(), true);
  assert.equal(unsubscribed, true);
});

test("normalization rejects incomplete routing identities", () => {
  assert.throws(
    () => normalizeRemoteInbound(inbound({ conversationId: "" })),
    /conversationId is required/,
  );
  assert.throws(
    () => normalizeRemoteInbound(inbound({ senderId: "" })),
    /senderId is required/,
  );
});

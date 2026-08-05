import test from "node:test";
import assert from "node:assert/strict";
import {
  createWeixinChannelAdapter,
  parseWeixinInboundMessage,
  WEIXIN_CHANNEL_CAPABILITIES,
} from "../desktop/remote-channels/weixin-channel.mjs";

function message(overrides = {}) {
  return {
    message_type: 1,
    message_id: 42,
    from_user_id: "bound-user",
    session_id: "private-session",
    context_token: "secret-reply-context-token",
    create_time_ms: 1_785_837_000_000,
    item_list: [{
      type: 1,
      text_item: { text: "继续优化设置页" },
      ref_msg: {
        title: "Agent Pet",
        message_item: {
          msg_id: "outbound-1",
          text_item: { text: "任务完成\n编号：P001/C0009" },
        },
      },
    }],
    ...overrides,
  };
}

test("Weixin normalizer produces a channel-neutral envelope", () => {
  const inbound = parseWeixinInboundMessage(message(), { accountId: "bot-account" });
  assert.deepEqual({
    channelId: inbound.channelId,
    accountId: inbound.accountId,
    messageId: inbound.messageId,
    dedupeKey: inbound.dedupeKey,
    senderId: inbound.senderId,
    conversationId: inbound.conversationId,
    conversationType: inbound.conversationType,
    text: inbound.text,
    connectionEvent: inbound.connectionEvent,
    reference: inbound.reference,
    createdAt: inbound.createdAt,
  }, {
    channelId: "weixin",
    accountId: "bot-account",
    messageId: "42",
    dedupeKey: "weixin:bot-account:42",
    senderId: "bound-user",
    conversationId: "private-session",
    conversationType: "private",
    text: "继续优化设置页",
    connectionEvent: "",
    reference: {
      messageId: "outbound-1",
      text: "Agent Pet\n任务完成\n编号：P001/C0009",
    },
    createdAt: 1_785_837_000_000,
  });
  assert.equal(inbound.replyContext.contextToken, "secret-reply-context-token");
  assert.equal(inbound.replyContext.recipientId, "bound-user");
});

test("Weixin adapter maps generic connection metadata without mutating provider messages", () => {
  const service = {
    credentials: { accountId: "bot-account" },
    isBoundUser: () => true,
    sendText: async () => ({ ok: true }),
  };
  const adapter = createWeixinChannelAdapter({ service });

  for (const connectionEvent of ["connected", "restored"]) {
    const raw = message({ message_id: `event-${connectionEvent}` });
    const inbound = adapter.normalizeInbound(raw, { connectionEvent });
    assert.equal(inbound.connectionEvent, connectionEvent);
    assert.equal("connectionEvent" in raw, false);
    assert.equal("agent_pet_connection_event" in raw, false);
  }

  assert.equal(
    adapter.normalizeInbound(message({ message_id: "event-unknown" }), {
      connectionEvent: "provider-specific-event",
    }).connectionEvent,
    "",
  );
});

test("Weixin reply token is transient and never serialized with the envelope", () => {
  const inbound = parseWeixinInboundMessage(message(), { accountId: "bot-account" });
  const serialized = JSON.stringify(inbound);
  assert.doesNotMatch(serialized, /secret-reply-context-token/);
  assert.equal(Object.keys(inbound.replyContext).includes("contextToken"), false);
  assert.equal(serialized.includes("contextToken"), false);
});

test("Weixin fallback dedupe keys are deterministic and channel namespaced", () => {
  const raw = message({ message_id: "", client_id: "" });
  const first = parseWeixinInboundMessage(raw, { accountId: "bot-account" });
  const second = parseWeixinInboundMessage(raw, { accountId: "bot-account" });
  assert.match(first.dedupeKey, /^weixin:sha256:[a-f0-9]{64}$/);
  assert.equal(first.dedupeKey, second.dedupeKey);
  assert.notEqual(
    first.dedupeKey,
    parseWeixinInboundMessage(raw, { accountId: "another-account" }).dedupeKey,
  );
  assert.equal(parseWeixinInboundMessage({ message_type: 2, item_list: [] }), null);
});

test("Weixin channel adapter authorizes the bound private user and delegates sends", async () => {
  const sends = [];
  const service = {
    credentials: { accountId: "bot-account", contextToken: "must-not-leak" },
    isBoundUser: (senderId) => senderId === "bound-user",
    sendText: async (text, options) => {
      sends.push({ text, options });
      return { ok: true, messageId: "sent-1" };
    },
  };
  const adapter = createWeixinChannelAdapter({ service });
  const inbound = adapter.normalizeInbound(message());
  assert.equal(adapter.id, "weixin");
  assert.equal(adapter.channelId, "weixin");
  assert.equal(adapter.capabilities, WEIXIN_CHANNEL_CAPABILITIES);
  assert.equal(adapter.isAuthorized(inbound), true);
  assert.equal(adapter.isAuthorized({ ...inbound, conversationType: "group" }), false);
  assert.equal(JSON.stringify(inbound).includes("must-not-leak"), false);

  const result = await adapter.send({ text: "已提交" }, { clientId: "client-1" });
  assert.deepEqual(result, { ok: true, messageId: "sent-1" });
  assert.deepEqual(sends, [{
    text: "已提交",
    options: { clientId: "client-1", signal: undefined },
  }]);
});

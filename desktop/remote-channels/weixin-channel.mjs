import { createHash } from "node:crypto";

export const WEIXIN_CHANNEL_ID = "weixin";

export const WEIXIN_CHANNEL_CAPABILITIES = Object.freeze({
  maxTextLength: 1_800,
  supportsQuote: true,
  supportsMarkdown: false,
  supportsCards: false,
});

function clean(value, limit = 4_000) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .trim()
    .slice(0, limit);
}

function referenceFromItem(item = {}) {
  const reference = item?.ref_msg || {};
  const nested = reference?.message_item || {};
  const title = clean(reference?.title, 500);
  const body = clean(nested?.text_item?.text, 6_000);
  return {
    messageId: clean(nested?.msg_id, 200),
    text: [title, body].filter(Boolean).join("\n"),
  };
}

function fallbackDedupeKey(value) {
  const digest = createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
  return `${WEIXIN_CHANNEL_ID}:sha256:${digest}`;
}

function createReplyContext(message, value = {}) {
  const replyContext = {
    channelId: WEIXIN_CHANNEL_ID,
    accountId: value.accountId,
    conversationId: value.conversationId,
    recipientId: value.senderId,
    sessionId: clean(message?.session_id, 200),
  };

  // The iLink context token is transient authentication material. Keeping it
  // non-enumerable lets the channel use it for an immediate reply without
  // leaking it through JSON logs, registry snapshots, or persisted envelopes.
  Object.defineProperty(replyContext, "contextToken", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: clean(message?.context_token, 2_000),
  });
  return replyContext;
}

/**
 * Converts a Tencent iLink message into the channel-neutral inbound envelope.
 * Authentication and command interpretation deliberately happen outside this
 * parser so the same remote controller can serve Weixin, QQ, Feishu, and more.
 */
export function parseWeixinInboundMessage(message = {}, options = {}) {
  if (Number(message?.message_type) !== 1) return null;

  const items = Array.isArray(message?.item_list) ? message.item_list : [];
  const textItems = items.filter((item) => (
    Number(item?.type) === 1 || item?.text_item?.text != null
  ));
  const input = textItems
    .map((item) => clean(item?.text_item?.text))
    .filter(Boolean)
    .join("\n");
  if (!input) return null;

  const reference = textItems
    .map(referenceFromItem)
    .find((item) => item.text || item.messageId)
    || { messageId: "", text: "" };
  const accountId = clean(
    options.accountId || message?.to_user_id || message?.account_id,
    200,
  );
  const senderId = clean(message?.from_user_id, 200);
  const groupId = clean(message?.group_id, 200);
  const sessionId = clean(message?.session_id, 200);
  const conversationType = groupId ? "group" : "private";
  const conversationId = groupId || sessionId || senderId;
  const messageId = clean(message?.message_id, 200)
    || clean(message?.client_id, 200);
  const createdAt = Number(message?.create_time_ms || 0);
  const rawConnectionEvent = clean(options.connectionEvent, 40).toLowerCase();
  const connectionEvent = ["connected", "restored"].includes(rawConnectionEvent)
    ? rawConnectionEvent
    : "";
  const dedupeKey = messageId
    ? `${WEIXIN_CHANNEL_ID}:${accountId || "default"}:${messageId}`
    : fallbackDedupeKey({
      accountId,
      senderId,
      conversationId,
      createdAt,
      text: input,
      reference,
    });

  const envelope = {
    channelId: WEIXIN_CHANNEL_ID,
    accountId,
    messageId,
    dedupeKey,
    senderId,
    conversationId,
    conversationType,
    text: input,
    connectionEvent,
    reference,
    createdAt,
    replyContext: null,
  };
  envelope.replyContext = createReplyContext(message, envelope);
  return envelope;
}

export class WeixinChannelAdapter {
  constructor(options = {}) {
    if (!options.service) throw new TypeError("service is required");
    this.service = options.service;
    this.accountId = clean(options.accountId, 200);
    this.id = WEIXIN_CHANNEL_ID;
    this.channelId = WEIXIN_CHANNEL_ID;
    this.capabilities = WEIXIN_CHANNEL_CAPABILITIES;
  }

  normalizeInbound(rawMessage, metadata = {}) {
    const accountId = this.accountId
      || clean(this.service?.credentials?.accountId, 200);
    return parseWeixinInboundMessage(rawMessage, {
      accountId,
      connectionEvent: metadata.connectionEvent,
    });
  }

  isAuthorized(envelope) {
    return envelope?.channelId === WEIXIN_CHANNEL_ID
      && envelope?.conversationType === "private"
      && Boolean(envelope?.senderId)
      && typeof this.service?.isBoundUser === "function"
      && this.service.isBoundUser(envelope.senderId);
  }

  getDefaultTarget() {
    return {
      channelId: WEIXIN_CHANNEL_ID,
      accountId: this.accountId,
      conversationId: clean(this.service?.credentials?.userId, 200),
    };
  }

  async send(message, options = {}) {
    const value = typeof message === "string" ? message : message?.text;
    const text = clean(value, 20_000);
    if (!text) throw new TypeError("message text is required");
    return this.service.sendText(text, {
      clientId: options.clientId || message?.clientId,
      signal: options.signal || message?.signal,
    });
  }
}

export function createWeixinChannelAdapter(options = {}) {
  return new WeixinChannelAdapter(options);
}

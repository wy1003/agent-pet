const DEFAULT_CAPABILITIES = Object.freeze({
  maxTextLength: null,
  supportsQuote: false,
  supportsMarkdown: false,
  supportsCards: false,
});

function requiredIdentifier(value, name) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new TypeError(`${name} is required`);
  return normalized;
}

function normalizeChannelId(value) {
  return requiredIdentifier(value, "channelId").toLowerCase();
}

function normalizeCapabilities(value = {}) {
  const maxTextLength = Number(value?.maxTextLength);
  return {
    maxTextLength: Number.isSafeInteger(maxTextLength) && maxTextLength > 0
      ? maxTextLength
      : null,
    supportsQuote: value?.supportsQuote === true,
    supportsMarkdown: value?.supportsMarkdown === true,
    supportsCards: value?.supportsCards === true,
  };
}

function adapterKey(channelId, accountId) {
  return `${channelId}\u0000${accountId}`;
}

function normalizeReference(value) {
  if (!value || typeof value !== "object") return null;
  const messageId = String(value.messageId ?? "").trim();
  const text = String(value.text ?? "").trim();
  if (!messageId && !text) return null;
  return {
    messageId,
    text,
    ...(value.senderId ? { senderId: String(value.senderId).trim() } : {}),
  };
}

/**
 * Normalize the channel-neutral message consumed by RemoteControlController.
 * Channel adapters are responsible for translating their provider payload into
 * this shape; provider-specific fields may be retained under `raw` only.
 */
export function normalizeRemoteInbound(value = {}, defaults = {}) {
  if (!value || typeof value !== "object") {
    throw new TypeError("remote inbound message must be an object");
  }
  const channelId = normalizeChannelId(value.channelId || defaults.channelId);
  const accountId = requiredIdentifier(value.accountId || defaults.accountId, "accountId");
  const conversationId = requiredIdentifier(value.conversationId, "conversationId");
  const messageId = requiredIdentifier(value.messageId, "messageId");
  const senderId = requiredIdentifier(value.senderId, "senderId");
  const text = String(value.text ?? "").trim();

  return {
    channelId,
    accountId,
    conversationId,
    conversationType: String(value.conversationType || "private").trim().toLowerCase(),
    messageId,
    dedupeKey: String(value.dedupeKey || `${channelId}:${accountId}:${messageId}`).trim(),
    senderId,
    text,
    reference: normalizeReference(value.reference) || { messageId: "", text: "" },
    createdAt: value.createdAt ?? value.receivedAt ?? "",
    replyContext: value.replyContext,
    raw: value.raw,
    metadata: value.metadata && typeof value.metadata === "object"
      ? { ...value.metadata }
      : {},
  };
}

function normalizeContent(value) {
  if (typeof value === "string") return { text: value };
  if (!value || typeof value !== "object") {
    throw new TypeError("outbound content must be a string or object");
  }
  return { ...value };
}

export class RemoteChannelError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "RemoteChannelError";
    this.code = options.code || "remote_channel_error";
    this.channelId = options.channelId || "";
    this.accountId = options.accountId || "";
  }
}

/**
 * Provider-neutral bridge between remote channel adapters and the remote
 * controller. Adapters own provider I/O; the controller owns agent routing and
 * execution. The hub only validates envelopes and returns replies to the same
 * channel/account/conversation.
 */
export class RemoteChannelHub {
  constructor(options = {}) {
    this.controller = options.controller || null;
    this.logger = options.logger || console;
    this.adapters = new Map();
  }

  setController(controller) {
    if (!controller || typeof controller.handleInbound !== "function") {
      throw new TypeError("controller.handleInbound is required");
    }
    this.controller = controller;
    return this;
  }

  register(adapter) {
    if (!adapter || typeof adapter !== "object") {
      throw new TypeError("channel adapter must be an object");
    }
    const channelId = normalizeChannelId(adapter.channelId);
    const accountId = requiredIdentifier(adapter.accountId, "accountId");
    if (typeof adapter.send !== "function") {
      throw new TypeError("channel adapter.send is required");
    }
    const key = adapterKey(channelId, accountId);
    if (this.adapters.has(key)) {
      throw new RemoteChannelError(`channel adapter already registered: ${channelId}/${accountId}`, {
        code: "channel_already_registered",
        channelId,
        accountId,
      });
    }

    const registration = {
      adapter,
      channelId,
      accountId,
      capabilities: normalizeCapabilities(adapter.capabilities),
      unsubscribe: null,
    };
    const receive = (inbound) => this.handleInbound(inbound, { channelId, accountId });
    // Publish the registration before subscribing: some adapters synchronously
    // replay a buffered inbound message when their listener is attached.
    this.adapters.set(key, registration);
    try {
      if (typeof adapter.subscribeInbound === "function") {
        const unsubscribe = adapter.subscribeInbound(receive);
        if (typeof unsubscribe === "function") registration.unsubscribe = unsubscribe;
      } else if (typeof adapter.setInboundHandler === "function") {
        adapter.setInboundHandler(receive);
        registration.unsubscribe = () => adapter.setInboundHandler(null);
      }
    } catch (error) {
      this.adapters.delete(key);
      throw error;
    }
    return () => this.unregister(channelId, accountId);
  }

  registerChannel(adapter) {
    return this.register(adapter);
  }

  unregister(channelIdValue, accountIdValue) {
    const channelId = normalizeChannelId(channelIdValue);
    const accountId = requiredIdentifier(accountIdValue, "accountId");
    const key = adapterKey(channelId, accountId);
    const registration = this.adapters.get(key);
    if (!registration) return false;
    this.adapters.delete(key);
    try {
      registration.unsubscribe?.();
    } catch (error) {
      this.logger.warn?.("[remote-channel] unable to unsubscribe adapter", {
        channelId,
        accountId,
        error,
      });
    }
    return true;
  }

  listChannels() {
    return [...this.adapters.values()].map((registration) => ({
      channelId: registration.channelId,
      accountId: registration.accountId,
      capabilities: { ...registration.capabilities },
    }));
  }

  getCapabilities(channelIdValue, accountIdValue) {
    const registration = this.#resolveAdapter(channelIdValue, accountIdValue);
    return { ...registration.capabilities };
  }

  capabilities(channelIdValue, accountIdValue) {
    return this.getCapabilities(channelIdValue, accountIdValue);
  }

  isAuthorized(inbound) {
    const normalized = normalizeRemoteInbound(inbound);
    const registration = this.#resolveAdapter(normalized.channelId, normalized.accountId);
    return typeof registration.adapter.isAuthorized === "function"
      ? registration.adapter.isAuthorized(normalized)
      : false;
  }

  getDefaultTarget(channelIdValue, accountIdValue) {
    const registration = this.#resolveAdapter(channelIdValue, accountIdValue);
    const target = typeof registration.adapter.getDefaultTarget === "function"
      ? registration.adapter.getDefaultTarget()
      : {};
    return {
      channelId: registration.channelId,
      accountId: registration.accountId,
      conversationId: String(target?.conversationId || "").trim(),
    };
  }

  async handleInbound(value, defaults = {}) {
    if (!this.controller || typeof this.controller.handleInbound !== "function") {
      throw new RemoteChannelError("remote controller is not configured", {
        code: "controller_not_configured",
      });
    }
    const inbound = normalizeRemoteInbound(value, defaults);
    const registration = this.#resolveAdapter(inbound.channelId, inbound.accountId);
    const context = {
      capabilities: { ...registration.capabilities },
      reply: (content, options = {}) => this.reply(content, { ...options, inbound }),
      send: (content, options = {}) => this.send({
        ...options,
        ...normalizeContent(content),
        channelId: inbound.channelId,
        accountId: inbound.accountId,
        conversationId: inbound.conversationId,
      }),
    };
    return this.controller.handleInbound(inbound, context);
  }

  receive(value, defaults = {}) {
    return this.handleInbound(value, defaults);
  }

  async reply(content, options = {}) {
    const inbound = normalizeRemoteInbound(options.inbound || options, options);
    const registration = this.#resolveAdapter(inbound.channelId, inbound.accountId);
    return this.send({
      ...options,
      ...normalizeContent(content),
      channelId: inbound.channelId,
      accountId: inbound.accountId,
      conversationId: inbound.conversationId,
      replyToMessageId: options.replyToMessageId
        || (registration.capabilities.supportsQuote && options.quote !== false
          ? inbound.messageId
          : ""),
      inbound: undefined,
      quote: undefined,
    });
  }

  async send(value = {}) {
    if (!value || typeof value !== "object") {
      throw new TypeError("outbound message must be an object");
    }
    const channelId = normalizeChannelId(value.channelId);
    const accountId = requiredIdentifier(value.accountId, "accountId");
    const conversationId = requiredIdentifier(value.conversationId, "conversationId");
    const registration = this.#resolveAdapter(channelId, accountId);
    const outbound = {
      ...value,
      channelId,
      accountId,
      conversationId,
    };
    try {
      const result = await registration.adapter.send(outbound);
      return {
        ...(result && typeof result === "object" ? result : { ok: result !== false }),
        channelId,
        accountId,
        conversationId,
      };
    } catch (error) {
      this.logger.warn?.("[remote-channel] adapter send failed", {
        channelId,
        accountId,
        conversationId,
        error,
      });
      throw new RemoteChannelError(`remote channel send failed: ${channelId}/${accountId}`, {
        code: "channel_send_failed",
        channelId,
        accountId,
        cause: error,
      });
    }
  }

  stop() {
    for (const { channelId, accountId } of this.listChannels()) {
      this.unregister(channelId, accountId);
    }
  }

  #resolveAdapter(channelIdValue, accountIdValue) {
    const channelId = normalizeChannelId(channelIdValue);
    const accountId = String(accountIdValue ?? "").trim();
    if (accountId) {
      const exact = this.adapters.get(adapterKey(channelId, accountId));
      if (exact) return exact;
    }
    const matches = [...this.adapters.values()].filter((entry) => entry.channelId === channelId);
    if (matches.length === 1 && !accountId) return matches[0];
    throw new RemoteChannelError(
      matches.length > 1 && !accountId
        ? `accountId is required for channel: ${channelId}`
        : `channel adapter is not registered: ${channelId}/${accountId}`,
      {
        code: matches.length > 1 && !accountId
          ? "channel_account_required"
          : "channel_not_registered",
        channelId,
        accountId,
      },
    );
  }
}

export { DEFAULT_CAPABILITIES, normalizeCapabilities };

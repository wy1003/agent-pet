import { randomBytes } from "node:crypto";

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_BOT_TYPE = "3";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_QR_TIMEOUT_MS = 35_000;
const DEFAULT_LONG_POLL_TIMEOUT_MS = 40_000;

// The public iLink gateway currently identifies the official channel as `bot`.
// Keep these configurable so a protocol update does not require changing callers.
const DEFAULT_ILINK_APP_ID = "bot";
const DEFAULT_ILINK_APP_CLIENT_VERSION = "256"; // Agent Pet 0.1.0 -> 0x00000100

export class WeixinIlinkError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "WeixinIlinkError";
    this.code = options.code ?? "ILINK_ERROR";
    this.endpoint = options.endpoint || "";
    this.httpStatus = options.httpStatus ?? null;
    this.sessionExpired = options.sessionExpired === true;
    this.ret = Number.isFinite(Number(options.ret)) ? Number(options.ret) : null;
    this.errcode = Number.isFinite(Number(options.errcode)) ? Number(options.errcode) : null;
    this.errmsg = String(options.errmsg || "").slice(0, 300);
  }
}

export function isWeixinSessionExpiredError(error) {
  return Boolean(error?.sessionExpired || Number(error?.code) === -14);
}

export function normalizeIlinkBaseUrl(value, fallback = DEFAULT_BASE_URL) {
  let text = String(value || fallback).trim();
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(text)) text = `https://${text}`;
  const parsed = new URL(text);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new WeixinIlinkError("微信服务地址必须使用 HTTP 或 HTTPS", {
      code: "INVALID_BASE_URL",
    });
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function abortError(reason) {
  if (reason instanceof Error) return reason;
  return new DOMException("This operation was aborted", "AbortError");
}

function randomWechatUin(randomBytesImpl) {
  const value = randomBytesImpl(4).readUInt32BE(0);
  return Buffer.from(String(value), "utf8").toString("base64");
}

function apiErrorCode(payload) {
  if (Number(payload?.errcode) === -14 || Number(payload?.ret) === -14) return -14;
  if (typeof payload?.ret === "number" && payload.ret !== 0) return payload.ret;
  if (typeof payload?.errcode === "number" && payload.errcode !== 0) return payload.errcode;
  return 0;
}

export class WeixinIlinkClient {
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof this.fetchImpl !== "function") {
      throw new TypeError("WeixinIlinkClient requires a fetch implementation");
    }
    this.baseUrl = normalizeIlinkBaseUrl(options.baseUrl);
    this.timeoutMs = Math.max(1, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS));
    this.qrTimeoutMs = Math.max(1, Number(options.qrTimeoutMs || DEFAULT_QR_TIMEOUT_MS));
    this.longPollTimeoutMs = Math.max(
      1,
      Number(options.longPollTimeoutMs || DEFAULT_LONG_POLL_TIMEOUT_MS),
    );
    this.botType = String(options.botType || DEFAULT_BOT_TYPE);
    this.appId = String(options.appId ?? DEFAULT_ILINK_APP_ID);
    this.appClientVersion = String(
      options.appClientVersion ?? DEFAULT_ILINK_APP_CLIENT_VERSION,
    );
    this.channelVersion = String(options.channelVersion || "0.1.0");
    this.botAgent = String(options.botAgent || "AgentPet/0.1.0");
    this.randomBytesImpl = options.randomBytesImpl || randomBytes;
    this.generateClientId = options.generateClientId
      || (() => `agent-pet-${this.randomBytesImpl(16).toString("hex")}`);
  }

  #baseInfo() {
    return {
      channel_version: this.channelVersion,
      bot_agent: this.botAgent,
    };
  }

  #commonHeaders() {
    return {
      "iLink-App-Id": this.appId,
      "iLink-App-ClientVersion": this.appClientVersion,
    };
  }

  #postHeaders(botToken) {
    const headers = {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      "X-WECHAT-UIN": randomWechatUin(this.randomBytesImpl),
      ...this.#commonHeaders(),
    };
    if (String(botToken || "").trim()) {
      headers.Authorization = `Bearer ${String(botToken).trim()}`;
    }
    return headers;
  }

  async #requestJson(endpoint, options = {}) {
    const baseUrl = normalizeIlinkBaseUrl(options.baseUrl, this.baseUrl);
    const url = new URL(endpoint, `${baseUrl}/`).toString();
    const timeoutMs = Math.max(1, Number(options.timeoutMs || this.timeoutMs));
    const externalSignal = options.signal;
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) throw abortError(externalSignal.reason);
    externalSignal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        method: options.method || "POST",
        headers: options.headers,
        body: options.body,
        signal: controller.signal,
      });
      const raw = await response.text();
      if (!response.ok) {
        throw new WeixinIlinkError(`微信服务请求失败（HTTP ${response.status}）`, {
          code: "HTTP_ERROR",
          endpoint,
          httpStatus: response.status,
        });
      }
      let payload;
      try {
        payload = raw ? JSON.parse(raw) : {};
      } catch (error) {
        throw new WeixinIlinkError("微信服务返回了无法解析的数据", {
          code: "INVALID_RESPONSE",
          endpoint,
          cause: error,
        });
      }
      const code = apiErrorCode(payload);
      if (code) {
        const errmsg = String(payload?.errmsg || `微信服务返回错误 ${code}`);
        throw new WeixinIlinkError(
          code === -14
            ? "微信连接已失效，请重新扫码"
            : errmsg,
          {
            code,
            endpoint,
            sessionExpired: code === -14,
            ret: payload?.ret,
            errcode: payload?.errcode,
            errmsg,
          },
        );
      }
      return payload;
    } catch (error) {
      if (externalSignal?.aborted) throw abortError(externalSignal.reason);
      if (timedOut) {
        throw new WeixinIlinkError("微信服务请求超时", {
          code: "ETIMEDOUT",
          endpoint,
          cause: error,
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onAbort);
    }
  }

  async getBotQrCode(options = {}) {
    const localTokenList = Array.isArray(options.localTokenList)
      ? options.localTokenList.map((value) => String(value || "").trim()).filter(Boolean).slice(0, 10)
      : [];
    return this.#requestJson(
      `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(this.botType)}`,
      {
        method: "POST",
        headers: this.#postHeaders(),
        body: JSON.stringify({ local_token_list: localTokenList }),
        timeoutMs: options.timeoutMs || this.timeoutMs,
        signal: options.signal,
      },
    );
  }

  async getQrCodeStatus(options = {}) {
    const qrcode = String(options.qrcode || "").trim();
    if (!qrcode) throw new TypeError("qrcode is required");
    const query = new URLSearchParams({ qrcode });
    if (String(options.verifyCode || "").trim()) {
      query.set("verify_code", String(options.verifyCode).trim());
    }
    try {
      return await this.#requestJson(`ilink/bot/get_qrcode_status?${query}`, {
        method: "GET",
        headers: this.#commonHeaders(),
        baseUrl: options.baseUrl,
        timeoutMs: options.timeoutMs || this.qrTimeoutMs,
        signal: options.signal,
      });
    } catch (error) {
      if (error?.code === "ETIMEDOUT") return { status: "wait" };
      throw error;
    }
  }

  async getUpdates(options = {}) {
    const getUpdatesBuf = String(options.getUpdatesBuf || "");
    try {
      return await this.#requestJson("ilink/bot/getupdates", {
        method: "POST",
        headers: this.#postHeaders(options.botToken),
        body: JSON.stringify({
          get_updates_buf: getUpdatesBuf,
          base_info: this.#baseInfo(),
        }),
        baseUrl: options.baseUrl,
        timeoutMs: options.timeoutMs || this.longPollTimeoutMs,
        signal: options.signal,
      });
    } catch (error) {
      if (error?.code === "ETIMEDOUT") {
        return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
      }
      throw error;
    }
  }

  async notifyStart(options = {}) {
    await this.#requestJson("ilink/bot/msg/notifystart", {
      method: "POST",
      headers: this.#postHeaders(options.botToken),
      body: JSON.stringify({ base_info: this.#baseInfo() }),
      baseUrl: options.baseUrl,
      timeoutMs: options.timeoutMs || this.timeoutMs,
      signal: options.signal,
    });
    return { ok: true };
  }

  async notifyStop(options = {}) {
    await this.#requestJson("ilink/bot/msg/notifystop", {
      method: "POST",
      headers: this.#postHeaders(options.botToken),
      body: JSON.stringify({ base_info: this.#baseInfo() }),
      baseUrl: options.baseUrl,
      timeoutMs: options.timeoutMs || this.timeoutMs,
      signal: options.signal,
    });
    return { ok: true };
  }

  async sendText(options = {}) {
    const text = String(options.text || "").trim();
    const toUserId = String(options.toUserId || "").trim();
    const contextToken = String(options.contextToken || "").trim();
    if (!text) throw new TypeError("text is required");
    if (!toUserId) throw new TypeError("toUserId is required");
    if (!contextToken) throw new TypeError("contextToken is required");

    const clientId = String(options.clientId || this.generateClientId()).trim();
    if (!clientId) throw new TypeError("clientId is required");

    await this.#requestJson("ilink/bot/sendmessage", {
      method: "POST",
      headers: this.#postHeaders(options.botToken),
      body: JSON.stringify({
        msg: {
          // AstrBot and Tencent's reference implementations keep this field even
          // when the backend derives the sender from the bearer token.
          from_user_id: "",
          client_id: clientId,
          to_user_id: toUserId,
          message_type: 2,
          message_state: 2,
          context_token: contextToken,
          item_list: [{ type: 1, text_item: { text } }],
        },
        base_info: this.#baseInfo(),
      }),
      baseUrl: options.baseUrl,
      timeoutMs: options.timeoutMs || this.timeoutMs,
      signal: options.signal,
    });
    return { ok: true, messageId: clientId, clientId };
  }
}

export {
  DEFAULT_BASE_URL,
  DEFAULT_BOT_TYPE,
  DEFAULT_LONG_POLL_TIMEOUT_MS,
  DEFAULT_QR_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
};

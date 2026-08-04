import {
  DEFAULT_BASE_URL,
  WeixinIlinkClient,
  WeixinIlinkError,
  isWeixinSessionExpiredError,
  normalizeIlinkBaseUrl,
} from "./weixin-ilink-client.mjs";
import QRCode from "qrcode";

function delay(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason || new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    timer.unref?.();
    function done() {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      reject(signal.reason || new DOMException("Aborted", "AbortError"));
    }
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

function isAbortError(error) {
  return error?.name === "AbortError";
}

function deliveryFailureMessage(error) {
  const code = String(error?.code || "").trim();
  const detail = String(error?.errmsg || error?.message || "微信通知发送失败").trim();
  if (Number(error?.code) === -2) {
    return `微信拒绝发送（-2：${detail}）。会话上下文可能已经失效，请先在微信中向 Agent Pet 发送一条消息刷新连接。`;
  }
  return code && detail !== code ? `${code}：${detail}` : (detail || code);
}

function normalizeCredentials(value) {
  if (!value || typeof value !== "object") return null;
  const botToken = String(value.botToken || "").trim();
  const accountId = String(value.accountId || "").trim();
  if (!botToken || !accountId) return null;
  return {
    botToken,
    accountId,
    baseUrl: normalizeIlinkBaseUrl(value.baseUrl, DEFAULT_BASE_URL),
    scannerUserId: String(value.scannerUserId || "").trim(),
    userId: String(value.userId || "").trim(),
    contextToken: String(value.contextToken || "").trim(),
    contextUpdatedAt: String(value.contextUpdatedAt || "").trim(),
    getUpdatesBuf: String(value.getUpdatesBuf || ""),
  };
}

export class WeixinRemoteService {
  constructor(options = {}) {
    this.loadCredentials = options.loadCredentials || (async () => null);
    this.saveCredentials = options.saveCredentials || (async () => {});
    this.clearCredentials = options.clearCredentials || (async () => {});
    this.onStatus = options.onStatus || (() => {});
    this.client = options.client || new WeixinIlinkClient(options.clientOptions);
    this.logger = options.logger || console;
    this.retryMs = Math.max(10, Number(options.retryMs || 1_500));
    this.retryMaxMs = Math.max(this.retryMs, Number(options.retryMaxMs || 30_000));
    this.qrPollDelayMs = Math.max(10, Number(options.qrPollDelayMs || 500));
    this.encodeQrCode = options.encodeQrCode || ((content) => QRCode.toDataURL(content, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 320,
      color: { dark: "#173d33", light: "#ffffff" },
    }));

    this.credentials = null;
    this.state = "disconnected";
    this.qrCodeUrl = "";
    this.lastError = "";
    this.lastSendError = "";
    this.lastSendAt = "";
    this.lastSendSuccessAt = "";
    this.started = false;
    this.loginController = null;
    this.loginPromise = null;
    this.pollController = null;
    this.pollPromise = null;
    this.verifyResolve = null;
    this.saveChain = Promise.resolve();
    this.consecutivePollFailures = 0;
  }

  status() {
    const bound = Boolean(this.credentials?.userId && this.credentials?.contextToken);
    const connected = this.state === "connected";
    const deliveryState = !bound
      ? "unavailable"
      : this.lastSendError
        ? "degraded"
        : connected
          ? "ready"
          : "recovering";
    return {
      state: this.state,
      connected,
      bound,
      sendAvailable: deliveryState === "ready",
      deliveryState,
      qrCodeUrl: this.qrCodeUrl,
      lastError: this.lastError,
      lastSendError: this.lastSendError,
      lastSendAt: this.lastSendAt,
      lastSendSuccessAt: this.lastSendSuccessAt,
      contextUpdatedAt: this.credentials?.contextUpdatedAt || "",
      accountLabel: this.credentials ? "已连接的微信" : "",
    };
  }

  #emitStatus(state = this.state, changes = {}) {
    this.state = state;
    if (Object.hasOwn(changes, "qrCodeUrl")) this.qrCodeUrl = changes.qrCodeUrl || "";
    if (Object.hasOwn(changes, "lastError")) this.lastError = changes.lastError || "";
    const snapshot = this.status();
    try {
      this.onStatus(snapshot);
    } catch (error) {
      this.logger.warn?.("[weixin] status listener failed", error);
    }
    return snapshot;
  }

  #persistCredentials() {
    if (!this.credentials) return Promise.resolve();
    const snapshot = { ...this.credentials };
    this.saveChain = this.saveChain
      .catch(() => {})
      .then(() => this.saveCredentials(snapshot));
    return this.saveChain;
  }

  async start() {
    if (this.started) return this.status();
    this.started = true;
    try {
      this.credentials = normalizeCredentials(await this.loadCredentials());
    } catch (error) {
      this.credentials = null;
      this.logger.warn?.("[weixin] failed to load credentials", error);
      return this.#emitStatus("error", {
        lastError: "无法读取微信连接信息",
        qrCodeUrl: "",
      });
    }
    if (!this.credentials) {
      return this.#emitStatus("disconnected", { lastError: "", qrCodeUrl: "" });
    }
    const bound = Boolean(this.credentials.userId && this.credentials.contextToken);
    this.#emitStatus(bound ? "reconnecting" : "waiting_bind", {
      lastError: "",
      qrCodeUrl: "",
    });
    this.#startPolling();
    return this.status();
  }

  async beginConnection() {
    this.started = true;
    await this.#stopLogin();
    await this.#stopPolling();
    this.lastError = "";
    this.lastSendError = "";
    this.lastSendAt = "";
    this.lastSendSuccessAt = "";

    const controller = new AbortController();
    this.loginController = controller;
    try {
      const response = await this.client.getBotQrCode({
        localTokenList: this.credentials?.botToken ? [this.credentials.botToken] : [],
        signal: controller.signal,
      });
      if (!response?.qrcode || !response?.qrcode_img_content) {
        throw new WeixinIlinkError("微信服务未返回二维码", {
          code: "INVALID_QR_RESPONSE",
        });
      }
      const qrContent = String(response.qrcode_img_content);
      if (qrContent.length > 4_096) {
        throw new WeixinIlinkError("微信二维码内容异常", {
          code: "INVALID_QR_RESPONSE",
        });
      }
      const qrCodeUrl = await this.encodeQrCode(qrContent);
      this.#emitStatus("waiting_scan", {
        qrCodeUrl,
        lastError: "",
      });
      this.loginPromise = this.#pollLogin(response.qrcode, controller.signal)
        .catch((error) => {
          if (!isAbortError(error)) {
            this.logger.warn?.("[weixin] QR login stopped", error);
            this.#emitStatus("error", {
              lastError: error?.message || "微信连接失败",
              qrCodeUrl: "",
            });
          }
        })
        .finally(() => {
          if (this.loginController === controller) this.loginController = null;
          this.verifyResolve = null;
          this.loginPromise = null;
        });
      return this.status();
    } catch (error) {
      if (this.loginController === controller) this.loginController = null;
      if (isAbortError(error)) return this.status();
      this.logger.warn?.("[weixin] failed to request QR code", error);
      return this.#emitStatus("error", {
        lastError: error?.message || "无法获取微信二维码",
        qrCodeUrl: "",
      });
    }
  }

  async #pollLogin(qrcode, signal) {
    let pollingBaseUrl = DEFAULT_BASE_URL;
    let verifyCode = "";
    while (!signal.aborted) {
      const response = await this.client.getQrCodeStatus({
        qrcode,
        verifyCode,
        baseUrl: pollingBaseUrl,
        signal,
      });
      verifyCode = "";
      switch (response?.status) {
        case "wait":
          this.#emitStatus("waiting_scan", { lastError: "" });
          break;
        case "scaned":
          this.#emitStatus("scanned", { lastError: "" });
          break;
        case "need_verifycode":
          this.#emitStatus("verification_required", { lastError: "" });
          verifyCode = await this.#waitForVerifyCode(signal);
          this.#emitStatus("scanned", { lastError: "" });
          continue;
        case "scaned_but_redirect":
          if (response.redirect_host) {
            pollingBaseUrl = normalizeIlinkBaseUrl(response.redirect_host);
          }
          this.#emitStatus("scanned", { lastError: "" });
          break;
        case "confirmed":
          await this.#completeLogin(response, pollingBaseUrl);
          return;
        case "binded_redirect":
          if (!this.credentials) {
            throw new WeixinIlinkError("该微信已连接，但本机没有可恢复的连接信息", {
              code: "BINDING_NOT_FOUND",
            });
          }
          this.#emitStatus(
            this.credentials.userId && this.credentials.contextToken
              ? "reconnecting"
              : "waiting_bind",
            { qrCodeUrl: "", lastError: "" },
          );
          this.#startPolling();
          return;
        case "expired":
          throw new WeixinIlinkError("二维码已过期，请重新连接", {
            code: "QR_EXPIRED",
          });
        case "verify_code_blocked":
          throw new WeixinIlinkError("验证次数过多，请稍后重新连接", {
            code: "VERIFY_CODE_BLOCKED",
          });
        default:
          throw new WeixinIlinkError("微信返回了未知的扫码状态", {
            code: "UNKNOWN_QR_STATUS",
          });
      }
      await delay(this.qrPollDelayMs, signal);
    }
  }

  #waitForVerifyCode(signal) {
    if (signal.aborted) return Promise.reject(signal.reason || new DOMException("Aborted", "AbortError"));
    return new Promise((resolve, reject) => {
      const aborted = () => {
        this.verifyResolve = null;
        reject(signal.reason || new DOMException("Aborted", "AbortError"));
      };
      signal.addEventListener("abort", aborted, { once: true });
      this.verifyResolve = (code) => {
        signal.removeEventListener("abort", aborted);
        this.verifyResolve = null;
        resolve(code);
      };
    });
  }

  async submitVerifyCode(value) {
    const code = String(value || "").trim();
    if (!/^\d{1,12}$/.test(code)) {
      throw new WeixinIlinkError("请输入微信中显示的数字", {
        code: "INVALID_VERIFY_CODE",
      });
    }
    if (this.state !== "verification_required" || !this.verifyResolve) {
      throw new WeixinIlinkError("当前不需要输入验证码", {
        code: "VERIFY_CODE_NOT_REQUIRED",
      });
    }
    this.verifyResolve(code);
    return this.status();
  }

  async #completeLogin(response, pollingBaseUrl) {
    const botToken = String(response?.bot_token || "").trim();
    const accountId = String(response?.ilink_bot_id || "").trim();
    if (!botToken || !accountId) {
      throw new WeixinIlinkError("微信确认成功，但连接凭据不完整", {
        code: "INCOMPLETE_CREDENTIALS",
      });
    }
    this.credentials = {
      botToken,
      accountId,
      baseUrl: normalizeIlinkBaseUrl(response.baseurl, pollingBaseUrl),
      scannerUserId: String(response.ilink_user_id || "").trim(),
      userId: "",
      contextToken: "",
      contextUpdatedAt: "",
      getUpdatesBuf: "",
    };
    await this.#persistCredentials();
    this.#emitStatus("waiting_bind", { qrCodeUrl: "", lastError: "" });
    this.#startPolling();
  }

  #startPolling() {
    if (!this.credentials || this.pollPromise) return;
    const controller = new AbortController();
    this.pollController = controller;
    this.pollPromise = this.#pollUpdates(controller.signal)
      .catch((error) => {
        if (!isAbortError(error)) {
          this.logger.warn?.("[weixin] update loop stopped", error);
        }
      })
      .finally(() => {
        if (this.pollController === controller) this.pollController = null;
        this.pollPromise = null;
      });
  }

  async #pollUpdates(signal) {
    let notifyStarted = false;
    while (!signal.aborted && this.credentials) {
      try {
        if (!notifyStarted && typeof this.client.notifyStart === "function") {
          await this.client.notifyStart({
            botToken: this.credentials.botToken,
            baseUrl: this.credentials.baseUrl,
            signal,
          });
          notifyStarted = true;
          if (this.credentials.userId && this.credentials.contextToken) {
            this.#emitStatus("connected", { lastError: "", qrCodeUrl: "" });
          }
        }
        const response = await this.client.getUpdates({
          botToken: this.credentials.botToken,
          baseUrl: this.credentials.baseUrl,
          getUpdatesBuf: this.credentials.getUpdatesBuf,
          signal,
        });
        if (signal.aborted || !this.credentials) return;
        this.consecutivePollFailures = 0;

        let changed = false;
        if (
          typeof response?.get_updates_buf === "string"
          && response.get_updates_buf !== this.credentials.getUpdatesBuf
        ) {
          this.credentials.getUpdatesBuf = response.get_updates_buf;
          changed = true;
        }
        for (const message of Array.isArray(response?.msgs) ? response.msgs : []) {
          if (Number(message?.message_type) !== 1) continue;
          const fromUserId = String(message?.from_user_id || "").trim();
          const contextToken = String(message?.context_token || "").trim();
          if (!fromUserId || !contextToken) continue;
          if (this.credentials.scannerUserId && fromUserId !== this.credentials.scannerUserId) {
            continue;
          }
          if (this.credentials.userId && fromUserId !== this.credentials.userId) continue;
          this.credentials.userId = fromUserId;
          this.credentials.contextToken = contextToken;
          this.credentials.contextUpdatedAt = new Date().toISOString();
          this.lastSendError = "";
          changed = true;
        }
        if (changed) await this.#persistCredentials();

        const bound = Boolean(this.credentials.userId && this.credentials.contextToken);
        if (bound && (this.state !== "connected" || this.lastError)) {
          this.#emitStatus("connected", { lastError: "", qrCodeUrl: "" });
        } else if (!bound && (this.state !== "waiting_bind" || this.lastError)) {
          this.#emitStatus("waiting_bind", { lastError: "", qrCodeUrl: "" });
        }
      } catch (error) {
        if (signal.aborted || isAbortError(error)) return;
        if (isWeixinSessionExpiredError(error)) {
          await this.#invalidateSession("微信连接已失效，请重新扫码");
          return;
        }
        this.logger.warn?.("[weixin] long poll failed; retrying", error);
        notifyStarted = false;
        this.consecutivePollFailures += 1;
        const bound = Boolean(this.credentials?.userId && this.credentials?.contextToken);
        this.#emitStatus(bound ? "reconnecting" : "waiting_bind", {
          lastError: "微信连接暂时中断，正在重试",
        });
        const retryDelay = Math.min(
          this.retryMaxMs,
          this.retryMs * (2 ** Math.min(this.consecutivePollFailures - 1, 5)),
        );
        await delay(retryDelay, signal);
      }
    }
  }

  async sendText(value, options = {}) {
    const text = String(value || "").trim();
    if (!this.credentials) {
      throw new WeixinIlinkError("微信尚未连接", {
        code: "remote_not_connected",
      });
    }
    if (!this.credentials.userId || !this.credentials.contextToken) {
      throw new WeixinIlinkError("请先在微信中向 Agent Pet 发送一条消息完成绑定", {
        code: "remote_not_bound",
      });
    }
    if (this.state !== "connected") {
      const error = new WeixinIlinkError("微信连接正在恢复，请稍后重试", {
        code: "remote_reconnecting",
      });
      error.transient = true;
      throw error;
    }
    try {
      const result = await this.client.sendText({
        botToken: this.credentials.botToken,
        baseUrl: this.credentials.baseUrl,
        toUserId: this.credentials.userId,
        contextToken: this.credentials.contextToken,
        text,
        signal: options.signal,
      });
      const deliveredAt = new Date().toISOString();
      this.lastSendError = "";
      this.lastSendAt = deliveredAt;
      this.lastSendSuccessAt = deliveredAt;
      this.#emitStatus();
      return result;
    } catch (error) {
      if (isWeixinSessionExpiredError(error)) {
        await this.#invalidateSession("微信连接已失效，请重新扫码");
        throw new WeixinIlinkError("微信连接已失效，请重新扫码", {
          code: "session_expired",
          sessionExpired: true,
          cause: error,
        });
      }
      this.lastSendAt = new Date().toISOString();
      this.lastSendError = deliveryFailureMessage(error);
      this.logger.warn?.("[weixin] sendmessage failed", {
        endpoint: error?.endpoint || "ilink/bot/sendmessage",
        code: error?.code || "",
        ret: error?.ret,
        errcode: error?.errcode,
        errmsg: error?.errmsg || error?.message || "",
      });
      this.#emitStatus();
      throw error;
    }
  }

  async #invalidateSession(message) {
    this.pollController?.abort();
    this.credentials = null;
    this.lastSendError = "";
    await this.clearCredentials();
    this.#emitStatus("error", { lastError: message, qrCodeUrl: "" });
  }

  async #stopLogin() {
    const pending = this.loginPromise;
    this.loginController?.abort();
    this.verifyResolve = null;
    await pending?.catch(() => {});
  }

  async #stopPolling() {
    const credentials = this.credentials ? { ...this.credentials } : null;
    const pending = this.pollPromise;
    this.pollController?.abort();
    await pending?.catch(() => {});
    if (credentials && typeof this.client.notifyStop === "function") {
      await this.client.notifyStop({
        botToken: credentials.botToken,
        baseUrl: credentials.baseUrl,
        signal: AbortSignal.timeout(3_000),
      }).catch((error) => {
        if (!isAbortError(error)) this.logger.warn?.("[weixin] notify stop failed", error);
      });
    }
  }

  async disconnect() {
    await this.#stopLogin();
    await this.#stopPolling();
    this.credentials = null;
    await this.clearCredentials();
    return this.#emitStatus("disconnected", { lastError: "", qrCodeUrl: "" });
  }

  async stop() {
    await this.#stopLogin();
    await this.#stopPolling();
    this.started = false;
    return this.#emitStatus("disconnected", { lastError: "", qrCodeUrl: "" });
  }
}

export { normalizeCredentials };

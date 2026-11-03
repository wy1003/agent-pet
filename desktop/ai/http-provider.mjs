import { aiError } from "./errors.mjs";

export function normalizeAiBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw aiError("configuration", "请填写有效的 AI 服务地址。"); }
  if (url.username || url.password || url.search || url.hash || !["http:", "https:"].includes(url.protocol)) {
    throw aiError("configuration", "AI 服务地址不能包含账号、密码、查询参数或片段。");
  }
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw aiError("configuration", "远程 AI 服务必须使用 HTTPS，本机服务可使用 HTTP。");
  }
  return url.href.replace(/\/+$/, "");
}

export class HttpTextProvider {
  constructor({ id, name, loadKey, fetchImpl = fetch }) {
    Object.assign(this, { id, name, loadKey, fetchImpl });
  }

  async open(config, { signal } = {}) {
    const baseUrl = normalizeAiBaseUrl(config.baseUrl);
    const credential = await this.loadKey(this.id);
    // Credentials are bound to the saved endpoint; changing it never forwards an old key.
    const apiKey = credential?.baseUrl === baseUrl ? credential.apiKey : "";
    if (!apiKey) throw aiError("authentication", "请为当前服务地址保存 API 密钥，再检查连接。");
    const request = async (route, body) => {
      const response = await this.fetchImpl(`${baseUrl}/${route}`, {
        method: body ? "POST" : "GET", redirect: "error", signal,
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if ([401, 403].includes(response.status)) throw aiError("authentication", "AI 连接认证或权限检查失败，请检查 API 密钥。");
        if (response.status === 429) throw aiError("rate_limit", "AI 服务限流或额度不足，请稍后重试。");
        if ([400, 404, 422].includes(response.status)) throw aiError("incompatible", "当前接口、模型或请求格式不兼容，请检查服务地址和模型选择。");
        throw aiError("connection_failed", "AI 服务暂时不可用，请稍后重试。");
      }
      // Stream with a byte limit, rather than trusting Content-Length.
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 4 * 1024 * 1024) throw aiError("invalid_response", "AI 服务响应过大。");
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { throw aiError("invalid_response", "AI 服务返回了无法识别的数据。"); }
    };
    const list = await request("models");
    if (!Array.isArray(list.data)) throw aiError("catalog_invalid", "服务没有提供有效的模型列表，无法自动检查兼容性。");
    const models = [...new Map(list.data.filter((item) => typeof item.id === "string" && item.id).map((item) => [item.id, {
      id: item.id, name: String(item.name || item.id), isDefault: item.isDefault === true || item.is_default === true,
    }])).values()];
    // Standard /models has no default field: never guess the first model.
    const defaultModelId = config.defaultModelId || list.default_model || models.find((item) => item.isDefault)?.id || "";
    return {
      catalog: { name: this.name, models, defaultModelId, modelProvider: this.id },
      generate: async ({ model, prompt, schema }) => {
        const result = await request("chat/completions", {
          model: model.id, stream: false,
          messages: [{ role: "user", content: `${prompt}\n\n仅返回 JSON 对象，遵守以下 JSON Schema：\n${JSON.stringify(schema)}` }],
          response_format: { type: "json_object" },
        });
        const choice = result.choices?.[0];
        if (choice?.finish_reason !== "stop" || typeof choice.message?.content !== "string" || !choice.message.content.trim()) {
          throw aiError("invalid_output", "AI 返回内容为空、不完整或不符合要求，请重试。");
        }
        return { text: choice.message.content };
      },
      close() {},
    };
  }
}

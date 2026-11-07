export function aiError(code, message) {
  return Object.assign(new Error(message), { code, safeAiError: true });
}

// Never send raw provider bodies, stderr or credentials to renderer/logs.
export function publicAiError(error) {
  if (error?.safeAiError) return error;
  if (error?.name === "AbortError") return aiError("cancelled", "AI 请求已取消。");
  const message = String(error?.message || "");
  if (/requires a newer version|upgrade.*(?:CLI|Codex)|unsupported.*(?:version|protocol)|method not found|unknown (?:method|variant)/i.test(message)) {
    return aiError("runtime_incompatible", "当前 Codex 运行程序与模型不兼容，请升级 Codex 后重新检查连接。");
  }
  if (/model.*(?:not found|does not exist|not supported|not available)|model_not_found/i.test(message)) {
    return aiError("model_unavailable", "所选模型已不可用，请刷新模型列表并重新选择。");
  }
  if (/401|unauthorized|authentication|login|sign.in/i.test(message)) {
    return aiError("authentication", "AI 连接认证失败，请检查登录状态或 API 密钥。");
  }
  if (/429|rate.limit|quota|insufficient.*credit|credit.*balance|billing/i.test(message)) return aiError("rate_limit", "AI 服务暂时限流或额度不足，请稍后重试。");
  return aiError("connection_failed", "AI 连接或生成失败，请检查服务地址、网络和连接配置后重试。");
}

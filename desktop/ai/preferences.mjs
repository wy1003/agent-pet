export const AI_CONNECTIONS = Object.freeze([
  { id: "agent", name: "沿用既有 AI 来源" },
  { id: "codex", name: "Codex" },
  { id: "claude", name: "Claude Code" },
  { id: "deepseek", name: "DeepSeek" },
  { id: "compatible", name: "其他兼容接口" },
]);

const clean = (value) => typeof value === "string" ? value.trim().slice(0, 300) : "";

export function normalizeAiPreferences(value = {}) {
  const connections = {};
  for (const id of ["deepseek", "compatible"]) {
    const entry = value?.connections?.[id] || {};
    connections[id] = {
      baseUrl: clean(entry.baseUrl) || (id === "deepseek" ? "https://api.deepseek.com" : ""),
      defaultModelId: clean(entry.defaultModelId),
    };
  }
  return {
    connectionId: AI_CONNECTIONS.some((item) => item.id === value?.connectionId) ? value.connectionId : "agent",
    modelMode: value?.modelMode === "pinned" ? "pinned" : "default",
    modelId: clean(value?.modelId),
    connections,
  };
}

export function resolveAiConnection(preferences) {
  const ai = normalizeAiPreferences(preferences?.ai);
  return ai.connectionId === "agent" ? preferences?.agent?.activeProviderId || "codex" : ai.connectionId;
}

export function aiConfigurationKey(preferences) {
  return JSON.stringify({ ...normalizeAiPreferences(preferences?.ai), resolvedConnection: resolveAiConnection(preferences) });
}

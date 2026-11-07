import { AI_CONNECTIONS, normalizeAiPreferences, resolveAiConnection } from "./preferences.mjs";
import { normalizeAiBaseUrl } from "./http-provider.mjs";
import { publicAiError } from "./errors.mjs";

export function installAiSettingsIpc({ ipcMain, requireSettingsMainFrame, controller, service }) {
  ipcMain.handle("ai:settings", async (event) => {
    requireSettingsMainFrame(event);
    return controller.snapshot();
  });
  ipcMain.handle("ai:update", async (event, command) => {
    requireSettingsMainFrame(event);
    return controller.update(command);
  });
  ipcMain.handle("ai:check", async (event) => {
    requireSettingsMainFrame(event);
    return controller.check();
  });
  ipcMain.handle("ai:configure", async (event, command) => {
    requireSettingsMainFrame(event);
    return controller.configure(command);
  });
}

export class AiSettingsController {
  constructor({ preferences, credentials, service, getAgentConnections, onSaved = () => {} }) {
    Object.assign(this, { preferences, credentials, service, getAgentConnections, onSaved });
    this.queue = Promise.resolve();
  }

  agentConnections() { return this.getAgentConnections?.() || {}; }

  agentAvailable(id, preferences, connections = this.agentConnections()) {
    return preferences.agent?.connections?.[id] === true && connections[id]?.state === 'connected'
      && connections[id]?.availability?.state === 'available';
  }

  async snapshot() {
    const preferences = this.preferences.get();
    const ai = normalizeAiPreferences(preferences.ai);
    const connectionId = resolveAiConnection(preferences);
    const configured = {};
    for (const id of ["deepseek", "compatible"]) {
      const credential = await this.credentials.load(`ai.${id}`);
      configured[id] = false;
      try { configured[id] = Boolean(credential?.apiKey && credential.baseUrl === normalizeAiBaseUrl(ai.connections[id]?.baseUrl)); } catch {}
    }
    const agentConnections = this.agentConnections();
    for (const id of ['codex', 'claude']) configured[id] = this.agentAvailable(id, preferences, agentConnections);
    return { preferences: ai, connections: AI_CONNECTIONS.filter(item => configured[item.id]), agentConnections,
      availableConnections: AI_CONNECTIONS, connectionId, keyConfigured: Boolean(configured[connectionId]),
      state: this.service.snapshot() };
  }

  async check() {
    const snapshot = await this.snapshot();
    if (!snapshot.connectionId || !snapshot.connections.some(item => item.id === snapshot.connectionId)) return snapshot;
    if (["deepseek", "compatible"].includes(snapshot.connectionId) && !snapshot.keyConfigured) return snapshot;
    await this.service.check();
    return this.snapshot();
  }

  async configure(command) {
    // Draft credentials remain in memory until the user picks a model and adds the service.
    try {
      if (!["deepseek", "compatible"].includes(command?.connectionId)) throw new Error("invalid connection");
      const baseUrl = normalizeAiBaseUrl(command.baseUrl);
      if (typeof command.apiKey !== "string" || !command.apiKey.trim() || command.apiKey.length > 8192 || /[\r\n]/.test(command.apiKey)) {
        return { error: "请填写有效的 API 密钥。" };
      }
      const credential = { baseUrl, apiKey: command.apiKey.trim() };
      const catalog = await this.service.inspectConnection(command.connectionId, { baseUrl }, credential);
      if (!command.save) return { catalog };
      if (!catalog.models.some(model => model.id === command.modelId)) return { error: "请选择当前服务提供的模型。" };
      const snapshot = await this.update({ preferences: { connectionId: command.connectionId, modelMode: "pinned", modelId: command.modelId,
        connections: { [command.connectionId]: { baseUrl, defaultModelId: command.modelId } } }, apiKey: credential.apiKey });
      return { snapshot };
    } catch (error) { return { error: publicAiError(error).message }; }
  }

  update(command) {
    const run = this.queue.catch(() => {}).then(async () => {
      if (!command || typeof command !== "object") throw new Error("无效的 AI 设置");
      const current = this.preferences.get();
      const next = normalizeAiPreferences({ ...current.ai, ...command.preferences,
        connections: { ...current.ai?.connections, ...command.preferences?.connections },
      });
      if (command.preferences?.connectionId && command.preferences.connectionId !== resolveAiConnection(current)) {
        if (command.preferences.modelMode === undefined) next.modelMode = "default";
        if (command.preferences.modelId === undefined) next.modelId = "";
      }
      const connectionId = resolveAiConnection({ ...current, ai: next });
      if (['codex', 'claude'].includes(command.preferences?.connectionId) && !this.agentAvailable(connectionId, current)) {
        throw new Error('请先连接智能体并通过可用性检查。');
      }
      if (["deepseek", "compatible"].includes(connectionId) && command.preferences?.modelId) {
        next.connections[connectionId].defaultModelId = next.modelId;
      }
      for (const config of Object.values(next.connections)) {
        if (config.baseUrl) config.baseUrl = normalizeAiBaseUrl(config.baseUrl);
      }
      if (command.apiKey !== undefined || command.clearKey === true) {
        if (!["deepseek", "compatible"].includes(connectionId)) throw new Error("当前连接不使用 API 密钥");
        if (command.clearKey === true) await this.credentials.clear(`ai.${connectionId}`);
        else {
          if (typeof command.apiKey !== "string" || !command.apiKey.trim() || command.apiKey.length > 8192 || /[\r\n]/.test(command.apiKey)) throw new Error("API 密钥格式无效");
          await this.credentials.save(`ai.${connectionId}`, { baseUrl: normalizeAiBaseUrl(next.connections[connectionId].baseUrl), apiKey: command.apiKey.trim() });
        }
      }
      // Only normalized, non-secret fields enter preferences.json.
      const saved = await this.preferences.update({ ai: next });
      this.service.configurationChanged();
      this.onSaved(saved);
      return this.snapshot();
    });
    this.queue = run;
    return run;
  }
}

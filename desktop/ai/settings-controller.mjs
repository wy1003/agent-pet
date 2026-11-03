import { AI_CONNECTIONS, normalizeAiPreferences, resolveAiConnection } from "./preferences.mjs";
import { normalizeAiBaseUrl } from "./http-provider.mjs";

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
    await service.check();
    return controller.snapshot();
  });
}

export class AiSettingsController {
  constructor({ preferences, credentials, service, onSaved = () => {} }) {
    Object.assign(this, { preferences, credentials, service, onSaved });
    this.queue = Promise.resolve();
  }

  async snapshot() {
    const preferences = this.preferences.get();
    const ai = normalizeAiPreferences(preferences.ai);
    const connectionId = resolveAiConnection(preferences);
    const credential = ["deepseek", "compatible"].includes(connectionId)
      ? await this.credentials.load(`ai.${connectionId}`) : null;
    let keyConfigured = false;
    try { keyConfigured = Boolean(credential?.apiKey && credential.baseUrl === normalizeAiBaseUrl(ai.connections[connectionId]?.baseUrl)); } catch {}
    return { preferences: ai, connections: AI_CONNECTIONS, connectionId, keyConfigured, state: this.service.snapshot() };
  }

  update(command) {
    const run = this.queue.catch(() => {}).then(async () => {
      if (!command || typeof command !== "object") throw new Error("无效的 AI 设置");
      const current = this.preferences.get();
      const next = normalizeAiPreferences({ ...current.ai, ...command.preferences,
        connections: { ...current.ai?.connections, ...command.preferences?.connections },
      });
      const connectionId = resolveAiConnection({ ...current, ai: next });
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

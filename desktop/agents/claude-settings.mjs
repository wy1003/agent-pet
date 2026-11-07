import { getClaudeIntegrationStatus, previewClaudeIntegration, installClaudeIntegration, removeClaudeIntegration } from "../claude/integration.mjs";
import { getClaudeRuntimeStatus } from "../claude/runtime.mjs";

export function executableResourcePath(file) {
  return file.replace(/([/\\])app\.asar([/\\])/, "$1app.asar.unpacked$2");
}

// Renderer sends only preferences or an action. All write targets come from the host.
export function installClaudeSettingsIpc({ ipcMain, requireSettingsMainFrame, getOptions, getStatusOptions = getOptions, getPreferences,
  isConnected = () => true,
  savePreferences, onSaved, confirm, lifecycleStatus = () => ({ state: 'pending' }), runtimeStatus = getClaudeRuntimeStatus,
  integration = { status: getClaudeIntegrationStatus, preview: previewClaudeIntegration,
    install: installClaudeIntegration, remove: removeClaudeIntegration } }) {
  const handle = (name, fn) => ipcMain.handle(name, async (event, value) => {
    requireSettingsMainFrame(event);
    return fn(value);
  });
  handle("claude:status", async () => ({ integration: await integration.status(await getStatusOptions()),
    lifecycle: await lifecycleStatus(),
    runtime: await runtimeStatus({ executablePath: getPreferences().claude?.executablePath || "" }),
    message: "接入安装不代表已认证；此处不发起模型请求。SDK 恢复不等于原窗口注入。" }));
  handle("claude:preview", async () => integration.preview(await getOptions()));
  handle("claude:install", async () => {
    if (!isConnected('claude')) throw new Error('请先连接 Claude Code，再安装可选增强。');
    const options = await getOptions();
    const preview = await integration.preview(options);
    if (!preview.ok) return preview;
    if (!await confirm("install", preview)) return { ok: false, cancelled: true };
    return integration.install(options);
  });
  handle("claude:remove", async () => {
    const options = await getStatusOptions();
    const status = await integration.status(options);
    if (!status.ok) return status;
    if (!await confirm("remove", status)) return { ok: false, cancelled: true };
    return integration.remove(options);
  });
  handle("claude:update", async value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("无效 Claude 设置");
    const patch = {};
    const claude = {};
    for (const key of ["executablePath", "nodePath"]) if (Object.hasOwn(value, key)) {
      if (typeof value[key] !== "string" || /[\0\r\n]/.test(value[key])) throw new TypeError("无效运行时路径");
      claude[key] = value[key];
    }
    for (const key of ["enableStatusline", "autoLifecycleHooks"]) if (Object.hasOwn(value, key)) {
      if (typeof value[key] !== "boolean") throw new TypeError("无效 Claude 开关设置");
      claude[key] = value[key];
    }
    if (Object.keys(claude).length) patch.claude = claude;
    if (Object.hasOwn(value, "defaultProviderId")) {
      if (!["codex", "claude"].includes(value.defaultProviderId)) throw new TypeError("未知任务来源");
      if (!isConnected(value.defaultProviderId)) throw new Error('请先连接所选智能体。');
      patch.remoteControl = { defaultProviderId: value.defaultProviderId };
    }
    if (Object.hasOwn(value, "usageProviderId")) {
      if (!["active", "codex", "claude"].includes(value.usageProviderId)) throw new TypeError("未知用量来源");
      patch.agent = { usageProviderId: value.usageProviderId };
    }
    const preferences = await savePreferences(patch);
    await onSaved?.(preferences, patch);
    return preferences;
  });
}

import path from "node:path";
import { CodexActivityCollector } from "../../src/collector.mjs";
import { ClaudeActivityCollector } from "../../src/claude-collector.mjs";
import { MultiAgentCollector } from "../../src/multi-agent-collector.mjs";
import { DESKTOP_COLLECTOR_IDENTITY } from "../../src/collector-service-identity.mjs";
import { AgentProviderRegistry } from "./agent-provider-registry.mjs";
import { UsageProviderRegistry } from "../usage/usage-provider-registry.mjs";
import { CodexUsageProvider } from "../usage/codex-usage-provider.mjs";
import { ClaudeUsageProvider } from "../usage/claude-usage-provider.mjs";
import { CodexTextProvider } from "../ai/codex-provider.mjs";
import { ClaudeTextProvider } from "../ai/claude-provider.mjs";
import { HttpTextProvider } from "../ai/http-provider.mjs";
import { resolveAiConnection } from "../ai/preferences.mjs";
import { resolveClaudeExecutable } from "../claude/runtime.mjs";
import { ClaudeRemoteExecutor } from "../claude/remote-executor.mjs";
import { RemoteExecutorRouter } from "./remote-executor-router.mjs";
import { writeHookEvent } from "../claude/hook-bridge.mjs";
import { aiError } from "../ai/errors.mjs";

export function createDesktopExecutor({ codex, getPreferences, eventsDir, isSessionActive, onUsage, onDiagnostic, query, resolveExecutable = resolveClaudeExecutable, isConnected, getRuntime }) {
  const execute = async (method, value) => {
    const runtime = getRuntime?.('claude');
    const executablePath = runtime?.executable || await resolveExecutable(getPreferences()?.claude?.executablePath || "");
    const claude = new ClaudeRemoteExecutor({ executablePath, query: query || runtime?.module.query, isSessionActive, onUsage, onDiagnostic,
      onEvent: event => writeHookEvent(event, { eventsDir, env: {} }),
    });
    return claude[method](value);
  };
  return new RemoteExecutorRouter({ codex, isConnected,
    claude: { start: value => execute("start", value), resume: value => execute("resume", value) },
    getDefaultProvider: () => getPreferences()?.remoteControl?.defaultProviderId || "codex",
  });
}


export const DUAL_COLLECTOR_IDENTITY = Object.freeze({ ...DESKTOP_COLLECTOR_IDENTITY,
  capabilities: Object.freeze(["tasks:codex", "tasks:claude", "tasks:claude:auto-discovery"]),
});

export function createDesktopCollectors({ codexHome, userData, claudeRoot, transcriptsDir, ignoredProjectPaths = [], connectedIds = ['codex', 'claude'] }) {
  const codex = new CodexActivityCollector({ codexHome, statePath: path.join(userData, "collector-state.json"), ignoredProjectPaths });
  const claude = new ClaudeActivityCollector({ eventsDir: path.join(claudeRoot, "events"), statePath: path.join(claudeRoot, "collector-state.json"), transcriptsDir, ignoredProjectPaths });
  return { codex, claude, collector: new MultiAgentCollector(connectedIds.map(id => ({ codex, claude })[id]).filter(Boolean)) };
}

export function createDesktopProviders({ codexHome, workingDirectory, usagePath, getPreferences, loadKey, isConnected = () => true, getRuntime }) {
  const agents = new AgentProviderRegistry({ activeProviderId: "codex" })
    .register({ id: "codex", displayName: "Codex", description: "读取 Codex 任务、会话状态与通用使用限额。", badge: "C",
      iconUrl: "/assets/agents/codex.svg", accent: "codex", taskSourceId: "codex-desktop", usageProviderId: "codex", remoteExecutorId: "codex",
      capabilities: { tasks: true, usage: true, remoteControl: true } })
    .register({ id: "claude", displayName: "Claude Code", description: "连接后发现 CLI / VS Code 会话并采集任务状态与额度。",
      badge: "CC", accent: "claude", capabilities: { tasks: true, usage: true, remoteControl: true } });
  const claudeUsage = new ClaudeUsageProvider({ usagePath });
  const usage = new UsageProviderRegistry({ isConnected }).register(new CodexUsageProvider({ codexHome })).register(claudeUsage);
  const requireConnection = id => { if (!isConnected(id)) throw aiError('agent_disconnected', `请先在“智能体与 AI”中连接 ${id === 'claude' ? 'Claude Code' : 'Codex'}。`); };
  const codexText = new CodexTextProvider({ workingDirectory,
    ...(getRuntime ? { resolveExecutable: async () => getRuntime('codex').executable } : {}) });
  const text = new Map([
    ["codex", { open: (config, options) => { requireConnection('codex'); return codexText.open(config, options); } }],
    // Resolve at open time, so changing a runtime path never leaves a stale provider.
    ["claude", { open: async (config, options) => {
      requireConnection('claude');
      const runtime = getRuntime?.('claude');
      const executablePath = runtime?.executable || await resolveClaudeExecutable(getPreferences?.()?.claude?.executablePath || "");
      return new ClaudeTextProvider({ workingDirectory, executablePath, query: runtime?.module.query }).open(config, options);
    } }],
    ...["deepseek", "compatible"].map(id => [id, new HttpTextProvider({ id, name: id === "deepseek" ? "DeepSeek" : "兼容接口", loadKey })]),
  ]);
  return { agents, usage, claudeUsage, text };
}

export function claudeSessionActivity({ owned, claude }, sessionId) {
  // An unstarted local collector is not evidence about a reused external service.
  return owned && claude ? claude.isSessionActive(sessionId.startsWith("claude:") ? sessionId : `claude:${sessionId}`) : null;
}

export function agentSelectionPatch(preferences, providerId) {
  return { agent: { activeProviderId: providerId },
    ...(preferences.ai?.connectionId === "agent" ? { ai: { ...preferences.ai, connectionId: resolveAiConnection(preferences) } } : {}),
  };
}

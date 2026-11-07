import electron from "electron";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { normalizePreferences, PreferenceStore } from "../desktop/preferences.mjs";
import { RemoteTaskRegistry } from "../desktop/remote-task-registry.mjs";
import { NotebookMcpBridge } from "../desktop/notebook/mcp/bridge-service.mjs";
import { productUserDataPath } from "../desktop/app-paths.mjs";
import { AiTextService } from "../desktop/ai/text-service.mjs";
import { AppUpdater } from "../desktop/app-updater.mjs";
import { CodexUsageProvider } from "../desktop/usage/codex-usage-provider.mjs";
import { PhrasePoolGenerator } from "../desktop/phrase-generator.mjs";
import { ClaudeTranscriptDiscovery } from "../src/claude-discovery.mjs";
import { NotebookCodexConnection } from "../desktop/notebook/mcp/codex-connection.mjs";

// Test driver only: observe native windows while exercising the real entrypoint,
// renderer, preload, Facades and IPC. Never use these hooks in production.
const { app, BrowserWindow, dialog, protocol, session } = electron;
const root = process.argv[2], output = process.argv[3];
if (!root || !output || !path.isAbsolute(root) || !fs.existsSync(path.join(root, ".smoke-fixture"))) throw new Error("An explicit isolated fixture is required");
const inside = value => {
  const relative = path.relative(root, value);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};
for (const key of ["appData", "userData", "sessionData", "temp"]) {
  const target = path.join(root, key);
  fs.mkdirSync(target, { recursive: true });
  app.setPath(key, target);
}
app.setAppLogsPath(path.join(root, "logs"));
const userData = productUserDataPath(app.getPath("appData"));
fs.mkdirSync(userData, { recursive: true });
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
const settingsFile = path.join(process.env.CLAUDE_CONFIG_DIR, "settings.json");
const initialClaude = { permissions: { deny: ["Bash"] }, language: "中文", model: "fixture-model",
  statusLine: { type: "command", command: `'${path.join(root, "fixture-statusline-never-executed.exe").replaceAll("\\", "/")}'` },
  hooks: { Stop: [{ hooks: [{ type: "command", command: "fixture-user-hook-never-executed" }] }] } };
const mcpFile = path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json");
const initialMcp = { mcpServers: { existing: { command: "fixture-mcp-never-executed" } } };
fs.writeFileSync(settingsFile, JSON.stringify(initialClaude));
fs.writeFileSync(mcpFile, JSON.stringify(initialMcp));
const readClaude = () => JSON.parse(fs.readFileSync(settingsFile, "utf8"));
const readMcp = () => JSON.parse(fs.readFileSync(mcpFile, "utf8"));
const lifecycleEvents = ["SessionStart", "UserPromptSubmit", "Stop", "StopFailure", "SessionEnd"];
const lifecycleHooks = settings => Object.fromEntries(lifecycleEvents.map(name => [name,
  (settings.hooks?.[name] || []).flatMap(group => group.hooks).filter(hook => JSON.stringify(hook).includes("agent-pet:lifecycle:v1"))]));
const assertLifecycle = settings => {
  for (const [name, hooks] of Object.entries(lifecycleHooks(settings))) assert.equal(hooks.length, 1, `${name}: exactly one automatic Hook`);
  assert.deepEqual(settings.permissions, initialClaude.permissions);
  assert.equal(settings.model, initialClaude.model);
  assert.equal(settings.language, initialClaude.language);
  assert.ok(settings.hooks.Stop.some(group => JSON.stringify(group) === JSON.stringify(initialClaude.hooks.Stop[0])));
};
fs.writeFileSync(path.join(userData, "preferences.json"), JSON.stringify(normalizePreferences({
  appearance: { alwaysOnTop: false, theme: "light" },
  notifications: { windows: { enabled: false }, voice: { enabled: false }, mobile: { enabled: false } },
  remoteControl: { enabled: false },
})));
const checks = [], blockedNetwork = [], dialogs = [], rendererErrors = [], discoveredEvents = [];
const scanTranscripts = ClaudeTranscriptDiscovery.prototype.scan;
ClaudeTranscriptDiscovery.prototype.scan = async function (...args) {
  const result = await scanTranscripts.apply(this, args);
  discoveredEvents.push(...result.events);
  return result;
};
for (const [type, method] of [[RemoteTaskRegistry, "load"], [NotebookMcpBridge, "start"], [PreferenceStore, "load"]]) {
  const original = type.prototype[method];
  type.prototype[method] = async function (...args) {
    checks.push(`startup:${type.name}.${method}:begin`);
    const result = await original.apply(this, args);
    checks.push(`startup:${type.name}.${method}:end`);
    return result;
  };
}
// Only the Codex configuration RPC is simulated; exercise its real connection facade,
// backups, UI and IPC without starting a real Codex process or accessing user config.
const codexConfigFile = path.join(root, "codex", "notebook-fixture.toml");
fs.writeFileSync(codexConfigFile, "# isolated Codex configuration fixture\n");
const codexConfig = { mcp_servers: { existing: { command: "fixture-codex-mcp-never-executed" } } };
let codexConfigVersion = 1, codexConfigWrites = 0;
const createCodexConfigRpc = () => ({
  async initialize() {}, close() {},
  async request(method, params) {
    if (method === "config/read") return {
      config: structuredClone(codexConfig),
      layers: [{ name: { type: "user", file: codexConfigFile }, version: String(codexConfigVersion) }],
    };
    assert.equal(method, "config/batchWrite");
    assert.equal(params.filePath, codexConfigFile);
    assert.equal(params.expectedVersion, String(codexConfigVersion));
    const entry = codexConfig.mcp_servers["agent-pet-notebook"] ||= {};
    for (const edit of params.edits) {
      assert.ok(edit.keyPath.startsWith("mcp_servers.agent-pet-notebook."));
      const key = edit.keyPath.slice("mcp_servers.agent-pet-notebook.".length);
      if (key === "env.ELECTRON_RUN_AS_NODE") entry.env = { ELECTRON_RUN_AS_NODE: edit.value };
      else entry[key] = edit.value;
    }
    codexConfigVersion++; codexConfigWrites++;
    fs.writeFileSync(codexConfigFile, JSON.stringify(codexConfig));
    return { status: "ok" };
  },
});
for (const method of ["status", "connect"]) {
  const original = NotebookCodexConnection.prototype[method];
  NotebookCodexConnection.prototype[method] = function (...args) {
    this.resolveExecutable = async () => path.join(root, "fixture-codex-never-executed.exe");
    this.createRpc = createCodexConfigRpc;
    return original.apply(this, args);
  };
}

let allowConfirmation = false, generationAttempts = 0;
app.setLoginItemSettings = () => { checks.push("login-item changes intercepted"); };
app.getLoginItemSettings = () => ({ openAtLogin: false, wasOpenedAtLogin: false });
AppUpdater.prototype.start = function () {};
// Startup phrase warmup is outside the UI/discovery contract and can call a model.
PhrasePoolGenerator.prototype.schedule = function () {};
AiTextService.prototype.check = async function () { return this.snapshot(); };
AiTextService.prototype.generateJson = async function () { generationAttempts++; throw new Error("Real model calls are disabled in UI smoke"); };
CodexUsageProvider.prototype.getUsage = async () => ({ providerId: "codex", viewType: "unavailable", status: "unavailable", windows: [], message: "隔离测试：未查询账户" });
dialog.showMessageBox = async options => {
  dialogs.push({ title: options.title, message: options.message });
  return { response: allowConfirmation ? 1 : 0, checkboxChecked: false };
};

// Reserve protocol privileges before asynchronous imports can let Electron ready.
protocol.registerSchemesAsPrivileged([{ scheme: "pet-asset", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
protocol.registerSchemesAsPrivileged = entries => { assert.deepEqual(entries.map(entry => entry.scheme), ["pet-asset"]); };
const ports = new Set();
const createServer = http.createServer;
http.createServer = function (...args) {
  const server = createServer.apply(this, args), listen = server.listen;
  server.listen = function (...listenArgs) {
    if (typeof listenArgs[0] === "number") listenArgs[0] = 0;
    server.once("listening", () => { ports.add(server.address().port); });
    return listen.apply(this, listenArgs);
  };
  return server;
};
syncBuiltinESMExports();
const fetch = globalThis.fetch;
globalThis.fetch = async (input, ...args) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.hostname === "127.0.0.1" && ports.has(Number(url.port))) return fetch(input, ...args);
  blockedNetwork.push(url.origin);
  return new Response("Isolated test: external service disabled", { status: 503 });
};
app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    const allowed = ["file:", "data:", "pet-asset:"].includes(url.protocol)
      || (url.hostname === "127.0.0.1" && ports.has(Number(url.port)));
    if (!allowed) blockedNetwork.push(url.origin);
    callback({ cancel: !allowed });
  });
});
app.on("browser-window-created", (_event, window) => {
  window.webContents.on("console-message", (_event, level, message) => { if (level >= 3) rendererErrors.push(message); });
});
const until = async (read, accept, label, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${label}`);
};
const evaluate = (window, code) => window.webContents.executeJavaScript(code, true);
const control = (window, key, value) => evaluate(window, `(() => { const e=document.querySelector('[data-claude-setting="${key}"]'); if(!e)throw Error('missing control'); if(e.type==='checkbox')e.checked=${JSON.stringify(value)};else e.value=${JSON.stringify(value)}; e.dispatchEvent(new Event('change',{bubbles:true})); })()`);
const state = window => evaluate(window, "window.companion.getSettings()");
const click = (window, selector) => evaluate(window, `document.querySelector(${JSON.stringify(selector)}).click()`);
async function runHook(hook, event) {
  assert.equal(hook?.type, "command");
  assert.ok(path.isAbsolute(hook.command));
  assert.ok(Array.isArray(hook.args), "Installed hooks use the official exec form");
  const child = spawn(hook.command, hook.args, { env: { ...process.env, AGENT_PET_AUXILIARY: "0" }, shell: false, windowsHide: true, stdio: "pipe" });
  let errors = "", timedOut = false;
  child.stdout.resume(); child.stderr.on("data", data => { errors += data; }); child.stdin.on("error", () => {});
  const timer = setTimeout(() => {
    timedOut = true;
    if (child.exitCode === null) spawnSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 5000 });
  }, 10000);
  try {
    const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    child.stdin.end(JSON.stringify(event));
    assert.equal(await closed, 0, errors);
    assert.equal(timedOut, false);
  } finally { clearTimeout(timer); }
}

async function runChecks() {
try {
  await import("../desktop/main.mjs");
  const pet = await until(async () => {
    const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith("/companion-badge.html"));
    return window && !window.webContents.isLoading() ? window : null;
  }, Boolean, "pet renderer");
  assert.ok(inside(app.getPath("userData")));
  const base = new URL(pet.webContents.getURL()).origin;
  assert.notEqual(new URL(base).port, "43123");
  await evaluate(pet, "window.companion.openSettings()");
  const settings = await until(async () => {
    const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes("settings.html"));
    return window && !window.webContents.isLoading() ? window : null;
  }, Boolean, "settings renderer");
  await until(() => state(settings), value => value.agentProviders?.providers?.length === 2, "provider list");
  settings.setTitle("Agent Pet · 隔离界面测试");
  await click(settings, '[data-page="ai"]');
  const before = await state(settings);
  const sourceCards = await evaluate(settings, `Array.from(document.querySelectorAll('.agent-provider-card')).map(card => ({
    text: card.textContent, selectable: card.matches('button,[role="button"],[aria-pressed]')
  }))`);
  assert.equal(sourceCards.length, 2);
  assert.ok(sourceCards.every(card => !card.selectable));
  assert.ok(sourceCards.some(card => card.text.includes("Codex")));
  assert.ok(sourceCards.some(card => card.text.includes("Claude")));
  assert.equal(await evaluate(settings, '!!document.querySelector(\'[data-claude-setting="usageProviderId"]\')'), false);
  const allUsage = await evaluate(settings, "window.companion.getAllUsage()");
  assert.deepEqual(allUsage.providers.map(provider => provider.providerId), ["codex", "claude"]);
  assert.equal((await state(settings)).preferences.ai.connectionId, before.preferences.ai.connectionId);
  await control(settings, "defaultProviderId", "claude");
  await until(() => state(settings), value => value.preferences.remoteControl.defaultProviderId === "claude", "default executor independent of collection");
  assert.equal(before.preferences.claude.nodePath, "", "No manually configured Node executable");
  assert.equal(before.preferences.claude.autoLifecycleHooks, true);
  assert.equal(await evaluate(settings, 'document.querySelector(\'[data-claude-setting="autoLifecycleHooks"]\').checked'), true);
  const automaticConfig = await until(readClaude, value => Object.values(lifecycleHooks(value)).every(hooks => hooks.length === 1), "startup automatically installs all five lifecycle Hooks");
  assertLifecycle(automaticConfig);
  assert.deepEqual(automaticConfig.statusLine, initialClaude.statusLine);
  assert.deepEqual(readMcp(), initialMcp);
  checks.push("startup installs five automatic Hooks with blank Node preference; permissions/model/statusLine/MCP and user Hooks unchanged");

  const timestamp = new Date().toISOString();
  const transcript = path.join(process.env.CLAUDE_CONFIG_DIR, "projects", "ui-project", "auto-ui.jsonl");
  const automaticCommand = name => lifecycleHooks(automaticConfig)[name][0];
  const automaticEvent = { session_id: "auto-ui", cwd: root, transcript_path: transcript, permission_mode: "default" };
  await runHook(automaticCommand("UserPromptSubmit"), { ...automaticEvent, hook_event_name: "UserPromptSubmit", prompt: "Claude 自动生命周期任务" });
  await fsp.mkdir(path.dirname(transcript), { recursive: true });
  await fsp.writeFile(transcript, [
    { type: "user", uuid: "auto-user", sessionId: "auto-ui", timestamp, cwd: root, message: { role: "user", content: "Claude 自动生命周期任务" } },
    { type: "attachment", uuid: "auto-attachment", parentUuid: "auto-user", sessionId: "auto-ui", timestamp, attachment: { type: "fixture" } },
    { type: "progress", uuid: "auto-progress", parentUuid: "auto-attachment", sessionId: "auto-ui", timestamp, data: { type: "hook_progress" } },
    { type: "assistant", uuid: "auto-thinking", parentUuid: "auto-progress", sessionId: "auto-ui", timestamp, message: { role: "assistant", content: [{ type: "thinking", thinking: "isolated fixture" }] } },
  ].map(row => JSON.stringify(row) + "\n").join(""));
  await until(async () => (await globalThis.fetch(`${base}/api/v1/tasks`)).json(), value =>
    value.tasks?.some(task => task.sessionId === "claude:auto-ui" && task.status === "running"), "live thinking task before an answer exists");
  await until(() => evaluate(pet, "document.querySelector('#badge').dataset.state"), value => value === "running", "pet reacts to Claude thinking through real SSE and renderer");
  await evaluate(pet, "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  await fsp.writeFile(path.join(output, "pet-thinking.png"), (await pet.webContents.capturePage()).toPNG());
  checks.push("attachment/progress records without message do not block discovery; pet visibly enters running before completion");
  await fsp.appendFile(transcript, JSON.stringify({ type: "assistant", uuid: "auto-answer", parentUuid: "auto-thinking", sessionId: "auto-ui", timestamp,
    message: { role: "assistant", content: [{ type: "text", text: "本地模拟完成" }] } }) + "\n");
  await until(() => discoveredEvents, events => events.some(event => event.hook_event_name === "TranscriptResponse"
    && event.last_assistant_message === "本地模拟完成"), "real-shape assistant text discovered without stop_reason");
  const beforeStop = (await (await globalThis.fetch(`${base}/api/v1/tasks`)).json()).tasks.filter(task => task.sessionId === "claude:auto-ui");
  assert.equal(beforeStop.length, 1, "Hook and transcript represent a single turn without prompt_id");
  assert.notEqual(beforeStop[0].status, "completed", "Assistant text without stop_reason cannot complete the turn");
  await runHook(automaticCommand("Stop"), { ...automaticEvent, hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "本地模拟完成" });
  const completed = await until(async () => (await globalThis.fetch(`${base}/api/v1/tasks`)).json(), value =>
    value.tasks?.some(task => task.sessionId === "claude:auto-ui" && task.status === "completed"), "Stop completes the automatic lifecycle task");
  const completedTurn = completed.tasks.filter(task => task.sessionId === "claude:auto-ui");
  assert.equal(completedTurn.length, 1);
  assert.equal(completedTurn[0].latestResponse, "本地模拟完成");
  checks.push("actual startup-installed command+args handles no-prompt_id submit + JSONL attachment/text without stop_reason; only Stop completes one correctly merged task");
  await fsp.mkdir(path.join(process.env.CODEX_HOME, "sessions"), { recursive: true });
  await fsp.writeFile(path.join(process.env.CODEX_HOME, "sessions", "rollout-auto-ui.jsonl"), [
    { type: "session_meta", timestamp, payload: { id: "codex-auto-ui", cwd: root, thread_source: "user" } },
    { type: "event_msg", timestamp, payload: { type: "task_started", turn_id: "turn1" } },
    { type: "event_msg", timestamp, payload: { type: "item_completed", turn_id: "turn1", thread_id: "codex-auto-ui", item: { type: "UserMessage", id: "codex-user", content: [{ type: "text", text: "Codex 同时自动发现" }] } } },
    { type: "event_msg", timestamp, payload: { type: "task_complete", turn_id: "turn1" } },
  ].map(row => JSON.stringify(row) + "\n").join(""));
  await until(async () => (await globalThis.fetch(`${base}/api/v1/tasks`)).json(), value =>
    value.tasks?.some(task => task.sessionId === "claude:auto-ui" && task.status === "completed")
    && value.tasks.some(task => task.question === "Codex 同时自动发现" && task.status === "completed"), "both automatically collected sources");
  assert.deepEqual(readClaude(), automaticConfig);
  checks.push("Codex and Claude collect simultaneously with automatic lifecycle Hooks");
  await evaluate(settings, "document.querySelector('.claude-advanced').open = true");
  await control(settings, "enableStatusline", true);
  await until(() => state(settings), value => value.preferences.claude.enableStatusline === true, "optional statusline preference saved without changing config");
  assert.deepEqual(readClaude(), automaticConfig);

  await evaluate(settings, "window.companion.installClaudeIntegration()");
  assert.deepEqual(readClaude(), automaticConfig);
  assert.deepEqual(readMcp(), initialMcp);
  allowConfirmation = true;
  const installed = await evaluate(settings, "window.companion.installClaudeIntegration()");
  assert.equal(installed.ok, true, JSON.stringify(installed));
  const configured = readClaude();
  assertLifecycle(configured);
  for (const name of lifecycleEvents) assert.deepEqual(configured.hooks[name], automaticConfig.hooks[name], "Optional integration must not duplicate lifecycle Hooks");
  for (const name of ["PermissionRequest", "Notification", "PostToolUse"]) {
    assert.equal(configured.hooks[name].flatMap(group => group.hooks).filter(hook => JSON.stringify(hook).includes("agent-pet:hook:v1")).length, 1);
  }
  assert.deepEqual(readMcp().mcpServers.existing, initialMcp.mcpServers.existing);
  assert.ok(readMcp().mcpServers["agent-pet-notebook"]);
  assert.equal(readMcp().mcpServers["agent-pet"], undefined);
  assert.match(JSON.stringify(configured.statusLine), /agent-pet:statusline:v1/);
  checks.push("optional enhancement cancellation preserves config; installation adds MCP and three optional event Hooks without duplicating five automatic Hooks");

  await click(settings, "#claude-refresh");
  await until(() => evaluate(settings, "document.querySelector('#claude-status').textContent"), text => text.includes("已安装"), "integration status");
  await fsp.writeFile(path.join(output, "settings-light.png"), (await settings.webContents.capturePage()).toPNG());
  await evaluate(settings, "document.querySelector('#claude-status').scrollIntoView({block:'center'})");
  await fsp.writeFile(path.join(output, "settings-detail-light.png"), (await settings.webContents.capturePage()).toPNG());
  await evaluate(settings, "window.companion.updateSettings({appearance:{theme:'dark'}})");
  await until(() => evaluate(settings, "matchMedia('(prefers-color-scheme: dark)').matches"), Boolean, "dark theme");
  await until(() => evaluate(settings, `(() => {
    const card = document.querySelector('.agent-provider-card');
    const probe = document.createElement('div');
    probe.style.backgroundColor = getComputedStyle(document.documentElement).getPropertyValue('--card');
    return { actual: getComputedStyle(card).backgroundColor, expected: probe.style.backgroundColor };
  })()`), colors => colors.actual === colors.expected, "provider card theme transition");
  await fsp.writeFile(path.join(output, "settings-dark.png"), (await settings.webContents.capturePage()).toPNG());
  await evaluate(settings, "document.querySelector('.claude-advanced').open = false; document.querySelector('.agent-provider-card').scrollIntoView({block:'start'})");
  await fsp.writeFile(path.join(output, "sources-dark.png"), (await settings.webContents.capturePage()).toPNG());
  await evaluate(settings, "window.companion.updateSettings({appearance:{showUsageCard:true}})");
  await evaluate(pet, "window.companion.togglePanel()");
  const usageWindow = await until(async () => {
    const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes("usage-card.html"));
    return window && !window.webContents.isLoading() && window.isVisible() ? window : null;
  }, Boolean, "dual usage window");
  await until(() => evaluate(usageWindow, "document.body.innerText"), text => text.includes("Codex") && text.includes("Claude"), "both usage providers rendered");
  assert.doesNotMatch(await evaluate(usageWindow, "document.body.innerText"), /已同步/, "missing quota is not a successful sync");
  await fsp.writeFile(path.join(output, "usage-dark.png"), (await usageWindow.webContents.capturePage()).toPNG());
  checks.push("both usage sources rendered in the real usage window");
  await evaluate(pet, "window.companion.showBadgeMenu()");
  const menu = await until(async () => {
    const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes("pet-menu.html"));
    return window && !window.webContents.isLoading() && window.isVisible() ? window : null;
  }, Boolean, "pet menu");
  await click(menu, '[data-action="tasks"]');
  const taskWindow = await until(async () => {
    const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes("?companion=1"));
    return window && !window.webContents.isLoading() && window.isVisible() ? window : null;
  }, Boolean, "task window");
  await until(() => evaluate(taskWindow, "document.body.innerText"), text => text.includes("Claude 自动生命周期任务") && text.includes("Codex 同时自动发现"), "both automatically discovered tasks rendered");
  await evaluate(taskWindow, `Array.from(document.querySelectorAll('*')).find(e => !e.childElementCount && e.textContent === 'Claude 自动生命周期任务')?.scrollIntoView({block:'end'})`);
  await fsp.writeFile(path.join(output, "tasks-dark.png"), (await taskWindow.webContents.capturePage()).toPNG());
  checks.push("native theme switching and real menu action open the populated task window");
  const removed = await evaluate(settings, "window.companion.removeClaudeIntegration()");
  assert.equal(removed.ok, true, JSON.stringify(removed));
  assert.deepEqual(readClaude(), automaticConfig);
  assert.deepEqual(readMcp(), initialMcp);
  checks.push("removing optional enhancement retains automatic Hooks and restores original statusLine/MCP");
  await control(settings, "autoLifecycleHooks", false);
  await until(() => state(settings), value => value.preferences.claude.autoLifecycleHooks === false, "automatic Hook preference disabled");
  await until(readClaude, value => Object.values(lifecycleHooks(value)).every(hooks => !hooks.length), "automatic Hooks removed");
  assert.deepEqual(readClaude(), initialClaude);
  assert.equal(JSON.parse(fs.readFileSync(path.join(userData, "preferences.json"), "utf8")).claude.autoLifecycleHooks, false);
  await control(settings, "autoLifecycleHooks", true);
  await until(readClaude, value => Object.values(lifecycleHooks(value)).every(hooks => hooks.length === 1), "automatic Hooks restored");
  assert.deepEqual(readClaude(), automaticConfig);
  assert.equal(JSON.parse(fs.readFileSync(path.join(userData, "preferences.json"), "utf8")).claude.autoLifecycleHooks, true);
  assert.equal((await state(settings)).preferences.claude.nodePath, "");

  await click(settings, '[data-page="notebook"]');
  assert.ok(await evaluate(settings, "Boolean(document.querySelector('#connect-notebook-codex') && document.querySelector('#connect-notebook-claude'))"));
  await evaluate(settings, "document.querySelector('#connect-notebook-claude').scrollIntoView({block:'center'})");
  const beforeNotebookSettings = fs.readFileSync(settingsFile, "utf8");
  allowConfirmation = false;
  const dialogCount = dialogs.length;
  const buttonStyles = await evaluate(settings, `['codex', 'claude'].map(provider => {
    const button = document.querySelector('#connect-notebook-' + provider);
    const style = getComputedStyle(button);
    return { className: button.className, whiteSpace: style.whiteSpace,
      fontSize: style.fontSize, borderRadius: style.borderRadius, padding: style.padding };
  })`);
  assert.deepEqual(buttonStyles[1], buttonStyles[0], "notebook connection buttons use the same visual rules");
  await click(settings, "#connect-notebook-claude");
  await until(() => evaluate(settings, "document.querySelector('#connect-notebook-claude').disabled"), disabled => !disabled, "Claude direct connection settled");
  assert.equal(dialogs.length, dialogCount, "Claude notebook connection must not show an extra dialog");
  await until(() => evaluate(settings, "window.companion.getNotebookClaudeConnection()"), result => result.ok && result.configured, "Claude notebook configuration ready");
  await until(() => evaluate(settings, "document.querySelector('#connect-notebook-claude').disabled"), disabled => !disabled, "Claude notebook button reset");
  assert.equal(fs.readFileSync(settingsFile, "utf8"), beforeNotebookSettings);
  assert.deepEqual(readMcp().mcpServers.existing, initialMcp.mcpServers.existing);
  assert.deepEqual(Object.keys(readMcp().mcpServers).sort(), ["agent-pet-notebook", "existing"]);
  assert.match(await evaluate(settings, "document.querySelector('#notebook-claude-mcp-status').textContent"), /配置已完成/);
  const notebookMcp = fs.readFileSync(mcpFile, "utf8");
  const notebookMcpStat = fs.statSync(mcpFile).mtimeMs;
  await click(settings, "#connect-notebook-claude");
  await until(() => evaluate(settings, "document.querySelector('#connect-notebook-claude').disabled"), disabled => !disabled, "Claude notebook repeat settled");
  assert.equal(fs.readFileSync(mcpFile, "utf8"), notebookMcp);
  assert.equal(fs.statSync(mcpFile).mtimeMs, notebookMcpStat);
  assert.match(await evaluate(settings, "document.querySelector('#notebook-claude-mcp-status').textContent"), /无需重复添加/);
  await click(settings, "#connect-notebook-codex");
  await until(() => evaluate(settings, "window.companion.getNotebookCodexConnection()"), result => result.ok && result.configured, "Codex notebook configuration ready");
  await until(() => evaluate(settings, "document.querySelector('#connect-notebook-codex').disabled"), disabled => !disabled, "Codex notebook button reset");
  assert.equal(codexConfigWrites, 1);
  assert.deepEqual(codexConfig.mcp_servers.existing, { command: "fixture-codex-mcp-never-executed" });
  assert.equal(fs.readFileSync(mcpFile, "utf8"), notebookMcp);
  await click(settings, "#connect-notebook-codex");
  await until(() => evaluate(settings, "document.querySelector('#connect-notebook-codex').disabled"), disabled => !disabled, "Codex notebook repeat settled");
  assert.equal(codexConfigWrites, 1);
  assert.match(await evaluate(settings, "document.querySelector('#notebook-claude-mcp-status').textContent"), /无需重复添加/);
  const configuredButtonWidths = await evaluate(settings, `['codex', 'claude'].map(provider =>
    document.querySelector('#connect-notebook-' + provider).getBoundingClientRect().width)`);
  assert.ok(Math.abs(configuredButtonWidths[0] - configuredButtonWidths[1]) < 1, "configured notebook buttons have equal visual width");
  await fsp.writeFile(path.join(output, "notebook-connections-dark.png"), (await settings.webContents.capturePage()).toPNG());
  await evaluate(settings, "window.companion.updateSettings({appearance:{theme:'light'}})");
  await until(() => evaluate(settings, "matchMedia('(prefers-color-scheme: dark)').matches"), dark => !dark, "notebook light theme");
  await fsp.writeFile(path.join(output, "notebook-connections-light.png"), (await settings.webContents.capturePage()).toPNG());
  assert.equal(dialogs.length, dialogCount, "both notebook buttons configure directly without dialogs");
  allowConfirmation = true;
  const fullAfterNotebook = await evaluate(settings, "window.companion.installClaudeIntegration()");
  assert.equal(fullAfterNotebook.ok, true, JSON.stringify(fullAfterNotebook));
  const removeFullAfterNotebook = await evaluate(settings, "window.companion.removeClaudeIntegration()");
  assert.equal(removeFullAfterNotebook.ok, true, JSON.stringify(removeFullAfterNotebook));
  assert.equal((await evaluate(settings, "window.companion.getNotebookClaudeConnection()")).configured, true);
  assert.deepEqual(readMcp(), JSON.parse(notebookMcp));
  assert.deepEqual(readClaude(), JSON.parse(beforeNotebookSettings));
  // Reproduce the already-delivered 0.12.0 notebook-only format in this isolated profile.
  const notebookManifestFile = path.join(process.env.CLAUDE_CONFIG_DIR, "agent-pet-notebook.json");
  const legacyManifest = JSON.parse(fs.readFileSync(notebookManifestFile, "utf8"));
  delete legacyManifest.mcpName;
  const legacyMcp = readMcp();
  legacyMcp.mcpServers["agent-pet"] = legacyMcp.mcpServers["agent-pet-notebook"];
  delete legacyMcp.mcpServers["agent-pet-notebook"];
  await fsp.writeFile(notebookManifestFile, JSON.stringify(legacyManifest));
  await fsp.writeFile(mcpFile, JSON.stringify(legacyMcp));
  const legacyMcpBytes = fs.readFileSync(mcpFile, "utf8");
  const legacyManifestBytes = fs.readFileSync(notebookManifestFile, "utf8");
  await evaluate(settings, "window.companion.getNotebookClaudeConnection()");
  assert.equal(fs.readFileSync(mcpFile, "utf8"), legacyMcpBytes, "status must not migrate old configuration");
  assert.equal(fs.readFileSync(notebookManifestFile, "utf8"), legacyManifestBytes);
  const beforeMigrationDialogs = dialogs.length;
  await click(settings, "#connect-notebook-claude");
  await until(() => evaluate(settings, "document.querySelector('#connect-notebook-claude').disabled"), disabled => !disabled, "legacy notebook migration settled");
  assert.equal(dialogs.length, beforeMigrationDialogs);
  assert.deepEqual(readMcp(), JSON.parse(notebookMcp), "explicit connection migrates the owned legacy name without duplicates");
  assert.equal(JSON.parse(fs.readFileSync(notebookManifestFile, "utf8")).mcpName, "agent-pet-notebook");
  assert.deepEqual(readClaude(), JSON.parse(beforeNotebookSettings));
  const missingManagedMcp = readMcp();
  delete missingManagedMcp.mcpServers["agent-pet-notebook"];
  await fsp.writeFile(mcpFile, JSON.stringify(missingManagedMcp));
  const beforeMissingStatus = fs.readFileSync(mcpFile, "utf8");
  const missingStatus = await evaluate(settings, "window.companion.getNotebookClaudeConnection()");
  assert.equal(missingStatus.configured, false);
  assert.equal(fs.readFileSync(mcpFile, "utf8"), beforeMissingStatus, "status must not restore a missing managed MCP");
  const beforeRestoreDialogs = dialogs.length;
  await click(settings, "#connect-notebook-claude");
  await until(() => evaluate(settings, "document.querySelector('#connect-notebook-claude').disabled"), disabled => !disabled, "missing managed notebook restoration settled");
  assert.equal(dialogs.length, beforeRestoreDialogs);
  assert.deepEqual(readMcp(), JSON.parse(notebookMcp), "explicit connection restores the missing managed MCP");
  assert.match(await evaluate(settings, "document.querySelector('#notebook-claude-mcp-status').textContent"), /配置已完成/);
  checks.push("Notebook settings: matching Codex/Claude button styles and direct no-dialog flow, canonical agent-pet-notebook name, changed/repeat feedback, MCP-only writes, duplicate no-op, source coexistence, full integration removal preserves notebook, legacy owned name migrates only on click, missing managed MCP restores only on click; Codex config RPC fixture only");
  assert.equal(generationAttempts, 0);
  checks.push("GUI toggle removes only owned lifecycle Hooks, persists disabled/enabled preference, restores Hooks with Node still blank; zero model generation attempts");
  await fsp.writeFile(path.join(output, "report.json"), JSON.stringify({ ok: true, checks, dialogs, rendererErrors, blockedNetwork: [...new Set(blockedNetwork)],
    boundaries: ["real source Electron UI", "temporary userData and Claude config", "confirmation dialogs simulated", "no real model or Weixin", "not an installer/real-client acceptance"] }, null, 2));
} catch (error) {
  process.exitCode = 1;
  await fsp.writeFile(path.join(output, "report.json"), JSON.stringify({ ok: false, error: error.stack, checks, dialogs, rendererErrors,
    windows: BrowserWindow.getAllWindows().map(window => window.webContents.getURL()), ports: [...ports],
    files: await fsp.readdir(root, { recursive: true }), blockedNetwork: [...new Set(blockedNetwork)] }, null, 2));
} finally {
  app.quit();
}
}
// Finish Electron's entry-module evaluation before waiting for native startup I/O.
void runChecks();

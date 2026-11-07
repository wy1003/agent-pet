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
import { AgentRuntimeInstallation } from "../desktop/agents/runtime-installation.mjs";

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
const runtimePreparations = [];
// Exercise real connection IPC and consumers, with component transfer simulated.
// Archive integrity, extraction and real SDK imports are verified separately.
AgentRuntimeInstallation.prototype.inspect = async function (id) { return this.ready.has(id) ? 'ready' : 'missing'; };
AgentRuntimeInstallation.prototype.prepare = async function (id, options) {
  runtimePreparations.push({ id, allowDownload: options.allowDownload });
  options.onProgress({ phase: 'downloading', received: 1024, total: 2048 });
  await new Promise(resolve => setTimeout(resolve, 80));
  options.signal.throwIfAborted();
  const value = { executable: path.join(root, `fixture-${id}-never-executed.exe`),
    module: { query() { throw new Error('No real model calls'); }, Codex: class {} } };
  this.ready.set(id, value);
  return value;
};
app.setLoginItemSettings = () => { checks.push("login-item changes intercepted"); };
app.getLoginItemSettings = () => ({ openAtLogin: false, wasOpenedAtLogin: false });
AppUpdater.prototype.start = function () {};
// Startup phrase warmup is outside the UI/discovery contract and can call a model.
PhrasePoolGenerator.prototype.schedule = function () {};
let aiCheckPreview = null;
let aiCatalogChecks = 0;
let claudeUnavailable = true;
AiTextService.prototype.inspectConnection = async function (id) {
  aiCatalogChecks++;
  if (['codex', 'claude'].includes(id)) {
    await new Promise(resolve => setTimeout(resolve, 180));
    if (id === 'claude' && claudeUnavailable) throw new Error('401 Unauthorized fixture');
    return { models: [{ id: 'fixture-model' }], defaultModelId: 'fixture-model' };
  }
  return structuredClone(aiCheckPreview);
};
AiTextService.prototype.check = async function () {
  aiCatalogChecks++;
  if (aiCheckPreview) { this.state = structuredClone(aiCheckPreview); this.onStatus(this.snapshot()); }
  return this.snapshot();
};
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
const control = (window, key, value) => evaluate(window, `(() => { const e=document.querySelector('[data-${key === 'defaultProviderId' ? 'agent' : 'claude'}-setting="${key}"]'); if(!e)throw Error('missing control'); if(e.type==='checkbox')e.checked=${JSON.stringify(value)};else e.value=${JSON.stringify(value)}; e.dispatchEvent(new Event('change',{bubbles:true})); })()`);
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
  assert.equal(await evaluate(settings, 'document.querySelector("#ai [data-claude-setting]")'), null, 'overview contains no provider-specific controls');
  await click(settings, '[data-provider-settings="codex"]');
  assert.equal(await evaluate(settings, 'document.querySelector("#agent-detail-title").textContent'), 'Codex');
  assert.equal(await evaluate(settings, 'document.querySelector("[data-agent-options=claude]").hidden'), true);
  assert.equal(await evaluate(settings, 'document.querySelector("[data-page=ai]").getAttribute("aria-current")'), 'page');
  await fsp.writeFile(path.join(output, 'codex-settings-light.png'), (await settings.webContents.capturePage()).toPNG());
  await click(settings, '#agent-detail-back');
  assert.equal(await evaluate(settings, 'document.activeElement.dataset.providerSettings'), 'codex');
  await click(settings, '[data-provider-settings="claude"]');
  assert.equal(await evaluate(settings, 'document.querySelector("#agent-detail-title").textContent'), 'Claude Code');
  assert.equal(await evaluate(settings, 'document.querySelector("#ai").hidden'), true);
  assert.equal(await evaluate(settings, 'document.querySelector("[data-agent-options=codex]").hidden'), true);
  assert.equal(await evaluate(settings, 'document.querySelector("[data-claude-setting=autoLifecycleHooks]").getClientRects().length > 0'), true);
  await until(() => evaluate(settings, 'document.querySelector("#claude-lifecycle-state").textContent'), text => text !== '待检查', 'separate Claude status rows loaded');
  await evaluate(settings, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await fsp.writeFile(path.join(output, 'claude-settings-light.png'), (await settings.webContents.capturePage()).toPNG());
  await click(settings, '#claude-runtime-settings > summary');
  await click(settings, '.claude-advanced > summary');
  assert.equal(await evaluate(settings, 'document.querySelector("#claude-runtime-settings").open && document.querySelector(".claude-advanced").open'), true);
  assert.equal(await evaluate(settings, '!!document.querySelector("#agent-detail .setting-list .setting-list")'), false, 'no nested cards in detail settings');
  await evaluate(settings, 'document.querySelector("#claude-runtime-settings").scrollIntoView({block:"start",behavior:"instant"}); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await fsp.writeFile(path.join(output, 'claude-runtime-light.png'), (await settings.webContents.capturePage()).toPNG());
  const detailSize = settings.getContentSize(), detailMinimum = settings.getMinimumSize();
  settings.setMinimumSize(500, 500);
  settings.setContentSize(540, 760);
  await click(settings, '#claude-preview');
  await until(() => evaluate(settings, 'document.querySelector("#claude-preview-output").textContent'), Boolean, 'preview content available');
  await evaluate(settings, 'document.querySelector(".claude-advanced").scrollIntoView({block:"start",behavior:"instant"}); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const detailLayout = await evaluate(settings, `(() => {
    const section = document.querySelector('#agent-detail').getBoundingClientRect();
    const cards = [...document.querySelectorAll('#agent-detail .setting-list')].filter(e => e.getClientRects().length);
    return { viewport: innerWidth, width: document.documentElement.scrollWidth, aligned: cards.every(e => Math.abs(e.getBoundingClientRect().left-section.left)<1 && Math.abs(e.getBoundingClientRect().right-section.right)<1),
      controlsFit: [...document.querySelectorAll('#agent-detail input, #agent-detail button, #claude-preview-output')].filter(e => e.getClientRects().length).every(e => e.getBoundingClientRect().right <= section.right+1),
      previewBounded: document.querySelector('#claude-preview-output').clientHeight <= 280 };
  })()`);
  assert.equal(detailLayout.width <= detailLayout.viewport, true, 'detail page has no horizontal overflow');
  assert.equal(detailLayout.aligned && detailLayout.controlsFit && detailLayout.previewBounded, true, JSON.stringify(detailLayout));
  await fsp.writeFile(path.join(output, 'claude-enhancements-narrow.png'), (await settings.webContents.capturePage()).toPNG());
  settings.setContentSize(...detailSize);
  settings.setMinimumSize(...detailMinimum);
  await evaluate(settings, 'document.querySelector("#claude-preview-output").hidden = true; document.querySelector("#claude-runtime-settings").open = false; document.querySelector(".claude-advanced").open = false; window.scrollTo({top:0,behavior:"instant"});');
  checks.push('Claude detail uses aligned cards, separate readable statuses, independent disclosures and bounded preview; narrow layout keeps controls inside cards without changing preferences');
  await click(settings, '[data-page="general"]');
  assert.equal(await evaluate(settings, 'document.querySelector("#agent-detail").hidden'), true);
  await click(settings, '[data-page="ai"]');
  assert.equal(await evaluate(settings, 'document.querySelector("#agent-detail").hidden'), true);
  assert.deepEqual((await state(settings)).preferences, before.preferences, 'navigation must not change connections or preferences');
  checks.push('provider settings are separate child pages; overview excludes Claude controls; Codex has no Claude controls; back restores focus and sidebar navigation exits details without changing preferences');
  assert.deepEqual(runtimePreparations, [], 'startup must not prepare or download optional components');
  assert.deepEqual(before.preferences.agent.connections, { codex: false, claude: false });
  assert.deepEqual(readClaude(), initialClaude, 'disconnected startup must not install Hooks');
  assert.deepEqual((await evaluate(settings, 'window.companion.getAllUsage()')).providers, []);
  assert.equal(await evaluate(settings, 'document.querySelector("[data-provider-id=claude] .agent-connection-action").textContent'), '下载');
  await fsp.writeFile(path.join(output, 'connections-disconnected.png'), (await settings.webContents.capturePage()).toPNG());
  await evaluate(settings, "document.querySelector('#ai-settings').scrollIntoView({block:'center',behavior:'instant'}); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  await fsp.writeFile(path.join(output, 'text-generation-light.png'), (await settings.webContents.capturePage()).toPNG());
  await evaluate(settings, "window.scrollTo({top:0,behavior:'instant'})");
  await click(settings, '[data-provider-id="codex"] .agent-connection-action');
  await click(settings, '[data-provider-id="claude"] .agent-connection-action');
  await until(() => state(settings), value => value.agentProviders.providers.every(provider => provider.state === 'connected'), 'independent connections complete');
  assert.equal(runtimePreparations.length, 2);
  await until(() => state(settings), value => value.agentProviders.providers.find(p => p.id === 'claude').availability?.state === 'unavailable', 'connected Claude without login is unavailable');
  assert.equal(await evaluate(settings, 'document.querySelector("[data-provider-id=claude] .agent-availability").textContent'), '不可用');
  assert.equal(await evaluate(settings, 'document.querySelector("[data-provider-id=claude] .agent-provider-state").textContent'), '已连接');
  await until(() => evaluate(settings, 'document.querySelector("#ai-connection").value'), value => value === 'codex', 'first available service becomes the visible default');
  assert.equal(await evaluate(settings, 'document.querySelector("#ai-connection option[value=claude]")'), null, 'connected but unavailable Claude cannot be selected');
  const rejectedSelection = await evaluate(settings, 'window.companion.updateAiSettings({preferences:{connectionId:"claude"}}).then(() => false, () => true)');
  assert.equal(rejectedSelection, true, 'IPC independently rejects unavailable services');
  await fsp.writeFile(path.join(output, 'agent-availability-light.png'), (await settings.webContents.capturePage()).toPNG());
  await evaluate(settings, "window.companion.updateSettings({appearance:{theme:'dark'}})");
  await until(() => evaluate(settings, "getComputedStyle(document.documentElement).getPropertyValue('--card').trim()"), color => color === '#272d30', 'availability dark palette');
  await evaluate(settings, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await fsp.writeFile(path.join(output, 'agent-availability-dark.png'), (await settings.webContents.capturePage()).toPNG());
  await evaluate(settings, "window.companion.updateSettings({appearance:{theme:'light'}})");
  claudeUnavailable = false;
  await click(settings, '[data-provider-id="claude"] .agent-availability');
  await until(() => state(settings), value => value.agentProviders.providers.every(p => p.availability?.state === 'available'), 'availability retry');
  await until(() => evaluate(settings, '!!document.querySelector("#ai-connection option[value=claude]")'), Boolean, 'available Claude appears in the service picker');
  await evaluate(settings, '(() => { const picker = document.querySelector("#ai-connection"); picker.value = "claude"; picker.dispatchEvent(new Event("change", {bubbles:true})); })()');
  await until(() => state(settings), value => value.preferences.ai.connectionId === 'claude', 'select available Claude');
  claudeUnavailable = true;
  await click(settings, '[data-provider-id="claude"] .agent-availability');
  await until(() => evaluate(settings, 'document.querySelector("#ai-connection option[value=claude]")?.textContent'), value => value?.includes('检查中'), 'selected service remains pending during recheck');
  await until(() => evaluate(settings, 'document.querySelector("#ai-connection option[value=claude]")?.textContent'), value => value?.includes('不可用'), 'failed selected service is marked unavailable');
  assert.equal(await evaluate(settings, 'document.querySelector("#ai-connection option[value=claude]").disabled'), true);
  assert.equal(await evaluate(settings, 'document.querySelector("#ai-connection").value'), 'claude', 'never silently switch the selected service');
  assert.equal(await evaluate(settings, 'document.querySelector("#ai-model-mode-row").hidden'), true);
  await evaluate(settings, "document.querySelector('#ai-settings').scrollIntoView({block:'center',behavior:'instant'}); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  await fsp.writeFile(path.join(output, 'ai-service-unavailable-light.png'), (await settings.webContents.capturePage()).toPNG());
  await evaluate(settings, '(() => { const picker = document.querySelector("#ai-connection"); picker.value = "codex"; picker.dispatchEvent(new Event("change", {bubbles:true})); })()');
  await until(() => state(settings), value => value.preferences.ai.connectionId === 'codex', 'switch to an available service');
  claudeUnavailable = false;
  await click(settings, '[data-provider-id="claude"] .agent-availability');
  await until(() => state(settings), value => value.agentProviders.providers.every(p => p.availability?.state === 'available'), 'availability restored after picker verification');
  await evaluate(settings, "window.scrollTo({top:0,behavior:'instant'})");
  checks.push('AI picker only permits available connections; checking differs from unavailable, IPC rejects invalid selections, and failure preserves the selected service until explicit replacement');
  checks.push('download action before components, independent connected/unavailable labels, and metadata-only availability retry');

  checks.push('no startup component download/Hook/quota; independent connect buttons prepare only selected providers; both become connected');
  aiCheckPreview = { connectionId: 'codex', status: 'ready', compatibility: 'catalog', name: 'Codex',
    modelId: 'gpt-6-astra', modelProvider: 'openai', runtimeVersion: '0.166.0-alpha.5.1',
    models: [{ id: 'gpt-6-astra', name: 'GPT-6-Astra' }],
    message: '连接和模型检查通过，当前模型：gpt-6-astra。实际生成时仍会检查服务端返回结果。' };
  await click(settings, '#ai-check');
  await until(() => evaluate(settings, 'document.querySelector("#ai-status-indicator").dataset.state'), value => value === 'ready', 'AI status preview');
  await evaluate(settings, "document.querySelector('#ai-settings').scrollIntoView({block:'center',behavior:'instant'}); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  await fsp.writeFile(path.join(output, 'text-generation-ready-light.png'), (await settings.webContents.capturePage()).toPNG());
  await evaluate(settings, "window.scrollTo({top:0,behavior:'instant'})");
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
  assert.equal((await state(settings)).preferences.ai.connectionId, "codex");
  assert.equal(await evaluate(settings, 'document.querySelector("#ai [data-agent-setting=defaultProviderId]")'), null, 'remote new-task routing is not a global AI option');
  await click(settings, '[data-page="mobile"]');
  assert.equal(await evaluate(settings, 'document.querySelector("#remote-control [data-agent-setting=defaultProviderId]").getClientRects().length > 0'), true);
  await control(settings, "defaultProviderId", "claude");
  await until(() => state(settings), value => value.preferences.remoteControl.defaultProviderId === "claude", "default executor independent of collection");
  await evaluate(settings, "document.querySelector('#remote-control').scrollIntoView({block:'center',behavior:'instant'}); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  await fsp.writeFile(path.join(output, 'remote-new-task-light.png'), (await settings.webContents.capturePage()).toPNG());
  await click(settings, '#remote-agent-connections');
  assert.equal(await evaluate(settings, 'document.querySelector("#ai").hidden'), false);
  assert.equal((await state(settings)).preferences.ai.connectionId, "codex");
  assert.equal(before.preferences.claude.nodePath, "", "No manually configured Node executable");
  assert.equal(before.preferences.claude.autoLifecycleHooks, true);
  assert.equal(await evaluate(settings, 'document.querySelector(\'[data-claude-setting="autoLifecycleHooks"]\').checked'), true);
  const automaticConfig = await until(readClaude, value => Object.values(lifecycleHooks(value)).every(hooks => hooks.length === 1), "startup automatically installs all five lifecycle Hooks");
  assertLifecycle(automaticConfig);
  assert.deepEqual(automaticConfig.statusLine, initialClaude.statusLine);
  assert.deepEqual(readMcp(), initialMcp);
  checks.push("connecting Claude installs five automatic Hooks with blank Node preference; permissions/model/statusLine/MCP and user Hooks unchanged");

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
  await click(settings, '[data-provider-settings="claude"]');
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
  await until(() => evaluate(settings, "document.querySelector('#claude-integration-state').textContent"), text => text.includes("已安装"), "integration status");
  await fsp.writeFile(path.join(output, "settings-light.png"), (await settings.webContents.capturePage()).toPNG());
  await evaluate(settings, "document.querySelector('.claude-advanced').scrollIntoView({block:'center',behavior:'instant'}); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  await fsp.writeFile(path.join(output, "settings-detail-light.png"), (await settings.webContents.capturePage()).toPNG());
  await evaluate(settings, "window.companion.updateSettings({appearance:{theme:'dark'}})");
  await until(() => evaluate(settings, "matchMedia('(prefers-color-scheme: dark)').matches"), Boolean, "dark theme");
  await until(() => evaluate(settings, "getComputedStyle(document.documentElement).getPropertyValue('--card').trim()"), color => color === '#272d30', 'dark CSS palette applied');
  await evaluate(settings, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await until(() => evaluate(settings, `(() => {
    const card = document.querySelector('.agent-provider-card');
    const probe = document.createElement('div');
    probe.style.backgroundColor = getComputedStyle(document.documentElement).getPropertyValue('--card');
    return { actual: getComputedStyle(card).backgroundColor, expected: probe.style.backgroundColor };
  })()`), colors => colors.actual === colors.expected, "provider card theme transition");
  await fsp.writeFile(path.join(output, "settings-dark.png"), (await settings.webContents.capturePage()).toPNG());
  await evaluate(settings, 'document.querySelector(".claude-advanced").open = false; window.scrollTo({top:0,behavior:"instant"}); new Promise(resolve => setTimeout(resolve, 200))');
  await fsp.writeFile(path.join(output, 'claude-settings-dark.png'), (await settings.webContents.capturePage()).toPNG());
  await click(settings, '#agent-detail-back');
  await fsp.writeFile(path.join(output, "sources-dark.png"), (await settings.webContents.capturePage()).toPNG());
  await click(settings, '#ai-check');
  await until(() => evaluate(settings, 'document.querySelector("#ai-status-indicator").dataset.state'), value => value === 'ready', 'dark AI status preview');
  await evaluate(settings, "document.querySelector('#ai-settings').scrollIntoView({block:'center',behavior:'instant'}); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  await fsp.writeFile(path.join(output, 'text-generation-dark.png'), (await settings.webContents.capturePage()).toPNG());
  await evaluate(settings, "document.querySelector('#ai-connection-details').open = true; document.querySelector('#ai-settings').scrollIntoView({block:'end',behavior:'instant'}); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  await fsp.writeFile(path.join(output, 'text-generation-details-dark.png'), (await settings.webContents.capturePage()).toPNG());
  await evaluate(settings, "document.querySelector('#ai-connection-details').open = false");
  await evaluate(settings, "window.scrollTo({top:0,behavior:'instant'})");
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
  await click(settings, '[data-provider-settings="claude"]');
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
  await click(settings, '[data-page="ai"]');
  await click(settings, '[data-provider-id="claude"] .agent-connection-action');
  await until(() => state(settings), value => !value.preferences.agent.connections.claude, 'disconnect Claude persists');
  assert.equal((await state(settings)).preferences.agent.connections.codex, true);
  assert.deepEqual((await evaluate(settings, 'window.companion.getAllUsage()')).providers.map(value => value.providerId), ['codex']);
  assert.ok(Object.values(lifecycleHooks(readClaude())).every(hooks => !hooks.length));
  assert.ok((await (await globalThis.fetch(`${base}/api/v1/tasks`)).json()).tasks.every(task => !task.sessionId.startsWith('claude:')));
  await fsp.writeFile(path.join(output, 'connections-one-connected.png'), (await settings.webContents.capturePage()).toPNG());
  checks.push('disconnecting Claude leaves Codex connected, removes only automatic Hooks, hides Claude quota and tasks, preserves the independent default');
  checks.push("GUI toggle removes only owned lifecycle Hooks, persists disabled/enabled preference, restores Hooks with Node still blank; zero model generation attempts");
  const checksBeforeKey = aiCatalogChecks;
  aiCheckPreview = { connectionId: 'deepseek', name: 'DeepSeek', modelProvider: 'deepseek', status: 'error', code: 'model_required',
    models: [{ id: 'fixture-chat', name: 'Fixture Chat' }, { id: 'fixture-reasoner', name: 'Fixture Reasoner' }],
    message: '请选择模型。' };
  assert.equal(await evaluate(settings, 'document.querySelector("#ai-connection option[value=agent]")'), null);
  assert.equal(await evaluate(settings, 'document.querySelector("#ai-connection option[value=deepseek]")'), null);
  await click(settings, '#ai-add');
  await evaluate(settings, "document.querySelector('#ai-add-type').value='deepseek'; document.querySelector('#ai-add-type').dispatchEvent(new Event('change',{bubbles:true}))");
  assert.equal(aiCatalogChecks, checksBeforeKey, 'no catalog check before a key is supplied');
  assert.equal(await evaluate(settings, 'document.querySelector("#ai-add-fetch").disabled'), true);
  await evaluate(settings, "document.querySelector('#ai-add-panel').scrollIntoView({block:'center',behavior:'instant'}); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  await fsp.writeFile(path.join(output, 'add-service-light.png'), (await settings.webContents.capturePage()).toPNG());
  await evaluate(settings, "window.companion.updateSettings({appearance:{theme:'dark'}})");
  await until(() => evaluate(settings, "getComputedStyle(document.documentElement).getPropertyValue('--card').trim()"), color => color === '#272d30', 'add service dark palette');
  await evaluate(settings, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await fsp.writeFile(path.join(output, 'add-service-dark.png'), (await settings.webContents.capturePage()).toPNG());
  await evaluate(settings, "document.querySelector('#ai-add-key').value='fixture-only-never-sent'; document.querySelector('#ai-add-key').dispatchEvent(new Event('input',{bubbles:true}))");
  await click(settings, '#ai-add-fetch');
  await until(() => evaluate(settings, 'document.querySelector("#ai-add-model-row").hidden'), hidden => !hidden, 'draft model list');
  assert.equal((await state(settings)).preferences.ai.connectionId, 'codex', 'draft does not switch the active service');
  await evaluate(settings, "document.querySelector('#ai-add-model').value='fixture-chat'; document.querySelector('#ai-add-model').dispatchEvent(new Event('change',{bubbles:true}))");
  aiCheckPreview = { ...aiCheckPreview, status: 'ready', code: undefined, modelId: 'fixture-chat', message: '连接与模型检查通过。' };
  await click(settings, '#ai-add-confirm');
  await until(() => evaluate(settings, 'document.querySelector("#ai-add-panel").hidden && document.querySelector("#ai-connection").value === "deepseek"'), Boolean, 'configured service selected');
  assert.equal(await evaluate(settings, 'document.querySelector("#ai-add-key").value'), '');
  await until(() => evaluate(settings, 'document.querySelector("#ai-status-indicator").dataset.state'), value => value === 'ready', 'new service checked');
  await evaluate(settings, "document.querySelector('#ai-settings').scrollIntoView({block:'end',behavior:'instant'}); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  await fsp.writeFile(path.join(output, 'added-service-dark.png'), (await settings.webContents.capturePage()).toPNG());
  checks.push('explicit configured-service picker, empty add state, key-first draft catalog with no active-service changes, and add-and-use through real preload/IPC');
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

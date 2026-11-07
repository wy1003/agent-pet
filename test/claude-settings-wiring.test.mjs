import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { minimatch } from "../node_modules/minimatch/dist/esm/index.js";

test("packaging unpacks external bridges and Windows SDK binaries at root or nested dependency paths", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  for (const file of ["desktop/claude/hook-bridge.mjs", "desktop/claude/statusline-bridge.mjs", "desktop/notebook/mcp/stdio.mjs", "public/notebook-deadline.mjs", "package.json",
    "node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe",
    "node_modules/@anthropic-ai/claude-agent-sdk/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe",
    "node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js", "node_modules/zod/index.js",
    "node_modules/@openai/codex-win32-x64/vendor/codex.exe"]) {
    assert.ok(pkg.build.asarUnpack.some(pattern => minimatch(file, pattern)), `external runtime resource: ${file}`);
  }
  assert.equal(pkg.dependencies["@anthropic-ai/claude-agent-sdk"], undefined);
});

const settings = () => import("../desktop/agents/claude-settings.mjs");

test("Claude IPC is main-frame-only, requires native confirmation and never accepts renderer paths for installation", async () => {
  const { installClaudeSettingsIpc } = await settings();
  const handlers = new Map(), calls = [];
  let confirmed = false;
  const options = { configDir: "/isolated", nodePath: "/node", bridgePath: "/bridge", eventsDir: "/events" };
  installClaudeSettingsIpc({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    requireSettingsMainFrame: event => { if (event !== "trusted") throw new Error("untrusted"); },
    getOptions: async () => options, getPreferences: () => ({ claude: {} }),
    savePreferences: async patch => { calls.push(["save", patch]); return patch; },
    confirm: async () => confirmed, onSaved: () => {},
    integration: {
      status: async input => ({ ok: true, state: "not_installed" }),
      preview: async input => { calls.push(["preview", input]); return { ok: true, preview: {} }; },
      install: async input => { calls.push(["install", input]); return { ok: true }; },
      remove: async input => { calls.push(["remove", input]); return { ok: true }; },
    }, runtimeStatus: async () => ({ authenticated: null }) });
  for (const handler of handlers.values()) await assert.rejects(async () => handler("other", {}), /untrusted/);
  const install = handlers.get("claude:install");
  assert.equal((await install("trusted", { configDir: "/attacker" })).cancelled, true);
  assert.equal(calls.some(([name]) => name === "install"), false);
  confirmed = true;
  await install("trusted", { configDir: "/attacker" });
  assert.deepEqual(calls.find(([name]) => name === "install")[1], options);
  await handlers.get("claude:update")("trusted", { executablePath: "/claude", autoLifecycleHooks: false, defaultProviderId: "claude", usageProviderId: "claude", configDir: "/attacker", ai: { modelId: "changed" } });
  const saved = calls.find(([name]) => name === "save")[1];
  assert.equal(saved.claude.executablePath, "/claude");
  assert.equal(saved.claude.autoLifecycleHooks, false);
  await assert.rejects(handlers.get("claude:update")("trusted", { autoLifecycleHooks: "false" }), /无效/);
  assert.equal(saved.remoteControl.defaultProviderId, "claude");
  assert.equal(saved.agent.usageProviderId, "claude");
  assert.equal(saved.ai, undefined);
  assert.equal(saved.claude.configDir, undefined);
});

test("status and removal do not require the optional MCP bridge to be online", async () => {
  const { installClaudeSettingsIpc } = await settings();
  const handlers = new Map();
  let removed = false;
  installClaudeSettingsIpc({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    requireSettingsMainFrame() {}, getPreferences: () => ({ claude: {} }),
    getOptions: async () => { throw new Error("MCP bridge unavailable"); },
    getStatusOptions: async () => ({ configDir: "/fixture" }),
    lifecycleStatus: async () => ({ ok: true, state: "installed" }),
    runtimeStatus: async () => ({ available: true }), confirm: async () => true,
    integration: {
      status: async () => ({ ok: true, state: "installed" }),
      remove: async options => { assert.equal(options.configDir, "/fixture"); removed = true; return { ok: true }; },
    },
  });
  assert.equal((await handlers.get("claude:status")({})).lifecycle.state, "installed");
  assert.equal((await handlers.get("claude:remove")({})).ok, true);
  assert.equal(removed, true);
});

test("desktop read-only options preserve the default user MCP location", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-pet-default-scope-"));
  const originalConfig = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  t.mock.method(os, "homedir", () => root);
  t.after(async () => {
    if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalConfig;
    await rm(root, { recursive: true, force: true });
  });
  const integration = await import("../desktop/claude/integration.mjs");
  const source = await readFile(new URL("../desktop/main.mjs", import.meta.url), "utf8");
  const getter = source.match(/getStatusOptions: (.*),\r?\n/)[1];
  const getStatusOptions = vm.runInNewContext(`(${getter})`, {
    resolveClaudeConfigDirectory: () => path.join(root, ".claude"),
  });
  const options = { nodePath: process.execPath, bridgePath: path.join(root, "bridge.mjs"),
    eventsDir: path.join(root, "events"), mcpConfig: { mcpServers: { "agent-pet": { command: process.execPath, args: ["fixture.mjs"] } } } };
  assert.equal((await integration.installClaudeIntegration(options)).ok, true);
  assert.equal((await integration.getClaudeIntegrationStatus(getStatusOptions())).state, "installed");
  assert.equal((await integration.removeClaudeIntegration(getStatusOptions())).ok, true);
  const restored = JSON.parse(await readFile(path.join(root, ".claude.json"), "utf8"));
  assert.equal(restored.mcpServers?.["agent-pet"], undefined);
});

test("notebook Claude main wiring reuses host config and default scope without native confirmation", async () => {
  const source = await readFile(new URL("../desktop/main.mjs", import.meta.url), "utf8");
  const block = source.match(/  const notebookClaudeConnection = new NotebookClaudeConnection\([\s\S]*?(?=  installNotebookWindowIpc)/)?.[0];
  assert.ok(block, "the notebook-only Claude flow is wired independently of full integration");
  const hostConfig = () => ({ mcpServers: { "agent-pet-notebook": { command: "fixture" } } });
  let connectionOptions, ipcOptions, response = 0;
  const prompts = [];
  vm.runInNewContext(block, {
    NotebookClaudeConnection: class { constructor(options) { connectionOptions = options; } },
    getNotebookMcpConfig: hostConfig, ipcMain: {}, requireSettingsMainFrame() {},
    installNotebookClaudeConnectionIpc: options => { ipcOptions = options; },
    dialog: { showMessageBox: async options => { prompts.push(options); return { response }; } },
  });
  assert.equal(connectionOptions.getConfig, hostConfig);
  assert.equal(connectionOptions.getOptions, undefined, "integration owns default home and CLAUDE_CONFIG_DIR resolution");
  assert.equal(ipcOptions.confirmConnect, undefined);
  assert.deepEqual(prompts, []);
  assert.doesNotMatch(block, /showMessageBox|confirmConnect/);
  assert.doesNotMatch(block, /resolveNodeExecutable|installClaudeIntegration|configDir:/);
});

test("notebook Claude preload exposes fixed actions and never forwards renderer paths", async () => {
  const source = await readFile(new URL("../desktop/preload.cjs", import.meta.url), "utf8");
  const exposed = {}, calls = [];
  vm.runInNewContext(source, { require: () => ({
    contextBridge: { exposeInMainWorld: (key, value) => { exposed[key] = value; } },
    ipcRenderer: { invoke: (...args) => { calls.push(args); } }, webUtils: {},
  }) });
  assert.equal(typeof exposed.companion.getNotebookClaudeConnection, "function");
  assert.equal(typeof exposed.companion.connectNotebookToClaude, "function");
  exposed.companion.getNotebookClaudeConnection({ configDir: "/attacker" });
  exposed.companion.connectNotebookToClaude({ action: "remove", configDir: "/attacker" });
  assert.deepEqual(calls, [["notebook:claude-connection", "status"], ["notebook:claude-connection", "connect"]]);
  assert.equal(typeof exposed.companion.connectNotebookToCodex, "function");
});

test("installed bridge and MCP paths resolve outside asar, source paths stay unchanged", async () => {
  const { executableResourcePath } = await settings();
  assert.equal(executableResourcePath("C:/app/resources/app.asar/desktop/claude/hook-bridge.mjs"), "C:/app/resources/app.asar.unpacked/desktop/claude/hook-bridge.mjs");
  assert.equal(executableResourcePath("D:/repo/desktop/notebook/mcp/stdio.mjs"), "D:/repo/desktop/notebook/mcp/stdio.mjs");
});

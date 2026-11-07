import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const require = createRequire(import.meta.url);
const { extractFile } = require("@electron/asar");
const source = fileURLToPath(new URL("../", import.meta.url));
const built = path.resolve(process.argv[2] || path.join(source, "dist", "win-unpacked"));
const archive = path.join(built, "resources", "app.asar");
const unpacked = `${archive}.unpacked`;
const sourcePackage = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"));
const packagedPackage = JSON.parse(extractFile(archive, "package.json").toString("utf8"));
assert.ok(extractFile(archive, path.normalize("src/claude-input.mjs")).equals(await readFile(path.join(source, "src/claude-input.mjs"))), "stale packaged Claude input classifier");
for (const field of ["name", "version", "main", "type"]) assert.equal(packagedPackage[field], sourcePackage[field]);
for (const relative of ["desktop/main.mjs", "desktop/preferences.mjs", "desktop/agents/desktop-runtime.mjs", "desktop/agents/claude-lifecycle.mjs", "desktop/agents/claude-settings.mjs", "desktop/claude/runtime.mjs", "desktop/claude/remote-executor.mjs", "desktop/claude/hook-bridge.mjs", "desktop/claude/statusline-bridge.mjs", "desktop/claude/integration.mjs", "desktop/notebook/mcp/stdio.mjs", "desktop/notebook/mcp/claude-connection.mjs", "desktop/preload.cjs", "desktop/windows/window-contracts.mjs", "public/settings.html", "public/settings.css", "src/claude-collector.mjs", "src/claude-discovery.mjs", "src/claude-transcript.mjs", "src/multi-agent-collector.mjs", "public/usage-card.js", "public/settings.js"]) {
  assert.ok(extractFile(archive, path.normalize(relative)).equals(await readFile(path.join(source, relative))), `stale packaged file: ${relative}`);
}
assert.ok((await stat(path.join(unpacked, "node_modules", "@anthropic-ai", "claude-agent-sdk-win32-x64", "claude.exe"))).size > 0);
const packagedSdk = await import(pathToFileURL(path.join(unpacked, "node_modules", "@anthropic-ai", "claude-agent-sdk", "sdk.mjs")).href);
assert.equal(typeof packagedSdk.query, "function"); // Import only: never query a model.
console.log("Packaged source, Claude binary, and SDK import verified.");

const temporary = await mkdtemp(path.join(os.tmpdir(), "agent-pet-package-中文 "));
const env = { ...process.env, HOME: temporary, USERPROFILE: temporary, APPDATA: temporary, LOCALAPPDATA: temporary,
  TMP: temporary, TEMP: temporary, TMPDIR: temporary, CODEX_HOME: path.join(temporary, "codex"),
  CLAUDE_CONFIG_DIR: path.join(temporary, "claude"), AGENT_PET_AUXILIARY: "0" };
let client, transport, bridge, store;
try {
  await mkdir(path.join(temporary, "events"));
  const load = relative => import(pathToFileURL(path.join(unpacked, relative)).href);
  const { installClaudeLifecycle, removeClaudeLifecycle, getClaudeLifecycleStatus } = await load("desktop/claude/integration.mjs");
  const { resolveNodeExecutable } = await load("desktop/claude/runtime.mjs");
  const configDir = env.CLAUDE_CONFIG_DIR, eventsDir = path.join(temporary, "events");
  await mkdir(configDir, { recursive: true });
  const settingsFile = path.join(configDir, "settings.json");
  const initial = { permissions: { deny: ["Bash"] }, model: "fixture-model",
    statusLine: { type: "command", command: "fixture-statusline-never-executed" } };
  await writeFile(settingsFile, JSON.stringify(initial));
  const mcpFile = path.join(configDir, ".claude.json"), initialMcp = { mcpServers: { existing: { command: "fixture-mcp-never-executed" } } };
  await writeFile(mcpFile, JSON.stringify(initialMcp));
  const options = { configDir, eventsDir, bridgePath: path.join(unpacked, "desktop", "claude", "hook-bridge.mjs") };
  const nodePath = await resolveNodeExecutable("");
  assert.ok(nodePath, "Packaged runtime discovers Node without a manually configured path");
  {
    const installed = await installClaudeLifecycle({ ...options, nodePath });
    assert.equal(installed.ok, true, JSON.stringify(installed));
    assert.equal((await getClaudeLifecycleStatus(options)).state, "installed");
    const configured = JSON.parse(await readFile(settingsFile, "utf8"));
    const { hooks, ...untouched } = configured;
    assert.deepEqual(untouched, initial);
    assert.deepEqual(JSON.parse(await readFile(mcpFile, "utf8")), initialMcp);
    const events = ["SessionStart", "UserPromptSubmit", "Stop", "StopFailure", "SessionEnd"];
    assert.deepEqual(Object.keys(hooks).sort(), [...events].sort());
    const commands = Object.fromEntries(events.map(event => {
      const entries = hooks[event].flatMap(group => group.hooks);
      assert.equal(entries.length, 1);
      assert.match(JSON.stringify(entries[0]), /agent-pet:lifecycle:v1/);
      assert.equal(entries[0].type, "command");
      assert.ok(path.isAbsolute(entries[0].command));
      assert.ok(Array.isArray(entries[0].args));
      return [event, entries[0]];
    }));
    for (const eventName of ["UserPromptSubmit", "Stop"]) {
      const hook = commands[eventName];
      const child = spawn(hook.command, hook.args, { windowsHide: true, timeout: 5000, env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", data => { stdout += data; });
      child.stderr.on("data", data => { stderr += data; });
      child.stdin.on("error", () => {});
      const exited = once(child, "close");
      child.stdin.end(JSON.stringify({ hook_event_name: eventName, session_id: "packaged-smoke", cwd: temporary,
        ...(eventName === "UserPromptSubmit" ? { prompt: "本地模拟" } : { stop_hook_active: false, last_assistant_message: "包内自动 Hook 完成" }) }));
      assert.equal((await exited)[0], 0, stderr);
      assert.equal(stdout, "");
      assert.equal(stderr, "");
    }
    const files = (await readdir(eventsDir)).filter(name => name.endsWith(".json"));
    assert.equal(files.length, 2);
    const recorded = await Promise.all(files.map(async name => JSON.parse(await readFile(path.join(eventsDir, name), "utf8"))));
    assert.deepEqual(recorded.map(event => event.hook_event_name).sort(), ["Stop", "UserPromptSubmit"]);
    assert.ok(recorded.every(event => event.session_id === "packaged-smoke"));
    assert.equal((await removeClaudeLifecycle(options)).ok, true);
    assert.deepEqual(JSON.parse(await readFile(settingsFile, "utf8")), initial);
    assert.equal((await installClaudeLifecycle({ ...options, nodePath })).ok, true);
    assert.deepEqual(JSON.parse(await readFile(settingsFile, "utf8")), configured);
    console.log("Packaged lifecycle installer discovers Node and installs five Hooks; actual installed exec-form submit/Stop commands and remove/reinstall verified.");
  }
  const { ClaudeActivityCollector } = await load("src/claude-collector.mjs");
  const transcriptsDir = path.join(temporary, "claude", "projects");
  await mkdir(path.join(transcriptsDir, "project"), { recursive: true });
  const timestamp = new Date().toISOString();
  await writeFile(path.join(transcriptsDir, "project", "auto.jsonl"), [
    { type: "user", uuid: "u1", sessionId: "auto", timestamp, message: { role: "user", content: "无 Hook 自动发现" } },
    { type: "attachment", uuid: "attachment1", parentUuid: "u1", sessionId: "auto", timestamp, attachment: { type: "fixture" } },
    { type: "assistant", uuid: "a1", parentUuid: "attachment1", sessionId: "auto", timestamp, message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "完成" }] } },
  ].map(row => JSON.stringify(row) + "\n").join(""));
  const automatic = new ClaudeActivityCollector({ transcriptsDir, eventsDir: path.join(temporary, "automatic-events"), statePath: null });
  try {
    await automatic.scanOnce();
    assert.equal(automatic.getTasks()[0].question, "无 Hook 自动发现");
    assert.equal(automatic.getTasks()[0].status, "completed");
  } finally { await automatic.stop(); }
  console.log("Packaged read-only Claude discovery works without installed Hooks.");
  const { NotebookStore } = await load("desktop/notebook/notebook-store.mjs");
  const { createNotebookTools } = await load("desktop/notebook/mcp/notebook-tools.mjs");
  const { NotebookMcpBridge } = await load("desktop/notebook/mcp/bridge-service.mjs");
  const connectionFile = path.join(temporary, "connection.json");
  store = new NotebookStore(path.join(temporary, "notebook"));
  bridge = new NotebookMcpBridge({ connectionFile, tools: createNotebookTools(store) });
  await bridge.start();
  const { NotebookClaudeConnection } = await load("desktop/notebook/mcp/claude-connection.mjs");
  const notebookEntry = { command: path.join(built, "Agent Pet.exe"),
    args: [path.join(unpacked, "desktop", "notebook", "mcp", "stdio.mjs"), "--connection", connectionFile],
    env: { ELECTRON_RUN_AS_NODE: "1" } };
  const notebookConnection = new NotebookClaudeConnection({
    getConfig: () => ({ mcpServers: { "agent-pet-notebook": notebookEntry } }),
    getOptions: () => ({ configDir }),
  });
  const settingsBeforeNotebook = await readFile(settingsFile, "utf8");
  assert.equal((await notebookConnection.connect()).configured, true);
  assert.equal((await notebookConnection.status()).configured, true);
  assert.equal((await notebookConnection.connect()).changed, false);
  assert.equal(await readFile(settingsFile, "utf8"), settingsBeforeNotebook);
  const installedMcp = JSON.parse(await readFile(mcpFile, "utf8"));
  assert.deepEqual(Object.keys(installedMcp.mcpServers).sort(), ["agent-pet-notebook", "existing"]);
  const installedNotebook = installedMcp.mcpServers["agent-pet-notebook"];
  assert.deepEqual(installedNotebook, notebookEntry);
  const notebookManifestFile = path.join(configDir, "agent-pet-notebook.json");
  const legacyManifest = JSON.parse(await readFile(notebookManifestFile, "utf8"));
  delete legacyManifest.mcpName;
  const legacyMcp = structuredClone(installedMcp);
  legacyMcp.mcpServers["agent-pet"] = legacyMcp.mcpServers["agent-pet-notebook"];
  delete legacyMcp.mcpServers["agent-pet-notebook"];
  await writeFile(mcpFile, JSON.stringify(legacyMcp));
  await writeFile(notebookManifestFile, JSON.stringify(legacyManifest));
  const beforeLegacyStatus = await readFile(mcpFile, "utf8");
  await notebookConnection.status();
  assert.equal(await readFile(mcpFile, "utf8"), beforeLegacyStatus);
  const migrated = await notebookConnection.connect();
  assert.equal(migrated.configured, true);
  assert.equal(migrated.changed, true);
  assert.deepEqual(JSON.parse(await readFile(mcpFile, "utf8")), installedMcp);
  assert.equal((await notebookConnection.connect()).changed, false);
  const missingManagedMcp = structuredClone(installedMcp);
  delete missingManagedMcp.mcpServers["agent-pet-notebook"];
  await writeFile(mcpFile, JSON.stringify(missingManagedMcp));
  const beforeMissingStatus = await readFile(mcpFile, "utf8");
  const missingStatus = await notebookConnection.status();
  assert.equal(missingStatus.configured, false);
  assert.equal(await readFile(mcpFile, "utf8"), beforeMissingStatus);
  const restored = await notebookConnection.connect();
  assert.equal(restored.configured, true);
  assert.equal(restored.changed, true);
  assert.deepEqual(JSON.parse(await readFile(mcpFile, "utf8")), installedMcp);
  assert.equal((await notebookConnection.connect()).changed, false);
  assert.equal(await readFile(settingsFile, "utf8"), settingsBeforeNotebook);
  console.log("Packaged notebook-only Claude connection uses agent-pet-notebook, safely migrates the owned legacy name, restores a missing managed entry, preserves Hooks and supports idempotent configuration.");
  client = new Client({ name: "package-smoke", version: "1" });
  transport = new StdioClientTransport({ ...installedNotebook,
    env: { ...env, ...installedNotebook.env }, stderr: "pipe" });
  let mcpErrors = "";
  transport.stderr.on("data", data => { mcpErrors += data; });
  await client.connect(transport, { timeout: 10000 });
  assert.equal((await client.listTools()).tools.length, 6);
  const args = { requestId: "package-smoke-1", originalText: "隔离验收", content: "验证打包后的 MCP" };
  const added = await client.callTool({ name: "notebook_add_idea", arguments: args });
  assert.equal(added.isError, undefined);
  assert.equal(added.structuredContent.saved, true);
  const duplicate = await client.callTool({ name: "notebook_add_idea", arguments: args });
  assert.equal(duplicate.structuredContent.record.id, added.structuredContent.record.id);
  assert.equal(duplicate.structuredContent.duplicate, true);
  assert.equal(mcpErrors, "");
  console.log("Packaged Electron Node-mode MCP discovery, write, and idempotent retry verified.");
} finally {
  await client?.close();
  await transport?.close();
  await bridge?.stop();
  await store?.close();
  await rm(temporary, { recursive: true, force: true });
}

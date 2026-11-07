import test from "node:test";
import assert from "node:assert/strict";
import { NotebookClaudeConnection, installNotebookClaudeConnectionIpc } from "../desktop/notebook/mcp/claude-connection.mjs";

import { readFile } from "node:fs/promises";
import vm from "node:vm";

const entry = { command: "/fixture/node", args: ["/fixture/notebook.mjs"], env: { ELECTRON_RUN_AS_NODE: "1" } };

test("Claude notebook facade supplies host-owned config and deduplicates concurrent connections", async () => {
  const calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const connection = new NotebookClaudeConnection({
    getConfig: () => ({ mcpServers: { "agent-pet-notebook": entry } }),
    getOptions: () => ({ configDir: "/fixture/claude" }),
    integration: {
      status: async options => { calls.push(["status", options]); return { ok: true, configured: false, state: "not-installed" }; },
      install: async options => { calls.push(["install", options]); await gate; return { ok: true, configured: true, changed: true, state: "installed" }; },
    },
  });
  assert.equal((await connection.status()).configured, false);
  const first = connection.connect(), second = connection.connect();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.filter(([method]) => method === "install").length, 1);
  release();
  assert.deepEqual(await first, await second);
  assert.equal((await first).configured, true);
  for (const [, options] of calls) assert.deepEqual(options, { configDir: "/fixture/claude", notebookMcpConfig: entry });
});

test("Claude notebook facade preserves omitted default config root", async () => {
  let received;
  const connection = new NotebookClaudeConnection({
    getConfig: () => ({ mcpServers: { "agent-pet-notebook": entry } }),
    integration: { status: async options => { received = options; return { ok: true, configured: false }; } },
  });
  await connection.status();
  assert.equal(Object.hasOwn(received, "configDir"), false);
  assert.deepEqual(received.notebookMcpConfig, entry);
});

function ipcFixture({ confirm = true, failure = false } = {}) {
  const handlers = new Map(), calls = [];
  installNotebookClaudeConnectionIpc({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    requireSettingsMainFrame: event => { if (event !== "settings-main") throw new Error("forbidden frame"); },
    confirmConnect: async () => { calls.push("confirm"); return confirm; },
    getConnection: () => ({
      status: async () => { calls.push("status"); return { ok: true, configured: false, state: "not-installed" }; },
      connect: async () => { calls.push("connect"); if (failure) throw new Error("SECRET_FIXTURE_TOKEN private/config.json"); return { ok: true, configured: true, state: "installed", changed: true }; },
    }),
  });
  return { calls, invoke: (event, action) => handlers.get("notebook:claude-connection")(event, action) };
}

test("Claude notebook IPC rejects subframes and arbitrary renderer actions", async () => {
  const f = ipcFixture();
  await assert.rejects(f.invoke("other-frame", "connect"), /forbidden/);
  await assert.rejects(f.invoke("settings-main", { action: "connect", configDir: "/attacker" }));
  await assert.rejects(f.invoke("settings-main", "remove"));
  assert.deepEqual(f.calls, []);
});

test("Claude notebook IPC status is read-only and connect is direct without any confirmation", async () => {
  const f = ipcFixture({ confirm: false });
  assert.equal((await f.invoke("settings-main", "status")).ok, true);
  assert.deepEqual(f.calls, ["status"]);
  assert.equal((await f.invoke("settings-main", "connect")).configured, true);
  assert.equal((await f.invoke("settings-main", "connect")).configured, true);
  assert.deepEqual(f.calls, ["status", "connect", "connect"]);
});

test("Claude notebook IPC connects without prompts and does not expose raw failures", async () => {
  const f = ipcFixture();
  assert.equal((await f.invoke("settings-main", "connect")).configured, true);
  assert.deepEqual(f.calls, ["connect"]);
  const failed = await ipcFixture({ failure: true }).invoke("settings-main", "connect");
  assert.equal(failed.ok, false);
  assert.doesNotMatch(JSON.stringify(failed), /SECRET_FIXTURE_TOKEN|private\/config/);
});

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const flush = () => new Promise(resolve => setImmediate(resolve));

test("Claude notebook IPC coalesces direct installation, then allows retry without prompts", async () => {
  const handlers = new Map(), gate = deferred();
  let confirmations = 0, installs = 0;
  installNotebookClaudeConnectionIpc({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, requireSettingsMainFrame() {},
    confirmConnect: async () => { confirmations++; return true; },
    getConnection: () => ({ connect: async () => { installs++; await gate.promise; return { ok: true, configured: true, state: "installed" }; } }),
  });
  const handler = handlers.get("notebook:claude-connection");
  const a = handler({}, "connect"), b = handler({}, "connect");
  await flush();
  assert.equal(installs, 1);
  gate.resolve();
  assert.deepEqual(await a, await b);
  assert.equal(installs, 1);
  await handler({}, "connect");
  assert.equal(confirmations, 0);
  assert.equal(installs, 2);
});

test("Claude notebook facade releases a failed pending install for retry", async () => {
  let installs = 0;
  const connection = new NotebookClaudeConnection({
    getConfig: () => ({ mcpServers: { "agent-pet-notebook": entry } }),
    integration: { install: () => { if (++installs === 1) throw new Error("failed"); return { ok: true }; } },
  });
  await assert.rejects(connection.connect(), /failed/);
  assert.equal((await connection.connect()).ok, true);
  assert.equal(installs, 2);
});

test("Claude notebook IPC sanitizes returned diagnostics as well as thrown status and connect errors", async () => {
  for (const stage of ["result", "status", "connect"]) {
    const handlers = new Map();
    installNotebookClaudeConnectionIpc({
      ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, requireSettingsMainFrame() {},
      getConnection: () => ({ connect: async () => { throw new Error("SECRET_FIXTURE_TOKEN"); }, status: async () => {
        if (stage === "status") throw new Error("SECRET_FIXTURE_TOKEN");
        return { ok: false, state: "error", message: "SECRET_FIXTURE_TOKEN", paths: "/private/config", backups: ["/private/config"] };
      } }),
    });
    const result = await handlers.get("notebook:claude-connection")({}, stage === "connect" ? "connect" : "status");
    assert.equal(result.ok, false);
    assert.equal(result.state, "error");
    assert.doesNotMatch(JSON.stringify(result), /SECRET_FIXTURE_TOKEN|private\/config/);
  }
});

async function settingsFixture(overrides = {}) {
  const source = await readFile(new URL("../public/settings.js", import.meta.url), "utf8");
  const elements = new Map(["connect-notebook-codex", "notebook-mcp-status", "copy-notebook-mcp", "connect-notebook-claude", "notebook-claude-mcp-status"].map(id => [id, {
    textContent: id === "connect-notebook-claude" ? "一键连接 Claude Code" : "", disabled: false,
    listeners: {}, addEventListener(name, callback) { this.listeners[name] = callback; },
    click() { return this.listeners.click?.({ currentTarget: this }); },
  }]));
  vm.runInNewContext(source.slice(source.indexOf("let notebookConnectionRevision = 0;")), {
    document: { querySelector: selector => elements.get(selector.slice(1)) },
    window: { companion: {
      getNotebookCodexConnection: async () => ({ ok: true, configured: false }),
      getNotebookClaudeConnection: async () => ({ ok: true, configured: false, state: "not-installed" }),
      connectNotebookToClaude: async () => ({ ok: true, configured: true, changed: true, state: "installed" }),
      ...overrides,
    } },
  });
  await flush();
  return Object.fromEntries(elements);
}

test("Claude notebook UI matches Codex pending, changed, repeat and status labels without dialogs", async () => {
  for (const changed of [true, false]) {
    const gate = deferred();
    const result = { ok: true, configured: true, state: "installed", changed };
    const ui = await settingsFixture({
      connectNotebookToClaude: () => gate.promise,
      connectNotebookToCodex: () => gate.promise,
    });
    const a = ui["connect-notebook-claude"].click(), b = ui["connect-notebook-codex"].click();
    assert.equal(ui["connect-notebook-claude"].textContent, ui["connect-notebook-codex"].textContent);
    assert.equal(ui["connect-notebook-claude"].textContent, "正在配置…");
    gate.resolve(result);
    await Promise.all([a, b]);
    assert.equal(ui["notebook-claude-mcp-status"].textContent, ui["notebook-mcp-status"].textContent.replaceAll("Codex", "Claude Code"));
    assert.equal(ui["connect-notebook-claude"].textContent, "检查连接配置");
    await ui["connect-notebook-claude"].click();
    assert.equal(ui["connect-notebook-claude"].disabled, false);
  }
  const ui = await settingsFixture({ getNotebookClaudeConnection: async () => ({ ok: true, configured: true, state: "installed" }),
    getNotebookCodexConnection: async () => ({ ok: true, configured: true }) });
  assert.equal(ui["notebook-claude-mcp-status"].textContent, ui["notebook-mcp-status"].textContent.replaceAll("Codex", "Claude Code"));
});

test("notebook settings keep Claude and Codex status, pending work and stale results independent", async () => {
  const status = deferred(), connect = deferred();
  let calls = 0;
  const ui = await settingsFixture({
    getNotebookClaudeConnection: () => status.promise,
    connectNotebookToClaude: () => { calls++; return connect.promise; },
    getNotebookCodexConnection: async () => { throw new Error("codex unavailable"); },
    connectNotebookToCodex: async () => ({ ok: true, configured: true, changed: false }),
  });
  const button = ui["connect-notebook-claude"];
  assert.equal(typeof button.listeners.click, "function");
  const first = button.click();
  await button.click();
  assert.equal(calls, 1);
  assert.equal(button.disabled, true);
  assert.equal(ui["connect-notebook-codex"].disabled, false);
  await ui["connect-notebook-codex"].click();
  const codexText = ui["notebook-mcp-status"].textContent;
  connect.resolve({ ok: true, configured: true, changed: true, state: "installed" });
  await first;
  const ready = ui["notebook-claude-mcp-status"].textContent;
  assert.match(ready, /配置已完成/);
  assert.match(ready, /重启此连接|重启 Claude Code/);
  assert.doesNotMatch(ready, /已在线|已连接成功/);
  status.resolve({ ok: false, state: "error" });
  await flush();
  assert.equal(ui["notebook-claude-mcp-status"].textContent, ready);
  assert.equal(ui["notebook-mcp-status"].textContent, codexText);
  assert.equal(button.disabled, false);
});

test("notebook Claude settings explain conflicts, detection and failures without leaking errors", async () => {
  for (const [result, expected] of [
    [{ ok: false, state: "conflict" }, /冲突|同名/],
    [{ ok: true, state: "not-detected", configured: false }, /未检测到/],
    [{ ok: false, state: "error", message: "SECRET_FIXTURE_TOKEN" }, /失败|未能|无法/],
    [null, /失败|未能|无法/],
  ]) {
    const ui = await settingsFixture({ connectNotebookToClaude: async () => {
      if (!result) throw new Error("SECRET_FIXTURE_TOKEN");
      return result;
    } });
    await ui["connect-notebook-claude"].click();
    assert.match(ui["notebook-claude-mcp-status"].textContent, expected);
    assert.doesNotMatch(ui["notebook-claude-mcp-status"].textContent, /SECRET_FIXTURE_TOKEN/);
    assert.equal(ui["connect-notebook-claude"].disabled, false);
    assert.equal(ui["notebook-mcp-status"].textContent, "");
  }
});

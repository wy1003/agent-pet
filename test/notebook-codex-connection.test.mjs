import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NotebookCodexConnection, installNotebookConnectionIpc } from "../desktop/notebook/mcp/codex-connection.mjs";

const name = "agent-pet-notebook";
const desired = { command: "D:/Agent Pet.exe", args: ["D:/app/desktop/notebook/mcp/stdio.mjs", "--connection", "D:/data/connection.json"], env: { ELECTRON_RUN_AS_NODE: "1" } };
async function fixture(t, entry, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-pet-codex-config-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "config.toml"), original = "# retain exact original configuration\nmodel = 'sample'\n";
  await fs.writeFile(file, original);
  const config = { model: "sample", mcp_servers: { other: { command: "keep-me" }, ...(entry ? { [name]: entry } : {}) } };
  const calls = [], closed = []; let version = "v1";
  const connection = new NotebookCodexConnection({
    getConfig: () => ({ mcpServers: { [name]: desired } }), workingDirectory: root,
    resolveExecutable: async () => "codex.exe", ...options,
    createRpc: () => ({ initialize: async () => {}, close: () => closed.push(true),
      request: async (method, params) => {
        calls.push({ method, params });
        if (method === "config/read") return structuredClone({ config, layers: [{ name: { type: "user", file }, version }] });
        assert.equal(method, "config/batchWrite"); assert.equal(params.filePath, file);
        await options.beforeWrite?.({ config, file });
        assert.equal(params.expectedVersion, version, "concurrent config change");
        for (const edit of params.edits) {
          assert.equal(edit.mergeStrategy, "replace");
          const keys = edit.keyPath.split("."); let target = config;
          for (const key of keys.slice(0, -1)) target = target[key] ??= {};
          target[keys.at(-1)] = edit.value;
        }
        version = "v2"; return { status: options.writeStatus || "ok" };
      },
    }),
  });
  return { connection, root, file, original, config, calls, closed, changeVersion: () => { version = "changed-elsewhere"; } };
}

test("one-click Codex config preserves unrelated settings and tool permissions, backs up once and is idempotent", async t => {
  const old = { ...desired, command: "old.exe", enabled: false, disabled_tools: ["notebook_update_plan"], startup_timeout_sec: 42, env: { CUSTOM: "retained" }, default_tools_approval_mode: "prompt" };
  const f = await fixture(t, old);
  assert.deepEqual(await f.connection.status(), { configured: false });
  const first = f.connection.connect(), second = f.connection.connect(); assert.equal(first, second);
  const result = await first; assert.equal(result.changed, true);
  assert.equal(await fs.readFile(result.backup, "utf8"), f.original);
  const saved = f.config.mcp_servers[name];
  assert.equal(saved.command, desired.command); assert.deepEqual(saved.args, desired.args);
  assert.equal(saved.env.CUSTOM, "retained"); assert.equal(saved.env.ELECTRON_RUN_AS_NODE, "1");
  assert.deepEqual(saved.disabled_tools, old.disabled_tools); assert.equal(saved.startup_timeout_sec, 42);
  assert.equal(saved.default_tools_approval_mode, "prompt"); assert.equal(saved.enabled, true);
  assert.equal(f.config.model, "sample"); assert.equal(f.config.mcp_servers.other.command, "keep-me");
  assert.deepEqual(await f.connection.connect(), { configured: true, changed: false });
  assert.equal(f.calls.filter(call => call.method === "config/batchWrite").length, 1);
  assert.equal((await fs.readdir(path.join(f.root, "mcp-config-backups"))).length, 1);
  assert.equal(f.closed.length, 3);
});

test("first-time connection works when Codex has no user config file", async t => {
  const f = await fixture(t); await fs.unlink(f.file);
  const result = await f.connection.connect(); assert.equal(result.changed, true); assert.equal(result.backup, "");
  assert.deepEqual(await f.connection.status(), { configured: true });
});

test("a foreign same-name service is never overwritten", async t => {
  const f = await fixture(t, { url: "https://example.test/mcp" });
  await assert.rejects(f.connection.connect(), /同名连接/);
  assert.equal(f.calls.filter(call => call.method === "config/batchWrite").length, 0);
  assert.equal(await fs.readFile(f.file, "utf8"), f.original); assert.equal(f.closed.length, 1);
});

test("backup failure prevents configuration writes, including ENOENT during backup creation", async t => {
  const f = await fixture(t, undefined, { io: { ...fs, writeFile: async () => { throw Object.assign(new Error("missing backup directory"), { code: "ENOENT" }); } } });
  await assert.rejects(f.connection.connect(), /无法备份/);
  assert.equal(f.calls.filter(call => call.method === "config/batchWrite").length, 0);
  assert.equal(f.closed.length, 1);
});

test("configuration races and overridden writes do not report success", async t => {
  let f;
  f = await fixture(t, undefined, { beforeWrite: () => { f.changeVersion(); f.config.model = "concurrent-choice"; } });
  await assert.rejects(f.connection.connect(), /concurrent config change/);
  assert.equal(f.config.model, "concurrent-choice"); assert.equal(f.config.mcp_servers[name], undefined);
  const overridden = await fixture(t, undefined, { writeStatus: "okOverridden" });
  await assert.rejects(overridden.connection.connect(), /覆盖/);
});

test("connection IPC requires the settings main frame and hides sensitive raw diagnostics", async () => {
  let handler, calls = 0;
  installNotebookConnectionIpc({ ipcMain: { handle: (channel, callback) => { assert.equal(channel, "notebook:codex-connection"); handler = callback; } },
    requireSettingsMainFrame: event => { if (event !== "settings-main") throw Error("Untrusted"); },
    getConnection: () => ({ connect: async () => { calls++; throw Error("parse error: secret=value"); }, status: async () => ({ configured: true }) }),
  });
  await assert.rejects(handler("notebook", "connect"), /Untrusted/);
  await assert.rejects(handler("settings-child", "status"), /Untrusted/);
  await assert.rejects(handler("settings-main", "delete"), /不支持/); assert.equal(calls, 0);
  assert.deepEqual(await handler("settings-main", "status"), { ok: true, configured: true });
  const result = await handler("settings-main", "connect"); assert.equal(result.ok, false); assert.ok(!result.message.includes("secret"));
});

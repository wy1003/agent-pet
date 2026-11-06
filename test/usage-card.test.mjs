import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { renderUsageMeter } from "../public/usage-meter.mjs";

function element(tag) {
  return { tag, children: [], dataset: {}, style: {}, attributes: {}, textContent: "", listeners: {},
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(key, callback) { this.listeners[key] = callback; },
    getBoundingClientRect() { return { width: 300, height: 420 }; },
    classList: { add() {}, remove() {} }, scrollHeight: 420, scrollWidth: 300,
  };
}
const text = node => [node.textContent, ...node.children.map(text)].join(" ");
const read = file => readFile(new URL(`../${file}`, import.meta.url), "utf8");

async function usageHarness(t, getAllUsage) {
  const root = element("main");
  const document = { createElement: element, querySelector: () => root, documentElement: { scrollHeight: 700, scrollWidth: 314 } };
  const previous = globalThis.document;
  globalThis.document = document;
  t.after(() => { globalThis.document = previous; });
  let shown;
  const sizes = [];
  const source = (await read("public/usage-card.js")).replace(/^import .*;\s*/m, "");
  vm.runInNewContext(source, { document, renderUsageMeter, requestAnimationFrame: callback => callback(),
    window: { companion: { getAllUsage, getUsage() { throw new Error("legacy interface must not drive the UI"); },
      onUsageCardShown(callback) { shown = callback; }, resizeUsageCard: size => sizes.push(size) } } });
  return { root, sizes, show: () => shown() };
}

test("usage card displays both providers and refreshes the full collection, not the active provider", async t => {
  const calls = [];
  const h = await usageHarness(t, async options => {
    calls.push(options.force);
    return { activeProviderId: "claude", providers: [
      { providerId: "codex", viewType: "codex-quota", status: "ready", windows: [{ usedPercent: 30, remainingPercent: 70 }] },
      { providerId: "claude", viewType: "claude-quota", status: "unavailable", message: "等待可靠额度数据" },
    ] };
  });
  await h.show();
  assert.deepEqual(calls, [false]);
  assert.equal(h.root.children.length, 2);
  assert.match(text(h.root.children[0]), /Codex.*70%/);
  assert.match(text(h.root.children[1]), /Claude Code.*等待可靠额度数据/);
  assert.doesNotMatch(text(h.root.children[1]), /0%/);
  await h.root.children[0].children[0].children[1].listeners.click();
  assert.deepEqual(calls, [false, true]);
  assert.equal(h.root.attributes["aria-busy"], "false");
  assert.equal(h.sizes.at(-1).height, 434, "measure natural content plus padding, not the clamped viewport");
});

test("usage card retains both identities and retry controls when the whole IPC request fails", async t => {
  const h = await usageHarness(t, async () => { throw new Error("private/path"); });
  await h.show();
  assert.equal(h.root.children.length, 2);
  assert.match(text(h.root), /Codex.*Claude Code/);
  assert.doesNotMatch(text(h.root), /private|0%/);
  for (const card of h.root.children) assert.equal(typeof card.children[0].children[1].listeners.click, "function");
  assert.equal(h.root.attributes["aria-busy"], "false");
});

test("settings source cards are noninteractive automatic discovery status, including legacy snapshots", async () => {
  const source = await read("public/settings.js");
  const start = source.indexOf("function renderAgentProviders(");
  const end = source.indexOf("\nasync function loadStorageLocations", start);
  const list = element("div"), status = element("p");
  const context = { document: { createElement: element }, agentProviderList: list, agentProviderStatus: status };
  vm.runInNewContext(source.slice(start, end), context);
  context.renderAgentProviders({ activeProviderId: "claude", providers: [
    { id: "codex", displayName: "Codex", selected: false, state: "auto" },
    { id: "claude", displayName: "Claude Code", selected: true, state: "unverified" },
  ] });
  assert.equal(list.children.length, 2);
  for (const card of list.children) {
    assert.notEqual(card.tag, "button");
    assert.equal(card.attributes["aria-pressed"], undefined);
    assert.match(text(card), /自动采集/);
  }
  assert.doesNotMatch(text(list) + text(status), /已选择|已连接|已登录|请选择/);
  assert.doesNotMatch(source, /selectAgentProvider|agentProviderList\.addEventListener/);
});

test("Claude optional integration status does not disclose runtime or configuration paths", async () => {
  const source = await read("public/settings.js");
  const start = source.indexOf("async function refreshClaudeStatus()");
  const end = source.indexOf("\nfor (const control", start);
  const status = element("p");
  const context = { claudeStatus: status, window: { companion: { async getClaudeStatus() {
    return { integration: { state: "not-installed", message: "C:/private/config.json", warnings: ["private/location"] },
      runtime: { available: true, executablePath: "C:/private/claude.exe", configDirectory: "C:/private" } };
  } } } };
  vm.runInNewContext(source.slice(start, end), context);
  await context.refreshClaudeStatus();
  assert.doesNotMatch(status.textContent, /private|\.exe|config\.json/);
  assert.match(status.textContent, /可选增强/);
  assert.match(status.textContent, /认证未验证/);
});

test("desktop exposes dual usage IPC with the same trust checks and keeps the old endpoint", async () => {
  const source = await read("desktop/main.mjs");
  const block = source.match(/ipcMain\.handle\("usage:get-all",[\s\S]*?\n  \}\);/);
  assert.ok(block, "usage:get-all handler is registered");
  let handler, called = 0;
  vm.runInNewContext(block[0], { ipcMain: { handle(name, callback) { handler = callback; } },
    requireTrustedSender(event) { if (event !== "trusted") throw new Error("untrusted"); },
    usageProviderRegistry: { async getAllUsage(options) { called++; return { providers: [], force: options.force }; } } });
  await assert.rejects(handler("untrusted", { force: true }), /untrusted/);
  assert.equal(called, 0);
  assert.equal((await handler("trusted", { force: "true" })).force, false);
  assert.equal((await handler("trusted", { force: true })).force, true);
  assert.match(source, /ipcMain\.handle\("usage:get",/);
  const preload = await read("desktop/preload.cjs");
  assert.match(preload, /getAllUsage:\s*\(options\)\s*=>\s*ipcRenderer\.invoke\("usage:get-all", options\)/);
  assert.match(preload, /getUsage:\s*\(options\)\s*=>\s*ipcRenderer\.invoke\("usage:get", options\)/);
  // The identity block must not resolve one global source.
  assert.doesNotMatch(source, /agent:\s*agentProviderRegistry\?\.current\(\)/);
  assert.match(source, /displayName:\s*"Codex \+ Claude Code"/);
});

test("dual usage layout scrolls vertically on small screens and keeps existing dark styles", async () => {
  const css = await read("public/usage-card.css");
  assert.match(css, /overflow-y:\s*auto/);
  assert.match(css, /width:\s*100%/);
  assert.match(css, /prefers-color-scheme:\s*dark/);
  assert.match(css, /#usage-card-root\s*\{[^}]*gap:/);
  assert.match(css, /data-status="unavailable"/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { AiSettingsView } from "../public/ai-settings.js";
import { AiSettingsController } from "../desktop/ai/settings-controller.mjs";
import { AiTextService } from "../desktop/ai/text-service.mjs";
import { normalizeAiPreferences } from "../desktop/ai/preferences.mjs";

function element(id = "") {
  return { id, children: [], value: "", textContent: "", dataset: {}, listeners: {}, attributes: {},
    focus() {},
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, listener) { this.listeners[name] = listener; },
    replaceChildren(...children) { this.children = children; },
    querySelector() { return this.children.find(child => child.value === ""); },
  };
}

async function fixture(t, connectionId = "codex", { keyConfigured = false, modelMode = "pinned", modelId = "old" } = {}) {
  const ids = ["connection", "model-mode", "model", "base-url", "api-key", "clear-key", "check",
    "pinned-row", "http-fields", "key-status", "connection-status", "connection-details", "save-status",
    "status-indicator", "current-model", "detail-connection", "detail-provider", "detail-provider-row",
    "detail-runtime", "detail-runtime-row", "check-description", "base-url-row", "edit-endpoint", "setup-status",
    "connection-summary", "model-mode-row", "model-label", "model-help",
    "connection-row", "empty", "add", "add-panel", "add-cancel", "add-type", "add-http", "add-agent-help",
    "add-url", "add-key", "add-fetch", "add-model-row", "add-model", "add-status", "add-confirm", "add-url-row", "add-edit-endpoint"];
  const elements = Object.fromEntries(ids.map(id => [id, element(`ai-${id}`)]));
  const root = { querySelectorAll: () => Object.values(elements) };
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => element(), activeElement: null };
  t.after(() => { globalThis.document = previousDocument; });
  let preferences = { agent: { activeProviderId: "codex", connections: { codex: true, claude: true } }, ai: normalizeAiPreferences({
    connectionId, modelMode, modelId, connections: { compatible: { baseUrl: "https://api.example.com", defaultModelId: "old" } },
  }) };
  const pending = [];
  let statusListener;
  let connectionsListener;
  const agents = Object.fromEntries(['codex', 'claude'].map(id => [id, { id, state: 'connected', availability: { state: 'available' } }]));
  const service = new AiTextService({ getPreferences: () => preferences,
    providers: new Map([connectionId, "deepseek"].map(id => [id, { open: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) }])),
    onStatus: state => statusListener?.(state),
  });
  t.after(() => service.stop());
  const credentials = new Map(keyConfigured ? [[`ai.${connectionId}`, { baseUrl: preferences.ai.connections[connectionId].baseUrl, apiKey: "fixture-key" }]] : []);
  const controller = new AiSettingsController({ service, credentials: { load: async key => credentials.get(key),
    save: async (key, value) => credentials.set(key, value), clear: async key => credentials.delete(key) },
    preferences: { get: () => preferences, update: async patch => (preferences = { ...preferences, ...patch }) },
    getAgentConnections: () => Object.fromEntries(Object.entries(agents).map(([id, agent]) => [id, {
      ...agent, state: preferences.agent?.connections?.[id] ? agent.state : 'disconnected',
    }])),
  });
  let checkCalls = 0;
  const api = { configureAiConnection: command => controller.configure(command), getAiSettings: () => controller.snapshot(), updateAiSettings: value => controller.update(value),
    checkAiConnection: async () => { checkCalls++; return controller.check(); },
    onAiStatus: listener => { statusListener = listener; },
    onAgentConnectionsChanged: listener => { connectionsListener = listener; },
  };
  const view = new AiSettingsView(root, api);
  view.snapshot = await api.getAiSettings();
  view.render();
  return { view, elements, api, credentials, setPreferences: patch => { preferences = { ...preferences, ...patch }; }, preferences: () => preferences, checkCalls: () => checkCalls,
    changeAgent: (id, patch) => { agents[id] = { ...agents[id], ...patch }; connectionsListener({ providers: Object.values(agents) }); },
    selected: (id = "model") => elements[id].children.find(option => option.value === elements[id].value)?.textContent,
    next: async () => { await new Promise(resolve => setImmediate(resolve)); assert.equal(pending.length, 1); return pending.shift(); },
  };
}

const catalog = { models: [{ id: "old", name: "Old model" }, { id: "new", name: "New model" }], defaultModelId: "old" };
const connection = (value = catalog) => ({ catalog: value, close() {} });

test("add-and-use never switches to an agent that connected but failed availability checking", async t => {
  const f = await fixture(t);
  let saves = 0;
  f.api.connectAgent = async () => ({ claude: { state: 'connected', availability: { state: 'unavailable', message: '请先登录 Claude Code。' } } });
  f.api.updateAiSettings = async () => { saves++; throw new Error('must not select'); };
  f.view.openAdd(); f.elements['add-type'].value = 'claude'; f.view.resetAddType();
  await f.view.configureAdd(true);
  assert.equal(saves, 0);
  assert.equal(f.preferences().ai.connectionId, 'codex');
  assert.match(f.elements['add-status'].textContent, /请先登录/);
});

test("service picker shows configured names, preserves disconnected selection, and has an empty add state", async t => {
  const f = await fixture(t);
  assert.deepEqual(f.view.snapshot.connections.map(item => item.id), ["codex", "claude"]);
  assert.equal(f.selected("connection"), "Codex");
  f.setPreferences({ agent: { connections: { claude: true } } });
  f.view.snapshot = await f.api.getAiSettings(); f.view.render();
  assert.equal(f.elements.connection.value, "codex");
  assert.match(f.selected("connection"), /需重新连接/);
  assert.equal(f.elements["model-mode-row"].hidden, true);
  await f.view.check();
  assert.equal(f.checkCalls(), 0);
  f.setPreferences({ agent: { connections: {} }, ai: normalizeAiPreferences() });
  await f.view.load();
  assert.equal(f.elements["connection-row"].hidden, true);
  assert.match(f.elements.empty.textContent, /暂无可用/);
  assert.equal(f.elements.add.hidden, false);
});

test("live availability filters the picker immediately, including while saving; unavailable choices cannot be selected", async t => {
  const f = await fixture(t);
  let release;
  const update = f.api.updateAiSettings;
  f.api.updateAiSettings = command => new Promise(resolve => { release = () => resolve(update(command)); });
  const saving = f.view.save({ modelMode: 'default' });
  f.changeAgent('claude', { availability: { state: 'checking' } });
  assert.equal(f.elements.connection.children.some(item => item.value === 'claude'), false);
  f.changeAgent('codex', { availability: { state: 'checking' } });
  assert.match(f.selected('connection'), /检查中/);
  assert.doesNotMatch(f.elements.empty.textContent, /不可用/);
  f.changeAgent('codex', { availability: { state: 'unavailable' } });
  assert.match(f.selected('connection'), /不可用/);
  assert.equal(f.elements.connection.disabled, true);
  assert.equal(f.elements['connection-row'].hidden, false, 'keep the original choice visible');
  assert.equal(f.elements['model-mode-row'].hidden, true);
  release();
  await saving;
  assert.equal(f.checkCalls(), 0, 'saving must not check a now unavailable connection');
  assert.deepEqual(f.view.snapshot.connections, [], 'events received during save must be reconciled');
  assert.equal(f.preferences().ai.connectionId, 'codex');
  let saves = 0;
  f.api.updateAiSettings = async () => { saves++; };
  await f.view.save({ connectionId: 'claude' });
  assert.equal(saves, 0);
  assert.equal(f.elements.connection.value, 'codex');
  f.changeAgent('claude', { availability: { state: 'available' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.elements.connection.disabled, false);
  assert.equal(f.elements.connection.children.find(item => item.value === 'codex').disabled, true);
  assert.equal(f.elements.connection.children.find(item => item.value === 'claude').textContent, 'Claude Code');
  assert.equal(f.checkCalls(), 0, 'an unrelated availability change must not recheck the selected service');
});

test("availability updates are not lost during an unsuccessful add flow", async t => {
  const f = await fixture(t);
  let release;
  f.api.connectAgent = () => new Promise(resolve => { release = resolve; });
  f.view.openAdd(); f.elements['add-type'].value = 'claude'; f.view.resetAddType();
  const adding = f.view.configureAdd(true);
  f.changeAgent('codex', { availability: { state: 'unavailable' } });
  f.changeAgent('claude', { availability: { state: 'unavailable' } });
  release({ claude: { state: 'connected', availability: { state: 'unavailable' } } });
  await adding;
  assert.deepEqual(f.view.snapshot.connections, []);
  assert.equal(f.preferences().ai.connectionId, 'codex');
  f.view.closeAdd();
  assert.equal(f.elements.connection.disabled, true);
  assert.match(f.elements.empty.textContent, /不可用/);
  assert.equal(f.elements.add.hidden, false);
});

test("adding HTTP service previews models without changing preferences or saving secrets, cancellation preserves selection", async t => {
  const f = await fixture(t);
  f.view.openAdd();
  f.elements["add-type"].value = "deepseek"; f.view.resetAddType();
  assert.equal(f.elements["add-fetch"].disabled, true);
  f.elements["add-key"].value = "draft-secret";
  f.elements["add-key"].listeners.input();
  const preview = f.elements["add-fetch"].listeners.click();
  (await f.next()).resolve(connection({ ...catalog, defaultModelId: "" }));
  await preview;
  assert.equal(f.elements["add-model-row"].hidden, false);
  assert.equal(f.elements["add-confirm"].disabled, true);
  assert.equal(f.preferences().ai.connectionId, "codex");
  assert.equal(f.credentials.size, 0);
  f.view.closeAdd();
  assert.equal(f.elements["add-key"].value, "");
  assert.equal(f.preferences().ai.connectionId, "codex");
});

test("HTTP service is selected only after a valid model is added; failed drafts keep the original choice", async t => {
  const f = await fixture(t);
  f.view.openAdd();
  f.elements["add-type"].value = "deepseek"; f.view.resetAddType();
  f.elements["add-key"].value = "draft-secret";
  let preview = f.view.configureAdd(false);
  (await f.next()).reject(new Error("401 private-secret"));
  await preview;
  assert.match(f.elements["add-status"].textContent, /认证/);
  assert.doesNotMatch(f.elements["add-status"].textContent, /private-secret/);
  assert.equal(f.preferences().ai.connectionId, "codex");
  preview = f.view.configureAdd(false);
  (await f.next()).resolve(connection()); await preview;
  f.elements["add-model"].value = "new";
  const adding = f.view.configureAdd(true);
  (await f.next()).resolve(connection()); // Confirm against the current catalog before saving.
  (await f.next()).resolve(connection()); // Normal selected-service check.
  await adding;
  assert.equal(f.preferences().ai.connectionId, "deepseek");
  assert.equal(f.preferences().ai.modelId, "new");
  assert.equal(f.credentials.get("ai.deepseek").baseUrl, "https://api.deepseek.com");
  assert.equal(f.elements["add-panel"].hidden, true);
  assert.equal(f.elements["add-key"].value, "");
  assert.equal(f.selected("connection"), "DeepSeek");
});

test("model selection stays pending through save and catalog checking, then displays the verified model", async t => {
  const f = await fixture(t);
  assert.match(f.selected(), /待检查/);
  let checking = f.view.check();
  assert.match(f.selected(), /正在检查/);
  (await f.next()).resolve(connection());
  await checking;
  assert.equal(f.selected(), "Old model");

  f.elements.model.value = "new";
  const saving = f.elements.model.listeners.change();
  const open = await f.next();
  assert.equal(f.preferences().ai.modelId, "new");
  assert.match(f.selected(), /^new（正在检查/);
  assert.doesNotMatch(f.selected(), /不可用/);
  assert.equal(f.elements["connection-status"].dataset.state, "checking");
  assert.equal(f.elements["status-indicator"].dataset.state, "checking");
  assert.equal(f.elements.check.disabled, true);
  open.resolve(connection());
  await saving;
  assert.equal(f.selected(), "New model");
  assert.equal(f.elements["connection-status"].dataset.state, "ready");
  assert.equal(f.elements["status-indicator"].attributes["aria-label"], "连接与模型检查通过");
  assert.equal(f.elements["current-model"].textContent, "new");
  assert.equal(f.elements["save-status"].textContent, "");
  assert.match(f.elements["check-description"].textContent, /实际生成/);
  assert.equal(f.elements.check.disabled, false);
});

test("a missing model is unavailable only after catalog validation; retry clears that verdict immediately", async t => {
  const f = await fixture(t);
  let checking = f.view.check();
  (await f.next()).resolve(connection({ ...catalog, models: [catalog.models[1]] }));
  await checking;
  assert.match(f.selected(), /当前不可用/);
  assert.equal(f.preferences().ai.modelId, "old");
  checking = f.view.check();
  assert.match(f.selected(), /正在检查/);
  assert.doesNotMatch(f.selected(), /不可用/);
  (await f.next()).resolve(connection());
  await checking;
  assert.equal(f.selected(), "Old model");
});

test("connection and IPC failures leave the model unverified and allow retry", async t => {
  const f = await fixture(t);
  const checking = f.view.check();
  (await f.next()).reject(new Error("network failure with private details"));
  await checking;
  assert.match(f.selected(), /未验证/);
  assert.doesNotMatch(f.selected(), /不可用/);
  f.api.checkAiConnection = async () => { throw new Error("IPC failed with private details"); };
  await f.view.check();
  assert.match(f.selected(), /未验证/);
  assert.equal(f.elements["connection-status"].dataset.state, "error");
  assert.equal(f.elements["status-indicator"].dataset.state, "error");
  assert.equal(f.elements.check.disabled, false);
  assert.doesNotMatch(f.elements["connection-status"].textContent, /private/);
  f.api.getAiSettings = async () => { throw new Error("unavailable"); };
  await f.view.load();
  assert.equal(f.elements["connection-status"].dataset.state, "error");
  assert.match(f.elements["connection-status"].textContent, /无法读取/);
});

test("HTTP connections preserve a configured default but only offer model selection after catalog discovery", async t => {
  const f = await fixture(t, "compatible", { keyConfigured: true, modelMode: "default" });
  assert.equal(f.elements["pinned-row"].hidden, true);
  const checking = f.view.check();
  assert.equal(f.elements["pinned-row"].hidden, true);
  (await f.next()).resolve(connection());
  await checking;
  assert.equal(f.elements["pinned-row"].hidden, false);
  assert.equal(f.elements["model-mode-row"].hidden, true);
  assert.equal(f.selected(), "Old model");
});

test("DeepSeek waits for a key, discovers models, then saves an explicit model without guessing the first", async t => {
  const f = await fixture(t, "deepseek", { modelMode: "default", modelId: "" });
  await f.view.load();
  await f.view.check();
  assert.equal(f.checkCalls(), 0);
  assert.equal(f.elements["pinned-row"].hidden, true);
  assert.equal(f.elements["connection-summary"].hidden, true);
  assert.equal(f.elements["base-url-row"].hidden, true);
  assert.match(f.elements["setup-status"].textContent, /填写 API 密钥/);
  f.elements["api-key"].value = "fixture-new-secret";
  const saving = f.elements["api-key"].listeners.change();
  const open = await f.next();
  assert.equal(f.elements["pinned-row"].hidden, true);
  open.resolve(connection({ ...catalog, defaultModelId: "" }));
  await saving;
  assert.equal(f.view.snapshot.keyConfigured, true);
  assert.equal(f.elements["api-key"].value, "");
  assert.equal(f.elements["pinned-row"].hidden, false);
  assert.equal(f.elements.model.value, "");
  assert.equal(f.elements["connection-status"].dataset.state, "unchecked");
  assert.match(f.elements["connection-status"].textContent, /请选择/);
  assert.equal(f.preferences().ai.modelId, "");
  f.elements.model.value = "new";
  const selecting = f.elements.model.listeners.change();
  const recheck = await f.next();
  assert.equal(f.elements["pinned-row"].hidden, false, "keep the fetched list visible during model validation");
  assert.equal(f.elements.model.disabled, true);
  recheck.resolve(connection({ ...catalog, defaultModelId: "" }));
  await selecting;
  assert.equal(f.preferences().ai.modelMode, "pinned");
  assert.equal(f.preferences().ai.modelId, "new");
  assert.equal(f.elements["status-indicator"].dataset.state, "ready");
});

test("removing a key or changing its endpoint hides models and does not request a catalog", async t => {
  const f = await fixture(t, "compatible", { keyConfigured: true });
  const checking = f.view.check();
  (await f.next()).resolve(connection());
  await checking;
  await f.view.saveConnection({ baseUrl: "https://other.example.com" });
  assert.equal(f.checkCalls(), 1);
  assert.equal(f.elements["pinned-row"].hidden, true);
  assert.equal(f.view.snapshot.keyConfigured, false);
  const restoring = f.view.saveConnection({ baseUrl: "https://api.example.com" });
  (await f.next()).resolve(connection());
  await restoring;
  await f.elements["clear-key"].listeners.click();
  assert.equal(f.checkCalls(), 2);
  assert.equal(f.elements["pinned-row"].hidden, true);
  assert.equal(f.view.snapshot.keyConfigured, false);
});

test("authentication failure and failed key saving never expose a stale model list or start another check", async t => {
  const f = await fixture(t, "deepseek", { keyConfigured: true });
  const checking = f.view.check();
  (await f.next()).reject(new Error("401 Unauthorized"));
  await checking;
  assert.equal(f.elements["pinned-row"].hidden, true);
  assert.equal(f.elements["connection-status"].dataset.state, "error");
  f.api.updateAiSettings = async () => { throw new Error("cannot save"); };
  f.elements["api-key"].value = "correction";
  await f.elements["api-key"].listeners.change();
  assert.equal(f.checkCalls(), 1);
  assert.match(f.elements["save-status"].textContent, /保存失败/);
  assert.equal(f.elements["api-key"].value, "correction");
});

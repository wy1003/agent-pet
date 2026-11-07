import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AiSettingsController, installAiSettingsIpc } from "../desktop/ai/settings-controller.mjs";
import { PreferenceStore, normalizePreferences } from "../desktop/preferences.mjs";
import { AiTextService } from "../desktop/ai/text-service.mjs";
import { HttpTextProvider } from "../desktop/ai/http-provider.mjs";

test("old settings migrate to an explicit service without changing notification preferences", () => {
  const old = normalizePreferences({ version: 19, notifications: { voice: { enabled: true, style: { tone: "warm" } } } });
  assert.equal(old.ai.connectionId, "codex");
  assert.equal(old.ai.modelMode, "default");
  assert.equal(old.notifications.voice.enabled, true);
  assert.equal(old.notifications.voice.style.tone, "warm");
  const normalized = normalizePreferences({ ai: { connectionId: "deepseek", modelMode: "pinned", modelId: "old-model", apiKey: "forbidden", connections: { deepseek: { baseUrl: "https://api.example.com", apiKey: "forbidden" } } } });
  assert.equal(normalized.ai.modelId, "old-model");
  assert.doesNotMatch(JSON.stringify(normalized), /forbidden|apiKey/);
});

test("legacy aliases become explicit choices; a fresh install waits for its first service", () => {
  assert.equal(normalizePreferences({ version: 22 }).ai.connectionId, "");
  for (const id of ["codex", "claude"]) {
    const migrated = normalizePreferences({ version: 21, agent: { activeProviderId: id }, ai: { connectionId: "agent", modelMode: "pinned", modelId: "chosen" } });
    assert.equal(migrated.ai.connectionId, id);
    assert.equal(migrated.ai.modelId, "chosen");
    assert.equal(normalizePreferences({ ...migrated, agent: { activeProviderId: "changed" } }).ai.connectionId, id);
  }
});

test("connected but unverified agents stay out of usable AI choices and cannot be newly selected", async () => {
  let preferences = normalizePreferences({ ai: { connectionId: 'codex' }, agent: { connections: { codex: true, claude: true } } });
  const available = new Set(['codex']);
  const controller = new AiSettingsController({
    preferences: { get: () => preferences, update: async patch => (preferences = normalizePreferences({ ...preferences, ...patch })) },
    credentials: { load: async () => null },
    getAgentConnections: () => Object.fromEntries(['codex', 'claude'].map(id => [id, { state: 'connected', availability: { state: available.has(id) ? 'available' : 'checking' } }])),
    service: { snapshot: () => ({ status: 'unchecked' }), configurationChanged() {} },
  });
  assert.deepEqual((await controller.snapshot()).connections.map(item => item.id), ['codex']);
  await assert.rejects(controller.update({ preferences: { connectionId: 'claude' } }), /可用性/);
  assert.equal(preferences.ai.connectionId, 'codex');
  available.add('claude');
  assert.equal((await controller.update({ preferences: { connectionId: 'claude' } })).connectionId, 'claude');
  available.delete('claude');
  assert.equal((await controller.snapshot()).connectionId, 'claude', 'an unavailable existing choice is preserved, never silently switched');
  available.add('claude');
  preferences.agent.connections.claude = false;
  await assert.rejects(controller.update({ preferences: { connectionId: 'claude' } }), /可用性/);
  assert.deepEqual((await controller.snapshot()).connections.map(item => item.id), ['codex'], 'both enabled preference and live availability are required');
});

test("saved connection flags alone never prove availability, and queued selections recheck live state", async () => {
  let preferences = normalizePreferences({ ai: { connectionId: 'codex' }, agent: { connections: { codex: true, claude: true } } });
  let availability = 'available';
  const service = { snapshot: () => ({ status: 'unchecked' }), configurationChanged() {} };
  const controller = new AiSettingsController({
    preferences: { get: () => preferences, update: async patch => (preferences = normalizePreferences({ ...preferences, ...patch })) },
    credentials: { load: async () => null }, service,
  });
  assert.deepEqual((await controller.snapshot()).connections, []);
  await assert.rejects(controller.update({ preferences: { connectionId: 'claude' } }), /可用性/);
  controller.getAgentConnections = () => ({ claude: { state: 'connected', availability: { state: availability } } });
  const save = controller.update({ preferences: { connectionId: 'claude' } });
  availability = 'unavailable';
  await assert.rejects(save, /可用性/);
  assert.equal(preferences.ai.connectionId, 'codex');
});

test("HTTP setup uses draft credentials only for its catalog and commits a validated model without generation", async t => {
  let preferences = normalizePreferences({ ai: { connectionId: "codex" }, agent: { connections: { codex: true } } });
  const secrets = new Map(), requests = [];
  const provider = new HttpTextProvider({ id: "deepseek", name: "DeepSeek", loadKey: async () => secrets.get("ai.deepseek"),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      assert.equal(options.headers.Authorization, "Bearer draft-key");
      return new Response(JSON.stringify({ data: [{ id: "chosen" }] }));
    } });
  const service = new AiTextService({ getPreferences: () => preferences, providers: new Map([["deepseek", provider]]) });
  t.after(() => service.stop());
  const controller = new AiSettingsController({ service,
    getAgentConnections: () => ({ codex: { state: 'connected', availability: { state: 'available' } } }),
    preferences: { get: () => preferences, update: async patch => (preferences = normalizePreferences({ ...preferences, ...patch })) },
    credentials: { load: async key => secrets.get(key), save: async (key, value) => secrets.set(key, value) } });
  const command = { connectionId: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: "draft-key" };
  const preview = await controller.configure(command);
  assert.equal(preview.catalog.models[0].id, "chosen");
  assert.equal(secrets.size, 0);
  assert.equal(preferences.ai.connectionId, "codex");
  assert.equal(service.snapshot().status, "unchecked");
  assert.ok((await controller.configure({ ...command, save: true, modelId: "missing" })).error);
  assert.equal(secrets.size, 0);
  const added = await controller.configure({ ...command, save: true, modelId: "chosen" });
  assert.equal(added.snapshot.connectionId, "deepseek");
  assert.deepEqual(added.snapshot.connections.map(item => item.id), ["codex", "deepseek"]);
  assert.doesNotMatch(JSON.stringify(added), /draft-key/);
  assert.doesNotMatch(JSON.stringify(preferences), /draft-key/);
  assert.ok(requests.every(({ url, options }) => url === "https://api.deepseek.com/models" && options.method === "GET"));
  await controller.update({ preferences: { connectionId: "codex" } });
  const selected = await controller.update({ preferences: { connectionId: "deepseek" } });
  assert.equal(selected.preferences.modelMode, "default");
  assert.equal(selected.preferences.connections.deepseek.defaultModelId, "chosen");
});

test("all AI IPC endpoints require a trusted settings main frame before reading, writing or requesting models", async () => {
  const handlers = new Map();
  let calls = 0;
  installAiSettingsIpc({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    requireSettingsMainFrame: event => { if (!event.trusted) throw new Error("untrusted"); },
    controller: { configure: () => { calls++; return {}; }, snapshot: () => { calls++; return {}; }, update: () => { calls++; return {}; }, check: () => { calls++; return {}; } },
    service: { check: () => { calls++; } },
  });
  for (const handler of handlers.values()) await assert.rejects(handler({ trusted: false }, { apiKey: "secret" }), /untrusted/);
  assert.equal(calls, 0);
  await handlers.get("ai:check")({ trusted: true });
  assert.equal(calls, 1);
});

test("AI settings persist choices and keep endpoint-bound keys exclusively in credential store", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-settings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "preferences.json");
  const preferences = new PreferenceStore(file);
  const secrets = new Map();
  let saved = 0;
  let checked = 0;
  const controller = new AiSettingsController({
    preferences,
    credentials: { load: async key => secrets.get(key), save: async (key, value) => secrets.set(key, value), clear: async key => secrets.delete(key) },
    service: { snapshot: () => ({ status: "unchecked", models: [] }), configurationChanged() {}, check: async () => { checked++; } },
    onSaved: () => saved++,
  });
  const snapshot = await controller.update({ preferences: { connectionId: "deepseek", modelMode: "pinned", modelId: "chosen-model" }, apiKey: "secret-example" });
  assert.equal(snapshot.keyConfigured, true);
  await controller.check();
  assert.equal(checked, 1);
  assert.doesNotMatch(JSON.stringify(snapshot), /secret-example/);
  assert.doesNotMatch(await readFile(file, "utf8"), /secret-example/);
  assert.equal(secrets.get("ai.deepseek").baseUrl, "https://api.deepseek.com");
  const restored = new PreferenceStore(file);
  assert.equal((await restored.load()).ai.modelId, "chosen-model");
  const changed = await controller.update({ preferences: { connections: { deepseek: { baseUrl: "https://other.example" } } } });
  assert.equal(changed.keyConfigured, false);
  await controller.check();
  assert.equal(checked, 1, "changing the endpoint waits for its own key before checking");
  assert.equal(changed.preferences.modelId, "chosen-model");
  await controller.update({ clearKey: true });
  await controller.check();
  assert.equal(checked, 1, "removing a key stops automatic catalog checks");
  assert.equal(secrets.size, 0);
  assert.equal(saved, 3);
});

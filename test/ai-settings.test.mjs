import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AiSettingsController, installAiSettingsIpc } from "../desktop/ai/settings-controller.mjs";
import { PreferenceStore, normalizePreferences } from "../desktop/preferences.mjs";

test("old settings migrate to following the agent default without changing notification preferences", () => {
  const old = normalizePreferences({ version: 19, notifications: { voice: { enabled: true, style: { tone: "warm" } } } });
  assert.equal(old.ai.connectionId, "agent");
  assert.equal(old.ai.modelMode, "default");
  assert.equal(old.notifications.voice.enabled, true);
  assert.equal(old.notifications.voice.style.tone, "warm");
  const normalized = normalizePreferences({ ai: { connectionId: "deepseek", modelMode: "pinned", modelId: "old-model", apiKey: "forbidden", connections: { deepseek: { baseUrl: "https://api.example.com", apiKey: "forbidden" } } } });
  assert.equal(normalized.ai.modelId, "old-model");
  assert.doesNotMatch(JSON.stringify(normalized), /forbidden|apiKey/);
});

test("all AI IPC endpoints require a trusted settings main frame before reading, writing or requesting models", async () => {
  const handlers = new Map();
  let calls = 0;
  installAiSettingsIpc({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    requireSettingsMainFrame: event => { if (!event.trusted) throw new Error("untrusted"); },
    controller: { snapshot: () => { calls++; return {}; }, update: () => { calls++; return {}; } },
    service: { check: () => { calls++; } },
  });
  for (const handler of handlers.values()) await assert.rejects(handler({ trusted: false }, { apiKey: "secret" }), /untrusted/);
  assert.equal(calls, 0);
  await handlers.get("ai:check")({ trusted: true });
  assert.equal(calls, 2);
});

test("AI settings persist choices and keep endpoint-bound keys exclusively in credential store", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-settings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "preferences.json");
  const preferences = new PreferenceStore(file);
  const secrets = new Map();
  let saved = 0;
  const controller = new AiSettingsController({
    preferences,
    credentials: { load: async key => secrets.get(key), save: async (key, value) => secrets.set(key, value), clear: async key => secrets.delete(key) },
    service: { snapshot: () => ({ status: "unchecked", models: [] }), configurationChanged() {} },
    onSaved: () => saved++,
  });
  const snapshot = await controller.update({ preferences: { connectionId: "deepseek", modelMode: "pinned", modelId: "chosen-model" }, apiKey: "secret-example" });
  assert.equal(snapshot.keyConfigured, true);
  assert.doesNotMatch(JSON.stringify(snapshot), /secret-example/);
  assert.doesNotMatch(await readFile(file, "utf8"), /secret-example/);
  assert.equal(secrets.get("ai.deepseek").baseUrl, "https://api.deepseek.com");
  const restored = new PreferenceStore(file);
  assert.equal((await restored.load()).ai.modelId, "chosen-model");
  const changed = await controller.update({ preferences: { connections: { deepseek: { baseUrl: "https://other.example" } } } });
  assert.equal(changed.keyConfigured, false);
  assert.equal(changed.preferences.modelId, "chosen-model");
  await controller.update({ clearKey: true });
  assert.equal(secrets.size, 0);
  assert.equal(saved, 3);
});

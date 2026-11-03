import test from "node:test";
import assert from "node:assert/strict";
import { AiTextService, validateJsonOutput } from "../desktop/ai/text-service.mjs";
import { normalizeAiPreferences } from "../desktop/ai/preferences.mjs";
import { publicAiError } from "../desktop/ai/errors.mjs";

const schema = { type: "object", properties: { text: { type: "string", minLength: 1 } }, required: ["text"], additionalProperties: false };
function fixture() {
  const preferences = { agent: { activeProviderId: "codex" }, ai: normalizeAiPreferences() };
  const catalog = { models: [{ id: "a" }, { id: "b" }], defaultModelId: "a", name: "test" };
  const calls = [];
  let closes = 0;
  const provider = { async open(config, options) {
    calls.push({ type: "open", config, signal: options.signal });
    return { catalog: structuredClone(catalog), close() { closes++; }, async generate(request) {
      calls.push({ type: "generate", ...request });
      return { text: '{"text":"结果"}' };
    } };
  } };
  const service = new AiTextService({ getPreferences: () => preferences, providers: new Map([["codex", provider], ["deepseek", provider]]) });
  return { service, preferences, catalog, calls, provider, closes: () => closes };
}

test("default policy refreshes connection model per new task; fixed policy survives default changes", async () => {
  const f = fixture();
  const first = await f.service.generateJson({ prompt: "one", schema });
  assert.equal(first.generation.modelId, "a");
  f.catalog.defaultModelId = "b";
  assert.equal((await f.service.generateJson({ prompt: "two", schema })).generation.modelId, "b");
  Object.assign(f.preferences.ai, { modelMode: "pinned", modelId: "a" });
  assert.equal((await f.service.generateJson({ prompt: "three", schema })).generation.modelId, "a");
  assert.equal(f.calls.filter(c => c.type === "open").length, 3);
  assert.equal(f.closes(), 3);
});

test("removed pinned/default models stop submission and preserve user choice", async () => {
  const f = fixture();
  Object.assign(f.preferences.ai, { modelMode: "pinned", modelId: "retired" });
  const result = await f.service.check();
  assert.equal(result.code, "model_unavailable");
  assert.match(result.message, /保留原选择/);
  await assert.rejects(f.service.generateJson({ prompt: "one", schema }), { code: "model_unavailable" });
  assert.equal(f.preferences.ai.modelId, "retired");
  f.preferences.ai.modelMode = "default";
  f.catalog.defaultModelId = "retired";
  assert.equal((await f.service.check()).code, "model_unavailable");
  f.catalog.defaultModelId = "";
  assert.equal((await f.service.check()).code, "model_required");
  assert.equal(f.calls.some(c => c.type === "generate"), false);
});

test("following an unsupported agent produces an actionable error without Codex fallback", async () => {
  const f = fixture();
  f.preferences.agent.activeProviderId = "other-agent";
  assert.equal((await f.service.check()).code, "unsupported_connection");
  assert.equal(f.calls.length, 0);
  f.preferences.ai.connectionId = "deepseek";
  assert.equal((await f.service.check()).status, "ready");
});

test("in-flight generation keeps its snapshot; old completion cannot overwrite new connection status", async () => {
  const f = fixture();
  let release;
  let started;
  const begun = new Promise(resolve => { started = resolve; });
  f.provider.open = async () => ({
    catalog: structuredClone(f.catalog), close() {},
    generate: async ({ model }) => { started(model.id); await new Promise(resolve => { release = resolve; }); return { text: '{"text":"旧任务"}' }; },
  });
  const pending = f.service.generateJson({ prompt: "one", schema });
  assert.equal(await begun, "a");
  f.preferences.agent.activeProviderId = "unknown";
  f.service.configurationChanged();
  await f.service.check();
  release();
  assert.equal((await pending).generation.modelId, "a");
  assert.equal(f.service.snapshot().code, "unsupported_connection");
});

test("catalog validation is distinguished from actual generation and rejects invalid output", async () => {
  const f = fixture();
  await f.service.check();
  assert.equal(f.service.snapshot().compatibility, "catalog");
  await f.service.generateJson({ prompt: "one", schema });
  assert.equal(f.service.snapshot().compatibility, "verified");
  f.provider.open = async () => ({ catalog: f.catalog, close() {}, generate: async () => ({ text: '{"wrong":"value"}' }) });
  await assert.rejects(f.service.generateJson({ prompt: "one", schema }), { code: "invalid_output" });
  assert.equal(f.service.snapshot().status, "error");
});

test("runtime errors are actionable and never surface raw provider credentials", async () => {
  const f = fixture();
  f.provider.open = async () => { throw new Error("The model requires a newer version of Codex. secret-key"); };
  assert.equal((await f.service.check()).code, "runtime_incompatible");
  assert.doesNotMatch(JSON.stringify(f.service.snapshot()), /secret-key/);
  assert.doesNotMatch(publicAiError(new Error("secret-key")).message, /secret-key/);
});

test("abort stops provider work and closes the connection", async () => {
  const f = fixture();
  f.provider.open = async (_config, { signal }) => ({
    catalog: f.catalog, close() { f.calls.push("closed"); },
    generate: () => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
  });
  const abort = new AbortController();
  const pending = f.service.generateJson({ prompt: "one", schema, signal: abort.signal });
  await new Promise(resolve => setImmediate(resolve));
  abort.abort();
  await assert.rejects(pending, { code: "cancelled" });
  assert.ok(f.calls.includes("closed"));
});

test("JSON output validates nested object and array constraints", () => {
  const nested = { type: "array", minItems: 1, maxItems: 2, items: schema };
  assert.throws(() => validateJsonOutput([{ text: "" }], nested), { code: "invalid_output" });
  assert.throws(() => validateJsonOutput([{ text: "ok", extra: true }], nested), { code: "invalid_output" });
  assert.deepEqual(validateJsonOutput([{ text: "ok" }], nested), [{ text: "ok" }]);
});

test("a concurrent catalog refresh cannot hide actual incompatibility from generation", async () => {
  const f = fixture();
  let failGeneration;
  f.provider.open = async () => ({ catalog: structuredClone(f.catalog), close() {},
    generate: () => new Promise((_resolve, reject) => { failGeneration = reject; }),
  });
  const generation = f.service.generateJson({ prompt: "one", schema });
  await new Promise(resolve => setImmediate(resolve));
  await f.service.check();
  failGeneration(new Error("The model requires a newer version of Codex"));
  await assert.rejects(generation, { code: "runtime_incompatible" });
  assert.equal(f.service.snapshot().code, "runtime_incompatible");
});

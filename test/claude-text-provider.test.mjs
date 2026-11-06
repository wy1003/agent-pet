import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeAiPreferences, resolveAiConnection } from "../desktop/ai/preferences.mjs";

const { ClaudeTextProvider } = await import("../desktop/ai/claude-provider.mjs").catch((error) => {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  return {};
});
function fixture(events = [{ type: "result", subtype: "success", structured_output: { text: "好" } }]) {
  const calls = [];
  const query = (args) => {
    const item = { args, closed: false };
    calls.push(item);
    return {
      supportedModels: async () => [{ value: "test-model", resolvedModel: "test-model", displayName: "测试模型" }],
      accountInfo: async () => ({ tokenSource: "apiKey" }),
      initializationResult: async () => ({}),
      close: () => { item.closed = true; },
      async *[Symbol.asyncIterator]() { for (const event of events) yield event; },
    };
  };
  return { calls, query };
}
async function inDirectory(run) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "claude-text-"));
  try { await run(cwd); } finally { await rm(cwd, { recursive: true, force: true }); }
}
const schema = { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false };

test("Claude text provider is implemented", () => assert.equal(typeof ClaudeTextProvider, "function"));
test("Claude is an independent text connection and agent-following choice", () => {
  assert.equal(normalizeAiPreferences({ connectionId: "claude" }).connectionId, "claude");
  assert.equal(resolveAiConnection({ agent: { activeProviderId: "claude" }, ai: { connectionId: "agent" } }), "claude");
});
test("checking Claude catalog does not submit a user prompt", () => inDirectory(async (workingDirectory) => {
  const { query, calls } = fixture();
  const connection = await new ClaudeTextProvider({ workingDirectory, query }).open({});
  assert.equal(calls.length, 1);
  assert.notEqual(typeof calls[0].args.prompt, "string");
  assert.equal(calls[0].closed, true);
  assert.equal(connection.catalog.defaultModelId, "default");
  assert.equal(connection.catalog.models.some((model) => model.id === "test-model"), true);
  connection.close();
}));
test("Claude generation disables tools, hooks and persistence, and returns structured JSON", () => inDirectory(async (workingDirectory) => {
  const { query, calls } = fixture();
  const connection = await new ClaudeTextProvider({ workingDirectory, query }).open({});
  const result = await connection.generate({ model: { id: "test-model" }, prompt: "生成", schema });
  assert.deepEqual(JSON.parse(result.text), { text: "好" });
  const options = calls[1].args.options;
  assert.deepEqual(options.tools, []);
  assert.equal(options.strictMcpConfig, true);
  assert.equal(options.settings.disableAllHooks, true);
  assert.equal(options.persistSession, false);
  assert.equal(options.env.AGENT_PET_AUXILIARY, "1");
  assert.equal(options.model, "test-model");
  assert.deepEqual(options.outputFormat, { type: "json_schema", schema });
  assert.equal(calls[1].closed, true);
  connection.close();
}));
test("Claude default generation inherits runtime model, rather than hardcoding a model", () => inDirectory(async (workingDirectory) => {
  const { query, calls } = fixture();
  const connection = await new ClaudeTextProvider({ workingDirectory, query }).open({});
  await connection.generate({ model: { id: "default" }, prompt: "生成", schema });
  assert.equal(Object.hasOwn(calls[1].args.options, "model"), false);
  connection.close();
}));
test("failed Claude result and empty stream are not treated as generated text", () => inDirectory(async (workingDirectory) => {
  for (const events of [[{ type: "result", subtype: "error_during_execution", errors: ["private diagnostic"] }], []]) {
    const { query, calls } = fixture(events);
    const connection = await new ClaudeTextProvider({ workingDirectory, query }).open({});
    await assert.rejects(connection.generate({ model: { id: "default" }, prompt: "生成", schema }), { code: "invalid_response" });
    assert.equal(calls.at(-1).closed, true);
    connection.close();
  }
}));
test("unexpected pinned model change fails instead of silently using another model", () => inDirectory(async (workingDirectory) => {
  const { query } = fixture([{ type: "system", subtype: "init", model: "other-model" }]);
  const connection = await new ClaudeTextProvider({ workingDirectory, query }).open({});
  await assert.rejects(connection.generate({ model: { id: "test-model" }, prompt: "生成", schema }), { code: "model_changed" });
  connection.close();
}));
test("aborted checks and generation never submit another request", () => inDirectory(async (workingDirectory) => {
  const { query, calls } = fixture();
  const provider = new ClaudeTextProvider({ workingDirectory, query });
  await assert.rejects(provider.open({}, { signal: AbortSignal.abort() }), { name: "AbortError" });
  assert.equal(calls.length, 0);
  const connection = await provider.open({});
  await assert.rejects(connection.generate({ model: { id: "default" }, prompt: "生成", schema, signal: AbortSignal.abort() }), { name: "AbortError" });
  assert.equal(calls.length, 1);
  connection.close();
  await assert.rejects(connection.generate({ model: { id: "default" }, prompt: "生成", schema }), { code: "cancelled" });
}));

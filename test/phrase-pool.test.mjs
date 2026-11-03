import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  PhrasePoolGenerator,
  copywriterPrompt,
  PHRASE_POOL_SCHEMA,
} from "../desktop/phrase-generator.mjs";
import {
  PHRASE_POOL_EVENTS,
  PhrasePoolStore,
  phraseStyleFingerprint,
} from "../desktop/phrase-pool.mjs";

function generatedPhrases() {
  return Object.fromEntries(PHRASE_POOL_EVENTS.map((event) => [
    event,
    Array.from({ length: 8 }, (_, index) => `{称呼}，${event} 文案 ${index + 1}。`),
  ]));
}

test("phrase pool fingerprints normalized style values", () => {
  const base = {
    addressee: "哥哥",
    assistantName: "宝宝",
    tone: "cute",
    includeProjectName: true,
    customInstruction: "自然一点",
  };
  assert.equal(
    phraseStyleFingerprint(base),
    phraseStyleFingerprint({ ...base, addressee: "  哥哥  " }),
  );
  assert.notEqual(
    phraseStyleFingerprint(base),
    phraseStyleFingerprint({ ...base, tone: "formal" }),
  );
});

test("phrase pool falls back locally and only uses a matching generated style", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phrase-pool-store-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new PhrasePoolStore(path.join(directory, "phrase-pool.json"));
  const style = { addressee: "哥哥", assistantName: "宝宝", tone: "cute" };

  assert.equal((await store.getPhrases(style)).completed.length, 4);
  await store.saveCodexPool(style, generatedPhrases());
  assert.equal(await store.isFresh(style), true);
  assert.equal((await store.getPhrases(style)).completed.length, 8);
  assert.equal(await store.isFresh({ ...style, tone: "formal" }), false);
  assert.equal((await store.getPhrases({ ...style, tone: "formal" })).completed.length, 4);
});

test("phrase generator uses the shared AI interface and persists model provenance", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-copywriter-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new PhrasePoolStore(path.join(directory, "phrase-pool.json"));
  const runs = [];
  const textService = {
    async generateJson(request) {
      runs.push(request);
      return { value: generatedPhrases(), generation: { connectionId: "deepseek", modelId: "model-a" } };
    },
  };
  const style = {
    addressee: "哥哥",
    assistantName: "宝宝",
    tone: "warm",
    includeProjectName: true,
    customInstruction: "不要过度撒娇",
  };
  const copywriter = new PhrasePoolGenerator({ store, textService });

  await copywriter.generate(style);
  assert.equal(runs.length, 1);
  assert.match(runs[0].prompt, /哥哥/);
  assert.equal(runs[0].schema, PHRASE_POOL_SCHEMA);
  assert.equal(runs[0].purpose, "voice-phrases");
  assert.equal((await store.readRecord()).generation.modelId, "model-a");
  assert.ok(Object.values(PHRASE_POOL_SCHEMA.properties).every(
    (schema) => !("uniqueItems" in schema),
  ));
  assert.equal((await store.getPhrases(style)).completed.length, 8);
});

test("copywriter prompt disables project placeholders when requested", () => {
  assert.match(copywriterPrompt({ includeProjectName: false }), /不要使用\{项目名\}变量/);
});

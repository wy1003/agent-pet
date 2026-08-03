import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CodexCopywriter,
  copywriterPrompt,
  PHRASE_POOL_SCHEMA,
} from "../desktop/codex-copywriter.mjs";
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

test("Codex copywriter uses an isolated read-only SDK task and persists structured output", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-copywriter-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new PhrasePoolStore(path.join(directory, "phrase-pool.json"));
  const workingDirectory = path.join(directory, "AgentPetCopywriter");
  const starts = [];
  const runs = [];
  const createCodex = () => ({
    startThread(options) {
      starts.push(options);
      return {
        async run(prompt, options) {
          runs.push({ prompt, options });
          return { finalResponse: JSON.stringify(generatedPhrases()) };
        },
      };
    },
  });
  const style = {
    addressee: "哥哥",
    assistantName: "宝宝",
    tone: "warm",
    includeProjectName: true,
    customInstruction: "不要过度撒娇",
  };
  const copywriter = new CodexCopywriter({ store, workingDirectory, createCodex });

  await copywriter.generate(style);
  assert.equal(starts.length, 1);
  assert.equal(starts[0].workingDirectory, workingDirectory);
  assert.equal(starts[0].sandboxMode, "read-only");
  assert.equal(starts[0].approvalPolicy, "never");
  assert.equal(starts[0].networkAccessEnabled, false);
  assert.match(runs[0].prompt, /哥哥/);
  assert.ok(runs[0].options.outputSchema);
  assert.ok(Object.values(PHRASE_POOL_SCHEMA.properties).every(
    (schema) => !("uniqueItems" in schema),
  ));
  assert.equal((await store.getPhrases(style)).completed.length, 8);
});

test("copywriter prompt disables project placeholders when requested", () => {
  assert.match(copywriterPrompt({ includeProjectName: false }), /不要使用\{项目名\}变量/);
});

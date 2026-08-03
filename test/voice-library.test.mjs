import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VoiceLibrary } from "../desktop/voice-library.mjs";

test("voice library copies imports into managed storage and survives source removal", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-voice-library-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const libraryRoot = path.join(root, "library");
  await writeFile(source + ".ckpt", "gpt-model");
  await writeFile(source + ".pth", "sovits-model");
  await writeFile(source + ".wav", "reference-audio");

  const library = new VoiceLibrary(libraryRoot);
  const imported = await library.importVoice({
    name: "自定义女声 01",
    gptModelPath: source + ".ckpt",
    sovitsModelPath: source + ".pth",
    referenceAudioPath: source + ".wav",
    promptText: "参考文本",
    promptLanguage: "ja",
  });
  assert.equal(imported.name, "自定义女声 01");
  assert.equal(imported.valid, true);
  assert.equal(await readFile(imported.gptModelPath, "utf8"), "gpt-model");

  await rm(source + ".ckpt");
  await rm(source + ".pth");
  await rm(source + ".wav");
  assert.equal((await library.get(imported.id)).valid, true);
  assert.equal((await library.list()).length, 1);

  const updated = await library.updateVoice(imported.id, {
    name: "自定义女声 01（调整版）",
    promptText: "新的参考文本",
    promptLanguage: "ja",
  });
  assert.equal(updated.name, "自定义女声 01（调整版）");
  assert.equal(updated.promptText, "新的参考文本");
  assert.equal((await library.get(imported.id)).valid, true);

  await assert.rejects(() => library.importVoice({ name: "损坏音色" }), /模型文件/);
  await library.removeVoice(imported.id);
  assert.deepEqual(await library.list(), []);
});

test("voice library rejects duplicate display names", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-voice-library-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = {
    gptModelPath: path.join(root, "voice.ckpt"),
    sovitsModelPath: path.join(root, "voice.pth"),
    referenceAudioPath: path.join(root, "voice.wav"),
  };
  await Promise.all(Object.values(files).map((file) => writeFile(file, "data")));
  const library = new VoiceLibrary(path.join(root, "library"));
  await library.importVoice({ name: "Voice", ...files });
  await assert.rejects(() => library.importVoice({ name: "voice", ...files }), /同名音色/);
});

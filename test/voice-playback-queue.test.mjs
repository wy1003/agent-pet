import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VoicePlaybackQueue } from "../desktop/voice-playback-queue.mjs";

function voicePreferences(engine) {
  return {
    notifications: {
      voice: {
        enabled: true,
        engine,
        voiceId: "system",
        rate: 0,
        pitch: 1,
        volume: 100,
        gptSovits: {
          selectedVoiceId: "voice-test",
          baseUrl: "http://127.0.0.1:9880",
          speed: 1,
          promptLanguage: "zh",
          targetLanguage: "zh",
        },
      },
    },
  };
}

test("voice playback is sequential and queued urgent events overtake normal events", async () => {
  const order = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const queue = new VoicePlaybackQueue({
    cacheDirectory: path.join(os.tmpdir(), `unused-${Date.now()}`),
    getPreferences: () => voicePreferences("windows"),
    synthesizeAudio: async () => { throw new Error("not used"); },
    playAudio: async () => ({ ok: true }),
    speakText: async (text) => {
      order.push(text);
      if (text === "first") await firstGate;
      return { ok: true };
    },
  });
  queue.enqueue({ taskId: "1", event: "completed", text: "first", priority: 50 });
  await new Promise((resolve) => setImmediate(resolve));
  queue.enqueue({ taskId: "2", event: "completed", text: "normal", priority: 50 });
  queue.enqueue({ taskId: "3", event: "failed", text: "urgent", priority: 90 });
  releaseFirst();
  await queue.waitForIdle();
  assert.deepEqual(order, ["first", "urgent", "normal"]);
  await queue.stop();
});

test("GPT-SoVITS pre-generation is reused and its temporary audio is deleted after playback", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "voice-queue-cache-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let syntheses = 0;
  let plays = 0;
  const deliveries = [];
  const queue = new VoicePlaybackQueue({
    cacheDirectory: directory,
    getPreferences: () => voicePreferences("gpt-sovits"),
    synthesizeAudio: async () => {
      syntheses += 1;
      return { audio: Buffer.from("test-audio"), mimeType: "audio/wav" };
    },
    playAudio: async () => {
      plays += 1;
      return { ok: true };
    },
    speakText: async () => ({ ok: true }),
    onDelivery: async (delivery) => deliveries.push(delivery),
  });
  const item = {
    notificationId: "notice-1",
    taskId: "gpt-task",
    event: "completed",
    text: "任务完成。",
    priority: 50,
  };
  const alternative = { taskId: "gpt-task", event: "failed", text: "任务失败。", priority: 90 };
  queue.prepare(item);
  queue.prepare(alternative);
  await queue.waitForIdle();
  assert.equal(syntheses, 2);
  assert.equal((await readdir(directory)).length, 2);
  queue.enqueue(item);
  await queue.waitForIdle();
  assert.equal(syntheses, 2);
  assert.equal(plays, 1);
  assert.deepEqual(deliveries.map((item) => item.status), ["synthesizing", "playing", "played"]);
  assert.equal((await readdir(directory)).length, 0);
  await queue.stop();
});

test("GPT-SoVITS can skip idle pre-generation and still synthesize on delivery", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "voice-queue-lazy-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let syntheses = 0;
  const queue = new VoicePlaybackQueue({
    cacheDirectory: directory,
    getPreferences: () => voicePreferences("gpt-sovits"),
    allowPreGeneration: () => false,
    synthesizeAudio: async () => {
      syntheses += 1;
      return { audio: Buffer.from("lazy-audio"), mimeType: "audio/wav" };
    },
    playAudio: async () => ({ ok: true }),
    speakText: async () => ({ ok: true }),
  });
  const item = {
    notificationId: "notice-lazy",
    taskId: "lazy-task",
    event: "completed",
    text: "按需合成。",
    priority: 50,
  };

  queue.prepare(item);
  await queue.waitForIdle();
  assert.equal(syntheses, 0);
  queue.enqueue(item);
  await queue.waitForIdle();
  assert.equal(syntheses, 1);
  await queue.stop();
});

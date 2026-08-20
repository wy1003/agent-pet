import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const AUDIO_SUFFIX = ".notification-audio";

function voiceSignature(preferences) {
  const voice = preferences?.notifications?.voice || {};
  const gpt = voice.gptSovits || {};
  return createHash("sha256").update(JSON.stringify({
    engine: voice.engine,
    voiceId: voice.voiceId,
    selectedVoiceId: gpt.selectedVoiceId,
    gptModelPath: gpt.gptModelPath,
    sovitsModelPath: gpt.sovitsModelPath,
    referenceAudioPath: gpt.referenceAudioPath,
    promptText: gpt.promptText,
    promptLanguage: gpt.promptLanguage,
    targetLanguage: gpt.targetLanguage,
    speed: gpt.speed,
    baseUrl: gpt.baseUrl,
  })).digest("hex");
}

export class TemporaryAudioCache {
  constructor(rootPath, options = {}) {
    this.rootPath = path.resolve(rootPath);
    this.maxAgeMs = Math.max(60_000, Number(options.maxAgeMs || 24 * 60 * 60 * 1000));
    this.maxBytes = Math.max(1024 * 1024, Number(options.maxBytes || 256 * 1024 * 1024));
  }

  async put(key, audio, mimeType) {
    await mkdir(this.rootPath, { recursive: true });
    const hash = createHash("sha256").update(String(key)).digest("hex").slice(0, 20);
    const filePath = path.join(this.rootPath, `${hash}-${randomUUID()}${AUDIO_SUFFIX}`);
    await writeFile(filePath, audio);
    return { filePath, mimeType: String(mimeType || "audio/wav") };
  }

  async read(entry) {
    return readFile(entry.filePath);
  }

  async remove(entry) {
    if (entry?.filePath) await rm(entry.filePath, { force: true }).catch(() => {});
  }

  async cleanup(now = Date.now()) {
    let entries;
    try {
      entries = await readdir(this.rootPath, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(AUDIO_SUFFIX)) continue;
      const filePath = path.join(this.rootPath, entry.name);
      try {
        const info = await stat(filePath);
        if (now - info.mtimeMs > this.maxAgeMs) await rm(filePath, { force: true });
        else files.push({ filePath, size: info.size, mtimeMs: info.mtimeMs });
      } catch {}
    }
    files.sort((left, right) => right.mtimeMs - left.mtimeMs);
    let retainedBytes = 0;
    for (const file of files) {
      retainedBytes += file.size;
      if (retainedBytes > this.maxBytes) await rm(file.filePath, { force: true }).catch(() => {});
    }
  }
}

export class VoicePlaybackQueue {
  constructor(options) {
    this.getPreferences = options.getPreferences;
    this.synthesizeAudio = options.synthesizeAudio;
    this.playAudio = options.playAudio;
    this.speakText = options.speakText;
    this.allowPreGeneration = options.allowPreGeneration || (() => true);
    this.onDelivery = options.onDelivery || (() => {});
    this.logger = options.logger || console;
    this.cache = options.cache || new TemporaryAudioCache(options.cacheDirectory);
    this.maxQueueLength = Math.max(5, Number(options.maxQueueLength || 30));
    this.maxPreparationJobs = Math.max(5, Number(options.maxPreparationJobs || 20));
    this.maxPreparedFiles = Math.max(5, Number(options.maxPreparedFiles || 20));
    this.queue = [];
    this.queuedKeys = new Set();
    this.prepared = new Map();
    this.preparationJobs = [];
    this.jobsByKey = new Map();
    this.processing = null;
    this.preparing = null;
    this.generation = 0;
    this.stopped = false;
    this.ready = this.cache.cleanup().catch((error) => {
      this.logger.warn("[voice-queue] cache cleanup failed", error);
    });
  }

  async #reportDelivery(item, status, error = "") {
    if (!item?.notificationId) return;
    try {
      await this.onDelivery({
        notificationId: item.notificationId,
        taskId: item.taskId,
        event: item.event,
        status,
        error: String(error || "").slice(0, 300),
      });
    } catch (reportError) {
      this.logger.warn("[voice-queue] unable to persist delivery status", reportError);
    }
  }

  #logicalKey(item) {
    return `${item.taskId}:${item.event}`;
  }

  #preparedKey(item, preferences) {
    return `${this.#logicalKey(item)}:${voiceSignature(preferences)}:${item.text}`;
  }

  prepare(item) {
    if (this.stopped) return;
    const preferences = this.getPreferences();
    if (!preferences.notifications.voice.enabled) return;
    if (preferences.notifications.voice.engine !== "gpt-sovits") return;
    if (!this.allowPreGeneration(preferences)) return;
    this.#ensureAudio(item, Number(item.priority || 0))
      .catch((error) => this.logger.warn("[voice-queue] pre-generation failed", error));
  }

  enqueue(item) {
    if (this.stopped || !item?.taskId || !item?.event || !item?.text) return false;
    const key = this.#logicalKey(item);
    if (this.queuedKeys.has(key)) return false;
    this.#discardAlternatives(item.taskId, item.event);
    this.queuedKeys.add(key);
    this.queue.push({ ...item, priority: Number(item.priority || 0), queuedAt: Date.now() });
    this.queue.sort((left, right) => right.priority - left.priority || left.queuedAt - right.queuedAt);
    while (this.queue.length > this.maxQueueLength) {
      const dropped = this.queue.pop();
      this.queuedKeys.delete(this.#logicalKey(dropped));
    }
    this.#drain().catch((error) => this.logger.warn("[voice-queue] playback loop failed", error));
    return true;
  }

  async #drain() {
    if (this.processing || this.stopped) return this.processing;
    this.processing = (async () => {
      while (this.queue.length && !this.stopped) {
        const item = this.queue.shift();
        const logicalKey = this.#logicalKey(item);
        let playbackEntry = null;
        try {
          const preferences = this.getPreferences();
          if (!preferences.notifications.voice.enabled) {
            await this.#reportDelivery(item, "cancelled", "voice_disabled_before_playback");
            continue;
          }
          if (preferences.notifications.voice.engine === "gpt-sovits") {
            await this.#reportDelivery(item, "synthesizing");
            playbackEntry = await this.#ensureAudio(item, 1_000);
            const audio = await this.cache.read(playbackEntry);
            await this.#reportDelivery(item, "playing");
            const result = await this.playAudio(audio, playbackEntry.mimeType, preferences);
            if (!result?.ok) throw new Error(result?.error || "audio_playback_failed");
          } else {
            await this.#reportDelivery(item, "playing");
            const result = await this.speakText(item.text, preferences);
            if (!result?.ok) throw new Error(result?.error || "speech_playback_failed");
          }
          await this.#reportDelivery(item, "played");
        } catch (error) {
          this.logger.warn(`[voice-queue] ${item.event} delivery failed`, error);
          await this.#reportDelivery(item, "failed", error?.message || error);
        } finally {
          if (playbackEntry) {
            await this.cache.remove(playbackEntry);
            if (this.prepared.get(logicalKey)?.filePath === playbackEntry.filePath) {
              this.prepared.delete(logicalKey);
            }
          }
          this.queuedKeys.delete(logicalKey);
        }
      }
    })();
    try {
      await this.processing;
    } finally {
      this.processing = null;
    }
  }

  #ensureAudio(item, priority) {
    const preferences = this.getPreferences();
    if (preferences.notifications.voice.engine !== "gpt-sovits") {
      return Promise.reject(new Error("GPT-SoVITS is not the selected voice engine"));
    }
    const logicalKey = this.#logicalKey(item);
    const preparedKey = this.#preparedKey(item, preferences);
    const existing = this.prepared.get(logicalKey);
    if (existing?.preparedKey === preparedKey) return Promise.resolve(existing);
    const pending = this.jobsByKey.get(preparedKey);
    if (pending) {
      pending.priority = Math.max(pending.priority, priority);
      this.preparationJobs.sort((left, right) => right.priority - left.priority);
      return pending.promise;
    }
    if (this.preparationJobs.length >= this.maxPreparationJobs && priority < 1_000) {
      return Promise.reject(new Error("audio preparation queue is full"));
    }

    let resolveJob;
    let rejectJob;
    const promise = new Promise((resolve, reject) => {
      resolveJob = resolve;
      rejectJob = reject;
    });
    const job = {
      item: { ...item },
      logicalKey,
      preparedKey,
      signature: voiceSignature(preferences),
      priority,
      generation: this.generation,
      promise,
      resolve: resolveJob,
      reject: rejectJob,
    };
    this.jobsByKey.set(preparedKey, job);
    this.preparationJobs.push(job);
    this.preparationJobs.sort((left, right) => right.priority - left.priority);
    this.#runPreparation().catch((error) => this.logger.warn("[voice-queue] synthesis loop failed", error));
    return promise;
  }

  async #runPreparation() {
    if (this.preparing || this.stopped) return this.preparing;
    this.preparing = (async () => {
      await this.ready;
      while (this.preparationJobs.length && !this.stopped) {
        this.preparationJobs.sort((left, right) => right.priority - left.priority);
        const job = this.preparationJobs.shift();
        try {
          const preferences = this.getPreferences();
          if (job.generation !== this.generation || job.signature !== voiceSignature(preferences)) {
            throw new Error("audio preparation became stale");
          }
          const result = await this.synthesizeAudio(job.item.text, preferences);
          const entry = await this.cache.put(job.preparedKey, result.audio, result.mimeType);
          if (job.generation !== this.generation || job.cancelled || this.stopped) {
            await this.cache.remove(entry);
            throw new Error("audio preparation became stale");
          }
          const previous = this.prepared.get(job.logicalKey);
          if (previous) await this.cache.remove(previous);
          while (this.prepared.size >= this.maxPreparedFiles) {
            const [oldestKey, oldestEntry] = this.prepared.entries().next().value;
            this.prepared.delete(oldestKey);
            await this.cache.remove(oldestEntry);
          }
          const prepared = { ...entry, preparedKey: job.preparedKey };
          this.prepared.set(job.logicalKey, prepared);
          job.resolve(prepared);
        } catch (error) {
          job.reject(error);
        } finally {
          this.jobsByKey.delete(job.preparedKey);
        }
      }
    })();
    try {
      await this.preparing;
    } finally {
      this.preparing = null;
    }
  }

  clearPrepared() {
    this.generation += 1;
    for (const entry of this.prepared.values()) this.cache.remove(entry);
    this.prepared.clear();
    for (const job of this.preparationJobs.splice(0)) {
      this.jobsByKey.delete(job.preparedKey);
      job.reject(new Error("audio preparation cleared"));
    }
  }

  cancelPending() {
    for (const item of this.queue) {
      this.#reportDelivery(item, "cancelled", "voice_queue_cancelled");
    }
    this.queue = [];
    this.queuedKeys.clear();
    this.clearPrepared();
  }

  #discardAlternatives(taskId, retainedEvent) {
    for (const job of this.jobsByKey.values()) {
      if (job.item.taskId === taskId && job.item.event !== retainedEvent) job.cancelled = true;
    }
    for (const [key, entry] of this.prepared) {
      if (!key.startsWith(`${taskId}:`) || key === `${taskId}:${retainedEvent}`) continue;
      this.prepared.delete(key);
      this.cache.remove(entry);
    }
    const retainedJobs = [];
    for (const job of this.preparationJobs) {
      if (job.item.taskId !== taskId || job.item.event === retainedEvent) retainedJobs.push(job);
      else {
        this.jobsByKey.delete(job.preparedKey);
        job.reject(new Error("alternative task outcome is no longer needed"));
      }
    }
    this.preparationJobs = retainedJobs;
  }

  dropTask(taskId) {
    if (!taskId) return;
    this.queue = this.queue.filter((item) => {
      if (item.taskId !== taskId) return true;
      this.#reportDelivery(item, "cancelled", "task_removed");
      this.queuedKeys.delete(this.#logicalKey(item));
      return false;
    });
    for (const [key, entry] of this.prepared) {
      if (!key.startsWith(`${taskId}:`)) continue;
      this.cache.remove(entry);
      this.prepared.delete(key);
    }
    const retainedJobs = [];
    for (const job of this.preparationJobs) {
      if (job.item.taskId !== taskId) retainedJobs.push(job);
      else {
        this.jobsByKey.delete(job.preparedKey);
        job.reject(new Error("task removed"));
      }
    }
    this.preparationJobs = retainedJobs;
  }

  async stop() {
    this.stopped = true;
    this.cancelPending();
    await Promise.allSettled([this.processing, this.preparing]);
    await this.cache.cleanup().catch(() => {});
  }

  async waitForIdle() {
    while (this.processing || this.preparing || this.queue.length || this.preparationJobs.length) {
      await Promise.allSettled([this.processing, this.preparing].filter(Boolean));
      if (!this.processing && !this.preparing && !this.queue.length && !this.preparationJobs.length) break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const VOICE_LANGUAGES = new Set(["zh", "ja", "en", "ko", "yue", "auto"]);
const MODEL_EXTENSIONS = {
  gpt: new Set([".ckpt"]),
  sovits: new Set([".pth"]),
  reference: new Set([".wav", ".mp3", ".flac", ".ogg", ".m4a"]),
};
const MAX_FILE_BYTES = {
  gpt: 4 * 1024 * 1024 * 1024,
  sovits: 4 * 1024 * 1024 * 1024,
  reference: 512 * 1024 * 1024,
};

function cleanName(value) {
  const name = String(value || "").trim().replace(/\s+/g, " ");
  if (!name) throw new Error("请输入音色名称");
  if (name.length > 60) throw new Error("音色名称不能超过 60 个字符");
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(name)) throw new Error("音色名称包含不支持的字符");
  return name;
}

function cleanPromptText(value) {
  return String(value || "").trim().slice(0, 500);
}

function cleanLanguage(value) {
  const language = String(value || "ja");
  return VOICE_LANGUAGES.has(language) ? language : "ja";
}

function assertId(value) {
  const id = String(value || "");
  if (!/^voice-[0-9a-f-]{36}$/i.test(id)) throw new Error("无效的音色 ID");
  return id;
}

async function sourceFile(kind, value) {
  const sourcePath = path.resolve(String(value || ""));
  const extension = path.extname(sourcePath).toLowerCase();
  if (!MODEL_EXTENSIONS[kind]?.has(extension)) {
    const expected = [...MODEL_EXTENSIONS[kind]].join("、");
    throw new Error(`${kind === "reference" ? "参考音频" : "模型"}文件必须是 ${expected}`);
  }
  const details = await stat(sourcePath).catch(() => null);
  if (!details?.isFile()) throw new Error(`找不到文件：${sourcePath}`);
  if (details.size <= 0) throw new Error(`文件为空：${sourcePath}`);
  if (details.size > MAX_FILE_BYTES[kind]) throw new Error(`文件过大：${path.basename(sourcePath)}`);
  return { sourcePath, extension, size: details.size, originalName: path.basename(sourcePath) };
}

async function pathDetails(filePath) {
  const details = await stat(filePath).catch(() => null);
  return details?.isFile() ? details : null;
}

export class VoiceLibrary {
  constructor(rootPath) {
    this.rootPath = path.resolve(rootPath);
    this.queue = Promise.resolve();
  }

  runWrite(operation) {
    const pending = this.queue.then(operation);
    this.queue = pending.catch(() => {});
    return pending;
  }

  async ensureRoot() {
    await mkdir(this.rootPath, { recursive: true });
  }

  async list() {
    await this.ensureRoot();
    const entries = await readdir(this.rootPath, { withFileTypes: true });
    const voices = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("voice-")) continue;
      try {
        voices.push(await this.readVoice(entry.name));
      } catch {
        // Ignore incomplete or corrupt directories; imports are committed only after validation.
      }
    }
    return voices.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  }

  async readVoice(value) {
    const id = assertId(value);
    const directory = path.join(this.rootPath, id);
    const manifest = JSON.parse(await readFile(path.join(directory, "voice.json"), "utf8"));
    if (manifest.id !== id || manifest.version !== 1) throw new Error("音色清单无效");
    const referenceExtension = String(manifest.files?.referenceExtension || "").toLowerCase();
    if (!MODEL_EXTENSIONS.reference.has(referenceExtension)) throw new Error("参考音频类型无效");
    const paths = {
      gptModelPath: path.join(directory, "gpt.ckpt"),
      sovitsModelPath: path.join(directory, "sovits.pth"),
      referenceAudioPath: path.join(directory, `reference${referenceExtension}`),
    };
    const details = await Promise.all(Object.values(paths).map(pathDetails));
    const missingFiles = Object.keys(paths).filter((_key, index) => !details[index]);
    const sizeBytes = details.reduce((total, item) => total + (item?.size || 0), 0);
    return {
      id,
      name: cleanName(manifest.name),
      promptText: cleanPromptText(manifest.promptText),
      promptLanguage: cleanLanguage(manifest.promptLanguage),
      originalFiles: {
        gpt: String(manifest.originalFiles?.gpt || "gpt.ckpt").slice(0, 260),
        sovits: String(manifest.originalFiles?.sovits || "sovits.pth").slice(0, 260),
        reference: String(manifest.originalFiles?.reference || `reference${referenceExtension}`).slice(0, 260),
      },
      ...paths,
      sizeBytes,
      valid: missingFiles.length === 0,
      missingFiles,
    };
  }

  async get(id) {
    return this.readVoice(id);
  }

  importVoice(input) {
    return this.runWrite(async () => {
      await this.ensureRoot();
      const name = cleanName(input?.name);
      const existing = await this.list();
      if (existing.some((voice) => voice.name.localeCompare(name, undefined, { sensitivity: "accent" }) === 0)) {
        throw new Error("已经存在同名音色，请换一个名称");
      }

      const [gpt, sovits, reference] = await Promise.all([
        sourceFile("gpt", input?.gptModelPath),
        sourceFile("sovits", input?.sovitsModelPath),
        sourceFile("reference", input?.referenceAudioPath),
      ]);
      const id = `voice-${randomUUID()}`;
      const temporaryDirectory = path.join(this.rootPath, `.importing-${id}`);
      const finalDirectory = path.join(this.rootPath, id);
      await mkdir(temporaryDirectory, { recursive: false });
      try {
        await Promise.all([
          copyFile(gpt.sourcePath, path.join(temporaryDirectory, "gpt.ckpt")),
          copyFile(sovits.sourcePath, path.join(temporaryDirectory, "sovits.pth")),
          copyFile(reference.sourcePath, path.join(temporaryDirectory, `reference${reference.extension}`)),
        ]);
        const copied = await Promise.all([
          stat(path.join(temporaryDirectory, "gpt.ckpt")),
          stat(path.join(temporaryDirectory, "sovits.pth")),
          stat(path.join(temporaryDirectory, `reference${reference.extension}`)),
        ]);
        if (copied[0].size !== gpt.size || copied[1].size !== sovits.size || copied[2].size !== reference.size) {
          throw new Error("音色文件复制不完整，请重试");
        }
        const manifest = {
          version: 1,
          id,
          name,
          promptText: cleanPromptText(input?.promptText),
          promptLanguage: cleanLanguage(input?.promptLanguage),
          files: { referenceExtension: reference.extension },
          originalFiles: {
            gpt: gpt.originalName,
            sovits: sovits.originalName,
            reference: reference.originalName,
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        await writeFile(
          path.join(temporaryDirectory, "voice.json"),
          `${JSON.stringify(manifest, null, 2)}\n`,
          "utf8",
        );
        await rename(temporaryDirectory, finalDirectory);
      } catch (error) {
        await rm(temporaryDirectory, { recursive: true, force: true });
        throw error;
      }
      return this.readVoice(id);
    });
  }

  updateVoice(idValue, input) {
    return this.runWrite(async () => {
      const id = assertId(idValue);
      const current = await this.readVoice(id);
      const name = cleanName(input?.name);
      const existing = await this.list();
      if (existing.some((voice) => voice.id !== id
        && voice.name.localeCompare(name, undefined, { sensitivity: "accent" }) === 0)) {
        throw new Error("已经存在同名音色，请换一个名称");
      }
      const manifestPath = path.join(this.rootPath, id, "voice.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.name = name;
      manifest.promptText = cleanPromptText(input?.promptText);
      manifest.promptLanguage = cleanLanguage(input?.promptLanguage);
      manifest.updatedAt = new Date().toISOString();
      const temporaryManifest = path.join(this.rootPath, id, `.voice-${randomUUID()}.json`);
      const backupManifest = path.join(this.rootPath, id, `.voice-backup-${randomUUID()}.json`);
      await writeFile(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      await rename(manifestPath, backupManifest);
      try {
        await rename(temporaryManifest, manifestPath);
        await rm(backupManifest, { force: true });
      } catch (error) {
        await rm(temporaryManifest, { force: true });
        await rename(backupManifest, manifestPath).catch(() => {});
        throw error;
      }
      return this.readVoice(id);
    });
  }

  removeVoice(idValue) {
    return this.runWrite(async () => {
      const id = assertId(idValue);
      await this.readVoice(id);
      const directory = path.join(this.rootPath, id);
      const deletingDirectory = path.join(this.rootPath, `.deleting-${id}-${randomUUID()}`);
      await rename(directory, deletingDirectory);
      await rm(deletingDirectory, { recursive: true, force: true });
      return { ok: true, id };
    });
  }
}

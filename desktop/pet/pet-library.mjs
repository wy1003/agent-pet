import { createHash, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { unzipSync } from "fflate";

const MAX_ZIP_BYTES = 50 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_ENTRY_BYTES = 12 * 1024 * 1024;
const MAX_ENTRIES = 64;

export const SPRITE_PET_CONTRACTS = Object.freeze({
  1: Object.freeze({ columns: 8, rows: 9, width: 1536, height: 1872 }),
  2: Object.freeze({ columns: 8, rows: 11, width: 1536, height: 2288 }),
});

const SPRITE_IMAGE_EXTENSIONS = new Set([".png", ".webp"]);

export const GIF_PET_STATES = Object.freeze({
  idle: 6,
  "running-right": 8,
  "running-left": 8,
  waving: 4,
  jumping: 5,
  failed: 8,
  waiting: 6,
  running: 6,
  review: 6,
  "look-right-side": 8,
  "look-left-side": 8,
});

const PET_STATE_NAMES = Object.keys(GIF_PET_STATES);
const STATE_SUFFIXES = [...PET_STATE_NAMES].sort((left, right) => right.length - left.length);

function petError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safePetId(value) {
  const id = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
    throw petError("invalid_pet_id", "GIF 文件前缀只能包含英文字母、数字、短横线或下划线");
  }
  return id;
}

function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw petError("invalid_zip", "找不到 ZIP 中央目录");
}

export function inspectZipContainer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22 || buffer.length > MAX_ZIP_BYTES) {
    throw petError("invalid_zip_size", "ZIP 文件无效或超过 50 MB");
  }
  const end = findEndOfCentralDirectory(buffer);
  const disk = buffer.readUInt16LE(end + 4);
  const centralDisk = buffer.readUInt16LE(end + 6);
  const count = buffer.readUInt16LE(end + 10);
  const centralSize = buffer.readUInt32LE(end + 12);
  const centralOffset = buffer.readUInt32LE(end + 16);
  if (disk !== 0 || centralDisk !== 0 || count > MAX_ENTRIES
    || centralOffset + centralSize > end || centralOffset + centralSize > buffer.length) {
    throw petError("unsupported_zip", "ZIP 使用了不支持的分卷、ZIP64 或异常目录结构");
  }

  let offset = centralOffset;
  let totalSize = 0;
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw petError("invalid_zip", "ZIP 中央目录已损坏");
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const endOfEntry = offset + 46 + nameLength + extraLength + commentLength;
    if (endOfEntry > buffer.length || compressedSize === 0xffffffff || size === 0xffffffff
      || (flags & 1) !== 0 || ![0, 8].includes(method)) {
      throw petError("unsupported_zip", "ZIP 包含加密、ZIP64 或不支持的压缩格式");
    }
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const normalized = name.replaceAll("\\", "/");
    if (!normalized || normalized.startsWith("/") || /^[a-z]:/i.test(normalized)
      || normalized.split("/").some((part) => part === ".." || part === ".")) {
      throw petError("unsafe_zip_path", "ZIP 中包含不安全的文件路径");
    }
    totalSize += size;
    if (size > MAX_ENTRY_BYTES || totalSize > MAX_UNCOMPRESSED_BYTES) {
      throw petError("zip_too_large", "ZIP 解压后的文件超过安全大小限制");
    }
    entries.push({ name: normalized, size, compressedSize, directory: normalized.endsWith("/") });
    offset = endOfEntry;
  }
  return entries;
}

function skipSubBlocks(buffer, start) {
  let offset = start;
  while (offset < buffer.length) {
    const size = buffer[offset];
    offset += 1;
    if (size === 0) return offset;
    offset += size;
    if (offset > buffer.length) break;
  }
  throw petError("invalid_gif", "GIF 数据块不完整");
}

export function inspectGif(bytes) {
  const buffer = Buffer.from(bytes);
  const signature = buffer.subarray(0, 6).toString("ascii");
  if (buffer.length < 14 || !["GIF87a", "GIF89a"].includes(signature)) {
    throw petError("invalid_gif", "文件不是有效的 GIF");
  }
  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);
  const packed = buffer[10];
  let offset = 13;
  if (packed & 0x80) offset += 3 * (2 ** ((packed & 0x07) + 1));
  let frames = 0;
  let trailer = false;
  while (offset < buffer.length) {
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0x3b) {
      trailer = true;
      break;
    }
    if (marker === 0x21) {
      if (offset >= buffer.length) throw petError("invalid_gif", "GIF 扩展块不完整");
      offset += 1;
      offset = skipSubBlocks(buffer, offset);
      continue;
    }
    if (marker === 0x2c) {
      if (offset + 9 > buffer.length) throw petError("invalid_gif", "GIF 图像描述块不完整");
      const imagePacked = buffer[offset + 8];
      offset += 9;
      if (imagePacked & 0x80) offset += 3 * (2 ** ((imagePacked & 0x07) + 1));
      if (offset >= buffer.length) throw petError("invalid_gif", "GIF 图像数据不完整");
      offset += 1;
      offset = skipSubBlocks(buffer, offset);
      frames += 1;
      continue;
    }
    throw petError("invalid_gif", "GIF 包含无法识别的数据块");
  }
  if (!trailer || frames === 0) throw petError("invalid_gif", "GIF 没有完整动画帧或结束标记");
  return { width, height, frames };
}

function inspectPng(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(signature)
    || buffer.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw petError("invalid_sprite_image", "精灵表不是有效的 PNG 图片");
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const colorType = buffer[25];
  let hasAlpha = colorType === 4 || colorType === 6;
  let offset = 8;
  while (!hasAlpha && offset + 12 <= buffer.length) {
    const size = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const next = offset + 12 + size;
    if (next > buffer.length) throw petError("invalid_sprite_image", "PNG 数据块不完整");
    if (type === "tRNS") hasAlpha = true;
    if (type === "IEND") break;
    offset = next;
  }
  return { format: "png", width, height, hasAlpha };
}

function inspectWebp(buffer) {
  if (buffer.length < 20 || buffer.subarray(0, 4).toString("ascii") !== "RIFF"
    || buffer.subarray(8, 12).toString("ascii") !== "WEBP") {
    throw petError("invalid_sprite_image", "精灵表不是有效的 WebP 图片");
  }
  let width = 0;
  let height = 0;
  let hasAlpha = false;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const type = buffer.subarray(offset, offset + 4).toString("ascii");
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > buffer.length) throw petError("invalid_sprite_image", "WebP 数据块不完整");
    if (type === "ALPH") hasAlpha = true;
    if (type === "VP8X" && size >= 10) {
      hasAlpha ||= Boolean(buffer[start] & 0x10);
      width = 1 + buffer.readUIntLE(start + 4, 3);
      height = 1 + buffer.readUIntLE(start + 7, 3);
    } else if (type === "VP8L" && size >= 5 && buffer[start] === 0x2f) {
      const bits = buffer.readUInt32LE(start + 1);
      width = 1 + (bits & 0x3fff);
      height = 1 + ((bits >>> 14) & 0x3fff);
      hasAlpha ||= Boolean((bits >>> 28) & 1);
    } else if (type === "VP8 " && size >= 10
      && buffer[start + 3] === 0x9d && buffer[start + 4] === 0x01 && buffer[start + 5] === 0x2a) {
      width = buffer.readUInt16LE(start + 6) & 0x3fff;
      height = buffer.readUInt16LE(start + 8) & 0x3fff;
    }
    offset = end + (size % 2);
  }
  if (!width || !height) throw petError("invalid_sprite_image", "无法读取 WebP 精灵表尺寸");
  return { format: "webp", width, height, hasAlpha };
}

export function inspectSpriteImage(bytes, fileName = "") {
  const buffer = Buffer.from(bytes);
  const extension = path.extname(String(fileName || "")).toLowerCase();
  if (extension === ".png") return inspectPng(buffer);
  if (extension === ".webp") return inspectWebp(buffer);
  throw petError("unsupported_sprite_image", "精灵表只支持 PNG 或 WebP");
}

function normalizedArchiveFiles(unzipped) {
  const files = Object.entries(unzipped)
    .map(([name, bytes]) => ({ name: name.replaceAll("\\", "/"), bytes }))
    .filter(({ name }) => !name.endsWith("/") && !name.startsWith("__MACOSX/")
      && !name.endsWith("/.DS_Store") && name !== ".DS_Store");
  const roots = new Set(files.filter(({ name }) => name.includes("/"))
    .map(({ name }) => name.split("/")[0]));
  const hasRootFiles = files.some(({ name }) => !name.includes("/"));
  const stripRoot = !hasRootFiles && roots.size === 1 ? `${[...roots][0]}/` : "";
  return files.map(({ name, bytes }) => ({
    name: stripRoot && name.startsWith(stripRoot) ? name.slice(stripRoot.length) : name,
    bytes,
  }));
}

export function validateGifPetFiles(unzipped) {
  const files = normalizedArchiveFiles(unzipped);
  if (files.length === 0 || files.length > PET_STATE_NAMES.length
    || files.some(({ name }) => name.includes("/"))) {
    throw petError(
      "invalid_pet_archive",
      `ZIP 根目录应包含 1 至 ${PET_STATE_NAMES.length} 个受支持的状态 GIF`,
    );
  }
  const states = {};
  let petId = "";
  for (const { name, bytes } of files) {
    const state = STATE_SUFFIXES.find((candidate) => name.toLowerCase().endsWith(`-${candidate}.gif`));
    if (!state) throw petError("unknown_pet_state", `无法识别宠物状态文件：${name}`);
    const prefix = name.slice(0, -(state.length + 5));
    const currentId = safePetId(prefix);
    if (petId && currentId !== petId) throw petError("mixed_pet_archive", "ZIP 中的 GIF 文件前缀不一致");
    petId = currentId;
    if (states[state]) throw petError("duplicate_pet_state", `宠物状态重复：${state}`);
    const gif = inspectGif(bytes);
    if (gif.width !== 192 || gif.height !== 208 || gif.frames !== GIF_PET_STATES[state]) {
      throw petError(
        "invalid_pet_gif",
        `${name} 应为 192×208、${GIF_PET_STATES[state]} 帧，实际为 ${gif.width}×${gif.height}、${gif.frames} 帧`,
      );
    }
    states[state] = name;
  }
  return { id: petId, displayName: petId, states, files };
}

export function validateSpritePetFiles(unzipped) {
  const files = normalizedArchiveFiles(unzipped);
  if (files.length < 2 || files.some(({ name }) => name.includes("/"))) {
    throw petError("invalid_sprite_archive", "Codex 宠物 ZIP 根目录应包含 pet.json 和精灵表图片");
  }
  const manifests = files.filter(({ name }) => name.toLowerCase() === "pet.json");
  if (manifests.length !== 1 || manifests[0].bytes.length > 64 * 1024) {
    throw petError("invalid_sprite_manifest", "Codex 宠物 ZIP 需要一个有效的 pet.json");
  }
  let manifest;
  try {
    const text = Buffer.from(manifests[0].bytes).toString("utf8").replace(/^\uFEFF/, "");
    manifest = JSON.parse(text);
  } catch {
    throw petError("invalid_sprite_manifest", "pet.json 不是有效的 JSON");
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw petError("invalid_sprite_manifest", "pet.json 内容无效");
  }
  const id = safePetId(manifest.id);
  const version = manifest.spriteVersionNumber == null
    ? 1
    : Number(manifest.spriteVersionNumber);
  if (![1, 2].includes(version)) {
    throw petError("unsupported_sprite_version", "spriteVersionNumber 只支持 1 或 2");
  }
  const originalName = String(manifest.spritesheetPath || "").trim();
  const extension = path.extname(originalName).toLowerCase();
  if (!originalName || path.basename(originalName) !== originalName
    || !SPRITE_IMAGE_EXTENSIONS.has(extension)) {
    throw petError("invalid_spritesheet_path", "spritesheetPath 必须指向 ZIP 根目录中的 PNG 或 WebP");
  }
  const asset = files.find(({ name }) => name === originalName);
  if (!asset) throw petError("missing_spritesheet", `ZIP 中缺少精灵表：${originalName}`);
  const image = inspectSpriteImage(asset.bytes, originalName);
  const contract = SPRITE_PET_CONTRACTS[version];
  if (image.width !== contract.width || image.height !== contract.height) {
    throw petError(
      "invalid_spritesheet_size",
      `v${version} 精灵表应为 ${contract.width}×${contract.height}，实际为 ${image.width}×${image.height}`,
    );
  }
  if (!image.hasAlpha) throw petError("missing_sprite_alpha", "精灵表必须包含透明通道");
  const displayName = String(manifest.displayName || id).trim().slice(0, 80) || id;
  const description = String(manifest.description || "").trim().slice(0, 500);
  return {
    id,
    displayName,
    description,
    format: "spritesheet",
    spriteVersionNumber: version,
    spritesheetPath: originalName,
    width: 192,
    height: 208,
    asset,
    image,
  };
}

export class PetLibrary {
  constructor(rootPath) {
    this.rootPath = path.resolve(rootPath);
  }

  async ensureDirectory() {
    await mkdir(this.rootPath, { recursive: true });
    return this.rootPath;
  }

  async list() {
    await this.ensureDirectory();
    const entries = await readdir(this.rootPath, { withFileTypes: true });
    const pets = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      try {
        pets.push(await this.get(entry.name));
      } catch {}
    }
    return pets.sort((left, right) => left.displayName.localeCompare(right.displayName, "zh-CN"));
  }

  async get(value) {
    const id = safePetId(value);
    const petRoot = path.join(this.rootPath, id);
    const manifest = JSON.parse(await readFile(path.join(petRoot, "pet.json"), "utf8"));
    if (manifest.id !== id) {
      throw petError("invalid_managed_pet", "受管宠物清单无效");
    }
    const format = manifest.format === "state-gifs"
      ? "state-gifs"
      : manifest.format === "spritesheet" || manifest.spritesheetPath
        ? "spritesheet"
        : "";
    if (format === "spritesheet") {
      const version = manifest.spriteVersionNumber == null
        ? 1
        : Number(manifest.spriteVersionNumber);
      const fileName = String(manifest.spritesheetPath || "");
      const contract = SPRITE_PET_CONTRACTS[version];
      if (!contract || path.basename(fileName) !== fileName
        || !SPRITE_IMAGE_EXTENSIONS.has(path.extname(fileName).toLowerCase())) {
        throw petError("invalid_managed_pet", "受管宠物精灵表清单无效");
      }
      const image = inspectSpriteImage(await readFile(path.join(petRoot, fileName)), fileName);
      if (image.width !== contract.width || image.height !== contract.height || !image.hasAlpha) {
        throw petError("invalid_managed_pet", "受管宠物精灵表无效");
      }
      return {
        ...manifest,
        format,
        spriteVersionNumber: version,
        spritesheetPath: fileName,
        width: 192,
        height: 208,
        rootPath: petRoot,
      };
    }
    if (format !== "state-gifs") {
      throw petError("invalid_managed_pet", "受管宠物清单无效");
    }
    const states = {};
    for (const state of PET_STATE_NAMES) {
      const fileName = String(manifest.states?.[state] || "");
      if (!fileName) continue;
      if (path.basename(fileName) !== fileName || !fileName.toLowerCase().endsWith(".gif")) {
        throw petError("invalid_managed_pet", `受管宠物状态文件无效：${state}`);
      }
      await access(path.join(petRoot, fileName));
      states[state] = fileName;
    }
    if (Object.keys(states).length === 0) {
      throw petError("invalid_managed_pet", "受管宠物至少需要一个可用状态");
    }
    return { ...manifest, states, rootPath: petRoot };
  }

  async importZip(zipPath) {
    const absolutePath = path.resolve(String(zipPath || ""));
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile() || fileStat.size > MAX_ZIP_BYTES || path.extname(absolutePath).toLowerCase() !== ".zip") {
      throw petError("invalid_zip_file", "请选择不超过 50 MB 的 ZIP 文件");
    }
    const archive = await readFile(absolutePath);
    inspectZipContainer(archive);
    let unpacked;
    try {
      unpacked = unzipSync(new Uint8Array(archive));
    } catch {
      throw petError("invalid_zip", "ZIP 无法解压或已经损坏");
    }
    const normalizedFiles = normalizedArchiveFiles(unpacked);
    const pet = normalizedFiles.some(({ name }) => name.toLowerCase() === "pet.json")
      ? validateSpritePetFiles(unpacked)
      : { ...validateGifPetFiles(unpacked), format: "state-gifs" };
    await this.ensureDirectory();
    const destination = path.join(this.rootPath, pet.id);
    try {
      await access(destination);
      throw petError("pet_already_exists", `宠物 ${pet.displayName} 已经存在`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    const staging = path.join(this.rootPath, `.staging-${randomUUID()}`);
    await mkdir(staging, { recursive: false });
    try {
      const importedAt = new Date().toISOString();
      let manifest;
      if (pet.format === "spritesheet") {
        await writeFile(path.join(staging, pet.spritesheetPath), pet.asset.bytes);
        manifest = {
          id: pet.id,
          displayName: pet.displayName,
          description: pet.description,
          format: "spritesheet",
          spriteVersionNumber: pet.spriteVersionNumber,
          spritesheetPath: pet.spritesheetPath,
          width: 192,
          height: 208,
          importedAt,
        };
      } else {
        const archivedFiles = new Map(pet.files.map((file) => [file.name, file.bytes]));
        for (const [state, originalName] of Object.entries(pet.states)) {
          const fileName = `${pet.id}-${state}.gif`;
          await writeFile(path.join(staging, fileName), archivedFiles.get(originalName));
          pet.states[state] = fileName;
        }
        manifest = {
          id: pet.id,
          displayName: pet.displayName,
          description: "用户导入的逐状态 GIF 宠物",
          format: "state-gifs",
          spriteVersionNumber: 2,
          width: 192,
          height: 208,
          states: pet.states,
          importedAt,
        };
      }
      const source = {
        kind: "zip-import",
        format: pet.format,
        fileName: path.basename(absolutePath),
        sha256: createHash("sha256").update(archive).digest("hex"),
        importedAt,
      };
      await writeFile(path.join(staging, "pet.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      await writeFile(path.join(staging, "source.json"), `${JSON.stringify(source, null, 2)}\n`, "utf8");
      await rename(staging, destination);
      return this.get(pet.id);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  async remove(value) {
    const id = safePetId(value);
    await rm(path.join(this.rootPath, id), { recursive: true, force: false });
    return { ok: true, id };
  }

  assetPath(value, fileName) {
    const id = safePetId(value);
    const name = String(fileName || "");
    const extension = path.extname(name).toLowerCase();
    if (path.basename(name) !== name || ![".gif", ".png", ".webp"].includes(extension)) {
      throw petError("invalid_pet_asset", "宠物资源路径无效");
    }
    return path.join(this.rootPath, id, name);
  }
}

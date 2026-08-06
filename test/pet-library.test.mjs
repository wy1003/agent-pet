import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import {
  GIF_PET_STATES,
  inspectGif,
  inspectSpriteImage,
  inspectZipContainer,
  PetLibrary,
  SPRITE_PET_CONTRACTS,
  validateGifPetFiles,
  validateSpritePetFiles,
} from "../desktop/pet/pet-library.mjs";
import {
  BUILTIN_PET,
  builtinPetAssetPath,
  builtinPetStateUrls,
} from "../desktop/pet/builtin-pet.mjs";

function gif(frames, width = 192, height = 208) {
  const header = Buffer.alloc(13);
  header.write("GIF89a", 0, "ascii");
  header.writeUInt16LE(width, 6);
  header.writeUInt16LE(height, 8);
  const parts = [header];
  for (let index = 0; index < frames; index += 1) {
    parts.push(Buffer.from([
      0x2c,
      0, 0, 0, 0,
      1, 0, 1, 0,
      0,
      2,
      2, 0x44, 0x01,
      0,
    ]));
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

function archive(id = "sample") {
  const files = {};
  for (const [state, frames] of Object.entries(GIF_PET_STATES)) {
    files[`${id}-${state}.gif`] = gif(frames);
  }
  return Buffer.from(zipSync(files));
}

function webpVp8x(width, height, hasAlpha = true) {
  const buffer = Buffer.alloc(30);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WEBP", 8, "ascii");
  buffer.write("VP8X", 12, "ascii");
  buffer.writeUInt32LE(10, 16);
  buffer[20] = hasAlpha ? 0x10 : 0;
  buffer.writeUIntLE(width - 1, 24, 3);
  buffer.writeUIntLE(height - 1, 27, 3);
  return buffer;
}

function spriteArchive(options = {}) {
  const version = options.version ?? 2;
  const contract = SPRITE_PET_CONTRACTS[version];
  const fileName = options.fileName || "spritesheet.webp";
  const manifest = {
    id: options.id || "native-pet",
    displayName: options.displayName || "原生宠物",
    description: "Codex 原生精灵表宠物",
    spritesheetPath: fileName,
  };
  if (options.includeVersion !== false) manifest.spriteVersionNumber = version;
  return Buffer.from(zipSync({
    "pet.json": Buffer.from(JSON.stringify(manifest)),
    [fileName]: webpVp8x(
      options.width || contract.width,
      options.height || contract.height,
      options.hasAlpha !== false,
    ),
  }));
}

test("built-in kitten provides every validated GIF state", async () => {
  assert.deepEqual(Object.keys(BUILTIN_PET.states), Object.keys(GIF_PET_STATES));
  assert.deepEqual(Object.keys(builtinPetStateUrls()), Object.keys(GIF_PET_STATES));
  const assetDirectory = path.dirname(builtinPetAssetPath(BUILTIN_PET.states.idle));
  const manifest = JSON.parse(await readFile(path.join(assetDirectory, "pet.json"), "utf8"));
  assert.deepEqual(manifest.states, BUILTIN_PET.states);

  for (const [state, expectedFrames] of Object.entries(GIF_PET_STATES)) {
    const content = await readFile(builtinPetAssetPath(BUILTIN_PET.states[state]));
    assert.deepEqual(inspectGif(content), {
      width: 192,
      height: 208,
      frames: expectedFrames,
    });
  }
});

test("GIF pet archive validates the standard state files", () => {
  const zipped = archive();
  assert.equal(inspectZipContainer(zipped).length, 11);
  const files = Object.fromEntries(Object.entries(GIF_PET_STATES)
    .map(([state, frames]) => [`sample-${state}.gif`, gif(frames)]));
  const pet = validateGifPetFiles(files);
  assert.equal(pet.id, "sample");
  assert.equal(Object.keys(pet.states).length, 11);
  assert.deepEqual(inspectGif(files["sample-idle.gif"]), { width: 192, height: 208, frames: 6 });
});

test("GIF pet archive accepts a partial set of supported states", async () => {
  const files = {
    "partial-idle.gif": gif(GIF_PET_STATES.idle),
    "partial-failed.gif": gif(GIF_PET_STATES.failed),
  };
  const pet = validateGifPetFiles(files);
  assert.equal(pet.id, "partial");
  assert.deepEqual(Object.keys(pet.states), ["idle", "failed"]);

  const directory = await mkdtemp(path.join(os.tmpdir(), "partial-pet-library-"));
  const zipPath = path.join(directory, "partial.zip");
  await import("node:fs/promises").then(({ writeFile }) => writeFile(zipPath, Buffer.from(zipSync(files))));
  const library = new PetLibrary(path.join(directory, "pets"));
  const imported = await library.importZip(zipPath);
  assert.deepEqual(Object.keys(imported.states), ["idle", "failed"]);
  assert.deepEqual(Object.keys((await library.get("partial")).states), ["idle", "failed"]);
});

test("Codex native sprite archives validate v1 and v2 atlas contracts", () => {
  const v2Files = {
    "pet.json": Buffer.from(JSON.stringify({
      id: "native-v2",
      displayName: "原生 V2",
      spriteVersionNumber: 2,
      spritesheetPath: "spritesheet.webp",
    })),
    "spritesheet.webp": webpVp8x(1536, 2288),
  };
  const v2 = validateSpritePetFiles(v2Files);
  assert.equal(v2.format, "spritesheet");
  assert.equal(v2.spriteVersionNumber, 2);
  assert.deepEqual(inspectSpriteImage(v2Files["spritesheet.webp"], "spritesheet.webp"), {
    format: "webp",
    width: 1536,
    height: 2288,
    hasAlpha: true,
  });

  const v1 = validateSpritePetFiles({
    "pet.json": Buffer.from(JSON.stringify({
      id: "native-v1",
      spritesheetPath: "spritesheet.webp",
    })),
    "spritesheet.webp": webpVp8x(1536, 1872),
  });
  assert.equal(v1.spriteVersionNumber, 1);
});

test("Codex native sprite archives reject unsafe or incompatible atlases", () => {
  assert.throws(() => validateSpritePetFiles({
    "pet.json": Buffer.from(JSON.stringify({
      id: "unsafe",
      spriteVersionNumber: 2,
      spritesheetPath: "../spritesheet.webp",
    })),
    "spritesheet.webp": webpVp8x(1536, 2288),
  }), /spritesheetPath/);
  assert.throws(() => validateSpritePetFiles({
    "pet.json": Buffer.from(JSON.stringify({
      id: "wrong-size",
      spriteVersionNumber: 2,
      spritesheetPath: "spritesheet.webp",
    })),
    "spritesheet.webp": webpVp8x(1536, 1872),
  }), /1536×2288/);
  assert.throws(() => validateSpritePetFiles({
    "pet.json": Buffer.from(JSON.stringify({
      id: "opaque",
      spriteVersionNumber: 2,
      spritesheetPath: "spritesheet.webp",
    })),
    "spritesheet.webp": webpVp8x(1536, 2288, false),
  }), /透明通道/);
});

test("GIF pet archive rejects mixed prefixes and incorrect frame counts", () => {
  const files = Object.fromEntries(Object.entries(GIF_PET_STATES)
    .map(([state, frames]) => [`sample-${state}.gif`, gif(frames)]));
  files["other-idle.gif"] = files["sample-idle.gif"];
  delete files["sample-idle.gif"];
  assert.throws(() => validateGifPetFiles(files), /前缀不一致/);

  files["sample-idle.gif"] = gif(1);
  delete files["other-idle.gif"];
  assert.throws(() => validateGifPetFiles(files), /应为 192×208、6 帧/);
});

test("pet library imports a ZIP atomically into managed storage", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pet-library-"));
  const zipPath = path.join(directory, "sample-gifs.zip");
  await import("node:fs/promises").then(({ writeFile }) => writeFile(zipPath, archive()));
  const library = new PetLibrary(path.join(directory, "pets"));
  const imported = await library.importZip(zipPath);
  assert.equal(imported.id, "sample");
  assert.equal((await library.list()).length, 1);
  const source = JSON.parse(await readFile(path.join(imported.rootPath, "source.json"), "utf8"));
  assert.equal(source.kind, "zip-import");
  await assert.rejects(() => library.importZip(zipPath), /已经存在/);
  await library.remove("sample");
  assert.deepEqual(await library.list(), []);
});

test("pet library imports and restores a Codex native spritesheet ZIP", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "native-pet-library-"));
  const zipPath = path.join(directory, "native-v2.zip");
  await writeFile(zipPath, spriteArchive({ id: "native-v2", displayName: "原生 V2" }));
  const library = new PetLibrary(path.join(directory, "pets"));
  const imported = await library.importZip(zipPath);
  assert.equal(imported.id, "native-v2");
  assert.equal(imported.displayName, "原生 V2");
  assert.equal(imported.format, "spritesheet");
  assert.equal(imported.spriteVersionNumber, 2);
  assert.equal(imported.spritesheetPath, "spritesheet.webp");
  assert.equal(path.basename(library.assetPath("native-v2", "spritesheet.webp")), "spritesheet.webp");
  const source = JSON.parse(await readFile(path.join(imported.rootPath, "source.json"), "utf8"));
  assert.equal(source.format, "spritesheet");
  assert.equal((await library.list()).length, 1);
});

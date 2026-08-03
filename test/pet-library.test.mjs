import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import {
  GIF_PET_STATES,
  inspectGif,
  inspectZipContainer,
  PetLibrary,
  validateGifPetFiles,
} from "../desktop/pet/pet-library.mjs";

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

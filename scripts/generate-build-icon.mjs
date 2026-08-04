import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { agentPetIconPngBuffer } from "../desktop/app-icon.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetDirectory = path.join(root, "build");
const targetPath = path.join(targetDirectory, "icon.png");
const targetIcoPath = path.join(targetDirectory, "icon.ico");

const source = PNG.sync.read(agentPetIconPngBuffer());
function resizeNearest(size) {
  const icon = new PNG({ width: size, height: size });
  for (let y = 0; y < icon.height; y += 1) {
    const sourceY = Math.min(source.height - 1, Math.floor((y * source.height) / icon.height));
    for (let x = 0; x < icon.width; x += 1) {
      const sourceX = Math.min(source.width - 1, Math.floor((x * source.width) / icon.width));
      const sourceOffset = ((sourceY * source.width) + sourceX) * 4;
      const targetOffset = ((y * icon.width) + x) * 4;
      icon.data[targetOffset] = source.data[sourceOffset];
      icon.data[targetOffset + 1] = source.data[sourceOffset + 1];
      icon.data[targetOffset + 2] = source.data[sourceOffset + 2];
      icon.data[targetOffset + 3] = source.data[sourceOffset + 3];
    }
  }
  return icon;
}

function pngAsIco(pngBuffer) {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt8(0, 6);
  header.writeUInt8(0, 7);
  header.writeUInt8(0, 8);
  header.writeUInt8(0, 9);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(pngBuffer.length, 14);
  header.writeUInt32LE(header.length, 18);
  return Buffer.concat([header, pngBuffer]);
}

const largeIcon = resizeNearest(512);
const windowsIcon = resizeNearest(256);
const largePng = PNG.sync.write(largeIcon);
const windowsPng = PNG.sync.write(windowsIcon);
await mkdir(targetDirectory, { recursive: true });
await Promise.all([
  writeFile(targetPath, largePng),
  writeFile(targetIcoPath, pngAsIco(windowsPng)),
]);
console.log(targetPath);
console.log(targetIcoPath);

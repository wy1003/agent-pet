import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { agentPetIconPngBuffer } from "../desktop/app-icon.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetDirectory = path.join(root, "build");
const targetPath = path.join(targetDirectory, "icon.png");

const source = PNG.sync.read(agentPetIconPngBuffer());
const icon = new PNG({ width: 512, height: 512 });
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
await mkdir(targetDirectory, { recursive: true });
await writeFile(targetPath, PNG.sync.write(icon));
console.log(targetPath);

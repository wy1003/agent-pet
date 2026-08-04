import { copyFile, stat } from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const electronExecutable = require("electron");
const entryPoint = path.join(root, "desktop", "main.mjs");

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} exited with ${result.status}`);
}

async function prepareWindowsExecutable() {
  const target = path.join(path.dirname(electronExecutable), "agent-pet-electron.exe");
  const iconSource = path.join(root, "desktop", "app-icon.mjs");
  const generator = path.join(root, "scripts", "generate-build-icon.mjs");
  if (!process.argv.includes("--refresh")) {
    try {
      const [targetInfo, electronInfo, iconInfo, generatorInfo] = await Promise.all([
        stat(target),
        stat(electronExecutable),
        stat(iconSource),
        stat(generator),
      ]);
      if (targetInfo.mtimeMs >= Math.max(electronInfo.mtimeMs, iconInfo.mtimeMs, generatorInfo.mtimeMs)) {
        return target;
      }
    } catch {}
  }
  run(process.execPath, [generator]);
  const icon = path.join(root, "build", "icon.ico");
  const rcedit = path.join(root, "node_modules", "electron-winstaller", "vendor", "rcedit.exe");
  await copyFile(electronExecutable, target);
  run(rcedit, [
    target,
    "--set-icon", icon,
    "--set-version-string", "ProductName", "Agent Pet",
    "--set-version-string", "FileDescription", "Agent Pet",
    "--set-version-string", "InternalName", "Agent Pet",
    "--set-version-string", "OriginalFilename", "Agent Pet.exe",
  ]);
  return target;
}

const executable = process.platform === "win32"
  ? await prepareWindowsExecutable()
  : electronExecutable;

if (process.argv.includes("--prepare-only")) {
  console.log(executable);
  process.exit(0);
}

const child = spawn(executable, [entryPoint], {
  cwd: root,
  env: { ...process.env, AGENT_PET_DEVELOPMENT: "1" },
  stdio: "inherit",
  windowsHide: false,
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 0;
});

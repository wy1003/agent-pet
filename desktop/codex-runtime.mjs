import { readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

function bundledExecutable(platform, arch) {
  const target = {
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "linux-arm64": "aarch64-unknown-linux-musl",
    "linux-x64": "x86_64-unknown-linux-musl",
    "win32-arm64": "aarch64-pc-windows-msvc",
    "win32-x64": "x86_64-pc-windows-msvc",
  }[`${platform}-${arch}`];
  if (!target) return "";
  try {
    const root = path.dirname(require.resolve(`@openai/codex-${platform}-${arch}/package.json`));
    return path.join(root, "vendor", target, "bin", platform === "win32" ? "codex.exe" : "codex")
      .replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  } catch {
    return "";
  }
}

async function isFile(value) {
  return Boolean(value && await stat(value).then((info) => info.isFile()).catch(() => false));
}

export async function resolveCodexExecutable(explicitPath = "", options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const override = explicitPath || env.AGENT_PET_CODEX_EXECUTABLE;
  if (override) {
    const resolved = path.resolve(override);
    if (!await isFile(resolved)) throw new Error("指定的 Codex 可执行文件不存在");
    return resolved;
  }
  // Use the same runtime that writes Desktop's rollouts. An older bundled CLI
  // can start successfully while silently dropping newer history records.
  if (await isFile(env.CODEX_CLI_PATH)) return env.CODEX_CLI_PATH;
  if (platform === "win32" && env.LOCALAPPDATA) {
    const root = path.join(env.LOCALAPPDATA, "OpenAI", "Codex", "bin");
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const installed = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      const executable = path.join(root, entry.name, "codex.exe");
      const info = await stat(executable).catch(() => null);
      return info?.isFile() ? { executable, modifiedAt: info.mtimeMs } : null;
    }));
    const latest = installed.filter(Boolean).sort((a, b) => b.modifiedAt - a.modifiedAt)[0];
    if (latest) return latest.executable;
  }
  const bundled = options.bundledExecutable ?? bundledExecutable(platform, arch);
  if (await isFile(bundled)) return bundled;
  return platform === "win32" ? "codex.exe" : "codex";
}

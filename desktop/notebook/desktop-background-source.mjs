import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);
const SCRIPT_URL = new URL("./desktop-background-source.ps1", import.meta.url);

export function chooseDesktopBackground(sources, viewport) {
  if (!viewport) return null;
  let selected = null, bestArea = 0;
  for (const source of Array.isArray(sources) ? sources : []) {
    if (!/^window:\d+:0$/.test(source?.id) || ![source.x, source.y, source.width, source.height].every(Number.isFinite)
      || source.width <= 0 || source.height <= 0) continue;
    const width = Math.max(0, Math.min(source.x + source.width, viewport.x + viewport.width) - Math.max(source.x, viewport.x));
    const height = Math.max(0, Math.min(source.y + source.height, viewport.y + viewport.height) - Math.max(source.y, viewport.y));
    if (width * height > bestArea) { bestArea = width * height; selected = source; }
  }
  return selected && { id: selected.id, x: selected.x, y: selected.y, width: selected.width, height: selected.height };
}

/** Metadata only. Frames stay in the notebook renderer; no screenshots are saved. */
export function createDesktopBackgroundSource({ platform = process.platform, execute = run, read = readFile, now = Date.now } = {}) {
  let pending = null, expires = 0, cached = [];
  async function discover() {
    if (platform !== "win32") return [];
    if (now() < expires) return cached;
    if (!pending) pending = (async () => {
      try {
        const script = await read(SCRIPT_URL, "utf8");
        const { stdout } = await execute("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
          { windowsHide: true, timeout: 5000, maxBuffer: 65536, encoding: "utf8" });
        cached = JSON.parse(stdout.replace(/^\uFEFF/, "").trim());
      } catch { cached = []; }
      expires = now() + 5000;
      return cached;
    })().finally(() => { pending = null; });
    return pending;
  }
  return { async get(viewport) { return { supported: platform === "win32", source: chooseDesktopBackground(await discover(), viewport), viewport }; } };
}

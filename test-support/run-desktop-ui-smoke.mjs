import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const source = fileURLToPath(new URL("../", import.meta.url));
const outputBase = path.join(source, "dist");
await mkdir(outputBase, { recursive: true });
const output = await mkdtemp(path.join(outputBase, "claude-ui-smoke-"));
const root = await mkdtemp(path.join(os.tmpdir(), "agent-pet-ui-smoke-"));
await writeFile(path.join(root, ".smoke-fixture"), "isolated desktop test\n");
const environment = { ...process.env, HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"),
  APPDATA: path.join(root, "appdata"), LOCALAPPDATA: path.join(root, "localappdata"),
  TMP: path.join(root, "tmp"), TEMP: path.join(root, "tmp"), TMPDIR: path.join(root, "tmp"),
  CODEX_HOME: path.join(root, "codex"), CLAUDE_CONFIG_DIR: path.join(root, "home", ".claude"),
  AGENT_PET_DEVELOPMENT: "1" };
delete environment.ELECTRON_RUN_AS_NODE;
for (const directory of ["home", "appdata", "localappdata", "tmp", "codex"]) await mkdir(path.join(root, directory));
const child = spawn(require("electron"), [fileURLToPath(new URL("./desktop-ui-smoke-main.mjs", import.meta.url)), root, output], {
  env: environment, cwd: source, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
});
let stdout = "", stderr = "", timedOut = false;
child.stdout.on("data", chunk => { stdout += chunk; });
child.stderr.on("data", chunk => { stderr += chunk; });
const kill = () => {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") spawnSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 5000 });
  else child.kill("SIGKILL");
};
const timer = setTimeout(() => { timedOut = true; kill(); }, 90000);
try {
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  await writeFile(path.join(output, "process.log"), `${stdout}\n${stderr}`);
  const report = await readFile(path.join(output, "report.json"), "utf8").catch(() => "No report written");
  console.log(report);
  console.log(`Artifacts: ${output}`);
  let reportOk = false;
  try { reportOk = JSON.parse(report).ok === true; } catch { /* Missing or partial reports fail verification. */ }
  if (timedOut || code !== 0 || !reportOk) {
    console.error(stderr.slice(-5000));
    process.exitCode = 1;
  }
} finally {
  clearTimeout(timer);
  kill();
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}

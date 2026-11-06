import path from "node:path";
import os from "node:os";
import { mkdir } from "node:fs/promises";
import { CodexActivityCollector } from "../src/collector.mjs";
import { ClaudeActivityCollector } from "../src/claude-collector.mjs";
import { MultiAgentCollector } from "../src/multi-agent-collector.mjs";
import { createCollectorServer } from "../src/server.mjs";

// Process-only fixture: all data stays below the explicit temporary root.
// No Electron startup, credentials, SDK requests, Weixin, or update checks.
if (!process.send || !process.argv[2]) throw new Error("smoke fixture requires an IPC parent and an isolated root");
const root = path.resolve(process.argv[2]);
await mkdir(path.join(root, "codex", "sessions"), { recursive: true });
const collector = new MultiAgentCollector([
  new CodexActivityCollector({ codexHome: path.join(root, "codex"), statePath: path.join(root, "codex-state.json"), pollIntervalMs: 50 }),
  new ClaudeActivityCollector({ eventsDir: path.join(root, "events"), statePath: path.join(root, "claude-state.json"), transcriptsDir: path.join(root, "claude", "projects"), pollIntervalMs: 50 }),
]);
const server = createCollectorServer(collector, { host: "127.0.0.1", port: 0 });
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try {
    await server.stop();
    await collector.stop();
    if (process.connected) process.disconnect();
  } catch {
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  }
}
process.on("message", (message) => { if (message?.type === "stop") void stop(); });
process.on("disconnect", () => { void stop(); });
process.on("SIGTERM", () => { void stop(); });
try {
  await collector.start();
  const address = await server.start();
  process.send({ type: "ready", host: address.address, port: address.port, home: os.homedir(), appData: process.env.APPDATA, localAppData: process.env.LOCALAPPDATA });
} catch (error) {
  await stop();
  throw error;
}

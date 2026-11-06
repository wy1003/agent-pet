import test from "node:test";
import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

const servicePath = fileURLToPath(new URL("../test-support/claude-service-process.mjs", import.meta.url));
const bridgePath = fileURLToPath(new URL("../desktop/claude/hook-bridge.mjs", import.meta.url));

function isolatedEnv(root) {
  return {
    ...process.env,
    HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"),
    APPDATA: path.join(root, "appdata"), LOCALAPPDATA: path.join(root, "localappdata"),
    TMP: path.join(root, "tmp"), TEMP: path.join(root, "tmp"), TMPDIR: path.join(root, "tmp"),
    CODEX_HOME: path.join(root, "codex"), CLAUDE_CONFIG_DIR: path.join(root, "claude"),
    AGENT_PET_AUXILIARY: "0",
  };
}

async function startService(root) {
  const child = fork(servicePath, [root], {
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: isolatedEnv(root),
  });
  let errors = "";
  child.stderr.on("data", (data) => { errors += data; });
  try {
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("service readiness timeout")), 8000);
      child.once("message", (message) => { clearTimeout(timer); resolve(message); });
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`service exited ${code}: ${errors}`)); });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
    assert.equal(ready.type, "ready");
    assert.equal(ready.host, "127.0.0.1");
    assert.equal(ready.home, path.join(root, "home"));
    assert.equal(ready.appData, path.join(root, "appdata"));
    assert.equal(ready.localAppData, path.join(root, "localappdata"));
    assert.ok(ready.port > 0);
    return { child, url: `http://127.0.0.1:${ready.port}`, errors: () => errors };
  } catch (error) {
    child.kill();
    throw error;
  }
}

async function stopService(service) {
  if (!service || service.child.exitCode !== null) return;
  const { child } = service;
  const exited = once(child, "exit");
  const timer = setTimeout(() => child.kill(), 3000);
  try {
    if (child.connected) child.send({ type: "stop" });
    else child.kill();
    const [code] = await exited;
    assert.equal(code, 0, service.errors());
  } finally { clearTimeout(timer); }
}

async function hook(root, event) {
  const child = spawn(process.execPath, [bridgePath, "--events-dir", path.join(root, "events")], {
    windowsHide: true,
    timeout: 5000,
    stdio: ["pipe", "pipe", "pipe"],
    env: isolatedEnv(root),
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; });
  const exited = once(child, "exit");
  child.stdin.end(JSON.stringify(event));
  const [code] = await exited;
  assert.equal(code, 0, stderr);
  assert.equal(stdout, "");
}

async function until(read, accept) {
  const deadline = Date.now() + 5000;
  do {
    const value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 30));
  } while (Date.now() < deadline);
  assert.fail("expected service state was not observed");
}

async function json(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200);
  return response.json();
}

test("isolated processes deliver Hook tasks over HTTP/SSE and preserve read state after restart", { timeout: 25000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-pet-process-中文 "));
  await Promise.all(["project", "home", "appdata", "localappdata", "tmp", "codex", "claude"].map((directory) => mkdir(path.join(root, directory))));
  let service;
  const abort = new AbortController();
  let eventsPromise;
  t.after(async () => {
    abort.abort();
    if (eventsPromise) await eventsPromise.catch(() => {});
    try { await stopService(service); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  service = await startService(root);
  assert.equal((await json(`${service.url}/health`)).ok, true);
  const stream = await fetch(`${service.url}/api/v1/events`, { signal: abort.signal });
  assert.equal(stream.status, 200);
  let events = "";
  eventsPromise = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of stream.body) events += decoder.decode(chunk, { stream: true });
  })();
  eventsPromise.catch(() => {});
  const common = { session_id: "smoke-session", prompt_id: "smoke-turn", cwd: path.join(root, "project") };
  await hook(root, { ...common, event_id: "smoke-start", hook_event_name: "UserPromptSubmit", prompt: "隔离任务", timestamp: new Date().toISOString() });
  await until(() => json(`${service.url}/api/v1/tasks`), (value) => value.tasks.some((task) => task.question === "隔离任务"));
  const terminal = { ...common, event_id: "smoke-stop", hook_event_name: "Stop", last_assistant_message: "模拟完成，没有模型调用", timestamp: new Date().toISOString() };
  await hook(root, terminal);
  const complete = await until(() => json(`${service.url}/api/v1/tasks`), (value) => value.tasks.some((task) => task.status === "completed"));
  assert.equal(complete.tasks.length, 1);
  assert.equal(complete.tasks[0].sessionId, "claude:smoke-session");
  assert.equal(complete.tasks[0].latestResponse, terminal.last_assistant_message);
  await until(async () => events, (value) => value.includes("task.updated") && value.includes("smoke-session"));
  await json(`${service.url}/api/v1/sessions/claude%3Asmoke-session/read`, { method: "POST" });
  const readSessions = (await json(`${service.url}/api/v1/sessions`)).sessions;
  assert.equal(readSessions[0].status.unread, false);
  abort.abort();
  await eventsPromise.catch(() => {});
  await stopService(service);
  service = await startService(root);
  await hook(root, terminal);
  await until(() => readdir(path.join(root, "events")), (files) => files.filter((file) => file.endsWith(".json")).length === 0);
  const restored = await json(`${service.url}/api/v1/sessions`);
  assert.equal(restored.sessions.length, 1);
  assert.equal(restored.sessions[0].status.unread, false);
  assert.equal((await json(`${service.url}/api/v1/tasks?scope=all`)).tasks.length, 1);
});

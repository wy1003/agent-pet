import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { writeHookEvent } from "../desktop/claude/hook-bridge.mjs";

const bridge = fileURLToPath(new URL("../desktop/claude/hook-bridge.mjs", import.meta.url));
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-pet-bridge-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return path.join(root, "中文 路径", "events");
}
function run(input, eventsDir, extraEnv = {}, args = [bridge, "--events-dir", eventsDir]) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { windowsHide: true, timeout: 5000, env: { ...process.env, AGENT_PET_AUXILIARY: "0", ...extraEnv }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

test("writeHookEvent preserves hook fields, adds unique envelope and atomically publishes JSON", async (t) => {
  const eventsDir = await fixture(t);
  const input = { hook_event_name: "UserPromptSubmit", session_id: "../chat", prompt: "中文请求", tool_input: { command: "test" } };
  const files = await Promise.all(Array.from({ length: 8 }, () => writeHookEvent(input, { eventsDir, env: {} })));
  assert.equal(new Set(files).size, 8);
  const names = await readdir(eventsDir);
  assert.equal(names.length, 8);
  assert.ok(names.every((name) => name.endsWith(".json")));
  const saved = JSON.parse(await readFile(files[0], "utf8"));
  assert.equal(saved.prompt, input.prompt);
  assert.deepEqual(saved.tool_input, input.tool_input);
  assert.match(saved.event_id, /^[\da-f-]{36}$/);
  assert.ok(Number.isFinite(Date.parse(saved.timestamp)));
  assert.equal(input.event_id, undefined);
});

test("bridge CLI accepts stdin JSON and Chinese spaced paths without stdout", async (t) => {
  const eventsDir = await fixture(t);
  const result = await run(JSON.stringify({ hook_event_name: "Stop", session_id: "会话", last_assistant_message: "好了" }), eventsDir);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "");
  const [file] = await readdir(eventsDir);
  assert.equal(JSON.parse(await readFile(path.join(eventsDir, file), "utf8")).last_assistant_message, "好了");
});

for (const input of ["{", "{}", " ".repeat(1024 * 1024 + 1)]) {
  test(`bridge rejects ${input.length > 100 ? "oversize" : input} with a diagnostic and nonzero exit`, async (t) => {
    const result = await run(input, await fixture(t));
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, "");
    assert.ok(result.stderr.length);
  });
}

test("auxiliary env suppresses recording even for malformed input", async (t) => {
  const eventsDir = await fixture(t);
  assert.equal(await writeHookEvent({}, { eventsDir, env: { AGENT_PET_AUXILIARY: "1" } }), null);
  const result = await run("{", eventsDir, { AGENT_PET_AUXILIARY: "1" });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
  await assert.rejects(readdir(eventsDir), { code: "ENOENT" });
});

test("invalid JSON diagnostics never echo secret input and create no files", async (t) => {
  const eventsDir = await fixture(t);
  const result = await run("FAKE_SECRET_TOKEN_987", eventsDir);
  assert.notEqual(result.code, 0);
  assert.equal(result.stderr, "Agent Pet hook bridge: hook_event_rejected\n");
  await assert.rejects(readdir(eventsDir), { code: "ENOENT" });
});

test("offline inbox retention enforces count, age and bytes without deleting unrelated files", async (t) => {
  const eventsDir = await fixture(t);
  await mkdir(eventsDir, { recursive: true });
  const foreign = "00000000-0000-4000-8000-000000000000.json";
  await writeFile(path.join(eventsDir, foreign), JSON.stringify({ secret: "keep" }));
  await writeFile(path.join(eventsDir, "notes.json"), "keep");
  await writeFile(path.join(eventsDir, ".writing.tmp"), "keep");
  const retention = { maxFiles: 3, maxBytes: 2500, maxAgeMs: 1000 };
  const input = { session_id: "chat", hook_event_name: "Stop", last_assistant_message: "x".repeat(600) };
  const options = { eventsDir, env: {}, retention };
  const old = await writeHookEvent(input, { ...options, now: () => 1000 });
  await writeHookEvent(input, { ...options, now: () => 3000 });
  await assert.rejects(readFile(old), { code: "ENOENT" });
  await Promise.all(Array.from({ length: 8 }, () => writeHookEvent(input, { ...options, now: () => 3100 })));
  const names = (await readdir(eventsDir)).filter((name) => name.endsWith(".json") && ![foreign, "notes.json"].includes(name));
  assert.ok(names.length > 0 && names.length <= 3);
  const data = await Promise.all(names.map((name) => readFile(path.join(eventsDir, name))));
  assert.ok(data.reduce((sum, value) => sum + value.length, 0) <= 2500);
  for (const name of [foreign, "notes.json", ".writing.tmp"]) assert.ok(await readFile(path.join(eventsDir, name)));
});

test("retention refuses an event larger than its byte budget without leaving temporary files", async (t) => {
  const eventsDir = await fixture(t);
  await assert.rejects(writeHookEvent({ session_id: "chat", prompt: "x".repeat(500) }, {
    eventsDir, env: {}, retention: { maxBytes: 100 },
  }), /budget/);
  assert.deepEqual(await readdir(eventsDir).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error)), []);
});

test("retention also prunes legacy bridge envelopes but not similarly named non-events", async (t) => {
  const eventsDir = await fixture(t);
  await mkdir(eventsDir, { recursive: true });
  const event_id = "11111111-1111-4111-8111-111111111111";
  const file = path.join(eventsDir, `${event_id}.json`);
  await writeFile(file, JSON.stringify({ event_id, timestamp: new Date(0).toISOString(), session_id: "legacy", hook_event_name: "Stop" }));
  await writeHookEvent({ session_id: "new", hook_event_name: "Stop" }, { eventsDir, env: {}, now: () => 2000, retention: { maxFiles: 1, maxAgeMs: 1000 } });
  await assert.rejects(readFile(file), { code: "ENOENT" });
  assert.equal((await readdir(eventsDir)).length, 1);
});

test("import has no stdin, filesystem or output side effects", async (t) => {
  const result = await run("bad", await fixture(t), {}, ["--input-type=module", "-e", `await import(${JSON.stringify(new URL("../desktop/claude/hook-bridge.mjs", import.meta.url).href)});`]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GptSovitsServiceController } from "../desktop/gpt-sovits-service.mjs";

async function installedEngineRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "gpt-sovits-service-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "env"), { recursive: true });
  await mkdir(path.join(root, "source"), { recursive: true });
  await writeFile(
    path.join(root, "installation.json"),
    JSON.stringify({ device: "CPU", source: "ModelScope", version: "test" }),
    "utf8",
  );
  await writeFile(path.join(root, "env", "python.exe"), "", "utf8");
  await writeFile(path.join(root, "source", "api_v2.py"), "", "utf8");
  return root;
}

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 12345;
  child.exitCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    child.exitCode = 0;
    queueMicrotask(() => child.emit("exit", 0, null));
    return true;
  };
  return child;
}

test("GPT-SoVITS service starts hidden, reports status and stops with the owner", async (t) => {
  const root = await installedEngineRoot(t);
  let spawnCall = null;
  const child = fakeChild();
  const controller = new GptSovitsServiceController(root, {
    fetchImpl: async () => { throw new Error("offline"); },
    spawnProcess: (...args) => {
      spawnCall = args;
      return child;
    },
  });

  const starting = await controller.start();
  assert.equal(starting.state, "starting");
  assert.equal(starting.managed, true);
  assert.equal(starting.installation.device, "CPU");
  assert.equal(starting.installation.source, "ModelScope");
  assert.equal(controller.hasManagedProcess(), true);
  assert.equal(spawnCall[0], path.join(root, "env", "python.exe"));
  assert.deepEqual(spawnCall[1].slice(-4), ["-a", "127.0.0.1", "-p", "9880"]);
  assert.equal(spawnCall[2].windowsHide, true);
  assert.deepEqual(spawnCall[2].stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(spawnCall[2].env.PYTHONNOUSERSITE, "1");

  const stopped = await controller.stop();
  assert.equal(stopped.state, "stopped");
  assert.equal(controller.hasManagedProcess(), false);
});

test("GPT-SoVITS service distinguishes an externally running API", async (t) => {
  const root = await installedEngineRoot(t);
  const controller = new GptSovitsServiceController(root, {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ paths: { "/tts": {} } }),
    }),
  });

  const status = await controller.status();
  assert.equal(status.state, "running");
  assert.equal(status.managed, false);
  const stopped = await controller.stop();
  assert.equal(stopped.external, true);
});

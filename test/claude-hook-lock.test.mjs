import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import os from "node:os";
import { writeHookEvent } from "../desktop/claude/hook-bridge.mjs";

for (const code of ["EPERM", "EBUSY"]) {
  test(`Windows lock acquisition retries a transient ${code} without dropping the event`, { skip: process.platform !== "win32" }, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pet-lock-race-"));
    const original = fs.promises.mkdir;
    let attempts = 0;
    const mocked = t.mock.method(fs.promises, "mkdir", async (directory, ...args) => {
      if (String(directory).endsWith(".agent-pet-hook.lock") && ++attempts === 1) {
        throw Object.assign(new Error("simulated Windows delete-pending directory"), { code });
      }
      return original(directory, ...args);
    });
    syncBuiltinESMExports();
    try {
      const result = await writeHookEvent({ session_id: "race", hook_event_name: "Stop" }, { eventsDir: root, env: {} });
      assert.equal(attempts, 2);
      assert.equal(JSON.parse(await readFile(result, "utf8")).session_id, "race");
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("an occupied lock is never removed to force a write", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pet-lock-owned-"));
  const lock = path.join(root, ".agent-pet-hook.lock");
  await fs.promises.mkdir(lock);
  await writeFile(path.join(lock, "owner"), "another writer");
  try {
    await assert.rejects(writeHookEvent({ session_id: "race" }, { eventsDir: root, env: {} }), /Hook inbox busy/);
    assert.equal(await readFile(path.join(lock, "owner"), "utf8"), "another writer");
  } finally { await rm(root, { recursive: true, force: true }); }
});

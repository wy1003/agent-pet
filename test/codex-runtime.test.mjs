import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, utimes, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveCodexExecutable } from "../desktop/codex-runtime.mjs";

test("Codex runtime prefers explicit configuration, active Desktop, then newest installed Desktop over the bundled CLI", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-pet-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundled = path.join(root, "bundled.exe");
  const installed = path.join(root, "OpenAI", "Codex", "bin");
  const older = path.join(installed, "older", "codex.exe");
  const newer = path.join(installed, "newer", "codex.exe");
  for (const file of [bundled, older, newer]) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "");
  }
  await utimes(older, new Date("2026-01-01"), new Date("2026-01-01"));
  await utimes(newer, new Date("2026-02-01"), new Date("2026-02-01"));
  const options = { platform: "win32", env: { LOCALAPPDATA: root }, bundledExecutable: bundled };
  assert.equal(await resolveCodexExecutable("", options), newer);
  options.env.CODEX_CLI_PATH = older;
  assert.equal(await resolveCodexExecutable("", options), older);
  options.env.AGENT_PET_CODEX_EXECUTABLE = newer;
  assert.equal(await resolveCodexExecutable("", options), newer);
  assert.equal(await resolveCodexExecutable(bundled, options), bundled);
  await assert.rejects(resolveCodexExecutable(path.join(root, "missing.exe"), options), /不存在/);
  await assert.rejects(resolveCodexExecutable(root, options), /不存在/);
  assert.equal(await resolveCodexExecutable("", { ...options, env: {} }), bundled);
  assert.equal(await resolveCodexExecutable("", {
    ...options, env: { CODEX_CLI_PATH: root }, bundledExecutable: "",
  }), "codex.exe");
});

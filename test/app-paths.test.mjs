import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DATA_LOCATION_FILE,
  PRODUCT_NAME,
  migrateLegacyUserData,
  productUserDataPath,
  resolveManagedDataRoot,
} from "../desktop/app-paths.mjs";
import {
  COPYWRITER_PROJECT_NAME,
  LEGACY_COPYWRITER_PROJECT_NAME,
  defaultIgnoredProjectPaths,
} from "../src/internal-projects.mjs";

test("Agent Pet migrates only its valid JSON files into the product userData directory", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-pet-user-data-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const legacy = path.join(root, "Electron");
  const target = productUserDataPath(root);
  await mkdir(legacy, { recursive: true });
  await writeFile(path.join(legacy, "preferences.json"), "{\"version\":8}\n", "utf8");
  await writeFile(path.join(legacy, "companion-window.json"), "{not-json", "utf8");

  const warnings = [];
  const migrated = await migrateLegacyUserData({
    targetRoot: target,
    legacyRoots: [legacy],
    logger: { warn: (...values) => warnings.push(values) },
  });

  assert.equal(PRODUCT_NAME, "Agent Pet");
  assert.deepEqual(migrated, ["preferences.json"]);
  assert.deepEqual(JSON.parse(await readFile(path.join(target, "preferences.json"), "utf8")), {
    version: 8,
  });
  assert.equal(warnings.length, 1);
});

test("managed data resolver keeps an existing legacy engine in place and records the choice", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-pet-managed-data-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const localAppData = path.join(root, "Local");
  const userDataPath = path.join(root, "Roaming", "Agent Pet");
  const legacy = path.join(localAppData, "CodexTaskCompanion");
  const preferred = path.join(localAppData, "AgentPet");
  await mkdir(path.join(legacy, "engines", "GPT-SoVITS"), { recursive: true });
  await mkdir(preferred, { recursive: true });
  await writeFile(
    path.join(legacy, "engines", "GPT-SoVITS", "installation.json"),
    "{}\n",
    "utf8",
  );

  const selected = await resolveManagedDataRoot({ localAppData, userDataPath });
  assert.equal(selected, legacy);
  const record = JSON.parse(await readFile(path.join(userDataPath, DATA_LOCATION_FILE), "utf8"));
  assert.equal(record.localRoot, legacy);
  assert.equal(record.mode, "legacy-in-place");

  await mkdir(path.join(preferred, "voices"), { recursive: true });
  assert.equal(await resolveManagedDataRoot({ localAppData, userDataPath }), legacy);
});

test("copywriter filtering covers current and legacy internal project names", () => {
  const ignored = defaultIgnoredProjectPaths({ localAppData: "C:\\Local" });
  assert.ok(ignored.some((value) => value.endsWith(COPYWRITER_PROJECT_NAME)));
  assert.ok(ignored.some((value) => value.endsWith(LEGACY_COPYWRITER_PROJECT_NAME)));
  assert.ok(ignored.some((value) => value.includes("AgentPet")));
  assert.ok(ignored.some((value) => value.includes("CodexTaskCompanion")));
});

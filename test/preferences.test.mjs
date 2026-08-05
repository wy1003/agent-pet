import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createDefaultPreferences,
  normalizePreferences,
  PreferenceStore,
} from "../desktop/preferences.mjs";

test("preferences normalize partial and invalid values against safe defaults", () => {
  const preferences = normalizePreferences({
    version: 99,
    rules: {
      completed: false,
      failed: { windows: false, voice: true, mobile: true },
    },
    notifications: {
      voice: {
        engine: "unsupported",
        rate: -99,
        pitch: 9,
        volume: 900,
        contentLevel: "everything",
        style: {
          addressee: `  ${"你".repeat(40)}  `,
          assistantName: " 小助手 ",
          tone: "unsupported",
          includeProjectName: false,
          customInstruction: `  ${"自然".repeat(200)}  `,
        },
        gptSovits: { speed: 9, promptLanguage: "unsupported", autoStartService: true },
      },
      mobile: { provider: "unsupported" },
    },
    remoteControl: { enabled: true },
    dailyReport: { contentLevel: "everything" },
    quietHours: { start: "25:80" },
    appearance: { theme: "dark", unknown: true },
    unknown: "discarded",
  });

  assert.equal(preferences.rules.completed, false);
  assert.equal(preferences.rules.failed, false);
  assert.equal(preferences.rules.needs_input, true);
  assert.equal(preferences.version, 13);
  assert.equal(preferences.notifications.voice.engine, "windows");
  assert.equal(preferences.notifications.voice.rate, -5);
  assert.equal(preferences.notifications.voice.pitch, 2);
  assert.equal(preferences.notifications.voice.volume, 100);
  assert.equal(preferences.notifications.voice.contentLevel, "standard");
  assert.equal(preferences.notifications.voice.style.addressee.length, 24);
  assert.equal(preferences.notifications.voice.style.assistantName, "小助手");
  assert.equal(preferences.notifications.voice.style.tone, "cute");
  assert.equal(preferences.notifications.voice.style.includeProjectName, false);
  assert.equal(preferences.notifications.voice.style.customInstruction.length, 240);
  assert.equal(preferences.notifications.voice.gptSovits.speed, 2);
  assert.equal(preferences.notifications.voice.gptSovits.promptLanguage, "zh");
  assert.equal(preferences.notifications.voice.gptSovits.selectedVoiceId, "");
  assert.equal(preferences.notifications.voice.gptSovits.autoStartService, true);
  assert.equal(preferences.notifications.mobile.provider, "weixin");
  assert.equal(preferences.remoteControl.enabled, true);
  assert.equal(preferences.dailyReport.contentLevel, "standard");
  assert.equal(preferences.quietHours.start, "22:00");
  assert.equal(preferences.appearance.theme, "dark");
  assert.equal(preferences.appearance.showPet, true);
  assert.equal(preferences.appearance.showBadge, true);
  assert.equal(preferences.appearance.pet.width, 112);
  assert.equal(preferences.appearance.pet.renderMode, "smooth");
  assert.equal("unknown" in preferences, false);
});

test("version 7 style-name defaults migrate to empty neutral values", () => {
  const preferences = normalizePreferences({
    version: 7,
    notifications: {
      voice: {
        style: { addressee: "老大", assistantName: "诺诺" },
      },
    },
  });
  assert.equal(preferences.notifications.voice.style.addressee, "");
  assert.equal(preferences.notifications.voice.style.assistantName, "");
});

test("version 8 badge visibility migrates to pet visibility", () => {
  const preferences = normalizePreferences({
    version: 8,
    appearance: { showBadge: false, pet: { width: 999, renderMode: "smooth" } },
  });
  assert.equal(preferences.version, 13);
  assert.equal(preferences.appearance.showPet, false);
  assert.equal(preferences.appearance.showBadge, false);
  assert.equal(preferences.appearance.pet.width, 224);
  assert.equal(preferences.appearance.pet.renderMode, "smooth");
  assert.equal(preferences.dailyReport.contentLevel, "standard");
});

test("global remote control defaults off and migrates the version 12 Weixin switch", () => {
  assert.deepEqual(normalizePreferences({ version: 13 }).remoteControl, {
    enabled: false,
  });

  const migrated = normalizePreferences({
    version: 12,
    remoteControl: {
      weixin: { enabled: true, allowedProjectCodes: ["P001"] },
    },
  });
  assert.equal(migrated.version, 13);
  assert.deepEqual(migrated.remoteControl, { enabled: true });

  const whitelistOnly = normalizePreferences({
    version: 12,
    remoteControl: {
      weixin: { allowedProjectCodes: ["P001"] },
    },
  });
  assert.deepEqual(whitelistOnly.remoteControl, { enabled: false });

  const currentVersionWins = normalizePreferences({
    version: 13,
    remoteControl: {
      enabled: false,
      weixin: { enabled: true, allowedProjectCodes: ["P001"] },
    },
  });
  assert.deepEqual(currentVersionWins.remoteControl, { enabled: false });
});

test("daily report content level accepts supported values", () => {
  assert.equal(
    normalizePreferences({ version: 10 }).dailyReport.contentLevel,
    "standard",
  );
  for (const contentLevel of ["brief", "standard", "detailed"]) {
    const preferences = normalizePreferences({
      version: 10,
      dailyReport: { contentLevel },
    });
    assert.equal(preferences.dailyReport.contentLevel, contentLevel);
  }
});

test("version 10 built-in pet migrates from pixelated to smooth rendering", () => {
  const builtIn = normalizePreferences({
    version: 10,
    appearance: { pet: { selectedPetId: "builtin-default", renderMode: "pixelated" } },
  });
  const custom = normalizePreferences({
    version: 10,
    appearance: { pet: { selectedPetId: "custom-cat", renderMode: "pixelated" } },
  });

  assert.equal(builtIn.appearance.pet.renderMode, "smooth");
  assert.equal(custom.appearance.pet.renderMode, "pixelated");
});

test("preference store persists updates and recovers from a corrupt file", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-preferences-test-"));
  const filePath = path.join(directory, "preferences.json");
  t.after(() => rm(directory, { recursive: true, force: true }));

  const store = new PreferenceStore(filePath);
  assert.deepEqual(await store.load(), createDefaultPreferences());
  assert.equal(store.get().dailyReport.contentLevel, "standard");
  assert.equal(store.get().remoteControl.enabled, false);
  await Promise.all([
    store.update({ notifications: { voice: { enabled: true, rate: 2 } } }),
    store.update({ notifications: { mobile: { provider: "weixin" } } }),
    store.update({ dailyReport: { contentLevel: "detailed" } }),
    store.update({ remoteControl: { enabled: true } }),
  ]);

  const restarted = new PreferenceStore(filePath);
  const restored = await restarted.load();
  assert.equal(restored.notifications.voice.enabled, true);
  assert.equal(restored.notifications.voice.rate, 2);
  assert.equal(restored.notifications.mobile.provider, "weixin");
  assert.equal(restored.dailyReport.contentLevel, "detailed");
  assert.equal(restored.remoteControl.enabled, true);

  const reset = await restarted.reset();
  assert.equal(reset.dailyReport.contentLevel, "standard");
  assert.equal(reset.remoteControl.enabled, false);
  const resetRestored = await new PreferenceStore(filePath).load();
  assert.equal(resetRestored.dailyReport.contentLevel, "standard");

  await writeFile(filePath, "{this is not json", "utf8");
  const recovered = await new PreferenceStore(filePath).load();
  assert.deepEqual(recovered, createDefaultPreferences());
});

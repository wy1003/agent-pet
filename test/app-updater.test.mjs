import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { AppUpdater } from "../desktop/app-updater.mjs";

class FakeAutoUpdater extends EventEmitter {
  constructor() {
    super();
    this.autoDownload = true;
    this.autoInstallOnAppQuit = false;
    this.checks = 0;
    this.downloads = 0;
    this.installs = 0;
  }

  async checkForUpdates() {
    this.checks += 1;
    this.emit("update-available", { version: "0.2.0" });
  }

  async downloadUpdate() {
    this.downloads += 1;
    this.emit("download-progress", { percent: 42.5 });
    this.emit("update-downloaded", { version: "0.2.0" });
  }

  quitAndInstall() {
    this.installs += 1;
  }
}

test("updater exposes the current version without checking in development", async () => {
  const updater = new FakeAutoUpdater();
  const service = new AppUpdater({
    autoUpdater: updater,
    currentVersion: "v0.1.0",
    isPackaged: false,
  });
  assert.deepEqual(service.start(), {
    state: "unavailable",
    currentVersion: "0.1.0",
    nextVersion: "",
    progress: 0,
    message: "开发模式不执行自动更新",
    packaged: false,
  });
  await service.checkForUpdates();
  assert.equal(updater.checks, 0);
});

test("updater checks, downloads and installs a packaged GitHub release", async () => {
  const updater = new FakeAutoUpdater();
  const statuses = [];
  const service = new AppUpdater({
    autoUpdater: updater,
    currentVersion: "0.1.0",
    isPackaged: true,
    onStatus: (status) => statuses.push(status),
    checkDelayMs: 60_000,
  });
  service.start();
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, true);

  await service.checkForUpdates();
  assert.equal(service.status().state, "available");
  assert.equal(service.status().nextVersion, "0.2.0");
  await service.downloadUpdate();
  assert.equal(service.status().state, "downloaded");
  assert.equal(service.status().progress, 100);
  assert.equal(service.installUpdate(), true);
  assert.equal(updater.installs, 1);
  assert.ok(statuses.some((status) => status.state === "downloading"));
  service.stop();
});

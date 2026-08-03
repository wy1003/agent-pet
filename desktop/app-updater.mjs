const DEFAULT_CHECK_DELAY_MS = 15_000;
const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;

function cleanVersion(value) {
  return String(value || "").trim().replace(/^v/i, "").slice(0, 64);
}

function cleanMessage(value) {
  return String(value?.message || value || "更新检查失败").trim().slice(0, 300);
}

export class AppUpdater {
  constructor(options = {}) {
    this.autoUpdater = options.autoUpdater || null;
    this.currentVersion = cleanVersion(options.currentVersion) || "0.0.0";
    this.isPackaged = options.isPackaged === true;
    this.onStatus = options.onStatus || (() => {});
    this.logger = options.logger || console;
    this.checkDelayMs = Math.max(1, Number(options.checkDelayMs || DEFAULT_CHECK_DELAY_MS));
    this.checkIntervalMs = Math.max(
      this.checkDelayMs,
      Number(options.checkIntervalMs || DEFAULT_CHECK_INTERVAL_MS),
    );
    this.started = false;
    this.timer = null;
    this.listeners = [];
    this.snapshot = {
      state: this.isPackaged ? "idle" : "unavailable",
      currentVersion: this.currentVersion,
      nextVersion: "",
      progress: 0,
      message: this.isPackaged ? "" : "开发模式不执行自动更新",
      packaged: this.isPackaged,
    };
  }

  status() {
    return { ...this.snapshot };
  }

  #emit(changes = {}) {
    this.snapshot = { ...this.snapshot, ...changes };
    try {
      this.onStatus(this.status());
    } catch (error) {
      this.logger.warn?.("[updater] status listener failed", error);
    }
    return this.status();
  }

  #listen(eventName, listener) {
    this.autoUpdater.on(eventName, listener);
    this.listeners.push([eventName, listener]);
  }

  #schedule(delayMs) {
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      await this.checkForUpdates();
      if (this.started) this.#schedule(this.checkIntervalMs);
    }, delayMs);
    this.timer.unref?.();
  }

  start() {
    if (this.started) return this.status();
    this.started = true;
    if (!this.isPackaged || !this.autoUpdater) {
      return this.#emit({
        state: "unavailable",
        message: "开发模式不执行自动更新",
      });
    }

    this.autoUpdater.autoDownload = false;
    this.autoUpdater.autoInstallOnAppQuit = true;
    this.#listen("checking-for-update", () => this.#emit({
      state: "checking",
      message: "正在检查新版本…",
    }));
    this.#listen("update-available", (info = {}) => this.#emit({
      state: "available",
      nextVersion: cleanVersion(info.version),
      progress: 0,
      message: "发现新版本",
    }));
    this.#listen("update-not-available", () => this.#emit({
      state: "up_to_date",
      nextVersion: "",
      progress: 0,
      message: "当前已是最新版本",
    }));
    this.#listen("download-progress", (progress = {}) => this.#emit({
      state: "downloading",
      progress: Math.max(0, Math.min(100, Number(progress.percent) || 0)),
      message: "正在下载更新…",
    }));
    this.#listen("update-downloaded", (info = {}) => this.#emit({
      state: "downloaded",
      nextVersion: cleanVersion(info.version) || this.snapshot.nextVersion,
      progress: 100,
      message: "更新已下载，重启后安装",
    }));
    this.#listen("error", (error) => this.#emit({
      state: "error",
      progress: 0,
      message: cleanMessage(error),
    }));
    this.#emit({ state: "idle", message: "" });
    this.#schedule(this.checkDelayMs);
    return this.status();
  }

  async checkForUpdates() {
    if (!this.isPackaged || !this.autoUpdater) return this.status();
    if (["checking", "downloading"].includes(this.snapshot.state)) return this.status();
    this.#emit({ state: "checking", message: "正在检查新版本…" });
    try {
      await this.autoUpdater.checkForUpdates();
    } catch (error) {
      this.logger.warn?.("[updater] update check failed", error);
      this.#emit({ state: "error", message: cleanMessage(error), progress: 0 });
    }
    return this.status();
  }

  async downloadUpdate() {
    if (!this.isPackaged || !this.autoUpdater || this.snapshot.state !== "available") {
      return this.status();
    }
    this.#emit({ state: "downloading", progress: 0, message: "正在下载更新…" });
    try {
      await this.autoUpdater.downloadUpdate();
    } catch (error) {
      this.logger.warn?.("[updater] update download failed", error);
      this.#emit({ state: "error", message: cleanMessage(error), progress: 0 });
    }
    return this.status();
  }

  installUpdate() {
    if (!this.isPackaged || !this.autoUpdater || this.snapshot.state !== "downloaded") {
      return false;
    }
    this.autoUpdater.quitAndInstall(false, true);
    return true;
  }

  stop() {
    this.started = false;
    clearTimeout(this.timer);
    this.timer = null;
    for (const [eventName, listener] of this.listeners.splice(0)) {
      this.autoUpdater?.removeListener(eventName, listener);
    }
  }
}

export { DEFAULT_CHECK_DELAY_MS, DEFAULT_CHECK_INTERVAL_MS };


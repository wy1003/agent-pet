/**
 * Common window interface. Consumers receive a facade, never a BrowserWindow.
 * Native construction is injected so lifecycle behavior can be tested without Electron.
 * @implements {import('./window-contracts.mjs').WindowPort}
 */
export class WindowFacade {
  #window = null;
  #creating = null;
  #showRevision = 0;
  #options;

  constructor(options) {
    this.#options = options;
  }

  async ensureCreated() {
    if (this.#creating) return this.#creating;
    if (!this.isDestroyed()) return;
    const { createWindow, getOptions, getUrl, configure, onClosed } = this.#options;
    const window = createWindow(getOptions());
    this.#window = window;
    window.on("closed", () => {
      if (this.#window !== window) return;
      this.#window = null;
      this.#showRevision += 1;
      onClosed?.();
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => {
      try {
        if (new URL(url).origin !== new URL(getUrl()).origin) event.preventDefault();
      } catch {
        event.preventDefault();
      }
    });
    const pending = Promise.resolve().then(async () => {
      configure?.(window);
      await window.loadURL(getUrl());
      if (this.#window !== window || window.isDestroyed()) {
        throw new Error("Window closed while loading");
      }
    }).catch((error) => {
      if (!window.isDestroyed()) window.destroy();
      throw error;
    }).finally(() => {
      if (this.#creating === pending) this.#creating = null;
    });
    this.#creating = pending;
    return pending;
  }

  async show({ focus = true } = {}) {
    const revision = ++this.#showRevision;
    await this.ensureCreated();
    if (revision !== this.#showRevision || this.isDestroyed()) return false;
    if (this.#window.isMinimized()) this.#window.restore();
    if (focus) {
      this.#window.show();
      this.#window.focus();
    } else {
      this.#window.showInactive();
    }
    this.#options.onShown?.();
    return true;
  }

  showInactive() { this.#window?.showInactive(); }
  hide() { this.#showRevision += 1; this.#window?.hide(); }
  destroy() { this.#showRevision += 1; this.#window?.destroy(); }
  isDestroyed() { return !this.#window || this.#window.isDestroyed(); }
  isVisible() { return !this.isDestroyed() && this.#window.isVisible(); }
  isFocused() { return !this.isDestroyed() && this.#window.isFocused(); }
  isLoading() { return this.isDestroyed() || this.#window.webContents.isLoading(); }
  getBounds() { return this.isDestroyed() ? null : this.#window.getBounds(); }
  setBounds(bounds) { this.#window?.setBounds(bounds, false); }
  setAlwaysOnTop(value) { this.#window?.setAlwaysOnTop(value, "floating"); }
  setOpacity(value) { this.#window?.setOpacity(value); }
  setTitle(value) { this.#window?.setTitle(value); }
  invalidate() { this.#window?.webContents.invalidate?.(); }
  send(channel, payload) {
    if (!this.isDestroyed()) this.#window.webContents.send(channel, payload);
  }
  ownsSender(event) {
    return !this.isDestroyed() && !this.#window.webContents.isDestroyed()
      && event.sender === this.#window.webContents;
  }
  ownsMainFrame(event) {
    return this.ownsSender(event) && event.senderFrame === this.#window.webContents.mainFrame;
  }
  popupMenu(menu) {
    if (!this.isDestroyed()) menu.popup({ window: this.#window });
  }
  openFileDialog(options) {
    return this.#options.showOpenDialog(this.#window, options);
  }
}

export function isolatedWebPreferences(preload, extra = {}) {
  return { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, ...extra };
}

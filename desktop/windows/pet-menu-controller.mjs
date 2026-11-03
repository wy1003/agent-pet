import { PET_MENU_SIZE } from "./window-contracts.mjs";

export function petMenuBounds(point, area) {
  const width = Math.min(PET_MENU_SIZE.width, area.width), height = Math.min(PET_MENU_SIZE.height, area.height);
  const x = point.x + width > area.x + area.width ? point.x - width + 8 : point.x - 8;
  const y = point.y + height > area.y + area.height ? point.y - height + 8 : point.y - 8;
  return { x: Math.round(Math.max(area.x, Math.min(x, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(y, area.y + area.height - height))), width, height };
}

/** Coordinates position, dismissal and actions through the menu window interface. */
export class PetMenuController {
  #revision = 0;
  #active = null;
  #releaseTimer = null;
  constructor({ window, getCursorPoint, getWorkArea, getPreferences, actions,
    isQuitting = () => false, setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { window, getCursorPoint, getWorkArea, getPreferences, actions, isQuitting, setTimer, clearTimer });
  }
  async open() {
    if (this.isQuitting()) return false;
    this.clearTimer(this.#releaseTimer); this.#releaseTimer = null;
    const revision = ++this.#revision, point = this.getCursorPoint();
    this.#active = revision;
    try {
      await this.window.ensureCreated();
      if (this.#active !== revision || this.isQuitting()) return false;
      const ready = await this.window.render({ revision, notebookVisible: this.getPreferences().appearance.showNotebook });
      if (!ready || this.#active !== revision || this.isQuitting()) return false;
      this.window.setBounds(petMenuBounds(point, this.getWorkArea(point)));
      return await this.window.show();
    } catch (error) {
      if (this.#active !== revision) return false;
      this.dismiss(); throw error;
    }
  }
  dismiss(revision = this.#active) {
    if (revision !== this.#active) return false;
    this.#active = null;
    this.window.hide();
    this.clearTimer(this.#releaseTimer);
    this.#releaseTimer = this.setTimer(() => { this.#releaseTimer = null; if (this.#active === null) this.window.destroy(); }, 15_000);
    this.#releaseTimer?.unref?.();
    return true;
  }
  async select(action, revision) {
    if (!["tasks", "notebook", "summary", "settings", "quit"].includes(action)) throw new Error("Unknown pet menu action");
    if (this.#active !== revision || !this.window.isVisible() || this.isQuitting()) return false;
    this.dismiss(revision);
    await this.actions[action]();
    return true;
  }
  dispose() {
    this.#active = null; this.#revision++;
    this.clearTimer(this.#releaseTimer); this.#releaseTimer = null;
    this.window.destroy();
  }
}

export function installPetMenuIpc({ ipcMain, window, controller }) {
  const check = event => { if (!window.ownsMainFrame(event)) throw new Error("Untrusted pet menu request"); };
  ipcMain.handle("pet-menu:ready", (event, revision) => { check(event); window.acknowledge(revision); });
  ipcMain.handle("pet-menu:dismiss", (event, revision) => { check(event); return controller.dismiss(revision); });
  ipcMain.handle("pet-menu:select", async (event, { action, revision } = {}) => {
    check(event); return controller.select(action, revision);
  });
}

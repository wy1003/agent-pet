import { panelBoundsNearBadge, usageCardBoundsNearBadge } from "../window-layout.mjs";
import { TASK_WINDOW_SIZE, USAGE_WINDOW_SIZE } from "./window-contracts.mjs";

/** Coordinates WindowPort facades; does not construct or access native windows. */
export class CompanionWindowCoordinator {
  #revision = 0;
  #open = false;
  #forceTasks = false;
  #releaseTimer = null;
  #blurTimer = null;

  /**
   * @param {{pet: import('./window-contracts.mjs').WindowPort,
   * tasks: import('./window-contracts.mjs').TaskWindowPort,
   * usage: import('./window-contracts.mjs').UsageWindowPort,
   * getPreferences: Function, getWorkArea: Function, isQuitting: Function,
   * setTimer?: Function, clearTimer?: Function, releaseMs?: number}} dependencies
   */
  constructor({ pet, tasks, usage, getPreferences, getWorkArea, isQuitting,
    setTimer = setTimeout, clearTimer = clearTimeout, releaseMs = 30_000 }) {
    Object.assign(this, { pet, tasks, usage, getPreferences, getWorkArea,
      isQuitting, setTimer, clearTimer, releaseMs });
  }

  isOpen() { return this.#open; }
  isVisible() { return this.tasks.isVisible() || this.usage.isVisible(); }

  #selection() {
    const appearance = this.getPreferences().appearance;
    return {
      tasks: this.#forceTasks || appearance.showTaskPanel !== false,
      usage: appearance.showUsageCard !== false,
    };
  }

  async show({ forceTasks = false, focus = true } = {}) {
    if (this.isQuitting()) return false;
    this.#forceTasks = forceTasks;
    const selection = this.#selection();
    if (!selection.tasks && !selection.usage) {
      this.hide();
      return false;
    }
    const revision = ++this.#revision;
    this.#open = true;
    this.clearTimer(this.#releaseTimer);
    this.#releaseTimer = null;
    const selected = [selection.tasks && this.tasks, selection.usage && this.usage].filter(Boolean);
    if (!selection.tasks) this.tasks.hide();
    if (!selection.usage) this.usage.hide();
    try {
      await Promise.all(selected.map((window) => window.ensureCreated()));
      if (!this.#open || revision !== this.#revision || this.isQuitting()) return false;
      this.position();
      const focusedWindow = selection.tasks ? this.tasks : this.usage;
      for (const window of selected) {
        if (!this.#open || revision !== this.#revision || this.isQuitting()) return false;
        await window.show({ focus: focus && window === focusedWindow });
      }
      return this.#open && revision === this.#revision;
    } catch (error) {
      if (revision !== this.#revision || !this.#open) return false;
      this.hide();
      throw error;
    }
  }

  toggle() {
    if (this.#open || this.isVisible()) {
      this.hide();
      return Promise.resolve(false);
    }
    return this.show();
  }

  resume() { return this.show({ forceTasks: this.#forceTasks }); }

  hideEmptyTasks() {
    if (!this.tasks.isVisible()) return;
    this.hide();
  }

  hide() {
    this.#revision += 1;
    this.#open = false;
    this.tasks.hide();
    this.usage.hide();
    this.clearTimer(this.#releaseTimer);
    this.#releaseTimer = this.setTimer(() => {
      this.#releaseTimer = null;
      if (this.#open || this.isVisible()) return;
      this.tasks.destroy();
      this.usage.destroy();
    }, this.releaseMs);
    this.#releaseTimer?.unref?.();
  }

  hideWhenFocusLeaves() {
    this.clearTimer(this.#blurTimer);
    this.#blurTimer = this.setTimer(() => {
      this.#blurTimer = null;
      if (!this.isQuitting() && !this.tasks.isFocused() && !this.usage.isFocused()) this.hide();
    }, 120);
  }

  async applyPreferences() {
    const appearance = this.getPreferences().appearance;
    this.tasks.setAlwaysOnTop(appearance.alwaysOnTop);
    this.usage.setAlwaysOnTop(appearance.alwaysOnTop);
    if (this.#open) await this.show({ focus: false });
    else this.position();
  }

  position() {
    const badge = this.pet.getBounds();
    if (!badge) return;
    const area = this.getWorkArea();
    const selected = this.#selection();
    let anchor = badge;
    if (selected.usage && !this.usage.isDestroyed()) {
      const size = this.usage.getBounds();
      const bounds = usageCardBoundsNearBadge(badge, {
        width: Math.min(USAGE_WINDOW_SIZE.width, area.width - 24),
        height: Math.min(size.height, area.height - 24),
      }, area, 10);
      this.usage.setBounds(bounds);
      if (bounds.x < badge.x) anchor = { ...badge, x: bounds.x, width: 0 };
    }
    if (selected.tasks && !this.tasks.isDestroyed()) {
      const size = this.tasks.getBounds();
      this.tasks.setBounds(panelBoundsNearBadge(anchor, {
        width: Math.min(TASK_WINDOW_SIZE.width, area.width - 24),
        height: Math.min(size.height, area.height - 24),
      }, area, 12, this.tasks.verticalAlignment(badge.height)));
    }
  }

  dispose() {
    this.#revision += 1;
    this.#open = false;
    this.clearTimer(this.#releaseTimer);
    this.clearTimer(this.#blurTimer);
    this.tasks.destroy();
    this.usage.destroy();
  }
}

import { clampWindowBounds } from "../window-layout.mjs";
import { NOTEBOOK_WINDOW_SIZE, NOTEBOOK_ORB_SIZE } from "./window-contracts.mjs";

const validPosition = bounds => Number.isFinite(bounds?.x) && Number.isFinite(bounds?.y);

/** Independent, persistent window policy. Depends only on NotebookWindowPort and injected services. */
export class NotebookWindowController {
  #revision = 0;
  #positioned = false;
  #restored = false;
  #collapsed = false;
  #expandedBounds = null;
  #orbBounds = null;
  #drag = null;
  #dragTimer = null;
  #dragged = true;
  constructor({ window, getPreferences, getWorkArea, getSavedBounds = () => null, getSavedState = () => null,
    getCursorPoint = () => ({ x: 0, y: 0 }), onStateChanged = () => {},
    setTimer = setInterval, clearTimer = clearInterval, isQuitting }) {
    Object.assign(this, { window, getPreferences, getWorkArea, getSavedBounds, getSavedState,
      getCursorPoint, onStateChanged, setTimer, clearTimer, isQuitting });
  }
  isVisible() { return this.window.isVisible(); }
  #restoreState() {
    if (this.#restored) return;
    const saved = this.getSavedState();
    this.#collapsed = saved?.collapsed === true;
    this.#expandedBounds = validPosition(saved?.expandedBounds) ? saved.expandedBounds : this.getSavedBounds();
    this.#orbBounds = validPosition(saved?.orbBounds) ? saved.orbBounds : this.#expandedBounds;
    this.#restored = true;
  }
  async show({ focus = true } = {}) {
    if (this.isQuitting()) return false;
    const revision = ++this.#revision;
    if (this.window.isDestroyed()) this.#positioned = false;
    try {
      this.#restoreState();
      this.window.setCollapsed(this.#collapsed);
      await this.window.ensureCreated();
      if (revision !== this.#revision || this.isQuitting()) return false;
      if (!this.#positioned) {
        this.#position(this.#collapsed ? this.#orbBounds : this.#expandedBounds);
        this.#positioned = true; this.#rememberBounds();
      }
      this.window.setAlwaysOnTop(this.getPreferences().appearance.notebookAlwaysOnTop !== false);
      this.window.applyAppearance();
      return await this.window.show({ focus });
    } catch (error) {
      if (revision !== this.#revision || this.isQuitting()) return false;
      throw error;
    }
  }
  hide() { this.finishDrag(true); this.#revision++; this.window.hide(); }
  async applyPreferences({ focus = false } = {}) {
    const preferences = this.getPreferences().appearance;
    this.window.setAlwaysOnTop(preferences.notebookAlwaysOnTop !== false);
    this.window.applyAppearance();
    if (!preferences.showNotebook) { this.hide(); return false; }
    if (this.isVisible()) return true;
    return this.show({ focus });
  }
  #position(saved) {
    const valid = validPosition(saved);
    const area = this.getWorkArea(valid ? saved : null);
    const dimensions = this.#collapsed ? NOTEBOOK_ORB_SIZE : NOTEBOOK_WINDOW_SIZE;
    const size = { width: Math.min(dimensions.width, Math.max(1, area.width - 24)),
      height: Math.min(dimensions.height, Math.max(1, area.height - 24)) };
    const origin = valid ? saved : { x: area.x + Math.round((area.width - size.width) / 2),
      y: area.y + Math.round((area.height - size.height) / 2) };
    this.window.setBounds(clampWindowBounds({ ...origin, ...size }, area));
  }
  #rememberBounds() {
    const bounds = this.window.getBounds();
    if (!bounds || !this.#positioned) return;
    if (this.#collapsed) this.#orbBounds = bounds;
    else this.#expandedBounds = bounds;
  }
  getState() {
    this.#restoreState();
    this.#rememberBounds();
    return structuredClone({ collapsed: this.#collapsed, expandedBounds: this.#expandedBounds, orbBounds: this.#orbBounds });
  }
  setCollapsed(value) {
    if (typeof value !== "boolean") throw new Error("Invalid notebook presentation");
    if (this.window.isDestroyed() || value === this.#collapsed) return this.window.getPresentation();
    this.finishDrag(true);
    this.#rememberBounds();
    if (value) this.#orbBounds = { ...this.#expandedBounds,
      x: this.#expandedBounds.x + this.#expandedBounds.width - NOTEBOOK_ORB_SIZE.width };
    this.#collapsed = value;
    // Suspend capture before the small viewport can overwrite the expanded frame.
    if (value) this.window.setCollapsed(true);
    this.#position(value ? this.#orbBounds : this.#expandedBounds);
    this.#rememberBounds();
    if (!value) this.window.setCollapsed(false);
    this.onStateChanged();
    return this.window.getPresentation();
  }
  startDrag() {
    this.finishDrag(true);
    if (!this.#collapsed || !this.window.isVisible() || this.isQuitting()) return false;
    this.#dragged = false;
    this.#drag = { cursor: this.getCursorPoint(), bounds: this.window.getBounds(), expanded: this.#expandedBounds };
    this.#dragTimer = this.setTimer(() => this.#moveDrag(), 16);
    return true;
  }
  #moveDrag() {
    if (!this.#drag) return;
    if (!this.window.isVisible() || this.isQuitting()) { this.finishDrag(true); return; }
    const cursor = this.getCursorPoint(), { bounds, expanded } = this.#drag;
    const dx = cursor.x - this.#drag.cursor.x, dy = cursor.y - this.#drag.cursor.y;
    if (!this.#dragged && Math.hypot(dx, dy) < 4) return;
    this.#dragged = true;
    const next = { ...bounds, x: bounds.x + dx, y: bounds.y + dy };
    const clamped = clampWindowBounds(next, this.getWorkArea(next));
    this.window.setBounds(clamped);
    this.#orbBounds = clamped;
    if (expanded) this.#expandedBounds = { ...expanded,
      x: expanded.x + clamped.x - bounds.x, y: expanded.y + clamped.y - bounds.y };
  }
  finishDrag(cancelled = false) {
    if (this.#drag && !cancelled) this.#moveDrag();
    if (this.#dragTimer !== null) this.clearTimer(this.#dragTimer);
    this.#dragTimer = null;
    const hadDrag = Boolean(this.#drag);
    this.#drag = null;
    this.#dragged ||= cancelled;
    if (hadDrag && this.#dragged) this.onStateChanged();
    return { dragged: this.#dragged };
  }
  keepOnScreen() {
    this.finishDrag(true);
    if (!this.window.isDestroyed()) { this.#position(this.window.getBounds()); this.#rememberBounds(); }
  }
  dispose() {
    this.finishDrag(true); this.#rememberBounds();
    this.#revision++; this.#positioned = false; this.window.destroy();
  }
}

export function installNotebookWindowIpc({ ipcMain, window, controller }) {
  const handle = (channel, action) => ipcMain.handle(channel, (event, ...args) => {
    if (!window.ownsMainFrame(event)) throw new Error("Untrusted notebook window request");
    return action(...args);
  });
  handle("notebook:presentation", () => window.getPresentation());
  handle("notebook:collapse", value => controller.setCollapsed(value));
  handle("notebook:drag-start", () => controller.startDrag());
  handle("notebook:drag-end", cancelled => controller.finishDrag(cancelled === true));
}

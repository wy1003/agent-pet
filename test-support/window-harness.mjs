import { EventEmitter } from "node:events";
import { createDefaultPreferences } from "../desktop/preferences.mjs";
import { PetWindowFacade } from "../desktop/windows/pet-window.mjs";
import { TaskWindowFacade } from "../desktop/windows/task-window.mjs";
import { UsageWindowFacade } from "../desktop/windows/usage-window.mjs";
import { NotebookWindowFacade } from "../desktop/windows/notebook-window.mjs";
import { NotebookWindowController } from "../desktop/windows/notebook-window-controller.mjs";
import { CompanionWindowCoordinator } from "../desktop/windows/companion-window-coordinator.mjs";

export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export function createWindowHarness() {
  const nativeWindows = [];
  const timers = new Map();
  const preferences = createDefaultPreferences();
  const harness = { nativeWindows, preferences, load: async () => {}, quitting: false };
  const createWindow = (options) => {
    const window = new EventEmitter();
    Object.assign(window, { options, bounds: { x: 0, y: 0, ...options }, visible: false,
      focused: false, destroyed: false, minimized: false, messages: [], loading: true });
    window.webContents = new EventEmitter();
    Object.assign(window.webContents, {
      mainFrame: {}, isDestroyed: () => window.destroyed, isLoading: () => window.loading,
      setWindowOpenHandler: (handler) => { window.openHandler = handler; },
      send: (channel, payload) => window.messages.push({ channel, payload }),
    });
    window.loadURL = async (url) => {
      window.url = url;
      await harness.load(url);
      window.loading = false;
    };
    window.isDestroyed = () => window.destroyed;
    window.isVisible = () => window.visible;
    window.isFocused = () => window.focused;
    window.isMinimized = () => window.minimized;
    window.restore = () => { window.minimized = false; };
    window.show = window.showInactive = () => { window.visible = true; window.emit("show"); };
    window.focus = () => {
      for (const other of nativeWindows) {
        if (other.focused && other !== window) { other.focused = false; other.emit("blur"); }
      }
      window.focused = true;
    };
    window.hide = () => { window.visible = false; window.focused = false; window.emit("hide"); };
    window.destroy = () => {
      if (window.destroyed) return;
      window.destroyed = true;
      window.visible = window.focused = false;
      window.emit("closed");
    };
    window.close = () => {
      let prevented = false;
      window.emit("close", { preventDefault: () => { prevented = true; } });
      if (!prevented) window.destroy();
    };
    window.getBounds = () => {
      const { x, y, width, height } = window.bounds;
      return { x, y, width, height };
    };
    window.setBounds = (bounds) => { window.bounds = { ...window.bounds, ...bounds }; };
    window.getContentSize = () => [window.bounds.width, window.bounds.height];
    window.setBackgroundMaterial = (value) => { window.material = value; };
    window.setShape = (rectangles) => { window.shape = rectangles; };
    window.setAlwaysOnTop = (value) => { window.alwaysOnTop = value; };
    window.setVisibleOnAllWorkspaces = () => {};
    window.setOpacity = (value) => { window.opacity = value; };
    window.setTitle = (value) => { window.title = value; };
    nativeWindows.push(window);
    return window;
  };
  const dependencies = {
    createWindow, preload: "preload.cjs", getServiceUrl: () => "http://127.0.0.1:43123",
    getPreferences: () => preferences,
    getWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1040 }),
    isQuitting: () => harness.quitting,
    onBlur: () => coordinator.hideWhenFocusLeaves(),
    onHide: () => coordinator.hide(),
    onResize: () => coordinator.position(),
  };
  const pet = new PetWindowFacade({
    ...dependencies,
    getInitialBounds: () => ({ x: 1750, y: 800, width: 120, height: 129 }),
    onCreated: () => {}, onMoved: () => {}, onVisibilityChanged: () => {},
  });
  const tasks = new TaskWindowFacade(dependencies);
  const usage = new UsageWindowFacade(dependencies);
  const notebook = new NotebookWindowFacade({ ...dependencies,
    getBackgroundSource: viewport => harness.getBackgroundSource?.(viewport) ?? null,
    toScreenRect: bounds => harness.toScreenRect?.(bounds) ?? bounds,
    onHide: () => { preferences.appearance.showNotebook = false; notebookController.applyPreferences(); },
  });
  const notebookController = new NotebookWindowController({ ...dependencies, window: notebook,
    getSavedBounds: () => harness.savedNotebookBounds,
    getSavedState: () => harness.savedNotebookState,
    getCursorPoint: () => harness.cursor || { x: 0, y: 0 },
    onStateChanged: () => { harness.notebookStateChanges = (harness.notebookStateChanges || 0) + 1; },
    setTimer: (fn, ms) => { const key = {}; timers.set(key, { fn, ms }); return key; },
    clearTimer: key => timers.delete(key),
  });
  const coordinator = new CompanionWindowCoordinator({
    ...dependencies, pet, tasks, usage,
    setTimer: (fn, ms) => { const key = {}; timers.set(key, { fn, ms }); return key; },
    clearTimer: (key) => timers.delete(key),
  });
  const runTimers = (ms) => {
    for (const [key, timer] of [...timers]) {
      if (timer.ms === ms) { timers.delete(key); timer.fn(); }
    }
  };
  return Object.assign(harness, { dependencies, pet, tasks, usage, notebook, notebookController, coordinator, runTimers });
}

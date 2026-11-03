import test from "node:test";
import assert from "node:assert/strict";
import { PetMenuWindowFacade } from "../desktop/windows/pet-menu-window.mjs";
import { PetMenuController, petMenuBounds, installPetMenuIpc } from "../desktop/windows/pet-menu-controller.mjs";
import { createWindowHarness, deferred } from "../test-support/window-harness.mjs";

function fixture(t) {
  const h = createWindowHarness(), timers = new Map(), calls = [];
  let acknowledge = true;
  const window = new PetMenuWindowFacade({ ...h.dependencies,
    createWindow: options => {
      const native = h.dependencies.createWindow(options), send = native.webContents.send;
      native.webContents.send = (channel, state) => { send(channel, state); if (acknowledge && channel === "pet-menu:state") queueMicrotask(() => window.acknowledge(state.revision)); };
      return native;
    }, onDismiss: () => controller.dismiss(),
  });
  const controller = new PetMenuController({ window, getCursorPoint: () => ({ x: 1918, y: 1038 }),
    getWorkArea: h.dependencies.getWorkArea, getPreferences: () => h.preferences,
    actions: Object.fromEntries(["tasks", "notebook", "summary", "settings", "quit"].map(action => [action, () => calls.push(action)])),
    setTimer: fn => { const key = {}; timers.set(key, fn); return key; }, clearTimer: key => timers.delete(key),
  });
  t.after(() => controller.dispose());
  return { h, window, controller, timers, calls, noAck: () => { acknowledge = false; }, native: () => h.nativeWindows.at(-1),
    revision: () => h.nativeWindows.at(-1).messages.at(-1).payload.revision };
}

test("menu stays within the cursor display at every edge, including negative monitor coordinates", () => {
  for (const area of [{ x: 0, y: 0, width: 1920, height: 1040 }, { x: -1280, y: -100, width: 1280, height: 720 }]) {
    for (const point of [{ x: area.x, y: area.y }, { x: area.x + area.width - 1, y: area.y + area.height - 1 }, { x: area.x - 100, y: area.y - 100 }]) {
      const bounds = petMenuBounds(point, area);
      assert.ok(bounds.x >= area.x && bounds.y >= area.y);
      assert.ok(bounds.x + bounds.width <= area.x + area.width);
      assert.ok(bounds.y + bounds.height <= area.y + area.height);
    }
  }
});

test("menu renders current notebook state and each action can execute only once while open", async t => {
  const f = fixture(t);
  for (const action of ["tasks", "notebook", "summary", "settings", "quit"]) {
    f.h.preferences.appearance.showNotebook = action === "notebook";
    assert.equal(await f.controller.open(), true);
    assert.equal(f.native().messages.at(-1).payload.notebookVisible, action === "notebook");
    const revision = f.revision();
    assert.equal(await f.controller.select(action, revision), true);
    assert.equal(await f.controller.select(action, revision), false);
    assert.equal(f.window.isVisible(), false);
  }
  assert.deepEqual(f.calls, ["tasks", "notebook", "summary", "settings", "quit"]);
  assert.equal(f.native().options.transparent, true);
  assert.equal(f.native().options.webPreferences.sandbox, true);
  assert.equal(f.native().options.webPreferences.nodeIntegration, false);
});

test("blur, stale dismissal and idle release cannot execute actions or close a newer menu", async t => {
  const f = fixture(t); await f.controller.open(); const old = f.revision();
  f.native().emit("blur"); assert.equal(f.window.isVisible(), false);
  assert.equal(await f.controller.select("quit", old), false);
  await f.controller.open(); assert.equal(f.timers.size, 0);
  assert.equal(f.controller.dismiss(old), false); assert.equal(f.window.isVisible(), true);
  f.controller.dismiss(); for (const fn of f.timers.values()) fn();
  assert.equal(f.window.isDestroyed(), true); assert.deepEqual(f.calls, []);
});

test("dismissal during page loading or renderer acknowledgement cancels a delayed show", async t => {
  const f = fixture(t), loading = deferred(); f.h.load = () => loading.promise;
  const open = f.controller.open(); f.controller.dismiss(); loading.resolve();
  assert.equal(await open, false); assert.equal(f.window.isVisible(), false);
  f.noAck(); const pending = f.controller.open(); await Promise.resolve(); await Promise.resolve();
  f.controller.dismiss(); assert.equal(await pending, false); assert.equal(f.window.isVisible(), false);
});

test("menu IPC rejects other windows, child frames and unknown commands", async t => {
  const f = fixture(t); await f.controller.open(); const native = f.native(), handlers = new Map();
  installPetMenuIpc({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, window: f.window, controller: f.controller });
  const good = { sender: native.webContents, senderFrame: native.webContents.mainFrame };
  const child = { sender: native.webContents, senderFrame: {} };
  await assert.rejects(handlers.get("pet-menu:select")(child, { action: "quit", revision: f.revision() }), /Untrusted/);
  assert.throws(() => handlers.get("pet-menu:dismiss")({ sender: {} }, f.revision()), /Untrusted/);
  await assert.rejects(handlers.get("pet-menu:select")(good, { action: "arbitrary", revision: f.revision() }), /Unknown/);
  assert.equal(f.window.isVisible(), true); assert.deepEqual(f.calls, []);
});

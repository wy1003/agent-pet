import test from "node:test";
import assert from "node:assert/strict";
import { createWindowHarness, deferred } from "../test-support/window-harness.mjs";
import { installNotebookWindowIpc } from "../desktop/windows/notebook-window-controller.mjs";
import { NOTEBOOK_ORB_SIZE } from "../desktop/windows/window-contracts.mjs";

async function open() {
  const h = createWindowHarness(); h.preferences.appearance.showNotebook = true;
  await h.notebookController.applyPreferences();
  h.notebook.setBounds({ x: 200, y: 130, width: 380, height: 460 });
  return h;
}

test("notebook collapses in the same renderer, restores bounds, and remains independent of pet popovers", async () => {
  const h = await open(), before = h.notebook.getBounds();
  h.notebookController.setCollapsed(true);
  assert.deepEqual(h.notebook.getBounds(), { x: 504, y: 130, ...NOTEBOOK_ORB_SIZE });
  assert.deepEqual(h.notebook.getPresentation(), { collapsed: true });
  assert.equal(h.preferences.appearance.showNotebook, true);
  h.coordinator.hide(); assert.equal(h.notebook.isVisible(), true);
  h.notebookController.hide(); await h.notebookController.show();
  assert.deepEqual(h.notebook.getPresentation(), { collapsed: true });
  h.notebookController.setCollapsed(false);
  assert.deepEqual(h.notebook.getBounds(), before);
  assert.equal(h.nativeWindows.length, 1, "drafts are retained without reloading or recreating");
});

test("orb dragging follows absolute cursor movement, suppresses clicks, and moves the expanded anchor", async () => {
  const h = await open(); h.notebookController.setCollapsed(true);
  h.cursor = { x: 530, y: 160 };
  assert.equal(h.notebookController.startDrag(), true);
  h.cursor = { x: 531, y: 161 }; h.runTimers(16);
  assert.deepEqual(h.notebookController.finishDrag(), { dragged: false });
  h.notebookController.startDrag();
  h.cursor = { x: 651, y: 241 }; h.runTimers(16); h.runTimers(16);
  assert.deepEqual(h.notebook.getBounds(), { x: 624, y: 210, ...NOTEBOOK_ORB_SIZE });
  assert.deepEqual(h.notebookController.finishDrag(), { dragged: true });
  h.cursor = { x: 800, y: 500 }; h.runTimers(16);
  assert.equal(h.notebook.getBounds().x, 624, "release removes polling");
  h.notebookController.setCollapsed(false);
  assert.deepEqual(h.notebook.getBounds(), { x: 320, y: 210, width: 380, height: 460 });
  assert.equal(h.notebookController.startDrag(), false, "only the orb can start this drag");
});

test("collapsed state and separate bounds restore on restart, including when notebook stays hidden", async () => {
  const h = await open(); h.notebookController.setCollapsed(true);
  const saved = h.notebookController.getState();
  const next = createWindowHarness(); next.savedNotebookState = saved;
  assert.deepEqual(next.notebookController.getState(), saved, "saving a hidden startup preserves the previous state");
  await next.notebookController.show();
  assert.equal(next.nativeWindows[0].options.width, NOTEBOOK_ORB_SIZE.width);
  assert.deepEqual(next.notebook.getBounds(), saved.orbBounds);
  next.notebookController.setCollapsed(false);
  assert.deepEqual(next.notebook.getBounds(), saved.expandedBounds);
  h.notebookController.dispose(); await h.notebookController.show();
  assert.deepEqual(h.notebook.getPresentation(), { collapsed: true });
});

test("orb and expanded board stay inside small or changed displays; invalid saved data is ignored", async () => {
  const h = createWindowHarness();
  h.savedNotebookState = { collapsed: true, orbBounds: { x: -9000, y: 9000 }, expandedBounds: { x: NaN, y: 0 } };
  h.notebookController.getWorkArea = () => ({ x: -320, y: 0, width: 320, height: 400 });
  await h.notebookController.show();
  assert.deepEqual(h.notebook.getBounds(), { x: -320, y: 324, ...NOTEBOOK_ORB_SIZE });
  h.cursor = { x: -300, y: 350 }; h.notebookController.startDrag();
  h.cursor = { x: -5000, y: -5000 }; h.runTimers(16); h.notebookController.finishDrag();
  assert.equal(h.notebook.getBounds().y, 0);
  h.notebookController.setCollapsed(false);
  const expanded = h.notebook.getBounds();
  assert.ok(expanded.x >= -320 && expanded.y >= 0 && expanded.x + expanded.width <= 0 && expanded.y + expanded.height <= 400);
});

test("hiding or disposing during a drag cancels polling and never counts as an expand click", async () => {
  for (const action of ["hide", "dispose"]) {
    const h = await open(); h.notebookController.setCollapsed(true); h.notebookController.startDrag();
    h.notebookController[action]();
    h.cursor = { x: 5000, y: 5000 }; h.runTimers(16);
    assert.deepEqual(h.notebookController.finishDrag(), { dragged: true });
    assert.equal(h.notebook.isVisible(), false);
  }
});

test("collapsing stops wallpaper discovery and discards a pending background result", async () => {
  const h = await open(), pending = deferred();
  h.preferences.appearance.notebookStyle = "glass"; await h.notebookController.applyPreferences();
  let calls = 0; h.getBackgroundSource = () => { calls++; return pending.promise; };
  const request = h.notebook.getBackground(); h.notebookController.setCollapsed(true);
  pending.resolve({ source: { id: "window:1:0" } });
  assert.equal(await request, null);
  assert.equal(await h.notebook.getBackground(), null); assert.equal(calls, 1);
});

test("orb IPC uses the actual controller and rejects other windows, subframes and invalid mode values", async () => {
  const h = await open(), handlers = new Map(), native = h.nativeWindows[0];
  installNotebookWindowIpc({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, window: h.notebook, controller: h.notebookController });
  const trusted = { sender: native.webContents, senderFrame: native.webContents.mainFrame };
  for (const handler of handlers.values()) {
    assert.throws(() => handler({ sender: {}, senderFrame: {} }, true), /Untrusted/);
    assert.throws(() => handler({ ...trusted, senderFrame: {} }, true), /Untrusted/);
  }
  assert.throws(() => handlers.get("notebook:collapse")(trusted, "true"), /Invalid/);
  assert.deepEqual(handlers.get("notebook:collapse")(trusted, true), { collapsed: true });
  assert.equal(handlers.get("notebook:drag-start")(trusted), true);
  assert.deepEqual(handlers.get("notebook:drag-end")(trusted, false), { dragged: false });
  assert.deepEqual(handlers.get("notebook:collapse")(trusted, false), { collapsed: false });
});

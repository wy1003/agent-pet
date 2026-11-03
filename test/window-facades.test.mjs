import assert from "node:assert/strict";
import test from "node:test";
import { WindowFacade } from "../desktop/windows/window-facade.mjs";
import { SettingsWindowFacade } from "../desktop/windows/settings-window.mjs";
import { DailyReportWindowFacade } from "../desktop/windows/daily-report-window.mjs";
import { SpeechWindowFacade } from "../desktop/windows/speech-window.mjs";
import { createWindowHarness, deferred } from "../test-support/window-harness.mjs";

for (const showTaskPanel of [false, true]) {
  for (const showUsageCard of [false, true]) {
    for (const showNotebook of [false, true]) {
    test(`pet click controls tasks=${showTaskPanel}, usage=${showUsageCard} independently of notebook=${showNotebook}`, async () => {
      const h = createWindowHarness();
      Object.assign(h.preferences.appearance, { showTaskPanel, showUsageCard, showNotebook });
      await h.pet.ensureCreated();
      await h.notebookController.applyPreferences();
      assert.equal(await h.coordinator.toggle(), showTaskPanel || showUsageCard);
      assert.equal(h.tasks.isVisible(), showTaskPanel);
      assert.equal(h.usage.isVisible(), showUsageCard);
      assert.equal(h.notebook.isVisible(), showNotebook);
      assert.equal(h.nativeWindows.length, 1 + Number(showTaskPanel) + Number(showUsageCard) + Number(showNotebook));
      if (showTaskPanel || showUsageCard) {
        assert.equal((showTaskPanel ? h.tasks : h.usage).isFocused(), true);
        assert.equal(await h.coordinator.toggle(), false);
        assert.equal(h.coordinator.isVisible(), false);
      }
      h.runTimers(30_000);
      assert.equal(h.notebook.isVisible(), showNotebook);
    });
    }
  }
}

test("notebook persists through blur, pet drag, hiding pet and popover reclamation", async () => {
  const h = createWindowHarness();
  h.preferences.appearance.showNotebook = true;
  await h.pet.ensureCreated();
  await h.notebookController.applyPreferences();
  assert.equal(h.notebook.isVisible(), true);
  h.notebook.setBounds({ x: 100, y: 90, width: 380, height: 460 });
  const position = h.notebook.getBounds();
  const native = h.nativeWindows.find(window => window.url.endsWith("notebook.html"));
  native.emit("blur");
  h.runTimers(120);
  assert.equal(h.notebook.isVisible(), true);
  await h.coordinator.show();
  h.coordinator.hide();
  h.pet.setBounds({ x: 1000, y: 600, width: 120, height: 129 });
  h.coordinator.position();
  await h.coordinator.resume();
  h.pet.hide(); h.coordinator.hide();
  h.runTimers(30_000);
  assert.equal(h.notebook.isVisible(), true);
  assert.equal(h.notebook.isDestroyed(), false);
  assert.deepEqual(h.notebook.getBounds(), position);
});

test("empty tasks and notebook close affect only their own window group", async () => {
  const h = createWindowHarness();
  h.preferences.appearance.showNotebook = true;
  await h.notebookController.applyPreferences();
  await h.coordinator.show();
  h.coordinator.hideEmptyTasks();
  assert.equal(h.tasks.isVisible(), false);
  assert.equal(h.notebook.isVisible(), true);
  await h.coordinator.show();
  h.nativeWindows.find(window => window.url.endsWith("notebook.html")).close();
  assert.equal(h.notebook.isVisible(), false);
  assert.equal(h.notebook.isDestroyed(), false, "explicit hide retains drafts and window position");
  assert.equal(h.preferences.appearance.showNotebook, false);
  assert.equal(h.tasks.isVisible(), true);
  assert.equal(h.usage.isVisible(), true);
});

test("notebook has independent always-on-top and settings do not reposition or steal focus", async () => {
  const h = createWindowHarness();
  h.preferences.appearance.showNotebook = true;
  await h.notebookController.applyPreferences();
  const native = h.nativeWindows[0];
  assert.equal(native.focused, false);
  assert.equal(native.alwaysOnTop, true);
  h.notebook.setBounds({ x: 123, y: 234, width: 380, height: 460 });
  h.preferences.appearance.alwaysOnTop = false;
  await h.coordinator.applyPreferences();
  await h.notebookController.applyPreferences();
  assert.equal(native.alwaysOnTop, true);
  assert.equal(native.focused, false);
  assert.equal(h.notebook.getBounds().x, 123);
  h.preferences.appearance.notebookAlwaysOnTop = false;
  await h.notebookController.applyPreferences();
  assert.equal(native.alwaysOnTop, false);
});

test("disabling notebook during loading cancels stale display and keeps the other selection", async () => {
  const h = createWindowHarness();
  h.savedNotebookBounds = { x: 37, y: 91 };
  h.preferences.appearance.showNotebook = true;
  const gate = deferred();
  h.load = () => gate.promise;
  const opening = h.notebookController.applyPreferences();
  h.preferences.appearance.showNotebook = false;
  const applying = h.notebookController.applyPreferences();
  gate.resolve();
  await Promise.all([opening, applying]);
  assert.equal(h.nativeWindows.length, 1);
  assert.equal(h.notebook.isVisible(), false);
  assert.equal(h.tasks.isVisible(), false);
  h.preferences.appearance.showNotebook = true;
  await h.notebookController.applyPreferences();
  assert.equal(h.notebook.isVisible(), true);
  assert.equal(h.notebook.getBounds().x, 37);
});

test("notebook restores independent coordinates and clamps to available displays", async () => {
  for (const area of [{ x: 0, y: 0, width: 1920, height: 1040 },
    { x: -1280, y: -100, width: 1280, height: 720 }, { x: 0, y: 0, width: 320, height: 400 }]) {
    for (const saved of [null, { x: -4000, y: 5000 }, { x: area.x + 25, y: area.y + 26 }]) {
      const h = createWindowHarness();
      h.notebookController.getWorkArea = () => area;
      h.savedNotebookBounds = saved;
      h.preferences.appearance.showNotebook = true;
      await h.notebookController.applyPreferences();
      const board = h.notebook.getBounds();
      assert.ok(board.x >= area.x && board.y >= area.y);
      assert.ok(board.x + board.width <= area.x + area.width);
      assert.ok(board.y + board.height <= area.y + area.height);
      h.notebookController.getWorkArea = () => ({ x: 100, y: 100, width: 800, height: 600 });
      h.notebookController.keepOnScreen();
      assert.ok(h.notebook.getBounds().x >= 100 && h.notebook.getBounds().y >= 100);
    }
  }
});

test("notebook creation failure can retry and quitting cancels pending display", async () => {
  const h = createWindowHarness(); h.preferences.appearance.showNotebook = true;
  h.load = async () => { throw new Error("load failed"); };
  await assert.rejects(h.notebookController.applyPreferences(), /load failed/);
  h.load = async () => {};
  await h.notebookController.applyPreferences();
  assert.equal(h.notebook.isVisible(), true);
  h.notebookController.dispose();
  const gate = deferred(); h.load = () => gate.promise;
  const opening = h.notebookController.show(); h.quitting = true; h.notebookController.dispose();
  gate.resolve(); await opening;
  assert.equal(h.notebook.isVisible(), false);
});

test("turning off quota repositions tasks and only-quota mode focuses and refreshes quota", async () => {
  const h = createWindowHarness();
  await h.pet.ensureCreated();
  await h.coordinator.show();
  const withQuota = h.tasks.getBounds().x;
  h.preferences.appearance.showUsageCard = false;
  await h.coordinator.applyPreferences();
  assert.equal(h.usage.isVisible(), false);
  assert.ok(h.tasks.getBounds().x > withQuota);
  h.preferences.appearance.showTaskPanel = false;
  h.preferences.appearance.showUsageCard = true;
  await h.coordinator.applyPreferences();
  assert.equal(h.tasks.isVisible(), false);
  assert.equal(h.usage.isVisible(), true);
  h.coordinator.hide();
  await h.coordinator.show();
  assert.equal(h.usage.isFocused(), true);
  assert.equal(h.nativeWindows.at(-1).messages.at(-1).channel, "usage:card-shown");
  h.preferences.appearance.showUsageCard = false;
  await h.coordinator.applyPreferences();
  assert.equal(h.coordinator.isOpen(), false);
  assert.equal(h.coordinator.isVisible(), false);
});

test("settings do not open hidden popovers, and tray can explicitly open disabled tasks", async () => {
  const h = createWindowHarness();
  Object.assign(h.preferences.appearance, { showTaskPanel: false, showUsageCard: false });
  await h.coordinator.applyPreferences();
  assert.equal(h.nativeWindows.length, 0);
  assert.equal(await h.coordinator.show({ forceTasks: true }), true);
  assert.equal(h.tasks.isVisible(), true);
  assert.equal(h.preferences.appearance.showTaskPanel, false);
  h.coordinator.hide();
  await h.coordinator.toggle();
  assert.equal(h.tasks.isVisible(), false);
});

test("quota-only popovers survive drag suspension and release when unfocused", async () => {
  const h = createWindowHarness();
  h.preferences.appearance.showTaskPanel = false;
  await h.coordinator.show();
  assert.equal(h.coordinator.isOpen(), true);
  h.coordinator.hide();
  await h.coordinator.resume();
  assert.equal(h.usage.isVisible(), true);
  h.nativeWindows[0].focused = false;
  h.coordinator.hideWhenFocusLeaves();
  h.runTimers(120);
  assert.equal(h.coordinator.isVisible(), false);
  h.runTimers(30_000);
  assert.equal(h.usage.isDestroyed(), true);
  await h.coordinator.show();
  assert.equal(h.usage.isVisible(), true);
  assert.equal(h.nativeWindows.length, 2);
});

test("moving focus between popovers preserves both and close hides the group", async () => {
  const h = createWindowHarness();
  await h.coordinator.show();
  const usage = h.nativeWindows.find((window) => window.url.endsWith("usage-card.html"));
  usage.focus();
  h.runTimers(120);
  assert.equal(h.tasks.isVisible(), true);
  assert.equal(h.usage.isVisible(), true);
  usage.close();
  assert.equal(h.coordinator.isVisible(), false);
  assert.equal(usage.destroyed, false);
});

test("a second click while loading cancels opening and disabled windows stay hidden", async () => {
  const h = createWindowHarness();
  const gate = deferred();
  h.load = () => gate.promise;
  const opening = h.coordinator.toggle();
  assert.equal(await h.coordinator.toggle(), false);
  gate.resolve();
  assert.equal(await opening, false);
  assert.equal(h.coordinator.isVisible(), false);
  assert.equal(h.nativeWindows.length, 2);
  h.runTimers(30_000);
  assert.ok(h.nativeWindows.every((window) => window.destroyed));
});

test("preference changes during load cancel stale selection without duplicate windows", async () => {
  const h = createWindowHarness();
  const gate = deferred();
  h.load = () => gate.promise;
  const opening = h.coordinator.show();
  h.preferences.appearance.showTaskPanel = false;
  const applying = h.coordinator.applyPreferences();
  gate.resolve();
  await Promise.all([opening, applying]);
  assert.equal(h.nativeWindows.length, 2);
  assert.equal(h.tasks.isVisible(), false);
  assert.equal(h.usage.isVisible(), true);
});

test("failed creation cleans up and a later open retries successfully", async () => {
  const h = createWindowHarness();
  h.load = async () => { throw new Error("load failed"); };
  await assert.rejects(h.coordinator.show(), /load failed/);
  assert.equal(h.coordinator.isOpen(), false);
  assert.ok(h.nativeWindows.every((window) => window.destroyed));
  h.load = async () => {};
  assert.equal(await h.coordinator.show(), true);
});

test("all tool window facades deduplicate opening, restore and recreate safely", async () => {
  const h = createWindowHarness();
  const dependencies = { ...h.dependencies, productName: "Agent Pet", getIcon: () => null,
    isDark: () => false, onClosed: () => {} };
  for (const Type of [SettingsWindowFacade, DailyReportWindowFacade, SpeechWindowFacade]) {
    const facade = new Type(dependencies);
    const before = h.nativeWindows.length;
    await Promise.all([facade.ensureCreated(), facade.ensureCreated()]);
    assert.equal(h.nativeWindows.length, before + 1);
    assert.equal(facade.isVisible(), false);
    assert.equal("webContents" in facade, false);
    assert.equal("window" in facade, false);
    h.nativeWindows.at(-1).minimized = true;
    await facade.show();
    assert.equal(h.nativeWindows.at(-1).minimized, false);
    facade.destroy();
    await facade.ensureCreated();
    assert.equal(h.nativeWindows.length, before + 2);
  }
});

test("facade checks sender and main frame, blocks external navigation and cancels pending show", async () => {
  const h = createWindowHarness();
  const gate = deferred();
  h.load = () => gate.promise;
  const facade = new WindowFacade({ createWindow: h.dependencies.createWindow,
    getOptions: () => ({}), getUrl: () => "http://127.0.0.1:43123/settings.html" });
  const showing = facade.show();
  facade.hide();
  gate.resolve();
  assert.equal(await showing, false);
  const native = h.nativeWindows[0];
  assert.equal(facade.ownsSender({ sender: {} }), false);
  assert.equal(facade.ownsMainFrame({ sender: native.webContents, senderFrame: {} }), false);
  assert.equal(facade.ownsMainFrame({ sender: native.webContents, senderFrame: native.webContents.mainFrame }), true);
  assert.deepEqual(native.openHandler(), { action: "deny" });
  let blocked = 0;
  const event = { preventDefault: () => { blocked += 1; } };
  native.webContents.emit("will-navigate", event, "http://127.0.0.1:43123/settings.html");
  native.webContents.emit("will-navigate", event, "https://example.com/");
  native.webContents.emit("will-navigate", event, "invalid-url");
  assert.equal(blocked, 2);
  facade.destroy();
  assert.equal(facade.ownsSender({ sender: native.webContents }), false);
});

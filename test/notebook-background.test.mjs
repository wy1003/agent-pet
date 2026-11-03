import test from "node:test";
import assert from "node:assert/strict";
import { chooseDesktopBackground, createDesktopBackgroundSource } from "../desktop/notebook/desktop-background-source.mjs";
import { backgroundCrop } from "../public/notebook-background-geometry.mjs";
import { createWindowHarness, deferred } from "../test-support/window-harness.mjs";

test("desktop source chooses the intersecting host and rejects malformed bounds and screen capture IDs", () => {
  const a = { id: "window:1:0", x: -1920, y: 0, width: 1920, height: 1080 };
  const b = { id: "window:2:0", x: 0, y: 0, width: 3840, height: 2160 };
  assert.deepEqual(chooseDesktopBackground([a, b], { x: -300, y: 100, width: 500, height: 600 }), a);
  assert.deepEqual(chooseDesktopBackground([a, b], { x: -200, y: 100, width: 500, height: 600 }), b);
  assert.equal(chooseDesktopBackground([{ ...b, id: "screen:0:0" }, { ...b, width: NaN }], b), null);
  assert.equal(chooseDesktopBackground([a], { x: 0, y: 0, width: 100, height: 100 }), null);
});

test("source discovery coalesces calls, caches metadata and handles unsupported systems or discovery failures", async () => {
  let calls = 0, time = 100, fail = false;
  const data = { id: "window:1:0", x: 0, y: 0, width: 3840, height: 2160 };
  const source = createDesktopBackgroundSource({ platform: "win32", now: () => time,
    read: async () => "Get-DesktopSource", execute: async (_file, _args, options) => {
      calls++; assert.equal(options.windowsHide, true);
      if (fail) throw Error("unavailable");
      return { stdout: JSON.stringify([data]) };
    } });
  const results = await Promise.all([source.get(data), source.get(data)]);
  assert.equal(calls, 1); assert.deepEqual(results[0].source, data);
  await source.get(data); assert.equal(calls, 1);
  fail = true; time += 6000; assert.equal((await source.get(data)).source, null);
  assert.equal(calls, 2);
  const unsupported = createDesktopBackgroundSource({ platform: "darwin", execute: () => assert.fail("no platform helper") });
  assert.equal((await unsupported.get(data)).supported, false);
});

test("wallpaper crop aligns physical source pixels with a scaled window, including negative monitor origins", () => {
  const source = { x: -3840, y: 0, width: 3840, height: 2160 };
  const viewport = { x: -1500, y: 300, width: 570, height: 690 };
  const surface = { x: 6, y: 6, width: 368, height: 448 };
  const crop = backgroundCrop(source, viewport, surface, { width: 1600, height: 900 }, { width: 380, height: 460 });
  assert.deepEqual(crop, { x: 963.75, y: 113.75, width: 260, height: 310, outputWidth: 416, outputHeight: 496 });
  const moved = backgroundCrop(source, { ...viewport, x: -1200 }, surface, { width: 1600, height: 900 }, { width: 380, height: 460 });
  assert.equal(moved.x - crop.x, 125);
  assert.equal(backgroundCrop(source, viewport, surface, { width: 0, height: 0 }, { width: 380, height: 460 }), null);
});

test("notebook only discovers backgrounds while visible and glass; late results are discarded after hide", async () => {
  const h = createWindowHarness(); let calls = 0; const pending = deferred();
  h.getBackgroundSource = async viewport => { calls++; return pending.promise; };
  assert.equal(await h.notebook.getBackground(), null);
  h.preferences.appearance.showNotebook = true;
  await h.notebookController.applyPreferences();
  assert.equal(await h.notebook.getBackground(), null); assert.equal(calls, 0);
  h.preferences.appearance.notebookStyle = "glass";
  await h.notebookController.applyPreferences();
  const result = h.notebook.getBackground();
  h.notebook.hide(); pending.resolve({ source: { id: "window:1:0" } });
  assert.equal(await result, null); assert.equal(calls, 1);
  assert.equal(h.nativeWindows[0].messages.at(-1).channel, "notebook:visibility-changed");
  assert.equal(h.nativeWindows[0].messages.at(-1).payload, false);
});

import assert from "node:assert/strict";
import test from "node:test";
import { createWindowHarness } from "../test-support/window-harness.mjs";

test("notebook uses one transparent container and switches page styles in place", async () => {
  const h = createWindowHarness();
  h.preferences.appearance.showNotebook = true;
  await h.notebookController.applyPreferences();
  const native = h.nativeWindows[0];
  assert.equal(native.options.transparent, true);
  assert.equal(native.options.backgroundColor, "#00000000");
  assert.equal(native.options.hasShadow, false);
  assert.equal(native.options.backgroundMaterial, undefined);
  assert.equal(native.material, undefined);
  assert.deepEqual(h.notebook.getAppearance(), { style: "classic" });
  h.notebook.setBounds({ x: 234, y: 123, width: 380, height: 460 });
  const bounds = h.notebook.getBounds();
  native.setBackgroundMaterial = native.setShape = () => { throw Error("Page styles must not require native effects"); };
  for (const style of ["glass", "classic", "glass"]) {
    h.preferences.appearance.notebookStyle = style;
    await h.notebookController.applyPreferences();
    assert.deepEqual(h.notebook.getAppearance(), { style });
    assert.equal(native.messages.at(-1).channel, "notebook:appearance-changed");
    assert.deepEqual(native.messages.at(-1).payload, { style });
    assert.equal(h.nativeWindows.length, 1, "no recreation or renderer reload");
    assert.equal(native.focused, false);
    assert.deepEqual(h.notebook.getBounds(), bounds);
    assert.equal(h.notebook.isVisible(), true);
  }
});

test("page glass selection applies before load and survives hiding and recreation", async () => {
  const h = createWindowHarness();
  Object.assign(h.preferences.appearance, { showNotebook: true, notebookStyle: "glass" });
  h.load = async () => {
    assert.deepEqual(h.notebook.getAppearance(), { style: "glass" });
    assert.equal(h.nativeWindows.at(-1).material, undefined);
  };
  await h.notebookController.applyPreferences();
  h.notebookController.hide();
  await h.notebookController.show();
  assert.equal(h.nativeWindows.length, 1);
  h.notebookController.dispose();
  await h.notebookController.show();
  assert.equal(h.nativeWindows.length, 2);
  assert.equal(h.nativeWindows[1].options.transparent, true);
  const snapshot = h.notebook.getAppearance(); snapshot.style = "classic";
  assert.equal(h.notebook.getAppearance().style, "glass");
});

import test from "node:test";
import assert from "node:assert/strict";
import { createGlassBackground } from "../public/notebook-glass-background.js";
import { deferred } from "../test-support/window-harness.mjs";

function fixture(t) {
  const descriptors = new Map();
  const replace = (key, value) => {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  };
  const listeners = {}, mediaListeners = {}, frames = new Map();
  const contrast = { matches: false, addEventListener: (name, fn) => { mediaListeners[name] = fn; } };
  const root = { dataset: {} }, videos = [], tracks = [], canvases = [];
  const state = { requests: 0, paints: 0, background: async () => ({ supported: true,
    source: { id: "window:1:0", x: 0, y: 0, width: 1920, height: 1080 },
    viewport: { x: 100, y: 100, width: 380, height: 460 } }) };
  const media = async () => {
    const track = { readyState: "live", stop() { this.readyState = "ended"; }, addEventListener() {} };
    tracks.push(track);
    return { getTracks: () => [track], getVideoTracks: () => [track] };
  };
  state.media = media;
  for (let i = 0; i < 2; i++) canvases.push({ width: 0, height: 0, getContext: () => ({ fillRect() {}, drawImage() { state.paints++; } }) });
  const material = { hidden: true, querySelectorAll: () => canvases };
  const surface = { querySelector: () => material, getBoundingClientRect: () => ({ x: 6, y: 6, width: 368, height: 448 }) };
  replace("document", { hidden: false, documentElement: root, addEventListener: (name, fn) => { listeners[name] = fn; },
    createElement: () => {
      const video = { readyState: 0, videoWidth: 1600, videoHeight: 900,
        async play() { this.readyState = 2; }, pause() {},
        requestVideoFrameCallback(fn) { const id = {}; frames.set(id, fn); return id; },
        cancelVideoFrameCallback(id) { frames.delete(id); } };
      videos.push(video); return video;
    } });
  replace("window", { addEventListener: (name, fn) => { listeners[name] = fn; } });
  replace("navigator", { mediaDevices: { getUserMedia: (...args) => state.media(...args) } });
  replace("matchMedia", () => contrast); replace("innerWidth", 380); replace("innerHeight", 460);
  const bridge = { getNotebookBackground: () => { state.requests++; return state.background(); },
    onNotebookBackgroundPosition: fn => { listeners.position = fn; }, onNotebookVisibilityChanged: fn => { listeners.visible = fn; } };
  const background = createGlassBackground(surface, bridge);
  t.after(() => {
    background.setEnabled(false);
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  return { background, root, material, tracks, state, listeners, mediaListeners, contrast, canvases, media };
}

test("collapse stops capture but retains the painted frame; expansion keeps it until a fresh frame arrives", async t => {
  const h = fixture(t); h.background.setEnabled(true); assert.equal(await h.background.whenReady(), true);
  const paints = h.state.paints, size = h.canvases.map(c => [c.width, c.height]);
  h.background.setEnabled(false, { retainFrame: true });
  assert.equal(h.tracks[0].readyState, "ended");
  assert.equal(h.root.dataset.glassBackground, "cached"); assert.equal(h.material.hidden, false);
  h.listeners.position({ x: 500, y: 100, width: 76, height: 76 });
  assert.equal(h.state.paints, paints); assert.deepEqual(h.canvases.map(c => [c.width, c.height]), size);
  const gate = deferred(); h.state.background = () => gate.promise;
  h.background.setEnabled(true);
  assert.equal(await h.background.whenReady(), true, "cached paint is immediately available");
  assert.equal(h.root.dataset.glassBackground, "cached"); assert.equal(h.material.hidden, false);
  gate.resolve({ supported: true, source: { id: "window:1:0", x: 0, y: 0, width: 1920, height: 1080 } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.root.dataset.glassBackground, "live"); assert.ok(h.state.paints > paints);
});

test("cold expansion waits for its first frame and cancellation resolves the wait without showing stale media", async t => {
  const h = fixture(t), mediaGate = deferred(); h.state.media = () => mediaGate.promise;
  h.background.setEnabled(true);
  let ready = false; const waiting = h.background.whenReady().then(value => { ready = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ready, false); assert.equal(h.background.hasFrame(), false);
  h.background.setEnabled(false, { retainFrame: true });
  assert.equal(await waiting, false);
  const late = await h.media(); mediaGate.resolve(late);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(late.getTracks()[0].readyState, "ended");
  assert.equal(h.material.hidden, true); assert.equal(h.state.paints, 0);
});

test("hide retains the frame; changing styles and forced colors discard cached presentation", async t => {
  const h = fixture(t); h.background.setEnabled(true); await h.background.whenReady();
  h.listeners.visible(false); assert.equal(h.root.dataset.glassBackground, "cached");
  h.background.setEnabled(false); assert.equal(h.root.dataset.glassBackground, undefined);
  h.listeners.visible(true); h.background.setEnabled(true); await h.background.whenReady();
  h.contrast.matches = true; h.mediaListeners.change();
  assert.equal(h.material.hidden, true); assert.equal(h.background.hasFrame(), false);
  assert.equal(await h.background.whenReady(), false);
});

test("missing or failed background sources release the initial reveal wait", async t => {
  const h = fixture(t); h.state.background = async () => ({ supported: false });
  h.background.setEnabled(true); assert.equal(await h.background.whenReady(), false);
  h.background.setEnabled(false); h.state.background = async () => { throw Error("source failed"); };
  h.background.setEnabled(true); assert.equal(await h.background.whenReady(), false);
  assert.equal(h.background.hasFrame(), false);
});

test("an unresponsive source cannot leave the notebook waiting indefinitely", async t => {
  const h = fixture(t); h.state.background = () => new Promise(() => {});
  h.background.setEnabled(true);
  assert.equal(await h.background.whenReady(), false);
  assert.equal(h.background.hasFrame(), false);
});

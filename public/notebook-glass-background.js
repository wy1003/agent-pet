import { backgroundCrop } from "./notebook-background-geometry.mjs";

/** Captures only the trusted desktop host, never the screen or arbitrary app IDs. */
export function createGlassBackground(surface, bridge = window.companion) {
  const material = surface.querySelector(".glass-material");
  const canvases = [...material.querySelectorAll("canvas")];
  const contexts = canvases.map(canvas => canvas.getContext("2d", { alpha: false }));
  const video = document.createElement("video");
  video.muted = true; video.playsInline = true;
  const contrast = matchMedia("(forced-colors: active)");
  let enabled = false, visible = !document.hidden, generation = 0;
  let stream = null, source = null, viewport = null, callback = 0, retry = 0;
  let hasFrame = false;
  const readyWaiters = new Set();
  const active = () => enabled && visible && !contrast.matches;
  function settleReady(value) {
    for (const resolve of readyWaiters) resolve(value);
    readyWaiters.clear();
  }
  function stop({ retainFrame = false } = {}) {
    generation++;
    clearTimeout(retry); retry = 0;
    if (callback) video.cancelVideoFrameCallback(callback);
    callback = 0;
    stream?.getTracks().forEach(track => track.stop());
    stream = null; source = null;
    video.pause(); video.srcObject = null;
    if (retainFrame && hasFrame && !contrast.matches) {
      material.hidden = false;
      document.documentElement.dataset.glassBackground = "cached";
    } else {
      hasFrame = false;
      material.hidden = true;
      delete document.documentElement.dataset.glassBackground;
    }
  }
  function draw() {
    if (!active() || !source || video.readyState < 2) return;
    const crop = backgroundCrop(source, viewport, surface.getBoundingClientRect(),
      { width: video.videoWidth, height: video.videoHeight }, { width: innerWidth, height: innerHeight });
    if (!crop) return;
    canvases.forEach((canvas, i) => {
      if (canvas.width !== crop.outputWidth || canvas.height !== crop.outputHeight) {
        canvas.width = crop.outputWidth; canvas.height = crop.outputHeight;
      }
      const context = contexts[i];
      context.fillStyle = "#526b78"; context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
    });
    material.hidden = false;
    hasFrame = true;
    document.documentElement.dataset.glassBackground = "live";
    settleReady(true);
  }
  function nextFrame() {
    if (!active() || !stream) return;
    draw(); callback = video.requestVideoFrameCallback(nextFrame);
  }
  function scheduleRetry() {
    clearTimeout(retry);
    if (active()) retry = setTimeout(start, 10000);
  }
  async function start() {
    // Stop media tracks without throwing away the last painted, blurred surface.
    stop({ retainFrame: true });
    if (!active() || !bridge?.getNotebookBackground) { settleReady(false); return; }
    const revision = generation;
    try {
      const background = await bridge.getNotebookBackground();
      if (revision !== generation || !active()) return;
      if (!background?.source) { settleReady(false); if (background?.supported) scheduleRetry(); return; }
      const nextStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: {
        chromeMediaSource: "desktop", chromeMediaSourceId: background.source.id,
        maxFrameRate: 8, maxWidth: 1600, maxHeight: 900,
      } } });
      if (revision !== generation || !active()) { nextStream.getTracks().forEach(track => track.stop()); return; }
      // Position events received while discovery was pending are newer than its snapshot.
      source = background.source; viewport ??= background.viewport; stream = nextStream;
      stream.getVideoTracks()[0].addEventListener("ended", () => {
        if (revision === generation) { stop({ retainFrame: true }); settleReady(false); scheduleRetry(); }
      }, { once: true });
      video.srcObject = stream;
      await video.play();
      if (revision !== generation || !active()) return;
      nextFrame();
    } catch {
      if (revision === generation) { stop({ retainFrame: true }); settleReady(false); scheduleRetry(); }
    }
  }
  bridge?.onNotebookBackgroundPosition?.(position => {
    viewport = position;
    if (source && (position.x + position.width <= source.x || position.x >= source.x + source.width
      || position.y + position.height <= source.y || position.y >= source.y + source.height)) start();
    else draw();
  });
  const visibility = value => {
    if (visible === value) { if (active() && !stream) start(); return; }
    visible = value;
    if (active()) start(); else { stop({ retainFrame: true }); settleReady(false); }
  };
  bridge?.onNotebookVisibilityChanged?.(visibility);
  document.addEventListener("visibilitychange", () => visibility(!document.hidden));
  contrast.addEventListener("change", () => { if (active()) start(); else { stop(); settleReady(false); } });
  window.addEventListener("resize", draw);
  window.addEventListener("beforeunload", () => { stop(); settleReady(false); });
  return {
    hasFrame: () => hasFrame && !contrast.matches,
    // Bound cold starts: an unavailable desktop source must not trap the user in the orb.
    whenReady() {
      if (hasFrame && !contrast.matches) return Promise.resolve(true);
      if (!active() || !bridge?.getNotebookBackground) return Promise.resolve(false);
      return new Promise(resolve => {
        const finish = value => { clearTimeout(timer); readyWaiters.delete(finish); resolve(value); };
        const timer = setTimeout(() => finish(false), 1800);
        readyWaiters.add(finish);
      });
    },
    setEnabled(value, { retainFrame = false } = {}) {
      if (enabled === value) {
        if (!value && !retainFrame) { stop(); settleReady(false); }
        return;
      }
      enabled = value;
      if (active()) start(); else { stop({ retainFrame }); settleReady(false); }
    },
  };
}

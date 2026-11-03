import { createGlassBackground } from "./notebook-glass-background.js";

/** Decorative rim only: no scaling or text filtering.
 * Inspired by liquid-glass-react's separate backdrop / masked rim / content layers.
 */
export function createNotebookGlass(surface) {
  const background = createGlassBackground(surface);
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  let enabled = false;
  let frame = 0;
  let point = null;
  const reset = () => {
    cancelAnimationFrame(frame); frame = 0; point = null;
    surface.style.removeProperty("--glass-light-x");
    surface.style.removeProperty("--glass-light-y");
    surface.style.removeProperty("--glass-light-angle");
  };
  const move = event => {
    if (!enabled || motion.matches || event.pointerType === "touch") return;
    point = { x: event.clientX, y: event.clientY };
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const rect = surface.getBoundingClientRect();
      if (!point || !rect.width || !rect.height) return;
      const x = Math.min(1, Math.max(0, (point.x - rect.left) / rect.width));
      const y = Math.min(1, Math.max(0, (point.y - rect.top) / rect.height));
      surface.style.setProperty("--glass-light-x", `${(x * 100).toFixed(1)}%`);
      surface.style.setProperty("--glass-light-y", `${(y * 100).toFixed(1)}%`);
      surface.style.setProperty("--glass-light-angle", `${(115 + x * 55 - y * 20).toFixed(1)}deg`);
    });
  };
  const sync = () => {
    surface.removeEventListener("pointermove", move);
    surface.removeEventListener("pointerleave", reset);
    reset();
    if (enabled && !motion.matches) {
      surface.addEventListener("pointermove", move, { passive: true });
      surface.addEventListener("pointerleave", reset, { passive: true });
    }
  };
  motion.addEventListener("change", sync);
  return {
    hasFrame: background.hasFrame,
    whenReady: background.whenReady,
    setEnabled(value, options) { background.setEnabled(value, options); if (enabled !== value) { enabled = value; sync(); } },
  };
}

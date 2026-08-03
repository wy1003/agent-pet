import { PET_DRAG_PROFILE } from "./pet-drag-profile.mjs";

function magnitude(x, y) {
  return Math.hypot(Number(x) || 0, Number(y) || 0);
}

export function crossedDragThreshold(start, current, profile = PET_DRAG_PROFILE) {
  return magnitude(current.x - start.x, current.y - start.y) >= profile.dragThreshold;
}

export function appendVelocitySample(samples, sample, profile = PET_DRAG_PROFILE) {
  const next = [...(samples || [])];
  const normalized = {
    x: Number(sample?.x) || 0,
    y: Number(sample?.y) || 0,
    time: Number(sample?.time) || 0,
  };
  const previous = next.at(-1);
  if (!previous || (
    normalized.time - previous.time >= profile.minimumSampleIntervalMs
    && magnitude(normalized.x - previous.x, normalized.y - previous.y)
      >= profile.minimumSampleDistance
  )) {
    next.push(normalized);
  }
  const cutoff = normalized.time - profile.sampleWindowMs;
  while (next.length > 2 && next[0].time < cutoff) next.shift();
  return next;
}

export function releaseVelocity(samples, profile = PET_DRAG_PROFILE) {
  if (!Array.isArray(samples) || samples.length < 2) return { x: 0, y: 0, speed: 0 };
  const first = samples[0];
  const last = samples.at(-1);
  const elapsedSeconds = (last.time - first.time) / 1000;
  if (!(elapsedSeconds > 0)) return { x: 0, y: 0, speed: 0 };
  let x = (last.x - first.x) / elapsedSeconds;
  let y = (last.y - first.y) / elapsedSeconds;
  let speed = magnitude(x, y);
  if (speed < profile.minimumFlingSpeed) return { x: 0, y: 0, speed: 0 };
  if (speed > profile.maximumFlingSpeed) {
    const scale = profile.maximumFlingSpeed / speed;
    x *= scale;
    y *= scale;
    speed = profile.maximumFlingSpeed;
  }
  return { x, y, speed };
}

export function advanceInertia(motion, elapsedMs, workArea, size, profile = PET_DRAG_PROFILE) {
  const dt = Math.max(0, Math.min(profile.maximumStepMs, Number(elapsedMs) || 0));
  const seconds = dt / 1000;
  const width = Math.min(Number(size?.width) || 0, workArea.width);
  const height = Math.min(Number(size?.height) || 0, workArea.height);
  const minimumX = workArea.x;
  const maximumX = workArea.x + workArea.width - width;
  const minimumY = workArea.y;
  const maximumY = workArea.y + workArea.height - height;
  let x = (Number(motion?.x) || 0) + (Number(motion?.velocityX) || 0) * seconds;
  let y = (Number(motion?.y) || 0) + (Number(motion?.velocityY) || 0) * seconds;
  let velocityX = Number(motion?.velocityX) || 0;
  let velocityY = Number(motion?.velocityY) || 0;

  if (x < minimumX || x > maximumX) {
    x = Math.max(minimumX, Math.min(maximumX, x));
    velocityX = -velocityX * profile.bounceFactor;
  }
  if (y < minimumY || y > maximumY) {
    y = Math.max(minimumY, Math.min(maximumY, y));
    velocityY = -velocityY * profile.bounceFactor;
  }

  const decay = profile.frictionPerFrame ** (dt / profile.frameMs);
  velocityX *= decay;
  velocityY *= decay;
  const durationMs = (Number(motion?.durationMs) || 0) + dt;
  const speed = magnitude(velocityX, velocityY);
  return {
    x,
    y,
    velocityX,
    velocityY,
    durationMs,
    speed,
    done: durationMs >= profile.maximumDurationMs || speed < profile.stopSpeed,
  };
}

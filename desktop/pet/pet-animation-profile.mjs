export const PET_ANIMATION_PROFILE = Object.freeze({
  idle: Object.freeze({ row: 0, durations: Object.freeze([280, 110, 110, 140, 140, 320]), idleMultiplier: 6 }),
  "running-right": Object.freeze({ row: 1, durations: Object.freeze([120, 120, 120, 120, 120, 120, 120, 220]) }),
  "running-left": Object.freeze({ row: 2, durations: Object.freeze([120, 120, 120, 120, 120, 120, 120, 220]) }),
  waving: Object.freeze({ row: 3, durations: Object.freeze([140, 140, 140, 280]), loops: 3 }),
  jumping: Object.freeze({ row: 4, durations: Object.freeze([140, 140, 140, 140, 280]), loops: 3 }),
  failed: Object.freeze({ row: 5, durations: Object.freeze([140, 140, 140, 140, 140, 140, 140, 240]), loops: 3 }),
  waiting: Object.freeze({ row: 6, durations: Object.freeze([150, 150, 150, 150, 150, 260]) }),
  running: Object.freeze({ row: 7, durations: Object.freeze([120, 120, 120, 120, 120, 220]) }),
  review: Object.freeze({ row: 8, durations: Object.freeze([150, 150, 150, 150, 150, 280]) }),
});

export const PET_SPRITE_CONTRACTS = Object.freeze({
  1: Object.freeze({ columns: 8, rows: 9 }),
  2: Object.freeze({ columns: 8, rows: 11 }),
});

export function normalizeSpriteVersion(value) {
  return Number(value) === 2 ? 2 : 1;
}

export function spriteFramePosition(column, row, version = 1) {
  const contract = PET_SPRITE_CONTRACTS[normalizeSpriteVersion(version)];
  const safeColumn = Math.max(0, Math.min(contract.columns - 1, Math.trunc(Number(column) || 0)));
  const safeRow = Math.max(0, Math.min(contract.rows - 1, Math.trunc(Number(row) || 0)));
  return {
    xPercent: safeColumn / (contract.columns - 1) * 100,
    yPercent: safeRow / (contract.rows - 1) * 100,
    backgroundSize: `${contract.columns * 100}% ${contract.rows * 100}%`,
  };
}

export function frameAtElapsedTime(state, elapsedMs, options = {}) {
  const animation = PET_ANIMATION_PROFILE[state] || PET_ANIMATION_PROFILE.idle;
  const multiplier = state === "idle" && options.slowIdle !== false
    ? animation.idleMultiplier || 1
    : 1;
  const durations = animation.durations.map((duration) => duration * multiplier);
  const cycleDuration = durations.reduce((total, duration) => total + duration, 0);
  const elapsed = Math.max(0, Number(elapsedMs) || 0);
  const completedLoops = cycleDuration > 0 ? Math.floor(elapsed / cycleDuration) : 0;
  let position = cycleDuration > 0 ? elapsed % cycleDuration : 0;
  let column = durations.length - 1;
  for (let index = 0; index < durations.length; index += 1) {
    if (position < durations[index]) {
      column = index;
      break;
    }
    position -= durations[index];
  }
  return { column, row: animation.row, completedLoops, cycleDuration };
}

export function lookDirectionFrame(angleDegrees) {
  const normalized = ((Number(angleDegrees) || 0) % 360 + 360) % 360;
  const direction = Math.round(normalized / 22.5) % 16;
  return {
    direction,
    row: direction < 8 ? 9 : 10,
    column: direction % 8,
  };
}

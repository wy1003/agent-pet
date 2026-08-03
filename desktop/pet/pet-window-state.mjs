import { clampWindowBounds, defaultBadgeBounds } from "../window-layout.mjs";

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function displayId(display) {
  return String(display?.id ?? "");
}

export function resolutionKey(bounds) {
  return `${Math.max(0, Math.round(Number(bounds?.width) || 0))}x${Math.max(0, Math.round(Number(bounds?.height) || 0))}`;
}

export function petWindowSize(width, padding = 4) {
  const petWidth = Math.max(80, Math.min(224, Math.round(Number(width) || 112)));
  const safePadding = Math.max(0, Math.min(16, Math.round(Number(padding) || 0)));
  return {
    width: petWidth + safePadding * 2,
    height: Math.round(petWidth * 208 / 192) + safePadding * 2,
    petWidth,
    padding: safePadding,
  };
}

function defaultBounds(display, size) {
  const square = defaultBadgeBounds(display.workArea, Math.max(size.width, size.height), 24);
  return clampWindowBounds({ ...square, width: size.width, height: size.height }, display.workArea);
}

function displayContainingBounds(displays, bounds) {
  const center = {
    x: (Number(bounds?.x) || 0) + (Number(bounds?.width) || 0) / 2,
    y: (Number(bounds?.y) || 0) + (Number(bounds?.height) || 0) / 2,
  };
  return displays.find((display) => {
    const area = display.workArea;
    return center.x >= area.x && center.x <= area.x + area.width
      && center.y >= area.y && center.y <= area.y + area.height;
  });
}

export function restorePetWindowBounds(state, displays, primaryDisplay, size) {
  const available = Array.isArray(displays) && displays.length ? displays : [primaryDisplay];
  const pet = object(state?.pet);
  const byDisplayId = object(pet.byDisplayId);
  const byResolution = object(pet.byResolution);
  let target = available.find((display) => displayId(display) === String(pet.displayId || ""));
  let anchor = target ? object(byDisplayId[displayId(target)]).anchor || pet.anchor : null;

  if (!target) {
    target = available.find((display) => byDisplayId[displayId(display)]);
    if (target) anchor = object(byDisplayId[displayId(target)]).anchor;
  }
  if (!target) {
    target = available.find((display) => byResolution[resolutionKey(display.bounds)]);
    if (target) anchor = object(byResolution[resolutionKey(target.bounds)]).anchor;
  }

  const legacyBounds = object(state?.badgeBounds);
  if (!target && Number.isFinite(Number(legacyBounds.x)) && Number.isFinite(Number(legacyBounds.y))) {
    target = displayContainingBounds(available, legacyBounds) || primaryDisplay;
    anchor = { x: Number(legacyBounds.x), y: Number(legacyBounds.y) };
  }

  target ||= primaryDisplay || available[0];
  if (!anchor || !Number.isFinite(Number(anchor.x)) || !Number.isFinite(Number(anchor.y))) {
    return defaultBounds(target, size);
  }
  return clampWindowBounds({
    x: Math.round(Number(anchor.x)),
    y: Math.round(Number(anchor.y)),
    width: size.width,
    height: size.height,
  }, target.workArea);
}

export function createPetWindowState(previousState, bounds, display, petPreferences = {}) {
  const previousPet = object(previousState?.pet);
  const id = displayId(display);
  const anchor = { x: Math.round(bounds.x), y: Math.round(bounds.y) };
  const displayBounds = { ...display.bounds };
  const entry = { anchor, displayBounds };
  return {
    version: 2,
    pet: {
      selectedPetId: String(petPreferences.selectedPetId || previousPet.selectedPetId || "builtin-default"),
      width: Math.max(80, Math.min(224, Math.round(Number(petPreferences.width) || 112))),
      displayId: id,
      displayBounds,
      anchor,
      byDisplayId: { ...object(previousPet.byDisplayId), [id]: entry },
      byResolution: { ...object(previousPet.byResolution), [resolutionKey(displayBounds)]: { anchor } },
    },
    badgeBounds: { ...bounds },
  };
}

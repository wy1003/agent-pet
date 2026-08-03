export function clampWindowBounds(bounds, workArea) {
  const width = Math.min(bounds.width, workArea.width);
  const height = Math.min(bounds.height, workArea.height);
  return {
    width,
    height,
    x: Math.min(
      Math.max(bounds.x, workArea.x),
      workArea.x + Math.max(0, workArea.width - width),
    ),
    y: Math.min(
      Math.max(bounds.y, workArea.y),
      workArea.y + Math.max(0, workArea.height - height),
    ),
  };
}

export function defaultBadgeBounds(workArea, size = 112, margin = 26) {
  return {
    width: size,
    height: size,
    x: workArea.x + workArea.width - size - margin,
    y: workArea.y + workArea.height - size - margin,
  };
}

export function panelVerticalAlignment(itemCount, panelHeight, badgeHeight) {
  const compactHeightLimit = Math.max(150, Math.round(Number(badgeHeight || 0) * 0.85));
  return Number(itemCount) <= 1 && Number(panelHeight) <= compactHeightLimit
    ? "head"
    : "bottom";
}

export function panelBoundsNearBadge(
  badgeBounds,
  panelSize,
  workArea,
  gap = 12,
  verticalAlignment = "bottom",
) {
  const fitsLeft = badgeBounds.x - panelSize.width - gap >= workArea.x;
  const x = fitsLeft
    ? badgeBounds.x - panelSize.width - gap
    : badgeBounds.x + badgeBounds.width + gap;
  const y = verticalAlignment === "head"
    ? badgeBounds.y + Math.round(badgeBounds.height * 0.32) - panelSize.height
    : badgeBounds.y + badgeBounds.height - panelSize.height;
  return clampWindowBounds(
    { x, y, width: panelSize.width, height: panelSize.height },
    workArea,
  );
}

export function badgeBoundsForDrag(initialBounds, initialCursor, currentCursor, workArea) {
  return clampWindowBounds(
    {
      ...initialBounds,
      x: initialBounds.x + currentCursor.x - initialCursor.x,
      y: initialBounds.y + currentCursor.y - initialCursor.y,
    },
    workArea,
  );
}

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

export function usageCardBoundsNearBadge(
  badgeBounds,
  cardSize,
  workArea,
  gap = 10,
) {
  const rightX = badgeBounds.x + badgeBounds.width + gap;
  const leftX = badgeBounds.x - cardSize.width - gap;
  const fitsRight = rightX + cardSize.width <= workArea.x + workArea.width;
  const fitsLeft = leftX >= workArea.x;
  const x = fitsRight || !fitsLeft ? rightX : leftX;
  const y = badgeBounds.y + Math.round((badgeBounds.height - cardSize.height) / 2);
  return clampWindowBounds(
    { x, y, width: cardSize.width, height: cardSize.height },
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

/** Find the nearest free slot without moving the existing pet/task/quota arrangement. */
export function windowBoundsNearGroup(anchor, size, occupied, workArea, gap = 12) {
  const width = Math.min(size.width, Math.max(1, workArea.width - gap * 2));
  const height = Math.min(size.height, Math.max(1, workArea.height - gap * 2));
  const xs = [workArea.x + gap, workArea.x + workArea.width - width - gap];
  const ys = [anchor.y + anchor.height - height, workArea.y + gap,
    workArea.y + workArea.height - height - gap];
  for (const bounds of occupied) {
    xs.push(bounds.x - width - gap, bounds.x + bounds.width + gap);
    ys.push(bounds.y - height - gap, bounds.y + bounds.height + gap);
  }
  const candidates = xs.flatMap(x => ys.map(y => {
    const bounds = clampWindowBounds({ x, y, width, height }, workArea);
    const overlap = occupied.reduce((area, item) => area
      + Math.max(0, Math.min(bounds.x + width, item.x + item.width + gap) - Math.max(bounds.x, item.x - gap))
      * Math.max(0, Math.min(bounds.y + height, item.y + item.height + gap) - Math.max(bounds.y, item.y - gap)), 0);
    const distance = Math.hypot(bounds.x + width / 2 - anchor.x - anchor.width / 2,
      bounds.y + height - anchor.y - anchor.height);
    return { bounds, overlap, distance };
  }));
  candidates.sort((a, b) => a.overlap - b.overlap || a.distance - b.distance);
  return candidates[0].bounds;
}

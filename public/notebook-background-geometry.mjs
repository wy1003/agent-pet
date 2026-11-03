/** Screen/source bounds are physical pixels; DOM bounds are CSS pixels. */
export function backgroundCrop(source, viewport, surface, video, view, padding = 24) {
  if (![source?.width, source?.height, viewport?.width, viewport?.height, video?.width, video?.height, view?.width, view?.height].every(value => Number.isFinite(value) && value > 0)) return null;
  const scaleX = viewport.width / view.width, scaleY = viewport.height / view.height;
  const sourceX = video.width / source.width, sourceY = video.height / source.height;
  return {
    x: (viewport.x + (surface.x - padding) * scaleX - source.x) * sourceX,
    y: (viewport.y + (surface.y - padding) * scaleY - source.y) * sourceY,
    width: (surface.width + padding * 2) * scaleX * sourceX,
    height: (surface.height + padding * 2) * scaleY * sourceY,
    outputWidth: Math.ceil(surface.width + padding * 2),
    outputHeight: Math.ceil(surface.height + padding * 2),
  };
}

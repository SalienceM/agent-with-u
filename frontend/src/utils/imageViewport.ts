export interface ImageSize { width: number; height: number }
export interface ImageView { scale: number; x: number; y: number }
export interface ImagePoint { x: number; y: number }

export function fitImageScale(image: ImageSize, viewport: ImageSize): number {
  if (image.width <= 0 || image.height <= 0) return 1;
  return Math.min(1, Math.max(1, viewport.width - 24) / image.width,
    Math.max(1, viewport.height - 24) / image.height);
}

export function imageScaleLimits(image: ImageSize, viewport: ImageSize): { min: number; max: number } {
  return { min: Math.min(0.05, fitImageScale(image, viewport) / 4), max: 16 };
}

/** 小图保持居中；大图可拖到每条边，但不能整张拖出视野。 */
export function constrainImageView(view: ImageView, image: ImageSize, viewport: ImageSize): ImageView {
  const limits = imageScaleLimits(image, viewport);
  const scale = Math.max(limits.min, Math.min(limits.max, Number.isFinite(view.scale) ? view.scale : 1));
  const maxX = Math.max(0, (image.width * scale - viewport.width) / 2);
  const maxY = Math.max(0, (image.height * scale - viewport.height) / 2);
  return { scale, x: Math.max(-maxX, Math.min(maxX, view.x || 0)), y: Math.max(-maxY, Math.min(maxY, view.y || 0)) };
}

/** anchor 以画布中心为原点，缩放固定鼠标/双指下的内容，双指中心移动同时平移。 */
export function zoomImageAt(
  view: ImageView, image: ImageSize, viewport: ImageSize, scale: number,
  anchor: ImagePoint = { x: 0, y: 0 }, nextAnchor: ImagePoint = anchor,
): ImageView {
  const limits = imageScaleLimits(image, viewport);
  const nextScale = Math.max(limits.min, Math.min(limits.max, scale));
  const ratio = nextScale / view.scale;
  return constrainImageView({
    scale: nextScale,
    x: nextAnchor.x - (anchor.x - view.x) * ratio,
    y: nextAnchor.y - (anchor.y - view.y) * ratio,
  }, image, viewport);
}

export function wheelImageScale(scale: number, delta: number, mode: number, viewportHeight: number): number {
  const pixels = delta * (mode === 1 ? 16 : mode === 2 ? viewportHeight : 1);
  return scale * Math.exp(-Math.max(-1000, Math.min(1000, pixels)) * 0.002);
}

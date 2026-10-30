/**
 * Alpha bounding-box scanning: the tight foreground box of an RGBA buffer,
 * the cached per-source lookup used by auto-crop, and the blob-keyed warm
 * helper. Pure canvas reads; importing this module has no side effects.
 */

const ALPHA_BBOX_FLOOR = 4;
let bboxCache = null;
/** Cutout-blob-keyed box cache, shared with the export pipeline's readouts. */
export const blobBBoxCache = new WeakMap();

/**
 * Scans an RGBA pixel buffer (`width * height * 4`) for the tight bounding box
 * of pixels with `alpha > threshold`. Falls back to the full frame when empty.
 * Each bound scans inward from its edge and stops at the first hit, so a
 * typical centered subject costs a fraction of a full pass.
 */
export function scanAlphaBBoxFromPixels(
  data,
  width,
  height,
  threshold = ALPHA_BBOX_FLOOR
) {
  const w = Math.max(1, width | 0);
  const h = Math.max(1, height | 0);
  const rowBytes = w * 4;

  const rowHasAlpha = (y) => {
    for (let i = y * rowBytes + 3, end = (y + 1) * rowBytes; i < end; i += 4) {
      if (data[i] > threshold) return true;
    }
    return false;
  };
  const colHasAlpha = (x, y0, y1) => {
    for (let y = y0; y <= y1; y++) {
      if (data[(y * w + x) * 4 + 3] > threshold) return true;
    }
    return false;
  };

  let minY = 0;
  while (minY < h && !rowHasAlpha(minY)) minY++;
  let maxY = h - 1;
  while (maxY > minY && !rowHasAlpha(maxY)) maxY--;
  if (minY > maxY) return { x: 0, y: 0, w, h };

  let minX = 0;
  while (minX < w && !colHasAlpha(minX, minY, maxY)) minX++;
  let maxX = w - 1;
  while (maxX > minX && !colHasAlpha(maxX, minY, maxY)) maxX--;

  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * Returns the tight alpha bounding box `{ x, y, w, h }` of `source` at the
 * given `shadowCutoff` percentage. The full-res pixel buffer is cached by
 * `(source, srcW, srcH)` so a cutoff change only costs a rescan, not another
 * drawImage + getImageData readback.
 */
export function computeAlphaBBox(source, srcW, srcH, shadowCutoff = 0, blobKey = null) {
  const w = Math.max(1, srcW | 0);
  const h = Math.max(1, srcH | 0);
  const cutoff = Number(shadowCutoff) || 0;
  const threshold = Math.max(ALPHA_BBOX_FLOOR, Math.round((cutoff / 100) * 255));
  const tryHit = (e) => {
    if (!e || e.w !== w || e.h !== h) return null;
    if (e.cutoff !== cutoff) {
      e.box = scanAlphaBBoxFromPixels(e.data, w, h, threshold);
      e.cutoff = cutoff;
    }
    return e.box;
  };
  if (blobKey && typeof blobKey === "object") {
    const hit = tryHit(blobBBoxCache.get(blobKey));
    if (hit) return hit;
  }
  const key = source?.currentSrc || source?.src || source;
  if (bboxCache && bboxCache.key === key) {
    const hit = tryHit(bboxCache);
    if (hit) return hit;
  }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  canvas.width = 0;
  canvas.height = 0;
  const box = scanAlphaBBoxFromPixels(data, w, h, threshold);
  const entry = { key, w, h, cutoff, box, data };
  bboxCache = entry;
  if (blobKey && typeof blobKey === "object") blobBBoxCache.set(blobKey, entry);
  return box;
}

/** Pre-computes and caches the alpha bounding box for a cutout `Blob`. */
export async function warmBlobAlphaBBox(blob, fallbackW = 0, fallbackH = 0, shadowCutoff = 0) {
  if (!blob || typeof createImageBitmap !== "function") return null;
  if (blobBBoxCache.has(blob)) {
    const e = blobBBoxCache.get(blob);
    return computeAlphaBBox(null, e.w, e.h, shadowCutoff, blob);
  }
  try {
    const bmp = await createImageBitmap(blob);
    try {
      const w = fallbackW || bmp.width || 1;
      const h = fallbackH || bmp.height || 1;
      return computeAlphaBBox(bmp, w, h, shadowCutoff, blob);
    } finally {
      bmp.close?.();
    }
  } catch (_) {
    return null;
  }
}

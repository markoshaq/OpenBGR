/**
 * Export pipeline: offscreen canvas rendering (PNG, WebP, JPG, 8-bit Mask),
 * alpha shadow/reflection thresholding, matte backdrop compositing, the live
 * stage preview, and the byte-exact export cache. Panel readouts live in
 * export-ui.js; save/copy actions in export-io.js; ZIP packaging in zip.js.
 */

import {
  state,
  dom,
  masterCutoutImg,
  saveStateToActiveTab,
  isPassthroughExport,
  resolveBackdropSource,
  resolveFileBackdropSource,
  formatDiskBytes,
} from "./state.js";
import { emit } from "./bus.js";

const ALPHA_BBOX_FLOOR = 4;
let bboxCache = null;
const blobBBoxCache = new WeakMap();

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
      const w = fallbackW || bmp.width || state.naturalWidth || 1;
      const h = fallbackH || bmp.height || state.naturalHeight || 1;
      return computeAlphaBBox(bmp, w, h, shadowCutoff, blob);
    } finally {
      bmp.close?.();
    }
  } catch (_) {
    return null;
  }
}

/** Expands `{ x, y, w, h }` symmetrically by `paddingPct`% of `max(w, h)`. */
export function expandCropBox(box, paddingPct = 0) {
  const pad = Math.round(Math.max(box.w, box.h) * (Math.max(0, Number(paddingPct) || 0) / 100));
  return { x: box.x - pad, y: box.y - pad, w: Math.max(1, box.w + 2 * pad), h: Math.max(1, box.h + 2 * pad) };
}

/** Returns the active crop rectangle `{ x, y, w, h }` in source pixel coordinates. */
export function getActiveCropRect(frameBlob = null) {
  const srcW = state.naturalWidth || masterCutoutImg.naturalWidth || 0;
  const srcH = state.naturalHeight || masterCutoutImg.naturalHeight || 0;
  let targetBlob = frameBlob || state.resultBlob;
  if (!targetBlob && state.isAnimated && state.frames.length > 1) {
    const s = Math.max(0, (state.startFrame || 1) - 1);
    const e = Math.min(state.frames.length - 1, (state.endFrame || state.frames.length) - 1);
    for (let i = s; i <= e; i++) {
      if (state.frames[i]?.resultBlob) { targetBlob = state.frames[i].resultBlob; break; }
    }
  }
  if (!state.autoCrop || !targetBlob || srcW < 1 || srcH < 1) return { x: 0, y: 0, w: srcW, h: srcH };
  if (blobBBoxCache.has(targetBlob)) {
    return expandCropBox(computeAlphaBBox(null, srcW, srcH, state.shadowCutoff, targetBlob), state.cropPadding);
  }
  if (!masterCutoutImg.complete || !masterCutoutImg.naturalWidth) return { x: 0, y: 0, w: srcW, h: srcH };
  return expandCropBox(computeAlphaBBox(masterCutoutImg, srcW, srcH, state.shadowCutoff, targetBlob), state.cropPadding);
}

/** Returns the 100%-scale base `{ w, h }` of the active image (cropped when Auto-Crop is on). */
export function getExportBaseDims() {
  const { w, h } = getActiveCropRect();
  return { w, h };
}
/** Affine placement of `cropRect` inside `targetW` x `targetH` (fit or stretch). */
function cropPlacement(cropRect, targetW, targetH, stretch) {
  const sameRatio =
    Math.abs(targetW * cropRect.h - targetH * cropRect.w) <=
    Math.max(cropRect.w, cropRect.h);
  // "uniform" is the centered aspect-fit; otherwise the rect maps to the
  // canvas with independent X/Y scales (equal when aspects already match).
  const uniform = !stretch && !sameRatio;
  const fit = Math.min(targetW / cropRect.w, targetH / cropRect.h);
  const scaleX = uniform ? fit : targetW / cropRect.w;
  const scaleY = uniform ? fit : targetH / cropRect.h;
  const offsetX = uniform ? (targetW - cropRect.w * fit) / 2 : 0;
  const offsetY = uniform ? (targetH - cropRect.h * fit) / 2 : 0;
  return { scaleX, scaleY, offsetX, offsetY };
}

/**
 * Draws `cropRect` from `source` (`srcW` x `srcH`) onto `ctx` (`targetW` x `targetH`).
 * Clips source sampling to `[0, 0, srcW, srcH]` so padding outside the frame stays
 * transparent, and centers aspect-preservingly inside custom non-matching boxes.
 */
function drawCroppedSource(ctx, source, srcW, srcH, cropRect, targetW, targetH, stretch = false) {
  const sx0 = Math.max(0, cropRect.x);
  const sy0 = Math.max(0, cropRect.y);
  const sw = Math.min(srcW, cropRect.x + cropRect.w) - sx0;
  const sh = Math.min(srcH, cropRect.y + cropRect.h) - sy0;
  if (sw <= 0 || sh <= 0) return;

  const { scaleX, scaleY, offsetX, offsetY } = cropPlacement(
    cropRect,
    targetW,
    targetH,
    stretch
  );

  ctx.drawImage(
    source,
    sx0,
    sy0,
    sw,
    sh,
    offsetX + (sx0 - cropRect.x) * scaleX,
    offsetY + (sy0 - cropRect.y) * scaleY,
    sw * scaleX,
    sh * scaleY
  );
}

/**
 * Two-pass separable box blur over RGBA pixels in place; two horizontal +
 * vertical sweeps of a sliding-window average approximate a Gaussian
 * closely enough for a backdrop. Border indices clamp (edge replication).
 */
function boxBlurRGBA(data, w, h, radius) {
  const tmp = new Uint8ClampedArray(data.length);
  const win = radius * 2 + 1;
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let r = 0, g = 0, b = 0, a = 0;
      for (let x = -radius; x <= radius; x++) {
        const i = (row + Math.min(w - 1, Math.max(0, x))) * 4;
        r += data[i]; g += data[i + 1]; b += data[i + 2]; a += data[i + 3];
      }
      for (let x = 0; x < w; x++) {
        const o = (row + x) * 4;
        tmp[o] = r / win; tmp[o + 1] = g / win; tmp[o + 2] = b / win; tmp[o + 3] = a / win;
        const iA = (row + Math.min(w - 1, x + radius + 1)) * 4;
        const iS = (row + Math.max(0, x - radius)) * 4;
        r += data[iA] - data[iS]; g += data[iA + 1] - data[iS + 1];
        b += data[iA + 2] - data[iS + 2]; a += data[iA + 3] - data[iS + 3];
      }
    }
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let y = -radius; y <= radius; y++) {
        const i = (Math.min(h - 1, Math.max(0, y)) * w + x) * 4;
        r += tmp[i]; g += tmp[i + 1]; b += tmp[i + 2]; a += tmp[i + 3];
      }
      for (let y = 0; y < h; y++) {
        const o = (y * w + x) * 4;
        data[o] = r / win; data[o + 1] = g / win; data[o + 2] = b / win; data[o + 3] = a / win;
        const iA = (Math.min(h - 1, y + radius + 1) * w + x) * 4;
        const iS = (Math.max(0, y - radius) * w + x) * 4;
        r += tmp[iA] - tmp[iS]; g += tmp[iA + 1] - tmp[iS + 1];
        b += tmp[iA + 2] - tmp[iS + 2]; a += tmp[iA + 3] - tmp[iS + 3];
      }
    }
  }
}

/**
 * Draws `srcRect` of `src` into `dstRect` blurred by `strength` (0-1; 0 draws
 * sharp). Uses the canvas filter blur when the engine supports it; otherwise
 * a real separable box blur runs on a ~12% scratch before the smoothed
 * upscale, which stays cheap on CPU-bound canvas engines.
 */
function drawBlurred(ctx, src, srcRect, dstRect, strength) {
  const s = Math.min(1, Math.max(0, strength));
  if (s <= 0) {
    ctx.drawImage(
      src,
      srcRect.x,
      srcRect.y,
      srcRect.w,
      srcRect.h,
      dstRect.x,
      dstRect.y,
      dstRect.w,
      dstRect.h
    );
    return;
  }
  if (typeof ctx.filter === "string") {
    // blur() takes a standard deviation; 3-4% of the width at full strength
    // lands in the portrait-bokeh range.
    const sigma = Math.max(
      1,
      Math.round(Math.min(40, Math.max(4, dstRect.w * 0.04)) * s)
    );
    ctx.filter = `blur(${sigma}px)`;
    ctx.drawImage(
      src,
      srcRect.x,
      srcRect.y,
      srcRect.w,
      srcRect.h,
      dstRect.x,
      dstRect.y,
      dstRect.w,
      dstRect.h
    );
    ctx.filter = "none";
    return;
  }
  const sw = Math.max(4, Math.round(dstRect.w * 0.12));
  const sh = Math.max(4, Math.round(dstRect.h * 0.12));
  const mini = document.createElement("canvas");
  mini.width = sw;
  mini.height = sh;
  const mctx = mini.getContext("2d", { willReadFrequently: true });
  mctx.imageSmoothingEnabled = true;
  mctx.imageSmoothingQuality = "high";
  mctx.drawImage(
    src,
    srcRect.x,
    srcRect.y,
    srcRect.w,
    srcRect.h,
    0,
    0,
    sw,
    sh
  );
  const imgData = mctx.getImageData(0, 0, sw, sh);
  boxBlurRGBA(imgData.data, sw, sh, Math.max(1, Math.round(s * sw * 0.08)));
  mctx.putImageData(imgData, 0, 0);
  ctx.drawImage(mini, dstRect.x, dstRect.y, dstRect.w, dstRect.h);
  mini.width = 0;
  mini.height = 0;
}

/**
 * Draws `source` at `targetW` x `targetH`, optionally trimming to the subject's
 * alpha bounding box (`autoCrop` + `cropPadding`), applies the `shadowCutoff`
 * alpha threshold, composites onto `backdrop` (flat color, "blur", or "image"
 * with `backdropSource`) when needed, and encodes to
 * `format` ("png" | "webp" | "jpg" | "mask").
 */
export async function renderExportBlob(source, srcW, srcH, opts) {
  const {
    format,
    targetW,
    targetH,
    shadowCutoff,
    backdrop,
    backdropSource = null,
    backdropBlur = 0,
    autoCrop = false,
    cropPadding = 0,
    cropBox = null,
    canvasFit = "fit",
  } = opts;
  const stretch = canvasFit === "stretch";

  const cropRect = autoCrop
    ? expandCropBox(
        cropBox || computeAlphaBBox(source, srcW, srcH, shadowCutoff),
        cropPadding
      )
    : { x: 0, y: 0, w: srcW, h: srcH };

  const canvas = document.createElement("canvas");
  canvas.width = targetW;
  canvas.height = targetH;
  // Mask mode reads every pixel back; the other formats stay GPU-friendly.
  const ctx = canvas.getContext("2d", {
    willReadFrequently: format === "mask",
  });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  const cutoffByte = Math.round((shadowCutoff / 100) * 255);
  const isImgBackdrop = backdrop === "blur" || backdrop === "image";
  const bw = backdropSource?.naturalWidth || backdropSource?.width || 0;
  const bh = backdropSource?.naturalHeight || backdropSource?.height || 0;
  const hasBackdropImg = isImgBackdrop && bw > 0 && bh > 0;
  // A loaded blur/image backdrop cover-fills the canvas itself, so flat
  // matting only applies to color backdrops, JPG's opacity requirement, and
  // the no-source fallback (transparent for png/webp, white for jpg).
  const needsMatte =
    format === "jpg" || (backdrop !== "checker" && !isImgBackdrop);
  const matteColor = isImgBackdrop
    ? "#ffffff"
    : backdrop === "checker"
      ? "#ffffff"
      : backdrop;

  const paintBackdrop = () => {
    if (needsMatte) {
      ctx.fillStyle = matteColor;
      ctx.fillRect(0, 0, targetW, targetH);
    }
    if (!hasBackdropImg) return;
    // Cover-fit the backdrop so it fills the canvas edge to edge.
    const cover = Math.max(targetW / bw, targetH / bh);
    const dw = bw * cover;
    const dh = bh * cover;
    const coverRect = {
      x: (targetW - dw) / 2,
      y: (targetH - dh) / 2,
      w: dw,
      h: dh,
    };
    const blurStrength = Math.max(0, Math.min(1, backdropBlur / 100));
    if (backdrop !== "blur") {
      drawBlurred(
        ctx,
        backdropSource,
        { x: 0, y: 0, w: bw, h: bh },
        coverRect,
        blurStrength
      );
      return;
    }
    // Margin fill first, then a second pass mapped with the exact affine
    // placement of the cutout (fit or stretch), so the subject overlays its
    // own blurred silhouette instead of a shifted ghost. Where the aligned
    // photo does not reach the canvas edge, the cover fill shows through.
    drawBlurred(
      ctx,
      backdropSource,
      { x: 0, y: 0, w: bw, h: bh },
      coverRect,
      blurStrength
    );
    const { scaleX, scaleY, offsetX, offsetY } = cropPlacement(
      cropRect,
      targetW,
      targetH,
      stretch
    );
    drawBlurred(
      ctx,
      backdropSource,
      { x: 0, y: 0, w: bw, h: bh },
      {
        x: offsetX - cropRect.x * scaleX,
        y: offsetY - cropRect.y * scaleY,
        w: bw * scaleX,
        h: bh * scaleY,
      },
      blurStrength
    );
  };

  if (format === "mask") {
    drawCroppedSource(ctx, source, srcW, srcH, cropRect, targetW, targetH, stretch);
    const imgData = ctx.getImageData(0, 0, targetW, targetH);
    const data = imgData.data;
    const span = Math.max(1, 255 - cutoffByte);
    for (let i = 0; i < data.length; i += 4) {
      let alpha = data[i + 3];
      if (cutoffByte > 0) {
        alpha =
          alpha <= cutoffByte
            ? 0
            : Math.min(255, Math.round(((alpha - cutoffByte) * 255) / span));
      }
      data[i] = alpha;
      data[i + 1] = alpha;
      data[i + 2] = alpha;
      data[i + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
    return canvasToBlob(canvas, "image/png");
  }

  if (cutoffByte > 0) {
    // Threshold alpha on an isolated foreground buffer before matte compositing.
    const fgCanvas = document.createElement("canvas");
    fgCanvas.width = targetW;
    fgCanvas.height = targetH;
    const fgCtx = fgCanvas.getContext("2d", { willReadFrequently: true });
    fgCtx.imageSmoothingEnabled = true;
    fgCtx.imageSmoothingQuality = "high";
    drawCroppedSource(fgCtx, source, srcW, srcH, cropRect, targetW, targetH, stretch);

    const imgData = fgCtx.getImageData(0, 0, targetW, targetH);
    const data = imgData.data;
    const span = Math.max(1, 255 - cutoffByte);
    for (let i = 3; i < data.length; i += 4) {
      const a = data[i];
      data[i] =
        a <= cutoffByte
          ? 0
          : Math.min(255, Math.round(((a - cutoffByte) * 255) / span));
    }
    fgCtx.putImageData(imgData, 0, 0);

    paintBackdrop();
    ctx.drawImage(fgCanvas, 0, 0);
    fgCanvas.width = 0;
    fgCanvas.height = 0;
  } else {
    paintBackdrop();
    drawCroppedSource(ctx, source, srcW, srcH, cropRect, targetW, targetH, stretch);
  }

  const mimeMap = {
    png: "image/png",
    webp: "image/webp",
    jpg: "image/jpeg",
  };
  const mimeType = mimeMap[format] || "image/png";
  const quality = format === "png" ? undefined : 0.95;
  return canvasToBlob(canvas, mimeType, quality);
}

/** Promisified `canvas.toBlob` with MIME/quality support. */
function canvasToBlob(canvas, mimeType, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => {
        canvas.width = 0;
        canvas.height = 0;
        if (b) resolve(b);
        else reject(new Error("Image encoding failed"));
      },
      mimeType,
      quality
    );
  });
}

/** Builds the final export blob for the active image using live export settings. */
export async function buildExportBlob(format) {
  const srcW = state.naturalWidth || masterCutoutImg.naturalWidth;
  const srcH = state.naturalHeight || masterCutoutImg.naturalHeight;
  const baseDims = getExportBaseDims();
  const targetW = Math.max(1, state.exportWidth || baseDims.w || srcW);
  const targetH = Math.max(1, state.exportHeight || baseDims.h || srcH);

  if (
    isPassthroughExport({
      format,
      targetW,
      targetH,
      srcW,
      srcH,
      autoCrop: state.autoCrop,
      backdrop: state.activeBackdrop,
      shadowCutoff: state.shadowCutoff,
    }) &&
    state.resultBlob
  ) {
    return state.resultBlob;
  }

  return renderExportBlob(masterCutoutImg, srcW, srcH, {
    format,
    targetW,
    targetH,
    shadowCutoff: state.shadowCutoff,
    backdrop: state.activeBackdrop,
    backdropSource: resolveBackdropSource(),
    backdropBlur: state.backdropBlur,
    autoCrop: state.autoCrop,
    cropPadding: state.cropPadding,
    canvasFit: state.canvasFit,
  });
}

/**
 * Builds the export blob for one batch item using the batch's settings
 * snapshot. `originalFile` is the entry's source image, needed when the
 * "blur" backdrop re-blurs it behind the cutout.
 */
export async function buildBatchExportBlob(blob, snap, originalFile = null) {
  const bmp = await createImageBitmap(blob);
  let bgBmp = null;
  try {
    const srcW = bmp.width;
    const srcH = bmp.height;
    const autoCrop = Boolean(snap.autoCrop);
    const cropPadding = snap.cropPadding || 0;
    const tightBox = autoCrop
      ? computeAlphaBBox(bmp, srcW, srcH, snap.shadowCutoff)
      : null;
    const { w: baseW, h: baseH } =
      autoCrop && tightBox
        ? expandCropBox(tightBox, cropPadding)
        : { w: srcW, h: srcH };

    let targetW = Math.max(1, Math.round(baseW * (snap.scale || 1)));
    let targetH = Math.max(1, Math.round(baseH * (snap.scale || 1)));

    // Custom dimensions act as an exact canvas box when both are set, or an
    // aspect-preserving bounding box when only one dimension is given.
    if (snap.exportWidth > 0 || snap.exportHeight > 0) {
      if (snap.exportWidth > 0 && snap.exportHeight > 0) {
        targetW = snap.exportWidth;
        targetH = snap.exportHeight;
      } else {
        const fit = Math.min(
          (snap.exportWidth || Infinity) / baseW,
          (snap.exportHeight || Infinity) / baseH
        );
        targetW = Math.max(1, Math.round(baseW * fit));
        targetH = Math.max(1, Math.round(baseH * fit));
      }
    }

    if (
      isPassthroughExport({
        format: snap.format,
        targetW,
        targetH,
        srcW,
        srcH,
        autoCrop,
        backdrop: snap.backdrop,
        shadowCutoff: snap.shadowCutoff,
      })
    ) {
      return blob;
    }

    const resolvedBackdrop = await resolveFileBackdropSource(
      snap.backdrop,
      originalFile,
      snap.backdropImg
    );
    bgBmp = resolvedBackdrop.ownedBitmap;
    const backdropSource = resolvedBackdrop.backdropSource;

    return await renderExportBlob(bmp, srcW, srcH, {
      format: snap.format,
      targetW,
      targetH,
      shadowCutoff: snap.shadowCutoff,
      backdrop: snap.backdrop,
      backdropSource,
      backdropBlur: snap.backdropBlur || 0,
      autoCrop,
      cropPadding,
      cropBox: tightBox,
      canvasFit: snap.canvasFit || "fit",
    });
  } finally {
    bmp.close();
    bgBmp?.close();
  }
}

/**
 * Settings signature identifying which render settings a blob was produced
 * under; used to detect stale preview/export-cache contents. Previews pass
 * their own dims/format so only byte-exact matches compare equal.
 */
function signatureFor({
  format,
  w,
  h,
  cutoff,
  backdrop,
  autoCrop,
  cropPadding,
}) {
  return JSON.stringify({
    format,
    w,
    h,
    cutoff,
    backdrop,
    bgSeq: backdrop === "image" ? state.backdropSeq : 0,
    bgBlur: backdrop === "blur" || backdrop === "image" ? state.backdropBlur : 0,
    autoCrop,
    cropPadding,
    canvasFit: state.canvasFit,
  });
}

export function exportSignature() {
  const sig = signatureFor({
    format: state.exportFormat,
    w: state.exportWidth,
    h: state.exportHeight,
    cutoff: state.shadowCutoff,
    backdrop: state.activeBackdrop,
    autoCrop: state.autoCrop,
    cropPadding: state.autoCrop ? state.cropPadding : 0,
  });
  if (!isAnimatedExport()) return sig;
  return `${sig}:${state.startFrame || 1}-${state.endFrame || state.frames.length}`;
}

/**
 * The signature a stage-preview render would carry under the current
 * settings. Animated tabs use it to detect stale per-frame previews: every
 * frame's `previewSignature` is compared against this value on selection and
 * by the background refresh pass.
 */
export function expectedPreviewSignature() {
  if (!previewNeedsRender()) {
    return signatureFor({
      format: "png",
      w: state.naturalWidth || masterCutoutImg.naturalWidth,
      h: state.naturalHeight || masterCutoutImg.naturalHeight,
      cutoff: 0,
      backdrop: "checker",
      autoCrop: false,
      cropPadding: 0,
    });
  }
  const { w, h } = previewTargetSize();
  const applyCrop = state.autoCrop && exportAspectMismatch();
  return signatureFor({
    format: state.exportFormat,
    w,
    h,
    cutoff: state.shadowCutoff,
    backdrop: state.activeBackdrop,
    autoCrop: applyCrop,
    cropPadding: applyCrop ? state.cropPadding : 0,
  });
}

/** True when the active tab exports a multi-frame animation rather than individual frames. */
export function isAnimatedExport() {
  return (
    state.isAnimated &&
    state.frames.length > 1 &&
    state.exportFormat === "gif"
  );
}

let animatedExportBuilder = null;
export function setAnimatedExportBuilder(fn) {
  animatedExportBuilder = fn;
}

export function currentExportSource() {
  if (!isAnimatedExport()) return state.resultBlob;
  const startIdx = Math.max(0, (state.startFrame || 1) - 1);
  return state.frames[startIdx]?.resultBlob || state.resultBlob;
}

/** True when the cached export blob is byte-exact for the current settings. */
export function exportCacheMatches() {
  const src = currentExportSource();
  return Boolean(
    src &&
      state.exportCacheBlob &&
      state.exportCacheSignature === exportSignature() &&
      state.exportCacheSource === src
  );
}

/**
 * Returns a blob that is byte-exact what an export would produce: the
 * background export cache when fresh, else the live preview blob when it was
 * rendered under the current export settings (raw passthrough included).
 */
export function exactExportBlob() {
  if (exportCacheMatches()) return state.exportCacheBlob;
  if (
    !isAnimatedExport() &&
    state.previewBlob &&
    state.previewSignature === exportSignature() &&
    state.previewSource === state.resultBlob
  ) {
    return state.previewBlob;
  }
  return null;
}

// One export-cache encode at a time: full-res canvas work is expensive, and
// slider bursts would otherwise stack encodes whose results are all but one
// discarded. Calls landing while busy are dropped; the drain loop re-encodes
// until the stored signature matches the live settings anyway.
let exportCacheBusy = false;

/**
 * Background full-res encode of the real export settings. The stage preview
 * is deliberately uncropped/capped, so its bytes can't back the size label:
 * this runs after each preview render whose signature differs from the
 * export's, giving an honest size readout and a warm EXPORT button.
 */
async function renderExportCache() {
  // Multi-frame tabs encode on-demand when EXPORT is clicked so slider bursts
  // and frame scrubbing do not trigger background multi-frame server encodes.
  if (exportCacheBusy || (state.isAnimated && state.frames.length > 1)) return;
  exportCacheBusy = true;
  try {
    while (!exportCacheMatches()) {
      const source = currentExportSource();
      const imgReady =
        masterCutoutImg.complete && masterCutoutImg.naturalWidth;
      if (!source || !imgReady) return;
      const renderedSig = exportSignature();
      let blob;
      if (isAnimatedExport()) {
        blob = await animatedExportBuilder(state.exportFormat, {
          showOverlay: false,
        });
        if (!blob) return;
      } else {
        const srcW = state.naturalWidth || masterCutoutImg.naturalWidth;
        const srcH = state.naturalHeight || masterCutoutImg.naturalHeight;
        const baseDims = getExportBaseDims();
        const targetW = Math.max(1, state.exportWidth || baseDims.w || srcW);
        const targetH = Math.max(1, state.exportHeight || baseDims.h || srcH);
        // Snapshot the signature alongside the render options so the stored
        // signature describes the settings this blob was encoded under, even
        // if they change while the encode is in flight.
        blob = await renderExportBlob(masterCutoutImg, srcW, srcH, {
          format: state.exportFormat,
          targetW,
          targetH,
          shadowCutoff: state.shadowCutoff,
          backdrop: state.activeBackdrop,
          backdropSource: resolveBackdropSource(),
          backdropBlur: state.backdropBlur,
          autoCrop: state.autoCrop,
          cropPadding: state.cropPadding,
          canvasFit: state.canvasFit,
        });
      }
      if (source !== currentExportSource()) continue; // cutout swapped; re-evaluate
      state.exportCacheBlob = blob;
      state.exportCacheSignature = renderedSig;
      state.exportCacheSource = source;
      if (dom.exportSizeLabel && exportCacheMatches()) {
        dom.exportSizeLabel.textContent = formatDiskBytes(blob.size);
      }
      saveStateToActiveTab();
    }
  } catch (err) {
    console.warn("[OpenBGR] Export cache render failed:", err);
  } finally {
    exportCacheBusy = false;
  }
}

/** Invokes the injected animated-export builder, or null before init. */
export const callAnimatedExportBuilder = (format, opts) =>
  animatedExportBuilder?.(format, opts) ?? null;

// Longest-side cap for the live stage preview in pixels. Full-res canvas
// work is only needed for the actual export; the stage just needs enough
// pixels to stay crisp at display size with some zoom headroom.
const PREVIEW_MAX_SIDE = 2048;
const PREVIEW_DEBOUNCE_MS = 150;
const PREVIEW_THROTTLE_MS = 400;

let previewTimer = null;
let previewLastStart = 0;

/** Export dims clamped to the preview cap, never upscaled past the target. */
export function previewTargetSize() {
  const srcW = state.naturalWidth || masterCutoutImg.naturalWidth;
  const srcH = state.naturalHeight || masterCutoutImg.naturalHeight;
  const uncroppedStage = state.autoCrop && !exportAspectMismatch();
  const scale = state.exportScale || 1;
  const scaledW = Math.max(1, Math.round(srcW * scale));
  const scaledH = Math.max(1, Math.round(srcH * scale));
  const targetW = Math.max(
    1,
    uncroppedStage ? scaledW : state.exportWidth || scaledW
  );
  const targetH = Math.max(
    1,
    uncroppedStage ? scaledH : state.exportHeight || scaledH
  );
  const k = Math.min(1, PREVIEW_MAX_SIDE / Math.max(targetW, targetH));
  return {
    w: Math.max(1, Math.round(targetW * k)),
    h: Math.max(1, Math.round(targetH * k)),
  };
}

/** True when the export box's aspect differs meaningfully from the base frame. */
export function exportAspectMismatch() {
  const baseDims = getExportBaseDims();
  const w = state.exportWidth;
  const h = state.exportHeight;
  if (!baseDims.w || !w || !h) return false;
  const mismatch = Math.abs(w * baseDims.h - h * baseDims.w);
  return mismatch > Math.max(w * baseDims.h, h * baseDims.w) * 0.02;
}

/** True when export settings change pixels or framing (cutoff, matte, mask, custom aspect); else the raw cutout is shown. */
export function previewNeedsRender() {
  if (
    state.shadowCutoff > 0 ||
    state.activeBackdrop !== "checker" ||
    state.exportFormat === "jpg" ||
    state.exportFormat === "mask"
  ) {
    return true;
  }
  // A preset or unlocked dims change the output canvas's aspect, so the raw
  // passthrough cutout no longer previews the real export framing.
  return exportAspectMismatch();
}

/**
 * Schedules a preview re-render after backdrop/scale/cutoff changes. Bursts of
 * input events (slider drags, keystrokes) coalesce into one render every
 * PREVIEW_THROTTLE_MS plus a trailing render PREVIEW_DEBOUNCE_MS after the
 * last event, so full-canvas encodes can't pile up on the main thread.
 */
export function updateLiveStagePreview() {
  // anim-preview.js listens for this and refreshes every processed frame,
  // so backdrop/cutoff/dims changes reach the whole animation, not only the
  // frame currently on stage.
  emit("animation:previews-scheduled");
  if (
    !state.resultBlob ||
    !masterCutoutImg.complete ||
    !masterCutoutImg.naturalWidth
  ) {
    return;
  }
  const token = ++state.previewRenderToken;
  const now = performance.now();
  clearTimeout(previewTimer);
  if (now - previewLastStart >= PREVIEW_THROTTLE_MS) {
    previewLastStart = now;
    renderLivePreview(token);
    return;
  }
  previewTimer = setTimeout(() => {
    previewLastStart = performance.now();
    renderLivePreview(token);
  }, PREVIEW_DEBOUNCE_MS);
}

/**
 * Renders the stage preview: the raw cutout is reused verbatim when nothing
 * changes pixels; otherwise the cutoff/matte/mask is drawn at display
 * resolution (not full res). `previewSignature` records what the blob
 * actually is so `exportActiveImage` only reuses it when it is byte-exact.
 */
async function renderLivePreview(token) {
  const source = state.resultBlob;
  if (!source || !masterCutoutImg.complete || !masterCutoutImg.naturalWidth) {
    return;
  }
  try {
    let blob;
    const renderedSig = expectedPreviewSignature();
    if (!previewNeedsRender()) {
      blob = source;
    } else {
      const srcW = state.naturalWidth || masterCutoutImg.naturalWidth;
      const srcH = state.naturalHeight || masterCutoutImg.naturalHeight;
      const { w, h } = previewTargetSize();
      const applyCrop = state.autoCrop && exportAspectMismatch();
      const previewFmt =
        state.exportFormat === "gif" ? "png" : state.exportFormat;
      blob = await renderExportBlob(masterCutoutImg, srcW, srcH, {
        format: previewFmt,
        targetW: w,
        targetH: h,
        shadowCutoff: state.shadowCutoff,
        backdrop: state.activeBackdrop,
        backdropSource: resolveBackdropSource(),
        backdropBlur: state.backdropBlur,
        autoCrop: applyCrop,
        cropPadding: applyCrop ? state.cropPadding : 0,
        canvasFit: state.canvasFit,
      });
    }
    if (token !== state.previewRenderToken) return;

    state.previewBlob = blob;
    state.previewSignature = renderedSig;
    state.previewSource = source;
    if (
      state.previewObjectUrl &&
      state.previewObjectUrl !== state.resultObjectUrl
    ) {
      URL.revokeObjectURL(state.previewObjectUrl);
    }

    state.previewObjectUrl =
      blob === state.resultBlob
        ? state.resultObjectUrl
        : URL.createObjectURL(blob);
    dom.afterImg.src = state.previewObjectUrl;
    // The byte size is only honest when the preview blob is exactly what an
    // export would produce (raw-passthrough or an uncapped render). When it
    // is not (auto-crop, capped preview dims), a background full-res encode
    // fills `exportCacheBlob` and updates the label itself.
    if (dom.exportSizeLabel && !(state.isAnimated && state.frames.length > 1)) {
      dom.exportSizeLabel.textContent =
        renderedSig === exportSignature()
          ? formatDiskBytes(blob.size)
          : "...";
    }
    if (renderedSig === exportSignature()) {
      state.exportCacheBlob = null;
      state.exportCacheSignature = null;
      state.exportCacheSource = null;
    } else {
      renderExportCache();
    }
    saveStateToActiveTab();
  } catch (err) {
    console.warn("[OpenBGR] Live preview render failed:", err);
  }
}

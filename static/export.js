/**
 * Export pipeline: offscreen canvas rendering (PNG, WebP, JPG, 8-bit Mask),
 * alpha shadow/reflection thresholding, matte backdrop compositing, live
 * stage preview, destination folder selection, and store-only ZIP packaging.
 */

import {
  state,
  dom,
  apiFetch,
  apiErrorDetail,
  masterCutoutImg,
  getActiveTab,
  saveStateToActiveTab,
  setError,
  blobToBase64,
  downloadBlob,
  setSuccess,
  FORMAT_EXT,
  FORMAT_LABELS,
  formatDiskBytes,
} from "./state.js";

const ALPHA_BBOX_FLOOR = 4;
let bboxCache = null;

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
export function computeAlphaBBox(source, srcW, srcH, shadowCutoff = 0) {
  const w = Math.max(1, srcW | 0);
  const h = Math.max(1, srcH | 0);
  const cutoff = Number(shadowCutoff) || 0;
  const key = source?.currentSrc || source?.src || source;
  const threshold = Math.max(
    ALPHA_BBOX_FLOOR,
    Math.round((cutoff / 100) * 255)
  );

  if (
    bboxCache &&
    bboxCache.key === key &&
    bboxCache.w === w &&
    bboxCache.h === h
  ) {
    if (bboxCache.cutoff === cutoff) return bboxCache.box;
    const box = scanAlphaBBoxFromPixels(bboxCache.data, w, h, threshold);
    bboxCache.cutoff = cutoff;
    bboxCache.box = box;
    return box;
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
  bboxCache = { key, w, h, cutoff, box, data };
  return box;
}

/** Expands `{ x, y, w, h }` symmetrically by `paddingPct`% of `max(w, h)`. */
export function expandCropBox(box, paddingPct = 0) {
  const pad = Math.round(
    Math.max(box.w, box.h) * (Math.max(0, Number(paddingPct) || 0) / 100)
  );
  return {
    x: box.x - pad,
    y: box.y - pad,
    w: Math.max(1, box.w + 2 * pad),
    h: Math.max(1, box.h + 2 * pad),
  };
}

/** Returns the active crop rectangle `{ x, y, w, h }` in source pixel coordinates. */
export function getActiveCropRect() {
  const srcW = state.naturalWidth || masterCutoutImg.naturalWidth || 0;
  const srcH = state.naturalHeight || masterCutoutImg.naturalHeight || 0;
  if (
    !state.autoCrop ||
    !state.resultBlob ||
    srcW < 1 ||
    srcH < 1 ||
    !masterCutoutImg.complete ||
    !masterCutoutImg.naturalWidth
  ) {
    return { x: 0, y: 0, w: srcW, h: srcH };
  }
  const tight = computeAlphaBBox(masterCutoutImg, srcW, srcH, state.shadowCutoff);
  return expandCropBox(tight, state.cropPadding);
}

/** Returns the 100%-scale base `{ w, h }` of the active image (cropped when Auto-Crop is on). */
export function getExportBaseDims() {
  const { w, h } = getActiveCropRect();
  return { w, h };
}

/** Updates the dashed crop-frame overlay on the stage when Auto-Crop is active. */
export function updateCropGuide() {
  const guide = dom.cropGuide;
  if (!guide) return;
  const srcW = state.naturalWidth || masterCutoutImg.naturalWidth || 0;
  const srcH = state.naturalHeight || masterCutoutImg.naturalHeight || 0;
  if (
    !state.autoCrop ||
    !state.resultBlob ||
    state.viewMode === "original" ||
    srcW < 1 ||
    srcH < 1
  ) {
    guide.classList.remove("visible");
    return;
  }
  const rect = getActiveCropRect();
  // The rect may reach past the frame (padding beyond the image edge exports
  // as transparent canvas margin): negative insets push the border off-stage,
  // so the dim overlay covers only pixels that are actually cropped away.
  const inset = `${(rect.y / srcH) * 100}% ${((srcW - rect.x - rect.w) / srcW) * 100}% ${((srcH - rect.y - rect.h) / srcH) * 100}% ${(rect.x / srcW) * 100}%`;
  guide.style.setProperty("--crop-inset", inset);
  guide.dataset.inset = inset;
  guide.classList.add("visible");
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
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let x = -radius; x <= radius; x++) {
        const i = (row + Math.min(w - 1, Math.max(0, x))) * 4;
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        a += data[i + 3];
      }
      for (let x = 0; x < w; x++) {
        const o = (row + x) * 4;
        tmp[o] = r / win;
        tmp[o + 1] = g / win;
        tmp[o + 2] = b / win;
        tmp[o + 3] = a / win;
        const iA = (row + Math.min(w - 1, x + radius + 1)) * 4;
        const iS = (row + Math.max(0, x - radius)) * 4;
        r += data[iA] - data[iS];
        g += data[iA + 1] - data[iS + 1];
        b += data[iA + 2] - data[iS + 2];
        a += data[iA + 3] - data[iS + 3];
      }
    }
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let y = -radius; y <= radius; y++) {
        const i = (Math.min(h - 1, Math.max(0, y)) * w + x) * 4;
        r += tmp[i];
        g += tmp[i + 1];
        b += tmp[i + 2];
        a += tmp[i + 3];
      }
      for (let y = 0; y < h; y++) {
        const o = (y * w + x) * 4;
        data[o] = r / win;
        data[o + 1] = g / win;
        data[o + 2] = b / win;
        data[o + 3] = a / win;
        const iA = (Math.min(h - 1, y + radius + 1) * w + x) * 4;
        const iS = (Math.max(0, y - radius) * w + x) * 4;
        r += tmp[iA] - tmp[iS];
        g += tmp[iA + 1] - tmp[iS + 1];
        b += tmp[iA + 2] - tmp[iS + 2];
        a += tmp[iA + 3] - tmp[iS + 3];
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
async function renderExportBlob(source, srcW, srcH, opts) {
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

/**
 * Resolves the image used to fill the canvas under "blur"/"image" backdrops:
 * the original stage photo for "blur", the chosen photo for "image".
 */
function resolveBackdropSource() {
  if (state.activeBackdrop === "blur") {
    return dom.beforeImg?.naturalWidth ? dom.beforeImg : null;
  }
  if (state.activeBackdrop === "image") {
    return state.backdropImg?.naturalWidth ? state.backdropImg : null;
  }
  return null;
}

/** Builds the final export blob for the active image using live export settings. */
async function buildExportBlob(format) {
  const srcW = state.naturalWidth || masterCutoutImg.naturalWidth;
  const srcH = state.naturalHeight || masterCutoutImg.naturalHeight;
  const baseDims = getExportBaseDims();
  const targetW = Math.max(1, state.exportWidth || baseDims.w || srcW);
  const targetH = Math.max(1, state.exportHeight || baseDims.h || srcH);

  if (
    !state.autoCrop &&
    format === "png" &&
    targetW === srcW &&
    targetH === srcH &&
    state.activeBackdrop === "checker" &&
    state.shadowCutoff === 0 &&
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
      !autoCrop &&
      snap.format === "png" &&
      snap.backdrop === "checker" &&
      snap.shadowCutoff === 0 &&
      targetW === srcW &&
      targetH === srcH
    ) {
      return blob;
    }

    let backdropSource = null;
    if (snap.backdrop === "blur" && originalFile) {
      bgBmp = await createImageBitmap(originalFile);
      backdropSource = bgBmp;
    } else if (snap.backdrop === "image") {
      backdropSource = snap.backdropImg || null;
    }

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

function exportSignature() {
  return signatureFor({
    format: state.exportFormat,
    w: state.exportWidth,
    h: state.exportHeight,
    cutoff: state.shadowCutoff,
    backdrop: state.activeBackdrop,
    autoCrop: state.autoCrop,
    cropPadding: state.autoCrop ? state.cropPadding : 0,
  });
}

/** True when the cached export blob is byte-exact for the current settings. */
function exportCacheMatches() {
  return (
    state.exportCacheBlob &&
    state.exportCacheSignature === exportSignature() &&
    state.exportCacheSource === state.resultBlob
  );
}

/**
 * Returns a blob that is byte-exact what an export would produce: the
 * background export cache when fresh, else the live preview blob when it was
 * rendered under the current export settings (raw passthrough included).
 */
function exactExportBlob() {
  if (exportCacheMatches()) return state.exportCacheBlob;
  if (
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
  if (exportCacheBusy) return;
  exportCacheBusy = true;
  try {
    while (!exportCacheMatches()) {
      const source = state.resultBlob;
      if (
        !source ||
        !masterCutoutImg.complete ||
        !masterCutoutImg.naturalWidth
      ) {
        return;
      }
      const srcW = state.naturalWidth || masterCutoutImg.naturalWidth;
      const srcH = state.naturalHeight || masterCutoutImg.naturalHeight;
      const baseDims = getExportBaseDims();
      const targetW = Math.max(1, state.exportWidth || baseDims.w || srcW);
      const targetH = Math.max(1, state.exportHeight || baseDims.h || srcH);
      // Snapshot the signature alongside the render options so the stored
      // signature describes the settings this blob was encoded under, even
      // if they change while the encode is in flight.
      const renderedSig = exportSignature();
      const blob = await renderExportBlob(masterCutoutImg, srcW, srcH, {
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
      if (source !== state.resultBlob) continue; // cutout swapped; re-evaluate
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

// Longest-side cap for the live stage preview in pixels. Full-res canvas
// work is only needed for the actual export; the stage just needs enough
// pixels to stay crisp at display size with some zoom headroom.
const PREVIEW_MAX_SIDE = 2048;
const PREVIEW_DEBOUNCE_MS = 150;
const PREVIEW_THROTTLE_MS = 400;

let previewTimer = null;
let previewLastStart = 0;

/** Export dims clamped to the preview cap, never upscaled past the target. */
function previewTargetSize() {
  const srcW = state.naturalWidth || masterCutoutImg.naturalWidth;
  const srcH = state.naturalHeight || masterCutoutImg.naturalHeight;
  const uncroppedStage = state.autoCrop && !exportAspectMismatch();
  const targetW = Math.max(1, uncroppedStage ? srcW : state.exportWidth || srcW);
  const targetH = Math.max(1, uncroppedStage ? srcH : state.exportHeight || srcH);
  const k = Math.min(1, PREVIEW_MAX_SIDE / Math.max(targetW, targetH));
  return {
    w: Math.max(1, Math.round(targetW * k)),
    h: Math.max(1, Math.round(targetH * k)),
  };
}

/** True when the export box's aspect differs meaningfully from the base frame. */
function exportAspectMismatch() {
  const baseDims = getExportBaseDims();
  const w = state.exportWidth;
  const h = state.exportHeight;
  if (!baseDims.w || !w || !h) return false;
  const mismatch = Math.abs(w * baseDims.h - h * baseDims.w);
  return mismatch > Math.max(w * baseDims.h, h * baseDims.w) * 0.02;
}

/** True when export settings change pixels or framing (cutoff, matte, mask, custom aspect); else the raw cutout is shown. */
function previewNeedsRender() {
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
    let renderedSig;
    if (!previewNeedsRender()) {
      blob = source;
      renderedSig = signatureFor({
        format: "png",
        w: state.naturalWidth || masterCutoutImg.naturalWidth,
        h: state.naturalHeight || masterCutoutImg.naturalHeight,
        cutoff: 0,
        backdrop: "checker",
        autoCrop: false,
        cropPadding: 0,
      });
    } else {
      const srcW = state.naturalWidth || masterCutoutImg.naturalWidth;
      const srcH = state.naturalHeight || masterCutoutImg.naturalHeight;
      const { w, h } = previewTargetSize();
      const applyCrop = state.autoCrop && exportAspectMismatch();
      blob = await renderExportBlob(masterCutoutImg, srcW, srcH, {
        format: state.exportFormat,
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
      renderedSig = signatureFor({
        format: state.exportFormat,
        w,
        h,
        cutoff: state.shadowCutoff,
        backdrop: state.activeBackdrop,
        autoCrop: applyCrop,
        cropPadding: applyCrop ? state.cropPadding : 0,
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
    if (dom.exportSizeLabel) {
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

/** Marks the active export-format segment button. */
export function syncFormatButtons() {
  document.querySelectorAll("#formatRow .fmt-btn").forEach((b) => {
    b.classList.toggle(
      "active",
      b.getAttribute("data-format") === state.exportFormat
    );
  });
}

/** Refreshes the export-destination label and folder button state. */
export function updateDestUI() {
  const hasNativePicker = Boolean(window.pywebview?.api?.choose_output_dir);
  if (dom.btnFileDest) {
    dom.btnFileDest.style.display = hasNativePicker ? "" : "none";
    dom.btnFileDest.textContent = state.outputDir
      ? "CHANGE FOLDER…"
      : "CHOOSE FOLDER…";
  }
  if (dom.fileDestPath) {
    let text;
    if (!hasNativePicker) {
      text = "Exports save via a file dialog or browser download.";
    } else if (state.outputDir) {
      text = state.outputDir;
    } else {
      text = "Exports ask where to save.";
    }
    dom.fileDestPath.textContent = text;
    dom.fileDestPath.title = state.outputDir || "";
    // RTL gives start-ellipsis for long paths but misplaces punctuation on
    // plain LTR sentences, so it is only applied to real paths.
    dom.fileDestPath.classList.toggle("rtl", Boolean(state.outputDir));
  }
}

/** Prompts for a per-tab export directory via the native bridge. */
export async function chooseOutputFolder(onBatchUpdate) {
  if (!window.pywebview?.api?.choose_output_dir) return;
  try {
    const res = await window.pywebview.api.choose_output_dir();
    if (res?.path) {
      state.outputDir = res.path;
      const tab = getActiveTab();
      if (tab) {
        tab.outputDir = res.path;
        if (tab.kind === "batch" && onBatchUpdate) onBatchUpdate(tab);
      }
      updateDestUI();
    } else if (res?.error) {
      setError(res.error);
    }
  } catch (err) {
    console.warn("[OpenBGR] Output directory picker failed:", err);
  }
}

/** Updates the dims/size/format readouts in the export panel. */
export function updateExportTelemetry() {
  const activeTab = getActiveTab();
  const fmtUpper = FORMAT_LABELS[state.exportFormat] || state.exportFormat.toUpperCase();
  dom.btnDownload.textContent =
    activeTab?.kind === "batch"
      ? state.batch.running && state.batch.tabId === activeTab.id
        ? "BATCH RUNNING…"
        : "RUN BATCH"
      : `EXPORT ${fmtUpper}`;
  syncFormatButtons();

  const pct = Math.round(state.exportScale * 100);
  dom.scalePctLabel.textContent = `${pct}%`;

  if (dom.exportSizeLabel) {
    if (!state.resultBlob) {
      dom.exportSizeLabel.textContent = "--";
    } else {
      const exact = exactExportBlob();
      dom.exportSizeLabel.textContent = exact
        ? formatDiskBytes(exact.size)
        : "...";
    }
  }

  const clampedSlider = Math.max(10, Math.min(200, pct));
  dom.exportScaleSlider.value = String(clampedSlider);

  document.querySelectorAll(".quick-scale-btn").forEach((btn) => {
    const btnScale = parseFloat(btn.getAttribute("data-scale") || "0");
    btn.classList.toggle("active", Math.abs(btnScale - state.exportScale) < 0.005);
  });

  if (state.naturalWidth > 0 && state.naturalHeight > 0) {
    const baseDims = getExportBaseDims();
    if (!state.exportWidth) {
      state.exportWidth = Math.max(
        1,
        Math.round(baseDims.w * state.exportScale)
      );
    }
    if (!state.exportHeight) {
      state.exportHeight = Math.max(
        1,
        Math.round(baseDims.h * state.exportScale)
      );
    }
    if (document.activeElement !== dom.exportWidthInput) {
      dom.exportWidthInput.value = String(state.exportWidth);
    }
    if (document.activeElement !== dom.exportHeightInput) {
      dom.exportHeightInput.value = String(state.exportHeight);
    }

    dom.statDim.textContent =
      pct === 100
        ? `${state.exportWidth}x${state.exportHeight} PX`
        : `${state.exportWidth}x${state.exportHeight} PX (${pct}%)`;

    dom.lblRight.textContent = `${fmtUpper} - ${state.exportWidth}x${state.exportHeight} (${pct}%)`;
    updateCropGuide();
    updateLiveStagePreview();
  } else {
    updateCropGuide();
    if (document.activeElement !== dom.exportWidthInput) {
      dom.exportWidthInput.value =
        state.exportWidth > 0 ? String(state.exportWidth) : "";
    }
    if (document.activeElement !== dom.exportHeightInput) {
      dom.exportHeightInput.value =
        state.exportHeight > 0 ? String(state.exportHeight) : "";
    }
  }

  syncPresetChips();
  syncFitChips();
}

/**
 * Highlights the preset chip matching the current export dims. ORIGINAL
 * lights whenever the output keeps the source aspect ratio (or no image is
 * loaded) and no exact preset chip matches.
 */
function syncPresetChips() {
  let presetHit = false;
  document.querySelectorAll(".preset-chip[data-w]").forEach((chip) => {
    const w = parseInt(chip.getAttribute("data-w"), 10);
    const h = parseInt(chip.getAttribute("data-h"), 10);
    const hit = w === state.exportWidth && h === state.exportHeight;
    if (hit) presetHit = true;
    chip.classList.toggle("active", hit);
  });
  const baseDims = getExportBaseDims();
  const isNativeAspect =
    !baseDims.w ||
    Math.abs(
      state.exportWidth * baseDims.h - state.exportHeight * baseDims.w
    ) <= Math.max(state.exportWidth, state.exportHeight);
  dom.presetReset?.classList.toggle("active", !presetHit && isNativeAspect);
}

/** Marks the canvas-fit chip matching `state.canvasFit`. */
function syncFitChips() {
  document.querySelectorAll(".fit-chip[data-fit]").forEach((chip) => {
    chip.classList.toggle(
      "active",
      chip.getAttribute("data-fit") === state.canvasFit
    );
  });
  // At native aspect FIT and STRETCH produce identical output; greying the
  // row prevents a meaningless toggle and teaches when the control matters.
  dom.canvasFitChips?.classList.toggle("disabled", !exportAspectMismatch());
}

/** Switches how the subject fills a mismatched export canvas: fit or stretch. */
export function setCanvasFit(mode) {
  state.canvasFit = mode === "stretch" ? "stretch" : "fit";
  updateExportTelemetry();
}

/** Maps a backdrop value ("checker", a hex color, "blur", "image") to its mode. */
function backdropModeOf(value) {
  return value === "checker" || value === "blur" || value === "image"
    ? value
    : "color";
}

/** Applies an export backdrop choice and syncs the mode-driven controls. */
export function applyBackdrop(value) {
  state.activeBackdrop = value;
  const mode = backdropModeOf(value);
  if (mode === "color") state.backdropColor = value;

  document.querySelectorAll(".mode-chip[data-mode]").forEach((chip) => {
    chip.classList.toggle("active", chip.getAttribute("data-mode") === mode);
  });
  document.querySelectorAll("#matteSwatches .swatch[data-bg]").forEach((s) => {
    s.classList.toggle("active", s.getAttribute("data-bg") === value);
  });
  dom.colorPicker?.classList.toggle(
    "active",
    value === dom.colorPicker.value
  );
  if (dom.matteSwatches) {
    dom.matteSwatches.style.display = mode === "color" ? "" : "none";
  }
  if (dom.backdropPhotoWrap) {
    dom.backdropPhotoWrap.style.display = mode === "image" ? "" : "none";
  }
  if (dom.backdropPhotoThumb) {
    const url = state.backdropImgUrl || "";
    dom.backdropPhotoThumb.classList.toggle("has-image", Boolean(url));
    dom.backdropPhotoThumb.style.backgroundImage = url ? `url("${url}")` : "";
  }
  if (dom.btnBackdropPhotoRemove) {
    dom.btnBackdropPhotoRemove.style.display = state.backdropImg ? "" : "none";
  }
  if (dom.backdropBlurWrap) {
    const isImgBackdrop = mode === "blur" || mode === "image";
    dom.backdropBlurWrap.style.display = isImgBackdrop ? "" : "none";
  }
  if (mode === "color") {
    dom.viewport.classList.remove("checkerboard-canvas");
    dom.viewport.style.background = value;
  } else {
    dom.viewport.style.background = "";
    dom.viewport.classList.toggle("checkerboard-canvas", mode === "checker");
  }
  updateLiveStagePreview();
}

/** Activates a backdrop mode chip; COLOR restores the last picked color. */
export function applyBackdropMode(mode) {
  applyBackdrop(mode === "color" ? state.backdropColor || "#ffffff" : mode);
}

/** Applies a preset export scale and re-renders the live preview. */
export function applyScaleValue(newScale) {
  state.exportScale = newScale;
  if (state.naturalWidth > 0 && state.naturalHeight > 0) {
    const baseDims = getExportBaseDims();
    state.exportWidth = Math.max(
      1,
      Math.round(baseDims.w * state.exportScale)
    );
    state.exportHeight = Math.max(
      1,
      Math.round(baseDims.h * state.exportScale)
    );
  }
  updateExportTelemetry();
}

/**
 * Applies a fixed export canvas size from a preset chip. Presets define an
 * exact output box (subject centered inside), so aspect lock is released:
 * locking would silently override the preset's second dimension.
 */
export function applyExportSizePreset(w, h) {
  state.exportWidth = Math.max(1, Math.round(w) || 0);
  state.exportHeight = Math.max(1, Math.round(h) || 0);
  if (!state.exportWidth || !state.exportHeight) return;
  state.aspectLocked = false;
  dom.aspectLockBtn?.classList.remove("active");
  dom.aspectLockBtn?.setAttribute("aria-pressed", "false");
  dom.exportWidthInput.value = String(state.exportWidth);
  dom.exportHeightInput.value = String(state.exportHeight);
  updateExportTelemetry();
}

/** Clears a preset/custom box back to the scaled source aspect ratio. */
export function resetExportSize() {
  state.aspectLocked = true;
  dom.aspectLockBtn?.classList.add("active");
  dom.aspectLockBtn?.setAttribute("aria-pressed", "true");
  if (state.naturalWidth > 0 && state.naturalHeight > 0) {
    applyScaleValue(state.exportScale || 1);
    return;
  }
  state.exportWidth = 0;
  state.exportHeight = 0;
  updateExportTelemetry();
}

/** POSTs one exported blob to `/api/save` inside `dir`; returns the raw Response. */
async function postSaveFile(dir, filename, blob) {
  const fd = new FormData();
  fd.append("directory", dir);
  fd.append("filename", filename);
  fd.append("file", blob, filename);
  return apiFetch("/api/save", { method: "POST", body: fd });
}

/**
 * Writes one exported batch file to the batch's output directory.
 * Returns `{ ok, detail? }` so callers can surface the server's failure reason.
 */
export async function saveBatchFile(dir, filename, blob) {
  try {
    const res = await postSaveFile(dir, filename, blob);
    if (res.ok) return { ok: true };
    return { ok: false, detail: await apiErrorDetail(res) };
  } catch (err) {
    return { ok: false, detail: err?.message || "Save request failed." };
  }
}

/** Exports the active cutout to its output folder or a Save-As dialog. */
export async function exportActiveImage() {
  if (!state.resultBlob) return;
  try {
    // Reuse the byte-exact cached encode or live preview when either was
    // rendered under the current export settings and from the current cutout;
    // otherwise re-encode so the saved file always matches its options.
    const exportBlob =
      exactExportBlob() || (await buildExportBlob(state.exportFormat));
    const suffix = state.exportFormat === "mask" ? "mask" : "cutout";
    const baseDims = getExportBaseDims();
    const isNativeSize =
      state.exportWidth === baseDims.w &&
      state.exportHeight === baseDims.h;
    const sizeTag = isNativeSize
      ? ""
      : `-${state.exportWidth}x${state.exportHeight}`;
    const baseName = (state.sourceFile?.name || "image").replace(/\.[^/.]+$/, "");
    const ext = FORMAT_EXT[state.exportFormat] || "png";
    const fileName = `${baseName}-${suffix}${sizeTag}.${ext}`;

    if (state.outputDir && window.pywebview?.api?.choose_output_dir) {
      const res = await postSaveFile(state.outputDir, fileName, exportBlob);
      if (!res.ok) {
        throw new Error(await apiErrorDetail(res));
      }
      const payload = await res.json().catch(() => ({}));
      setSuccess(`SAVED: ${payload.name || fileName} IN ${state.outputDir}`);
      return;
    }

    if (window.pywebview?.api?.save_file) {
      const b64 = await blobToBase64(exportBlob);
      const res = await window.pywebview.api.save_file(b64, fileName);
      if (res?.error) throw new Error(res.error);
      if (res?.saved && res.path) {
        const parts = res.path.replace(/\\/g, "/").split("/");
        const savedName = parts.pop();
        const savedDir = parts.join("/") || ".";
        setSuccess(`SAVED: ${savedName} IN ${savedDir}`);
      }
      return;
    }

    // In Chromium-based contexts (WebView2, Chrome) offer a real Save-As
    // dialog instead of a silent download when no output folder is set.
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: fileName,
        });
        const writable = await handle.createWritable();
        await writable.write(exportBlob);
        await writable.close();
        setSuccess(`SAVED: ${handle.name}`);
        return;
      } catch (pickerErr) {
        if (pickerErr?.name === "AbortError") return;
      }
    }

    downloadBlob(exportBlob, fileName);
    setSuccess(`DOWNLOADED: ${fileName}`);
  } catch (err) {
    setError(err.message || "Failed to export image.");
  }
}

/** Copies the processed cutout PNG to the system clipboard. */
export async function copyActiveCutout() {
  if (!state.resultBlob) return;
  const markCopied = () => {
    const originalLabel = dom.btnCopy.textContent;
    dom.btnCopy.textContent = "COPIED";
    setTimeout(() => {
      dom.btnCopy.textContent = originalLabel;
    }, 1400);
  };

  try {
    const copyFormat = state.exportFormat === "mask" ? "mask" : "png";
    const cached = copyFormat === state.exportFormat ? exactExportBlob() : null;
    const pngBlob = cached || (await buildExportBlob(copyFormat));

    if (window.pywebview?.api?.copy_image) {
      const b64 = await blobToBase64(pngBlob);
      const res = await window.pywebview.api.copy_image(b64);
      if (res?.copied) {
        markCopied();
        return;
      }
    }

    await navigator.clipboard.write([
      new ClipboardItem({ "image/png": pngBlob }),
    ]);
    markCopied();
  } catch (_) {
    setError("Clipboard PNG write is not supported in this browser context.");
  }
}

const ZIP_CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** Computes a CRC-32 checksum for ZIP central-directory entries. */
function crc32(u8) {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) {
    c = ZIP_CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

const ZIP_ENCODER = new TextEncoder();
// STORED-ZIP header fields are uint32 offsets and a uint16 entry count;
// silently truncating past them yields a corrupt archive.
const ZIP_U32_MAX = 0xffffffff;
const ZIP_U16_MAX = 0xffff;
const ZIP_TOO_LARGE_MSG =
  "Batch exceeds the 4 GiB ZIP limit; save to an output folder instead.";

/** Builds the 30-byte local header plus UTF-8 name bytes for one STORED entry. */
function zipLocalPieces(name, data) {
  const nameBytes = ZIP_ENCODER.encode(name);
  // Bit 11 marks the entry name as UTF-8; without it, extractors assume
  // CP437 and non-ASCII filenames come out as mojibake.
  const utf8Flag = nameBytes.length !== name.length ? 0x0800 : 0;
  const crc = crc32(data);
  const local = new DataView(new ArrayBuffer(30));
  local.setUint32(0, 0x04034b50, true);
  local.setUint16(4, 20, true);
  local.setUint16(6, utf8Flag, true);
  local.setUint16(8, 0, true);
  local.setUint16(10, 0, true);
  local.setUint16(12, 0, true);
  local.setUint32(14, crc, true);
  local.setUint32(18, data.length, true);
  local.setUint32(22, data.length, true);
  local.setUint16(26, nameBytes.length, true);
  local.setUint16(28, 0, true);
  return { local: local.buffer, nameBytes, crc, size: data.length, utf8Flag };
}

/** Builds the 46-byte central-directory record for a written entry. */
function zipCentralRecord(e) {
  const cd = new DataView(new ArrayBuffer(46));
  cd.setUint32(0, 0x02014b50, true);
  cd.setUint16(4, 20, true);
  cd.setUint16(6, 20, true);
  cd.setUint16(8, e.utf8Flag, true);
  cd.setUint16(10, 0, true);
  cd.setUint16(12, 0, true);
  cd.setUint16(14, 0, true);
  cd.setUint32(16, e.crc, true);
  cd.setUint32(20, e.size, true);
  cd.setUint32(24, e.size, true);
  cd.setUint16(28, e.nameBytes.length, true);
  cd.setUint32(42, e.offset, true);
  return cd.buffer;
}

/** Builds the 22-byte end-of-central-directory record. */
function zipEocd(count, cdSize, cdStart) {
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, count, true);
  eocd.setUint16(10, count, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, cdStart, true);
  return eocd.buffer;
}

/**
 * Builds an uncompressed (STORED) ZIP archive in memory. Image payloads are
 * already compressed, so store-only avoids extra CPU passes with no size cost.
 */
export function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of entries) {
    if (offset > ZIP_U32_MAX || data.length > ZIP_U32_MAX) {
      throw new Error(ZIP_TOO_LARGE_MSG);
    }
    const p = zipLocalPieces(name, data);
    chunks.push(p.local, p.nameBytes, data);
    central.push({
      nameBytes: p.nameBytes,
      crc: p.crc,
      size: p.size,
      offset,
      utf8Flag: p.utf8Flag,
    });
    offset += 30 + p.nameBytes.length + p.size;
  }

  const cdStart = offset;
  for (const e of central) {
    chunks.push(zipCentralRecord(e), e.nameBytes);
    offset += 46 + e.nameBytes.length;
  }
  if (
    central.length > ZIP_U16_MAX ||
    offset - cdStart > ZIP_U32_MAX ||
    cdStart > ZIP_U32_MAX
  ) {
    throw new Error(ZIP_TOO_LARGE_MSG);
  }

  chunks.push(zipEocd(central.length, offset - cdStart, cdStart));
  return new Blob(chunks, { type: "application/zip" });
}

/**
 * Incremental STORED-zip writer for a FileSystemWritableFileStream. Each
 * entry is flushed to disk as it is produced, so a large batch holds at most
 * one output file's bytes in memory at a time.
 */
export function createZipWriter(writable) {
  const central = [];
  const names = new Set();
  let offset = 0;
  return {
    names,
    async add(name, data) {
      if (offset > ZIP_U32_MAX || data.length > ZIP_U32_MAX) {
        throw new Error(ZIP_TOO_LARGE_MSG);
      }
      const p = zipLocalPieces(name, data);
      await writable.write(p.local);
      await writable.write(p.nameBytes);
      await writable.write(data);
      central.push({
        nameBytes: p.nameBytes,
        crc: p.crc,
        size: p.size,
        offset,
        utf8Flag: p.utf8Flag,
      });
      offset += 30 + p.nameBytes.length + p.size;
    },
    async close() {
      const cdStart = offset;
      let cdSize = 0;
      for (const e of central) cdSize += 46 + e.nameBytes.length;
      if (
        central.length > ZIP_U16_MAX ||
        cdSize > ZIP_U32_MAX ||
        cdStart > ZIP_U32_MAX
      ) {
        try {
          await writable.abort();
        } catch (_) {}
        throw new Error(ZIP_TOO_LARGE_MSG);
      }
      for (const e of central) {
        await writable.write(zipCentralRecord(e));
        await writable.write(e.nameBytes);
      }
      await writable.write(zipEocd(central.length, cdSize, cdStart));
      await writable.close();
    },
    async abort() {
      try {
        await writable.abort();
      } catch (_) {}
    },
  };
}

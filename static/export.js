/**
 * Export pipeline: offscreen canvas rendering (PNG, WebP, JPG, 8-bit Mask),
 * alpha shadow/reflection thresholding, matte backdrop compositing, live
 * stage preview, destination folder selection, and store-only ZIP packaging.
 */

import {
  state,
  dom,
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

/**
 * Draws `source` at `targetW` x `targetH`, applies the `shadowCutoff` alpha
 * threshold, composites onto `backdrop` when opaque output is needed, and
 * encodes to `format` ("png" | "webp" | "jpg" | "mask").
 */
async function renderExportBlob(source, srcW, srcH, opts) {
  const { format, targetW, targetH, shadowCutoff, backdrop } = opts;

  const canvas = document.createElement("canvas");
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  const cutoffByte = Math.round((shadowCutoff / 100) * 255);
  const needsMatte = format === "jpg" || backdrop !== "checker";
  const matteColor = backdrop === "checker" ? "#ffffff" : backdrop;

  if (format === "mask") {
    ctx.drawImage(source, 0, 0, targetW, targetH);
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
    const fgCtx = fgCanvas.getContext("2d");
    fgCtx.imageSmoothingEnabled = true;
    fgCtx.imageSmoothingQuality = "high";
    fgCtx.drawImage(source, 0, 0, targetW, targetH);

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

    if (needsMatte) {
      ctx.fillStyle = matteColor;
      ctx.fillRect(0, 0, targetW, targetH);
    }
    ctx.drawImage(fgCanvas, 0, 0);
    fgCanvas.width = 0;
    fgCanvas.height = 0;
  } else {
    if (needsMatte) {
      ctx.fillStyle = matteColor;
      ctx.fillRect(0, 0, targetW, targetH);
    }
    ctx.drawImage(source, 0, 0, targetW, targetH);
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
async function buildExportBlob(format) {
  const srcW = state.naturalWidth || masterCutoutImg.naturalWidth;
  const srcH = state.naturalHeight || masterCutoutImg.naturalHeight;
  const targetW = Math.max(1, state.exportWidth || srcW);
  const targetH = Math.max(1, state.exportHeight || srcH);

  if (
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
  });
}

/** Builds the export blob for one batch item using the batch's settings snapshot. */
export async function buildBatchExportBlob(blob, snap) {
  const bmp = await createImageBitmap(blob);
  try {
    const srcW = bmp.width;
    const srcH = bmp.height;
    let targetW = Math.max(1, Math.round(srcW * (snap.scale || 1)));
    let targetH = Math.max(1, Math.round(srcH * (snap.scale || 1)));

    // Custom dimensions act as an aspect-preserving bounding box per image.
    if (snap.exportWidth > 0 || snap.exportHeight > 0) {
      const fit = Math.min(
        (snap.exportWidth || Infinity) / srcW,
        (snap.exportHeight || Infinity) / srcH
      );
      targetW = Math.max(1, Math.round(srcW * fit));
      targetH = Math.max(1, Math.round(srcH * fit));
    }

    if (
      snap.format === "png" &&
      snap.backdrop === "checker" &&
      snap.shadowCutoff === 0 &&
      targetW === srcW &&
      targetH === srcH
    ) {
      return blob;
    }

    return await renderExportBlob(bmp, srcW, srcH, {
      format: snap.format,
      targetW,
      targetH,
      shadowCutoff: snap.shadowCutoff,
      backdrop: snap.backdrop,
    });
  } finally {
    bmp.close();
  }
}

/**
 * Settings signature identifying which export options a preview blob was
 * rendered under; used to detect stale `state.previewBlob` contents.
 */
function exportSignature() {
  return JSON.stringify({
    format: state.exportFormat,
    w: state.exportWidth,
    h: state.exportHeight,
    cutoff: state.shadowCutoff,
    backdrop: state.activeBackdrop,
  });
}

/** Re-renders the processed preview on canvas after backdrop/scale changes. */
export async function updateLiveStagePreview() {
  if (
    !state.resultBlob ||
    !masterCutoutImg.complete ||
    !masterCutoutImg.naturalWidth
  ) {
    return;
  }

  const token = ++state.previewRenderToken;
  const signature = exportSignature();
  const source = state.resultBlob;
  try {
    const blob = await buildExportBlob(state.exportFormat);
    if (token !== state.previewRenderToken) return;

    state.previewBlob = blob;
    state.previewSignature = signature;
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
    // previewBlob is encoded through the exact export path, so its byte size
    // is the real output file size, not an estimate.
    if (dom.exportSizeLabel) {
      dom.exportSizeLabel.textContent = formatDiskBytes(blob.size);
    }
    saveStateToActiveTab();
  } catch (_) {}
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
  } catch (_) {}
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
    } else if (
      state.previewBlob &&
      state.previewSignature === exportSignature() &&
      state.previewSource === state.resultBlob
    ) {
      dom.exportSizeLabel.textContent = formatDiskBytes(state.previewBlob.size);
    } else {
      dom.exportSizeLabel.textContent = "...";
    }
  }

  const clampedSlider = Math.max(10, Math.min(200, pct));
  dom.exportScaleSlider.value = String(clampedSlider);

  document.querySelectorAll(".quick-scale-btn").forEach((btn) => {
    const btnScale = parseFloat(btn.getAttribute("data-scale") || "0");
    btn.classList.toggle("active", Math.abs(btnScale - state.exportScale) < 0.005);
  });

  if (state.naturalWidth > 0 && state.naturalHeight > 0) {
    if (!state.exportWidth) {
      state.exportWidth = Math.max(
        1,
        Math.round(state.naturalWidth * state.exportScale)
      );
    }
    if (!state.exportHeight) {
      state.exportHeight = Math.max(
        1,
        Math.round(state.naturalHeight * state.exportScale)
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
    updateLiveStagePreview();
  } else {
    if (document.activeElement !== dom.exportWidthInput) {
      dom.exportWidthInput.value =
        state.exportWidth > 0 ? String(state.exportWidth) : "";
    }
    if (document.activeElement !== dom.exportHeightInput) {
      dom.exportHeightInput.value =
        state.exportHeight > 0 ? String(state.exportHeight) : "";
    }
  }
}

/** Applies an export backdrop choice (transparent/white/black/custom). */
export function applyBackdrop(value) {
  state.activeBackdrop = value;
  document.querySelectorAll("#matteSwatches .swatch").forEach((s) => {
    s.classList.toggle("active", s.getAttribute("data-bg") === value);
  });
  if (value === "checker") {
    dom.viewport.style.background = "";
    dom.viewport.classList.add("checkerboard-canvas");
  } else {
    dom.viewport.classList.remove("checkerboard-canvas");
    dom.viewport.style.background = value;
  }
  updateLiveStagePreview();
}

/** Applies a preset export scale and re-renders the live preview. */
export function applyScaleValue(newScale) {
  state.exportScale = newScale;
  if (state.naturalWidth > 0 && state.naturalHeight > 0) {
    state.exportWidth = Math.max(
      1,
      Math.round(state.naturalWidth * state.exportScale)
    );
    state.exportHeight = Math.max(
      1,
      Math.round(state.naturalHeight * state.exportScale)
    );
  }
  updateExportTelemetry();
}

/** POSTs one exported blob to `/api/save` inside `dir`; returns the raw Response. */
async function postSaveFile(dir, filename, blob) {
  const fd = new FormData();
  fd.append("directory", dir);
  fd.append("filename", filename);
  fd.append("file", blob, filename);
  return fetch("/api/save", { method: "POST", body: fd });
}

/** Writes one exported batch file to the batch's output directory (or downloads it). */
export async function saveBatchFile(dir, filename, blob) {
  try {
    const res = await postSaveFile(dir, filename, blob);
    return res.ok;
  } catch (_) {
    return false;
  }
}

/** Exports the active cutout to its output folder or a Save-As dialog. */
export async function exportActiveImage() {
  if (!state.resultBlob) return;
  try {
    // Reuse the live preview only when it was rendered under the exact current
    // export settings and from the current cutout; otherwise re-encode so the
    // downloaded file always matches its extension and options.
    const exportBlob =
      state.previewBlob &&
      state.previewSignature === exportSignature() &&
      state.previewSource === state.resultBlob
        ? state.previewBlob
        : await buildExportBlob(state.exportFormat);
    const suffix = state.exportFormat === "mask" ? "mask" : "cutout";
    const isNativeSize =
      state.exportWidth === state.naturalWidth &&
      state.exportHeight === state.naturalHeight;
    const sizeTag = isNativeSize
      ? ""
      : `-${state.exportWidth}x${state.exportHeight}`;
    const baseName = (state.sourceFile?.name || "image").replace(/\.[^/.]+$/, "");
    const ext = FORMAT_EXT[state.exportFormat] || "png";
    const fileName = `${baseName}-${suffix}${sizeTag}.${ext}`;

    if (state.outputDir && window.pywebview?.api?.choose_output_dir) {
      const res = await postSaveFile(state.outputDir, fileName, exportBlob);
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          payload?.detail || "Failed to write to the output folder."
        );
      }
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
    const pngBlob = await buildExportBlob(copyFormat);

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

/**
 * Builds an uncompressed (STORED) ZIP archive in memory. Image payloads are
 * already compressed, so store-only avoids extra CPU passes with no size cost.
 */
export function buildZip(entries) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBytes = enc.encode(name);
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
    chunks.push(local.buffer, nameBytes, data);
    central.push({ nameBytes, crc, size: data.length, offset, utf8Flag });
    offset += 30 + nameBytes.length + data.length;
  }

  const cdStart = offset;
  for (const e of central) {
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
    chunks.push(cd.buffer, e.nameBytes);
    offset += 46 + e.nameBytes.length;
  }

  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, central.length, true);
  eocd.setUint16(10, central.length, true);
  eocd.setUint32(12, offset - cdStart, true);
  eocd.setUint32(16, cdStart, true);
  chunks.push(eocd.buffer);
  return new Blob(chunks, { type: "application/zip" });
}

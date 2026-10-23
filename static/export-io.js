/**
 * Export actions: the destination folder picker, `/api/save` uploads, the
 * Save-As/download fallbacks for the active cutout, clipboard copy of the
 * result and the original, and the file-manager reveal (desktop mode).
 * Importing this module has no side effects.
 */

import {
  state,
  dom,
  apiFetch,
  apiErrorDetail,
  masterCutoutImg,
  getActiveTab,
  setError,
  blobToBase64,
  downloadBlob,
  setSuccess,
  FORMAT_EXT,
  formatDiskBytes,
} from "./state.js";
import {
  buildExportBlob,
  computeAlphaBBox,
  exactExportBlob,
  expandCropBox,
  getExportBaseDims,
  renderExportBlob,
} from "./export.js";
import { updateDestUI } from "./export-ui.js";
import { buildZip } from "./zip.js";

/**
 * Prompts for a per-tab export directory. Uses the pywebview bridge in the
 * desktop app and `/api/choose-folder` (server-side native dialog) elsewhere.
 */
export async function chooseOutputFolder(onBatchUpdate) {
  try {
    let path = null;
    if (window.pywebview?.api?.choose_output_dir) {
      const res = await window.pywebview.api.choose_output_dir();
      if (res?.error) {
        setError(res.error);
        return;
      }
      path = res?.path || null;
    } else {
      const res = await apiFetch("/api/choose-folder", { method: "POST" });
      if (!res.ok) {
        setError("Could not open the folder picker.");
        return;
      }
      const payload = await res.json().catch(() => ({}));
      path = payload?.path || null;
    }
    if (!path) return;
    state.outputDir = path;
    const tab = getActiveTab();
    if (tab) {
      tab.outputDir = path;
      if (tab.kind === "batch" && onBatchUpdate) onBatchUpdate(tab);
    }
    updateDestUI();
  } catch (err) {
    console.warn("[OpenBGR] Output directory picker failed:", err);
    setError("Could not open the folder picker.");
  }
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

/** Opens the OS file manager at a saved file or folder (desktop mode only). */
export function revealSavedPath(path) {
  if (!path || !window.pywebview?.api?.reveal_path) return;
  window.pywebview.api
    .reveal_path(path)
    .then((res) => {
      if (res && res.revealed === false) {
        setError("Could not reveal the saved file.");
      }
    })
    .catch(() => setError("Could not reveal the saved file."));
}

/**
 * Renders every frame in the trimmed `[startFrame, endFrame]` slice through
 * the export canvas (backdrop, shadow cutoff, auto-crop, custom dimensions)
 * and encodes the result as an animated GIF or WebP via `/api/encode-animation`.
 */
export async function buildAnimatedExportBlob(format = "gif", opts = {}) {
  const total = state.frames.length;
  const startIdx = Math.max(0, Math.min(total - 1, (state.startFrame || 1) - 1));
  const endIdx = Math.max(
    startIdx,
    Math.min(total - 1, (state.endFrame || total) - 1)
  );
  const slice = state.frames.slice(startIdx, endIdx + 1);
  const missing = slice.findIndex((frm) => !frm.resultBlob);
  if (missing >= 0) {
    throw new Error(
      `Frame ${startIdx + missing + 1} is not processed yet. Run PROCESS GIF first.`
    );
  }

  const srcW = state.naturalWidth || masterCutoutImg.naturalWidth;
  const srcH = state.naturalHeight || masterCutoutImg.naturalHeight;

  // Auto-Crop must use the union of every trimmed frame's alpha bbox: a box
  // from only the current frame clips subjects that move between frames.
  let unionBox = null;
  if (state.autoCrop) {
    for (const frm of slice) {
      const cutoutBlob = frm.resultBlob;
      if (!cutoutBlob) continue;
      const bmp = await createImageBitmap(cutoutBlob);
      try {
        const box = computeAlphaBBox(
          bmp,
          srcW,
          srcH,
          state.shadowCutoff,
          cutoutBlob
        );
        unionBox = unionBox
          ? {
              x: Math.min(unionBox.x, box.x),
              y: Math.min(unionBox.y, box.y),
              w:
                Math.max(unionBox.x + unionBox.w, box.x + box.w) -
                Math.min(unionBox.x, box.x),
              h:
                Math.max(unionBox.y + unionBox.h, box.y + box.h) -
                Math.min(unionBox.y, box.y),
            }
          : box;
      } finally {
        bmp.close?.();
      }
    }
  }
  const baseDims =
    state.autoCrop && unionBox
      ? expandCropBox(unionBox, state.cropPadding)
      : { w: srcW, h: srcH };
  const scale = state.exportScale || 1;
  const scaledW = Math.max(1, Math.round(baseDims.w * scale));
  const scaledH = Math.max(1, Math.round(baseDims.h * scale));
  const targetW =
    state.aspectLocked !== false
      ? scaledW
      : Math.max(1, state.exportWidth || scaledW);
  const targetH =
    state.aspectLocked !== false
      ? scaledH
      : Math.max(1, state.exportHeight || scaledH);
  const passthrough =
    !state.autoCrop &&
    targetW === srcW &&
    targetH === srcH &&
    state.activeBackdrop === "checker" &&
    state.shadowCutoff === 0;

  const showBusy = opts.showOverlay !== false && !state.isProcessing;
  if (showBusy) {
    dom.busySub.textContent = "";
    if (dom.btnCancel) dom.btnCancel.style.display = "none";
    dom.appShell?.classList.add("is-processing");
    dom.busyOverlay.classList.add("active");
  }
  const fd = new FormData();
  const durations = [];
  try {
    for (let i = 0; i < slice.length; i++) {
      if (showBusy) {
        dom.busyTitle.textContent = `ENCODING ANIMATION (${i + 1}/${slice.length})`;
      }
      const frm = slice[i];
      const cutoutBlob = frm.resultBlob;
      if (passthrough && cutoutBlob) {
        fd.append("files", cutoutBlob, `frame-${i + 1}.png`);
        durations.push(Number(frm.durationMs) || 100);
        continue;
      }
      const bmp = await createImageBitmap(cutoutBlob);
      let bgBmp = null;
      try {
        let backdropSource = null;
        if (state.activeBackdrop === "blur" && frm.sourceFile) {
          bgBmp = await createImageBitmap(frm.sourceFile);
          backdropSource = bgBmp;
        } else if (state.activeBackdrop === "image") {
          backdropSource = state.backdropImg?.naturalWidth
            ? state.backdropImg
            : null;
        }
        const renderedFrame = await renderExportBlob(bmp, srcW, srcH, {
          format: "png",
          targetW,
          targetH,
          shadowCutoff: state.shadowCutoff,
          backdrop: state.activeBackdrop,
          backdropSource,
          backdropBlur: state.backdropBlur,
          autoCrop: state.autoCrop,
          cropPadding: state.cropPadding,
          cropBox: unionBox,
          canvasFit: state.canvasFit,
        });
        fd.append("files", renderedFrame, `frame-${i + 1}.png`);
        durations.push(Number(frm.durationMs) || 100);
      } finally {
        bmp.close?.();
        bgBmp?.close?.();
      }
    }
    fd.append("durations", JSON.stringify(durations));
    fd.append("format", format === "webp" ? "webp" : "gif");

    const res = await apiFetch("/api/encode-animation", {
      method: "POST",
      body: fd,
    });
    if (!res.ok) {
      throw new Error(await apiErrorDetail(res));
    }
    if (typeof res.blob !== "function") return null;
    return await res.blob();
  } finally {
    if (showBusy) {
      if (dom.btnCancel) dom.btnCancel.style.display = "";
      dom.appShell?.classList.remove("is-processing");
      dom.busyOverlay.classList.remove("active");
    }
  }
}

/** Saves a single exported blob via outputDir, pywebview Save-As, File System Access, or browser download. */
async function saveSingleExportBlob(exportBlob, fileName) {
  if (state.outputDir) {
    const res = await postSaveFile(state.outputDir, fileName, exportBlob);
    if (!res.ok) {
      throw new Error(await apiErrorDetail(res));
    }
    const payload = await res.json().catch(() => ({}));
    const savedPath =
      payload.path || `${state.outputDir}/${payload.name || fileName}`;
    setSuccess(
      `SAVED: ${payload.name || fileName} IN ${state.outputDir}`,
      8000,
      { label: "OPEN", fn: () => revealSavedPath(savedPath) }
    );
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
      setSuccess(`SAVED: ${savedName} IN ${savedDir}`, 8000, {
        label: "OPEN",
        fn: () => revealSavedPath(res.path),
      });
    }
    return;
  }

  // Inside pywebview, never fall through to `<a href="blob:..." download>` (which
  // navigates WKWebView to the raw blob URL); use `/api/save-as` instead.
  if (window.pywebview) {
    const fd = new FormData();
    fd.append("filename", fileName);
    fd.append("file", exportBlob, fileName);
    const res = await apiFetch("/api/save-as", { method: "POST", body: fd });
    if (!res.ok) {
      throw new Error(await apiErrorDetail(res));
    }
    const payload = await res.json().catch(() => ({}));
    if (payload?.error) throw new Error(payload.error);
    if (payload?.saved && payload.path) {
      const parts = payload.path.replace(/\\/g, "/").split("/");
      const savedName = parts.pop();
      const savedDir = parts.join("/") || ".";
      setSuccess(`SAVED: ${savedName} IN ${savedDir}`, 8000, {
        label: "OPEN",
        fn: () => revealSavedPath(payload.path),
      });
    }
    return;
  }

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
}

/**
 * Renders every frame in the trimmed `[startFrame, endFrame]` slice as an
 * individual image file (`png`, `webp`, `jpg`, or `mask`), applying per-frame
 * auto-crop, resolution scale, custom dimensions, shadow cutoff, and backdrop.
 */
export async function exportAnimatedFramesIndividually() {
  const total = state.frames.length;
  const startIdx = Math.max(0, Math.min(total - 1, (state.startFrame || 1) - 1));
  const endIdx = Math.max(
    startIdx,
    Math.min(total - 1, (state.endFrame || total) - 1)
  );
  const slice = state.frames.slice(startIdx, endIdx + 1);
  const missing = slice.findIndex((frm) => !frm.resultBlob);
  if (missing >= 0) {
    throw new Error(
      `Frame ${startIdx + missing + 1} is not processed yet. Run PROCESS GIF first.`
    );
  }

  // When exporting multiple individual files without a chosen folder on desktop,
  // prompt for a destination directory so each frame lands directly on disk.
  if (
    slice.length > 1 &&
    !state.outputDir &&
    window.pywebview?.api?.choose_output_dir
  ) {
    const pick = await window.pywebview.api.choose_output_dir();
    if (pick?.error) throw new Error(pick.error);
    if (!pick?.path) return;
    state.outputDir = pick.path;
    const tab = getActiveTab();
    if (tab) tab.outputDir = pick.path;
    updateDestUI();
  }

  const srcW = state.naturalWidth || masterCutoutImg.naturalWidth;
  const srcH = state.naturalHeight || masterCutoutImg.naturalHeight;
  const fmt = state.exportFormat;
  const suffix = fmt === "mask" ? "mask" : "cutout";
  const ext = FORMAT_EXT[fmt] || "png";
  const baseName = (state.sourceFile?.name || "image").replace(/\.[^/.]+$/, "");
  const scale = state.exportScale || 1;

  const showBusy = !state.isProcessing && slice.length > 1;
  if (showBusy) {
    dom.busySub.textContent = "";
    if (dom.btnCancel) dom.btnCancel.style.display = "none";
    dom.appShell?.classList.add("is-processing");
    dom.busyOverlay.classList.add("active");
  }

  const renderedFiles = [];
  let totalBytes = 0;
  try {
    for (let i = 0; i < slice.length; i++) {
      const frameNum = startIdx + i + 1;
      if (showBusy) {
        dom.busyTitle.textContent = `EXPORTING FRAMES (${i + 1}/${slice.length})`;
      }
      const frm = slice[i];
      const cutoutBlob = frm.resultBlob;
      const bmp = await createImageBitmap(cutoutBlob);
      let bgBmp = null;
      try {
        const tightBox = state.autoCrop
          ? computeAlphaBBox(
              bmp,
              srcW,
              srcH,
              state.shadowCutoff,
              cutoutBlob
            )
          : null;
        const frameBase =
          state.autoCrop && tightBox
            ? expandCropBox(tightBox, state.cropPadding)
            : { w: srcW, h: srcH };
        const scaledW = Math.max(1, Math.round(frameBase.w * scale));
        const scaledH = Math.max(1, Math.round(frameBase.h * scale));
        const targetW =
          state.aspectLocked !== false
            ? scaledW
            : Math.max(1, state.exportWidth || scaledW);
        const targetH =
          state.aspectLocked !== false
            ? scaledH
            : Math.max(1, state.exportHeight || scaledH);

        const isPassthrough =
          !state.autoCrop &&
          fmt === "png" &&
          targetW === srcW &&
          targetH === srcH &&
          state.activeBackdrop === "checker" &&
          state.shadowCutoff === 0;

        let frameBlob;
        if (isPassthrough) {
          frameBlob = cutoutBlob;
        } else {
          let backdropSource = null;
          if (state.activeBackdrop === "blur" && frm.sourceFile) {
            bgBmp = await createImageBitmap(frm.sourceFile);
            backdropSource = bgBmp;
          } else if (state.activeBackdrop === "image") {
            backdropSource = state.backdropImg?.naturalWidth
              ? state.backdropImg
              : null;
          }
          frameBlob = await renderExportBlob(bmp, srcW, srcH, {
            format: fmt,
            targetW,
            targetH,
            shadowCutoff: state.shadowCutoff,
            backdrop: state.activeBackdrop,
            backdropSource,
            backdropBlur: state.backdropBlur,
            autoCrop: state.autoCrop,
            cropPadding: state.cropPadding,
            cropBox: tightBox,
            canvasFit: state.canvasFit,
          });
        }
        const isNativeSize =
          targetW === frameBase.w && targetH === frameBase.h;
        const sizeTag = isNativeSize ? "" : `-${targetW}x${targetH}`;
        const fileName = `${baseName}-frame-${frameNum}-${suffix}${sizeTag}.${ext}`;
        renderedFiles.push({ name: fileName, blob: frameBlob });
        totalBytes += frameBlob.size || 0;
      } finally {
        bmp.close?.();
        bgBmp?.close?.();
      }
    }
  } finally {
    if (showBusy) {
      if (dom.btnCancel) dom.btnCancel.style.display = "";
      dom.appShell?.classList.remove("is-processing");
      dom.busyOverlay.classList.remove("active");
    }
  }

  if (dom.exportSizeLabel && totalBytes > 0) {
    dom.exportSizeLabel.textContent = formatDiskBytes(totalBytes);
  }

  if (renderedFiles.length === 1) {
    await saveSingleExportBlob(renderedFiles[0].blob, renderedFiles[0].name);
    return;
  }

  if (state.outputDir) {
    let lastSavedPath = state.outputDir;
    for (const item of renderedFiles) {
      const res = await postSaveFile(state.outputDir, item.name, item.blob);
      if (!res.ok) {
        throw new Error(await apiErrorDetail(res));
      }
      const payload = await res.json().catch(() => ({}));
      if (payload.path) lastSavedPath = payload.path;
    }
    setSuccess(
      `SAVED: ${renderedFiles.length} FRAMES IN ${state.outputDir}`,
      8000,
      { label: "OPEN", fn: () => revealSavedPath(lastSavedPath) }
    );
    return;
  }

  const zipEntries = await Promise.all(
    renderedFiles.map(async (item) => ({
      name: item.name,
      data: new Uint8Array(await item.blob.arrayBuffer()),
    }))
  );
  const zipBlob = buildZip(zipEntries);
  const isTrimmed = state.startFrame > 1 || state.endFrame < total;
  const trimTag = isTrimmed ? `-f${state.startFrame}-${state.endFrame}` : "";
  const zipName = `${baseName}-${suffix}${trimTag}-frames.zip`;
  await saveSingleExportBlob(zipBlob, zipName);
}

/** Exports the active cutout to its output folder or a Save-As dialog. */
export async function exportActiveImage() {
  // Animated tabs may sit on an unprocessed frame outside the trim range;
  // the export builders report which frame still needs processing.
  if (
    !state.resultBlob &&
    !(state.isAnimated && state.frames.length > 1)
  ) {
    return;
  }
  try {
    const isMultiFrame = state.isAnimated && state.frames.length > 1;
    if (isMultiFrame && state.exportFormat !== "gif") {
      await exportAnimatedFramesIndividually();
      return;
    }
    const isAnimExport = isMultiFrame && state.exportFormat === "gif";
    // Reuse the byte-exact cached encode or live preview when either was
    // rendered under the current export settings and from the current cutout;
    // otherwise re-encode so the saved file always matches its options.
    const exportBlob =
      exactExportBlob() ||
      (isAnimExport
        ? await buildAnimatedExportBlob("gif", {
            showOverlay: true,
          })
        : await buildExportBlob(state.exportFormat));
    if (isAnimExport && exportBlob && dom.exportSizeLabel) {
      dom.exportSizeLabel.textContent =
        exportBlob.size > 0
          ? formatDiskBytes(exportBlob.size)
          : dom.exportSizeLabel.textContent;
    }
    const suffix = state.exportFormat === "mask" ? "mask" : "cutout";
    const baseDims = getExportBaseDims();
    const scale = state.exportScale || 1;
    const outW =
      state.exportWidth || Math.max(1, Math.round(baseDims.w * scale));
    const outH =
      state.exportHeight || Math.max(1, Math.round(baseDims.h * scale));
    const isNativeSize = outW === baseDims.w && outH === baseDims.h;
    const sizeTag = isNativeSize ? "" : `-${outW}x${outH}`;
    const isTrimmed =
      isAnimExport &&
      (state.startFrame > 1 || state.endFrame < state.frames.length);
    const trimTag = isTrimmed ? `-f${state.startFrame}-${state.endFrame}` : "";
    const baseName = (state.sourceFile?.name || "image").replace(/\.[^/.]+$/, "");
    const ext = FORMAT_EXT[state.exportFormat] || "png";
    const fileName = `${baseName}-${suffix}${trimTag}${sizeTag}.${ext}`;

    await saveSingleExportBlob(exportBlob, fileName);
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

/** Copies the unprocessed source image as PNG to the system clipboard. */
export async function copyOriginalImage() {
  if (!state.sourceFile) return;
  try {
    const bmp = await createImageBitmap(state.sourceFile);
    const canvas = document.createElement("canvas");
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    canvas.getContext("2d").drawImage(bmp, 0, 0);
    bmp.close?.();
    const pngBlob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/png")
    );
    if (!pngBlob) throw new Error("PNG encode failed");

    if (window.pywebview?.api?.copy_image) {
      const b64 = await blobToBase64(pngBlob);
      const res = await window.pywebview.api.copy_image(b64);
      if (res?.copied) {
        setSuccess("COPIED: ORIGINAL IMAGE");
        return;
      }
    }
    await navigator.clipboard.write([
      new ClipboardItem({ "image/png": pngBlob }),
    ]);
    setSuccess("COPIED: ORIGINAL IMAGE");
  } catch (_) {
    setError("Could not copy the original image.");
  }
}

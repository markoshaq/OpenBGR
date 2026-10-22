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
  getActiveTab,
  setError,
  blobToBase64,
  downloadBlob,
  setSuccess,
  FORMAT_EXT,
} from "./state.js";
import {
  buildExportBlob,
  exactExportBlob,
  getExportBaseDims,
} from "./export.js";
import { updateDestUI } from "./export-ui.js";

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
      const savedPath =
        payload.path || `${state.outputDir}/${payload.name || fileName}`;
      setSuccess(
        `SAVED: ${payload.name || fileName} IN ${state.outputDir}`,
        8000,
        { label: "REVEAL", fn: () => revealSavedPath(savedPath) }
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
          label: "REVEAL",
          fn: () => revealSavedPath(res.path),
        });
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

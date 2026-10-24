/**
 * Clipboard image ingest: keyboard paste, Edit > Paste Image, and the
 * clipboard probe that gates that menu item.
 * Importing this module has no side effects; app.js calls `initClipboard()`.
 */

import { state, setError, openConfirmModal, base64ToBlob } from "./state.js";
import { ingestImageFile, syncMenuBarState } from "./tabs.js";
import { cancelProcessing } from "./segmentation.js";
import { isTextField } from "./shortcuts.js";
import { on } from "./bus.js";

/** Ingests a file, prompting when it would replace an existing unprocessed image. */
export function ingestWithConfirm(fileOrBlob) {
  if (state.isProcessing) {
    openConfirmModal(
      {
        message:
          "This will stop the current image processing. Do you want to load the pasted image?",
      },
      () => {
        cancelProcessing();
        ingestImageFile(fileOrBlob);
      }
    );
  } else {
    ingestImageFile(fileOrBlob);
  }
}

/** Reads a clipboard image through the native bridge (desktop mode). */
export async function readNativeClipboardImage() {
  if (!window.pywebview?.api?.read_clipboard_image) return null;
  try {
    const res = await window.pywebview.api.read_clipboard_image();
    if (res?.has_image && res.data_b64) {
      const blob = base64ToBlob(res.data_b64);
      return new File([blob], res.name || "CLIPBOARD.PNG", {
        type: "image/png",
      });
    }
  } catch (err) {
    console.warn("[OpenBGR] Native clipboard read failed:", err);
  }
  return null;
}

/** Window `paste` handler: event image items first, then the native clipboard. */
export async function handlePasteEvent(e) {
  // A focused field owns keyboard paste; workspace image ingest stays out.
  if (isTextField(e.target)) return;
  const items = e.clipboardData?.items || [];
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      const blob = item.getAsFile();
      if (!blob) break;
      ingestWithConfirm(blob);
      return;
    }
  }
  const nativeFile = await readNativeClipboardImage();
  if (nativeFile) ingestWithConfirm(nativeFile);
}

/** Paste handler: prefers native clipboard, falls back to `ClipboardEvent` items. */
export async function pasteImageFromClipboard() {
  const nativeFile = await readNativeClipboardImage();
  if (nativeFile) {
    ingestWithConfirm(nativeFile);
    return;
  }
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const imgType = item.types.find((t) => t.startsWith("image/"));
      if (imgType) {
        ingestWithConfirm(await item.getType(imgType));
        return;
      }
    }
    setError("Clipboard does not contain an image.");
  } catch (_) {
    setError("Clipboard does not contain an image (or press Cmd/Ctrl+V).");
  }
}

/** Probes the OS clipboard for image content to gate Edit > Paste Image. */
export async function refreshClipboardState() {
  if (window.pywebview?.api?.has_clipboard_image) {
    try {
      const res = await window.pywebview.api.has_clipboard_image();
      state.clipboardHasImage =
        typeof res?.has_image === "boolean" ? res.has_image : null;
    } catch (_) {
      state.clipboardHasImage = null;
    }
    syncMenuBarState();
    return;
  }
  if (!navigator.clipboard?.read) {
    state.clipboardHasImage = null;
    return;
  }
  try {
    const items = await navigator.clipboard.read();
    state.clipboardHasImage = items.some((item) =>
      (item.types || []).some((t) => t.startsWith("image/"))
    );
  } catch (_) {
    // Unknown (permission denied / unsupported): keep the item enabled.
    state.clipboardHasImage = null;
  }
  syncMenuBarState();
}

/** Wires window paste ingest and the focus-time clipboard probe. */
export function initClipboard() {
  window.addEventListener("paste", handlePasteEvent);
  window.addEventListener("focus", refreshClipboardState);
  on("clipboard:probe", refreshClipboardState);
}

/**
 * Matte backdrop controls in the right sidebar: mode chips, color swatches,
 * the custom color picker, and the backdrop photo chooser.
 * Importing this module has no side effects; app.js calls `initBackdrop()`.
 */

import {
  state,
  dom,
  saveStateToActiveTab,
  setError,
  openContextMenu,
  filesFromDialogResult,
  isImageFile,
} from "./state.js";
import { applyBackdrop, applyBackdropMode } from "./export-ui.js";

/** Decodes a picked photo and installs it as the "image" matte backdrop. */
export async function setBackdropFile(file) {
  if (file) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    await new Promise((resolve) => {
      img.onload = resolve;
      img.onerror = resolve;
      img.src = url;
    });
    if (!img.naturalWidth) {
      URL.revokeObjectURL(url);
      setError("Could not decode the selected backdrop image.");
      return;
    }
    // Replaced URLs are not revoked: tab records snapshot backdropImgUrl and
    // would render broken thumbnails if their copy were revoked under them.
    state.backdropImg = img;
    state.backdropImgUrl = url;
    state.backdropSeq += 1;
  }
  if (state.backdropImg) {
    applyBackdrop("image");
    saveStateToActiveTab();
  }
}

/** Picks (or replaces) the photo used by the "image" matte backdrop. */
export async function chooseBackdropImage() {
  if (window.pywebview?.api?.open_image_dialog) {
    try {
      const res = await window.pywebview.api.open_image_dialog();
      if (res?.error) {
        setError(res.error);
        return;
      }
      const files = await filesFromDialogResult(res);
      await setBackdropFile(files.find(isImageFile));
      return;
    } catch (err) {
      console.warn("[OpenBGR] Native image dialog failed:", err);
    }
  }
  dom.backdropInput.value = "";
  dom.backdropInput.click();
}

/** Drops the loaded backdrop photo, falling back to the grid if it was active. */
export function removeBackdropPhoto() {
  state.backdropImg = null;
  state.backdropImgUrl = null;
  state.backdropSeq += 1;
  applyBackdrop(
    state.activeBackdrop === "image" ? "checker" : state.activeBackdrop
  );
  saveStateToActiveTab();
}

/** Mode chip click; PHOTO opens the picker when no backdrop photo is loaded yet. */
export function handleBackdropModeChip(mode) {
  if (mode === "image" && !state.backdropImg) {
    chooseBackdropImage();
    return;
  }
  applyBackdropMode(mode);
  saveStateToActiveTab();
}

/** Right-clicking the photo thumbnail offers the same remove action. */
export function showBackdropPhotoMenu(x, y) {
  if (!state.backdropImg) return;
  openContextMenu(x, y, (m) => {
    m.item("REMOVE PHOTO", removeBackdropPhoto);
  });
}

/** Wires the backdrop chips, swatches, color picker, and photo controls. */
export function initBackdrop() {
  dom.backdropInput.addEventListener("change", async (e) => {
    const file = Array.from(e.target.files || []).find(isImageFile);
    dom.backdropInput.value = "";
    await setBackdropFile(file);
  });

  document.querySelectorAll(".mode-chip[data-mode]").forEach((chip) => {
    chip.addEventListener("click", () =>
      handleBackdropModeChip(chip.getAttribute("data-mode"))
    );
  });

  document
    .querySelectorAll("#matteSwatches .swatch[data-bg]")
    .forEach((swatch) => {
      swatch.addEventListener("click", () => {
        applyBackdrop(swatch.getAttribute("data-bg") || "checker");
        saveStateToActiveTab();
      });
    });

  dom.btnBackdropPhoto?.addEventListener("click", chooseBackdropImage);
  dom.backdropPhotoThumb?.addEventListener("click", chooseBackdropImage);
  dom.btnBackdropPhotoRemove?.addEventListener("click", removeBackdropPhoto);
  dom.backdropPhotoThumb?.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showBackdropPhotoMenu(e.clientX, e.clientY);
  });

  dom.colorPicker.addEventListener("input", (e) => {
    applyBackdrop(e.target.value);
    saveStateToActiveTab();
  });
}

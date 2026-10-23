/**
 * Export panel UI sync: the dims/size/format readouts, format buttons,
 * destination label, crop guide, backdrop mode chips and wraps, scale,
 * preset, and fit chips. Rendering itself lives in export.js; this module
 * only mirrors `state` into the controls.
 * Importing this module has no side effects.
 */

import {
  state,
  dom,
  masterCutoutImg,
  getActiveTab,
  FORMAT_LABELS,
  formatDiskBytes,
} from "./state.js";
import {
  getActiveCropRect,
  getExportBaseDims,
  exactExportBlob,
  exportAspectMismatch,
  isAnimatedExport,
  updateLiveStagePreview,
} from "./export.js";
import { scheduleAnimatedExportSize } from "./anim-export.js";

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
    // The server-side `/api/choose-folder` fallback works without the
    // pywebview bridge too, so the button stays visible in every mode.
    dom.btnFileDest.style.display = "";
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
    const anyResult =
      state.resultBlob ||
      (state.isAnimated && state.frames.some((f) => f?.resultBlob));
    if (!anyResult) {
      dom.exportSizeLabel.textContent = "--";
    } else {
      const exact = exactExportBlob();
      if (exact) {
        dom.exportSizeLabel.textContent = formatDiskBytes(exact.size);
      } else if (state.isAnimated && state.frames.length > 1) {
        const total = state.frames.length;
        const startIdx = Math.max(
          0,
          Math.min(total - 1, (state.startFrame || 1) - 1)
        );
        const endIdx = Math.max(
          startIdx,
          Math.min(total - 1, (state.endFrame || total) - 1)
        );
        let sumBytes = 0;
        let rangeDone = true;
        for (let i = startIdx; i <= endIdx; i++) {
          const size = state.frames[i]?.resultBlob?.size || 0;
          if (!size) rangeDone = false;
          sumBytes += size;
        }
        if (!rangeDone) {
          // Frames missing a cutout can't export; there is no honest number.
          dom.exportSizeLabel.textContent = "--";
        } else if (isAnimatedExport()) {
          // A GIF's byte size needs a real encode; the debounced background
          // pass lands the exact number on this label shortly.
          dom.exportSizeLabel.textContent = "...";
          scheduleAnimatedExportSize();
        } else {
          // Individual-frame exports: sum the encoded cutout bytes, scaled to
          // the output resolution and adjusted per format.
          const areaScale = Math.max(
            0.05,
            state.exportScale * state.exportScale
          );
          const fmtRatios = {
            png: 1.0,
            webp: 0.42,
            jpg: 0.28,
            mask: 0.18,
          };
          const estBytes = Math.max(
            512,
            Math.round(sumBytes * areaScale * (fmtRatios[state.exportFormat] || 1.0))
          );
          dom.exportSizeLabel.textContent = `~${formatDiskBytes(estBytes)}`;
        }
      } else {
        dom.exportSizeLabel.textContent = "...";
      }
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

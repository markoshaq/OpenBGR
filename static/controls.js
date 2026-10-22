/**
 * Workspace control wiring: the left sidebar (Process, edge toggles, sliders),
 * the top bar (view mode, zoom, loupe), and the right sidebar (format,
 * destination, auto-crop, scale, export dims, presets, fit, export/copy).
 * Importing this module has no side effects; app.js calls `initControls()`.
 */

import {
  state,
  dom,
  getActiveTab,
  saveStateToActiveTab,
} from "./state.js";
import { setZoom } from "./stage.js";
import {
  updateLiveStagePreview,
  getExportBaseDims,
} from "./export.js";
import {
  updateExportTelemetry,
  applyScaleValue,
  applyExportSizePreset,
  resetExportSize,
  setCanvasFit,
} from "./export-ui.js";
import {
  chooseOutputFolder,
  exportActiveImage,
  copyActiveCutout,
} from "./export-io.js";
import { renderBatchPanel } from "./batch-panel.js";
import { runBatch } from "./batch-run.js";
import { setViewMode, toggleLoupe, syncMenuBarState } from "./tabs.js";
import { runSegmentation, applyEdgeRefinement } from "./segmentation.js";

/** Process button: starts inference only when an image is loaded and idle. */
export function handleProcessClick() {
  if (state.sourceFile && !state.isProcessing) {
    runSegmentation();
  }
}

/** DEFRINGE toggle: flips the flag, mirrors it, and re-runs refinement. */
export function toggleDefringe() {
  state.defringe = !state.defringe;
  dom.btnDefringe.classList.toggle("active", state.defringe);
  saveStateToActiveTab();
  syncMenuBarState();
  applyEdgeRefinement();
}

/** SUPPRESS COLOR SPILL toggle: flips the flag, mirrors it, and re-runs refinement. */
export function toggleDespill() {
  state.despill = !state.despill;
  dom.btnDespill.classList.toggle("active", state.despill);
  saveStateToActiveTab();
  syncMenuBarState();
  applyEdgeRefinement();
}

/** Shadow cutoff slider; with Auto-Crop on it reshapes the crop instead of the stage. */
export function handleShadowCutoffInput(value) {
  state.shadowCutoff = parseInt(value || "0", 10);
  if (dom.shadowCutoffLabel) {
    dom.shadowCutoffLabel.textContent = `${state.shadowCutoff}%`;
  }
  if (state.autoCrop) {
    if (state.aspectLocked) applyScaleValue(state.exportScale);
    else updateExportTelemetry();
    return;
  }
  updateLiveStagePreview();
}

/** Edge shift slider. */
export function handleEdgeShiftInput(value) {
  state.edgeShift = parseInt(value || "0", 10);
  if (dom.edgeShiftLabel) {
    dom.edgeShiftLabel.textContent = `${state.edgeShift > 0 ? "+" : ""}${state.edgeShift}px`;
  }
  applyEdgeRefinement();
  saveStateToActiveTab();
}

/** Edge feather slider. */
export function handleEdgeFeatherInput(value) {
  state.edgeFeather = parseInt(value || "0", 10);
  if (dom.edgeFeatherLabel) {
    dom.edgeFeatherLabel.textContent = `${state.edgeFeather}px`;
  }
  applyEdgeRefinement();
  saveStateToActiveTab();
}

/** Format button: stores the export format and refreshes the readout. */
export function handleFormatPick(btn) {
  state.exportFormat = btn.getAttribute("data-format") || "png";
  updateExportTelemetry();
  saveStateToActiveTab();
}

/** AUTO-CROP toggle: mirrors the switch, then reshapes export dims or the readout. */
export function toggleAutoCrop() {
  state.autoCrop = !state.autoCrop;
  dom.btnAutoCrop.classList.toggle("active", state.autoCrop);
  dom.btnAutoCrop.setAttribute("aria-checked", String(state.autoCrop));
  dom.cropPaddingWrap?.classList.toggle("disabled", !state.autoCrop);
  if (state.aspectLocked) applyScaleValue(state.exportScale);
  else updateExportTelemetry();
  saveStateToActiveTab();
}

/** Crop padding slider. */
export function handleCropPaddingInput(value) {
  state.cropPadding = parseInt(value || "0", 10);
  if (dom.cropPaddingLabel) {
    dom.cropPaddingLabel.textContent = `${state.cropPadding}%`;
  }
  if (state.autoCrop) {
    if (state.aspectLocked) applyScaleValue(state.exportScale);
    else updateExportTelemetry();
  }
  saveStateToActiveTab();
}

/** Backdrop blur slider. */
export function handleBackdropBlurInput(value) {
  state.backdropBlur = parseInt(value || "0", 10);
  if (dom.backdropBlurLabel) {
    dom.backdropBlurLabel.textContent = `${state.backdropBlur}%`;
  }
  updateLiveStagePreview();
  saveStateToActiveTab();
}

/** Export scale slider, a percent that drives applyScaleValue. */
export function handleExportScaleInput(value) {
  const pct = parseInt(value || "100", 10);
  applyScaleValue(pct / 100);
}

/** Aspect-ratio lock toggle. */
export function toggleAspectLock() {
  state.aspectLocked = !state.aspectLocked;
  dom.aspectLockBtn.classList.toggle("active", state.aspectLocked);
  dom.aspectLockBtn.setAttribute("aria-pressed", String(state.aspectLocked));
}

/** Custom width input; a cleared field falls back to the scale-derived size. */
export function handleExportWidthInput(value) {
  const val = parseInt(value, 10);
  if (!val || val < 1) {
    state.exportWidth = 0;
    if (state.aspectLocked) state.exportHeight = 0;
    updateExportTelemetry();
    return;
  }
  state.exportWidth = Math.min(16384, val);
  if (
    state.aspectLocked &&
    state.naturalWidth > 0 &&
    state.naturalHeight > 0
  ) {
    const baseDims = getExportBaseDims();
    state.exportScale = state.exportWidth / baseDims.w;
    state.exportHeight = Math.max(
      1,
      Math.round(baseDims.h * state.exportScale)
    );
    dom.exportHeightInput.value = String(state.exportHeight);
  }
  updateExportTelemetry();
}

/** Custom height input; a cleared field falls back to the scale-derived size. */
export function handleExportHeightInput(value) {
  const val = parseInt(value, 10);
  if (!val || val < 1) {
    state.exportHeight = 0;
    if (state.aspectLocked) state.exportWidth = 0;
    updateExportTelemetry();
    return;
  }
  state.exportHeight = Math.min(16384, val);
  if (
    state.aspectLocked &&
    state.naturalWidth > 0 &&
    state.naturalHeight > 0
  ) {
    const baseDims = getExportBaseDims();
    state.exportScale = state.exportHeight / baseDims.h;
    state.exportWidth = Math.max(
      1,
      Math.round(baseDims.w * state.exportScale)
    );
    dom.exportWidthInput.value = String(state.exportWidth);
  }
  updateExportTelemetry();
}

/** Download button: batch tabs run the queue, image tabs export the cutout. */
export function handleDownloadClick() {
  const activeTab = getActiveTab();
  if (activeTab?.kind === "batch") {
    runBatch(activeTab);
    return;
  }
  exportActiveImage();
}

/** Retry button: re-runs only the failed entries of the active batch tab. */
export function handleBatchRetryClick() {
  const activeTab = getActiveTab();
  if (activeTab?.kind === "batch") runBatch(activeTab, { onlyFailed: true });
}

/** Wires every left-sidebar, top-bar, and right-sidebar control. */
export function initControls() {
  // Left sidebar: Process button, Edge & Reflection toggles, Shadow Cutoff
  dom.btnProcess?.addEventListener("click", handleProcessClick);
  dom.btnDefringe.addEventListener("click", toggleDefringe);
  dom.btnDespill?.addEventListener("click", toggleDespill);
  dom.shadowCutoffSlider?.addEventListener("input", (e) =>
    handleShadowCutoffInput(e.target.value)
  );
  dom.edgeShiftSlider?.addEventListener("input", (e) =>
    handleEdgeShiftInput(e.target.value)
  );
  dom.edgeFeatherSlider?.addEventListener("input", (e) =>
    handleEdgeFeatherInput(e.target.value)
  );

  // Top bar: View mode, Zoom, and 4x Loupe
  document
    .getElementById("viewSplit")
    .addEventListener("click", () => setViewMode("split"));
  document
    .getElementById("viewCutout")
    .addEventListener("click", () => setViewMode("cutout"));
  document
    .getElementById("viewOriginal")
    .addEventListener("click", () => setViewMode("original"));

  dom.btnZoomIn?.addEventListener("click", () => setZoom(state.zoom + 0.25));
  dom.btnZoomOut?.addEventListener("click", () => setZoom(state.zoom - 0.25));
  dom.btnZoomReset?.addEventListener("click", () => setZoom(1));
  dom.btnLoupe?.addEventListener("click", () => toggleLoupe());

  // Right sidebar: Format buttons, Destination picker, Scale, Custom PX, Export & Copy
  document.querySelectorAll("#formatRow .fmt-btn").forEach((btn) => {
    btn.addEventListener("click", () => handleFormatPick(btn));
  });

  dom.btnFileDest?.addEventListener("click", () =>
    chooseOutputFolder(renderBatchPanel)
  );

  dom.btnAutoCrop?.addEventListener("click", toggleAutoCrop);
  dom.cropPaddingSlider?.addEventListener("input", (e) =>
    handleCropPaddingInput(e.target.value)
  );
  dom.backdropBlurSlider?.addEventListener("input", (e) =>
    handleBackdropBlurInput(e.target.value)
  );
  dom.exportScaleSlider.addEventListener("input", (e) =>
    handleExportScaleInput(e.target.value)
  );

  document.querySelectorAll(".quick-scale-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const sc = parseFloat(btn.getAttribute("data-scale") || "1");
      applyScaleValue(sc);
    });
  });

  dom.aspectLockBtn?.addEventListener("click", toggleAspectLock);
  dom.exportWidthInput.addEventListener("input", (e) =>
    handleExportWidthInput(e.target.value)
  );
  dom.exportHeightInput.addEventListener("input", (e) =>
    handleExportHeightInput(e.target.value)
  );

  // Preset export sizes: exact custom boxes with the subject centered on canvas.
  document.querySelectorAll(".preset-chip[data-w]").forEach((chip) => {
    chip.addEventListener("click", () => {
      applyExportSizePreset(
        parseInt(chip.getAttribute("data-w"), 10),
        parseInt(chip.getAttribute("data-h"), 10)
      );
      saveStateToActiveTab();
    });
  });

  dom.presetReset?.addEventListener("click", () => {
    resetExportSize();
    saveStateToActiveTab();
  });

  // Canvas fit: FIT keeps aspect with margins, STRETCH distorts to fill.
  document.querySelectorAll(".fit-chip[data-fit]").forEach((chip) => {
    chip.addEventListener("click", () => {
      setCanvasFit(chip.getAttribute("data-fit"));
      saveStateToActiveTab();
    });
  });

  dom.btnDownload.addEventListener("click", handleDownloadClick);
  dom.btnBatchRetry?.addEventListener("click", handleBatchRetryClick);
  dom.btnCopy.addEventListener("click", copyActiveCutout);
}

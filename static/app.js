/**
 * OpenBGR - Frontend Entry Point
 * Wires DOM controls, pointer/keyboard gestures, clipboard and file dialogs,
 * the in-app menu bar, and the `window.openBGR` bridge for native OS menus.
 */

import {
  state,
  dom,
  prefs,
  apiFetch,
  TIER_KEYS,
  setPref,
  resetPrefs,
  getActiveTab,
  saveStateToActiveTab,
  normalizeTierKey,
  setError,
  openConfirmModal,
  closeConfirmModal,
  triggerOpenFileDialog,
  base64ToBlob,
  filesFromDialogResult,
  isImageFile,
  openExternalUrl,
} from "./state.js";
import {
  setZoom,
  applyZoomTransform,
  renderLoupeAtPointer,
  handleSplitDrag,
} from "./stage.js";
import {
  syncFormatButtons,
  chooseOutputFolder,
  updateExportTelemetry,
  updateLiveStagePreview,
  applyBackdrop,
  applyScaleValue,
  applyExportSizePreset,
  resetExportSize,
  setCanvasFit,
  applyBackdropMode,
  getExportBaseDims,
  exportActiveImage,
  copyActiveCutout,
} from "./export.js";
import {
  updateCacheIndicator,
  syncServerStatus,
  selectPrefsPane,
  openPrefsDialog,
  closePrefsDialog,
  applyPreferences,
  uninstallModel,
  openCacheFolder,
  openLogsFolder,
  showModelContextMenu,
  syncQuickActionConfigToServer,
  toggleQuickActionInstall,
} from "./preferences.js";
import {
  openMultiFileChooser,
  pickImageFiles,
  addFilesToBatchTab,
  renderBatchPanel,
  extractBatchItemToTab,
  hideTabContextMenu,
  runBatch,
  requestBatch,
  requestBatchDispatch,
} from "./batch.js";
import {
  showTabGhost,
  hideTabGhost,
  createBlankTab,
  requestCloseTab,
  requestSwitchToTab,
  ingestImageFile,
  setViewMode,
  selectTier,
  toggleLoupe,
  syncMenuBarState,
  cancelProcessing,
  runSegmentation,
  applyEdgeRefinement,
} from "./tabs.js";

/**
 * Shared floating tooltip anchored to the viewport on `<body>` for every
 * `[data-tooltip]` element, so scrollable sidebars cannot clip it.
 */
function initTooltips() {
  let tipEl = null;
  let tipHost = null;

  const ensureTip = () => {
    if (!tipEl) {
      tipEl = document.createElement("div");
      tipEl.className = "floating-tooltip";
      tipEl.setAttribute("role", "tooltip");
      document.body.appendChild(tipEl);
    }
    return tipEl;
  };

  const hideTip = () => {
    tipHost = null;
    tipEl?.classList.remove("visible");
  };

  document.addEventListener("mouseover", (e) => {
    const host = e.target?.closest?.("[data-tooltip]");
    const text = host?.getAttribute("data-tooltip");
    if (!text) {
      if (tipHost) hideTip();
      return;
    }
    if (host === tipHost && tipEl?.textContent === text) return;
    tipHost = host;
    const tip = ensureTip();
    tip.textContent = text;
    tip.classList.add("visible");

    const hostRect = host.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    let top = hostRect.bottom + 6;
    if (top + tipRect.height > window.innerHeight - 8) {
      top = hostRect.top - tipRect.height - 6;
    }
    top = Math.max(8, Math.min(top, window.innerHeight - tipRect.height - 8));
    let left = hostRect.left + hostRect.width / 2 - tipRect.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8));
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  });
  document.addEventListener("pointerdown", hideTip, true);
  document.addEventListener("mouseleave", hideTip);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideTip();
  });
  window.addEventListener("scroll", hideTip, true);
  window.addEventListener("blur", hideTip);
}

// Connectivity listeners for model cache indicators
window.addEventListener("online", updateCacheIndicator);
window.addEventListener("offline", updateCacheIndicator);

// Tab bar dropzone for dragging a batch row onto empty tab-bar space
dom.tabBar?.addEventListener("dragover", (e) => {
  if (!state.dragBatchItem) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
  const src = state.tabs.find((t) => t.id === state.dragBatchItem.tabId);
  const name = src?.batchFiles[state.dragBatchItem.index]?.name || "image";
  showTabGhost(name);
});
dom.tabBar?.addEventListener("dragleave", (e) => {
  if (!dom.tabBar.contains(e.relatedTarget)) hideTabGhost();
});
dom.tabBar?.addEventListener("drop", (e) => {
  const item = state.dragBatchItem;
  if (!item) return;
  e.preventDefault();
  e.stopPropagation();
  state.dragBatchItem = null;
  hideTabGhost();
  const src = state.tabs.find((t) => t.id === item.tabId);
  if (src) extractBatchItemToTab(src, item.index);
});

// Dismiss tab context menu on outside click or Escape
window.addEventListener("click", (e) => {
  if (
    dom.tabContextMenu &&
    (!(e.target instanceof Node) || !dom.tabContextMenu.contains(e.target))
  ) {
    hideTabContextMenu();
  }
});

// Busy cancel & confirmation modal controls
dom.btnCancel.addEventListener("click", cancelProcessing);
dom.btnModalCancel.addEventListener("click", closeConfirmModal);
dom.btnModalConfirm.addEventListener("click", () => {
  const fn = state.pendingConfirmFn;
  closeConfirmModal();
  if (typeof fn === "function") fn();
});
dom.btnModalAlt?.addEventListener("click", () => {
  const fn = state.pendingAltFn;
  closeConfirmModal();
  if (typeof fn === "function") fn();
});
dom.confirmModal.addEventListener("click", (e) => {
  if (e.target === dom.confirmModal) closeConfirmModal();
});

// Preferences modal controls
dom.btnInfo.addEventListener("click", () => openPrefsDialog());
dom.btnInfoClose.addEventListener("click", () => closePrefsDialog());
dom.btnPrefsCloseX?.addEventListener("click", () => closePrefsDialog());
dom.infoModal.addEventListener("click", (e) => {
  if (e.target === dom.infoModal) closePrefsDialog();
});
dom.infoModal.querySelectorAll(".prefs-nav-item").forEach((item) => {
  item.addEventListener("click", () =>
    selectPrefsPane(item.getAttribute("data-pane"))
  );
});

dom.infoModal.querySelectorAll("[data-uninstall-model]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const key = btn.getAttribute("data-uninstall-model");
    if (key) uninstallModel(key);
  });
});

document
  .getElementById("btnUninstallAllModels")
  ?.addEventListener("click", () => uninstallModel("all"));

dom.btnOpenCacheDir?.addEventListener("click", () => openCacheFolder());
dom.btnOpenLogsDir?.addEventListener("click", () => openLogsFolder());

dom.infoModal.querySelectorAll(".model-row[data-model-key]").forEach((row) => {
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const key = row.getAttribute("data-model-key");
    if (key) showModelContextMenu(key, e.clientX, e.clientY);
  });
});

if (dom.btnToggleConfirmClose) {
  dom.btnToggleConfirmClose.classList.toggle("active", state.confirmCloseTab);
  dom.btnToggleConfirmClose.addEventListener("click", () => {
    state.confirmCloseTab = !state.confirmCloseTab;
    setPref("confirmClose", state.confirmCloseTab);
    dom.btnToggleConfirmClose.classList.toggle("active", state.confirmCloseTab);
  });
}

dom.prefThemeDark?.addEventListener("click", () => {
  setPref("theme", "dark");
  applyPreferences(syncMenuBarState);
});
dom.prefThemeLight?.addEventListener("click", () => {
  setPref("theme", "light");
  applyPreferences(syncMenuBarState);
});
dom.accentSwatches?.querySelectorAll(".swatch").forEach((sw) => {
  sw.addEventListener("click", () => {
    setPref("accent", sw.getAttribute("data-accent") || "default");
    applyPreferences(syncMenuBarState);
  });
});
dom.prefDefaultTier?.addEventListener("change", (e) => {
  setPref("defaultTier", e.target.value);
  if (!state.sourceFile) {
    const targetTier =
      prefs.defaultTier !== "auto"
        ? prefs.defaultTier
        : state.serverStatus?.recommended_tier || "general";
    selectTier(targetTier);
  }
});
dom.prefDefaultFormat?.addEventListener("change", (e) => {
  setPref("defaultFormat", e.target.value);
  if (!state.resultBlob) {
    state.exportFormat = prefs.defaultFormat;
    updateExportTelemetry();
  }
});
dom.prefDefaultBackdrop?.addEventListener("change", (e) => {
  setPref("defaultBackdrop", e.target.value);
  if (!state.resultBlob) {
    applyBackdrop(prefs.defaultBackdrop);
  }
});
dom.prefQaTier?.addEventListener("change", (e) => {
  setPref("qaTier", e.target.value);
  syncQuickActionConfigToServer();
});
dom.prefQaSaveMode?.addEventListener("change", (e) => {
  setPref("qaSaveMode", e.target.value);
  syncQuickActionConfigToServer();
});
dom.prefQaFormat?.addEventListener("change", (e) => {
  setPref("qaFormat", e.target.value);
  syncQuickActionConfigToServer();
});
dom.btnToggleQaEdgeRefine?.addEventListener("click", () => {
  setPref("qaEdgeRefine", !prefs.qaEdgeRefine);
  dom.btnToggleQaEdgeRefine.classList.toggle("active", prefs.qaEdgeRefine);
  syncQuickActionConfigToServer();
});
dom.btnToggleQaClipboard?.addEventListener("click", () => {
  setPref("qaCopyClipboard", !prefs.qaCopyClipboard);
  dom.btnToggleQaClipboard.classList.toggle("active", prefs.qaCopyClipboard);
  syncQuickActionConfigToServer();
});
dom.btnToggleQaNotify?.addEventListener("click", () => {
  setPref("qaNotify", !prefs.qaNotify);
  dom.btnToggleQaNotify.classList.toggle("active", prefs.qaNotify);
  syncQuickActionConfigToServer();
});
dom.btnQaInstallToggle?.addEventListener("click", () => {
  toggleQuickActionInstall();
});
dom.btnResetPrefs?.addEventListener("click", () => {
  resetPrefs();
  state.confirmCloseTab = prefs.confirmClose;
  applyPreferences(syncMenuBarState);
  syncQuickActionConfigToServer();
  if (!state.resultBlob) {
    state.exportFormat = prefs.defaultFormat;
    applyBackdrop(prefs.defaultBackdrop);
    selectTier(state.serverStatus?.recommended_tier || "general");
    updateExportTelemetry();
  }
});

// Model dropdown: the collapsed trigger mirrors the active tier card. A
// MutationObserver keeps the mirror synced with .active and dot-class changes
// made elsewhere (tab restore, server-status updates, downloads).
function syncTierDropdownTrigger() {
  const active =
    document.querySelector("#tierSelector .tier-btn.active") ||
    document.querySelector("#tierSelector .tier-btn");
  if (!active) return;
  if (dom.tierDropdownLabel) {
    dom.tierDropdownLabel.textContent =
      active.querySelector(".tier-label")?.textContent || "";
  }
  if (dom.tierDropdownTech) {
    dom.tierDropdownTech.textContent =
      active.querySelector(".tier-tech")?.textContent || "";
  }
}

function setTierDropdownOpen(open) {
  dom.tierDropdown?.classList.toggle("open", open);
  dom.tierDropdownBtn?.setAttribute("aria-expanded", String(open));
}

dom.tierDropdownBtn?.addEventListener("click", () => {
  setTierDropdownOpen(!dom.tierDropdown.classList.contains("open"));
});

// A chosen option collapses the list; the tier handler above still runs.
dom.tierDropdown?.addEventListener("click", (e) => {
  if (e.target.closest("#tierSelector .tier-btn")) setTierDropdownOpen(false);
});

document.addEventListener("click", (e) => {
  if (
    dom.tierDropdown?.classList.contains("open") &&
    !e.target.closest("#tierDropdown")
  ) {
    setTierDropdownOpen(false);
  }
});

new MutationObserver(syncTierDropdownTrigger).observe(
  document.getElementById("tierSelector"),
  {
    attributes: true,
    attributeFilter: ["class"],
    childList: true,
    characterData: true,
    subtree: true,
  }
);
syncTierDropdownTrigger();

// Left sidebar: Model selector, Process button, Edge & Reflection toggles, Shadow Cutoff
document.querySelectorAll("#tierSelector .tier-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const targetTier = btn.getAttribute("data-tier");
    if (targetTier && targetTier !== state.tier) {
      selectTier(targetTier);
    }
  });
  btn.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const targetTier = btn.getAttribute("data-tier");
    if (targetTier) showModelContextMenu(targetTier, e.clientX, e.clientY);
  });
});

dom.btnProcess?.addEventListener("click", () => {
  if (state.sourceFile && !state.isProcessing) {
    runSegmentation();
  }
});

dom.btnDefringe.addEventListener("click", () => {
  state.defringe = !state.defringe;
  dom.btnDefringe.classList.toggle("active", state.defringe);
  saveStateToActiveTab();
  syncMenuBarState();
  applyEdgeRefinement();
});

dom.btnDespill?.addEventListener("click", () => {
  state.despill = !state.despill;
  dom.btnDespill.classList.toggle("active", state.despill);
  saveStateToActiveTab();
  syncMenuBarState();
  applyEdgeRefinement();
});

dom.shadowCutoffSlider?.addEventListener("input", (e) => {
  state.shadowCutoff = parseInt(e.target.value || "0", 10);
  if (dom.shadowCutoffLabel) {
    dom.shadowCutoffLabel.textContent = `${state.shadowCutoff}%`;
  }
  if (state.autoCrop) {
    if (state.aspectLocked) applyScaleValue(state.exportScale);
    else updateExportTelemetry();
    return;
  }
  updateLiveStagePreview();
});

dom.edgeShiftSlider?.addEventListener("input", (e) => {
  state.edgeShift = parseInt(e.target.value || "0", 10);
  if (dom.edgeShiftLabel) {
    dom.edgeShiftLabel.textContent = `${state.edgeShift > 0 ? "+" : ""}${state.edgeShift}px`;
  }
  applyEdgeRefinement();
  saveStateToActiveTab();
});

dom.edgeFeatherSlider?.addEventListener("input", (e) => {
  state.edgeFeather = parseInt(e.target.value || "0", 10);
  if (dom.edgeFeatherLabel) {
    dom.edgeFeatherLabel.textContent = `${state.edgeFeather}px`;
  }
  applyEdgeRefinement();
  saveStateToActiveTab();
});

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
  btn.addEventListener("click", () => {
    state.exportFormat = btn.getAttribute("data-format") || "png";
    updateExportTelemetry();
    saveStateToActiveTab();
  });
});

dom.btnFileDest?.addEventListener("click", () =>
  chooseOutputFolder(renderBatchPanel)
);

dom.btnAutoCrop?.addEventListener("click", () => {
  state.autoCrop = !state.autoCrop;
  dom.btnAutoCrop.classList.toggle("active", state.autoCrop);
  dom.btnAutoCrop.setAttribute("aria-checked", String(state.autoCrop));
  dom.cropPaddingWrap?.classList.toggle("disabled", !state.autoCrop);
  if (state.aspectLocked) applyScaleValue(state.exportScale);
  else updateExportTelemetry();
  saveStateToActiveTab();
});

dom.cropPaddingSlider?.addEventListener("input", (e) => {
  state.cropPadding = parseInt(e.target.value || "0", 10);
  if (dom.cropPaddingLabel) {
    dom.cropPaddingLabel.textContent = `${state.cropPadding}%`;
  }
  if (state.autoCrop) {
    if (state.aspectLocked) applyScaleValue(state.exportScale);
    else updateExportTelemetry();
  }
  saveStateToActiveTab();
});

dom.backdropBlurSlider?.addEventListener("input", (e) => {
  state.backdropBlur = parseInt(e.target.value || "0", 10);
  if (dom.backdropBlurLabel) {
    dom.backdropBlurLabel.textContent = `${state.backdropBlur}%`;
  }
  updateLiveStagePreview();
  saveStateToActiveTab();
});

dom.exportScaleSlider.addEventListener("input", (e) => {
  const pct = parseInt(e.target.value || "100", 10);
  applyScaleValue(pct / 100);
});

document.querySelectorAll(".quick-scale-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const sc = parseFloat(btn.getAttribute("data-scale") || "1");
    applyScaleValue(sc);
  });
});

dom.aspectLockBtn?.addEventListener("click", () => {
  state.aspectLocked = !state.aspectLocked;
  dom.aspectLockBtn.classList.toggle("active", state.aspectLocked);
  dom.aspectLockBtn.setAttribute("aria-pressed", String(state.aspectLocked));
});

dom.exportWidthInput.addEventListener("input", (e) => {
  const val = parseInt(e.target.value, 10);
  if (!val || val < 1) {
    // Cleared input = "auto"; fall back to the scale-derived size.
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
});

dom.exportHeightInput.addEventListener("input", (e) => {
  const val = parseInt(e.target.value, 10);
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
});

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

dom.btnDownload.addEventListener("click", () => {
  const activeTab = getActiveTab();
  if (activeTab?.kind === "batch") {
    runBatch(activeTab);
    return;
  }
  exportActiveImage();
});

dom.btnBatchRetry?.addEventListener("click", () => {
  const activeTab = getActiveTab();
  if (activeTab?.kind === "batch") runBatch(activeTab, { onlyFailed: true });
});

dom.btnCopy.addEventListener("click", copyActiveCutout);

// Matte backdrop swatches & custom color picker
/** Decodes a picked photo and installs it as the "image" matte backdrop. */
async function setBackdropFile(file) {
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
async function chooseBackdropImage() {
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

dom.backdropInput.addEventListener("change", async (e) => {
  const file = Array.from(e.target.files || []).find(isImageFile);
  dom.backdropInput.value = "";
  await setBackdropFile(file);
});

// Backdrop mode chips pick the compositing mode; PHOTO opens the picker when
// no backdrop photo is loaded yet.
document.querySelectorAll(".mode-chip[data-mode]").forEach((chip) => {
  chip.addEventListener("click", () => {
    const mode = chip.getAttribute("data-mode");
    if (mode === "image" && !state.backdropImg) {
      chooseBackdropImage();
      return;
    }
    applyBackdropMode(mode);
    saveStateToActiveTab();
  });
});

document.querySelectorAll("#matteSwatches .swatch[data-bg]").forEach((swatch) => {
  swatch.addEventListener("click", () => {
    applyBackdrop(swatch.getAttribute("data-bg") || "checker");
    saveStateToActiveTab();
  });
});

/** Drops the loaded backdrop photo, falling back to the grid if it was active. */
function removeBackdropPhoto() {
  state.backdropImg = null;
  state.backdropImgUrl = null;
  state.backdropSeq += 1;
  applyBackdrop(
    state.activeBackdrop === "image" ? "checker" : state.activeBackdrop
  );
  saveStateToActiveTab();
}

dom.btnBackdropPhoto?.addEventListener("click", chooseBackdropImage);
dom.backdropPhotoThumb?.addEventListener("click", chooseBackdropImage);
dom.btnBackdropPhotoRemove?.addEventListener("click", removeBackdropPhoto);

// Right-clicking the photo thumbnail offers the same remove action.
dom.backdropPhotoThumb?.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (!state.backdropImg || !dom.tabContextMenu) return;
  const menu = dom.tabContextMenu;
  menu.replaceChildren();
  const item = document.createElement("button");
  item.type = "button";
  item.className = "ctx-item";
  item.textContent = "REMOVE PHOTO";
  item.addEventListener("click", () => {
    hideTabContextMenu();
    removeBackdropPhoto();
  });
  menu.appendChild(item);
  menu.style.display = "block";
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(e.clientX, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(e.clientY, window.innerHeight - rect.height - 8)}px`;
});

dom.colorPicker.addEventListener("input", (e) => {
  applyBackdrop(e.target.value);
  saveStateToActiveTab();
});

// Viewport wheel zoom, pan, split drag, and loupe tracking.
// Standard canvas-app convention (Figma/Maps): two-finger scroll pans the
// zoomed stage, while pinch (ctrlKey wheel) or Cmd/Ctrl+wheel zooms.
dom.viewport.addEventListener(
  "wheel",
  (e) => {
    if (!state.sourceFile) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      // Trackpad pinch arrives as wheel events with ctrlKey set.
      setZoom(state.zoom * Math.exp(-e.deltaY * 0.01));
    } else {
      state.panX -= e.deltaX;
      state.panY -= e.deltaY;
      applyZoomTransform();
    }
    renderLoupeAtPointer(e.clientX, e.clientY);
  },
  { passive: false }
);

// WebKit pinch gestures (WKWebView delivers GestureEvent instead of ctrlKey
// wheel events) zoom relative to the zoom level at gesture start.
let gestureStartZoom = 1;
dom.viewport.addEventListener("gesturestart", (e) => {
  if (!state.sourceFile) return;
  e.preventDefault();
  gestureStartZoom = state.zoom;
});
dom.viewport.addEventListener("gesturechange", (e) => {
  if (!state.sourceFile) return;
  e.preventDefault();
  setZoom(gestureStartZoom * e.scale);
});

dom.stage.addEventListener("dblclick", () => setZoom(1));
dom.stage.addEventListener("contextmenu", (e) => {
  if (state.zoom > 1) e.preventDefault();
});

dom.stage.addEventListener("mousedown", (e) => {
  if (
    state.zoom > 1 &&
    (e.button === 1 ||
      e.button === 2 ||
      state.spacePressed ||
      state.viewMode !== "split")
  ) {
    e.preventDefault();
    state.isPanning = true;
    state.panStartX = e.clientX - state.panX;
    state.panStartY = e.clientY - state.panY;
    dom.stage.classList.add("panning");
    return;
  }
  if (e.button === 0 && state.viewMode === "split" && !state.loupeEnabled) {
    state.isDraggingSplit = true;
    handleSplitDrag(e.clientX);
  }
});

window.addEventListener("mousemove", (e) => {
  // Releasing the button outside the window never delivers mouseup, so a
  // latched drag flag would keep panning/splitting with no button held.
  if (e.buttons === 0 && (state.isPanning || state.isDraggingSplit)) {
    state.isPanning = false;
    state.isDraggingSplit = false;
    dom.stage.classList.remove("panning");
  }
  if (state.isPanning) {
    state.panX = e.clientX - state.panStartX;
    state.panY = e.clientY - state.panStartY;
    applyZoomTransform();
    return;
  }
  handleSplitDrag(e.clientX);
  if (state.loupeEnabled) {
    renderLoupeAtPointer(e.clientX, e.clientY);
  }
});

dom.stage.addEventListener("mouseleave", () => {
  dom.loupeCanvas?.classList.remove("visible");
});

window.addEventListener("mouseup", () => {
  if (state.isPanning) {
    state.isPanning = false;
    dom.stage.classList.remove("panning");
  }
  state.isDraggingSplit = false;
  saveStateToActiveTab();
});

dom.stage.addEventListener(
  "touchstart",
  (e) => {
    if (state.viewMode !== "split" || state.loupeEnabled) return;
    state.isDraggingSplit = true;
    if (e.touches[0]) handleSplitDrag(e.touches[0].clientX);
  },
  { passive: true }
);
window.addEventListener(
  "touchmove",
  (e) => {
    if (state.isDraggingSplit && e.touches[0]) {
      handleSplitDrag(e.touches[0].clientX);
    }
  },
  { passive: true }
);
window.addEventListener("touchend", () => {
  state.isDraggingSplit = false;
  saveStateToActiveTab();
});

// File dialogs, drag-and-drop, and clipboard paste
/** Opens the image picker via native bridge or the hidden file input. */
async function openImageDialog() {
  if (window.pywebview?.api?.open_image_dialog) {
    try {
      const res = await window.pywebview.api.open_image_dialog();
      if (res?.error) {
        setError(res.error);
        return;
      }
      const files = await filesFromDialogResult(res);
      if (files.length > 1) {
        openMultiFileChooser(files, "SELECTED");
      } else if (files.length === 1) {
        ingestImageFile(files[0]);
      }
      return;
    } catch (err) {
      console.warn("[OpenBGR] Native image dialog failed:", err);
    }
  }
  triggerOpenFileDialog();
}

/** Entry point for the Open action; routes to batch or single-image ingestion. */
function requestOpenImage() {
  if (state.isProcessing) {
    openConfirmModal(
      "This will stop the current image processing. Do you want to open a new image?",
      () => {
        cancelProcessing();
        openImageDialog();
      }
    );
    return;
  }
  openImageDialog();
}

dom.emptyState.addEventListener("click", requestOpenImage);
dom.btnOpen.addEventListener("click", requestOpenImage);

dom.btnBatchAdd?.addEventListener("click", () => {
  const tab = getActiveTab();
  if (!tab || tab.kind !== "batch" || state.batch.running) return;
  pickImageFiles((files) => addFilesToBatchTab(tab, files));
});

dom.fileInput.addEventListener("change", (e) => {
  const picked = Array.from(e.target.files || []);
  const files = picked.filter(isImageFile);
  const expecting = state.expectingBatch;
  state.expectingBatch = false;
  if (picked.length && files.length === 0) {
    setError("Only image files can be processed.");
    return;
  }
  if (files.length < picked.length) {
    setError("Non-image files skipped.");
  }
  if (files.length === 0) return;
  if (expecting) {
    requestBatchDispatch(files);
    return;
  }
  if (files.length > 1) {
    openMultiFileChooser(files, "SELECTED");
    return;
  }
  if (state.isProcessing) cancelProcessing();
  files.forEach((f) => ingestImageFile(f));
});

// Cancelling the file dialog must clear the batch dispatch intent, otherwise
// the next normal Open would be routed into a batch queue.
dom.fileInput.addEventListener("cancel", () => {
  state.expectingBatch = false;
});

window.addEventListener("dragover", (e) => {
  e.preventDefault();
  dom.viewport.classList.add("dragover");
});

window.addEventListener("dragleave", (e) => {
  // Only clear the highlight when the drag leaves the window entirely;
  // dragleave also fires while crossing between child elements.
  if (!e.relatedTarget) {
    dom.viewport.classList.remove("dragover");
  }
});

window.addEventListener("drop", (e) => {
  e.preventDefault();
  dom.viewport.classList.remove("dragover");

  const item = state.dragBatchItem;
  if (item) {
    state.dragBatchItem = null;
    hideTabGhost();
    if (e.target.closest?.(".batch-list")) return;
    const src = state.tabs.find((t) => t.id === item.tabId);
    if (src) extractBatchItemToTab(src, item.index);
    return;
  }

  const dropped = Array.from(e.dataTransfer?.files || []);
  if (dropped.length === 0) return;
  const files = dropped.filter(isImageFile);
  if (files.length === 0) {
    setError("Only image files can be processed.");
    return;
  }
  if (files.length < dropped.length) {
    setError("Non-image files skipped.");
  }

  const activeTab = getActiveTab();
  if (activeTab?.kind === "batch" && !state.batch.running) {
    addFilesToBatchTab(activeTab, files);
    return;
  }

  if (files.length > 1) {
    openMultiFileChooser(files, "DROPPED");
    return;
  }

  if (state.isProcessing) {
    openConfirmModal(
      "This will stop the current image processing. Do you want to load the dropped image?",
      () => {
        cancelProcessing();
        files.forEach((f) => ingestImageFile(f));
      }
    );
    return;
  }
  files.forEach((f) => ingestImageFile(f));
});

/** Ingests a file, prompting when it would replace an existing unprocessed image. */
function ingestWithConfirm(fileOrBlob) {
  if (state.isProcessing) {
    openConfirmModal(
      "This will stop the current image processing. Do you want to load the pasted image?",
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
async function readNativeClipboardImage() {
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

window.addEventListener("paste", async (e) => {
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
});

/** Paste handler: prefers native clipboard, falls back to `ClipboardEvent` items. */
async function pasteImageFromClipboard() {
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

document.querySelectorAll('a[target="_blank"]').forEach((link) => {
  link.addEventListener("click", (e) => {
    if (window.pywebview?.api?.open_external) {
      e.preventDefault();
      openExternalUrl(link.href);
    }
  });
});

// Menu bar & keyboard shortcut command bridge (also invoked by pywebview native menus)
/** Closes every open in-app menu dropdown. */
function closeAllMenus() {
  dom.menuBar?.querySelectorAll(".menu-root.open").forEach((m) => {
    m.classList.remove("open");
  });
}

/**
 * Pulls image paths handed over by the OS (argv, Finder "Open With", Dock drops)
 * from the native bridge and loads them. Called on startup, on a poll interval,
 * and pushed by the backend whenever a new open-request arrives while running.
 */
async function pullPendingFiles() {
  try {
    let res = null;
    if (window.pywebview?.api?.take_pending_files) {
      // The bridge drains the same Python queue as the HTTP endpoint, so an
      // empty bridge answer is definitive; no redundant POST needed.
      res = await window.pywebview.api.take_pending_files();
    } else {
      const httpRes = await apiFetch("/api/pending-files", { method: "POST" });
      if (httpRes.ok) res = await httpRes.json();
    }
    if (res?.error) {
      setError(res.error);
      return;
    }
    const files = await filesFromDialogResult(res);
    if (!files.length) return;
    if (state.isProcessing) cancelProcessing();
    if (files.length > 1) {
      openMultiFileChooser(files, "SELECTED");
    } else {
      ingestImageFile(files[0]);
    }
  } catch (err) {
    console.warn("[OpenBGR] Failed to pull pending files:", err);
  }
}

window.openBGR = {
  pullPendingFiles: () => pullPendingFiles(),
  newTab: () => {
    if (!getActiveTab()) return;
    if (state.isProcessing) {
      openConfirmModal(
        {
          title: "STOP CURRENT IMAGE?",
          message: "Opening a new tab will stop the current image processing.",
          confirmText: "STOP & OPEN TAB",
          cancelText: "KEEP PROCESSING",
        },
        () => {
          cancelProcessing();
          createBlankTab();
        }
      );
      return;
    }
    createBlankTab();
  },
  openImage: () => requestOpenImage(),
  startBatch: () => requestBatch(),
  exportImage: () => {
    if (state.resultBlob && !state.isProcessing) exportActiveImage();
  },
  copyImage: () => {
    if (state.resultBlob && !state.isProcessing) copyActiveCutout();
  },
  closeActiveTab: () => {
    if (state.activeTabId) requestCloseTab(state.activeTabId);
  },
  switchToTabAt: (n) => {
    const tabs = state.tabs;
    const target = n === 9 ? tabs[tabs.length - 1] : tabs[n - 1];
    if (target && target.id !== state.activeTabId) requestSwitchToTab(target.id);
  },
  switchTabOffset: (delta) => {
    const tabs = state.tabs;
    const idx = tabs.findIndex((t) => t.id === state.activeTabId);
    if (idx < 0 || tabs.length < 2) return;
    const next = tabs[(idx + delta + tabs.length) % tabs.length];
    requestSwitchToTab(next.id);
  },
  pasteImage: () => pasteImageFromClipboard(),
  restartApp: () => {
    window.pywebview?.api?.restart_app?.();
  },
  setView: (mode) => {
    if (state.resultBlob && ["split", "cutout", "original"].includes(mode)) {
      setViewMode(mode);
    }
  },
  zoomIn: () => {
    if (state.sourceFile) setZoom(state.zoom + 0.25);
  },
  zoomOut: () => {
    if (state.sourceFile) setZoom(state.zoom - 0.25);
  },
  zoomReset: () => {
    if (state.sourceFile) setZoom(1);
  },
  toggleLoupe: () => {
    if (state.sourceFile) toggleLoupe();
  },
  toggleTheme: () => {
    setPref("theme", prefs.theme === "light" ? "dark" : "light");
    applyPreferences(syncMenuBarState);
  },
  toggleFullscreen: () => {
    if (window.pywebview?.api?.toggle_fullscreen) {
      window.pywebview.api.toggle_fullscreen();
    } else if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch((err) => {
        console.warn("[OpenBGR] Fullscreen request failed:", err);
      });
    } else {
      document.exitFullscreen?.().catch((err) => {
        console.warn("[OpenBGR] Exiting fullscreen failed:", err);
      });
    }
  },
  selectPreset: (tierKey) => {
    const norm = normalizeTierKey(tierKey);
    if (TIER_KEYS.includes(norm) && norm !== state.tier) {
      selectTier(norm);
    }
  },
  toggleDefringe: () => dom.btnDefringe.click(),
  toggleDespill: () => dom.btnDespill?.click(),
  rerunSegmentation: () => {
    if (state.sourceFile && !state.isProcessing) runSegmentation();
  },
  cancelProcessing: () => {
    if (state.isProcessing) cancelProcessing();
  },
  openSettings: (section) => openPrefsDialog(section),
  openGithub: () => openExternalUrl("https://github.com/markoshaq/OpenBGR"),
  quitApp: () => {
    if (window.pywebview?.api?.quit) {
      window.pywebview.api.quit();
    } else {
      window.close();
    }
  },
};

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    hideTabContextMenu();
    if (dom.menuBar?.querySelector(".menu-root.open")) {
      closeAllMenus();
    } else if (dom.tierDropdown?.classList.contains("open")) {
      setTierDropdownOpen(false);
      dom.tierDropdownBtn?.focus();
    } else if (dom.infoModal.classList.contains("active")) {
      closePrefsDialog();
    } else if (dom.confirmModal.classList.contains("active")) {
      closeConfirmModal();
    } else if (state.isProcessing) {
      cancelProcessing();
    } else if (state.loupeEnabled) {
      toggleLoupe(false);
    }
    return;
  }

  if (e.key === "F11") {
    e.preventDefault();
    window.openBGR.toggleFullscreen();
    return;
  }

  // Plain keys are ignored inside form fields; modifier combos always work.
  if (
    e.target &&
    !e.metaKey &&
    !e.ctrlKey &&
    (e.target.tagName === "INPUT" ||
      e.target.tagName === "SELECT" ||
      e.target.tagName === "TEXTAREA" ||
      e.target.isContentEditable)
  ) {
    return;
  }

  if (e.metaKey || e.ctrlKey) {
    const sc = MOD_SHORTCUTS.find(
      (s) =>
        s.keys.includes(e.key.toLowerCase()) &&
        (s.shift === undefined || e.shiftKey === s.shift) &&
        (!s.bothMods || (e.metaKey && e.ctrlKey))
    );
    if (sc) {
      e.preventDefault();
      sc.run(e);
    }
    return;
  }

  if (e.code === "Space") {
    state.spacePressed = true;
  } else if (
    (e.key === "z" || e.key === "Z") &&
    !e.metaKey &&
    !e.ctrlKey &&
    state.sourceFile
  ) {
    toggleLoupe();
  } else if (
    !e.metaKey &&
    !e.ctrlKey &&
    !e.altKey &&
    ["1", "2", "3"].includes(e.key) &&
    state.resultBlob
  ) {
    window.openBGR.setView({ "1": "split", "2": "cutout", "3": "original" }[e.key]);
  }
});

window.addEventListener("keyup", (e) => {
  if (e.code === "Space") {
    state.spacePressed = false;
  }
});

/** Probes the OS clipboard for image content to gate Edit > Paste Image. */
async function refreshClipboardState() {
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
window.addEventListener("focus", refreshClipboardState);

/**
 * Cmd/Ctrl-modified keyboard shortcuts, matched on the lowercased `e.key`.
 * `shift` pins the required Shift state (undefined = ignored); `bothMods`
 * requires Cmd and Ctrl together (macOS fullscreen convention).
 */
const MOD_SHORTCUTS = [
  { keys: ["t"], run: () => window.openBGR.newTab() },
  { keys: ["o"], run: () => window.openBGR.openImage() },
  { keys: ["e", "s"], run: () => window.openBGR.exportImage() },
  { keys: ["w"], run: () => window.openBGR.closeActiveTab() },
  { keys: ["b"], run: () => window.openBGR.startBatch() },
  { keys: [","], run: () => window.openBGR.openSettings("preferences") },
  { keys: ["r"], run: () => window.openBGR.rerunSegmentation() },
  {
    keys: ["tab"],
    run: (e) => window.openBGR.switchTabOffset(e.shiftKey ? -1 : 1),
  },
  {
    keys: ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
    run: (e) => window.openBGR.switchToTabAt(Number(e.key)),
  },
  { keys: ["0"], run: () => window.openBGR.zoomReset() },
  { keys: ["=", "+"], run: () => window.openBGR.zoomIn() },
  { keys: ["-"], run: () => window.openBGR.zoomOut() },
  { keys: ["c"], shift: true, run: () => window.openBGR.copyImage() },
  {
    keys: ["f"],
    bothMods: true,
    run: () => window.openBGR.toggleFullscreen(),
  },
  { keys: ["q"], run: () => window.openBGR.quitApp() },
];

// In-app menu bar initialization
(function initStudioMenuBar() {
  if (!dom.menuBar) return;

  const isMac = /Mac|iPhone|iPad|iPod/i.test(
    navigator.platform || navigator.userAgent
  );
  if (!isMac) {
    dom.menuBar.querySelectorAll(".menu-kbd[data-shortcut]").forEach((el) => {
      const spec = el.getAttribute("data-shortcut") || "";
      el.textContent =
        spec === "Fullscreen"
          ? "F11"
          : spec
              .replace("Shift+Mod+", "Ctrl+Shift+")
              .replace("Mod+", "Ctrl+");
    });
    document.querySelectorAll("[data-shortcut-chip]").forEach((el) => {
      const spec = el.getAttribute("data-shortcut-chip") || "";
      el.textContent = spec
        .replace("Shift+Mod+", "CTRL+SHIFT+")
        .replace("Mod+", "CTRL+")
        .toUpperCase();
    });
  }

  const roots = Array.from(dom.menuBar.querySelectorAll(".menu-root"));
  roots.forEach((root) => {
    const trigger = root.querySelector(".menu-trigger");
    trigger?.addEventListener("click", (e) => {
      e.stopPropagation();
      const wasOpen = root.classList.contains("open");
      closeAllMenus();
      if (!wasOpen) {
        syncMenuBarState();
        refreshClipboardState();
        root.classList.add("open");
      }
    });
    trigger?.addEventListener("mouseenter", () => {
      const anyOpen = dom.menuBar.querySelector(".menu-root.open");
      if (anyOpen && anyOpen !== root) {
        closeAllMenus();
        syncMenuBarState();
        root.classList.add("open");
      }
    });
  });

  const dispatch = {
    newTab: () => window.openBGR.newTab(),
    openImage: () => window.openBGR.openImage(),
    batchProcess: () => window.openBGR.startBatch(),
    exportImage: () => window.openBGR.exportImage(),
    closeActiveTab: () => window.openBGR.closeActiveTab(),
    preferences: () => window.openBGR.openSettings("preferences"),
    about: () => window.openBGR.openSettings("about"),
    quitApp: () => window.openBGR.quitApp(),
    copyImage: () => window.openBGR.copyImage(),
    pasteImage: () => window.openBGR.pasteImage(),
    cancelProcessing: () => window.openBGR.cancelProcessing(),
    restartApp: () => window.openBGR.restartApp(),
    viewSplit: () => window.openBGR.setView("split"),
    viewCutout: () => window.openBGR.setView("cutout"),
    viewOriginal: () => window.openBGR.setView("original"),
    zoomIn: () => window.openBGR.zoomIn(),
    zoomOut: () => window.openBGR.zoomOut(),
    zoomReset: () => window.openBGR.zoomReset(),
    toggleLoupe: () => window.openBGR.toggleLoupe(),
    toggleTheme: () => window.openBGR.toggleTheme(),
    toggleFullscreen: () => window.openBGR.toggleFullscreen(),
    presetLite: () => window.openBGR.selectPreset("lite"),
    presetGeneral: () => window.openBGR.selectPreset("general"),
    presetHr: () => window.openBGR.selectPreset("hr"),
    presetPortrait: () => window.openBGR.selectPreset("portrait"),
    presetMatting: () => window.openBGR.selectPreset("matting"),
    presetDynamic: () => window.openBGR.selectPreset("dynamic"),
    toggleDefringe: () => window.openBGR.toggleDefringe(),
    toggleDespill: () => window.openBGR.toggleDespill(),
    rerun: () => window.openBGR.rerunSegmentation(),
    manageModels: () => window.openBGR.openSettings("models"),
    shortcuts: () => window.openBGR.openSettings("shortcuts"),
    openGithub: () => window.openBGR.openGithub(),
  };

  dom.menuBar.querySelectorAll(".menu-item").forEach((item) => {
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      if (item.classList.contains("disabled")) return;
      const cmd = item.getAttribute("data-cmd");
      closeAllMenus();
      dispatch[cmd]?.();
    });
  });

  window.addEventListener("click", closeAllMenus);
})();

// Startup initialization
initTooltips();
applyPreferences(syncMenuBarState);
syncFormatButtons();
applyBackdrop(state.activeBackdrop);
syncServerStatus(true, selectTier);

// Ingest OS-delivered files (Open With / argv / Dock drops) once the bridge is
// up, then keep polling so files sent to an already-running instance arrive
// too. In desktop mode the backend pushes new arrivals over evaluate_js, so
// the poll is only a safety net and can run slowly; in browser mode the poll
// is the only channel, so it stays quick.
pullPendingFiles();
setInterval(
  pullPendingFiles,
  window.pywebview?.api?.take_pending_files ? 10000 : 2000
);

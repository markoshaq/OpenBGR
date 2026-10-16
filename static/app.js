/**
 * OpenBGR — Frontend Entry Point
 * Wires DOM controls, pointer/keyboard gestures, clipboard and file dialogs,
 * the in-app menu bar, and the `window.openBGR` bridge for native OS menus.
 */

import {
  state,
  dom,
  prefs,
  savePrefs,
  getDefaultPrefs,
  getActiveTab,
  saveStateToActiveTab,
  setError,
  openConfirmModal,
  closeConfirmModal,
  triggerOpenFileDialog,
  base64ToBlob,
  filesFromDialogResult,
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
  exportActiveImage,
  copyActiveCutout,
} from "./export.js";
import {
  updateCacheIndicator,
  syncServerStatus,
  selectPrefsPane,
  openPrefsDialog,
  applyPreferences,
  uninstallModel,
  showModelContextMenu,
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
  ingestImageFile,
  setViewMode,
  selectTier,
  toggleLoupe,
  syncMenuBarState,
  cancelProcessing,
  runSegmentation,
} from "./tabs.js";

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
dom.btnInfoClose.addEventListener("click", () =>
  dom.infoModal.classList.remove("active")
);
dom.btnPrefsCloseX?.addEventListener("click", () =>
  dom.infoModal.classList.remove("active")
);
dom.infoModal.addEventListener("click", (e) => {
  if (e.target === dom.infoModal) dom.infoModal.classList.remove("active");
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
    prefs.confirmClose = state.confirmCloseTab;
    savePrefs();
    dom.btnToggleConfirmClose.classList.toggle("active", state.confirmCloseTab);
  });
}

dom.prefThemeDark?.addEventListener("click", () => {
  prefs.theme = "dark";
  savePrefs();
  applyPreferences(syncMenuBarState);
});
dom.prefThemeLight?.addEventListener("click", () => {
  prefs.theme = "light";
  savePrefs();
  applyPreferences(syncMenuBarState);
});
dom.prefDensityComfortable?.addEventListener("click", () => {
  prefs.density = "comfortable";
  savePrefs();
  applyPreferences(syncMenuBarState);
});
dom.prefDensityCompact?.addEventListener("click", () => {
  prefs.density = "compact";
  savePrefs();
  applyPreferences(syncMenuBarState);
});
dom.accentSwatches?.querySelectorAll(".swatch").forEach((sw) => {
  sw.addEventListener("click", () => {
    prefs.accent = sw.getAttribute("data-accent") || "default";
    savePrefs();
    applyPreferences(syncMenuBarState);
  });
});
dom.prefDefaultTier?.addEventListener("change", (e) => {
  prefs.defaultTier = e.target.value;
  savePrefs();
  if (!state.sourceFile) {
    const targetTier =
      prefs.defaultTier !== "auto"
        ? prefs.defaultTier
        : state.serverStatus?.recommended_tier || "mid";
    selectTier(targetTier);
  }
});
dom.prefDefaultFormat?.addEventListener("change", (e) => {
  prefs.defaultFormat = e.target.value;
  savePrefs();
  if (!state.resultBlob) {
    state.exportFormat = prefs.defaultFormat;
    updateExportTelemetry();
  }
});
dom.prefDefaultBackdrop?.addEventListener("change", (e) => {
  prefs.defaultBackdrop = e.target.value;
  savePrefs();
  if (!state.resultBlob) {
    applyBackdrop(prefs.defaultBackdrop);
  }
});
dom.btnResetPrefs?.addEventListener("click", () => {
  Object.assign(prefs, getDefaultPrefs());
  state.confirmCloseTab = prefs.confirmClose;
  savePrefs();
  applyPreferences(syncMenuBarState);
  if (!state.resultBlob) {
    state.exportFormat = prefs.defaultFormat;
    applyBackdrop(prefs.defaultBackdrop);
    selectTier(state.serverStatus?.recommended_tier || "mid");
    updateExportTelemetry();
  }
});

// Left sidebar: Hardware presets, Process button, Edge & Reflection toggles, Shadow Cutoff
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
});

dom.btnDespill?.addEventListener("click", () => {
  state.despill = !state.despill;
  dom.btnDespill.classList.toggle("active", state.despill);
  saveStateToActiveTab();
  syncMenuBarState();
});

dom.btnMatting?.addEventListener("click", () => {
  state.matting = !state.matting;
  dom.btnMatting.classList.toggle("active", state.matting);
  saveStateToActiveTab();
  syncMenuBarState();
});
dom.btnMatting?.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  e.stopPropagation();
  showModelContextMenu("matting", e.clientX, e.clientY);
});

dom.shadowCutoffSlider?.addEventListener("input", (e) => {
  state.shadowCutoff = parseInt(e.target.value || "0", 10);
  if (dom.shadowCutoffLabel) {
    dom.shadowCutoffLabel.textContent = `${state.shadowCutoff}%`;
  }
  updateLiveStagePreview();
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

dom.exportWidthInput.addEventListener("input", (e) => {
  const val = parseInt(e.target.value, 10);
  if (!val || val < 1) return;
  state.exportWidth = Math.min(16384, val);
  if (state.naturalWidth > 0 && state.naturalHeight > 0) {
    state.exportScale = state.exportWidth / state.naturalWidth;
    state.exportHeight = Math.max(
      1,
      Math.round(state.naturalHeight * state.exportScale)
    );
    dom.exportHeightInput.value = String(state.exportHeight);
  }
  updateExportTelemetry();
});

dom.exportHeightInput.addEventListener("input", (e) => {
  const val = parseInt(e.target.value, 10);
  if (!val || val < 1) return;
  state.exportHeight = Math.min(16384, val);
  if (state.naturalWidth > 0 && state.naturalHeight > 0) {
    state.exportScale = state.exportHeight / state.naturalHeight;
    state.exportWidth = Math.max(
      1,
      Math.round(state.naturalWidth * state.exportScale)
    );
    dom.exportWidthInput.value = String(state.exportWidth);
  }
  updateExportTelemetry();
});

dom.btnDownload.addEventListener("click", () => {
  const activeTab = getActiveTab();
  if (activeTab?.kind === "batch") {
    runBatch(activeTab);
    return;
  }
  exportActiveImage();
});

dom.btnCopy.addEventListener("click", copyActiveCutout);

// Matte backdrop swatches & custom color picker
document.querySelectorAll(".swatch[data-bg]").forEach((swatch) => {
  swatch.addEventListener("click", () => {
    applyBackdrop(swatch.getAttribute("data-bg") || "checker");
    saveStateToActiveTab();
  });
});

document.getElementById("colorPicker").addEventListener("input", (e) => {
  applyBackdrop(e.target.value);
  e.target.classList.add("active");
  saveStateToActiveTab();
});

// Viewport wheel zoom, pan, split drag, and loupe tracking
dom.viewport.addEventListener(
  "wheel",
  (e) => {
    if (!state.sourceFile) return;
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.2 : -0.2;
    setZoom(state.zoom + delta);
    renderLoupeAtPointer(e.clientX, e.clientY);
  },
  { passive: false }
);

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
async function openImageDialog() {
  if (window.pywebview?.api?.open_image_dialog) {
    try {
      const res = await window.pywebview.api.open_image_dialog();
      if (res?.error) {
        setError(res.error);
        return;
      }
      const files = filesFromDialogResult(res);
      if (files.length > 1) {
        openMultiFileChooser(files, "SELECTED");
      } else if (files.length === 1) {
        ingestImageFile(files[0]);
      }
      return;
    } catch (_) {}
  }
  triggerOpenFileDialog();
}

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
  const files = Array.from(e.target.files || []);
  const expecting = state.expectingBatch;
  state.expectingBatch = false;
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

window.addEventListener("dragover", (e) => {
  e.preventDefault();
  dom.viewport.classList.add("dragover");
});

window.addEventListener("dragleave", () => {
  dom.viewport.classList.remove("dragover");
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

  const files = Array.from(e.dataTransfer?.files || []);
  if (files.length === 0) return;

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
  } catch (_) {}
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
function closeAllMenus() {
  dom.menuBar?.querySelectorAll(".menu-root.open").forEach((m) => {
    m.classList.remove("open");
  });
}

window.openBGR = {
  newTab: () => {
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
    if (!dom.btnDownload.classList.contains("disabled")) dom.btnDownload.click();
  },
  copyImage: () => {
    if (!dom.btnCopy.classList.contains("disabled")) dom.btnCopy.click();
  },
  closeActiveTab: () => {
    if (state.activeTabId) requestCloseTab(state.activeTabId);
  },
  pasteImage: () => pasteImageFromClipboard(),
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
    prefs.theme = prefs.theme === "light" ? "dark" : "light";
    savePrefs();
    applyPreferences(syncMenuBarState);
  },
  toggleFullscreen: () => {
    if (window.pywebview?.api?.toggle_fullscreen) {
      window.pywebview.api.toggle_fullscreen();
    } else if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  },
  selectPreset: (tierKey) => {
    if (["low", "mid", "high"].includes(tierKey) && tierKey !== state.tier) {
      selectTier(tierKey);
    }
  },
  toggleDefringe: () => dom.btnDefringe.click(),
  toggleDespill: () => dom.btnDespill?.click(),
  toggleMatting: () => dom.btnMatting?.click(),
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
    } else if (dom.infoModal.classList.contains("active")) {
      dom.infoModal.classList.remove("active");
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

  if (
    e.target &&
    (e.target.tagName === "INPUT" || e.target.tagName === "SELECT")
  ) {
    return;
  }

  if (e.metaKey || e.ctrlKey) {
    const key = e.key.toLowerCase();
    if (key === "t") {
      e.preventDefault();
      window.openBGR.newTab();
    } else if (key === "o") {
      e.preventDefault();
      window.openBGR.openImage();
    } else if (key === "e" || key === "s") {
      e.preventDefault();
      window.openBGR.exportImage();
    } else if (key === "w") {
      e.preventDefault();
      window.openBGR.closeActiveTab();
    } else if (key === "b") {
      e.preventDefault();
      window.openBGR.startBatch();
    } else if (key === ",") {
      e.preventDefault();
      window.openBGR.openSettings("preferences");
    } else if (key === "r") {
      e.preventDefault();
      window.openBGR.rerunSegmentation();
    } else if (key === "1") {
      e.preventDefault();
      window.openBGR.setView("split");
    } else if (key === "2") {
      e.preventDefault();
      window.openBGR.setView("cutout");
    } else if (key === "3") {
      e.preventDefault();
      window.openBGR.setView("original");
    } else if (key === "0") {
      e.preventDefault();
      window.openBGR.zoomReset();
    } else if (key === "=" || key === "+") {
      e.preventDefault();
      window.openBGR.zoomIn();
    } else if (key === "-") {
      e.preventDefault();
      window.openBGR.zoomOut();
    } else if (key === "c" && e.shiftKey) {
      e.preventDefault();
      window.openBGR.copyImage();
    } else if (key === "q") {
      e.preventDefault();
      window.openBGR.quitApp();
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
  }
});

window.addEventListener("keyup", (e) => {
  if (e.code === "Space") {
    state.spacePressed = false;
  }
});

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
    viewSplit: () => window.openBGR.setView("split"),
    viewCutout: () => window.openBGR.setView("cutout"),
    viewOriginal: () => window.openBGR.setView("original"),
    zoomIn: () => window.openBGR.zoomIn(),
    zoomOut: () => window.openBGR.zoomOut(),
    zoomReset: () => window.openBGR.zoomReset(),
    toggleLoupe: () => window.openBGR.toggleLoupe(),
    toggleTheme: () => window.openBGR.toggleTheme(),
    toggleFullscreen: () => window.openBGR.toggleFullscreen(),
    presetLow: () => window.openBGR.selectPreset("low"),
    presetMid: () => window.openBGR.selectPreset("mid"),
    presetHigh: () => window.openBGR.selectPreset("high"),
    toggleDefringe: () => window.openBGR.toggleDefringe(),
    toggleDespill: () => window.openBGR.toggleDespill(),
    toggleMatting: () => window.openBGR.toggleMatting(),
    rerun: () => window.openBGR.rerunSegmentation(),
    manageModels: () => window.openBGR.openSettings("models"),
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
applyPreferences(syncMenuBarState);
syncFormatButtons();
applyBackdrop(state.activeBackdrop);
syncServerStatus(true, selectTier);

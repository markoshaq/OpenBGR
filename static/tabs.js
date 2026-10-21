/**
 * Multi-tab workspace management, single-image ingestion, view/preset/menu
 * state synchronization, and single-image segmentation lifecycle.
 */

import {
  state,
  dom,
  prefs,
  apiFetch,
  masterCutoutImg,
  getActiveTab,
  defaultTierForNewTab,
  createByteSmoother,
  createTabRecord,
  nextClipboardName,
  revokeTabUrls,
  savePrefs,
  saveStateToActiveTab,
  setError,
  openConfirmModal,
  closeConfirmModal,
  normalizeTierKey,
  PRESET_NAMES,
  updateTierDownloadUI,
  clearTierDownloadProgress,
  formatDiskBytes,
  formatElapsed,
  clearResultState,
  isImageFile,
} from "./state.js";
import { renderStageGeometry, applyZoomTransform } from "./stage.js";
import {
  syncFormatButtons,
  updateDestUI,
  updateExportTelemetry,
  applyBackdrop,
  updateLiveStagePreview,
} from "./export.js";
import {
  updateCacheIndicator,
  syncServerStatus,
  isModelInstallInProgress,
} from "./preferences.js";
import {
  renderBatchPanel,
  syncBatchPanelChrome,
  mergeTabsIntoBatch,
  extractBatchItemToTab,
  moveBatchItemToBatch,
  showTabContextMenu,
} from "./batch.js";

let tabGhostEl = null;

/** Displays the drag-reorder ghost label while a tab is being dragged. */
export function showTabGhost(name) {
  if (!dom.tabBar) return;
  if (!tabGhostEl) {
    tabGhostEl = document.createElement("div");
    tabGhostEl.className = "tab-item tab-ghost";
    const s = document.createElement("span");
    s.className = "tab-title";
    tabGhostEl.appendChild(s);
  }
  tabGhostEl.querySelector(".tab-title").textContent = name;
  const addBtn = dom.tabBar.querySelector(".tab-add");
  dom.tabBar.insertBefore(tabGhostEl, addBtn);
}

/** Hides the tab drag ghost. */
export function hideTabGhost() {
  tabGhostEl?.remove();
  tabGhostEl = null;
}

/**
 * Builds one tab-strip element: title, close button, and the
 * click/close/context/drag handlers that merge, reorder, and move batch items.
 */
function buildTabElement(tab) {
  const isActive = tab.id === state.activeTabId;
  const tabEl = document.createElement("div");
  tabEl.className = `tab-item${isActive ? " active" : ""}${tab.kind === "batch" ? " batch-tab" : ""}`;
  tabEl.setAttribute("data-tab-id", tab.id);
  tabEl.setAttribute("role", "tab");
  tabEl.setAttribute("aria-selected", isActive ? "true" : "false");
  tabEl.title = tab.name;
  tabEl.draggable = true;

  const titleSpan = document.createElement("span");
  titleSpan.className = "tab-title";
  titleSpan.textContent =
    tab.kind === "batch" ? `${tab.name} (${tab.batchFiles.length})` : tab.name;

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "tab-close";
  closeBtn.title = "Close image tab";
  closeBtn.setAttribute("aria-label", `Close ${tab.name}`);
  closeBtn.textContent = "x";
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    requestCloseTab(tab.id);
  });

  tabEl.addEventListener("dragstart", (e) => {
    state.dragTabId = tab.id;
    e.dataTransfer.effectAllowed = "move";
    try {
      e.dataTransfer.setData("text/plain", tab.id);
    } catch (_) {}
  });
  tabEl.addEventListener("dragend", () => {
    state.dragTabId = null;
    dom.tabBar
      .querySelectorAll(".drop-target")
      .forEach((el) => el.classList.remove("drop-target"));
  });
  tabEl.addEventListener("dragover", (e) => {
    if (state.dragBatchItem) {
      if (state.dragBatchItem.tabId === tab.id) return;
      e.preventDefault();
      e.stopPropagation();
      if (tab.kind === "batch") {
        e.dataTransfer.dropEffect = "move";
        tabEl.classList.add("drop-target");
        hideTabGhost();
      } else {
        e.dataTransfer.dropEffect = "copy";
        const srcTab = state.tabs.find(
          (t) => t.id === state.dragBatchItem.tabId
        );
        showTabGhost(
          srcTab?.batchFiles[state.dragBatchItem.index]?.name || "image"
        );
      }
      return;
    }
    if (!state.dragTabId || state.dragTabId === tab.id) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    tabEl.classList.add("drop-target");
  });
  tabEl.addEventListener("dragleave", () => {
    tabEl.classList.remove("drop-target");
  });
  tabEl.addEventListener("drop", (e) => {
    if (!state.dragTabId && !state.dragBatchItem) return;
    e.preventDefault();
    e.stopPropagation();
    tabEl.classList.remove("drop-target");
    hideTabGhost();
    const item = state.dragBatchItem;
    if (item) {
      state.dragBatchItem = null;
      const src = state.tabs.find((t) => t.id === item.tabId);
      if (tab.kind === "batch") {
        moveBatchItemToBatch(item, tab);
      } else if (src) {
        extractBatchItemToTab(src, item.index);
      }
      return;
    }
    const srcId = state.dragTabId;
    state.dragTabId = null;
    if (srcId !== tab.id) mergeTabsIntoBatch(srcId, tab.id);
  });

  tabEl.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showTabContextMenu(tab, e.clientX, e.clientY, requestCloseTab);
  });

  tabEl.addEventListener("click", () => {
    requestSwitchToTab(tab.id);
  });

  tabEl.appendChild(titleSpan);
  tabEl.appendChild(closeBtn);
  return tabEl;
}

/** Re-renders the tab strip, wiring click/close/context/drag handlers per tab. */
export function renderTabBar() {
  if (!dom.tabBar) return;
  dom.tabBar.replaceChildren();

  if (state.tabs.length === 0) {
    dom.tabBar.classList.remove("visible");
    return;
  }

  dom.tabBar.classList.add("visible");
  state.tabs.forEach((tab) => dom.tabBar.appendChild(buildTabElement(tab)));

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "tab-add";
  addBtn.title = "New Tab";
  addBtn.textContent = "+";
  addBtn.addEventListener("click", () => {
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
  });
  dom.tabBar.appendChild(addBtn);
}

/** Switches to `tabId`, prompting first if an image is currently processing. */
export function requestSwitchToTab(tabId) {
  if (!tabId || tabId === state.activeTabId) return;
  const tab = state.tabs.find((t) => t.id === tabId);
  if (!tab) return;
  if (state.isProcessing) {
    openConfirmModal(
      {
        title: "STOP CURRENT IMAGE?",
        message: `Switching to "${tab.name}" will stop the current image processing.`,
        confirmText: "STOP & SWITCH",
        cancelText: "KEEP PROCESSING",
      },
      () => {
        cancelProcessing();
        switchToTab(tab.id);
      }
    );
    return;
  }
  switchToTab(tab.id);
}

/** Creates and switches to an empty tab. */
export function createBlankTab() {
  saveStateToActiveTab();

  const blankTab = createTabRecord({
    tier: defaultTierForNewTab(),
    shadowCutoff: 0,
    exportFormat: prefs.defaultFormat,
    exportScale: 1,
    activeBackdrop: prefs.defaultBackdrop,
  });

  state.tabs.push(blankTab);
  switchToTab(blankTab.id);
}

/** Closes a tab, prompting first when it holds an image or a non-empty batch. */
export function requestCloseTab(tabId) {
  const tab = state.tabs.find((t) => t.id === tabId);
  if (!tab) return;

  const hasContent =
    Boolean(tab.sourceFile) || (tab.kind === "batch" && tab.batchFiles.length);
  if (state.confirmCloseTab && hasContent) {
    openConfirmModal(
      {
        title: tab.kind === "batch" ? "CLOSE BATCH TAB?" : "CLOSE IMAGE TAB?",
        message:
          tab.kind === "batch"
            ? `Remove the batch queue with ${tab.batchFiles.length} image${tab.batchFiles.length === 1 ? "" : "s"}?`
            : `Remove "${tab.name}" from the viewer?`,
        confirmText: tab.kind === "batch" ? "CLOSE BATCH" : "CLOSE IMAGE",
        cancelText: "CANCEL",
      },
      () => closeTabImmediate(tabId)
    );
  } else {
    closeTabImmediate(tabId);
  }
}

/** Destroys a tab record, revoking its URLs and updating neighbors. */
export function closeTabImmediate(tabId) {
  const idx = state.tabs.findIndex((t) => t.id === tabId);
  if (idx === -1) return;

  const tab = state.tabs[idx];
  const wasActive = tab.id === state.activeTabId;

  if (wasActive && state.isProcessing) {
    if (state.abortController) {
      state.abortController.abort();
      state.abortController = null;
    }
    apiFetch("/api/cancel", { method: "POST" }).catch(() => {});
    state.isProcessing = false;
    dom.busyOverlay.classList.remove("active");
    stopJobProgressPolling();
    stopElapsedTicker();
  }

  revokeTabUrls(tab);

  if (tab.kind === "batch" && state.batch.running && state.batch.tabId === tabId) {
    state.batch.cancelled = true;
    if (state.abortController) {
      state.abortController.abort();
      state.abortController = null;
    }
    apiFetch("/api/cancel", { method: "POST" }).catch(() => {});
    state.isProcessing = false;
    dom.busyOverlay.classList.remove("active");
    stopJobProgressPolling();
  }

  state.tabs.splice(idx, 1);

  // Drop leftover blank stubs and collapse to the empty dropzone when no
  // content-bearing tab (image or batch) remains.
  if (!state.tabs.some((t) => t.sourceFile || t.kind === "batch")) {
    state.tabs = [];
    state.activeTabId = null;
    resetToEmptyWorkspace();
    renderTabBar();
    return;
  }

  if (wasActive) {
    const nextTab = state.tabs[Math.min(idx, state.tabs.length - 1)];
    state.activeTabId = null;
    switchToTab(nextTab.id);
  } else {
    renderTabBar();
  }
}

/** Tears all tabs down and returns to the splash/dropzone state. */
export function resetToEmptyWorkspace() {
  setError(null);
  state.sourceFile = null;
  state.originalObjectUrl = null;
  clearResultState();

  dom.stageSizerImg.removeAttribute("src");
  dom.beforeImg.removeAttribute("src");
  dom.afterImg.removeAttribute("src");
  masterCutoutImg.removeAttribute("src");

  dom.stage.classList.remove("visible");
  dom.emptyState.style.display = "";
  dom.batchPanel?.classList.remove("active");
  dom.appShell?.classList.remove("batch-active");

  dom.exportWidthInput.value = "";
  dom.exportHeightInput.value = "";
  if (dom.exportSizeLabel) dom.exportSizeLabel.textContent = "--";
  dom.statFile.textContent = "NONE";
  dom.statDim.textContent = "--";
  dom.statTime.textContent = "--";

  dom.btnDownload.classList.add("disabled");
  dom.btnCopy.classList.add("disabled");
  dom.appShell?.classList.add("no-image");
  dom.appShell?.classList.add("no-result");
  syncMenuBarState();
}

/** Switches the workspace to a tab, restoring its image, result, zoom, and mode. */
export async function switchToTab(tabId) {
  if (state.activeTabId && state.activeTabId !== tabId) {
    saveStateToActiveTab();
  }
  // Invalidate any debounced preview render still queued for the old tab so a
  // late canvas encode can't paint over the incoming tab's image.
  state.previewRenderToken++;

  const tab = state.tabs.find((t) => t.id === tabId);
  if (!tab) return;

  state.activeTabId = tab.id;
  state.sourceFile = tab.sourceFile;
  state.originalObjectUrl = tab.originalObjectUrl;
  state.resultBlob = tab.resultBlob;
  state.previewBlob = tab.previewBlob;
  state.previewSignature = tab.previewSignature ?? null;
  state.previewSource = tab.previewSource ?? null;
  state.resultObjectUrl = tab.resultObjectUrl;
  state.previewObjectUrl = tab.previewObjectUrl;
  state.naturalWidth = tab.naturalWidth;
  state.naturalHeight = tab.naturalHeight;
  state.tier = normalizeTierKey(tab.tier);
  state.defringe = tab.defringe;
  state.despill = tab.despill ?? true;
  state.refineJobId = tab.refineJobId ?? null;
  state.shadowCutoff = tab.shadowCutoff ?? 0;
  state.viewMode = tab.viewMode;
  state.splitPercent = tab.splitPercent;
  state.exportFormat = tab.exportFormat;
  state.outputDir = tab.outputDir || null;
  state.exportScale = tab.exportScale;
  state.exportWidth = tab.exportWidth;
  state.exportHeight = tab.exportHeight;
  state.activeBackdrop = tab.activeBackdrop;
  state.zoom = tab.zoom ?? 1;
  state.panX = tab.panX ?? 0;
  state.panY = tab.panY ?? 0;
  applyZoomTransform();

  renderTabBar();

  document.querySelectorAll("#tierSelector .tier-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-tier") === state.tier);
  });
  dom.btnDefringe.classList.toggle("active", state.defringe);
  dom.btnDespill?.classList.toggle("active", state.despill);
  if (dom.shadowCutoffSlider) {
    dom.shadowCutoffSlider.value = String(state.shadowCutoff);
  }
  if (dom.shadowCutoffLabel) {
    dom.shadowCutoffLabel.textContent = `${state.shadowCutoff}%`;
  }
  syncFormatButtons();
  updateDestUI();
  applyBackdrop(state.activeBackdrop);

  if (tab.kind === "batch") {
    updateExportTelemetry();
    renderBatchPanel(tab);
    dom.appShell?.classList.add("no-image");
    dom.appShell?.classList.add("no-result");
    dom.appShell?.classList.add("batch-active");
    dom.btnCopy.classList.add("disabled");
    dom.statFile.textContent = `BATCH - ${tab.batchFiles.length} FILE${tab.batchFiles.length === 1 ? "" : "S"}`;
    dom.statDim.textContent = "--";
    dom.statTime.textContent = tab.elapsedText || "--";
    dom.appShell?.classList.toggle(
      "batch-elapsed",
      Boolean(tab.elapsedText && tab.elapsedText !== "--")
    );
    syncMenuBarState();
    return;
  }
  dom.batchPanel?.classList.remove("active");
  dom.appShell?.classList.remove("batch-active");

  if (!tab.sourceFile) {
    resetToEmptyWorkspace();
    return;
  }

  dom.emptyState.style.display = "none";
  dom.stage.classList.add("visible");
  dom.beforeImg.onload = () => {
    // Guard: switching to a batch tab leaves this handler installed; a late
    // decode must not overwrite the batch view's statDim or global dims.
    if (state.activeTabId !== tab.id) return;
    if (dom.beforeImg.naturalWidth > 0 && dom.beforeImg.naturalHeight > 0) {
      if (!state.naturalWidth || !state.naturalHeight) {
        state.naturalWidth = dom.beforeImg.naturalWidth;
        state.naturalHeight = dom.beforeImg.naturalHeight;
        tab.naturalWidth = state.naturalWidth;
        tab.naturalHeight = state.naturalHeight;
      }
      dom.statDim.textContent = `${state.naturalWidth}x${state.naturalHeight} PX`;
    }
  };
  dom.stageSizerImg.src = state.originalObjectUrl;
  dom.beforeImg.src = state.originalObjectUrl;
  dom.statFile.textContent = tab.name.toUpperCase();
  dom.statDim.textContent =
    state.naturalWidth > 0 && state.naturalHeight > 0
      ? `${state.naturalWidth}x${state.naturalHeight} PX`
      : "--";
  dom.statTime.textContent = tab.elapsedText || "--";

  if (state.resultBlob && state.resultObjectUrl) {
    if (
      !masterCutoutImg.complete ||
      masterCutoutImg.currentSrc !== state.resultObjectUrl
    ) {
      await new Promise((resolve) => {
        masterCutoutImg.onload = resolve;
        masterCutoutImg.onerror = resolve;
        masterCutoutImg.src = state.resultObjectUrl;
      });
    }
    dom.afterImg.src = state.previewObjectUrl || state.resultObjectUrl;
    dom.appShell?.classList.remove("no-image");
    dom.appShell?.classList.remove("no-result");
    dom.btnDownload.classList.remove("disabled");
    dom.btnCopy.classList.remove("disabled");
    setViewMode(state.viewMode);
    updateExportTelemetry();
  } else {
    dom.afterImg.src = state.originalObjectUrl;
    // Release the previous tab's decoded cutout bitmap while this tab has
    // no result; it is re-decoded from resultObjectUrl on switch-back.
    masterCutoutImg.src = "about:blank";
    dom.appShell?.classList.remove("no-image");
    dom.appShell?.classList.add("no-result");
    dom.btnDownload.classList.add("disabled");
    dom.btnCopy.classList.add("disabled");
    setViewMode("original");
  }
  syncMenuBarState();
}

/** Loads a File/Blob into the current (or a new) tab and shows the loaded state. */
export function ingestImageFile(file) {
  if (!isImageFile(file)) {
    setError("Only image files can be processed.");
    return;
  }
  saveStateToActiveTab();

  const rawName = file.name || nextClipboardName();
  const objUrl = URL.createObjectURL(file);
  const currentTab = getActiveTab();

  if (currentTab && !currentTab.sourceFile && currentTab.kind !== "batch") {
    currentTab.name = rawName;
    currentTab.sourceFile = file;
    currentTab.originalObjectUrl = objUrl;
    currentTab.elapsedText = "READY";
  } else {
    const targetTab = createTabRecord({
      name: rawName,
      sourceFile: file,
      originalObjectUrl: objUrl,
      outputDir: state.outputDir || null,
      elapsedText: "READY",
    });
    state.tabs.push(targetTab);
    state.activeTabId = targetTab.id;
  }

  state.sourceFile = file;
  state.originalObjectUrl = objUrl;
  clearResultState();
  state.zoom = 1;
  state.panX = 0;
  state.panY = 0;
  applyZoomTransform();

  dom.appShell?.classList.remove("no-image");
  dom.appShell?.classList.add("no-result");
  dom.batchPanel?.classList.remove("active");
  dom.appShell?.classList.remove("batch-active");
  dom.btnDownload.classList.add("disabled");
  dom.btnCopy.classList.add("disabled");
  dom.exportWidthInput.value = "";
  dom.exportHeightInput.value = "";
  if (dom.exportSizeLabel) dom.exportSizeLabel.textContent = "--";

  dom.stageSizerImg.src = state.originalObjectUrl;
  const ingestedTab = getActiveTab();
  dom.beforeImg.onload = () => {
    // Stale-handler guard: if the user switched away (e.g. to a batch tab)
    // before the decode finished, this load no longer belongs to the view.
    if (!ingestedTab || state.activeTabId !== ingestedTab.id) return;
    if (dom.beforeImg.naturalWidth > 0 && dom.beforeImg.naturalHeight > 0) {
      state.naturalWidth = dom.beforeImg.naturalWidth;
      state.naturalHeight = dom.beforeImg.naturalHeight;
      dom.statDim.textContent = `${state.naturalWidth}x${state.naturalHeight} PX`;
      ingestedTab.naturalWidth = state.naturalWidth;
      ingestedTab.naturalHeight = state.naturalHeight;
    }
  };
  dom.beforeImg.src = state.originalObjectUrl;
  dom.afterImg.src = state.originalObjectUrl;

  dom.emptyState.style.display = "none";
  dom.stage.classList.add("visible");
  dom.statFile.textContent = rawName.toUpperCase();
  dom.statDim.textContent = "--";
  dom.statTime.textContent = "READY";

  renderTabBar();
  updateDestUI();
  setViewMode("original");
  syncMenuBarState();
}

/** Sets the active model key and syncs cards, menus, and the Settings default. */
export function selectTier(tierKey) {
  const norm = normalizeTierKey(tierKey);
  state.tier = norm;
  document.querySelectorAll("#tierSelector .tier-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-tier") === norm);
  });
  updateCacheIndicator();
  saveStateToActiveTab();
  syncMenuBarState();
}

/** Switches the stage between split / cutout / original modes. */
export function setViewMode(mode) {
  state.viewMode = mode;
  document.getElementById("viewSplit").classList.toggle("active", mode === "split");
  document.getElementById("viewCutout").classList.toggle("active", mode === "cutout");
  document.getElementById("viewOriginal").classList.toggle("active", mode === "original");
  renderStageGeometry();
  saveStateToActiveTab();
  syncMenuBarState();
}

/** Toggles (or forces) the 4x magnifier loupe. */
export function toggleLoupe(forceState) {
  state.loupeEnabled =
    typeof forceState === "boolean" ? forceState : !state.loupeEnabled;
  dom.btnLoupe?.classList.toggle("active", state.loupeEnabled);
  dom.stage?.classList.toggle("loupe-active", state.loupeEnabled);
  if (!state.loupeEnabled) {
    dom.loupeCanvas?.classList.remove("visible");
  }
  syncMenuBarState();
}

/** Enables/disables the in-app menu bar items for the current workspace state. */
export function syncMenuBarState() {
  if (!dom.menuBar) return;
  const activeTabNow = getActiveTab();
  const hasTab = Boolean(state.activeTabId);
  const hasImage = Boolean(state.sourceFile);
  const hasResult = Boolean(state.resultBlob);
  const isBusy = Boolean(state.isProcessing);
  const isBatch = activeTabNow?.kind === "batch";

  dom.menuBar.querySelectorAll(".menu-item").forEach((item) => {
    const req = item.getAttribute("data-requires");
    let enabled = true;
    if (req === "tab") enabled = hasTab;
    else if (req === "image") enabled = hasImage;
    else if (req === "result") enabled = hasResult && !isBusy;
    else if (req === "processing") enabled = isBusy;
    else if (req === "image-idle") enabled = hasImage && !isBusy;
    else if (req === "native") enabled = Boolean(window.pywebview?.api);
    else if (req === "paste-image") {
      enabled = state.clipboardHasImage !== false;
    } else if (req === "model-controls") {
      enabled = (hasImage || isBatch) && !isBusy;
    }
    item.classList.toggle("disabled", !enabled);

    const checkKey = item.getAttribute("data-check");
    const checkSpan = item.querySelector(".menu-check");
    if (checkKey && checkSpan) {
      let checked = false;
      if (checkKey === "view:split") checked = state.viewMode === "split";
      else if (checkKey === "view:cutout") checked = state.viewMode === "cutout";
      else if (checkKey === "view:original") checked = state.viewMode === "original";
      else if (checkKey === "loupe") checked = state.loupeEnabled;
      else if (checkKey === "theme:light") checked = prefs.theme === "light";
      else if (checkKey.startsWith("tier:")) {
        checked = state.tier === checkKey.slice(5);
      } else if (checkKey === "defringe") checked = state.defringe;
      else if (checkKey === "despill") checked = state.despill;
      checkSpan.textContent = checked ? "✓" : "";
    }
  });

  dom.appShell?.classList.toggle("is-processing", isBusy);

  if (dom.btnProcess) {
    dom.btnProcess.classList.toggle("disabled", !hasImage || isBusy);
    dom.btnProcess.textContent = isBusy
      ? "PROCESSING…"
      : hasResult
        ? "REPROCESS IMAGE"
        : "PROCESS IMAGE";
  }

  // Chrome only: counters/disabled flags, not a rebuild of every queue row.
  if (activeTabNow?.kind === "batch") syncBatchPanelChrome(activeTabNow);
}

/** Aborts the in-flight segmentation fetch and tells the server to drop the job. */
export function cancelProcessing() {
  if (state.batch.running) {
    state.batch.cancelled = true;
  }
  if (state.abortController) {
    state.abortController.abort();
    state.abortController = null;
  }
  apiFetch("/api/cancel", { method: "POST" }).catch(() => {});
  state.isProcessing = false;
  dom.busyOverlay.classList.remove("active");
  stopJobProgressPolling();
  closeConfirmModal();
  const elapsedMs = stopElapsedTicker();
  dom.statTime.textContent =
    elapsedMs != null ? `CANCELLED - ${formatElapsed(elapsedMs)}` : "CANCELLED";

  if (!state.resultBlob && state.sourceFile) {
    setViewMode("original");
  }
  saveStateToActiveTab();
  syncMenuBarState();
}

let jobProgressTimer = null;
let inferPhaseStartedAt = 0;
let elapsedTimer = null;
let elapsedStartedAt = 0;

/** Starts the live elapsed timer on the busy-overlay sub-line. */
function startElapsedTicker() {
  stopElapsedTicker();
  elapsedStartedAt = performance.now();
  dom.busySub.textContent = formatElapsed(0);
  elapsedTimer = setInterval(() => {
    // The download-phase progress text owns busySub; don't fight it.
    if (downloadKey == null) {
      dom.busySub.textContent = formatElapsed(
        performance.now() - elapsedStartedAt
      );
    }
  }, 250);
}

/** Stops the ELAPSED ticker; returns ms elapsed, or null if it wasn't running. */
function stopElapsedTicker() {
  if (!elapsedTimer) return null;
  clearInterval(elapsedTimer);
  elapsedTimer = null;
  return performance.now() - elapsedStartedAt;
}

/** True while the job poller reports the model-weights download phase. */
export function isModelDownloadActive() {
  return downloadKey != null;
}
let byteSmoother = createByteSmoother();
let downloadPeak = 0;
let downloadKey = null;

/** Sets the busy-overlay bar to a determinate percent, or back to indeterminate. */
function setBusyProgress(pct) {
  const fill = dom.busyProgressFill;
  if (!fill) return;
  const bar = fill.parentElement;
  if (pct == null) {
    bar?.classList.remove("determinate");
    fill.style.width = "0";
    return;
  }
  bar?.classList.add("determinate");
  fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
}

/** Polls `/api/progress` so the busy overlay tracks download/load/inference stages. */
async function pollJobProgress() {
  try {
    const res = await apiFetch("/api/progress");
    if (!res.ok) return;
    const p = await res.json();
    if (!state.isProcessing) return;
    const modelKey = p.model_key || state.tier;
    if (p.phase !== "download") {
      byteSmoother = createByteSmoother();
      downloadPeak = 0;
      if (downloadKey) {
        clearTierDownloadProgress(downloadKey);
        downloadKey = null;
      }
    }

    if (p.phase === "download") {
      inferPhaseStartedAt = 0;
      const dl = Number(p.downloaded_bytes) || 0;
      const tot = Number(p.total_bytes) || 0;
      const modelName = PRESET_NAMES[modelKey] || "MODEL";
      const shown = Math.max(byteSmoother(dl, tot), downloadPeak);
      downloadPeak = shown;
      const expectedBytes =
        Number(state.serverStatus?.tiers?.[modelKey]?.expected_bytes) || 0;
      downloadKey = modelKey;
      dom.busyTitle.textContent = "DOWNLOADING MODEL WEIGHTS";
      dom.busySub.textContent =
        tot > 0
          ? `${formatDiskBytes(shown, true)} / ${formatDiskBytes(tot, true)} - ${modelName}`
          : `${formatDiskBytes(shown, true)} downloaded - ${modelName}`;
      setBusyProgress(tot > 0 ? (shown / tot) * 100 : null);
      updateTierDownloadUI(modelKey, shown, tot, expectedBytes);
    } else if (p.phase === "load") {
      // Model is cached and being restored into device memory; present this
      // as part of "processing", not a separate user-facing stage.
      inferPhaseStartedAt = 0;
      if (!state.batch.running) {
        dom.busyTitle.textContent = "PROCESSING IMAGE";
      }
      setBusyProgress(null);
    } else if (p.phase === "inference") {
      if (!inferPhaseStartedAt) inferPhaseStartedAt = performance.now();
      const est = Number(prefs.inferEstimates?.[modelKey]) || 4000;
      const elapsed = performance.now() - inferPhaseStartedAt;
      if (!state.batch.running) {
        dom.busyTitle.textContent = "PROCESSING IMAGE";
      }
      setBusyProgress(Math.min(97, (elapsed / (elapsed + est * 0.6)) * 100));
    }
  } catch (_) {}
}

/** Starts polling job progress while the busy overlay is visible. */
export function startJobProgressPolling() {
  stopJobProgressPolling();
  setBusyProgress(null);
  jobProgressTimer = setInterval(pollJobProgress, 250);
}

/** Stops progress polling and resets the overlay bar to indeterminate. */
export function stopJobProgressPolling() {
  if (jobProgressTimer) {
    clearInterval(jobProgressTimer);
    jobProgressTimer = null;
  }
  inferPhaseStartedAt = 0;
  byteSmoother = createByteSmoother();
  downloadPeak = 0;
  if (downloadKey) {
    clearTierDownloadProgress(downloadKey);
    downloadKey = null;
  }
  setBusyProgress(null);
}

/** POSTs the active image to `/api/remove-bg` and applies the returned cutout + job id. */
export async function runSegmentation() {
  if (!state.sourceFile) return;
  if (isModelInstallInProgress()) {
    setError(
      "A model download is in progress. Wait for it to finish before processing."
    );
    return;
  }

  const tierInfo = state.serverStatus?.tiers?.[state.tier];
  if (tierInfo && !tierInfo.cached && !navigator.onLine) {
    setError("Selected model is not cached on disk and device is currently offline.");
    return;
  }

  if (state.abortController) {
    state.abortController.abort();
    apiFetch("/api/cancel", { method: "POST" }).catch(() => {});
  }
  const controller = new AbortController();
  state.abortController = controller;
  state.isProcessing = true;

  if (!state.resultBlob) {
    dom.appShell?.classList.add("no-result");
  }
  setError(null);
  dom.busyOverlay.classList.add("active");
  startJobProgressPolling();
  startElapsedTicker();
  syncMenuBarState();

  const isCached = tierInfo ? tierInfo.cached : true;

  dom.busyTitle.textContent = isCached
    ? "PROCESSING IMAGE"
    : "PROCESSING IMAGE - FETCHING MODEL WEIGHTS";

  const formData = new FormData();
  formData.append("file", state.sourceFile);
  formData.append("tier", state.tier);
  formData.append("defringe", state.defringe ? "true" : "false");
  formData.append("despill", state.despill ? "true" : "false");

  try {
    const response = await apiFetch("/api/remove-bg", {
      method: "POST",
      body: formData,
      signal: controller.signal,
    });

    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const errPayload = await response.json();
        if (errPayload.detail) detail = errPayload.detail;
      } catch (_) {}
      throw new Error(detail);
    }

    const inferenceMs = parseFloat(
      response.headers.get("X-Inference-Time-Ms") || "0"
    );
    if (inferenceMs > 0) {
      prefs.inferEstimates = prefs.inferEstimates || {};
      prefs.inferEstimates[state.tier] = inferenceMs;
      savePrefs();
    }
    const width = parseInt(response.headers.get("X-Image-Width") || "0", 10);
    const height = parseInt(response.headers.get("X-Image-Height") || "0", 10);
    const jobId = parseInt(
      response.headers.get("X-Refine-Job-Id") || "0",
      10
    );

    const blob = await response.blob();
    if (controller.signal.aborted) return;

    state.resultBlob = blob;
    state.refineJobId = jobId || null;
    state.naturalWidth = width;
    state.naturalHeight = height;
    state.exportWidth = Math.max(1, Math.round(width * state.exportScale));
    state.exportHeight = Math.max(1, Math.round(height * state.exportScale));

    if (
      state.previewObjectUrl &&
      state.previewObjectUrl !== state.resultObjectUrl
    ) {
      URL.revokeObjectURL(state.previewObjectUrl);
    }
    state.previewBlob = null;
    state.previewObjectUrl = null;
    if (state.resultObjectUrl) {
      URL.revokeObjectURL(state.resultObjectUrl);
    }
    state.resultObjectUrl = URL.createObjectURL(state.resultBlob);

    await new Promise((resolve) => {
      masterCutoutImg.onload = resolve;
      masterCutoutImg.onerror = resolve;
      masterCutoutImg.src = state.resultObjectUrl;
    });

    dom.appShell?.classList.remove("no-result");
    dom.btnDownload.classList.remove("disabled");
    dom.btnCopy.classList.remove("disabled");

    updateExportTelemetry();
    const finishedMs = stopElapsedTicker();
    dom.statTime.textContent =
      finishedMs != null ? formatElapsed(finishedMs) : "DONE";

    setViewMode("split");
    saveStateToActiveTab();
    syncServerStatus(false);
  } catch (err) {
    if (err.name === "AbortError") return;
    stopElapsedTicker();
    setError(err.message || "Failed to process image.");
    dom.statTime.textContent = "ERROR";
  } finally {
    if (state.abortController === controller) {
      state.isProcessing = false;
      state.abortController = null;
      dom.busyOverlay.classList.remove("active");
      stopJobProgressPolling();
      stopElapsedTicker();
      closeConfirmModal();
      if (state.resultBlob) {
        dom.appShell?.classList.remove("no-result");
      }
      syncMenuBarState();
    } else if (!state.abortController) {
      // The job was cancelled or its tab closed without a replacement run
      // taking over: kill the orphaned poller and ticker instead of letting
      // them fire every 250 ms forever.
      stopJobProgressPolling();
      stopElapsedTicker();
    }
  }
}

/**
 * Re-applies the edge-refinement filters (DEFRINGE / SUPPRESS COLOR SPILL) on
 * the server-side cached raw RGB + alpha of the last job: a pure NumPy
 * post-processing pass (~20 ms), no neural-network re-inference required.
 * No-ops when the active tab has no fresh cutout job on the server.
 */
export async function applyEdgeRefinement() {
  const tab = getActiveTab();
  if (
    !tab ||
    tab.kind === "batch" ||
    !state.refineJobId ||
    !state.resultBlob ||
    state.isProcessing
  ) {
    return;
  }

  // Coalesce rapid toggle clicks: while a request is in flight, only the
  // latest flag state is rendered (one extra request) instead of queueing
  // one server-side compose per click.
  if (state.refineInFlight) {
    state.refinePending = true;
    return;
  }
  state.refineInFlight = true;
  try {
    do {
      state.refinePending = false;
      if (
        !state.refineJobId ||
        !state.resultBlob ||
        state.isProcessing ||
        getActiveTab()?.kind === "batch"
      ) {
        break;
      }
      const token = ++state.refineToken;
      const fd = new FormData();
      fd.append("job_id", String(state.refineJobId));
      fd.append("defringe", state.defringe ? "true" : "false");
      fd.append("despill", state.despill ? "true" : "false");

      try {
        const response = await apiFetch("/api/refine", {
          method: "POST",
          body: fd,
        });
        if (!response.ok) {
          if (response.status === 409 && token === state.refineToken) {
            dom.statTime.textContent = "REPROCESS TO APPLY";
          }
          continue;
        }

        const blob = await response.blob();
        if (token !== state.refineToken) continue;

        state.resultBlob = blob;
        state.previewBlob = null;
        if (
          state.previewObjectUrl &&
          state.previewObjectUrl !== state.resultObjectUrl
        ) {
          URL.revokeObjectURL(state.previewObjectUrl);
        }
        state.previewObjectUrl = null;
        if (state.resultObjectUrl) {
          URL.revokeObjectURL(state.resultObjectUrl);
        }
        state.resultObjectUrl = URL.createObjectURL(blob);

        await new Promise((resolve) => {
          masterCutoutImg.onload = resolve;
          masterCutoutImg.onerror = resolve;
          masterCutoutImg.src = state.resultObjectUrl;
        });
        if (token !== state.refineToken) continue;

        updateLiveStagePreview();
        saveStateToActiveTab();
      } catch (_) {}
    } while (state.refinePending);
  } finally {
    state.refineInFlight = false;
  }
}

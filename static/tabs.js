/**
 * Multi-tab workspace management, single-image ingestion, view/preset/menu
 * state synchronization, and single-image segmentation lifecycle.
 */

import {
  state,
  dom,
  prefs,
  masterCutoutImg,
  getActiveTab,
  defaultTierForNewTab,
  createTabRecord,
  nextClipboardName,
  revokeTabUrls,
  saveStateToActiveTab,
  setError,
  openConfirmModal,
  closeConfirmModal,
  PRESET_NAMES,
} from "./state.js";
import { renderStageGeometry, applyZoomTransform } from "./stage.js";
import {
  syncFormatButtons,
  updateDestUI,
  updateExportTelemetry,
  applyBackdrop,
} from "./export.js";
import { updateCacheIndicator, syncServerStatus } from "./preferences.js";
import {
  renderBatchPanel,
  mergeTabsIntoBatch,
  extractBatchItemToTab,
  moveBatchItemToBatch,
  showTabContextMenu,
} from "./batch.js";

let tabGhostEl = null;

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

export function hideTabGhost() {
  tabGhostEl?.remove();
  tabGhostEl = null;
}

export function renderTabBar() {
  if (!dom.tabBar) return;
  dom.tabBar.innerHTML = "";

  if (state.tabs.length === 0) {
    dom.tabBar.classList.remove("visible");
    return;
  }

  dom.tabBar.classList.add("visible");

  state.tabs.forEach((tab) => {
    const tabEl = document.createElement("div");
    tabEl.className = `tab-item${tab.id === state.activeTabId ? " active" : ""}${tab.kind === "batch" ? " batch-tab" : ""}`;
    tabEl.setAttribute("data-tab-id", tab.id);
    tabEl.title = tab.name;
    tabEl.draggable = true;

    const titleSpan = document.createElement("span");
    titleSpan.className = "tab-title";
    titleSpan.textContent =
      tab.kind === "batch" ? `BATCH (${tab.batchFiles.length})` : tab.name;

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "tab-close";
    closeBtn.title = "Close image tab";
    closeBtn.textContent = "×";
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
      if (tab.id === state.activeTabId) return;
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
    });

    tabEl.appendChild(titleSpan);
    tabEl.appendChild(closeBtn);
    dom.tabBar.appendChild(tabEl);
  });

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
    fetch("/api/cancel", { method: "POST" }).catch(() => {});
    state.isProcessing = false;
    dom.busyOverlay.classList.remove("active");
  }

  revokeTabUrls(tab);

  if (tab.kind === "batch" && state.batch.running && state.batch.tabId === tabId) {
    state.batch.cancelled = true;
    if (state.abortController) {
      state.abortController.abort();
      state.abortController = null;
    }
    fetch("/api/cancel", { method: "POST" }).catch(() => {});
    state.isProcessing = false;
    dom.busyOverlay.classList.remove("active");
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

export function resetToEmptyWorkspace() {
  setError(null);
  state.sourceFile = null;
  state.resultBlob = null;
  state.previewBlob = null;
  state.originalObjectUrl = null;
  state.resultObjectUrl = null;
  state.previewObjectUrl = null;
  state.naturalWidth = 0;
  state.naturalHeight = 0;
  state.exportWidth = 0;
  state.exportHeight = 0;

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
  dom.statFile.textContent = "NONE";
  dom.statDim.textContent = "—";
  dom.statTime.textContent = "—";

  dom.btnDownload.classList.add("disabled");
  dom.btnCopy.classList.add("disabled");
  dom.appShell?.classList.add("no-image");
  dom.appShell?.classList.add("no-result");
  syncMenuBarState();
}

export async function switchToTab(tabId) {
  if (state.activeTabId && state.activeTabId !== tabId) {
    saveStateToActiveTab();
  }

  const tab = state.tabs.find((t) => t.id === tabId);
  if (!tab) return;

  state.activeTabId = tab.id;
  state.sourceFile = tab.sourceFile;
  state.originalObjectUrl = tab.originalObjectUrl;
  state.resultBlob = tab.resultBlob;
  state.previewBlob = tab.previewBlob;
  state.resultObjectUrl = tab.resultObjectUrl;
  state.previewObjectUrl = tab.previewObjectUrl;
  state.naturalWidth = tab.naturalWidth;
  state.naturalHeight = tab.naturalHeight;
  state.tier = tab.tier;
  state.defringe = tab.defringe;
  state.despill = tab.despill ?? true;
  state.matting = tab.matting ?? false;
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
  dom.btnMatting?.classList.toggle("active", state.matting);
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
    renderBatchPanel(tab);
    dom.appShell?.classList.add("no-image");
    dom.appShell?.classList.add("no-result");
    dom.appShell?.classList.add("batch-active");
    dom.btnCopy.classList.add("disabled");
    dom.statFile.textContent = `BATCH · ${tab.batchFiles.length} FILE${tab.batchFiles.length === 1 ? "" : "S"}`;
    dom.statDim.textContent = "—";
    dom.statTime.textContent = tab.elapsedText || "—";
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
    if (dom.beforeImg.naturalWidth > 0 && dom.beforeImg.naturalHeight > 0) {
      if (!state.naturalWidth || !state.naturalHeight) {
        state.naturalWidth = dom.beforeImg.naturalWidth;
        state.naturalHeight = dom.beforeImg.naturalHeight;
        tab.naturalWidth = state.naturalWidth;
        tab.naturalHeight = state.naturalHeight;
      }
      dom.statDim.textContent = `${state.naturalWidth}×${state.naturalHeight} PX`;
    }
  };
  dom.stageSizerImg.src = state.originalObjectUrl;
  dom.beforeImg.src = state.originalObjectUrl;
  dom.statFile.textContent = tab.name.toUpperCase();
  dom.statDim.textContent =
    state.naturalWidth > 0 && state.naturalHeight > 0
      ? `${state.naturalWidth}×${state.naturalHeight} PX`
      : "—";
  dom.statTime.textContent = tab.elapsedText || "—";

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
    dom.appShell?.classList.remove("no-image");
    dom.appShell?.classList.add("no-result");
    dom.btnDownload.classList.add("disabled");
    dom.btnCopy.classList.add("disabled");
    setViewMode("original");
  }
  syncMenuBarState();
}

export function ingestImageFile(file) {
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
  state.resultBlob = null;
  state.previewBlob = null;
  state.resultObjectUrl = null;
  state.previewObjectUrl = null;
  state.naturalWidth = 0;
  state.naturalHeight = 0;
  state.exportWidth = 0;
  state.exportHeight = 0;
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

  dom.stageSizerImg.src = state.originalObjectUrl;
  dom.beforeImg.onload = () => {
    if (dom.beforeImg.naturalWidth > 0 && dom.beforeImg.naturalHeight > 0) {
      state.naturalWidth = dom.beforeImg.naturalWidth;
      state.naturalHeight = dom.beforeImg.naturalHeight;
      dom.statDim.textContent = `${state.naturalWidth}×${state.naturalHeight} PX`;
      const active = getActiveTab();
      if (active && active.kind !== "batch") {
        active.naturalWidth = state.naturalWidth;
        active.naturalHeight = state.naturalHeight;
      }
    }
  };
  dom.beforeImg.src = state.originalObjectUrl;
  dom.afterImg.src = state.originalObjectUrl;

  dom.emptyState.style.display = "none";
  dom.stage.classList.add("visible");
  dom.statFile.textContent = rawName.toUpperCase();
  dom.statDim.textContent = "—";
  dom.statTime.textContent = "READY";

  renderTabBar();
  updateDestUI();
  setViewMode("original");
  syncMenuBarState();
}

export function selectTier(tierKey) {
  state.tier = tierKey;
  document.querySelectorAll("#tierSelector .tier-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-tier") === tierKey);
  });
  updateCacheIndicator();
  saveStateToActiveTab();
  syncMenuBarState();
}

export function setViewMode(mode) {
  state.viewMode = mode;
  document.getElementById("viewSplit").classList.toggle("active", mode === "split");
  document.getElementById("viewCutout").classList.toggle("active", mode === "cutout");
  document.getElementById("viewOriginal").classList.toggle("active", mode === "original");
  renderStageGeometry();
  saveStateToActiveTab();
  syncMenuBarState();
}

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

export function syncMenuBarState() {
  if (!dom.menuBar) return;
  const hasTab = Boolean(state.activeTabId);
  const hasImage = Boolean(state.sourceFile);
  const hasResult = Boolean(state.resultBlob);
  const isBusy = Boolean(state.isProcessing);

  dom.menuBar.querySelectorAll(".menu-item").forEach((item) => {
    const req = item.getAttribute("data-requires");
    let enabled = true;
    if (req === "tab") enabled = hasTab;
    else if (req === "image") enabled = hasImage;
    else if (req === "result") enabled = hasResult && !isBusy;
    else if (req === "processing") enabled = isBusy;
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
      else if (checkKey === "tier:low") checked = state.tier === "low";
      else if (checkKey === "tier:mid") checked = state.tier === "mid";
      else if (checkKey === "tier:high") checked = state.tier === "high";
      else if (checkKey === "defringe") checked = state.defringe;
      else if (checkKey === "despill") checked = state.despill;
      else if (checkKey === "matting") checked = state.matting;
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

  const activeTabNow = getActiveTab();
  if (activeTabNow?.kind === "batch") renderBatchPanel(activeTabNow);
}

export function cancelProcessing() {
  if (state.batch.running) {
    state.batch.cancelled = true;
  }
  if (state.abortController) {
    state.abortController.abort();
    state.abortController = null;
  }
  fetch("/api/cancel", { method: "POST" }).catch(() => {});
  state.isProcessing = false;
  dom.busyOverlay.classList.remove("active");
  closeConfirmModal();
  dom.statTime.textContent = "CANCELLED";

  if (!state.resultBlob && state.sourceFile) {
    setViewMode("original");
  }
  saveStateToActiveTab();
  syncMenuBarState();
}

export async function runSegmentation() {
  if (!state.sourceFile) return;

  const tierInfo = state.matting
    ? state.serverStatus?.matting
    : state.serverStatus?.tiers?.[state.tier];
  if (tierInfo && !tierInfo.cached && !navigator.onLine) {
    setError("Selected model is not cached on disk and device is currently offline.");
    return;
  }

  if (state.abortController) {
    state.abortController.abort();
    fetch("/api/cancel", { method: "POST" }).catch(() => {});
  }
  const controller = new AbortController();
  state.abortController = controller;
  state.isProcessing = true;

  if (!state.resultBlob) {
    dom.appShell?.classList.add("no-result");
  }
  setError(null);
  dom.busyOverlay.classList.add("active");
  dom.statTime.textContent = "PROCESSING...";
  syncMenuBarState();

  const isCached = tierInfo ? tierInfo.cached : true;
  const presetName = state.matting
    ? "MATTING"
    : PRESET_NAMES[state.tier] || state.tier.toUpperCase();
  const qualityDesc =
    state.exportWidth > 0 || state.exportHeight > 0
      ? `${state.exportWidth || "AUTO"}×${state.exportHeight || "AUTO"}`
      : `${Math.round((state.exportScale || 1) * 100)}%`;
  const destDesc =
    state.outputDir || (window.pywebview ? "save dialog" : "browser downloads");

  dom.busyTitle.textContent = isCached
    ? "PROCESSING IMAGE"
    : "PROCESSING IMAGE — FETCHING MODEL WEIGHTS";
  dom.busySub.textContent =
    `Exporting to ${destDesc} using ${presetName} preset ` +
    `at ${qualityDesc} quality.` +
    (isCached
      ? ""
      : " One-time download from Hugging Face Hub — all future runs are fully offline.");

  const formData = new FormData();
  formData.append("file", state.sourceFile);
  formData.append("tier", state.tier);
  formData.append("defringe", state.defringe ? "true" : "false");
  formData.append("despill", state.despill ? "true" : "false");
  formData.append("matting", state.matting ? "true" : "false");

  try {
    const response = await fetch("/api/remove-bg", {
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
    const width = parseInt(response.headers.get("X-Image-Width") || "0", 10);
    const height = parseInt(response.headers.get("X-Image-Height") || "0", 10);

    const blob = await response.blob();
    if (controller.signal.aborted) return;

    state.resultBlob = blob;
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
    dom.statTime.textContent = inferenceMs
      ? `${(inferenceMs / 1000).toFixed(2)}S`
      : "DONE";

    setViewMode("split");
    saveStateToActiveTab();
    syncServerStatus(false);
  } catch (err) {
    if (err.name === "AbortError") return;
    setError(err.message || "Failed to process image.");
    dom.statTime.textContent = "ERROR";
  } finally {
    if (state.abortController === controller) {
      state.isProcessing = false;
      state.abortController = null;
      dom.busyOverlay.classList.remove("active");
      closeConfirmModal();
      if (state.resultBlob) {
        dom.appShell?.classList.remove("no-result");
      }
      syncMenuBarState();
    }
  }
}

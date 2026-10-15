/**
 * OpenBGR — Frontend Studio Controller
 * ====================================
 * Handles multi-image workspace tabs, hardware preset switching, drag-and-drop /
 * clipboard image ingestion, split-plane comparison rendering, active request
 * cancellation, live client-side multi-format / custom-pixel preview & export,
 * and communication with the local FastAPI segmentation backend.
 */

"use strict";

/** Format descriptions shown in the right Export sidebar */
const FORMAT_HINTS = {
  png: "Uncompressed 32-bit RGBA PNG with full alpha transparency.",
  webp: "High-efficiency WebP with alpha transparency (~40% smaller file size).",
  jpg: "Lossy JPEG composited onto the active Matte backdrop color.",
  mask: "8-bit grayscale Alpha Matte PNG (White = Foreground, Black = Background).",
};

/** Status dot tooltip descriptions */
const DOT_TOOLTIPS = {
  ready: "READY OFFLINE — Model weights are cached on disk",
  downloadable: "CAN BE DOWNLOADED — Model will download on 1st run",
  unavailable: "UNAVAILABLE OFFLINE — Model is not cached and device is offline",
};

const STORAGE_KEY_CONFIRM_CLOSE = "openbgr_confirm_close_tab";

/** Offscreen master Image element holding the active tab's 100% RGBA cutout */
const masterCutoutImg = new Image();

let nextTabSeq = 1;

/** Application State */
const state = {
  tabs: [],                  // Array of open image tab objects
  activeTabId: null,         // ID of currently selected tab
  confirmCloseTab: localStorage.getItem(STORAGE_KEY_CONFIRM_CLOSE) !== "false",
  tier: "mid",               // "low" (BiRefNet_lite 1K) | "mid" (BiRefNet Full 1K) | "high" (BiRefNet_HR 2K)
  defringe: true,            // Morphological edge color decontamination toggle
  viewMode: "split",         // "split" | "cutout" | "original"
  splitPercent: 50,          // Horizontal divider position (0 - 100)
  isDraggingSplit: false,    // Pointer drag state for split comparator
  isProcessing: false,       // Whether an inference request is currently in-flight
  abortController: null,     // AbortController for the active fetch request
  pendingConfirmFn: null,    // Callback to execute if user confirms modal dialog
  sourceFile: null,          // Active tab's File/Blob object
  resultBlob: null,          // Active tab's segmented master 32-bit RGBA PNG Blob
  previewBlob: null,         // Active tab's live-rendered output Blob
  originalObjectUrl: null,   // Active tab's Object URL for source preview
  resultObjectUrl: null,     // Active tab's Object URL for master 100% RGBA cutout
  previewObjectUrl: null,    // Active tab's Object URL for live formatted/scaled stage preview
  previewRenderToken: 0,     // Monotonic counter to discard stale async canvas renders
  naturalWidth: 0,           // Native pixel width of active cutout
  naturalHeight: 0,          // Native pixel height of active cutout
  exportFormat: "png",       // "png" | "webp" | "jpg" | "mask"
  exportScale: 1,            // Scale multiplier (0.1 to 2.0)
  exportWidth: 0,            // Target export width in pixels
  exportHeight: 0,           // Target export height in pixels
  activeBackdrop: "checker", // "checker" or hex color string (e.g. "#ffffff")
  serverStatus: null,        // Cached response from GET /api/status
};

/** DOM Element References */
const dom = {
  appShell: document.getElementById("appShell"),
  tabBar: document.getElementById("tabBar"),
  viewport: document.getElementById("viewport"),
  emptyState: document.getElementById("emptyState"),
  stage: document.getElementById("stage"),
  stageSizerImg: document.getElementById("stageSizerImg"),
  beforeImg: document.getElementById("beforeImg"),
  afterImg: document.getElementById("afterImg"),
  beforeClip: document.getElementById("beforeClip"),
  splitLine: document.getElementById("splitLine"),
  lblLeft: document.getElementById("lblLeft"),
  lblRight: document.getElementById("lblRight"),

  busyOverlay: document.getElementById("busyOverlay"),
  busyTitle: document.getElementById("busyTitle"),
  busySub: document.getElementById("busySub"),
  btnCancel: document.getElementById("btnCancel"),
  errorToast: document.getElementById("errorToast"),

  confirmModal: document.getElementById("confirmModal"),
  modalTitle: document.getElementById("modalTitle"),
  modalDesc: document.getElementById("modalDesc"),
  btnModalCancel: document.getElementById("btnModalCancel"),
  btnModalConfirm: document.getElementById("btnModalConfirm"),

  infoModal: document.getElementById("infoModal"),
  btnInfo: document.getElementById("btnInfo"),
  btnInfoClose: document.getElementById("btnInfoClose"),
  btnToggleConfirmClose: document.getElementById("btnToggleConfirmClose"),

  fileInput: document.getElementById("fileInput"),
  btnOpen: document.getElementById("btnOpen"),
  btnCopy: document.getElementById("btnCopy"),
  btnDownload: document.getElementById("btnDownload"),
  btnDefringe: document.getElementById("btnDefringe"),

  exportFormatSelect: document.getElementById("exportFormatSelect"),
  formatHint: document.getElementById("formatHint"),
  exportScaleSlider: document.getElementById("exportScaleSlider"),
  scalePctLabel: document.getElementById("scalePctLabel"),
  exportWidthInput: document.getElementById("exportWidthInput"),
  exportHeightInput: document.getElementById("exportHeightInput"),

  hwCompute: document.getElementById("hwCompute"),
  statFile: document.getElementById("statFile"),
  statDim: document.getElementById("statDim"),
  statTier: document.getElementById("statTier"),
  statTime: document.getElementById("statTime"),
};

/**
 * Returns the currently active tab object, or null if no tabs exist.
 */
function getActiveTab() {
  return state.tabs.find((t) => t.id === state.activeTabId) || null;
}

/**
 * Saves the current studio state fields back into the active tab record.
 */
function saveStateToActiveTab() {
  const tab = getActiveTab();
  if (!tab) return;
  tab.tier = state.tier;
  tab.defringe = state.defringe;
  tab.viewMode = state.viewMode;
  tab.splitPercent = state.splitPercent;
  tab.resultBlob = state.resultBlob;
  tab.previewBlob = state.previewBlob;
  tab.resultObjectUrl = state.resultObjectUrl;
  tab.previewObjectUrl = state.previewObjectUrl;
  tab.naturalWidth = state.naturalWidth;
  tab.naturalHeight = state.naturalHeight;
  tab.exportFormat = state.exportFormat;
  tab.exportScale = state.exportScale;
  tab.exportWidth = state.exportWidth;
  tab.exportHeight = state.exportHeight;
  tab.activeBackdrop = state.activeBackdrop;
  tab.elapsedText = dom.statTime.textContent;
}

/**
 * Renders the top multi-image tab bar (`#tabBar`).
 */
function renderTabBar() {
  if (!dom.tabBar) return;
  dom.tabBar.innerHTML = "";

  if (state.tabs.length === 0) {
    dom.tabBar.classList.remove("visible");
    return;
  }

  dom.tabBar.classList.add("visible");

  state.tabs.forEach((tab) => {
    const tabEl = document.createElement("div");
    tabEl.className = `tab-item${tab.id === state.activeTabId ? " active" : ""}`;
    tabEl.setAttribute("data-tab-id", tab.id);
    tabEl.title = tab.name;

    const titleSpan = document.createElement("span");
    titleSpan.className = "tab-title";
    titleSpan.textContent = tab.name;

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "tab-close";
    closeBtn.title = "Close image tab";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      requestCloseTab(tab.id);
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
  addBtn.title = "Open another image";
  addBtn.textContent = "+";
  addBtn.addEventListener("click", () => {
    dom.btnOpen.click();
  });
  dom.tabBar.appendChild(addBtn);
}

/**
 * Requests closing a tab by ID, showing a confirmation dialog if
 * `state.confirmCloseTab` is enabled in Settings.
 * @param {string} tabId
 */
function requestCloseTab(tabId) {
  const tab = state.tabs.find((t) => t.id === tabId);
  if (!tab) return;

  if (state.confirmCloseTab) {
    openConfirmModal(
      {
        title: "CLOSE IMAGE TAB?",
        message: `Remove "${tab.name}" from the viewer?`,
        confirmText: "CLOSE IMAGE",
        cancelText: "CANCEL",
      },
      () => {
        closeTabImmediate(tabId);
      }
    );
  } else {
    closeTabImmediate(tabId);
  }
}

/**
 * Immediately closes and cleans up a tab by ID.
 * @param {string} tabId
 */
function closeTabImmediate(tabId) {
  const idx = state.tabs.findIndex((t) => t.id === tabId);
  if (idx === -1) return;

  const tab = state.tabs[idx];
  const wasActive = tab.id === state.activeTabId;

  if (wasActive && state.isProcessing) {
    if (state.abortController) {
      state.abortController.abort();
      state.abortController = null;
    }
    state.isProcessing = false;
    dom.busyOverlay.classList.remove("active");
  }

  if (tab.originalObjectUrl) URL.revokeObjectURL(tab.originalObjectUrl);
  if (tab.resultObjectUrl) URL.revokeObjectURL(tab.resultObjectUrl);
  if (tab.previewObjectUrl && tab.previewObjectUrl !== tab.resultObjectUrl) {
    URL.revokeObjectURL(tab.previewObjectUrl);
  }

  state.tabs.splice(idx, 1);

  if (state.tabs.length === 0) {
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

/**
 * Resets the center viewport and controls when zero tabs are open.
 */
function resetToEmptyWorkspace() {
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

  dom.stage.classList.remove("visible");
  dom.emptyState.style.display = "";

  dom.exportWidthInput.value = "";
  dom.exportHeightInput.value = "";
  dom.statFile.textContent = "NONE";
  dom.statDim.textContent = "—";
  dom.statTime.textContent = "—";

  dom.btnDownload.classList.add("disabled");
  dom.btnCopy.classList.add("disabled");
  dom.appShell?.classList.add("no-image");
}

/**
 * Switches the active workspace view to the specified tab ID.
 * @param {string} tabId
 */
async function switchToTab(tabId) {
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
  state.viewMode = tab.viewMode;
  state.splitPercent = tab.splitPercent;
  state.exportFormat = tab.exportFormat;
  state.exportScale = tab.exportScale;
  state.exportWidth = tab.exportWidth;
  state.exportHeight = tab.exportHeight;
  state.activeBackdrop = tab.activeBackdrop;

  renderTabBar();

  // Sync sidebar & view controls to this tab's state
  document.querySelectorAll("#tierSelector .preset-card").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-tier") === state.tier);
  });
  dom.btnDefringe.classList.toggle("active", state.defringe);
  dom.exportFormatSelect.value = state.exportFormat;

  document.querySelectorAll(".swatch").forEach((s) => {
    s.classList.toggle("active", s.getAttribute("data-bg") === state.activeBackdrop);
  });
  if (state.activeBackdrop === "checker") {
    dom.viewport.style.background = "";
    dom.viewport.classList.add("checkerboard-canvas");
  } else {
    dom.viewport.classList.remove("checkerboard-canvas");
    dom.viewport.style.background = state.activeBackdrop;
  }

  dom.emptyState.style.display = "none";
  dom.stage.classList.add("visible");
  dom.stageSizerImg.src = state.originalObjectUrl;
  dom.beforeImg.src = state.originalObjectUrl;
  dom.statFile.textContent = tab.name.toUpperCase();
  dom.statTime.textContent = tab.elapsedText || "—";

  if (state.resultBlob && state.resultObjectUrl) {
    await new Promise((resolve) => {
      masterCutoutImg.onload = resolve;
      masterCutoutImg.onerror = resolve;
      masterCutoutImg.src = state.resultObjectUrl;
    });
    dom.afterImg.src = state.previewObjectUrl || state.resultObjectUrl;
    dom.appShell?.classList.remove("no-image");
    dom.btnDownload.classList.remove("disabled");
    dom.btnCopy.classList.remove("disabled");
    setViewMode(state.viewMode);
    updateExportTelemetry();
  } else {
    dom.afterImg.src = state.originalObjectUrl;
    dom.appShell?.classList.add("no-image");
    dom.btnDownload.classList.add("disabled");
    dom.btnCopy.classList.add("disabled");
    setViewMode("original");
    runSegmentation();
  }
}

/**
 * Displays or clears the top error notification banner.
 * @param {string|null} message
 */
function setError(message) {
  if (!message) {
    dom.errorToast.classList.remove("visible");
    dom.errorToast.textContent = "";
    return;
  }
  dom.errorToast.textContent = `ERROR // ${message}`;
  dom.errorToast.classList.add("visible");
}

/**
 * Opens the confirmation dialog.
 * @param {string|{title?: string, message: string, confirmText?: string, cancelText?: string}} opts
 * @param {() => void} onConfirm
 */
function openConfirmModal(opts, onConfirm) {
  const cfg = typeof opts === "string" ? { message: opts } : opts;
  if (dom.modalTitle) {
    dom.modalTitle.textContent = cfg.title || "STOP CURRENT IMAGE?";
  }
  dom.modalDesc.textContent = cfg.message;
  dom.btnModalConfirm.textContent = cfg.confirmText || "STOP & CONTINUE";
  dom.btnModalCancel.textContent = cfg.cancelText || "KEEP PROCESSING";
  state.pendingConfirmFn = onConfirm;
  dom.confirmModal.classList.add("active");
}

/**
 * Closes the confirmation dialog without executing the pending action.
 */
function closeConfirmModal() {
  state.pendingConfirmFn = null;
  dom.confirmModal.classList.remove("active");
}

/**
 * Cancels the currently running segmentation request via AbortController
 * and restores the workspace to a clean idle state.
 */
function cancelProcessing() {
  if (state.abortController) {
    state.abortController.abort();
    state.abortController = null;
  }
  state.isProcessing = false;
  dom.busyOverlay.classList.remove("active");
  closeConfirmModal();
  dom.statTime.textContent = "CANCELLED";

  if (!state.resultBlob && state.sourceFile) {
    setViewMode("original");
  }
  saveStateToActiveTab();
}

/**
 * Resolves the availability state of a model tier:
 * - "ready"        : Green  (Model weights are cached locally on disk)
 * - "downloadable" : Orange (Not cached yet, but internet is available to download)
 * - "unavailable"  : Red    (Not cached on disk and browser is currently offline)
 *
 * @param {object} tierInfo
 * @returns {"ready"|"downloadable"|"unavailable"}
 */
function getTierAvailability(tierInfo) {
  if (tierInfo?.cached) return "ready";
  return navigator.onLine ? "downloadable" : "unavailable";
}

/**
 * Applies the status dot class ("ready", "downloadable", or "unavailable")
 * and updates its hover tooltip (`data-tooltip` and `title`).
 *
 * @param {HTMLElement|null} dotEl
 * @param {"ready"|"downloadable"|"unavailable"} status
 */
function applyDotState(dotEl, status) {
  if (!dotEl) return;
  dotEl.classList.remove("ready", "downloadable", "unavailable");
  dotEl.classList.add(status);
  const tip = DOT_TOOLTIPS[status] || "";
  dotEl.setAttribute("data-tooltip", tip);
  dotEl.setAttribute("title", tip);
}

/**
 * Updates the status dots and tooltips on all 3 preset buttons.
 */
function updateCacheIndicator() {
  const tiers = state.serverStatus?.tiers;
  if (!tiers) return;

  ["low", "mid", "high"].forEach((key) => {
    const dotEl = document.getElementById(`dot-${key}`);
    const status = getTierAvailability(tiers[key]);
    applyDotState(dotEl, status);
  });
}

/**
 * Renders the master segmented image (`masterCutoutImg`) onto an offscreen
 * canvas at the target `exportWidth` x `exportHeight` and `format`
 * ("png", "webp", "jpg", or "mask") and returns a Promise resolving to the Blob.
 *
 * @param {"png"|"webp"|"jpg"|"mask"} format
 * @returns {Promise<Blob>}
 */
async function buildExportBlob(format) {
  const srcW = state.naturalWidth || masterCutoutImg.naturalWidth;
  const srcH = state.naturalHeight || masterCutoutImg.naturalHeight;
  const targetW = Math.max(1, state.exportWidth || srcW);
  const targetH = Math.max(1, state.exportHeight || srcH);

  if (
    format === "png" &&
    targetW === srcW &&
    targetH === srcH &&
    state.activeBackdrop === "checker" &&
    state.resultBlob
  ) {
    return state.resultBlob;
  }

  const canvas = document.createElement("canvas");
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  if (format === "mask") {
    ctx.drawImage(masterCutoutImg, 0, 0, targetW, targetH);
    const imgData = ctx.getImageData(0, 0, targetW, targetH);
    const data = imgData.data;
    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3];
      data[i] = alpha;
      data[i + 1] = alpha;
      data[i + 2] = alpha;
      data[i + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("Mask export failed"))),
        "image/png"
      );
    });
  }

  if (format === "jpg" || state.activeBackdrop !== "checker") {
    ctx.fillStyle =
      state.activeBackdrop === "checker" ? "#ffffff" : state.activeBackdrop;
    ctx.fillRect(0, 0, targetW, targetH);
  }

  ctx.drawImage(masterCutoutImg, 0, 0, targetW, targetH);

  const mimeMap = {
    png: "image/png",
    webp: "image/webp",
    jpg: "image/jpeg",
  };
  const mimeType = mimeMap[format] || "image/png";
  const quality = format === "png" ? undefined : 0.95;

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Image encoding failed"))),
      mimeType,
      quality
    );
  });
}

/**
 * Updates the live stage preview (`dom.afterImg`) to reflect the currently
 * selected Output Format, Resolution Scale, Custom Dimensions, and Matte Backdrop.
 */
async function updateLiveStagePreview() {
  if (!state.resultBlob || !masterCutoutImg.complete || !masterCutoutImg.naturalWidth) {
    return;
  }

  const token = ++state.previewRenderToken;
  try {
    const blob = await buildExportBlob(state.exportFormat);
    if (token !== state.previewRenderToken) return;

    state.previewBlob = blob;
    if (state.previewObjectUrl && state.previewObjectUrl !== state.resultObjectUrl) {
      URL.revokeObjectURL(state.previewObjectUrl);
    }

    if (blob === state.resultBlob) {
      state.previewObjectUrl = state.resultObjectUrl;
    } else {
      state.previewObjectUrl = URL.createObjectURL(blob);
    }
    dom.afterImg.src = state.previewObjectUrl;
    saveStateToActiveTab();
  } catch (_) {}
}

/**
 * Synchronizes the EXPORT button label, format hint, scale percentage readout,
 * quick-scale buttons, WxH px inputs, bottom DIMENSIONS status bar, stage
 * corner label, and live stage image preview.
 */
function updateExportTelemetry() {
  const fmtUpper = state.exportFormat.toUpperCase();
  dom.btnDownload.textContent = `EXPORT ${fmtUpper}`;
  if (dom.formatHint && FORMAT_HINTS[state.exportFormat]) {
    dom.formatHint.textContent = FORMAT_HINTS[state.exportFormat];
  }

  const pct = Math.round(state.exportScale * 100);
  dom.scalePctLabel.textContent = `${pct}%`;

  const clampedSlider = Math.max(10, Math.min(200, pct));
  dom.exportScaleSlider.value = String(clampedSlider);

  document.querySelectorAll(".quick-scale-btn").forEach((btn) => {
    const btnScale = parseFloat(btn.getAttribute("data-scale") || "0");
    btn.classList.toggle("active", Math.abs(btnScale - state.exportScale) < 0.005);
  });

  if (state.naturalWidth > 0 && state.naturalHeight > 0) {
    if (!state.exportWidth || !state.exportHeight) {
      state.exportWidth = Math.max(1, Math.round(state.naturalWidth * state.exportScale));
      state.exportHeight = Math.max(1, Math.round(state.naturalHeight * state.exportScale));
    }
    if (document.activeElement !== dom.exportWidthInput) {
      dom.exportWidthInput.value = String(state.exportWidth);
    }
    if (document.activeElement !== dom.exportHeightInput) {
      dom.exportHeightInput.value = String(state.exportHeight);
    }

    dom.statDim.textContent =
      pct === 100
        ? `${state.exportWidth}×${state.exportHeight} PX`
        : `${state.exportWidth}×${state.exportHeight} PX (${pct}%)`;

    dom.lblRight.textContent = `${fmtUpper} • ${state.exportWidth}×${state.exportHeight} (${pct}%)`;
    updateLiveStagePreview();
  }
}

/**
 * Queries `/api/status` to discover hardware acceleration capabilities
 * and local model cache state.
 * @param {boolean} isInitialLoad
 */
async function syncServerStatus(isInitialLoad = false) {
  try {
    const response = await fetch("/api/status");
    state.serverStatus = await response.json();

    const { device_label, precision, recommended_tier } = state.serverStatus;
    dom.hwCompute.textContent = `${device_label} (${precision})`.toUpperCase();

    if (isInitialLoad && recommended_tier) {
      selectTier(recommended_tier, false);
    }
    updateCacheIndicator();
  } catch (_) {
    dom.hwCompute.textContent = "LOCAL ENGINE";
  }
}

/**
 * Switches the active hardware preset ("low", "mid", or "high").
 * If an image is already loaded and `reprocess` is true, immediately
 * re-runs segmentation with the new preset.
 *
 * @param {string} tierKey
 * @param {boolean} reprocess
 */
function selectTier(tierKey, reprocess = true) {
  state.tier = tierKey;
  document.querySelectorAll("#tierSelector .preset-card").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-tier") === tierKey);
  });
  updateCacheIndicator();
  saveStateToActiveTab();

  if (reprocess && state.sourceFile) {
    runSegmentation();
  }
}

/**
 * Updates the active viewport mode ("split", "cutout", or "original")
 * and refreshes the stage clipping planes.
 * @param {"split"|"cutout"|"original"} mode
 */
function setViewMode(mode) {
  state.viewMode = mode;
  document.getElementById("viewSplit").classList.toggle("active", mode === "split");
  document.getElementById("viewCutout").classList.toggle("active", mode === "cutout");
  document.getElementById("viewOriginal").classList.toggle("active", mode === "original");
  renderStageGeometry();
  saveStateToActiveTab();
}

/**
 * Applies CSS `clip-path` and divider coordinates according to `state.viewMode`
 * and `state.splitPercent`.
 */
function renderStageGeometry() {
  if (state.viewMode === "split") {
    dom.beforeClip.style.display = "block";
    dom.splitLine.style.display = "block";
    dom.lblLeft.style.display = "block";
    dom.lblRight.style.display = "block";
    dom.beforeClip.style.clipPath = `inset(0 ${100 - state.splitPercent}% 0 0)`;
    dom.splitLine.style.left = `${state.splitPercent}%`;
  } else if (state.viewMode === "cutout") {
    dom.beforeClip.style.display = "none";
    dom.splitLine.style.display = "none";
    dom.lblLeft.style.display = "none";
    dom.lblRight.style.display = "block";
  } else {
    dom.beforeClip.style.display = "block";
    dom.beforeClip.style.clipPath = "inset(0 0 0 0)";
    dom.splitLine.style.display = "none";
    dom.lblLeft.style.display = "block";
    dom.lblRight.style.display = "none";
  }
}

/**
 * Updates the split-plane divider position from a mouse or touch X coordinate.
 * @param {number} clientX
 */
function handleSplitDrag(clientX) {
  if (!state.isDraggingSplit || state.viewMode !== "split") return;
  const rect = dom.stage.getBoundingClientRect();
  if (!rect.width) return;

  const rawPct = ((clientX - rect.left) / rect.width) * 100;
  state.splitPercent = Math.max(0, Math.min(100, rawPct));
  renderStageGeometry();
}

/**
 * Creates a new image tab for a user-supplied File or clipboard Blob,
 * switches to it, and triggers background removal.
 * @param {File|Blob} file
 */
function ingestImageFile(file) {
  saveStateToActiveTab();

  const tabId = `tab-${nextTabSeq++}`;
  const rawName = file.name || `CLIPBOARD_${nextTabSeq - 1}.PNG`;
  const objUrl = URL.createObjectURL(file);

  const newTab = {
    id: tabId,
    name: rawName,
    sourceFile: file,
    originalObjectUrl: objUrl,
    resultBlob: null,
    resultObjectUrl: null,
    previewBlob: null,
    previewObjectUrl: null,
    naturalWidth: 0,
    naturalHeight: 0,
    tier: state.tier,
    defringe: state.defringe,
    viewMode: "split",
    splitPercent: 50,
    exportFormat: state.exportFormat,
    exportScale: state.exportScale,
    exportWidth: 0,
    exportHeight: 0,
    activeBackdrop: state.activeBackdrop,
    elapsedText: "PROCESSING...",
  };

  state.tabs.push(newTab);
  state.activeTabId = tabId;

  state.sourceFile = file;
  state.originalObjectUrl = objUrl;
  state.resultBlob = null;
  state.previewBlob = null;
  state.resultObjectUrl = null;
  state.previewObjectUrl = null;
  state.naturalWidth = 0;
  state.naturalHeight = 0;

  dom.appShell?.classList.add("no-image");
  dom.btnDownload.classList.add("disabled");
  dom.btnCopy.classList.add("disabled");

  dom.stageSizerImg.src = state.originalObjectUrl;
  dom.beforeImg.src = state.originalObjectUrl;
  dom.afterImg.src = state.originalObjectUrl;

  dom.emptyState.style.display = "none";
  dom.stage.classList.add("visible");
  dom.statFile.textContent = rawName.toUpperCase();
  dom.statDim.textContent = "—";

  renderTabBar();
  runSegmentation();
}

/**
 * Sends the active image file and selected parameters (`tier`, `defringe`)
 * to `POST /api/remove-bg` and renders the resulting lossless RGBA PNG.
 */
async function runSegmentation() {
  if (!state.sourceFile) return;

  const tierInfo = state.serverStatus?.tiers?.[state.tier];
  if (tierInfo && !tierInfo.cached && !navigator.onLine) {
    setError(`Model for ${state.tier.toUpperCase()} preset is not cached and device is offline.`);
    return;
  }

  if (state.abortController) {
    state.abortController.abort();
  }
  const controller = new AbortController();
  state.abortController = controller;
  state.isProcessing = true;

  // Keep studio options locked while processing is active
  dom.appShell?.classList.add("no-image");
  setError(null);
  dom.busyOverlay.classList.add("active");
  dom.statTime.textContent = "PROCESSING...";

  const isCached = tierInfo ? tierInfo.cached : true;

  dom.busyTitle.textContent = isCached
    ? `PROCESSING // ${state.tier.toUpperCase()} PRESET`
    : `DOWNLOADING MODEL WEIGHTS (ONE-TIME) // ${state.tier.toUpperCase()}`;
  dom.busySub.textContent = isCached
    ? "Executing local BiRefNet segmentation at full native resolution."
    : "Fetching model weights from Hugging Face Hub (~1 min). All future runs execute 100% offline.";

  const formData = new FormData();
  formData.append("file", state.sourceFile);
  formData.append("tier", state.tier);
  formData.append("defringe", state.defringe ? "true" : "false");

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

    const inferenceMs = parseFloat(response.headers.get("X-Inference-Time-Ms") || "0");
    const width = parseInt(response.headers.get("X-Image-Width") || "0", 10);
    const height = parseInt(response.headers.get("X-Image-Height") || "0", 10);
    const tierLabel = response.headers.get("X-Tier-Used") || state.tier.toUpperCase();

    const blob = await response.blob();
    if (controller.signal.aborted) return;

    state.resultBlob = blob;
    state.naturalWidth = width;
    state.naturalHeight = height;
    state.exportWidth = Math.max(1, Math.round(width * state.exportScale));
    state.exportHeight = Math.max(1, Math.round(height * state.exportScale));

    if (state.resultObjectUrl) URL.revokeObjectURL(state.resultObjectUrl);
    state.resultObjectUrl = URL.createObjectURL(state.resultBlob);

    await new Promise((resolve) => {
      masterCutoutImg.onload = resolve;
      masterCutoutImg.onerror = resolve;
      masterCutoutImg.src = state.resultObjectUrl;
    });

    // Processing is complete: unlock all studio options
    dom.appShell?.classList.remove("no-image");
    dom.btnDownload.classList.remove("disabled");
    dom.btnCopy.classList.remove("disabled");

    updateExportTelemetry();
    if (dom.statTier) {
      dom.statTier.textContent = tierLabel.toUpperCase();
    }
    dom.statTime.textContent = inferenceMs ? `${(inferenceMs / 1000).toFixed(2)}S` : "DONE";

    setViewMode("split");
    saveStateToActiveTab();
    syncServerStatus(false);
  } catch (err) {
    if (err.name === "AbortError") {
      return;
    }
    setError(err.message || "Failed to process image.");
    dom.statTime.textContent = "ERROR";
  } finally {
    if (state.abortController === controller) {
      state.isProcessing = false;
      state.abortController = null;
      dom.busyOverlay.classList.remove("active");
      closeConfirmModal();
      if (state.resultBlob) {
        dom.appShell?.classList.remove("no-image");
      }
    }
  }
}

/* -------------------------------------------------------------------------
 * Event Listeners Registration
 * ------------------------------------------------------------------------- */

// 1. Online / Offline Connectivity Listeners for Preset Status Dots
window.addEventListener("online", () => updateCacheIndicator());
window.addEventListener("offline", () => updateCacheIndicator());

// 2. Cancel Button, Confirmation Modal & Settings Modal Controls
dom.btnCancel.addEventListener("click", () => {
  cancelProcessing();
});

dom.btnModalCancel.addEventListener("click", () => {
  closeConfirmModal();
});

dom.btnModalConfirm.addEventListener("click", () => {
  const fn = state.pendingConfirmFn;
  closeConfirmModal();
  if (typeof fn === "function") fn();
});

dom.confirmModal.addEventListener("click", (e) => {
  if (e.target === dom.confirmModal) {
    closeConfirmModal();
  }
});

dom.btnInfo.addEventListener("click", () => {
  dom.infoModal.classList.add("active");
});

dom.btnInfoClose.addEventListener("click", () => {
  dom.infoModal.classList.remove("active");
});

dom.infoModal.addEventListener("click", (e) => {
  if (e.target === dom.infoModal) {
    dom.infoModal.classList.remove("active");
  }
});

// Sync initial state of "Confirm before closing image tab" toggle in Settings
if (dom.btnToggleConfirmClose) {
  dom.btnToggleConfirmClose.classList.toggle("active", state.confirmCloseTab);
  dom.btnToggleConfirmClose.addEventListener("click", () => {
    state.confirmCloseTab = !state.confirmCloseTab;
    localStorage.setItem(STORAGE_KEY_CONFIRM_CLOSE, String(state.confirmCloseTab));
    dom.btnToggleConfirmClose.classList.toggle("active", state.confirmCloseTab);
  });
}

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (dom.infoModal.classList.contains("active")) {
      dom.infoModal.classList.remove("active");
    } else if (dom.confirmModal.classList.contains("active")) {
      closeConfirmModal();
    } else if (state.isProcessing) {
      cancelProcessing();
    }
  }
});

// 3. Left Sidebar: Hardware Preset Cards
document.querySelectorAll("#tierSelector .preset-card").forEach((btn) => {
  btn.addEventListener("click", () => {
    const targetTier = btn.getAttribute("data-tier");
    if (targetTier && targetTier !== state.tier) {
      selectTier(targetTier, true);
    }
  });
});

// 4. Left Sidebar: Edge Defringe Toggle Card
dom.btnDefringe.addEventListener("click", () => {
  state.defringe = !state.defringe;
  dom.btnDefringe.classList.toggle("active", state.defringe);
  saveStateToActiveTab();
  if (state.sourceFile) runSegmentation();
});

// 5. Top Bar: View Mode Segmented Control
document.getElementById("viewSplit").addEventListener("click", () => setViewMode("split"));
document.getElementById("viewCutout").addEventListener("click", () => setViewMode("cutout"));
document.getElementById("viewOriginal").addEventListener("click", () => setViewMode("original"));

// 6. Right Sidebar: Export Format Dropdown, Scale Slider, Quick Scale & Custom PX Inputs
dom.exportFormatSelect.addEventListener("change", (e) => {
  state.exportFormat = e.target.value;
  updateExportTelemetry();
});

function applyScaleValue(newScale) {
  state.exportScale = newScale;
  if (state.naturalWidth > 0 && state.naturalHeight > 0) {
    state.exportWidth = Math.max(1, Math.round(state.naturalWidth * state.exportScale));
    state.exportHeight = Math.max(1, Math.round(state.naturalHeight * state.exportScale));
  }
  updateExportTelemetry();
}

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
    state.exportHeight = Math.max(1, Math.round(state.naturalHeight * state.exportScale));
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
    state.exportWidth = Math.max(1, Math.round(state.naturalWidth * state.exportScale));
    dom.exportWidthInput.value = String(state.exportWidth);
  }
  updateExportTelemetry();
});

// 7. Split-Plane Pointer Dragging (Mouse + Touch)
dom.stage.addEventListener("mousedown", (e) => {
  if (state.viewMode !== "split") return;
  state.isDraggingSplit = true;
  handleSplitDrag(e.clientX);
});
window.addEventListener("mousemove", (e) => handleSplitDrag(e.clientX));
window.addEventListener("mouseup", () => {
  state.isDraggingSplit = false;
  saveStateToActiveTab();
});

dom.stage.addEventListener(
  "touchstart",
  (e) => {
    if (state.viewMode !== "split") return;
    state.isDraggingSplit = true;
    if (e.touches[0]) handleSplitDrag(e.touches[0].clientX);
  },
  { passive: true }
);
window.addEventListener(
  "touchmove",
  (e) => {
    if (state.isDraggingSplit && e.touches[0]) handleSplitDrag(e.touches[0].clientX);
  },
  { passive: true }
);
window.addEventListener("touchend", () => {
  state.isDraggingSplit = false;
  saveStateToActiveTab();
});

// 8. Matte Backdrop Swatches & Custom Color Picker
document.querySelectorAll(".swatch[data-bg]").forEach((swatch) => {
  swatch.addEventListener("click", () => {
    document.querySelectorAll(".swatch").forEach((s) => s.classList.remove("active"));
    swatch.classList.add("active");

    const bgValue = swatch.getAttribute("data-bg") || "checker";
    state.activeBackdrop = bgValue;
    if (bgValue === "checker") {
      dom.viewport.style.background = "";
      dom.viewport.classList.add("checkerboard-canvas");
    } else {
      dom.viewport.classList.remove("checkerboard-canvas");
      dom.viewport.style.background = bgValue;
    }
    updateLiveStagePreview();
  });
});

document.getElementById("colorPicker").addEventListener("input", (e) => {
  document.querySelectorAll(".swatch").forEach((s) => s.classList.remove("active"));
  e.target.classList.add("active");
  state.activeBackdrop = e.target.value;
  dom.viewport.classList.remove("checkerboard-canvas");
  dom.viewport.style.background = e.target.value;
  updateLiveStagePreview();
});

// 9. File Selection, Drag-and-Drop, and Clipboard Paste (with active-job guard)
function triggerOpenFileDialog() {
  dom.fileInput.value = "";
  dom.fileInput.click();
}

dom.emptyState.addEventListener("click", () => triggerOpenFileDialog());

dom.btnOpen.addEventListener("click", () => {
  if (state.isProcessing) {
    openConfirmModal(
      "This will stop the current image processing. Do you want to open a new image?",
      () => {
        cancelProcessing();
        triggerOpenFileDialog();
      }
    );
    return;
  }
  triggerOpenFileDialog();
});

dom.fileInput.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  if (state.isProcessing) {
    cancelProcessing();
  }
  ingestImageFile(file);
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
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;

  if (state.isProcessing) {
    openConfirmModal(
      "This will stop the current image processing. Do you want to load the dropped image?",
      () => {
        cancelProcessing();
        ingestImageFile(file);
      }
    );
    return;
  }
  ingestImageFile(file);
});

window.addEventListener("paste", (e) => {
  const items = e.clipboardData?.items || [];
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      const blob = item.getAsFile();
      if (!blob) break;
      if (state.isProcessing) {
        openConfirmModal(
          "This will stop the current image processing. Do you want to load the pasted image?",
          () => {
            cancelProcessing();
            ingestImageFile(blob);
          }
        );
      } else {
        ingestImageFile(blob);
      }
      break;
    }
  }
});

// 10. Export Download & Clipboard Copy (Multi-Format & Custom Pixel Resolution)
dom.btnDownload.addEventListener("click", async () => {
  if (!state.resultBlob) return;
  try {
    const exportBlob = state.previewBlob || (await buildExportBlob(state.exportFormat));
    const extMap = { png: "png", webp: "webp", jpg: "jpg", mask: "png" };
    const suffix = state.exportFormat === "mask" ? "mask" : "cutout";
    const isNativeSize =
      state.exportWidth === state.naturalWidth &&
      state.exportHeight === state.naturalHeight;
    const sizeTag = isNativeSize
      ? ""
      : `-${state.exportWidth}x${state.exportHeight}`;
    const baseName = (state.sourceFile?.name || "image").replace(/\.[^/.]+$/, "");
    const fileName = `${baseName}-${suffix}${sizeTag}.${extMap[state.exportFormat] || "png"}`;

    const downloadUrl = URL.createObjectURL(exportBlob);
    const a = document.createElement("a");
    a.href = downloadUrl;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(downloadUrl), 2000);
  } catch (err) {
    setError(err.message || "Failed to export image.");
  }
});

dom.btnCopy.addEventListener("click", async () => {
  if (!state.resultBlob) return;
  try {
    const copyFormat = state.exportFormat === "mask" ? "mask" : "png";
    const pngBlob = await buildExportBlob(copyFormat);
    await navigator.clipboard.write([
      new ClipboardItem({ "image/png": pngBlob }),
    ]);
    const originalLabel = dom.btnCopy.textContent;
    dom.btnCopy.textContent = "COPIED";
    setTimeout(() => {
      dom.btnCopy.textContent = originalLabel;
    }, 1400);
  } catch (_) {
    setError("Clipboard PNG write is not supported in this browser context.");
  }
});

// Initialize studio status on page load
syncServerStatus(true);

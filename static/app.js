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
const STORAGE_KEY_PREFS = "openbgr_prefs";

/** Accent palette for Preferences > Accent (accent color, contrasting label color) */
const ACCENTS = {
  white: ["#fafafa", "#09090b"],
  green: ["#34d399", "#052e1b"],
  blue: ["#60a5fa", "#0b1c3a"],
  amber: ["#fbbf24", "#3a2a05"],
  red: ["#f87171", "#3a0a0a"],
  violet: ["#a78bfa", "#1e1245"],
};

/**
 * Loads persisted user preferences from localStorage, migrating the legacy
 * standalone confirm-close key and filling unspecified fields with defaults.
 */
function loadPrefs() {
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(STORAGE_KEY_PREFS) || "{}");
  } catch (_) {}
  const legacyConfirm = localStorage.getItem(STORAGE_KEY_CONFIRM_CLOSE);
  return {
    theme: "dark",
    accent: "default",
    density: "comfortable",
    defaultFormat: "png",
    defaultBackdrop: "checker",
    confirmClose: legacyConfirm !== null ? legacyConfirm !== "false" : true,
    ...stored,
  };
}

const prefs = loadPrefs();

function savePrefs() {
  try {
    localStorage.setItem(STORAGE_KEY_PREFS, JSON.stringify(prefs));
  } catch (_) {}
}

/** Offscreen master Image element holding the active tab's 100% RGBA cutout */
const masterCutoutImg = new Image();

let nextTabSeq = 1;

/** Application State */
const state = {
  tabs: [],                  // Array of open image tab objects
  activeTabId: null,         // ID of currently selected tab
  confirmCloseTab: prefs.confirmClose,
  tier: "mid",               // "low" (BiRefNet_lite 1K) | "mid" (BiRefNet Full 1K) | "high" (BiRefNet_HR 2K)
  defringe: true,            // Morphological edge color decontamination toggle
  despill: true,             // Rim color spill / background reflection neutralization toggle
  matting: false,            // BiRefNet-matting mode for glass, windows & sheer materials
  shadowCutoff: 0,           // Alpha threshold (0 - 75%) to slice off floor reflections & shadows
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
  exportFormat: prefs.defaultFormat, // "png" | "webp" | "jpg" | "mask"
  exportScale: 1,            // Scale multiplier (0.1 to 2.0)
  exportWidth: 0,            // Target export width in pixels
  exportHeight: 0,           // Target export height in pixels
  activeBackdrop: prefs.defaultBackdrop, // "checker" or hex color string (e.g. "#ffffff")
  zoom: 1,                   // Viewport zoom factor (1.0 to 8.0)
  panX: 0,                   // Viewport pan X offset in px
  panY: 0,                   // Viewport pan Y offset in px
  isPanning: false,          // Whether user is currently panning the canvas
  panStartX: 0,
  panStartY: 0,
  spacePressed: false,       // Spacebar held for pan mode
  loupeEnabled: false,       // Whether 4x circular magnifier loupe is active
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
  loupeCanvas: document.getElementById("loupeCanvas"),

  btnZoomOut: document.getElementById("btnZoomOut"),
  btnZoomReset: document.getElementById("btnZoomReset"),
  btnZoomIn: document.getElementById("btnZoomIn"),
  btnLoupe: document.getElementById("btnLoupe"),

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
  prefThemeDark: document.getElementById("prefThemeDark"),
  prefThemeLight: document.getElementById("prefThemeLight"),
  prefDensityComfortable: document.getElementById("prefDensityComfortable"),
  prefDensityCompact: document.getElementById("prefDensityCompact"),
  accentSwatches: document.getElementById("accentSwatches"),
  prefDefaultFormat: document.getElementById("prefDefaultFormat"),
  prefDefaultBackdrop: document.getElementById("prefDefaultBackdrop"),

  fileInput: document.getElementById("fileInput"),
  btnOpen: document.getElementById("btnOpen"),
  btnCopy: document.getElementById("btnCopy"),
  btnDownload: document.getElementById("btnDownload"),
  btnDefringe: document.getElementById("btnDefringe"),
  btnDespill: document.getElementById("btnDespill"),
  btnMatting: document.getElementById("btnMatting"),
  shadowCutoffSlider: document.getElementById("shadowCutoffSlider"),
  shadowCutoffLabel: document.getElementById("shadowCutoffLabel"),

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
  tab.despill = state.despill;
  tab.matting = state.matting;
  tab.shadowCutoff = state.shadowCutoff;
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

/**
 * Creates a new blank tab showing the empty dropzone/paste screen and switches to it.
 */
function createBlankTab() {
  saveStateToActiveTab();

  const tabId = `tab-${nextTabSeq++}`;
  const blankTab = {
    id: tabId,
    name: "NEW TAB",
    sourceFile: null,
    originalObjectUrl: null,
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
    elapsedText: "—",
  };

  state.tabs.push(blankTab);
  switchToTab(tabId);
}

/**
 * Requests closing a tab by ID, showing a confirmation dialog if
 * `state.confirmCloseTab` is enabled in Settings and the tab contains an image.
 * @param {string} tabId
 */
function requestCloseTab(tabId) {
  const tab = state.tabs.find((t) => t.id === tabId);
  if (!tab) return;

  if (state.confirmCloseTab && tab.sourceFile) {
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
  masterCutoutImg.removeAttribute("src");

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
  state.despill = tab.despill ?? true;
  state.matting = tab.matting ?? false;
  state.shadowCutoff = tab.shadowCutoff ?? 0;
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
  dom.btnDespill?.classList.toggle("active", state.despill);
  dom.btnMatting?.classList.toggle("active", state.matting);
  if (dom.shadowCutoffSlider) {
    dom.shadowCutoffSlider.value = String(state.shadowCutoff);
  }
  if (dom.shadowCutoffLabel) {
    dom.shadowCutoffLabel.textContent = `${state.shadowCutoff}%`;
  }
  dom.exportFormatSelect.value = state.exportFormat;

  applyBackdrop(state.activeBackdrop);

  if (!tab.sourceFile) {
    resetToEmptyWorkspace();
    return;
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
    if (tab.elapsedText !== "CANCELLED" && tab.elapsedText !== "ERROR") {
      runSegmentation();
    }
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
  fetch("/api/cancel", { method: "POST" }).catch(() => {});
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
 * Updates the status dots and tooltips on all 3 preset buttons and the Matting toggle.
 */
function updateCacheIndicator() {
  const tiers = state.serverStatus?.tiers;
  if (!tiers) return;

  ["low", "mid", "high"].forEach((key) => {
    const dotEl = document.getElementById(`dot-${key}`);
    const status = getTierAvailability(tiers[key]);
    applyDotState(dotEl, status);
  });

  if (state.serverStatus?.matting) {
    const matDot = document.getElementById("dot-matting");
    applyDotState(matDot, getTierAvailability(state.serverStatus.matting));
  }
}

/**
 * Renders the master segmented image (`masterCutoutImg`) onto an offscreen
 * canvas at the target `exportWidth` x `exportHeight`, applies real-time
 * `shadowCutoff` alpha thresholding, and encodes to `format`
 * ("png", "webp", "jpg", or "mask").
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
    state.shadowCutoff === 0 &&
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

  // Draw the cutout onto an intermediate buffer if shadow/reflection cutoff or mask is needed
  const cutoffByte = Math.round((state.shadowCutoff / 100) * 255);

  if (format === "mask") {
    ctx.drawImage(masterCutoutImg, 0, 0, targetW, targetH);
    const imgData = ctx.getImageData(0, 0, targetW, targetH);
    const data = imgData.data;
    const span = Math.max(1, 255 - cutoffByte);
    for (let i = 0; i < data.length; i += 4) {
      let alpha = data[i + 3];
      if (cutoffByte > 0) {
        alpha = alpha <= cutoffByte ? 0 : Math.min(255, Math.round(((alpha - cutoffByte) * 255) / span));
      }
      data[i] = alpha;
      data[i + 1] = alpha;
      data[i + 2] = alpha;
      data[i + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (b) => {
          canvas.width = 0;
          canvas.height = 0;
          if (b) resolve(b);
          else reject(new Error("Mask export failed"));
        },
        "image/png"
      );
    });
  }

  if (cutoffByte > 0) {
    // Apply alpha cutoff on an offscreen foreground layer before compositing onto Matte backdrop
    const fgCanvas = document.createElement("canvas");
    fgCanvas.width = targetW;
    fgCanvas.height = targetH;
    const fgCtx = fgCanvas.getContext("2d");
    fgCtx.imageSmoothingEnabled = true;
    fgCtx.imageSmoothingQuality = "high";
    fgCtx.drawImage(masterCutoutImg, 0, 0, targetW, targetH);

    const imgData = fgCtx.getImageData(0, 0, targetW, targetH);
    const data = imgData.data;
    const span = Math.max(1, 255 - cutoffByte);
    for (let i = 3; i < data.length; i += 4) {
      const a = data[i];
      data[i] = a <= cutoffByte ? 0 : Math.min(255, Math.round(((a - cutoffByte) * 255) / span));
    }
    fgCtx.putImageData(imgData, 0, 0);

    if (format === "jpg" || state.activeBackdrop !== "checker") {
      ctx.fillStyle =
        state.activeBackdrop === "checker" ? "#ffffff" : state.activeBackdrop;
      ctx.fillRect(0, 0, targetW, targetH);
    }
    ctx.drawImage(fgCanvas, 0, 0);
    fgCanvas.width = 0;
    fgCanvas.height = 0;
  } else {
    if (format === "jpg" || state.activeBackdrop !== "checker") {
      ctx.fillStyle =
        state.activeBackdrop === "checker" ? "#ffffff" : state.activeBackdrop;
      ctx.fillRect(0, 0, targetW, targetH);
    }
    ctx.drawImage(masterCutoutImg, 0, 0, targetW, targetH);
  }

  const mimeMap = {
    png: "image/png",
    webp: "image/webp",
    jpg: "image/jpeg",
  };
  const mimeType = mimeMap[format] || "image/png";
  const quality = format === "png" ? undefined : 0.95;

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => {
        canvas.width = 0;
        canvas.height = 0;
        if (b) resolve(b);
        else reject(new Error("Image encoding failed"));
      },
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
 * Applies the persisted appearance preferences (theme, accent, UI density) to
 * the document root and re-syncs the Preferences modal controls.
 */
function applyPreferences() {
  const root = document.documentElement;
  root.classList.toggle("theme-light", prefs.theme === "light");
  root.classList.toggle("density-compact", prefs.density === "compact");

  const accent = ACCENTS[prefs.accent];
  if (prefs.accent !== "default" && accent) {
    root.style.setProperty("--accent", accent[0]);
    root.style.setProperty("--accent-contrast", accent[1]);
  } else {
    // Falls back to the per-theme --accent default (mono light/dark).
    root.style.removeProperty("--accent");
    root.style.removeProperty("--accent-contrast");
  }

  dom.prefThemeDark?.classList.toggle("active", prefs.theme !== "light");
  dom.prefThemeLight?.classList.toggle("active", prefs.theme === "light");
  dom.prefDensityComfortable?.classList.toggle("active", prefs.density !== "compact");
  dom.prefDensityCompact?.classList.toggle("active", prefs.density === "compact");
  document.querySelectorAll("#accentSwatches .swatch").forEach((s) => {
    s.classList.toggle("active", s.getAttribute("data-accent") === prefs.accent);
  });
  if (dom.prefDefaultFormat) dom.prefDefaultFormat.value = prefs.defaultFormat;
  if (dom.prefDefaultBackdrop) dom.prefDefaultBackdrop.value = prefs.defaultBackdrop;
  dom.btnToggleConfirmClose?.classList.toggle("active", prefs.confirmClose);
}

/**
 * Applies a matte backdrop ("checker" or a hex color) to the viewport,
 * swatch selection state, and live stage preview.
 * @param {string} value
 */
function applyBackdrop(value) {
  state.activeBackdrop = value;
  document.querySelectorAll(".swatch").forEach((s) => {
    s.classList.toggle("active", s.getAttribute("data-bg") === value);
  });
  if (value === "checker") {
    dom.viewport.style.background = "";
    dom.viewport.classList.add("checkerboard-canvas");
  } else {
    dom.viewport.classList.remove("checkerboard-canvas");
    dom.viewport.style.background = value;
  }
  updateLiveStagePreview();
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
 * Applies the current `state.zoom`, `state.panX`, and `state.panY` transform
 * to `#stage` and updates the top-bar zoom percentage button.
 */
function applyZoomTransform() {
  if (!dom.stage) return;
  if (state.zoom <= 1) {
    state.zoom = 1;
    state.panX = 0;
    state.panY = 0;
  }
  dom.stage.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
  if (dom.btnZoomReset) {
    dom.btnZoomReset.textContent = `${Math.round(state.zoom * 100)}%`;
  }
}

/**
 * Sets a new zoom factor (clamped to [1, 8]) and updates the stage transform.
 * @param {number} newZoom
 */
function setZoom(newZoom) {
  state.zoom = Math.max(1, Math.min(8, newZoom));
  applyZoomTransform();
}

/**
 * Toggles the 4× circular mouse magnifier loupe on or off.
 * @param {boolean} [forceState]
 */
function toggleLoupe(forceState) {
  state.loupeEnabled = typeof forceState === "boolean" ? forceState : !state.loupeEnabled;
  dom.btnLoupe?.classList.toggle("active", state.loupeEnabled);
  dom.stage?.classList.toggle("loupe-active", state.loupeEnabled);
  if (!state.loupeEnabled) {
    dom.loupeCanvas?.classList.remove("visible");
  }
}

/**
 * Renders the 4× magnified circular loupe at the current cursor position `(clientX, clientY)`.
 * In `SPLIT` mode, the left half of the circle shows 4× Original and the right half shows 4× Cutout.
 *
 * @param {number} clientX
 * @param {number} clientY
 */
function renderLoupeAtPointer(clientX, clientY) {
  if (!state.loupeEnabled || !state.resultBlob || !dom.loupeCanvas) {
    dom.loupeCanvas?.classList.remove("visible");
    return;
  }

  const stageRect = dom.stage.getBoundingClientRect();
  const vpRect = dom.viewport.getBoundingClientRect();
  if (
    !stageRect.width ||
    clientX < stageRect.left ||
    clientX > stageRect.right ||
    clientY < stageRect.top ||
    clientY > stageRect.bottom
  ) {
    dom.loupeCanvas.classList.remove("visible");
    return;
  }

  dom.loupeCanvas.classList.add("visible");
  dom.loupeCanvas.style.left = `${clientX - vpRect.left}px`;
  dom.loupeCanvas.style.top = `${clientY - vpRect.top}px`;

  const normX = (clientX - stageRect.left) / stageRect.width;
  const normY = (clientY - stageRect.top) / stageRect.height;

  const size = 180;
  const zoomFactor = 4;
  const ctx = dom.loupeCanvas.getContext("2d");
  ctx.clearRect(0, 0, size, size);

  // 1. Fill circular loupe backdrop (checkerboard or solid matte)
  if (state.activeBackdrop === "checker") {
    const cs = getComputedStyle(document.documentElement);
    const checkerA = cs.getPropertyValue("--checker-a").trim() || "#16161a";
    const checkerB = cs.getPropertyValue("--checker-b").trim() || "#0e0e11";
    const tile = 10;
    for (let y = 0; y < size; y += tile) {
      for (let x = 0; x < size; x += tile) {
        ctx.fillStyle = ((x / tile + y / tile) & 1) === 0 ? checkerA : checkerB;
        ctx.fillRect(x, y, tile, tile);
      }
    }
  } else {
    ctx.fillStyle = state.activeBackdrop;
    ctx.fillRect(0, 0, size, size);
  }

  const drawMagnifiedSource = (imgEl) => {
    const imgW = imgEl.naturalWidth;
    const imgH = imgEl.naturalHeight;
    if (!imgW || !imgH) return;

    const sampleW = (size / stageRect.width) * (imgW / zoomFactor);
    const sampleH = (size / stageRect.height) * (imgH / zoomFactor);
    const sx = normX * imgW - sampleW / 2;
    const sy = normY * imgH - sampleH / 2;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(imgEl, sx, sy, sampleW, sampleH, 0, 0, size, size);
  };

  if (state.viewMode === "original") {
    drawMagnifiedSource(dom.beforeImg);
  } else if (state.viewMode === "split" && normX * 100 < state.splitPercent) {
    drawMagnifiedSource(dom.beforeImg);
  } else {
    drawMagnifiedSource(dom.afterImg);
  }
}

/**
 * Updates the split-plane divider position from a mouse or touch X coordinate.
 * @param {number} clientX
 */
function handleSplitDrag(clientX) {
  if (state.loupeEnabled || !state.isDraggingSplit || state.viewMode !== "split") return;
  const rect = dom.stage.getBoundingClientRect();
  if (!rect.width) return;

  const rawPct = ((clientX - rect.left) / rect.width) * 100;
  state.splitPercent = Math.max(0, Math.min(100, rawPct));
  renderStageGeometry();
}

/**
 * Loads a user-supplied File or clipboard Blob into the current blank tab
 * (if active tab is empty) or creates a new tab for it, then triggers segmentation.
 * @param {File|Blob} file
 */
function ingestImageFile(file) {
  saveStateToActiveTab();

  const rawName = file.name || `CLIPBOARD_${nextTabSeq}.PNG`;
  const objUrl = URL.createObjectURL(file);
  const currentTab = getActiveTab();

  let targetTab;
  if (currentTab && !currentTab.sourceFile) {
    // Reuse the currently active blank "NEW TAB"
    currentTab.name = rawName;
    currentTab.sourceFile = file;
    currentTab.originalObjectUrl = objUrl;
    currentTab.elapsedText = "PROCESSING...";
    targetTab = currentTab;
  } else {
    const tabId = `tab-${nextTabSeq++}`;
    targetTab = {
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

  // Keep studio options locked while processing is active
  dom.appShell?.classList.add("no-image");
  setError(null);
  dom.busyOverlay.classList.add("active");
  dom.statTime.textContent = "PROCESSING...";

  const isCached = tierInfo ? tierInfo.cached : true;
  const modeLabel = state.matting ? "GLASS & SHEER MATTING" : `${state.tier.toUpperCase()} PRESET`;

  dom.busyTitle.textContent = isCached
    ? `PROCESSING // ${modeLabel}`
    : `DOWNLOADING MODEL WEIGHTS (ONE-TIME) // ${modeLabel}`;
  dom.busySub.textContent = isCached
    ? "Executing local BiRefNet segmentation at full native resolution."
    : "Fetching model weights from Hugging Face Hub (~1 min). All future runs execute 100% offline.";

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

    if (state.previewObjectUrl && state.previewObjectUrl !== state.resultObjectUrl) {
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
    prefs.confirmClose = state.confirmCloseTab;
    savePrefs();
    dom.btnToggleConfirmClose.classList.toggle("active", state.confirmCloseTab);
  });
}

// Preferences modal: Appearance (theme / accent / density) & Behavior defaults
dom.prefThemeDark?.addEventListener("click", () => {
  prefs.theme = "dark";
  savePrefs();
  applyPreferences();
});
dom.prefThemeLight?.addEventListener("click", () => {
  prefs.theme = "light";
  savePrefs();
  applyPreferences();
});
dom.prefDensityComfortable?.addEventListener("click", () => {
  prefs.density = "comfortable";
  savePrefs();
  applyPreferences();
});
dom.prefDensityCompact?.addEventListener("click", () => {
  prefs.density = "compact";
  savePrefs();
  applyPreferences();
});
dom.accentSwatches?.querySelectorAll(".swatch").forEach((sw) => {
  sw.addEventListener("click", () => {
    prefs.accent = sw.getAttribute("data-accent") || "default";
    savePrefs();
    applyPreferences();
  });
});
dom.prefDefaultFormat?.addEventListener("change", (e) => {
  prefs.defaultFormat = e.target.value;
  savePrefs();
  // Adopt as the live selection when the workspace is still empty
  if (!state.resultBlob) {
    state.exportFormat = prefs.defaultFormat;
    dom.exportFormatSelect.value = state.exportFormat;
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

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (dom.infoModal.classList.contains("active")) {
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

  // Ignore shortcuts when typing in an input field
  if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "SELECT")) {
    return;
  }

  // Native-menu parity shortcuts (Cmd on macOS, Ctrl on Windows/Linux)
  if (e.metaKey || e.ctrlKey) {
    const key = e.key.toLowerCase();
    if (key === "o") {
      e.preventDefault();
      window.openBGR.openImage();
    } else if (key === "e") {
      e.preventDefault();
      window.openBGR.exportImage();
    } else if (key === "w") {
      e.preventDefault();
      window.openBGR.closeActiveTab();
    } else if (key === ",") {
      e.preventDefault();
      window.openBGR.openSettings("preferences");
    } else if (key === "0") {
      e.preventDefault();
      setZoom(1);
    } else if (key === "=" || key === "+") {
      e.preventDefault();
      setZoom(state.zoom + 0.25);
    } else if (key === "-") {
      e.preventDefault();
      setZoom(state.zoom - 0.25);
    } else if (key === "c" && e.shiftKey) {
      e.preventDefault();
      window.openBGR.copyImage();
    }
    return;
  }

  if (e.code === "Space") {
    state.spacePressed = true;
  } else if ((e.key === "z" || e.key === "Z") && !e.metaKey && !e.ctrlKey && state.resultBlob) {
    toggleLoupe();
  }
});

window.addEventListener("keyup", (e) => {
  if (e.code === "Space") {
    state.spacePressed = false;
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

// 4. Left Sidebar: Edge Defringe, Color Spill Suppression, Glass Matting & Shadow Cutoff
dom.btnDefringe.addEventListener("click", () => {
  state.defringe = !state.defringe;
  dom.btnDefringe.classList.toggle("active", state.defringe);
  saveStateToActiveTab();
  if (state.sourceFile) runSegmentation();
});

dom.btnDespill?.addEventListener("click", () => {
  state.despill = !state.despill;
  dom.btnDespill.classList.toggle("active", state.despill);
  saveStateToActiveTab();
  if (state.sourceFile) runSegmentation();
});

dom.btnMatting?.addEventListener("click", () => {
  state.matting = !state.matting;
  dom.btnMatting.classList.toggle("active", state.matting);
  saveStateToActiveTab();
  if (state.sourceFile) runSegmentation();
});

dom.shadowCutoffSlider?.addEventListener("input", (e) => {
  state.shadowCutoff = parseInt(e.target.value || "0", 10);
  if (dom.shadowCutoffLabel) {
    dom.shadowCutoffLabel.textContent = `${state.shadowCutoff}%`;
  }
  updateLiveStagePreview();
});

// 5. Top Bar: View Mode, Zoom Controls & 4x Loupe Toggle
document.getElementById("viewSplit").addEventListener("click", () => setViewMode("split"));
document.getElementById("viewCutout").addEventListener("click", () => setViewMode("cutout"));
document.getElementById("viewOriginal").addEventListener("click", () => setViewMode("original"));

dom.btnZoomIn?.addEventListener("click", () => setZoom(state.zoom + 0.25));
dom.btnZoomOut?.addEventListener("click", () => setZoom(state.zoom - 0.25));
dom.btnZoomReset?.addEventListener("click", () => setZoom(1));
dom.btnLoupe?.addEventListener("click", () => toggleLoupe());

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

// 7. Split-Plane Pointer Dragging, Scroll-Wheel Zoom, Pan & 4x Loupe
dom.viewport.addEventListener(
  "wheel",
  (e) => {
    if (!state.resultBlob) return;
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.2 : -0.2;
    setZoom(state.zoom + delta);
    renderLoupeAtPointer(e.clientX, e.clientY);
  },
  { passive: false }
);

dom.stage.addEventListener("dblclick", () => {
  setZoom(1);
});

dom.stage.addEventListener("contextmenu", (e) => {
  if (state.zoom > 1) e.preventDefault();
});

dom.stage.addEventListener("mousedown", (e) => {
  // Right-click, Middle-click, Space+drag, or Left-click in non-split mode when zoomed -> Pan
  if (
    state.zoom > 1 &&
    (e.button === 1 || e.button === 2 || state.spacePressed || state.viewMode !== "split")
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
    applyBackdrop(swatch.getAttribute("data-bg") || "checker");
    saveStateToActiveTab();
  });
});

document.getElementById("colorPicker").addEventListener("input", (e) => {
  applyBackdrop(e.target.value);
  e.target.classList.add("active");
  saveStateToActiveTab();
});

// 9. File Selection, Drag-and-Drop, and Clipboard Paste (with active-job guard)
function triggerOpenFileDialog() {
  dom.fileInput.value = "";
  dom.fileInput.click();
}

/**
 * Decodes a base64 string into a Blob (used by the native OS Open dialog bridge).
 * @param {string} b64
 * @returns {Blob}
 */
function base64ToBlob(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return new Blob([bytes]);
}

/**
 * Opens an image via the native OS file dialog when running inside the
 * pywebview desktop window, falling back to the HTML file input in browsers.
 */
async function openImageDialog() {
  if (window.pywebview?.api?.open_image_dialog) {
    try {
      const res = await window.pywebview.api.open_image_dialog();
      if (res?.error) {
        setError(res.error);
        return;
      }
      if (res?.data_b64) {
        const blob = base64ToBlob(res.data_b64);
        ingestImageFile(new File([blob], res.name || "image.png"));
      }
      return;
    } catch (_) {
      // Fall through to the HTML file input if the bridge call fails
    }
  }
  triggerOpenFileDialog();
}

/**
 * Entry point for every "open image" surface (button, dropzone, menu, ⌘O).
 * Guards against interrupting an in-flight inference job.
 */
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

dom.emptyState.addEventListener("click", () => requestOpenImage());

dom.btnOpen.addEventListener("click", () => requestOpenImage());

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

// 10. Export Download & Clipboard Copy (Native OS Save Dialog or Browser Download)
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = String(reader.result || "");
      const base64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl;
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

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

    // If running inside the pywebview native desktop window, use the native OS Save dialog
    if (window.pywebview?.api?.save_file) {
      const b64 = await blobToBase64(exportBlob);
      const res = await window.pywebview.api.save_file(b64, fileName);
      if (res && res.error) {
        throw new Error(res.error);
      }
      return;
    }

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

/**
 * Reads an image from the OS clipboard via `navigator.clipboard.read()`
 * (used by the native Edit > Paste Image menu item).
 */
async function pasteImageFromClipboard() {
  const finish = (blob) => {
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
  };
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const imgType = item.types.find((t) => t.startsWith("image/"));
      if (imgType) {
        finish(await item.getType(imgType));
        return;
      }
    }
    setError("Clipboard does not contain an image.");
  } catch (_) {
    setError("Clipboard read is not permitted in this context.");
  }
}

/**
 * Command bridge invoked by the native OS menu bar (pywebview) and by
 * keyboard shortcuts. Mirrors the native menu structure 1:1.
 */
window.openBGR = {
  openImage: () => requestOpenImage(),
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
    if (["split", "cutout", "original"].includes(mode)) setViewMode(mode);
  },
  zoomIn: () => setZoom(state.zoom + 0.25),
  zoomOut: () => setZoom(state.zoom - 0.25),
  zoomReset: () => setZoom(1),
  toggleLoupe: () => toggleLoupe(),
  cancelProcessing: () => cancelProcessing(),
  openSettings: (section) => {
    dom.infoModal.classList.add("active");
    if (section) {
      document
        .getElementById(`settings-${section}`)
        ?.scrollIntoView({ block: "start" });
    }
  },
};

// Initialize persisted preferences, default backdrop, format select & server status
applyPreferences();
dom.exportFormatSelect.value = state.exportFormat;
applyBackdrop(state.activeBackdrop);
syncServerStatus(true);

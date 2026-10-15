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

/** Short availability phrases appended to tier-button tooltips */
const TIER_STATUS_SHORT = {
  ready: "CACHED OFFLINE",
  downloadable: "DOWNLOADS ON 1ST RUN",
  unavailable: "NOT CACHED — DEVICE OFFLINE",
};

/** Full model descriptions shown in the Hardware Preset hover tooltips */
const TIER_META = {
  low: "LITE 1K — BiRefNet_lite · Swin-T @1024px · ~110 MB. Fastest on CPU & integrated GPUs.",
  mid: "FULL 1K — BiRefNet · Swin-L @1024px · ~440 MB. Studio hair, fur & soft alpha.",
  high: "ULTRA 2K — BiRefNet_HR · Swin-L @2K HR. Max detail for 4K/8K photography.",
  matting: "MATTING — BiRefNet-matting. True alpha for glass, smoke & sheer fabric.",
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

function getDefaultPrefs() {
  return {
    theme: "dark",
    accent: "default",
    density: "comfortable",
    defaultTier: "auto",
    defaultFormat: "png",
    defaultBackdrop: "checker",
    confirmClose: true,
  };
}

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
    ...getDefaultPrefs(),
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
  tier: prefs.defaultTier !== "auto" ? prefs.defaultTier : "mid", // "low" | "mid" | "high"
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
  expectingBatch: false,     // Next fileInput selection routes into the batch queue
  batch: {                   // Client-side FIFO queue state for batch processing
    running: false,
    total: 0,
    index: 0,
    failed: 0,
    cancelled: false,
    outputDir: null,         // Chosen output folder (native desktop mode)
    results: [],             // [{name, blob}] collected for browser ZIP export
  },
};

/** DOM Element References */
const dom = {
  appShell: document.getElementById("appShell"),
  menuBar: document.getElementById("menuBar"),
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
  btnResetPrefs: document.getElementById("btnResetPrefs"),
  btnToggleConfirmClose: document.getElementById("btnToggleConfirmClose"),
  prefThemeDark: document.getElementById("prefThemeDark"),
  prefThemeLight: document.getElementById("prefThemeLight"),
  prefDensityComfortable: document.getElementById("prefDensityComfortable"),
  prefDensityCompact: document.getElementById("prefDensityCompact"),
  accentSwatches: document.getElementById("accentSwatches"),
  prefDefaultTier: document.getElementById("prefDefaultTier"),
  prefDefaultFormat: document.getElementById("prefDefaultFormat"),
  prefDefaultBackdrop: document.getElementById("prefDefaultBackdrop"),

  fileInput: document.getElementById("fileInput"),
  btnOpen: document.getElementById("btnOpen"),
  btnProcess: document.getElementById("btnProcess"),
  btnBatch: document.getElementById("btnBatch"),
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
  hwPrecision: document.getElementById("hwPrecision"),
  prefsVersion: document.getElementById("prefsVersion"),
  sysVersion: document.getElementById("sysVersion"),
  aboutVersion: document.getElementById("aboutVersion"),
  btnPrefsCloseX: document.getElementById("btnPrefsCloseX"),
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
  const defaultTier =
    prefs.defaultTier !== "auto"
      ? prefs.defaultTier
      : state.serverStatus?.recommended_tier || state.tier;
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
    tier: defaultTier,
    defringe: state.defringe,
    despill: state.despill,
    matting: state.matting,
    shadowCutoff: 0,
    viewMode: "split",
    splitPercent: 50,
    exportFormat: prefs.defaultFormat,
    exportScale: 1,
    exportWidth: 0,
    exportHeight: 0,
    activeBackdrop: prefs.defaultBackdrop,
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

  // Collapse to the pristine empty workspace whenever no image-bearing tab
  // remains — leftover blank "NEW TAB" stubs shouldn't keep the tab bar alive.
  if (!state.tabs.some((t) => t.sourceFile)) {
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
  dom.appShell?.classList.add("no-result");
  syncMenuBarState();
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
  dom.btnModalCancel.style.display = cfg.hideCancel ? "none" : "";
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

/* =========================================================================
 * Batch Processing — client-side FIFO queue over POST /api/remove-bg.
 * Multi-file selections (native picker, file input, drag-and-drop) route here;
 * each image runs sequentially through the serialized inference lock, then the
 * exported blob is written into a user-chosen folder (native mode) or packed
 * into a single ZIP download (browser mode).
 * ========================================================================= */

const BATCH_EXT = { png: "png", webp: "webp", jpg: "jpg", mask: "png" };

/**
 * Entry point for batch: confirms the count, then runs the queue.
 * @param {Array<File>} files
 */
function startBatchFlow(files) {
  const list = Array.from(files || []).filter((f) => f);
  if (list.length === 0 || state.batch.running) return;

  if (state.isProcessing) {
    openConfirmModal(
      `This will stop the current image processing. Start a batch of ${list.length} image${list.length > 1 ? "s" : ""}?`,
      () => {
        cancelProcessing();
        confirmBatch(list);
      }
    );
    return;
  }
  confirmBatch(list);
}

/**
 * Shows the batch confirmation summary (current settings apply to every file).
 * @param {Array<File>} files
 */
function confirmBatch(files) {
  const tierLabel = { low: "LOW · LITE 1K", mid: "MID · FULL 1K", high: "HIGH · ULTRA 2K" }[
    state.tier
  ] || state.tier;
  const opts = [
    state.matting ? "MATTING" : tierLabel,
    state.defringe ? "DEFRINGE" : null,
    state.despill ? "DESPILL" : null,
    state.shadowCutoff > 0 ? `CUTOFF ${state.shadowCutoff}%` : null,
    (state.exportFormat || "png").toUpperCase(),
  ]
    .filter(Boolean)
    .join(" · ");

  openConfirmModal(
    {
      title: `BATCH PROCESS ${files.length} IMAGE${files.length > 1 ? "S" : ""}?`,
      message: `Every file is processed locally with your current settings and exported as "_cutout" copies — no tabs are opened.\n\n${opts}`,
      confirmText: "START BATCH",
      cancelText: "CANCEL",
    },
    () => runBatch(files)
  );
}

/**
 * Runs the FIFO queue: POST each file, render the export blob, then either
 * write it into the chosen folder via POST /api/save (native) or collect it
 * for a single ZIP download (browser).
 * @param {Array<File>} files
 */
async function runBatch(files) {
  const batch = state.batch;

  // Choose the destination folder up-front in native mode.
  let outputDir = null;
  if (window.pywebview?.api?.choose_output_dir) {
    try {
      const res = await window.pywebview.api.choose_output_dir();
      if (res?.error) {
        setError(res.error);
        return;
      }
      if (!res?.path) return; // Folder pick cancelled — abort the batch quietly.
      outputDir = res.path;
    } catch (_) {
      // Bridge failure → fall back to the browser ZIP path below.
    }
  }

  // Snapshot settings so mid-batch UI tweaks cannot alter queued jobs.
  const snap = {
    tier: state.tier,
    defringe: state.defringe,
    despill: state.despill,
    matting: state.matting,
    format: state.exportFormat,
    scale: state.exportScale,
    backdrop: state.activeBackdrop,
    shadowCutoff: state.shadowCutoff,
  };

  batch.running = true;
  batch.total = files.length;
  batch.index = 0;
  batch.failed = 0;
  batch.cancelled = false;
  batch.outputDir = outputDir;
  batch.results = [];

  state.isProcessing = true; // Locks the studio UI through the existing guards.
  setError(null);
  dom.busyOverlay.classList.add("active");
  const tierInfo = snap.matting
    ? state.serverStatus?.matting
    : state.serverStatus?.tiers?.[snap.tier];
  const isCached = tierInfo ? tierInfo.cached !== false : true;
  syncMenuBarState();

  const controller = new AbortController();
  state.abortController = controller;
  let completed = 0;

  for (let i = 0; i < batch.total; i++) {
    if (batch.cancelled) break;
    batch.index = i;
    const file = files[i];
    const label = `${i + 1}/${batch.total}`;
    dom.busyTitle.textContent = `BATCH ${label}`;
    dom.busySub.textContent = `${file.name.toUpperCase()} — ${
      isCached
        ? "executing local BiRefNet segmentation at full native resolution"
        : "fetching model weights from Hugging Face Hub (first run only)"
    }`;
    dom.statTime.textContent = label;

    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("tier", snap.tier);
      fd.append("defringe", snap.defringe ? "true" : "false");
      fd.append("despill", snap.despill ? "true" : "false");
      fd.append("matting", snap.matting ? "true" : "false");

      const response = await fetch("/api/remove-bg", {
        method: "POST",
        body: fd,
        signal: controller.signal,
      });
      if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        try {
          const payload = await response.json();
          if (payload?.detail) detail = payload.detail;
        } catch (_) {}
        throw new Error(detail);
      }

      const blob = await response.blob();
      if (batch.cancelled || controller.signal.aborted) break;

      const outBlob = await buildBatchExportBlob(blob, snap);
      const ext = BATCH_EXT[snap.format] || "png";
      const stem = (file.name || "image").replace(/\.[^.]+$/, "") || "image";
      const outName = `${stem}_cutout.${ext}`;

      if (batch.outputDir) {
        const ok = await saveBatchFile(batch.outputDir, outName, outBlob);
        if (!ok) {
          batch.failed++;
          continue;
        }
      } else {
        batch.results.push({ name: outName, blob: outBlob });
      }
      completed++;
    } catch (err) {
      if (err?.name === "AbortError" || batch.cancelled) break;
      batch.failed++;
    }
  }

  const wasCancelled = batch.cancelled;
  batch.running = false;
  batch.cancelled = false;
  state.isProcessing = false;
  state.abortController = null;
  dom.busyOverlay.classList.remove("active");
  syncMenuBarState();

  // Browser mode: deliver all collected results as one ZIP download.
  if (!outputDir && batch.results.length > 0) {
    const entries = await Promise.all(
      batch.results.map(async (r) => ({
        name: r.name,
        data: new Uint8Array(await r.blob.arrayBuffer()),
      }))
    );
    batch.results = [];
    downloadBlob(buildZip(entries), "openbgr-cutouts.zip");
  } else {
    batch.results = [];
  }

  if (wasCancelled) {
    dom.statTime.textContent = `CANCELLED ${completed}/${batch.total}`;
    return;
  }
  dom.statTime.textContent = "BATCH DONE";
  openConfirmModal(
    {
      title: "BATCH COMPLETE",
      message: `${completed} of ${batch.total} image${batch.total > 1 ? "s" : ""} processed` +
        (batch.failed > 0 ? ` — ${batch.failed} failed` : "") +
        (outputDir ? `.\nSaved to: ${outputDir}` : " — downloaded as openbgr-cutouts.zip."),
      confirmText: "DONE",
      hideCancel: true,
    },
    () => {}
  );
}

/**
 * Uploads one exported blob to POST /api/save so the server writes it into the
 * batch output directory.
 * @returns {Promise<boolean>}
 */
async function saveBatchFile(dir, filename, blob) {
  try {
    const fd = new FormData();
    fd.append("directory", dir);
    fd.append("filename", filename);
    fd.append("file", blob, filename);
    const res = await fetch("/api/save", { method: "POST", body: fd });
    return res.ok;
  } catch (_) {
    return false;
  }
}

/**
 * Applies export settings (format, scale, backdrop, shadow cutoff) to one batch
 * result blob and returns the encoded output Blob.
 * @param {Blob} blob  Raw RGBA cutout returned by POST /api/remove-bg
 * @param {object} snap  Settings snapshot taken at batch start
 * @returns {Promise<Blob>}
 */
async function buildBatchExportBlob(blob, snap) {
  const bmp = await createImageBitmap(blob);
  try {
    const srcW = bmp.width;
    const srcH = bmp.height;
    const targetW = Math.max(1, Math.round(srcW * (snap.scale || 1)));
    const targetH = Math.max(1, Math.round(srcH * (snap.scale || 1)));

    // Fast path — untouched full-res PNG with no cutoff or matte.
    if (
      snap.format === "png" &&
      snap.backdrop === "checker" &&
      snap.shadowCutoff === 0 &&
      targetW === srcW &&
      targetH === srcH
    ) {
      return blob;
    }

    return await renderExportBlob(bmp, srcW, srcH, {
      format: snap.format,
      targetW,
      targetH,
      shadowCutoff: snap.shadowCutoff,
      backdrop: snap.backdrop,
    });
  } finally {
    bmp.close();
  }
}

/** Triggers a browser download for `blob` under `filename`. */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** CRC-32 table for the minimal ZIP writer. */
const ZIP_CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(u8) {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) {
    c = ZIP_CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Builds an uncompressed (STORED) ZIP archive in memory. PNG/WebP payloads are
 * already compressed, so store-only avoids wasting CPU with no size penalty.
 * @param {Array<{name: string, data: Uint8Array}>} entries
 * @returns {Blob}
 */
function buildZip(entries) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBytes = enc.encode(name);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, 0, true);
    local.setUint16(12, 0, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    chunks.push(local.buffer, nameBytes, data);
    central.push({ nameBytes, crc, size: data.length, offset });
    offset += 30 + nameBytes.length + data.length;
  }

  const cdStart = offset;
  for (const e of central) {
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, 0, true);
    cd.setUint16(14, 0, true);
    cd.setUint32(16, e.crc, true);
    cd.setUint32(20, e.size, true);
    cd.setUint32(24, e.size, true);
    cd.setUint16(28, e.nameBytes.length, true);
    cd.setUint32(42, e.offset, true);
    chunks.push(cd.buffer, e.nameBytes);
    offset += 46 + e.nameBytes.length;
  }

  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, central.length, true);
  eocd.setUint16(10, central.length, true);
  eocd.setUint32(12, offset - cdStart, true);
  eocd.setUint32(16, cdStart, true);
  chunks.push(eocd.buffer);
  return new Blob(chunks, { type: "application/zip" });
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
  // Only fall back to the native title tooltip when no styled has-tooltip
  // tooltip covers this element (itself or an ancestor).
  if (dotEl.classList.contains("has-tooltip") || dotEl.closest(".has-tooltip")) {
    dotEl.removeAttribute("title");
  } else {
    dotEl.setAttribute("title", tip);
  }
}

/**
 * Updates the status dots and tooltips on all 3 preset buttons and the Matting toggle.
 * Also refreshes the System pane model inventory badges in Preferences.
 */
function updateCacheIndicator() {
  const tiers = state.serverStatus?.tiers;
  if (!tiers) return;

  const inventory = {
    low: tiers.low,
    mid: tiers.mid,
    high: tiers.high,
    matting: state.serverStatus?.matting,
  };

  Object.entries(inventory).forEach(([key, tierInfo]) => {
    const status = getTierAvailability(tierInfo);
    applyDotState(document.getElementById(`dot-${key}`), status);
    applyDotState(document.getElementById(`sysdot-${key}`), status);

    // Keep each tier button's hover tooltip = model spec + live cache status
    const tierBtn = document.querySelector(`#tierSelector .tier-btn[data-tier="${key}"]`);
    if (tierBtn) {
      const tip = `${TIER_META[key] || ""} ${TIER_STATUS_SHORT[status] || ""}`.trim();
      tierBtn.setAttribute("data-tooltip", tip);
    }

    // Same combined tooltip on the Matting toggle (its spec + cache status)
    if (key === "matting") {
      const matBtn = document.getElementById("btnMatting");
      if (matBtn) {
        const tip = `${TIER_META.matting} ${TIER_STATUS_SHORT[status] || ""}`.trim();
        matBtn.setAttribute("data-tooltip", tip);
      }
    }

    const badge = document.getElementById(`sysbadge-${key}`);
    if (badge) {
      const isActive = Boolean(tierInfo?.active);
      badge.textContent = isActive
        ? "ACTIVE"
        : status === "ready"
          ? "CACHED"
          : status === "downloadable"
            ? "ON DEMAND"
            : "OFFLINE";
      badge.classList.toggle("on", isActive);
    }
  });
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

  return renderExportBlob(masterCutoutImg, srcW, srcH, {
    format,
    targetW,
    targetH,
    shadowCutoff: state.shadowCutoff,
    backdrop: state.activeBackdrop,
  });
}

/**
 * Shared export renderer: draws `source` (Image | ImageBitmap) onto a canvas at
 * `targetW` x `targetH`, applies the alpha `shadowCutoff` threshold, optionally
 * composites a `backdrop` matte (or forces white for JPG), and encodes to
 * `format` ("png" | "webp" | "jpg" | "mask"). Used by both interactive export
 * and the batch pipeline.
 *
 * @param {CanvasImageSource} source
 * @param {{format: string, targetW: number, targetH: number,
 *          shadowCutoff: number, backdrop: string}} opts
 * @returns {Promise<Blob>}
 */
async function renderExportBlob(source, srcW, srcH, opts) {
  const { format, targetW, targetH, shadowCutoff, backdrop } = opts;

  const canvas = document.createElement("canvas");
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  // Draw the cutout onto an intermediate buffer if shadow/reflection cutoff or mask is needed
  const cutoffByte = Math.round((shadowCutoff / 100) * 255);
  const needsMatte = format === "jpg" || backdrop !== "checker";
  const matteColor = backdrop === "checker" ? "#ffffff" : backdrop;

  if (format === "mask") {
    ctx.drawImage(source, 0, 0, targetW, targetH);
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
    fgCtx.drawImage(source, 0, 0, targetW, targetH);

    const imgData = fgCtx.getImageData(0, 0, targetW, targetH);
    const data = imgData.data;
    const span = Math.max(1, 255 - cutoffByte);
    for (let i = 3; i < data.length; i += 4) {
      const a = data[i];
      data[i] = a <= cutoffByte ? 0 : Math.min(255, Math.round(((a - cutoffByte) * 255) / span));
    }
    fgCtx.putImageData(imgData, 0, 0);

    if (needsMatte) {
      ctx.fillStyle = matteColor;
      ctx.fillRect(0, 0, targetW, targetH);
    }
    ctx.drawImage(fgCanvas, 0, 0);
    fgCanvas.width = 0;
    fgCanvas.height = 0;
  } else {
    if (needsMatte) {
      ctx.fillStyle = matteColor;
      ctx.fillRect(0, 0, targetW, targetH);
    }
    ctx.drawImage(source, 0, 0, targetW, targetH);
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

    const { device_label, precision, recommended_tier, version } = state.serverStatus;
    dom.hwCompute.textContent = (device_label || "LOCAL ENGINE").toUpperCase();
    if (dom.hwPrecision) dom.hwPrecision.textContent = (precision || "—").toUpperCase();
    const verLabel = version ? `V${version}` : "V—";
    if (dom.prefsVersion) dom.prefsVersion.textContent = verLabel;
    if (dom.sysVersion) dom.sysVersion.textContent = verLabel;
    if (dom.aboutVersion) dom.aboutVersion.textContent = verLabel;

    if (isInitialLoad) {
      const targetTier =
        prefs.defaultTier && prefs.defaultTier !== "auto"
          ? prefs.defaultTier
          : recommended_tier || "mid";
      selectTier(targetTier, false);
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
  document.querySelectorAll("#tierSelector .tier-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-tier") === tierKey);
  });
  updateCacheIndicator();
  saveStateToActiveTab();
  syncMenuBarState();

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
  syncMenuBarState();
}

/**
 * Synchronizes checkmarks (✓) and disabled states inside the top-bar
 * Studio Menu Bar (`#menuBar`) with the current studio state.
 */
function syncMenuBarState() {
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

  // PROCESS button: enabled only with a loaded image and no active job
  if (dom.btnProcess) {
    dom.btnProcess.classList.toggle("disabled", !hasImage || isBusy);
    dom.btnProcess.textContent = isBusy
      ? "PROCESSING…"
      : hasResult
        ? "REPROCESS IMAGE"
        : "PROCESS IMAGE";
  }

  // BATCH button: always available while the queue is idle
  if (dom.btnBatch) {
    dom.btnBatch.classList.toggle("disabled", isBusy);
    dom.btnBatch.textContent = state.batch.running
      ? "BATCH RUNNING…"
      : "BATCH PROCESS IMAGES";
  }
}

/**
 * Applies the persisted appearance preferences (theme, accent, UI density) to
 * the document root, native OS window frame, and Preferences modal controls.
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
  if (dom.prefDefaultTier) dom.prefDefaultTier.value = prefs.defaultTier || "auto";
  if (dom.prefDefaultFormat) dom.prefDefaultFormat.value = prefs.defaultFormat;
  if (dom.prefDefaultBackdrop) dom.prefDefaultBackdrop.value = prefs.defaultBackdrop;
  dom.btnToggleConfirmClose?.classList.toggle("active", prefs.confirmClose);

  // Sync native OS window appearance (DarkAqua / Aqua on macOS)
  try {
    window.pywebview?.api?.set_window_theme?.(prefs.theme);
  } catch (_) {}

  syncMenuBarState();
}

/**
 * Applies a matte backdrop ("checker" or a hex color) to the viewport,
 * matte swatch selection state, and live stage preview.
 * @param {string} value
 */
function applyBackdrop(value) {
  state.activeBackdrop = value;
  document.querySelectorAll("#matteSwatches .swatch").forEach((s) => {
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
  syncMenuBarState();
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
    currentTab.elapsedText = "READY";
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
      despill: state.despill,
      matting: state.matting,
      shadowCutoff: state.shadowCutoff,
      viewMode: "split",
      splitPercent: 50,
      exportFormat: state.exportFormat,
      exportScale: state.exportScale,
      exportWidth: 0,
      exportHeight: 0,
      activeBackdrop: state.activeBackdrop,
      elapsedText: "READY",
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

  dom.appShell?.classList.remove("no-image");
  dom.appShell?.classList.add("no-result");
  dom.btnDownload.classList.add("disabled");
  dom.btnCopy.classList.add("disabled");

  dom.stageSizerImg.src = state.originalObjectUrl;
  dom.beforeImg.src = state.originalObjectUrl;
  dom.afterImg.src = state.originalObjectUrl;

  dom.emptyState.style.display = "none";
  dom.stage.classList.add("visible");
  dom.statFile.textContent = rawName.toUpperCase();
  dom.statDim.textContent = "—";
  dom.statTime.textContent = "READY";

  renderTabBar();
  setViewMode("original");
  syncMenuBarState();
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

  // Lock result-dependent controls while a new result is being computed
  dom.appShell?.classList.add("no-result");
  setError(null);
  dom.busyOverlay.classList.add("active");
  dom.statTime.textContent = "PROCESSING...";
  syncMenuBarState();

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
    dom.appShell?.classList.remove("no-result");
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
        dom.appShell?.classList.remove("no-result");
      }
      syncMenuBarState();
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
  openPrefsDialog();
});

dom.btnInfoClose.addEventListener("click", () => {
  dom.infoModal.classList.remove("active");
});

dom.btnPrefsCloseX?.addEventListener("click", () => {
  dom.infoModal.classList.remove("active");
});

dom.infoModal.addEventListener("click", (e) => {
  if (e.target === dom.infoModal) {
    dom.infoModal.classList.remove("active");
  }
});

// Preferences dialog sidebar navigation
const PREFS_SECTION_MAP = {
  preferences: "settings-preferences",
  appearance: "settings-preferences",
  general: "settings-general",
  behavior: "settings-general",
  system: "settings-system",
  about: "settings-about",
};

function selectPrefsPane(paneId) {
  dom.infoModal.querySelectorAll(".prefs-nav-item").forEach((item) => {
    item.classList.toggle("active", item.getAttribute("data-pane") === paneId);
  });
  dom.infoModal.querySelectorAll(".prefs-pane").forEach((pane) => {
    pane.classList.toggle("active", pane.id === paneId);
  });
}

function openPrefsDialog(section) {
  dom.infoModal.classList.add("active");
  const paneId = PREFS_SECTION_MAP[section] || "settings-preferences";
  selectPrefsPane(paneId);
}

dom.infoModal.querySelectorAll(".prefs-nav-item").forEach((item) => {
  item.addEventListener("click", () => {
    selectPrefsPane(item.getAttribute("data-pane"));
  });
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
dom.prefDefaultTier?.addEventListener("change", (e) => {
  prefs.defaultTier = e.target.value;
  savePrefs();
  if (!state.sourceFile) {
    const targetTier =
      prefs.defaultTier !== "auto"
        ? prefs.defaultTier
        : state.serverStatus?.recommended_tier || "mid";
    selectTier(targetTier, false);
  }
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
dom.btnResetPrefs?.addEventListener("click", () => {
  Object.assign(prefs, getDefaultPrefs());
  state.confirmCloseTab = prefs.confirmClose;
  savePrefs();
  applyPreferences();
  if (!state.resultBlob) {
    state.exportFormat = prefs.defaultFormat;
    dom.exportFormatSelect.value = state.exportFormat;
    applyBackdrop(prefs.defaultBackdrop);
    const targetTier = state.serverStatus?.recommended_tier || "mid";
    selectTier(targetTier, false);
    updateExportTelemetry();
  }
});

// Close any open top-bar dropdown menu
function closeAllMenus() {
  dom.menuBar?.querySelectorAll(".menu-root.open").forEach((m) => {
    m.classList.remove("open");
  });
}

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
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

  // Ignore shortcuts when typing in an input field
  if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "SELECT")) {
    return;
  }

  // Native-menu parity shortcuts (Cmd on macOS, Ctrl on Windows/Linux)
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
      if (state.resultBlob) setViewMode("split");
    } else if (key === "2") {
      e.preventDefault();
      if (state.resultBlob) setViewMode("cutout");
    } else if (key === "3") {
      e.preventDefault();
      if (state.resultBlob) setViewMode("original");
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
    } else if (key === "q") {
      e.preventDefault();
      window.openBGR.quitApp();
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

// 3. Left Sidebar: Hardware Preset Buttons (select only — processing is manual)
document.querySelectorAll("#tierSelector .tier-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const targetTier = btn.getAttribute("data-tier");
    if (targetTier && targetTier !== state.tier) {
      selectTier(targetTier, false);
    }
  });
});

// PROCESS / REPROCESS button — the only trigger that runs segmentation
dom.btnProcess?.addEventListener("click", () => {
  if (state.sourceFile && !state.isProcessing) {
    runSegmentation();
  }
});

// 4. Left Sidebar: Edge Defringe, Color Spill Suppression, Glass Matting & Shadow Cutoff
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
      if (Array.isArray(res?.files) && res.files.length > 0) {
        const files = res.files.map(
          (f) => new File([base64ToBlob(f.data_b64)], f.name || "image.png")
        );
        // Multiple selections route into the batch queue instead of opening tabs.
        if (files.length > 1) {
          startBatchFlow(files);
        } else {
          files.forEach((f) => ingestImageFile(f));
        }
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

/**
 * Batch entry point (sidebar button, File menu, ⌘B): opens a multi-file
 * picker and always routes the selection through the batch queue.
 */
function requestBatch() {
  if (state.batch.running) return;
  if (window.pywebview?.api?.open_image_dialog) {
    (async () => {
      try {
        const res = await window.pywebview.api.open_image_dialog();
        if (res?.error) {
          setError(res.error);
          return;
        }
        if (Array.isArray(res?.files) && res.files.length > 0) {
          const files = res.files.map(
            (f) => new File([base64ToBlob(f.data_b64)], f.name || "image.png")
          );
          startBatchFlow(files);
        } else if (res?.data_b64) {
          startBatchFlow([new File([base64ToBlob(res.data_b64)], res.name || "image.png")]);
        }
      } catch (_) {
        state.expectingBatch = true;
        triggerOpenFileDialog();
      }
    })();
    return;
  }
  state.expectingBatch = true;
  triggerOpenFileDialog();
}

dom.btnBatch?.addEventListener("click", () => requestBatch());

dom.fileInput.addEventListener("change", (e) => {
  const files = Array.from(e.target.files || []);
  if (files.length === 0) return;
  const expecting = state.expectingBatch;
  state.expectingBatch = false;
  if (expecting || files.length > 1) {
    startBatchFlow(files);
    return;
  }
  if (state.isProcessing) {
    cancelProcessing();
  }
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
  const files = Array.from(e.dataTransfer?.files || []);
  if (files.length === 0) return;

  // Dropping multiple files routes into the batch queue (one file = normal tab).
  if (files.length > 1) {
    startBatchFlow(files);
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

window.addEventListener("paste", async (e) => {
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
      return;
    }
  }
  // Fallback for files copied in Finder / File Explorer when running in native desktop mode
  if (window.pywebview?.api?.read_clipboard_image) {
    try {
      const res = await window.pywebview.api.read_clipboard_image();
      if (res?.has_image && res.data_b64) {
        const blob = base64ToBlob(res.data_b64);
        const file = new File([blob], res.name || "CLIPBOARD.PNG", { type: "image/png" });
        if (state.isProcessing) {
          openConfirmModal(
            "This will stop the current image processing. Do you want to load the pasted image?",
            () => {
              cancelProcessing();
              ingestImageFile(file);
            }
          );
        } else {
          ingestImageFile(file);
        }
      }
    } catch (_) {}
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
  const markCopied = () => {
    const originalLabel = dom.btnCopy.textContent;
    dom.btnCopy.textContent = "COPIED";
    setTimeout(() => {
      dom.btnCopy.textContent = originalLabel;
    }, 1400);
  };

  try {
    const copyFormat = state.exportFormat === "mask" ? "mask" : "png";
    const pngBlob = await buildExportBlob(copyFormat);

    // Prefer native OS clipboard bridge when running in pywebview desktop mode
    if (window.pywebview?.api?.copy_image) {
      const b64 = await blobToBase64(pngBlob);
      const res = await window.pywebview.api.copy_image(b64);
      if (res?.copied) {
        markCopied();
        return;
      }
    }

    await navigator.clipboard.write([
      new ClipboardItem({ "image/png": pngBlob }),
    ]);
    markCopied();
  } catch (_) {
    setError("Clipboard PNG write is not supported in this browser context.");
  }
});

/**
 * Reads an image from the OS clipboard (native OS bridge first, then Web Clipboard API).
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

  if (window.pywebview?.api?.read_clipboard_image) {
    try {
      const res = await window.pywebview.api.read_clipboard_image();
      if (res?.has_image && res.data_b64) {
        const blob = base64ToBlob(res.data_b64);
        finish(new File([blob], res.name || "CLIPBOARD.PNG", { type: "image/png" }));
        return;
      }
    } catch (_) {}
  }

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
    setError("Clipboard does not contain an image (or press Cmd/Ctrl+V).");
  }
}

/**
 * Opens an external URL in the user's system browser.
 * @param {string} url
 */
function openExternalUrl(url) {
  if (window.pywebview?.api?.open_external) {
    window.pywebview.api.open_external(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
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

/**
 * Command bridge invoked by the native OS menu bar (pywebview), the in-app
 * Studio Menu Bar (`#menuBar`), and keyboard shortcuts.
 */
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
    if (state.resultBlob) setZoom(state.zoom + 0.25);
  },
  zoomOut: () => {
    if (state.resultBlob) setZoom(state.zoom - 0.25);
  },
  zoomReset: () => {
    if (state.resultBlob) setZoom(1);
  },
  toggleLoupe: () => {
    if (state.resultBlob) toggleLoupe();
  },
  toggleTheme: () => {
    prefs.theme = prefs.theme === "light" ? "dark" : "light";
    savePrefs();
    applyPreferences();
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
      selectTier(tierKey, false);
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

// 11. In-App Studio Menu Bar (`#menuBar`) Interaction & Platform Shortcut Labels
(function initStudioMenuBar() {
  if (!dom.menuBar) return;

  // Format shortcut labels for non-macOS platforms (Ctrl instead of ⌘)
  const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
  if (!isMac) {
    dom.menuBar.querySelectorAll(".menu-kbd[data-shortcut]").forEach((el) => {
      const spec = el.getAttribute("data-shortcut") || "";
      if (spec === "Fullscreen") {
        el.textContent = "F11";
      } else {
        el.textContent = spec.replace("Shift+Mod+", "Ctrl+Shift+").replace("Mod+", "Ctrl+");
      }
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

  dom.menuBar.querySelectorAll(".menu-item").forEach((item) => {
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      if (item.classList.contains("disabled")) return;
      const cmd = item.getAttribute("data-cmd");
      closeAllMenus();

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
        openGithub: () => window.openBGR.openGithub(),
      };
      dispatch[cmd]?.();
    });
  });

  window.addEventListener("click", () => closeAllMenus());
})();

// Initialize persisted preferences, default backdrop, format select & server status
applyPreferences();
dom.exportFormatSelect.value = state.exportFormat;
applyBackdrop(state.activeBackdrop);
syncServerStatus(true);

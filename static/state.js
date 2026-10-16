/**
 * Shared studio state, persisted user preferences, DOM registry, and common
 * tab/modal/blob helpers.
 */

export const DOT_TOOLTIPS = {
  ready: "READY OFFLINE — Model weights are cached on disk",
  downloadable: "CAN BE DOWNLOADED — Model will download on 1st run",
  unavailable: "UNAVAILABLE OFFLINE — Model is not cached and device is offline",
};

export const TIER_STATUS_SHORT = {
  ready: "CACHED OFFLINE",
  downloadable: "DOWNLOADS ON 1ST RUN",
  unavailable: "NOT CACHED — DEVICE OFFLINE",
};

export const TIER_META = {
  low: "LITE 1K — BiRefNet_lite · Swin-T @1024px · ~110 MB. Fastest on CPU & integrated GPUs.",
  mid: "FULL 1K — BiRefNet · Swin-L @1024px · ~440 MB. Studio hair, fur & soft alpha.",
  high: "ULTRA 2K — BiRefNet_HR · Swin-L @2K HR. Max detail for 4K/8K photography.",
  matting: "MATTING — BiRefNet-matting. True alpha for glass, smoke & sheer fabric.",
};

export const PRESET_NAMES = {
  low: "LITE 1K",
  mid: "FULL 1K",
  high: "ULTRA 2K",
};

export const FORMAT_EXT = {
  png: "png",
  webp: "webp",
  jpg: "jpg",
  mask: "png",
};

export const ACCENTS = {
  white: ["#fafafa", "#09090b"],
  green: ["#34d399", "#052e1b"],
  blue: ["#60a5fa", "#0b1c3a"],
  amber: ["#fbbf24", "#3a2a05"],
  red: ["#f87171", "#3a0a0a"],
  violet: ["#a78bfa", "#1e1245"],
};

const STORAGE_KEY_CONFIRM_CLOSE = "openbgr_confirm_close_tab";
const STORAGE_KEY_PREFS = "openbgr_prefs";

export function getDefaultPrefs() {
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

const PREF_SCHEMA = {
  theme: { values: ["dark", "light"], fallback: "dark" },
  accent: { values: ["default", ...Object.keys(ACCENTS)], fallback: "default" },
  density: { values: ["comfortable", "compact"], fallback: "comfortable" },
  defaultTier: { values: ["auto", "low", "mid", "high"], fallback: "auto" },
  defaultFormat: { values: ["png", "webp", "jpg", "mask"], fallback: "png" },
  defaultBackdrop: {
    values: ["checker", "#ffffff", "#000000", "#18181b"],
    fallback: "checker",
  },
  confirmClose: { type: "boolean", fallback: true },
};

function sanitizePrefs(stored) {
  const clean = {};
  for (const [key, rule] of Object.entries(PREF_SCHEMA)) {
    const v = stored[key];
    if (rule.type === "boolean") {
      clean[key] = typeof v === "boolean" ? v : rule.fallback;
    } else {
      clean[key] = rule.values.includes(v) ? v : rule.fallback;
    }
  }
  return clean;
}

function loadPrefs() {
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(STORAGE_KEY_PREFS) || "{}");
  } catch (_) {}
  const legacyConfirm = localStorage.getItem(STORAGE_KEY_CONFIRM_CLOSE);
  const clean = sanitizePrefs(typeof stored === "object" && stored ? stored : {});
  if (legacyConfirm !== null) {
    clean.confirmClose = legacyConfirm !== "false";
  }
  return clean;
}

export const prefs = loadPrefs();

export function savePrefs() {
  try {
    localStorage.setItem(STORAGE_KEY_PREFS, JSON.stringify(prefs));
  } catch (_) {}
}

export const masterCutoutImg = new Image();

let nextTabSeq = 1;

export const state = {
  tabs: [],
  activeTabId: null,
  confirmCloseTab: prefs.confirmClose,
  tier: prefs.defaultTier !== "auto" ? prefs.defaultTier : "mid",
  defringe: true,
  despill: true,
  matting: false,
  shadowCutoff: 0,
  viewMode: "split",
  splitPercent: 50,
  isDraggingSplit: false,
  isProcessing: false,
  abortController: null,
  pendingConfirmFn: null,
  pendingAltFn: null,
  sourceFile: null,
  resultBlob: null,
  previewBlob: null,
  originalObjectUrl: null,
  resultObjectUrl: null,
  previewObjectUrl: null,
  previewRenderToken: 0,
  naturalWidth: 0,
  naturalHeight: 0,
  exportFormat: prefs.defaultFormat,
  outputDir: null,
  exportScale: 1,
  exportWidth: 0,
  exportHeight: 0,
  activeBackdrop: prefs.defaultBackdrop,
  zoom: 1,
  panX: 0,
  panY: 0,
  isPanning: false,
  panStartX: 0,
  panStartY: 0,
  spacePressed: false,
  loupeEnabled: false,
  serverStatus: null,
  expectingBatch: false,
  batch: {
    running: false,
    tabId: null,
    total: 0,
    index: 0,
    failed: 0,
    cancelled: false,
    results: [],
  },
  dragTabId: null,
  dragBatchItem: null,
};

export const dom = {
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
  btnModalAlt: document.getElementById("btnModalAlt"),
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
  batchPanel: document.getElementById("batchPanel"),
  batchList: document.getElementById("batchList"),
  batchSub: document.getElementById("batchSub"),
  batchFootText: document.getElementById("batchFootText"),
  btnBatchAdd: document.getElementById("btnBatchAdd"),
  tabContextMenu: document.getElementById("tabContextMenu"),
  btnCopy: document.getElementById("btnCopy"),
  btnDownload: document.getElementById("btnDownload"),
  btnDefringe: document.getElementById("btnDefringe"),
  btnDespill: document.getElementById("btnDespill"),
  btnMatting: document.getElementById("btnMatting"),
  shadowCutoffSlider: document.getElementById("shadowCutoffSlider"),
  shadowCutoffLabel: document.getElementById("shadowCutoffLabel"),

  formatRow: document.getElementById("formatRow"),
  btnFileDest: document.getElementById("btnFileDest"),
  fileDestPath: document.getElementById("fileDestPath"),
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
  statTime: document.getElementById("statTime"),
};

export function getActiveTab() {
  return state.tabs.find((t) => t.id === state.activeTabId) || null;
}

export function defaultTierForNewTab() {
  return prefs.defaultTier !== "auto"
    ? prefs.defaultTier
    : state.serverStatus?.recommended_tier || state.tier;
}

export function createTabRecord(overrides = {}) {
  return {
    id: `tab-${nextTabSeq++}`,
    kind: "image",
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
    despill: state.despill,
    matting: state.matting,
    shadowCutoff: state.shadowCutoff,
    viewMode: "split",
    splitPercent: 50,
    exportFormat: state.exportFormat,
    outputDir: null,
    exportScale: state.exportScale,
    exportWidth: 0,
    exportHeight: 0,
    activeBackdrop: state.activeBackdrop,
    zoom: 1,
    panX: 0,
    panY: 0,
    elapsedText: "—",
    batchFiles: [],
    ...overrides,
  };
}

export function nextClipboardName() {
  return `CLIPBOARD_${nextTabSeq}.PNG`;
}

export function revokeTabUrls(tab) {
  if (!tab) return;
  if (tab.originalObjectUrl) URL.revokeObjectURL(tab.originalObjectUrl);
  if (tab.resultObjectUrl) URL.revokeObjectURL(tab.resultObjectUrl);
  if (tab.previewObjectUrl && tab.previewObjectUrl !== tab.resultObjectUrl) {
    URL.revokeObjectURL(tab.previewObjectUrl);
  }
}

export function saveStateToActiveTab() {
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
  tab.outputDir = state.outputDir;
  tab.exportScale = state.exportScale;
  tab.exportWidth = state.exportWidth;
  tab.exportHeight = state.exportHeight;
  tab.activeBackdrop = state.activeBackdrop;
  tab.zoom = state.zoom;
  tab.panX = state.panX;
  tab.panY = state.panY;
  tab.elapsedText = dom.statTime.textContent;
}

export function setError(message) {
  if (!message) {
    dom.errorToast.classList.remove("visible");
    dom.errorToast.textContent = "";
    return;
  }
  dom.errorToast.textContent = `ERROR // ${message}`;
  dom.errorToast.classList.add("visible");
}

export function openConfirmModal(opts, onConfirm) {
  const cfg = typeof opts === "string" ? { message: opts } : opts;
  if (dom.modalTitle) {
    dom.modalTitle.textContent = cfg.title || "STOP CURRENT IMAGE?";
  }
  dom.modalDesc.textContent = cfg.message;
  dom.btnModalConfirm.textContent = cfg.confirmText || "STOP & CONTINUE";
  dom.btnModalCancel.textContent = cfg.cancelText || "KEEP PROCESSING";
  dom.btnModalCancel.style.display = cfg.hideCancel ? "none" : "";
  if (dom.btnModalAlt) {
    dom.btnModalAlt.style.display = cfg.altText ? "" : "none";
    if (cfg.altText) dom.btnModalAlt.textContent = cfg.altText;
  }
  state.pendingConfirmFn = onConfirm;
  state.pendingAltFn = cfg.altFn || null;
  dom.confirmModal.classList.add("active");
}

export function closeConfirmModal() {
  state.pendingConfirmFn = null;
  state.pendingAltFn = null;
  dom.confirmModal.classList.remove("active");
}

export function triggerOpenFileDialog() {
  dom.fileInput.value = "";
  dom.fileInput.click();
}

export function base64ToBlob(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return new Blob([bytes]);
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = String(reader.result || "");
      resolve(dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export function filesFromDialogResult(res) {
  if (Array.isArray(res?.files) && res.files.length > 0) {
    return res.files.map(
      (f) => new File([base64ToBlob(f.data_b64)], f.name || "image.png")
    );
  }
  if (res?.data_b64) {
    return [new File([base64ToBlob(res.data_b64)], res.name || "image.png")];
  }
  return [];
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function openExternalUrl(url) {
  if (window.pywebview?.api?.open_external) {
    window.pywebview.api.open_external(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

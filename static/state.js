/**
 * Shared studio state, persisted user preferences, DOM registry, and common
 * tab/modal/blob helpers.
 */

export const DOT_TOOLTIPS = {
  ready: "READY OFFLINE: Model weights are cached on disk",
  downloadable: "ON DEMAND: Model downloads on first run",
  unavailable: "OFFLINE: Model is not cached and device is offline",
};

export const TIER_KEYS = [
  "lite",
  "general",
  "hr",
  "portrait",
  "matting",
  "dynamic",
];

const TIER_ALIASES = {
  low: "lite",
  mid: "general",
  full: "general",
  high: "hr",
};

/** Resolves legacy tier keys (`low`/`mid`/`high`) and display labels to a canonical model key. */
export function normalizeTierKey(key) {
  const cleaned = String(key || "").trim().toLowerCase();
  return TIER_ALIASES[cleaned] || cleaned;
}

/** Display names matching the sidebar tier-labels exactly. */
export const PRESET_NAMES = {
  lite: "LITE",
  general: "GENERAL",
  hr: "ULTRA HR",
  portrait: "PORTRAIT",
  matting: "MATTING",
  dynamic: "DYNAMIC",
};

export const FORMAT_EXT = {
  png: "png",
  webp: "webp",
  jpg: "jpg",
  mask: "png",
};

export const FORMAT_LABELS = {
  png: "PNG",
  webp: "WEBP",
  jpg: "JPG",
  mask: "MASK",
};

/** Default Auto-Crop padding: percent of the tight box's longest side. */
export const DEFAULT_CROP_PADDING = 5;

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

/**
 * Per-session API token injected by the server into the served page's
 * `<meta name="openbgr-api-token">`. Mutating `/api/*` endpoints reject
 * requests that lack it, which blocks cross-origin drive-by POSTs.
 */
export const API_TOKEN =
  document
    .querySelector('meta[name="openbgr-api-token"]')
    ?.getAttribute("content") || "";

/** `fetch` wrapper that attaches the session token to every API call. */
export function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (API_TOKEN) headers.set("x-openbgr-token", API_TOKEN);
  return fetch(url, { ...options, headers });
}

/** Extracts the server's `detail` string from a non-OK API response. */
export async function apiErrorDetail(response) {
  let detail = `HTTP ${response.status}`;
  try {
    const payload = await response.json();
    if (payload?.detail) detail = payload.detail;
  } catch (_) {}
  return detail;
}

/** Returns the factory-default preference snapshot (theme, model, filters, export). */
export function getDefaultPrefs() {
  return {
    theme: "dark",
    accent: "default",
    defaultTier: "auto",
    defaultFormat: "png",
    defaultBackdrop: "checker",
    confirmClose: true,
    qaTier: "general",
    qaSaveMode: "same_folder",
    qaFormat: "png",
    qaEdgeRefine: true,
    qaCopyClipboard: false,
    qaNotify: true,
    inferEstimates: {},
  };
}

const PREF_SCHEMA = {
  theme: { values: ["dark", "light"], fallback: "dark" },
  accent: { values: ["default", ...Object.keys(ACCENTS)], fallback: "default" },
  defaultTier: {
    values: ["auto", ...TIER_KEYS],
    fallback: "auto",
  },
  defaultFormat: { values: ["png", "webp", "jpg", "mask"], fallback: "png" },
  defaultBackdrop: {
    values: ["checker", "#ffffff", "#000000", "#18181b"],
    fallback: "checker",
  },
  confirmClose: { type: "boolean", fallback: true },
  qaTier: {
    values: [...TIER_KEYS],
    fallback: "general",
  },
  qaSaveMode: {
    values: ["same_folder", "ask"],
    fallback: "same_folder",
  },
  qaFormat: { values: ["png", "webp", "jpg", "mask"], fallback: "png" },
  qaEdgeRefine: { type: "boolean", fallback: true },
  qaCopyClipboard: { type: "boolean", fallback: false },
  qaNotify: { type: "boolean", fallback: true },
};

/** Validates a stored preference object against the schema; unknown/invalid values fall back to defaults. */
function sanitizePrefs(stored) {
  const clean = {};
  for (const [key, rule] of Object.entries(PREF_SCHEMA)) {
    let v = stored[key];
    if (
      (key === "defaultTier" || key === "qaTier") &&
      typeof v === "string" &&
      v !== "auto"
    ) {
      v = normalizeTierKey(v);
    }
    if (rule.type === "boolean") {
      clean[key] = typeof v === "boolean" ? v : rule.fallback;
    } else {
      clean[key] = rule.values.includes(v) ? v : rule.fallback;
    }
  }
  const est = {};
  if (stored.inferEstimates && typeof stored.inferEstimates === "object") {
    for (const k of TIER_KEYS) {
      const ms = Number(stored.inferEstimates[k]);
      if (Number.isFinite(ms) && ms > 0) est[k] = ms;
    }
  }
  clean.inferEstimates = est;
  return clean;
}

/** Reads preferences from `localStorage`, sanitizes them, and merges over defaults. */
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

/** Updates one preference key and persists the whole object to `localStorage`. */
export function setPref(key, value) {
  prefs[key] = value;
  savePrefs();
}

/** Restores every preference to its factory default and persists it. */
export function resetPrefs() {
  Object.assign(prefs, getDefaultPrefs());
  savePrefs();
}

/**
 * Returns a function `(downloadedBytes, totalBytes) => shownBytes` that
 * extrapolates the last observed download rate between samples, so coarse
 * xet chunk flushes still render as smooth progress.
 */
export function createByteSmoother() {
  let rate = 0;
  let lastBytes = 0;
  let lastAt = 0;
  return (dl, tot) => {
    const now = performance.now();
    if (dl > lastBytes) {
      if (lastAt) {
        const r = (dl - lastBytes) / ((now - lastAt) / 1000);
        rate = rate ? rate * 0.5 + r * 0.5 : r;
      }
      lastBytes = dl;
      lastAt = now;
    }
    return Math.min(
      tot > 0 ? tot : lastBytes,
      lastBytes + rate * ((now - lastAt) / 1000)
    );
  };
}

/** Formats a duration for the elapsed readouts: "34.2s", "2m 05s", "1h 23m". */
export function formatElapsed(ms) {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const totalSec = Math.floor(s);
  const m = Math.floor(totalSec / 60);
  if (m < 60) return `${m}m ${String(totalSec % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Formats a byte count for display (MiB/GiB units). */
export function formatDiskBytes(bytes, compact = false) {
  const n = Number(bytes) || 0;
  const sp = compact ? "" : " ";
  if (n <= 0) return `0${sp}MB`;
  const gb = n / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)}${sp}GB`;
  const mb = n / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)}${sp}MB`;
  return `${Math.max(1, Math.round(n / 1024))}${sp}KB`;
}

/** Live "XMB/YMB" download text per model key, shared by every progress poller. */
const tierDownloadText = new Map();

/** Highest rendered download byte count per model key; displayed progress never regresses. */
const tierDownloadPeak = new Map();

/**
 * Paints live model-download progress onto a sidebar tier button (fill +
 * label). The label's total uses `expectedBytes` (same source as the static
 * label) so the number can't drift mid-download; the fill uses the real
 * downloaded/total ratio.
 */
export function updateTierDownloadUI(key, shownBytes, totBytes, expectedBytes) {
  if (!key) return;
  const peak = Math.max(shownBytes, tierDownloadPeak.get(key) || 0);
  tierDownloadPeak.set(key, peak);
  const totalShown = expectedBytes > 0 ? expectedBytes : totBytes;
  const text =
    totalShown > 0
      ? `${formatDiskBytes(peak, true)}/${formatDiskBytes(totalShown, true)}`
      : formatDiskBytes(peak, true);
  tierDownloadText.set(key, text);
  const tierBtn = document.querySelector(
    `#tierSelector .tier-btn[data-tier="${key}"]`
  );
  if (tierBtn) {
    tierBtn.classList.add("downloading");
    if (totBytes > 0) {
      tierBtn.style.setProperty(
        "--dl",
        `${Math.min(100, (peak / totBytes) * 100)}%`
      );
    }
  }
  const techEl = document.getElementById(`tech-${key}`);
  if (techEl) {
    const name =
      techEl.dataset.name ||
      techEl.textContent.replace(/\s*\([^)]*\)\s*$/, "").trim();
    techEl.textContent = `${name} (${text})`;
  }
}

/** Clears live download progress from a sidebar tier button. */
export function clearTierDownloadProgress(key) {
  if (!key) return;
  tierDownloadText.delete(key);
  tierDownloadPeak.delete(key);
  const tierBtn = document.querySelector(
    `#tierSelector .tier-btn[data-tier="${key}"]`
  );
  if (tierBtn) {
    tierBtn.classList.remove("downloading");
    tierBtn.style.removeProperty("--dl");
  }
}

/** Returns the live "XMB/YMB" label for a downloading model, or null. */
export function getTierDownloadText(key) {
  return tierDownloadText.get(key) || null;
}

/** Persists the current preference object to `localStorage` as JSON. */
export function savePrefs() {
  try {
    localStorage.setItem(STORAGE_KEY_PREFS, JSON.stringify(prefs));
  } catch (err) {
    console.warn("[OpenBGR] Failed to persist preferences:", err);
  }
}

export const masterCutoutImg = new Image();

let nextTabSeq = 1;

/**
 * The single live workspace store. `state` mirrors the active tab's fields
 * (image, result, view, export settings); `saveStateToActiveTab` writes them
 * back into the tab record before a switch. Fields are grouped below by
 * concern so a reader can tell workspace state from transient input state.
 */
export const state = {
  // Tabs & workspace
  tabs: [],
  activeTabId: null,
  confirmCloseTab: prefs.confirmClose,

  // Per-tab mirrored settings (restored on tab switch)
  tier: prefs.defaultTier !== "auto" ? prefs.defaultTier : "general",
  defringe: true,
  despill: true,
  edgeShift: 0,
  edgeFeather: 0,
  shadowCutoff: 0,
  viewMode: "split",
  splitPercent: 50,
  exportFormat: prefs.defaultFormat,
  outputDir: null,
  autoCrop: false,
  cropPadding: DEFAULT_CROP_PADDING,
  exportScale: 1,
  exportWidth: 0,
  exportHeight: 0,
  aspectLocked: true,
  // How the subject fills a mismatched export canvas: "fit" or "stretch".
  canvasFit: "fit",
  activeBackdrop: prefs.defaultBackdrop,
  // Last flat color picked in COLOR backdrop mode, so mode switches restore it.
  backdropColor: prefs.defaultBackdrop.startsWith("#")
    ? prefs.defaultBackdrop
    : "#ffffff",
  // "image" backdrop photo: decoded element, its object URL, and a change
  // counter included in export signatures.
  backdropImg: null,
  backdropImgUrl: null,
  backdropSeq: 0,
  // Blur strength (0-100) applied to the "blur" and "image" backdrops.
  backdropBlur: 50,

  // Active job lifecycle
  isProcessing: false,
  abortController: null,
  pendingConfirmFn: null,
  pendingAltFn: null,
  expectingBatch: false,

  // Edge-refinement coalescing (/api/refine)
  refineJobId: null,
  refineToken: 0,
  refineInFlight: false,
  refinePending: false,

  // Byte-exact export encode cache (honest size label + instant re-export)
  exportCacheBlob: null,
  exportCacheSignature: null,
  exportCacheSource: null,

  // Source image, result, and live-preview blobs/URLs
  sourceFile: null,
  originalObjectUrl: null,
  resultBlob: null,
  resultObjectUrl: null,
  previewBlob: null,
  previewObjectUrl: null,
  previewSignature: null,
  previewSource: null,
  previewRenderToken: 0,
  naturalWidth: 0,
  naturalHeight: 0,

  // Stage view transform
  zoom: 1,
  panX: 0,
  panY: 0,
  isPanning: false,
  panStartX: 0,
  panStartY: 0,
  isDraggingSplit: false,
  loupeEnabled: false,

  // Transient input / capability flags
  spacePressed: false,
  clipboardHasImage: null,
  serverStatus: null,

  // Batch run state (shared; only one run at a time)
  batch: {
    running: false,
    tabId: null,
    total: 0,
    index: 0,
    failed: 0,
    cancelled: false,
    results: [],
    zipWriter: null,
  },

  // Drag-and-drop in flight
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
  cropGuide: document.getElementById("cropGuide"),
  splitLine: document.getElementById("splitLine"),
  lblLeft: document.getElementById("lblLeft"),
  lblRight: document.getElementById("lblRight"),
  loupeCanvas: document.getElementById("loupeCanvas"),

  btnZoomOut: document.getElementById("btnZoomOut"),
  btnZoomReset: document.getElementById("btnZoomReset"),
  btnZoomIn: document.getElementById("btnZoomIn"),
  btnLoupe: document.getElementById("btnLoupe"),

  busyOverlay: document.getElementById("busyOverlay"),
  busyProgressFill: document.getElementById("busyProgressFill"),
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
  accentSwatches: document.getElementById("accentSwatches"),
  prefDefaultTier: document.getElementById("prefDefaultTier"),
  prefDefaultFormat: document.getElementById("prefDefaultFormat"),
  prefDefaultBackdrop: document.getElementById("prefDefaultBackdrop"),
  prefQaTier: document.getElementById("prefQaTier"),
  prefQaSaveMode: document.getElementById("prefQaSaveMode"),
  prefQaFormat: document.getElementById("prefQaFormat"),
  btnToggleQaEdgeRefine: document.getElementById("btnToggleQaEdgeRefine"),
  btnToggleQaClipboard: document.getElementById("btnToggleQaClipboard"),
  btnToggleQaNotify: document.getElementById("btnToggleQaNotify"),
  qaInstallStatusDesc: document.getElementById("qaInstallStatusDesc"),
  btnQaInstallToggle: document.getElementById("btnQaInstallToggle"),
  btnOpenCacheDir: document.getElementById("btnOpenCacheDir"),
  btnOpenLogsDir: document.getElementById("btnOpenLogsDir"),

  fileInput: document.getElementById("fileInput"),
  backdropInput: document.getElementById("backdropInput"),
  btnOpen: document.getElementById("btnOpen"),
  btnProcess: document.getElementById("btnProcess"),
  tierDropdown: document.getElementById("tierDropdown"),
  tierDropdownBtn: document.getElementById("tierDropdownBtn"),
  tierDropdownLabel: document.getElementById("tierDropdownLabel"),
  tierDropdownTech: document.getElementById("tierDropdownTech"),
  batchPanel: document.getElementById("batchPanel"),
  batchList: document.getElementById("batchList"),
  batchSub: document.getElementById("batchSub"),
  batchCheckAll: document.getElementById("batchCheckAll"),
  btnBatchAdd: document.getElementById("btnBatchAdd"),
  btnBatchRetry: document.getElementById("btnBatchRetry"),
  tabContextMenu: document.getElementById("tabContextMenu"),
  btnCopy: document.getElementById("btnCopy"),
  btnDownload: document.getElementById("btnDownload"),
  btnDefringe: document.getElementById("btnDefringe"),
  btnDespill: document.getElementById("btnDespill"),
  shadowCutoffSlider: document.getElementById("shadowCutoffSlider"),
  shadowCutoffLabel: document.getElementById("shadowCutoffLabel"),
  edgeShiftSlider: document.getElementById("edgeShiftSlider"),
  edgeShiftLabel: document.getElementById("edgeShiftLabel"),
  edgeFeatherSlider: document.getElementById("edgeFeatherSlider"),
  edgeFeatherLabel: document.getElementById("edgeFeatherLabel"),
  btnFileDest: document.getElementById("btnFileDest"),
  btnAutoCrop: document.getElementById("btnAutoCrop"),
  cropPaddingWrap: document.getElementById("cropPaddingWrap"),
  cropPaddingSlider: document.getElementById("cropPaddingSlider"),
  cropPaddingLabel: document.getElementById("cropPaddingLabel"),

  exportScaleSlider: document.getElementById("exportScaleSlider"),
  scalePctLabel: document.getElementById("scalePctLabel"),
  exportWidthInput: document.getElementById("exportWidthInput"),
  exportHeightInput: document.getElementById("exportHeightInput"),
  aspectLockBtn: document.getElementById("aspectLockBtn"),
  presetReset: document.getElementById("presetReset"),
  canvasFitChips: document.getElementById("canvasFitChips"),
  matteSwatches: document.getElementById("matteSwatches"),
  colorPicker: document.getElementById("colorPicker"),
  backdropPhotoWrap: document.getElementById("backdropPhotoWrap"),
  backdropPhotoThumb: document.getElementById("backdropPhotoThumb"),
  btnBackdropPhoto: document.getElementById("btnBackdropPhoto"),
  btnBackdropPhotoRemove: document.getElementById("btnBackdropPhotoRemove"),
  backdropBlurWrap: document.getElementById("backdropBlurWrap"),
  backdropBlurSlider: document.getElementById("backdropBlurSlider"),
  backdropBlurLabel: document.getElementById("backdropBlurLabel"),
  fileDestPath: document.getElementById("fileDestPath"),
  exportSizeLabel: document.getElementById("exportSizeLabel"),

  hwCompute: document.getElementById("hwCompute"),
  hwPrecision: document.getElementById("hwPrecision"),
  hwMemory: document.getElementById("hwMemory"),
  aboutVersion: document.getElementById("aboutVersion"),
  statusVersion: document.getElementById("statusVersion"),
  btnPrefsCloseX: document.getElementById("btnPrefsCloseX"),
  statFile: document.getElementById("statFile"),
  statDim: document.getElementById("statDim"),
  statTime: document.getElementById("statTime"),
};

/** Returns the currently active tab record, or `null` in the empty workspace. */
export function getActiveTab() {
  return state.tabs.find((t) => t.id === state.activeTabId) || null;
}

/** Resolves which model key a newly created tab should inherit. */
export function defaultTierForNewTab() {
  return prefs.defaultTier !== "auto"
    ? prefs.defaultTier
    : state.serverStatus?.recommended_tier || state.tier;
}

/** Allocates a fresh tab record (image, result, zoom, batch state) with optional overrides. */
export function createTabRecord(overrides = {}) {
  return {
    id: `tab-${nextTabSeq++}`,
    kind: "image",
    name: "NEW TAB",
    sourceFile: null,
    originalObjectUrl: null,
    resultBlob: null,
    refineJobId: null,
    resultObjectUrl: null,
    previewBlob: null,
    previewObjectUrl: null,
    previewSignature: null,
    previewSource: null,
    naturalWidth: 0,
    naturalHeight: 0,
    tier: state.tier,
    defringe: state.defringe,
    despill: state.despill,
    edgeShift: state.edgeShift,
    edgeFeather: state.edgeFeather,
    shadowCutoff: state.shadowCutoff,
    viewMode: "split",
    splitPercent: 50,
    exportFormat: state.exportFormat,
    outputDir: null,
    autoCrop: state.autoCrop,
    cropPadding: state.cropPadding,
    exportScale: state.exportScale,
    exportWidth: 0,
    exportHeight: 0,
    aspectLocked: true,
    canvasFit: state.canvasFit,
    activeBackdrop: state.activeBackdrop,
    backdropColor: state.backdropColor,
    backdropImg: state.backdropImg,
    backdropImgUrl: state.backdropImgUrl,
    backdropSeq: state.backdropSeq,
    backdropBlur: state.backdropBlur,
    exportCacheBlob: null,
    exportCacheSignature: null,
    exportCacheSource: null,
    zoom: 1,
    panX: 0,
    panY: 0,
    elapsedText: "--",
    batchFiles: [],
    ...overrides,
  };
}

/** Generates sequential `Pasted Image N` names for clipboard-ingested images. */
export function nextClipboardName() {
  return `CLIPBOARD_${nextTabSeq}.PNG`;
}

/**
 * Clears the result/preview/dimension fields of the live `state` object.
 * Shared by workspace resets and new ingests so the two can't drift (ingest
 * previously left a stale `previewSource` blob pinned from the last image).
 */
export function clearResultState() {
  state.resultBlob = null;
  state.refineJobId = null;
  state.previewBlob = null;
  state.previewSignature = null;
  state.previewSource = null;
  state.exportCacheBlob = null;
  state.exportCacheSignature = null;
  state.exportCacheSource = null;
  state.resultObjectUrl = null;
  state.previewObjectUrl = null;
  state.naturalWidth = 0;
  state.naturalHeight = 0;
  state.exportWidth = 0;
  state.exportHeight = 0;
}

/** Revokes all `blob:` object URLs owned by a tab before it is discarded. */
export function revokeTabUrls(tab) {
  if (!tab) return;
  if (tab.originalObjectUrl) URL.revokeObjectURL(tab.originalObjectUrl);
  if (tab.resultObjectUrl) URL.revokeObjectURL(tab.resultObjectUrl);
  if (tab.previewObjectUrl && tab.previewObjectUrl !== tab.resultObjectUrl) {
    URL.revokeObjectURL(tab.previewObjectUrl);
  }
}

/** Snapshots the live global state (model, view, filters, result) back into the active tab record. */
export function saveStateToActiveTab() {
  const tab = getActiveTab();
  if (!tab) return;
  tab.tier = state.tier;
  tab.defringe = state.defringe;
  tab.despill = state.despill;
  tab.edgeShift = state.edgeShift;
  tab.edgeFeather = state.edgeFeather;
  tab.shadowCutoff = state.shadowCutoff;
  tab.viewMode = state.viewMode;
  tab.splitPercent = state.splitPercent;
  tab.resultBlob = state.resultBlob;
  tab.refineJobId = state.refineJobId;
  tab.previewBlob = state.previewBlob;
  tab.previewSignature = state.previewSignature;
  tab.previewSource = state.previewSource;
  tab.exportCacheBlob = state.exportCacheBlob;
  tab.exportCacheSignature = state.exportCacheSignature;
  tab.exportCacheSource = state.exportCacheSource;
  tab.resultObjectUrl = state.resultObjectUrl;
  tab.previewObjectUrl = state.previewObjectUrl;
  tab.naturalWidth = state.naturalWidth;
  tab.naturalHeight = state.naturalHeight;
  tab.exportFormat = state.exportFormat;
  tab.outputDir = state.outputDir;
  tab.autoCrop = state.autoCrop;
  tab.cropPadding = state.cropPadding;
  tab.exportScale = state.exportScale;
  tab.exportWidth = state.exportWidth;
  tab.exportHeight = state.exportHeight;
  tab.aspectLocked = state.aspectLocked;
  tab.canvasFit = state.canvasFit;
  tab.activeBackdrop = state.activeBackdrop;
  tab.backdropColor = state.backdropColor;
  tab.backdropImg = state.backdropImg;
  tab.backdropImgUrl = state.backdropImgUrl;
  tab.backdropSeq = state.backdropSeq;
  tab.backdropBlur = state.backdropBlur;
  tab.zoom = state.zoom;
  tab.panX = state.panX;
  tab.panY = state.panY;
  tab.elapsedText = dom.statTime.textContent;
}

let errorCopyResetTimer = null;
let toastHideTimer = null;

/** Shows (or clears, with empty message) the transient error toast. */
export function setError(message, ms = 10000) {
  clearTimeout(toastHideTimer);
  if (!message) {
    dom.errorToast.classList.remove("visible", "success");
    dom.errorToast.textContent = "";
    delete dom.errorToast.dataset.raw;
    delete dom.errorToast.dataset.kind;
    return;
  }
  dom.errorToast.classList.remove("success");
  dom.errorToast.dataset.raw = message;
  dom.errorToast.dataset.kind = "error";
  dom.errorToast.textContent = `ERROR: ${message}`;
  dom.errorToast.classList.add("visible");
  toastHideTimer = setTimeout(() => setError(null), ms);
}

/** Shows a transient green success toast that auto-hides after `ms`. */
export function setSuccess(message, ms = 5000) {
  dom.errorToast.dataset.raw = message;
  dom.errorToast.dataset.kind = "success";
  dom.errorToast.classList.add("success");
  dom.errorToast.textContent = message;
  dom.errorToast.classList.add("visible");
  clearTimeout(toastHideTimer);
  toastHideTimer = setTimeout(() => {
    if (dom.errorToast.dataset.kind === "success") setError(null);
  }, ms);
}

/** Copies `text` to the clipboard; resolves false if every method failed. */
async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {}
  }
  // Fallback for contexts where the async Clipboard API is unavailable.
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    return document.execCommand("copy");
  } catch (_) {
    return false;
  } finally {
    ta.remove();
  }
}

/** Clicking (or Enter/Space on) the toast copies its message and flashes a sweep. */
function handleErrorToastCopy() {
  const raw = dom.errorToast.dataset.raw;
  if (!raw) return;
  copyTextToClipboard(raw).then((ok) => {
    if (!ok) return;
    dom.errorToast.classList.remove("copied");
    void dom.errorToast.offsetWidth; // restart the sweep animation
    dom.errorToast.classList.add("copied");
    clearTimeout(errorCopyResetTimer);
    errorCopyResetTimer = setTimeout(() => {
      dom.errorToast.classList.remove("copied");
    }, 900);
  });
}

dom.errorToast?.addEventListener("click", handleErrorToastCopy);
dom.errorToast?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    handleErrorToastCopy();
  }
});

let lastConfirmFocus = null;

/** Opens the destructive-action confirm modal and stashes its confirm callback. */
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
  lastConfirmFocus =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  dom.confirmModal.classList.add("active");
  dom.btnModalConfirm?.focus?.();
}

/** Dismisses the confirm modal and drops the pending callback. */
export function closeConfirmModal() {
  state.pendingConfirmFn = null;
  state.pendingAltFn = null;
  dom.confirmModal.classList.remove("active");
  if (lastConfirmFocus && document.contains(lastConfirmFocus)) {
    lastConfirmFocus.focus?.();
  }
  lastConfirmFocus = null;
}

/** Programmatically clicks the hidden file input (or the native dialog via `openBGR.openImage`). */
export function triggerOpenFileDialog() {
  dom.fileInput.value = "";
  dom.fileInput.click();
}

/** Decodes a base64 data payload into a typed `Blob`. */
export function base64ToBlob(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return new Blob([bytes]);
}

/** Encodes a `Blob` as a raw base64 string (no `data:` prefix). */
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

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i;

/** True for image files by MIME type, with an extension check for empty types. */
export function isImageFile(f) {
  return Boolean(
    f && (f.type?.startsWith("image/") || IMAGE_EXT_RE.test(f.name || ""))
  );
}

/**
 * Normalizes a native-dialog result into an array of `File`s. Entries carry a
 * one-shot `file_id` whose bytes stream over HTTP from the local server;
 * legacy `{data_b64}` payloads (clipboard reads) are decoded inline.
 */
export async function filesFromDialogResult(res) {
  const entries = Array.isArray(res?.files)
    ? res.files
    : res?.file_id || res?.data_b64
      ? [res]
      : [];
  const files = await Promise.all(
    entries.map(async (entry) => {
      if (entry.file_id) {
        try {
          const r = await fetch(
            `/api/local-file?file_id=${encodeURIComponent(entry.file_id)}`
          );
          if (r.ok) {
            return new File([await r.blob()], entry.name || "image.png");
          }
          console.warn(
            `[OpenBGR] Local file grant ${entry.file_id} failed: HTTP ${r.status}`
          );
        } catch (err) {
          console.warn("[OpenBGR] Local file fetch failed:", err);
        }
        return null;
      }
      if (entry.data_b64) {
        return new File(
          [base64ToBlob(entry.data_b64)],
          entry.name || "image.png"
        );
      }
      return null;
    })
  );
  return files.filter(Boolean);
}

/** Browser-mode fallback: triggers an anchor download for a blob. */
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

/** Opens an external URL via the native bridge when present, else `window.open`. */
export function openExternalUrl(url) {
  if (window.pywebview?.api?.open_external) {
    window.pywebview.api.open_external(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

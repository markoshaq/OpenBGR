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

/** Returns the factory-default preference snapshot (theme, model, filters, export). */
export function getDefaultPrefs() {
  return {
    theme: "dark",
    accent: "default",
    defaultTier: "auto",
    defaultFormat: "png",
    defaultBackdrop: "checker",
    confirmClose: true,
    qaTier: "auto",
    qaSaveMode: "same_folder",
    qaFormat: "png",
    qaEdgeRefine: true,
    qaCopyClipboard: false,
    qaNotify: true,
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
    values: ["auto", ...TIER_KEYS],
    fallback: "auto",
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
  } catch (_) {}
}

export const masterCutoutImg = new Image();

let nextTabSeq = 1;

export const state = {
  tabs: [],
  activeTabId: null,
  confirmCloseTab: prefs.confirmClose,
  tier: prefs.defaultTier !== "auto" ? prefs.defaultTier : "general",
  defringe: true,
  despill: true,
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
  refineJobId: null,
  refineToken: 0,
  previewBlob: null,
  previewSignature: null,
  previewSource: null,
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
  aspectLocked: true,
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
  shadowCutoffSlider: document.getElementById("shadowCutoffSlider"),
  shadowCutoffLabel: document.getElementById("shadowCutoffLabel"),

  formatRow: document.getElementById("formatRow"),
  btnFileDest: document.getElementById("btnFileDest"),

  exportScaleSlider: document.getElementById("exportScaleSlider"),
  scalePctLabel: document.getElementById("scalePctLabel"),
  exportWidthInput: document.getElementById("exportWidthInput"),
  exportHeightInput: document.getElementById("exportHeightInput"),
  aspectLockBtn: document.getElementById("aspectLockBtn"),
  fileDestPath: document.getElementById("fileDestPath"),

  hwCompute: document.getElementById("hwCompute"),
  hwPrecision: document.getElementById("hwPrecision"),
  hwMemory: document.getElementById("hwMemory"),
  prefsVersion: document.getElementById("prefsVersion"),
  sysVersion: document.getElementById("sysVersion"),
  aboutVersion: document.getElementById("aboutVersion"),
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
    elapsedText: "--",
    batchFiles: [],
    ...overrides,
  };
}

/** Generates sequential `Pasted Image N` names for clipboard-ingested images. */
export function nextClipboardName() {
  return `CLIPBOARD_${nextTabSeq}.PNG`;
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
  tab.shadowCutoff = state.shadowCutoff;
  tab.viewMode = state.viewMode;
  tab.splitPercent = state.splitPercent;
  tab.resultBlob = state.resultBlob;
  tab.refineJobId = state.refineJobId;
  tab.previewBlob = state.previewBlob;
  tab.previewSignature = state.previewSignature;
  tab.previewSource = state.previewSource;
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

let errorCopyResetTimer = null;
let successHideTimer = null;

/** Shows (or clears, with empty message) the transient error toast. */
export function setError(message) {
  if (!message) {
    dom.errorToast.classList.remove("visible", "success");
    dom.errorToast.textContent = "";
    delete dom.errorToast.dataset.raw;
    delete dom.errorToast.dataset.kind;
    return;
  }
  clearTimeout(successHideTimer);
  dom.errorToast.classList.remove("success");
  dom.errorToast.dataset.raw = message;
  dom.errorToast.dataset.kind = "error";
  dom.errorToast.textContent = `ERROR: ${message}`;
  dom.errorToast.classList.add("visible");
}

/** Shows a transient green success toast that auto-hides after `ms`. */
export function setSuccess(message, ms = 5000) {
  dom.errorToast.dataset.raw = message;
  dom.errorToast.dataset.kind = "success";
  dom.errorToast.classList.add("success");
  dom.errorToast.textContent = message;
  dom.errorToast.classList.add("visible");
  clearTimeout(successHideTimer);
  successHideTimer = setTimeout(() => {
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

/** Clicking (or Enter/Space on) the error toast copies its message to the clipboard. */
function handleErrorToastCopy() {
  const raw = dom.errorToast.dataset.raw;
  if (!raw) return;
  copyTextToClipboard(raw).then((ok) => {
    if (!ok) return;
    dom.errorToast.textContent = "COPIED TO CLIPBOARD";
    clearTimeout(errorCopyResetTimer);
    errorCopyResetTimer = setTimeout(() => {
      if (dom.errorToast.dataset.raw) {
        dom.errorToast.textContent =
          dom.errorToast.dataset.kind === "success"
            ? dom.errorToast.dataset.raw
            : `ERROR: ${dom.errorToast.dataset.raw}`;
      }
    }, 1200);
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

/** Normalizes a native-dialog result into an array of `{name, blob}` entries. */
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

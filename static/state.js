/**
 * Shared studio workspace state, tab record helpers, toast/modal state, and
 * file/blob utilities. Constants, preferences, formatting helpers, and the
 * lazy DOM registry live in `prefs.js`, `format.js`, and `dom.js` and are
 * re-exported here for callers that import from `state.js`.
 * Importing this module has no side effects.
 */

import { dom, DOM_IDS } from "./dom.js";
import {
  DOT_TOOLTIPS,
  TIER_KEYS,
  TIER_ALIASES,
  normalizeTierKey,
  PRESET_NAMES,
  FORMAT_EXT,
  FORMAT_LABELS,
  DEFAULT_CROP_PADDING,
  ACCENTS,
  getDefaultPrefs,
  loadPrefs,
  prefs,
  setPref,
  resetPrefs,
  savePrefs,
} from "./prefs.js";
import {
  createByteSmoother,
  formatElapsed,
  formatDiskBytes,
  updateTierDownloadUI,
  clearTierDownloadProgress,
  getTierDownloadText,
} from "./format.js";

export {
  dom,
  DOM_IDS,
  DOT_TOOLTIPS,
  TIER_KEYS,
  TIER_ALIASES,
  normalizeTierKey,
  PRESET_NAMES,
  FORMAT_EXT,
  FORMAT_LABELS,
  DEFAULT_CROP_PADDING,
  ACCENTS,
  getDefaultPrefs,
  loadPrefs,
  prefs,
  setPref,
  resetPrefs,
  savePrefs,
  createByteSmoother,
  formatElapsed,
  formatDiskBytes,
  updateTierDownloadUI,
  clearTierDownloadProgress,
  getTierDownloadText,
};

/**
 * Resolves the per-session API token injected by the server into the served
 * page's `<meta name="openbgr-api-token">` lazily at request time.
 */
export function getApiToken() {
  return (
    globalThis.document
      ?.querySelector?.('meta[name="openbgr-api-token"]')
      ?.getAttribute("content") || ""
  );
}

/** `fetch` wrapper that attaches the session token to every API call. */
export function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  const token = getApiToken();
  if (token) headers.set("x-openbgr-token", token);
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

export const masterCutoutImg =
  typeof Image !== "undefined" ? new Image() : { onload: null, onerror: null, src: "" };

let nextTabSeq = 1;
let nextClipboardSeq = 1;

/**
 * The single live workspace store. `state` mirrors the active tab's fields
 * (image, result, view, export settings); `saveStateToActiveTab` writes them
 * back into the tab record before a switch.
 */
export const state = {
  // Tabs & workspace
  tabs: [],
  activeTabId: null,
  // Recently closed tab records for File > Reopen Closed Tab (newest last).
  closedTabs: [],
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
  // Last elapsed-time readout for the active tab; mirrored to `dom.statTime`
  // by `setStatElapsed` and snapshotted back onto the tab by
  // `saveStateToActiveTab`.
  elapsedText: "--",

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

  // Multi-frame animation (GIF / animated WebP) state
  isAnimated: false,
  frames: [],
  currentFrameIndex: 0,
  animPlaying: false,
  startFrame: 1,
  endFrame: 1,

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
    failed: 0,
    cancelled: false,
    results: [],
    zipWriter: null,
  },

  // Drag-and-drop in flight
  dragTabId: null,
  dragBatchItem: null,
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

/**
 * Sidebar defaults for a brand-new tab or a freshly ingested image: every
 * processing and export control starts clean instead of inheriting whatever
 * the previous tab had dialed in. The chosen output folder is not a
 * per-image setting and stays.
 */
export function freshTabSettings() {
  return {
    tier: defaultTierForNewTab(),
    defringe: true,
    despill: true,
    edgeShift: 0,
    edgeFeather: 0,
    shadowCutoff: 0,
    exportFormat: prefs.defaultFormat,
    autoCrop: false,
    cropPadding: DEFAULT_CROP_PADDING,
    exportScale: 1,
    aspectLocked: true,
    canvasFit: "fit",
    activeBackdrop: prefs.defaultBackdrop,
    backdropColor: prefs.defaultBackdrop.startsWith("#")
      ? prefs.defaultBackdrop
      : "#ffffff",
    backdropImg: null,
    backdropImgUrl: null,
    backdropSeq: 0,
    backdropBlur: 50,
  };
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
    isAnimated: false,
    frames: [],
    currentFrameIndex: 0,
    startFrame: 1,
    endFrame: 1,
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
    aspectLocked: state.aspectLocked,
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

/** Generates sequential `CLIPBOARD_N.PNG` fallback names for pasted images. */
export function nextClipboardName() {
  return `CLIPBOARD_${nextClipboardSeq++}.PNG`;
}

/**
 * Clears the result/preview/dimension fields of the live `state` object.
 * Shared by workspace resets and new ingests so the two can't drift.
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
  if (Array.isArray(tab.frames)) {
    for (const f of tab.frames) {
      if (f?.originalObjectUrl) URL.revokeObjectURL(f.originalObjectUrl);
      if (f?.resultObjectUrl) URL.revokeObjectURL(f.resultObjectUrl);
      if (f?.previewObjectUrl && f.previewObjectUrl !== f.resultObjectUrl) {
        URL.revokeObjectURL(f.previewObjectUrl);
      }
    }
  }
}

/** Snapshots the live global state (model, view, filters, result) back into the active tab record. */
export function saveStateToActiveTab() {
  const tab = getActiveTab();
  if (!tab) return;
  if (state.isAnimated && state.frames[state.currentFrameIndex]) {
    const cur = state.frames[state.currentFrameIndex];
    cur.resultBlob = state.resultBlob;
    cur.resultObjectUrl = state.resultObjectUrl;
    cur.previewBlob = state.previewBlob;
    cur.previewObjectUrl = state.previewObjectUrl;
    cur.previewSignature = state.previewSignature;
    cur.refineJobId = state.refineJobId;
  }
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
  tab.isAnimated = state.isAnimated;
  tab.frames = state.frames;
  tab.currentFrameIndex = state.currentFrameIndex;
  tab.startFrame = state.startFrame;
  tab.endFrame = state.endFrame;
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
  tab.elapsedText = state.elapsedText;
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
export function setSuccess(message, ms = 5000, action = null) {
  dom.errorToast.dataset.raw = message;
  dom.errorToast.dataset.kind = "success";
  dom.errorToast.classList.add("success");
  dom.errorToast.textContent = message;
  if (action?.label && typeof action.fn === "function") {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toast-action";
    btn.textContent = action.label;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      action.fn();
    });
    dom.errorToast.appendChild(btn);
  }
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
export function handleErrorToastCopy() {
  const raw = dom.errorToast.dataset.raw;
  if (!raw) return;
  copyTextToClipboard(raw).then((ok) => {
    if (!ok) return;
    dom.errorToast.classList.remove("copied");
    void dom.errorToast.offsetWidth;
    dom.errorToast.classList.add("copied");
    clearTimeout(errorCopyResetTimer);
    errorCopyResetTimer = setTimeout(() => {
      dom.errorToast.classList.remove("copied");
    }, 900);
  });
}

let lastConfirmFocus = null;

/** Writes the elapsed-time telemetry readout into live state and the bar. */
export function setStatElapsed(text) {
  state.elapsedText = text;
  if (dom.statTime) dom.statTime.textContent = text;
}

/** Opens the destructive-action confirm modal and stashes its confirm callback. */
export function openConfirmModal(opts, onConfirm) {
  if (dom.modalTitle) {
    dom.modalTitle.textContent = opts.title || "STOP CURRENT IMAGE?";
  }
  dom.modalDesc.textContent = opts.message;
  dom.btnModalConfirm.textContent = opts.confirmText || "STOP & CONTINUE";
  dom.btnModalCancel.textContent = opts.cancelText || "KEEP PROCESSING";
  dom.btnModalCancel.style.display = opts.hideCancel ? "none" : "";
  if (dom.btnModalAlt) {
    dom.btnModalAlt.style.display = opts.altText ? "" : "none";
    if (opts.altText) dom.btnModalAlt.textContent = opts.altText;
  }
  state.pendingConfirmFn = onConfirm;
  state.pendingAltFn = opts.altFn || null;
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

/**
 * Resolves the trimmed `[startFrame, endFrame]` slice of `frames`, clamped to
 * the loaded range. `requireProcessed` throws naming the first unprocessed
 * frame; used by export paths that need every frame rendered.
 */
export function trimmedFrameSlice(frames, { requireProcessed = false } = {}) {
  const total = frames.length;
  const startIdx = Math.max(0, Math.min(total - 1, (state.startFrame || 1) - 1));
  const endIdx = Math.max(
    startIdx,
    Math.min(total - 1, (state.endFrame || total) - 1)
  );
  const slice = frames.slice(startIdx, endIdx + 1);
  if (requireProcessed) {
    const missing = slice.findIndex((frm) => !frm.resultBlob);
    if (missing >= 0) {
      throw new Error(
        `Frame ${startIdx + missing + 1} is not processed yet. Run PROCESS GIF first.`
      );
    }
  }
  return { slice, startIdx, endIdx };
}

/**
 * Resolves the element used to fill the canvas under "blur"/"image" backdrops
 * for the ACTIVE tab: the stage's original photo for "blur", the chosen
 * backdrop photo for "image". Anything else resolves to no backdrop.
 */
export function resolveBackdropSource() {
  if (state.activeBackdrop === "blur") {
    return dom.beforeImg?.naturalWidth ? dom.beforeImg : null;
  }
  if (state.activeBackdrop === "image") {
    return state.backdropImg?.naturalWidth ? state.backdropImg : null;
  }
  return null;
}

/**
 * True when the export is a pixel passthrough: PNG at native size with a
 * checker backdrop, no auto-crop and no shadow cutoff, so the pipeline
 * output ships unchanged.
 */
export function isPassthroughExport({
  format,
  targetW,
  targetH,
  srcW,
  srcH,
  autoCrop,
  backdrop,
  shadowCutoff,
}) {
  return (
    !autoCrop &&
    format === "png" &&
    targetW === srcW &&
    targetH === srcH &&
    backdrop === "checker" &&
    shadowCutoff === 0
  );
}

/**
 * Resolves the backdrop source for a per-file render (batch entries and
 * animation frames): for "blur" a new ImageBitmap decoded from `sourceFile`
 * that the caller must close via `ownedBitmap`; for "image" the shared
 * backdrop photo, borrowed. Anything else resolves to no backdrop.
 */
export async function resolveFileBackdropSource(backdrop, sourceFile, backdropImg) {
  if (backdrop === "blur" && sourceFile) {
    const ownedBitmap = await createImageBitmap(sourceFile);
    return { backdropSource: ownedBitmap, ownedBitmap };
  }
  if (backdrop === "image") {
    const img = backdropImg?.naturalWidth ? backdropImg : null;
    return { backdropSource: img, ownedBitmap: null };
  }
  return { backdropSource: null, ownedBitmap: null };
}

/**
 * Opens the shared context menu (`#tabContextMenu`) at viewport point (x, y):
 * clears it, lets `build` append `.item(label, fn, disabled?)`, `.sep()`,
 * and `.head(label)` entries, then clamps it inside the viewport. Item clicks
 * hide the menu before running their handler; separators before the first
 * item are dropped. Returns false when nothing was built.
 */
export function openContextMenu(x, y, build) {
  const menu = dom.tabContextMenu;
  if (!menu) return false;
  menu.replaceChildren();
  const api = {
    item(label, fn, disabled = false) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `ctx-item${disabled ? " ctx-disabled" : ""}`;
      b.textContent = label;
      if (!disabled) {
        b.addEventListener("click", () => {
          menu.style.display = "none";
          fn();
        });
      }
      menu.appendChild(b);
    },
    sep() {
      if (!menu.children.length) return;
      const s = document.createElement("div");
      s.className = "ctx-sep";
      menu.appendChild(s);
    },
    head(label) {
      const h = document.createElement("div");
      h.className = "ctx-head";
      h.textContent = label;
      menu.appendChild(h);
    },
  };
  build(api);
  if (!menu.children.length) return false;
  menu.style.display = "block";
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
  return true;
}

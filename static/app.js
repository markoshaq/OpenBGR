/**
 * REMOVEBG — Frontend Studio Controller
 * =====================================
 * Handles hardware preset switching, drag-and-drop / clipboard image ingestion,
 * split-plane comparison rendering, active request cancellation, client-side
 * multi-format / multi-resolution export, and communication with the local
 * FastAPI segmentation backend.
 */

"use strict";

/** Application State */
const state = {
  tier: "mid",             // "low" (BiRefNet_lite 1K) | "mid" (BiRefNet Full 1K) | "high" (BiRefNet_HR 2K)
  defringe: true,          // Morphological edge color decontamination toggle
  viewMode: "split",       // "split" | "cutout" | "original"
  splitPercent: 50,        // Horizontal divider position (0 - 100)
  isDraggingSplit: false,  // Pointer drag state for split comparator
  isProcessing: false,     // Whether an inference request is currently in-flight
  abortController: null,   // AbortController for the active fetch request
  pendingConfirmFn: null,  // Callback to execute if user confirms interrupting active processing
  sourceFile: null,        // Active File/Blob object
  resultBlob: null,        // Latest segmented master 32-bit RGBA PNG Blob
  originalObjectUrl: null, // Object URL for source preview
  resultObjectUrl: null,   // Object URL for cutout preview
  naturalWidth: 0,         // Native pixel width of active cutout
  naturalHeight: 0,        // Native pixel height of active cutout
  exportFormat: "png",     // "png" | "webp" | "jpg" | "mask"
  exportScale: 1,          // 1 (100%) | 0.5 (50%) | 0.25 (25%)
  activeBackdrop: "checker", // "checker" or hex color string (e.g. "#ffffff")
  serverStatus: null,      // Cached response from GET /api/status
};

/** DOM Element References */
const dom = {
  viewport: document.getElementById("viewport"),
  emptyState: document.getElementById("emptyState"),
  stage: document.getElementById("stage"),
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
  modalDesc: document.getElementById("modalDesc"),
  btnModalCancel: document.getElementById("btnModalCancel"),
  btnModalConfirm: document.getElementById("btnModalConfirm"),

  infoModal: document.getElementById("infoModal"),
  btnInfo: document.getElementById("btnInfo"),
  btnInfoClose: document.getElementById("btnInfoClose"),

  fileInput: document.getElementById("fileInput"),
  btnOpen: document.getElementById("btnOpen"),
  btnCopy: document.getElementById("btnCopy"),
  btnDownload: document.getElementById("btnDownload"),
  btnDefringe: document.getElementById("btnDefringe"),

  hwCompute: document.getElementById("hwCompute"),
  hwCache: document.getElementById("hwCache"),
  statFile: document.getElementById("statFile"),
  statDim: document.getElementById("statDim"),
  statTier: document.getElementById("statTier"),
  statTime: document.getElementById("statTime"),
};

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
 * Opens the confirmation dialog before interrupting an active inference job.
 * @param {string} message
 * @param {() => void} onConfirm
 */
function openConfirmModal(message, onConfirm) {
  dom.modalDesc.textContent = message;
  state.pendingConfirmFn = onConfirm;
  dom.confirmModal.classList.add("active");
}

/**
 * Closes the confirmation dialog without interrupting the active job.
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
}

/**
 * Updates the header badge showing whether the active tier's weights are
 * already cached on disk for offline execution.
 */
function updateCacheIndicator() {
  const tierInfo = state.serverStatus?.tiers?.[state.tier];
  if (!tierInfo) return;
  dom.hwCache.textContent = tierInfo.cached
    ? "READY OFFLINE"
    : "DOWNLOADS ON 1ST RUN";
}

/**
 * Updates the DIMENSIONS status readout and EXPORT button label based on
 * the currently selected `exportFormat` and `exportScale`.
 */
function updateExportTelemetry() {
  dom.btnDownload.textContent = `EXPORT ${state.exportFormat.toUpperCase()}`;

  if (state.naturalWidth > 0 && state.naturalHeight > 0) {
    const outW = Math.max(1, Math.round(state.naturalWidth * state.exportScale));
    const outH = Math.max(1, Math.round(state.naturalHeight * state.exportScale));
    const scalePct = Math.round(state.exportScale * 100);
    dom.statDim.textContent =
      state.exportScale === 1
        ? `${outW}×${outH} PX`
        : `${outW}×${outH} PX (${scalePct}%)`;
  }
}

/**
 * Renders the master segmented image onto an offscreen canvas at the target
 * `exportScale` and `exportFormat` ("png", "webp", "jpg", or "mask") and
 * returns a Promise resolving to the encoded Blob.
 *
 * @param {"png"|"webp"|"jpg"|"mask"} format
 * @param {number} scale
 * @returns {Promise<Blob>}
 */
async function buildExportBlob(format, scale) {
  // Fast path: 100% scale, transparent PNG with no solid matte backdrop.
  if (
    format === "png" &&
    scale === 1 &&
    state.activeBackdrop === "checker" &&
    state.resultBlob
  ) {
    return state.resultBlob;
  }

  const img = dom.afterImg;
  const srcW = state.naturalWidth || img.naturalWidth;
  const srcH = state.naturalHeight || img.naturalHeight;
  const targetW = Math.max(1, Math.round(srcW * scale));
  const targetH = Math.max(1, Math.round(srcH * scale));

  const canvas = document.createElement("canvas");
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  if (format === "mask") {
    // Draw cutout and convert its alpha channel into an 8-bit grayscale mask.
    ctx.drawImage(img, 0, 0, targetW, targetH);
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

  // Fill background color if exporting JPEG or if user selected a solid Matte swatch.
  if (format === "jpg" || state.activeBackdrop !== "checker") {
    ctx.fillStyle =
      state.activeBackdrop === "checker" ? "#ffffff" : state.activeBackdrop;
    ctx.fillRect(0, 0, targetW, targetH);
  }

  ctx.drawImage(img, 0, 0, targetW, targetH);

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
  document.querySelectorAll("#tierSelector .seg-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-tier") === tierKey);
  });
  updateCacheIndicator();

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
 * Loads a user-supplied image File or clipboard Blob into the workspace
 * and triggers background removal.
 * @param {File|Blob} file
 */
function ingestImageFile(file) {
  state.sourceFile = file;
  state.resultBlob = null;
  state.naturalWidth = 0;
  state.naturalHeight = 0;
  dom.btnDownload.classList.add("disabled");
  dom.btnCopy.classList.add("disabled");

  if (state.originalObjectUrl) URL.revokeObjectURL(state.originalObjectUrl);
  state.originalObjectUrl = URL.createObjectURL(file);

  dom.beforeImg.src = state.originalObjectUrl;
  dom.afterImg.src = state.originalObjectUrl;

  dom.emptyState.style.display = "none";
  dom.stage.classList.add("visible");
  dom.statFile.textContent = (file.name || "CLIPBOARD_IMAGE").toUpperCase();

  runSegmentation();
}

/**
 * Sends the active image file and selected parameters (`tier`, `defringe`)
 * to `POST /api/remove-bg` and renders the resulting lossless RGBA PNG.
 */
async function runSegmentation() {
  if (!state.sourceFile) return;

  if (state.abortController) {
    state.abortController.abort();
  }
  const controller = new AbortController();
  state.abortController = controller;
  state.isProcessing = true;

  setError(null);
  dom.busyOverlay.classList.add("active");
  dom.statTime.textContent = "PROCESSING...";

  const tierInfo = state.serverStatus?.tiers?.[state.tier];
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

    if (state.resultObjectUrl) URL.revokeObjectURL(state.resultObjectUrl);
    state.resultObjectUrl = URL.createObjectURL(state.resultBlob);

    dom.afterImg.src = state.resultObjectUrl;
    dom.btnDownload.classList.remove("disabled");
    dom.btnCopy.classList.remove("disabled");

    updateExportTelemetry();
    dom.statTier.textContent = tierLabel.toUpperCase();
    dom.statTime.textContent = inferenceMs ? `${(inferenceMs / 1000).toFixed(2)}S` : "DONE";

    setViewMode("split");
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
    }
  }
}

/* -------------------------------------------------------------------------
 * Event Listeners Registration
 * ------------------------------------------------------------------------- */

// 1. Cancel Button, Confirmation Modal & Info Modal Controls
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

// 2. Hardware Preset Buttons
document.querySelectorAll("#tierSelector .seg-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const targetTier = btn.getAttribute("data-tier");
    if (targetTier && targetTier !== state.tier) {
      selectTier(targetTier, true);
    }
  });
});

// 3. Edge Defringe Toggle
dom.btnDefringe.addEventListener("click", () => {
  state.defringe = !state.defringe;
  dom.btnDefringe.classList.toggle("active", state.defringe);
  if (state.sourceFile) runSegmentation();
});

// 4. View Mode Segmented Control
document.getElementById("viewSplit").addEventListener("click", () => setViewMode("split"));
document.getElementById("viewCutout").addEventListener("click", () => setViewMode("cutout"));
document.getElementById("viewOriginal").addEventListener("click", () => setViewMode("original"));

// 5. Output Format & Scale Selectors
document.querySelectorAll("#formatSelector .mini-seg-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const fmt = btn.getAttribute("data-format");
    if (!fmt) return;
    state.exportFormat = fmt;
    document.querySelectorAll("#formatSelector .mini-seg-btn").forEach((b) => {
      b.classList.toggle("active", b === btn);
    });
    updateExportTelemetry();
  });
});

document.querySelectorAll("#scaleSelector .mini-seg-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const sc = parseFloat(btn.getAttribute("data-scale") || "1");
    state.exportScale = sc;
    document.querySelectorAll("#scaleSelector .mini-seg-btn").forEach((b) => {
      b.classList.toggle("active", b === btn);
    });
    updateExportTelemetry();
  });
});

// 6. Split-Plane Pointer Dragging (Mouse + Touch)
dom.stage.addEventListener("mousedown", (e) => {
  if (state.viewMode !== "split") return;
  state.isDraggingSplit = true;
  handleSplitDrag(e.clientX);
});
window.addEventListener("mousemove", (e) => handleSplitDrag(e.clientX));
window.addEventListener("mouseup", () => {
  state.isDraggingSplit = false;
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
});

// 7. Matte Backdrop Swatches & Custom Color Picker
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
  });
});

document.getElementById("colorPicker").addEventListener("input", (e) => {
  document.querySelectorAll(".swatch").forEach((s) => s.classList.remove("active"));
  e.target.classList.add("active");
  state.activeBackdrop = e.target.value;
  dom.viewport.classList.remove("checkerboard-canvas");
  dom.viewport.style.background = e.target.value;
});

// 8. File Selection, Drag-and-Drop, and Clipboard Paste (with active-job guard)
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

// 9. Export Download & Clipboard Copy (Multi-Format & Multi-Resolution)
dom.btnDownload.addEventListener("click", async () => {
  if (!state.resultBlob) return;
  try {
    const exportBlob = await buildExportBlob(state.exportFormat, state.exportScale);
    const extMap = { png: "png", webp: "webp", jpg: "jpg", mask: "png" };
    const suffix = state.exportFormat === "mask" ? "mask" : "cutout";
    const scaleTag =
      state.exportScale === 1 ? "" : `-${Math.round(state.exportScale * 100)}pct`;
    const baseName = (state.sourceFile?.name || "image").replace(/\.[^/.]+$/, "");
    const fileName = `${baseName}-${suffix}${scaleTag}.${extMap[state.exportFormat] || "png"}`;

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
    // ClipboardItem requires image/png; render at selected scale & matte/mask mode.
    const copyFormat = state.exportFormat === "mask" ? "mask" : "png";
    const pngBlob = await buildExportBlob(copyFormat, state.exportScale);
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

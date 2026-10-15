/**
 * REMOVEBG — Frontend Studio Controller
 * =====================================
 * Handles hardware preset switching, drag-and-drop / clipboard image ingestion,
 * split-plane comparison rendering, and communication with the local FastAPI
 * segmentation backend (`/api/status` and `/api/remove-bg`).
 */

"use strict";

/** Application State */
const state = {
  tier: "mid",             // "low" (768px Lite) | "mid" (1024px Lite) | "high" (1024px Full)
  defringe: true,          // Morphological edge color decontamination toggle
  viewMode: "split",       // "split" | "cutout" | "original"
  splitPercent: 50,        // Horizontal divider position (0 - 100)
  isDraggingSplit: false,  // Pointer drag state for split comparator
  sourceFile: null,        // Active File/Blob object
  resultBlob: null,        // Latest segmented PNG Blob
  originalObjectUrl: null, // Object URL for source preview
  resultObjectUrl: null,   // Object URL for cutout preview
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
  errorToast: document.getElementById("errorToast"),

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
  setError(null);
  dom.busyOverlay.classList.add("active");

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
    });

    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const errPayload = await response.json();
        if (errPayload.detail) detail = errPayload.detail;
      } catch (_) {}
      throw new Error(detail);
    }

    // Parse performance telemetry headers returned by the FastAPI engine.
    const inferenceMs = parseFloat(response.headers.get("X-Inference-Time-Ms") || "0");
    const width = response.headers.get("X-Image-Width") || "";
    const height = response.headers.get("X-Image-Height") || "";
    const tierLabel = response.headers.get("X-Tier-Used") || state.tier.toUpperCase();

    state.resultBlob = await response.blob();
    if (state.resultObjectUrl) URL.revokeObjectURL(state.resultObjectUrl);
    state.resultObjectUrl = URL.createObjectURL(state.resultBlob);

    dom.afterImg.src = state.resultObjectUrl;

    const baseName = (state.sourceFile.name || "image").replace(/\.[^/.]+$/, "");
    dom.btnDownload.href = state.resultObjectUrl;
    dom.btnDownload.download = `${baseName}-cutout.png`;
    dom.btnDownload.classList.remove("disabled");
    dom.btnCopy.classList.remove("disabled");

    dom.statDim.textContent = width && height ? `${width}×${height} PX` : "ORIGINAL";
    dom.statTier.textContent = tierLabel.toUpperCase();
    dom.statTime.textContent = inferenceMs ? `${(inferenceMs / 1000).toFixed(2)}S` : "DONE";

    setViewMode("split");
    syncServerStatus(false);
  } catch (err) {
    setError(err.message || "Failed to process image.");
  } finally {
    dom.busyOverlay.classList.remove("active");
  }
}

/* -------------------------------------------------------------------------
 * Event Listeners Registration
 * ------------------------------------------------------------------------- */

// 1. Hardware Preset Buttons
document.querySelectorAll("#tierSelector .seg-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const targetTier = btn.getAttribute("data-tier");
    if (targetTier && targetTier !== state.tier) {
      selectTier(targetTier, true);
    }
  });
});

// 2. Edge Defringe Toggle
dom.btnDefringe.addEventListener("click", () => {
  state.defringe = !state.defringe;
  dom.btnDefringe.classList.toggle("active", state.defringe);
  if (state.sourceFile) runSegmentation();
});

// 3. View Mode Segmented Control
document.getElementById("viewSplit").addEventListener("click", () => setViewMode("split"));
document.getElementById("viewCutout").addEventListener("click", () => setViewMode("cutout"));
document.getElementById("viewOriginal").addEventListener("click", () => setViewMode("original"));

// 4. Split-Plane Pointer Dragging (Mouse + Touch)
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

// 5. Matte Backdrop Swatches & Custom Color Picker
document.querySelectorAll(".swatch[data-bg]").forEach((swatch) => {
  swatch.addEventListener("click", () => {
    document.querySelectorAll(".swatch").forEach((s) => s.classList.remove("active"));
    swatch.classList.add("active");

    const bgValue = swatch.getAttribute("data-bg");
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
  dom.viewport.classList.remove("checkerboard-canvas");
  dom.viewport.style.background = e.target.value;
});

// 6. File Selection, Drag-and-Drop, and Clipboard Paste
dom.emptyState.addEventListener("click", () => dom.fileInput.click());
dom.btnOpen.addEventListener("click", () => {
  dom.fileInput.value = "";
  dom.fileInput.click();
});

dom.fileInput.addEventListener("change", (e) => {
  if (e.target.files?.[0]) ingestImageFile(e.target.files[0]);
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
  if (e.dataTransfer?.files?.[0]) ingestImageFile(e.dataTransfer.files[0]);
});

window.addEventListener("paste", (e) => {
  const items = e.clipboardData?.items || [];
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      const blob = item.getAsFile();
      if (blob) ingestImageFile(blob);
      break;
    }
  }
});

// 7. Direct Clipboard PNG Copy
dom.btnCopy.addEventListener("click", async () => {
  if (!state.resultBlob) return;
  try {
    await navigator.clipboard.write([
      new ClipboardItem({ "image/png": state.resultBlob }),
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

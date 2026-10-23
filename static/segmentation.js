/**
 * Segmentation lifecycle: job cancel, busy-overlay progress and elapsed
 * pollers, the `/api/remove-bg` request/apply path, and the `/api/refine`
 * edge-refinement pass. Tab records, ingest, and view/menu sync live in
 * tabs.js; panel chrome and the batch queue runner live in batch-*.js.
 * Importing this module has no side effects.
 */

import {
  state,
  dom,
  prefs,
  apiFetch,
  apiErrorDetail,
  masterCutoutImg,
  getActiveTab,
  createByteSmoother,
  savePrefs,
  saveStateToActiveTab,
  setError,
  closeConfirmModal,
  PRESET_NAMES,
  updateTierDownloadUI,
  clearTierDownloadProgress,
  formatDiskBytes,
  formatElapsed,
} from "./state.js";
// View/menu sync injected once at boot by `initSegmentation` (app.js wires
// the real functions; tests inject stubs). Kept out of the import list so the
// workspace coordinator (tabs.js) can drive the run lifecycle without a cycle.
let tabOps = {};
export function initSegmentation(ops) {
  tabOps = ops;
}
import { updateExportTelemetry, applyScaleValue } from "./export-ui.js";
import { warmBlobAlphaBBox } from "./export.js";
import {
  syncServerStatus,
  isModelInstallInProgress,
} from "./preferences.js";
import {
  stopAnimationPlayback,
  selectAnimationFrame,
  syncFilmstripSelection,
} from "./animation.js";

/** Fire-and-forget job cancel; warns when the server cannot be reached. */
export function postCancel() {
  apiFetch("/api/cancel", { method: "POST" }).catch((err) =>
    console.warn("[OpenBGR] Cancel request failed:", err)
  );
}

/** Aborts the in-flight segmentation fetch and tells the server to drop the job. */
export function cancelProcessing() {
  if (state.batch.running) {
    state.batch.cancelled = true;
  }
  if (state.abortController) {
    state.abortController.abort();
    state.abortController = null;
  }
  postCancel();
  state.isProcessing = false;
  dom.busyOverlay.classList.remove("active");
  stopJobProgressPolling();
  closeConfirmModal();
  const elapsedMs = stopElapsedTicker();
  dom.statTime.textContent =
    elapsedMs != null ? `CANCELLED - ${formatElapsed(elapsedMs)}` : "CANCELLED";

  if (!state.resultBlob && state.sourceFile) {
    tabOps.setViewMode("original");
  }
  saveStateToActiveTab();
  tabOps.syncMenuBarState();
}

let jobProgressTimer = null;
let inferPhaseStartedAt = 0;
let elapsedTimer = null;
let elapsedStartedAt = 0;

/** Starts the live elapsed timer on the busy-overlay sub-line. */
function startElapsedTicker() {
  stopElapsedTicker();
  elapsedStartedAt = performance.now();
  dom.busySub.textContent = formatElapsed(0);
  elapsedTimer = setInterval(() => {
    // The download-phase progress text owns busySub; don't fight it.
    if (downloadKey == null) {
      dom.busySub.textContent = formatElapsed(
        performance.now() - elapsedStartedAt
      );
    }
  }, 250);
}

/** Stops the ELAPSED ticker; returns ms elapsed, or null if it wasn't running. */
export function stopElapsedTicker() {
  if (!elapsedTimer) return null;
  clearInterval(elapsedTimer);
  elapsedTimer = null;
  return performance.now() - elapsedStartedAt;
}

/** True while the job poller reports the model-weights download phase. */
export function isModelDownloadActive() {
  return downloadKey != null;
}
let byteSmoother = createByteSmoother();
let downloadPeak = 0;
let downloadKey = null;

/** Sets the busy-overlay bar to a determinate percent, or back to indeterminate. */
function setBusyProgress(pct) {
  const fill = dom.busyProgressFill;
  if (!fill) return;
  const bar = fill.parentElement;
  if (pct == null) {
    bar?.classList.remove("determinate");
    fill.style.width = "0";
    return;
  }
  bar?.classList.add("determinate");
  fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
}

/** Polls `/api/progress` so the busy overlay tracks download/load/inference stages. */
async function pollJobProgress() {
  try {
    const res = await apiFetch("/api/progress");
    if (!res.ok) return;
    const p = await res.json();
    if (!state.isProcessing) return;
    const modelKey = p.model_key || state.tier;
    if (p.phase !== "download") {
      byteSmoother = createByteSmoother();
      downloadPeak = 0;
      if (downloadKey) {
        clearTierDownloadProgress(downloadKey);
        downloadKey = null;
      }
    }

    if (p.phase === "download") {
      inferPhaseStartedAt = 0;
      const dl = Number(p.downloaded_bytes) || 0;
      const tot = Number(p.total_bytes) || 0;
      const modelName = PRESET_NAMES[modelKey] || "MODEL";
      const shown = Math.max(byteSmoother(dl, tot), downloadPeak);
      downloadPeak = shown;
      const expectedBytes =
        Number(state.serverStatus?.tiers?.[modelKey]?.expected_bytes) || 0;
      downloadKey = modelKey;
      dom.busyTitle.textContent = "DOWNLOADING MODEL WEIGHTS";
      dom.busySub.textContent =
        tot > 0
          ? `${formatDiskBytes(shown, true)} / ${formatDiskBytes(tot, true)} - ${modelName}`
          : `${formatDiskBytes(shown, true)} downloaded - ${modelName}`;
      setBusyProgress(tot > 0 ? (shown / tot) * 100 : null);
      updateTierDownloadUI(modelKey, shown, tot, expectedBytes);
    } else if (p.phase === "load") {
      // Model is cached and being restored into device memory; present this
      // as part of "processing", not a separate user-facing stage.
      inferPhaseStartedAt = 0;
      if (!state.batch.running && !state.isAnimated) {
        dom.busyTitle.textContent = "PROCESSING IMAGE";
        setBusyProgress(null);
      }
    } else if (p.phase === "inference") {
      if (!inferPhaseStartedAt) inferPhaseStartedAt = performance.now();
      const est = Number(prefs.inferEstimates?.[modelKey]) || 4000;
      const elapsed = performance.now() - inferPhaseStartedAt;
      if (!state.batch.running && !state.isAnimated) {
        dom.busyTitle.textContent = "PROCESSING IMAGE";
        setBusyProgress(Math.min(97, (elapsed / (elapsed + est * 0.6)) * 100));
      }
    }
  } catch (_) {}
}

/** Starts polling job progress while the busy overlay is visible. */
export function startJobProgressPolling() {
  stopJobProgressPolling();
  setBusyProgress(null);
  jobProgressTimer = setInterval(pollJobProgress, 250);
}

/** Stops progress polling and resets the overlay bar to indeterminate. */
export function stopJobProgressPolling() {
  if (jobProgressTimer) {
    clearInterval(jobProgressTimer);
    jobProgressTimer = null;
  }
  inferPhaseStartedAt = 0;
  byteSmoother = createByteSmoother();
  downloadPeak = 0;
  if (downloadKey) {
    clearTierDownloadProgress(downloadKey);
    downloadKey = null;
  }
  setBusyProgress(null);
}

/** Builds the `/api/remove-bg` multipart body shared by single and batch runs. */
export function buildRemoveBgForm(
  file,
  tier,
  defringe,
  despill,
  edgeShift = 0,
  edgeFeather = 0
) {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("tier", tier);
  fd.append("defringe", defringe ? "true" : "false");
  fd.append("despill", despill ? "true" : "false");
  fd.append("edge_shift", String(edgeShift));
  fd.append("edge_feather", String(edgeFeather));
  return fd;
}

/** Persists the server-reported inference time as the ETA baseline for `tierKey`. */
export function recordInferenceEstimate(response, tierKey) {
  const inferenceMs = parseFloat(
    response.headers.get("X-Inference-Time-Ms") || "0"
  );
  if (inferenceMs > 0) {
    prefs.inferEstimates = prefs.inferEstimates || {};
    prefs.inferEstimates[tierKey] = inferenceMs;
    savePrefs();
  }
}

/** Reports why a run must not start; returns true when blocked. */
function segmentationBlocked() {
  if (isModelInstallInProgress()) {
    setError(
      "A model download is in progress. Wait for it to finish before processing."
    );
    return true;
  }
  const tierInfo = state.serverStatus?.tiers?.[state.tier];
  if (tierInfo && !tierInfo.cached && state.serverStatus?.offline_mode) {
    setError(
      "Selected model is not cached and internet access is blocked. " +
        "Import the checkpoint folder under Settings > Models."
    );
    return true;
  }
  if (tierInfo && !tierInfo.cached && !navigator.onLine) {
    setError("Selected model is not cached on disk and device is currently offline.");
    return true;
  }
  return false;
}

/** Aborts any in-flight job, marks the UI busy, and starts progress/elapsed pollers. */
function beginSegmentationUI(tierInfo) {
  if (state.abortController) {
    state.abortController.abort();
    postCancel();
  }
  const controller = new AbortController();
  state.abortController = controller;
  state.isProcessing = true;

  if (!state.resultBlob) {
    dom.appShell?.classList.add("no-result");
  }
  setError(null);
  dom.busyOverlay.classList.add("active");
  startJobProgressPolling();
  startElapsedTicker();
  tabOps.syncMenuBarState();

  const isCached = tierInfo ? tierInfo.cached : true;
  const jobLabel =
    state.isAnimated && state.frames.length > 1
      ? "PROCESSING GIF"
      : "PROCESSING IMAGE";
  dom.busyTitle.textContent = isCached
    ? jobLabel
    : `${jobLabel} - FETCHING MODEL WEIGHTS`;
  return controller;
}

/** Applies a successful `/api/remove-bg` response: headers, blob, URLs, stage. */
async function applySegmentationResult(response, controller) {
  recordInferenceEstimate(response, state.tier);
  const width = parseInt(response.headers.get("X-Image-Width") || "0", 10);
  const height = parseInt(response.headers.get("X-Image-Height") || "0", 10);
  const jobId = parseInt(response.headers.get("X-Refine-Job-Id") || "0", 10);

  const blob = await response.blob();
  if (controller.signal.aborted) return;

  state.resultBlob = blob;
  state.refineJobId = jobId || null;
  state.naturalWidth = width;
  state.naturalHeight = height;
  if (state.aspectLocked) {
    state.exportWidth = 0;
    state.exportHeight = 0;
  }

  if (
    state.previewObjectUrl &&
    state.previewObjectUrl !== state.resultObjectUrl
  ) {
    URL.revokeObjectURL(state.previewObjectUrl);
  }
  state.previewBlob = null;
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
  const finishedMs = stopElapsedTicker();
  dom.statTime.textContent =
    finishedMs != null ? formatElapsed(finishedMs) : "DONE";

  tabOps.setViewMode("split");
  saveStateToActiveTab();
  syncServerStatus(false);
}

/**
 * Runs `/api/remove-bg` across the trimmed frame range of an animated
 * GIF/WebP tab. Frames outside START/END keep their originals so exports
 * and refine passes only ever touch processed frames.
 */
async function runAnimatedSegmentation(controller) {
  stopAnimationPlayback();
  const frames = state.frames;
  const total = frames.length;
  const startIdx = Math.max(
    0,
    Math.min(total - 1, (state.startFrame || 1) - 1)
  );
  const endIdx = Math.max(
    startIdx,
    Math.min(total - 1, (state.endFrame || total) - 1)
  );
  const count = endIdx - startIdx + 1;
  const staged = [];
  let outW = 0;
  let outH = 0;
  try {
    for (let k = 0; k < count; k++) {
      const i = startIdx + k;
      if (controller.signal.aborted) {
        staged.forEach((s) => URL.revokeObjectURL(s.url));
        return;
      }
      dom.busyTitle.textContent = `PROCESSING GIF (${k + 1}/${count})`;
      setBusyProgress((k / count) * 100);
      const frame = frames[i];
      const formData = buildRemoveBgForm(
        frame.sourceFile,
        state.tier,
        state.defringe,
        state.despill,
        state.edgeShift,
        state.edgeFeather
      );
      const response = await apiFetch("/api/remove-bg", {
        method: "POST",
        body: formData,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(await apiErrorDetail(response));
      }
      if (k === 0) recordInferenceEstimate(response, state.tier);
      const width = parseInt(response.headers.get("X-Image-Width") || "0", 10);
      const height = parseInt(response.headers.get("X-Image-Height") || "0", 10);
      const jobId = parseInt(response.headers.get("X-Refine-Job-Id") || "0", 10);
      const blob = await response.blob();
      if (controller.signal.aborted) {
        staged.forEach((s) => URL.revokeObjectURL(s.url));
        return;
      }
      if (width > 0 && height > 0) {
        outW = width;
        outH = height;
      }
      await warmBlobAlphaBBox(
        blob,
        width || outW || state.naturalWidth,
        height || outH || state.naturalHeight,
        state.shadowCutoff
      );
      staged.push({
        idx: i,
        blob,
        url: URL.createObjectURL(blob),
        jobId: jobId || null,
      });
      setBusyProgress(((k + 1) / count) * 100);
    }
  } catch (err) {
    staged.forEach((s) => URL.revokeObjectURL(s.url));
    throw err;
  }

  for (const next of staged) {
    const frame = frames[next.idx];
    if (frame.previewObjectUrl && frame.previewObjectUrl !== frame.resultObjectUrl) {
      URL.revokeObjectURL(frame.previewObjectUrl);
    }
    if (frame.resultObjectUrl) {
      URL.revokeObjectURL(frame.resultObjectUrl);
    }
    frame.resultBlob = next.blob;
    frame.resultObjectUrl = next.url;
    frame.previewBlob = null;
    frame.previewObjectUrl = null;
    frame.previewSignature = null;
    frame.refineJobId = next.jobId;
  }
  if (outW > 0 && outH > 0) {
    state.naturalWidth = outW;
    state.naturalHeight = outH;
  }
  syncFilmstripSelection(false);

  if (state.aspectLocked) {
    state.exportWidth = 0;
    state.exportHeight = 0;
  }
  state.exportCacheBlob = null;
  state.exportCacheSignature = null;

  // Land on a processed frame: the current one may sit outside the trim
  // range and carry no cutout, which would leave EXPORT disabled.
  const curIdx = Math.max(0, Math.min(total - 1, state.currentFrameIndex));
  const targetIdx = frames[curIdx]?.resultBlob ? curIdx : startIdx;
  const targetUrl = frames[targetIdx]?.resultObjectUrl;
  if (targetUrl) {
    await new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, 250);
      masterCutoutImg.onload = done;
      masterCutoutImg.onerror = done;
      masterCutoutImg.src = targetUrl;
      if (masterCutoutImg.complete && masterCutoutImg.naturalWidth > 0) {
        done();
      }
    });
  }
  selectAnimationFrame(targetIdx, { scrollIntoView: false });

  dom.appShell?.classList.remove("no-result");
  dom.btnDownload.classList.remove("disabled");
  dom.btnCopy.classList.remove("disabled");

  updateExportTelemetry();
  const finishedMs = stopElapsedTicker();
  dom.statTime.textContent =
    finishedMs != null ? formatElapsed(finishedMs) : "DONE";

  tabOps.setViewMode("split");
  saveStateToActiveTab();
  syncServerStatus(false);
}

/** POSTs the active image to `/api/remove-bg` and applies the returned cutout + job id. */
export async function runSegmentation() {
  if (!state.sourceFile || segmentationBlocked()) return;
  const tierInfo = state.serverStatus?.tiers?.[state.tier];
  const controller = beginSegmentationUI(tierInfo);

  try {
    if (state.isAnimated && state.frames.length > 1) {
      await runAnimatedSegmentation(controller);
      return;
    }
    const formData = buildRemoveBgForm(
      state.sourceFile,
      state.tier,
      state.defringe,
      state.despill,
      state.edgeShift,
      state.edgeFeather
    );
    const response = await apiFetch("/api/remove-bg", {
      method: "POST",
      body: formData,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(await apiErrorDetail(response));
    }
    await applySegmentationResult(response, controller);
  } catch (err) {
    if (err.name === "AbortError") return;
    stopElapsedTicker();
    setError(err.message || "Failed to process image.");
    dom.statTime.textContent = "ERROR";
  } finally {
    if (state.abortController === controller) {
      state.isProcessing = false;
      state.abortController = null;
      dom.busyOverlay.classList.remove("active");
      stopJobProgressPolling();
      stopElapsedTicker();
      closeConfirmModal();
      if (state.resultBlob) {
        dom.appShell?.classList.remove("no-result");
      }
      tabOps.syncMenuBarState();
    } else if (!state.abortController) {
      // The job was cancelled or its tab closed without a replacement run
      // taking over: kill the orphaned poller and ticker instead of letting
      // them fire every 250 ms forever.
      stopJobProgressPolling();
      stopElapsedTicker();
    }
  }
}

/**
 * Re-applies the edge-refinement filters (DEFRINGE / SUPPRESS COLOR SPILL /
 * EDGE SHIFT / EDGE FEATHER) on the server-side cached raw RGB + alpha of the
 * last job: a pure NumPy
 * post-processing pass (~20 ms), no neural-network re-inference required.
 * No-ops when the active tab has no fresh cutout job on the server.
 */
export async function applyEdgeRefinement() {
  const tab = getActiveTab();
  if (
    !tab ||
    tab.kind === "batch" ||
    !state.refineJobId ||
    !state.resultBlob ||
    state.isProcessing
  ) {
    return;
  }

  // Coalesce rapid toggle clicks: while a request is in flight, only the
  // latest flag state is rendered (one extra request) instead of queueing
  // one server-side compose per click.
  if (state.refineInFlight) {
    state.refinePending = true;
    return;
  }
  let needsReprocess = false;
  state.refineInFlight = true;
  try {
    do {
      state.refinePending = false;
      if (
        !state.refineJobId ||
        !state.resultBlob ||
        state.isProcessing ||
        getActiveTab()?.kind === "batch"
      ) {
        break;
      }
      const token = ++state.refineToken;
      const fd = new FormData();
      fd.append("job_id", String(state.refineJobId));
      fd.append("defringe", state.defringe ? "true" : "false");
      fd.append("despill", state.despill ? "true" : "false");
      fd.append("edge_shift", String(state.edgeShift));
      fd.append("edge_feather", String(state.edgeFeather));

      try {
        const response = await apiFetch("/api/refine", {
          method: "POST",
          body: fd,
        });
        if (!response.ok) {
          if (response.status === 409 && token === state.refineToken) {
            state.refineJobId = null;
            if (state.sourceFile && !state.isProcessing) {
              needsReprocess = true;
              break;
            }
            dom.statTime.textContent = "REPROCESS TO APPLY";
          }
          continue;
        }

        const blob = await response.blob();
        if (token !== state.refineToken) continue;

        state.resultBlob = blob;
        state.previewBlob = null;
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
        state.resultObjectUrl = URL.createObjectURL(blob);

        await new Promise((resolve) => {
          masterCutoutImg.onload = resolve;
          masterCutoutImg.onerror = resolve;
          masterCutoutImg.src = state.resultObjectUrl;
        });
        if (token !== state.refineToken) continue;

        if (state.autoCrop && state.aspectLocked) {
          applyScaleValue(state.exportScale);
        } else {
          updateExportTelemetry();
        }
        saveStateToActiveTab();

        if (state.isAnimated && state.frames.length > 1) {
          const curFrm = state.frames[state.currentFrameIndex];
          if (curFrm) {
            if (
              curFrm.previewObjectUrl &&
              curFrm.previewObjectUrl !== state.resultObjectUrl
            ) {
              URL.revokeObjectURL(curFrm.previewObjectUrl);
            }
            curFrm.resultBlob = blob;
            curFrm.resultObjectUrl = state.resultObjectUrl;
            curFrm.previewBlob = null;
            curFrm.previewObjectUrl = null;
            curFrm.previewSignature = null;
          }
          await warmBlobAlphaBBox(
            blob,
            state.naturalWidth,
            state.naturalHeight,
            state.shadowCutoff
          );
          syncFilmstripSelection(false);
          for (let i = 0; i < state.frames.length; i++) {
            if (token !== state.refineToken || state.refinePending) break;
            if (i === state.currentFrameIndex) continue;
            const frm = state.frames[i];
            if (!frm?.refineJobId) continue;
            const ffd = new FormData();
            ffd.append("job_id", String(frm.refineJobId));
            ffd.append("defringe", state.defringe ? "true" : "false");
            ffd.append("despill", state.despill ? "true" : "false");
            ffd.append("edge_shift", String(state.edgeShift));
            ffd.append("edge_feather", String(state.edgeFeather));
            const fres = await apiFetch("/api/refine", {
              method: "POST",
              body: ffd,
            });
            if (!fres.ok || token !== state.refineToken) continue;
            const fblob = await fres.blob();
            if (token !== state.refineToken) break;
            await warmBlobAlphaBBox(
              fblob,
              state.naturalWidth,
              state.naturalHeight,
              state.shadowCutoff
            );
            if (
              frm.previewObjectUrl &&
              frm.previewObjectUrl !== frm.resultObjectUrl
            ) {
              URL.revokeObjectURL(frm.previewObjectUrl);
            }
            if (frm.resultObjectUrl) URL.revokeObjectURL(frm.resultObjectUrl);
            frm.resultBlob = fblob;
            frm.resultObjectUrl = URL.createObjectURL(fblob);
            frm.previewBlob = null;
            frm.previewObjectUrl = null;
            frm.previewSignature = null;
          }
          state.exportCacheBlob = null;
          state.exportCacheSignature = null;
          syncFilmstripSelection(false);
          updateExportTelemetry();
        }
      } catch (err) {
        console.warn("[OpenBGR] Edge refinement request failed:", err);
      }
    } while (state.refinePending);
  } finally {
    state.refineInFlight = false;
  }
  if (needsReprocess) {
    await runSegmentation();
  }
}

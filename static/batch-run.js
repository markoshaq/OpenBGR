/**
 * Batch run lifecycle: the settings snapshot, output-destination resolution
 * (folder, streaming ZIP, or in-memory ZIP), sequential `/api/remove-bg`
 * execution, per-row status, and the completion summary. The queue model
 * lives in batch.js; row/panel rendering in batch-panel.js.
 * Importing this module has no side effects.
 */

import {
  state,
  dom,
  apiFetch,
  apiErrorDetail,
  setError,
  openConfirmModal,
  downloadBlob,
  FORMAT_EXT,
  DEFAULT_CROP_PADDING,
  formatElapsed,
} from "./state.js";
import { buildBatchExportBlob } from "./export.js";
import { saveBatchFile, revealSavedPath } from "./export-io.js";
import { buildZip, createZipWriter } from "./zip.js";
// Tab-strip sync injected once at boot by `initBatchRun` (app.js wires the
// real function; tests inject stubs). Kept out of the import list so the
// workspace coordinator (tabs.js) can reach the run lifecycle without a cycle.
let tabOps = {};
export function initBatchRun(ops) {
  tabOps = ops;
}
import { renderBatchPanel, updateBatchRowStatus } from "./batch-panel.js";
import {
  startJobProgressPolling,
  stopJobProgressPolling,
  isModelDownloadActive,
  buildRemoveBgForm,
  recordInferenceEstimate,
} from "./segmentation.js";
import { isModelInstallInProgress } from "./preferences.js";

/**
 * Runs inference + export for one batch entry: POSTs the image, exports the
 * cutout in the snapshotted settings, then either saves it to `outputDir` or
 * buffers it for the final ZIP download. Returns "done", "failed", or
 * "cancelled"; throws AbortError/network errors to the caller's catch.
 */
async function processBatchEntry(batch, entry, snap, outputDir, controller) {
  const fd = buildRemoveBgForm(
    entry.file,
    snap.tier,
    snap.defringe,
    snap.despill,
    snap.edgeShift,
    snap.edgeFeather
  );
  const response = await apiFetch("/api/remove-bg", {
    method: "POST",
    body: fd,
    signal: controller.signal,
  });
  if (!response.ok) {
    throw new Error(await apiErrorDetail(response));
  }

  recordInferenceEstimate(response, snap.tier);

  const blob = await response.blob();
  if (batch.cancelled || controller.signal.aborted) return "cancelled";

  const outBlob = await buildBatchExportBlob(blob, snap, entry.file);
  const ext = FORMAT_EXT[snap.format] || "png";
  const stem = (entry.name || "image").replace(/\.[^.]+$/, "") || "image";
  const suffix = snap.format === "mask" ? "mask" : "cutout";
  let outName = `${stem}-${suffix}.${ext}`;

  if (outputDir) {
    const saved = await saveBatchFile(outputDir, outName, outBlob);
    if (!saved.ok) {
      entry.error = saved.detail;
      return "failed";
    }
    return "done";
  }
  const taken = batch.zipWriter
    ? batch.zipWriter.names
    : new Set(batch.results.map((r) => r.name));
  let n = 1;
  while (taken.has(outName)) {
    outName = `${stem}-${suffix}-${n++}.${ext}`;
  }
  if (batch.zipWriter) {
    // Streaming zip: the entry lands on disk immediately, so the batch never
    // holds more than one output file's bytes in memory at a time.
    await batch.zipWriter.add(
      outName,
      new Uint8Array(await outBlob.arrayBuffer())
    );
    return "done";
  }
  batch.results.push({ name: outName, blob: outBlob });
  return "done";
}

/** Snapshots the settings a batch run applies uniformly to every entry. */
function snapshotBatchSettings(tab) {
  return {
    tier: tab.tier ?? state.tier,
    defringe: tab.defringe ?? state.defringe,
    despill: tab.despill ?? state.despill,
    format: tab.exportFormat ?? state.exportFormat,
    scale: tab.exportScale ?? state.exportScale,
    exportWidth: tab.exportWidth ?? 0,
    exportHeight: tab.exportHeight ?? 0,
    canvasFit: tab.canvasFit ?? state.canvasFit ?? "fit",
    autoCrop: Boolean(tab.autoCrop ?? state.autoCrop),
    cropPadding: tab.cropPadding ?? state.cropPadding ?? DEFAULT_CROP_PADDING,
    edgeShift: tab.edgeShift ?? state.edgeShift ?? 0,
    edgeFeather: tab.edgeFeather ?? state.edgeFeather ?? 0,
    backdrop: tab.activeBackdrop ?? state.activeBackdrop,
    backdropImg: tab.backdropImg ?? state.backdropImg,
    backdropBlur: tab.backdropBlur ?? state.backdropBlur ?? 50,
    shadowCutoff: tab.shadowCutoff ?? state.shadowCutoff,
  };
}

/** Reports why a run must not start; returns true when blocked. */
function batchPreflightBlocked(snap) {
  const tierInfo = state.serverStatus?.tiers?.[snap.tier];
  if (
    tierInfo &&
    tierInfo.cached === false &&
    (state.serverStatus?.offline_mode || !navigator.onLine)
  ) {
    setError(
      state.serverStatus?.offline_mode
        ? "Selected model is not cached and internet access is blocked. Import the checkpoint folder under Settings > Models."
        : "Selected model is not cached on disk and device is currently offline."
    );
    return true;
  }
  if (isModelInstallInProgress()) {
    setError(
      "A model download is in progress. Wait for it to finish before processing."
    );
    return true;
  }
  return false;
}

/**
 * Resolves the run's output destination: an already-chosen folder, the native
 * directory picker, a streaming-zip Save-As (picked up front so the RUN BATCH
 * click still counts as user activation), or the in-memory ZIP fallback for
 * browsers without the File System Access API. Returns null when the user
 * aborted a picker or the native picker reported an error.
 */
async function resolveBatchOutput(tab, batch) {
  let outputDir = tab.outputDir || null;
  if (!outputDir && window.pywebview?.api?.choose_output_dir) {
    try {
      const res = await window.pywebview.api.choose_output_dir();
      if (res?.error) {
        setError(res.error);
        return null;
      }
      if (!res?.path) return null;
      outputDir = res.path;
      tab.outputDir = outputDir;
      if (tab.id === state.activeTabId) state.outputDir = outputDir;
    } catch (err) {
      console.warn("[OpenBGR] Output directory picker failed:", err);
    }
  }

  let zipHandle = null;
  if (!outputDir && window.showSaveFilePicker) {
    try {
      zipHandle = await window.showSaveFilePicker({
        suggestedName: "openbgr-cutouts.zip",
        types: [
          {
            description: "ZIP archive",
            accept: { "application/zip": [".zip"] },
          },
        ],
      });
      batch.zipWriter = createZipWriter(await zipHandle.createWritable());
    } catch (pickerErr) {
      if (pickerErr?.name === "AbortError") return null;
      batch.zipWriter = null;
      zipHandle = null;
    }
  }
  return { outputDir, zipHandle };
}

/** Marks the batch run started: flags, per-entry statuses, busy overlay, pollers. */
function beginBatchRun(tab, batch, onlyFailed) {
  batch.running = true;
  batch.tabId = tab.id;
  batch.failed = 0;
  batch.cancelled = false;
  batch.results = [];

  // runTarget is the explicit membership of this run. "queued" alone cannot
  // be trusted in retry mode: newly added files and entries left over from a
  // cancelled run also carry that status.
  batch.total = 0;
  tab.batchFiles.forEach((e) => {
    e.runTarget = onlyFailed
      ? e.status === "failed" && e.selected !== false
      : e.selected !== false;
    if (e.runTarget) batch.total++;
    if (onlyFailed) {
      // Retry targets only failed, still-selected rows; done and skipped
      // rows keep their status.
      if (e.runTarget) {
        e.status = "queued";
        delete e.error;
      }
      return;
    }
    e.status = e.runTarget ? "queued" : "skipped";
    delete e.error;
  });

  state.isProcessing = true;
  setError(null);
  dom.busyOverlay.classList.add("active");
  startJobProgressPolling();

  if (tab.id === state.activeTabId) renderBatchPanel(tab);
  tabOps.syncMenuBarState();
}

/** Ticks the busy-overlay elapsed sub-line while no download phase owns it. */
function startBatchElapsedTicker(startedAt) {
  dom.busySub.textContent = formatElapsed(0);
  return setInterval(() => {
    // The download-phase progress text owns busySub; don't fight it.
    if (!isModelDownloadActive()) {
      dom.busySub.textContent = formatElapsed(performance.now() - startedAt);
    }
  }, 250);
}

/** Runs the queue entries sequentially; returns the count of completed entries. */
async function processBatchQueue(tab, batch, snap, outputDir, controller) {
  let seen = 0;
  let completed = 0;
  for (let i = 0; i < tab.batchFiles.length; i++) {
    if (batch.cancelled) break;
    const entry = tab.batchFiles[i];
    // Only entries marked for this run (and still queued: a mid-run deselect
    // flips a row to skipped) are processed.
    if (!entry.runTarget || entry.status !== "queued") continue;
    seen++;
    entry.status = "processing";
    updateBatchRowStatus(tab, i);
    dom.busyTitle.textContent = `PROCESSING BATCH (${seen}/${batch.total})`;

    try {
      const outcome = await processBatchEntry(
        batch,
        entry,
        snap,
        outputDir,
        controller
      );
      if (outcome === "cancelled") {
        entry.status = "queued";
        updateBatchRowStatus(tab, i);
        break;
      }
      entry.status = outcome;
      if (outcome === "done") completed++;
      else batch.failed++;
      updateBatchRowStatus(tab, i);
    } catch (err) {
      if (err?.name === "AbortError" || batch.cancelled) {
        entry.status = "queued";
        updateBatchRowStatus(tab, i);
        break;
      }
      entry.status = "failed";
      entry.error = err?.message || "Processing failed.";
      batch.failed++;
      updateBatchRowStatus(tab, i);
    }
  }
  return completed;
}

/** Tears down the run, flushes or aborts the zip, and shows the summary modal. */
async function finishBatchRun(tab, batch, run) {
  const { outputDir, zipHandle, startedAt, elapsedTimer, completed } = run;
  const wasCancelled = batch.cancelled;
  batch.running = false;
  batch.cancelled = false;
  batch.tabId = null;
  state.isProcessing = false;
  state.abortController = null;
  dom.busyOverlay.classList.remove("active");
  stopJobProgressPolling();

  if (batch.zipWriter) {
    if (wasCancelled) {
      await batch.zipWriter.abort();
    } else {
      try {
        await batch.zipWriter.close();
      } catch (err) {
        console.warn("[OpenBGR] ZIP write failed:", err);
        setError("Failed to write the ZIP archive.");
      }
    }
    batch.zipWriter = null;
  } else if (!outputDir && batch.results.length > 0) {
    const entries = await Promise.all(
      batch.results.map(async (r) => ({
        name: r.name,
        data: new Uint8Array(await r.blob.arrayBuffer()),
      }))
    );
    try {
      downloadBlob(buildZip(entries), "openbgr-cutouts.zip");
    } catch (zipErr) {
      setError(zipErr?.message || "Failed to build the ZIP archive.");
    }
  }
  batch.results = [];

  clearInterval(elapsedTimer);
  const totalElapsed = formatElapsed(performance.now() - startedAt);
  tab.elapsedText = wasCancelled
    ? `CANCELLED - ${totalElapsed}`
    : totalElapsed;
  if (tab.id === state.activeTabId) {
    dom.statTime.textContent = tab.elapsedText;
    dom.appShell?.classList.add("batch-elapsed");
    renderBatchPanel(tab);
  }
  tabOps.syncMenuBarState();

  if (wasCancelled) return;
  openConfirmModal(
    {
      title: "BATCH COMPLETE",
      message:
        `${completed} of ${batch.total} image${batch.total > 1 ? "s" : ""} processed` +
        (batch.failed > 0 ? `, ${batch.failed} failed` : "") +
        (outputDir
          ? `.\nSaved to: ${outputDir}`
          : zipHandle
            ? `.\nSaved to: ${zipHandle.name}`
            : ".\nDownloaded as openbgr-cutouts.zip."),
      confirmText: "DONE",
      hideCancel: true,
      altText: outputDir ? "REVEAL FOLDER" : undefined,
      altFn: outputDir ? () => revealSavedPath(outputDir) : null,
    },
    () => {}
  );
}

/**
 * Runs the segmentation pipeline sequentially over a batch tab's queue.
 * With `onlyFailed`, re-processes just the rows whose last run ended in
 * status "failed" and which remain selected, leaving done rows untouched.
 */
export async function runBatch(tab, { onlyFailed = false } = {}) {
  const batch = state.batch;
  if (!tab || tab.kind !== "batch" || batch.running || !tab.batchFiles.length) {
    return;
  }
  if (onlyFailed) {
    const hasRetryable = tab.batchFiles.some(
      (e) => e.status === "failed" && e.selected !== false
    );
    if (!hasRetryable) {
      setError("No failed entries to retry.");
      return;
    }
  } else if (!tab.batchFiles.some((e) => e.selected !== false)) {
    setError("Select at least one image to process.");
    return;
  }
  const snap = snapshotBatchSettings(tab);
  if (batchPreflightBlocked(snap)) return;

  const dest = await resolveBatchOutput(tab, batch);
  if (!dest) return;

  beginBatchRun(tab, batch, onlyFailed);
  const controller = new AbortController();
  state.abortController = controller;
  const startedAt = performance.now();
  const elapsedTimer = startBatchElapsedTicker(startedAt);

  const completed = await processBatchQueue(
    tab,
    batch,
    snap,
    dest.outputDir,
    controller
  );
  await finishBatchRun(tab, batch, {
    ...dest,
    startedAt,
    elapsedTimer,
    completed,
  });
}

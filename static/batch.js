/**
 * Batch processing: queue tab model, batch panel UI, folder-style tab merge,
 * row drag-out, tab context menu, and sequential `/api/remove-bg` execution.
 */

import {
  state,
  dom,
  getActiveTab,
  defaultTierForNewTab,
  createTabRecord,
  revokeTabUrls,
  saveStateToActiveTab,
  setError,
  openConfirmModal,
  triggerOpenFileDialog,
  filesFromDialogResult,
  downloadBlob,
  PRESET_NAMES,
  FORMAT_EXT,
} from "./state.js";
import {
  updateDestUI,
  buildBatchExportBlob,
  saveBatchFile,
  buildZip,
} from "./export.js";
import {
  renderTabBar,
  hideTabGhost,
  closeTabImmediate,
  switchToTab,
  ingestImageFile,
  cancelProcessing,
  syncMenuBarState,
  startJobProgressPolling,
  stopJobProgressPolling,
} from "./tabs.js";
import { isModelInstallInProgress } from "./preferences.js";

/** Opens the hidden multi-file input (or native dialog) routing results to a callback. */
export function openMultiFileChooser(files, noun) {
  const list = Array.from(files || []).filter(Boolean);
  if (!list.length) return;
  openConfirmModal(
    {
      title: `${list.length} IMAGES ${noun}`,
      message:
        "Open them as separate tabs, or create one batch tab that processes them all with a single set of settings?",
      confirmText: "CREATE BATCH",
      cancelText: "CANCEL",
      altText: "OPEN AS TABS",
      altFn: () => {
        if (state.isProcessing) cancelProcessing();
        list.forEach((f) => ingestImageFile(f));
      },
    },
    () => {
      if (state.isProcessing) cancelProcessing();
      createBatchTab(list);
    }
  );
}

/** Unified file picker: native dialog in desktop mode, `<input>` in browser mode. */
export async function pickImageFiles(cb) {
  if (window.pywebview?.api?.open_image_dialog) {
    try {
      const res = await window.pywebview.api.open_image_dialog();
      if (res?.error) {
        setError(res.error);
        return;
      }
      const files = filesFromDialogResult(res);
      if (files.length > 0) cb(files);
      return;
    } catch (_) {}
  }
  state.expectingBatch = true;
  triggerOpenFileDialog();
}

/** Creates a batch tab from a file list and switches to it. */
export function createBatchTab(files) {
  const list = Array.from(files || []).filter(Boolean);
  if (!list.length) return;
  saveStateToActiveTab();

  const tab = createTabRecord({
    kind: "batch",
    name: "BATCH",
    tier: defaultTierForNewTab(),
    batchFiles: list.map((f) => ({
      file: f,
      name: f.name || "image",
      size: f.size || 0,
      status: "queued",
    })),
  });
  state.tabs.push(tab);
  switchToTab(tab.id);
  return tab;
}

/** Appends files to an existing batch tab's queue and re-renders its panel. */
export function addFilesToBatchTab(tab, files) {
  Array.from(files || [])
    .filter(Boolean)
    .forEach((f) =>
      tab.batchFiles.push({
        file: f,
        name: f.name || "image",
        size: f.size || 0,
        status: "queued",
      })
    );
  if (tab.id === state.activeTabId) renderBatchPanel(tab);
  renderTabBar();
}

/** Formats a byte count for batch row file-size labels. */
function formatBytes(n) {
  if (!n) return "--";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Re-renders the batch queue list, counters, and Run button state. */
export function renderBatchPanel(tab) {
  if (!dom.batchPanel || tab.kind !== "batch") return;
  dom.batchPanel.classList.add("active");
  dom.stage.classList.remove("visible");
  dom.emptyState.style.display = "none";

  const n = tab.batchFiles.length;
  const runningThis = state.batch.running && state.batch.tabId === tab.id;
  dom.batchSub.textContent = `${n} IMAGE${n === 1 ? "" : "S"} · ONE SETTING FOR ALL`;

  updateDestUI();
  dom.batchFootText.textContent = tab.outputDir
    ? `OUTPUT → ${tab.outputDir}`
    : "Drop more images onto this window to add them.";

  dom.batchList.replaceChildren();
  if (n === 0) {
    const hint = document.createElement("div");
    hint.className = "batch-empty-hint";
    hint.textContent = "EMPTY BATCH · DROP IMAGES OR USE ADD IMAGES";
    dom.batchList.appendChild(hint);
  }

  tab.batchFiles.forEach((entry, i) => {
    const row = document.createElement("div");
    row.className = "batch-row";
    row.setAttribute("data-idx", String(i));
    row.draggable = true;
    row.addEventListener("dragstart", (e) => {
      if (state.batch.running) {
        e.preventDefault();
        return;
      }
      state.dragBatchItem = { tabId: tab.id, index: i };
      row.classList.add("dragging");
      e.dataTransfer.effectAllowed = "copyMove";
      try {
        e.dataTransfer.setData("text/plain", entry.name);
      } catch (_) {}
    });
    row.addEventListener("dragend", () => {
      state.dragBatchItem = null;
      row.classList.remove("dragging");
      hideTabGhost();
      dom.tabBar
        .querySelectorAll(".drop-target")
        .forEach((el) => el.classList.remove("drop-target"));
    });

    const dot = document.createElement("span");
    dot.className = `batch-dot st-${entry.status}`;
    const name = document.createElement("span");
    name.className = "batch-row-name";
    name.textContent = entry.name;
    name.title = entry.name;
    const size = document.createElement("span");
    size.className = "batch-row-size";
    size.textContent = formatBytes(entry.size);
    const st = document.createElement("span");
    st.className = `batch-row-status st-${entry.status}`;
    st.textContent = entry.status.toUpperCase();
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "batch-row-remove";
    rm.textContent = "×";
    rm.title = "Remove from batch";
    rm.addEventListener("click", (e) => {
      e.stopPropagation();
      if (state.batch.running) return;
      tab.batchFiles.splice(i, 1);
      if (tab.batchFiles.length === 0) {
        closeTabImmediate(tab.id);
      } else {
        renderBatchPanel(tab);
        renderTabBar();
      }
    });
    row.append(dot, name, size, st, rm);
    dom.batchList.appendChild(row);
  });

  if (dom.btnDownload) {
    dom.btnDownload.classList.toggle(
      "disabled",
      n === 0 || (state.isProcessing && !runningThis)
    );
    dom.btnDownload.textContent = runningThis ? "BATCH RUNNING…" : "RUN BATCH";
  }
}

/** Sets one row's status chip and optional detail message. */
function updateBatchRowStatus(tab, i) {
  if (tab.id !== state.activeTabId || !dom.batchList) return;
  const row = dom.batchList.querySelector(`.batch-row[data-idx="${i}"]`);
  if (!row) return;
  const entry = tab.batchFiles[i];
  const dot = row.querySelector(".batch-dot");
  const st = row.querySelector(".batch-row-status");
  if (dot) dot.className = `batch-dot st-${entry.status}`;
  if (st) {
    st.className = `batch-row-status st-${entry.status}`;
    st.textContent = entry.status.toUpperCase();
  }
}

/** Converts a single-image tab into a batch tab seeded with its image. */
export function convertTabToBatch(tab) {
  const entries = [];
  if (tab.kind === "batch") {
    entries.push(...tab.batchFiles);
  } else if (tab.sourceFile) {
    entries.push({
      file: tab.sourceFile,
      name: tab.name,
      size: tab.sourceFile.size || 0,
      status: "queued",
    });
  }
  revokeTabUrls(tab);
  tab.kind = "batch";
  tab.name = "BATCH";
  tab.sourceFile = null;
  tab.originalObjectUrl = null;
  tab.resultBlob = null;
  tab.resultObjectUrl = null;
  tab.previewBlob = null;
  tab.previewObjectUrl = null;
  tab.naturalWidth = 0;
  tab.naturalHeight = 0;
  tab.batchFiles = entries;
}

/** Drags one tab's contents into another, creating/extending a batch tab. */
export function mergeTabsIntoBatch(srcId, dstId) {
  if (srcId === dstId || state.batch.running) return;
  const src = state.tabs.find((t) => t.id === srcId);
  const dst = state.tabs.find((t) => t.id === dstId);
  if (!src || !dst) return;

  const srcEntries =
    src.kind === "batch"
      ? src.batchFiles
      : src.sourceFile
        ? [
            {
              file: src.sourceFile,
              name: src.name,
              size: src.sourceFile.size || 0,
              status: "queued",
            },
          ]
        : [];
  if (!srcEntries.length) return;

  if (dst.kind !== "batch") convertTabToBatch(dst);
  dst.batchFiles.push(...srcEntries);

  const idx = state.tabs.indexOf(src);
  if (idx !== -1) {
    if (src.kind !== "batch") revokeTabUrls(src);
    const srcWasActive = src.id === state.activeTabId;
    state.tabs.splice(idx, 1);
    if (srcWasActive) state.activeTabId = null;
  }

  switchToTab(dst.id);
}

/** Pulls one queue entry out of a batch into its own image tab. */
export function extractBatchItemToTab(tab, index) {
  const entry = tab.batchFiles[index];
  if (!entry || state.batch.running) return;
  tab.batchFiles.splice(index, 1);
  ingestImageFile(entry.file);
  if (tab.batchFiles.length === 0) {
    closeTabImmediate(tab.id);
  } else {
    renderTabBar();
    if (tab.id === state.activeTabId) renderBatchPanel(tab);
  }
}

/** Moves a batch queue entry into a different batch tab. */
export function moveBatchItemToBatch(item, targetTab) {
  const src = state.tabs.find((t) => t.id === item.tabId);
  if (
    !src ||
    !targetTab ||
    targetTab.kind !== "batch" ||
    src.id === targetTab.id ||
    state.batch.running
  ) {
    return;
  }
  const entry = src.batchFiles[item.index];
  if (!entry) return;
  src.batchFiles.splice(item.index, 1);
  entry.status = "queued";
  targetTab.batchFiles.push(entry);
  if (src.batchFiles.length === 0) {
    closeTabImmediate(src.id);
  } else if (src.id === state.activeTabId) {
    renderBatchPanel(src);
  }
  renderTabBar();
}

/** Shows the right-click menu on a tab (batch ops, close). */
export function showTabContextMenu(tab, x, y, onRequestCloseTab) {
  const menu = dom.tabContextMenu;
  if (!menu) return;
  menu.replaceChildren();

  const addItem = (label, fn, disabled = false) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `ctx-item${disabled ? " ctx-disabled" : ""}`;
    b.textContent = label;
    if (!disabled) {
      b.addEventListener("click", () => {
        hideTabContextMenu();
        fn();
      });
    }
    menu.appendChild(b);
  };
  const addSep = () => {
    const s = document.createElement("div");
    s.className = "ctx-sep";
    menu.appendChild(s);
  };
  const addHead = (label) => {
    const h = document.createElement("div");
    h.className = "ctx-head";
    h.textContent = label;
    menu.appendChild(h);
  };

  const hasFiles = tab.kind === "batch" || Boolean(tab.sourceFile);

  if (tab.kind !== "batch" && hasFiles) {
    addItem("SEND TO NEW BATCH", () => {
      convertTabToBatch(tab);
      if (tab.id === state.activeTabId) {
        state.activeTabId = null;
        switchToTab(tab.id);
      }
      renderTabBar();
    });
  }
  const others = state.tabs.filter((t) => t.kind === "batch" && t.id !== tab.id);
  if (hasFiles && others.length) {
    if (menu.children.length) addSep();
    addHead("ADD TO BATCH");
    others.forEach((b) => {
      addItem(`${b.name} (${b.batchFiles.length})`, () =>
        mergeTabsIntoBatch(tab.id, b.id)
      );
    });
  }
  if (tab.kind === "batch") {
    addItem("RUN BATCH", () => runBatch(tab), state.batch.running);
    addItem(
      "ADD IMAGES…",
      () => {
        pickImageFiles((files) => addFilesToBatchTab(tab, files));
      },
      state.batch.running
    );
  }
  if (menu.children.length) addSep();
  addItem("CLOSE TAB", () => onRequestCloseTab(tab.id));

  menu.style.display = "block";
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
}

/** Dismisses the tab context menu. */
export function hideTabContextMenu() {
  if (dom.tabContextMenu) dom.tabContextMenu.style.display = "none";
}

/** Runs the segmentation pipeline sequentially over a batch tab's queue. */
export async function runBatch(tab) {
  const batch = state.batch;
  if (!tab || tab.kind !== "batch" || batch.running || !tab.batchFiles.length) {
    return;
  }

  const snap = {
    tier: tab.tier ?? state.tier,
    defringe: tab.defringe ?? state.defringe,
    despill: tab.despill ?? state.despill,
    format: tab.exportFormat ?? state.exportFormat,
    scale: tab.exportScale ?? state.exportScale,
    exportWidth: tab.exportWidth ?? 0,
    exportHeight: tab.exportHeight ?? 0,
    backdrop: tab.activeBackdrop ?? state.activeBackdrop,
    shadowCutoff: tab.shadowCutoff ?? state.shadowCutoff,
  };

  const tierInfo = state.serverStatus?.tiers?.[snap.tier];
  if (tierInfo && tierInfo.cached === false && !navigator.onLine) {
    setError("Selected model is not cached on disk and device is currently offline.");
    return;
  }
  if (isModelInstallInProgress()) {
    setError(
      "A model download is in progress. Wait for it to finish before processing."
    );
    return;
  }

  let outputDir = tab.outputDir || null;
  if (!outputDir && window.pywebview?.api?.choose_output_dir) {
    try {
      const res = await window.pywebview.api.choose_output_dir();
      if (res?.error) {
        setError(res.error);
        return;
      }
      if (!res?.path) return;
      outputDir = res.path;
      tab.outputDir = outputDir;
      if (tab.id === state.activeTabId) state.outputDir = outputDir;
    } catch (_) {}
  }

  batch.running = true;
  batch.tabId = tab.id;
  batch.total = tab.batchFiles.length;
  batch.index = 0;
  batch.failed = 0;
  batch.cancelled = false;
  batch.results = [];

  tab.batchFiles.forEach((e) => (e.status = "queued"));

  state.isProcessing = true;
  setError(null);
  dom.busyOverlay.classList.add("active");
  startJobProgressPolling();
  const isCached = tierInfo ? tierInfo.cached !== false : true;

  const presetName = PRESET_NAMES[snap.tier] || snap.tier.toUpperCase();
  const qualityDesc =
    snap.exportWidth > 0 || snap.exportHeight > 0
      ? `${snap.exportWidth || "AUTO"}×${snap.exportHeight || "AUTO"}`
      : `${Math.round((snap.scale || 1) * 100)}%`;
  const destDesc = outputDir
    ? outputDir
    : "browser downloads (openbgr-cutouts.zip)";
  const batchDesc =
    `Processing using ${presetName}...` +
    (isCached ? "" : " Fetching model weights...");

  if (tab.id === state.activeTabId) renderBatchPanel(tab);
  syncMenuBarState();

  const controller = new AbortController();
  state.abortController = controller;
  let completed = 0;

  for (let i = 0; i < batch.total; i++) {
    if (batch.cancelled) break;
    batch.index = i;
    const entry = tab.batchFiles[i];
    const label = `${i + 1}/${batch.total}`;
    entry.status = "processing";
    updateBatchRowStatus(tab, i);
    dom.busyTitle.textContent = `PROCESSING BATCH (${label})`;
    dom.busySub.textContent = batchDesc;
    if (tab.id === state.activeTabId) dom.statTime.textContent = label;

    try {
      const fd = new FormData();
      fd.append("file", entry.file);
      fd.append("tier", snap.tier);
      fd.append("defringe", snap.defringe ? "true" : "false");
      fd.append("despill", snap.despill ? "true" : "false");

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
      if (batch.cancelled || controller.signal.aborted) {
        entry.status = "queued";
        updateBatchRowStatus(tab, i);
        break;
      }

      const outBlob = await buildBatchExportBlob(blob, snap);
      const ext = FORMAT_EXT[snap.format] || "png";
      const stem = (entry.name || "image").replace(/\.[^.]+$/, "") || "image";
      const suffix = snap.format === "mask" ? "mask" : "cutout";
      const outName = `${stem}-${suffix}.${ext}`;

      if (outputDir) {
        const ok = await saveBatchFile(outputDir, outName, outBlob);
        if (!ok) {
          entry.status = "failed";
          batch.failed++;
          updateBatchRowStatus(tab, i);
          continue;
        }
      } else {
        batch.results.push({ name: outName, blob: outBlob });
      }
      entry.status = "done";
      completed++;
      updateBatchRowStatus(tab, i);
    } catch (err) {
      if (err?.name === "AbortError" || batch.cancelled) {
        entry.status = "queued";
        updateBatchRowStatus(tab, i);
        break;
      }
      entry.status = "failed";
      batch.failed++;
      updateBatchRowStatus(tab, i);
    }
  }

  const wasCancelled = batch.cancelled;
  batch.running = false;
  batch.cancelled = false;
  batch.tabId = null;
  state.isProcessing = false;
  state.abortController = null;
  dom.busyOverlay.classList.remove("active");
  stopJobProgressPolling();

  if (!outputDir && batch.results.length > 0) {
    const entries = await Promise.all(
      batch.results.map(async (r) => ({
        name: r.name,
        data: new Uint8Array(await r.blob.arrayBuffer()),
      }))
    );
    downloadBlob(buildZip(entries), "openbgr-cutouts.zip");
  }
  batch.results = [];

  tab.elapsedText = wasCancelled
    ? `CANCELLED ${completed}/${batch.total}`
    : `${completed}/${batch.total} DONE`;
  if (tab.id === state.activeTabId) {
    dom.statTime.textContent = tab.elapsedText;
    renderBatchPanel(tab);
  }
  syncMenuBarState();

  if (wasCancelled) return;
  openConfirmModal(
    {
      title: "BATCH COMPLETE",
      message:
        `${completed} of ${batch.total} image${batch.total > 1 ? "s" : ""} processed` +
        (batch.failed > 0 ? `, ${batch.failed} failed` : "") +
        (outputDir
          ? `.\nSaved to: ${outputDir}`
          : ".\nDownloaded as openbgr-cutouts.zip."),
      confirmText: "DONE",
      hideCancel: true,
    },
    () => {}
  );
}

/** Entry point for the Batch shortcut: pick files, then create a batch tab. */
export function requestBatch() {
  if (state.batch.running) return;
  pickImageFiles(requestBatchDispatch);
}

/** Handles files routed into batch mode from the shared file input. */
export function requestBatchDispatch(files) {
  const active = getActiveTab();
  if (active?.kind === "batch") {
    addFilesToBatchTab(active, files);
  } else {
    createBatchTab(files);
  }
}

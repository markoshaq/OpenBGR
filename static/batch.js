/**
 * Batch processing: queue tab model, batch panel UI, folder-style tab merge,
 * row drag-out, tab context menu, and sequential `/api/remove-bg` execution.
 */

import {
  state,
  dom,
  apiFetch,
  apiErrorDetail,
  getActiveTab,
  defaultTierForNewTab,
  createTabRecord,
  revokeTabUrls,
  saveStateToActiveTab,
  setError,
  openConfirmModal,
  triggerOpenFileDialog,
  filesFromDialogResult,
  isImageFile,
  downloadBlob,
  FORMAT_EXT,
  DEFAULT_CROP_PADDING,
  formatElapsed,
} from "./state.js";
import {
  updateDestUI,
  buildBatchExportBlob,
  saveBatchFile,
  buildZip,
  createZipWriter,
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
  isModelDownloadActive,
  buildRemoveBgForm,
  recordInferenceEstimate,
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
      const files = await filesFromDialogResult(res);
      if (files.length > 0) cb(files);
      return;
    } catch (err) {
      console.warn("[OpenBGR] Native image dialog failed:", err);
    }
  }
  state.expectingBatch = true;
  triggerOpenFileDialog();
}

/** Creates a batch tab from a file list and switches to it. */
function createBatchTab(files) {
  const list = Array.from(files || []).filter(isImageFile);
  if (!list.length) {
    if (Array.from(files || []).length) {
      setError("Only image files can be processed.");
    }
    return;
  }
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
  const all = Array.from(files || []).filter(Boolean);
  const images = all.filter(isImageFile);
  if (all.length && images.length === 0) {
    setError("Only image files can be processed.");
  } else if (images.length < all.length) {
    setError("Non-image files skipped.");
  }
  images.forEach((f) =>
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

/**
 * Formats a byte count for batch row file-size labels. Unlike the shared
 * `formatDiskBytes` (disk/model sizes, MB-floored), this keeps B/KB units for
 * small uploads and renders an empty size as "--".
 */
function formatFileSize(n) {
  if (!n) return "--";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Updates the batch header counters, check-all state, row disabled flags, and
 * Run button label without rebuilding the queue DOM. Called from
 * `syncMenuBarState`, which fires on every state change; the row list itself
 * is only rebuilt by `renderBatchPanel` on structural changes.
 */
// Row elements of the currently rendered batch panel, indexed by queue
// position, so status/toggle updates avoid O(n) selector scans per event.
let batchRowEls = [];
// Whether the row buttons were last disabled; the O(n) write only repeats
// when the running flag actually flips, not on every state sync.
let batchListDisabled = null;

export function syncBatchPanelChrome(tab) {
  if (!dom.batchPanel || tab.kind !== "batch") return;
  const n = tab.batchFiles.length;
  const selCount = tab.batchFiles.filter((e) => e.selected !== false).length;
  const runningThis = state.batch.running && state.batch.tabId === tab.id;
  dom.batchSub.textContent =
    selCount === n
      ? `${n} IMAGE${n === 1 ? "" : "S"}`
      : `${selCount}/${n} SELECTED`;

  if (dom.batchCheckAll) {
    dom.batchCheckAll.textContent =
      selCount === 0 ? "" : selCount === n ? "x" : "–";
    dom.batchCheckAll.classList.toggle("on", selCount > 0);
    dom.batchCheckAll.disabled = state.batch.running;
  }

  // Cosmetic disable while a run owns the queue; the click guards still check
  // `state.batch.running` so a stale row can't mutate mid-flight.
  if (batchListDisabled !== state.batch.running) {
    batchListDisabled = state.batch.running;
    for (const row of batchRowEls) {
      row.firstElementChild.disabled = state.batch.running;
      row.lastElementChild.disabled = state.batch.running;
    }
  }

  if (dom.btnDownload) {
    dom.btnDownload.classList.toggle(
      "disabled",
      n === 0 || selCount === 0 || (state.isProcessing && !runningThis)
    );
    dom.btnDownload.textContent = runningThis ? "BATCH RUNNING…" : "RUN BATCH";
  }

  if (dom.btnBatchRetry) {
    const hasFailed = tab.batchFiles.some(
      (e) => e.status === "failed" && e.selected !== false
    );
    dom.btnBatchRetry.style.display =
      hasFailed && !state.batch.running ? "" : "none";
  }
}

/** Wires the check-all toggle in the batch panel header for `tab`'s queue. */
function wireBatchCheckAll(tab) {
  if (!dom.batchCheckAll) return;
  dom.batchCheckAll.onclick = () => {
    if (state.batch.running) return;
    const selCount = tab.batchFiles.filter(
      (e) => e.selected !== false
    ).length;
    const turnOn = selCount !== tab.batchFiles.length;
    tab.batchFiles.forEach((e) => {
      e.selected = turnOn;
      if (!turnOn && e.status === "queued") e.status = "skipped";
      if (turnOn && e.status === "skipped") e.status = "queued";
    });
    renderBatchPanel(tab);
  };
}

/** Toggles one queue entry's selected state and repaints its row + counters. */
function toggleBatchRowSelection(tab, row, chk) {
  // Look up the row's live index: rows re-index after removals, so a
  // closure over the render-time index would target the wrong entry.
  const idx = Number(row.getAttribute("data-idx"));
  const ent = tab.batchFiles[idx];
  if (!ent) return;
  const on = ent.selected === false;
  ent.selected = on;
  if (!on && ent.status === "queued") ent.status = "skipped";
  if (on && ent.status === "skipped") ent.status = "queued";
  row.classList.toggle("off", !on);
  chk.classList.toggle("on", on);
  chk.setAttribute("aria-checked", String(on));
  chk.textContent = on ? "x" : "";
  updateBatchRowStatus(tab, idx);
  syncBatchPanelChrome(tab);
}

/** Removes one queue entry; closes the tab when the queue empties out. */
function removeBatchRow(tab, row) {
  const idx = Number(row.getAttribute("data-idx"));
  if (idx < 0 || idx >= tab.batchFiles.length) return;
  tab.batchFiles.splice(idx, 1);
  if (tab.batchFiles.length === 0) {
    batchRowEls = [];
    closeTabImmediate(tab.id);
    return;
  }
  batchRowEls.splice(idx, 1)[0].remove();
  // Re-index the rows after the removed one; handlers read data-idx live.
  for (let j = idx; j < batchRowEls.length; j++) {
    batchRowEls[j].setAttribute("data-idx", String(j));
  }
  syncBatchPanelChrome(tab);
  renderTabBar();
}

/** Builds one queue row: checkbox, name, size, status chip, remove, and drag. */
function buildBatchRow(tab, entry, i) {
  const on = entry.selected !== false;
  const row = document.createElement("div");
  row.className = `batch-row${on ? "" : " off"}`;
  row.setAttribute("data-idx", String(i));
  row.draggable = true;
  batchRowEls.push(row);
  row.addEventListener("dragstart", (e) => {
    if (state.batch.running) {
      e.preventDefault();
      return;
    }
    state.dragBatchItem = {
      tabId: tab.id,
      index: Number(row.getAttribute("data-idx")),
    };
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

  const chk = document.createElement("button");
  chk.type = "button";
  chk.className = `batch-check${on ? " on" : ""}`;
  chk.setAttribute("role", "checkbox");
  chk.setAttribute("aria-checked", String(on));
  chk.title = "Include in batch run";
  chk.textContent = on ? "x" : "";
  chk.disabled = state.batch.running;
  chk.addEventListener("click", (e) => {
    e.stopPropagation();
    if (state.batch.running) return;
    toggleBatchRowSelection(tab, row, chk);
  });

  const name = document.createElement("span");
  name.className = "batch-row-name";
  name.textContent = entry.name;
  name.title = entry.name;
  const size = document.createElement("span");
  size.className = "batch-row-size";
  size.textContent = formatFileSize(entry.size);
  const st = document.createElement("span");
  st.className = `batch-row-status st-${entry.status}`;
  st.textContent = entry.status.toUpperCase();
  if (entry.error) st.title = entry.error;
  const rm = document.createElement("button");
  rm.type = "button";
  rm.className = "batch-row-remove";
  rm.textContent = "x";
  rm.title = "Remove from batch";
  rm.disabled = state.batch.running;
  rm.addEventListener("click", (e) => {
    e.stopPropagation();
    if (state.batch.running) return;
    removeBatchRow(tab, row);
  });
  row.append(chk, name, size, st, rm);
  return row;
}

/** Rebuilds the queue row list, or shows the empty-batch hint. */
function renderBatchRows(tab) {
  batchRowEls = [];
  dom.batchList.replaceChildren();
  if (tab.batchFiles.length === 0) {
    const hint = document.createElement("div");
    hint.className = "batch-empty-hint";
    hint.textContent = "EMPTY BATCH - DROP IMAGES OR USE ADD IMAGE";
    dom.batchList.appendChild(hint);
    return;
  }
  tab.batchFiles.forEach((entry, i) => {
    dom.batchList.appendChild(buildBatchRow(tab, entry, i));
  });
}

/** Re-renders the batch queue list, counters, and Run button state. */
export function renderBatchPanel(tab) {
  if (!dom.batchPanel || tab.kind !== "batch") return;
  dom.batchPanel.classList.add("active");
  dom.stage.classList.remove("visible");
  dom.emptyState.style.display = "none";

  wireBatchCheckAll(tab);
  updateDestUI();
  renderBatchRows(tab);
  syncBatchPanelChrome(tab);
}

/** Sets one row's status chip; a stored failure reason rides along as tooltip. */
function updateBatchRowStatus(tab, i) {
  if (tab.id !== state.activeTabId || !dom.batchList) return;
  const row = batchRowEls[i];
  const entry = tab.batchFiles[i];
  if (!row || !entry) return;
  const st = row.querySelector(".batch-row-status");
  if (st) {
    st.className = `batch-row-status st-${entry.status}`;
    st.textContent = entry.status.toUpperCase();
    st.title = entry.error || "";
  }
}

/** Converts a single-image tab into a batch tab seeded with its image. */
function convertTabToBatch(tab) {
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

/**
 * Replaces a tab's title with an inline rename input: Enter or blur commits,
 * Escape cancels. Batch tabs keep their "(N)" queue-count suffix since only
 * `tab.name` is edited.
 */
function startTabRename(tab) {
  const tabEl = dom.tabBar?.querySelector(`[data-tab-id="${tab.id}"]`);
  const titleEl = tabEl?.querySelector(".tab-title");
  if (!titleEl) return;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "tab-rename-input";
  input.value = tab.name;
  input.maxLength = 64;
  input.spellcheck = false;
  titleEl.replaceChildren(input);
  tabEl.draggable = false;
  input.focus();
  input.select();

  let settled = false;
  const finish = (commit) => {
    if (settled) return;
    settled = true;
    const name = input.value.trim();
    if (commit && name) tab.name = name;
    renderTabBar();
    if (
      commit &&
      tab.kind !== "batch" &&
      tab.id === state.activeTabId &&
      name
    ) {
      dom.statFile.textContent = tab.name.toUpperCase();
    }
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    }
  });
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("blur", () => finish(true));
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
      "ADD IMAGE…",
      () => {
        pickImageFiles((files) => addFilesToBatchTab(tab, files));
      },
      state.batch.running
    );
  }
  if (menu.children.length) addSep();
  addItem("RENAME TAB", () => startTabRename(tab));
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
  if (tierInfo && tierInfo.cached === false && !navigator.onLine) {
    setError("Selected model is not cached on disk and device is currently offline.");
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
  syncMenuBarState();
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
          : zipHandle
            ? `.\nSaved to: ${zipHandle.name}`
            : ".\nDownloaded as openbgr-cutouts.zip."),
      confirmText: "DONE",
      hideCancel: true,
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

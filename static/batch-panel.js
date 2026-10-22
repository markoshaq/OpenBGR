/**
 * Batch queue panel UI: row building, selection/remove handlers, drag-out,
 * check-all, header counters, and Run button chrome. The queue model and
 * context menu live in batch.js; the run lifecycle in batch-run.js.
 * Importing this module has no side effects.
 */

import { state, dom } from "./state.js";
import { updateDestUI } from "./export-ui.js";

// Tab-strip operations injected once at boot by `initBatchPanel` (app.js wires
// the real functions; tests inject stubs). Kept out of the import list so the
// workspace coordinator (tabs.js) can call into this module without a cycle.
let tabOps = {};
export function initBatchPanel(ops) {
  tabOps = ops;
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

// Row elements of the currently rendered batch panel, indexed by queue
// position, so status/toggle updates avoid O(n) selector scans per event.
let batchRowEls = [];
// Whether the row buttons were last disabled; the O(n) write only repeats
// when the running flag actually flips, not on every state sync.
let batchListDisabled = null;

/**
 * Updates the batch header counters, check-all state, row disabled flags, and
 * Run button label without rebuilding the queue DOM. Called from
 * `syncMenuBarState`, which fires on every state change; the row list itself
 * is only rebuilt by `renderBatchPanel` on structural changes.
 */
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
    tabOps.closeTabImmediate(tab.id);
    return;
  }
  batchRowEls.splice(idx, 1)[0].remove();
  // Re-index the rows after the removed one; handlers read data-idx live.
  for (let j = idx; j < batchRowEls.length; j++) {
    batchRowEls[j].setAttribute("data-idx", String(j));
  }
  syncBatchPanelChrome(tab);
  tabOps.renderTabBar();
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
    tabOps.hideTabGhost();
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
export function updateBatchRowStatus(tab, i) {
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

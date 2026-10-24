/**
 * Batch queue model: creating and extending batch tabs, folder-style tab
 * merges, row drag-out, and the shared tab context menu. Panel rendering
 * lives in batch-panel.js; the sequential run in batch-run.js.
 */

import {
  state,
  dom,
  prefs,
  getActiveTab,
  defaultTierForNewTab,
  createTabRecord,
  revokeTabUrls,
  saveStateToActiveTab,
  setError,
  openConfirmModal,
  openContextMenu,
  triggerOpenFileDialog,
  filesFromDialogResult,
  isImageFile,
} from "./state.js";
import { cancelProcessing } from "./segmentation.js";
import { renderBatchPanel } from "./batch-panel.js";
import { runBatch } from "./batch-run.js";
import { on } from "./bus.js";

// Tab-strip operations injected once at boot by `initBatch` (app.js wires the
// real functions; tests inject stubs). Kept out of the import list so the
// workspace coordinator (tabs.js) can call into this module without a cycle.
let tabOps = {};
export function initBatch(ops) {
  tabOps = ops;
}

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
        list.forEach((f) => tabOps.ingestImageFile(f));
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
  tabOps.switchToTab(tab.id);
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
  tabOps.renderTabBar();
}

/** Converts a plain image tab into a batch tab seeded with its current file. */
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
  tab.previewSignature = null;
  tab.previewSource = null;
  tab.refineJobId = null;
  tab.naturalWidth = 0;
  tab.naturalHeight = 0;
  // GIF-only state cannot survive the conversion: frames reference revoked
  // URLs, and `gif` is an animation export, not a per-image format.
  tab.isAnimated = false;
  tab.frames = [];
  tab.currentFrameIndex = 0;
  tab.startFrame = 1;
  tab.endFrame = 1;
  if (tab.exportFormat === "gif") {
    tab.exportFormat = prefs.defaultFormat || "png";
  }
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

  tabOps.switchToTab(dst.id);
}

/** Pulls one queue entry out of a batch into its own image tab. */
export function extractBatchItemToTab(tab, index) {
  const entry = tab.batchFiles[index];
  if (!entry || state.batch.running) return;
  tab.batchFiles.splice(index, 1);
  tabOps.ingestImageFile(entry.file);
  if (tab.batchFiles.length === 0) {
    tabOps.closeTabImmediate(tab.id);
  } else {
    tabOps.renderTabBar();
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
    tabOps.closeTabImmediate(src.id);
  } else if (src.id === state.activeTabId) {
    renderBatchPanel(src);
  }
  tabOps.renderTabBar();
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
    tabOps.renderTabBar();
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
  const hasFiles = tab.kind === "batch" || Boolean(tab.sourceFile);
  openContextMenu(x, y, (m) => {
    if (tab.kind !== "batch" && hasFiles) {
      m.item("SEND TO NEW BATCH", () => {
        convertTabToBatch(tab);
        if (tab.id === state.activeTabId) {
          state.activeTabId = null;
          tabOps.switchToTab(tab.id);
        }
        tabOps.renderTabBar();
      });
    }
    const others = state.tabs.filter(
      (t) => t.kind === "batch" && t.id !== tab.id
    );
    if (hasFiles && others.length) {
      m.sep();
      m.head("ADD TO BATCH");
      others.forEach((b) => {
        m.item(`${b.name} (${b.batchFiles.length})`, () =>
          mergeTabsIntoBatch(tab.id, b.id)
        );
      });
    }
    if (tab.kind === "batch") {
      m.item("RUN BATCH", () => runBatch(tab), state.batch.running);
      m.item(
        "ADD IMAGE…",
        () => {
          pickImageFiles((files) => addFilesToBatchTab(tab, files));
        },
        state.batch.running
      );
    }
    m.sep();
    m.item("RENAME TAB", () => startTabRename(tab));
    m.item("CLOSE TAB", () => onRequestCloseTab(tab.id));
  });
}

/** Dismisses the tab context menu. */
export function hideTabContextMenu() {
  if (dom.tabContextMenu) dom.tabContextMenu.style.display = "none";
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

// "context-menu:hide" lets modules dismiss this menu without importing batch.js.
on("context-menu:hide", hideTabContextMenu);

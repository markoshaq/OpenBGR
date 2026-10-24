/**
 * Getting images into the workspace from outside: the Open dialog (native
 * bridge or hidden file input), window and tab-bar drag-and-drop, and files
 * handed over by the OS (argv, Finder "Open With", Dock drops).
 * Importing this module has no side effects; app.js calls `initOpenFiles()`
 * and `startPendingFilesPoll()`.
 */

import {
  state,
  dom,
  apiFetch,
  getActiveTab,
  setError,
  openConfirmModal,
  triggerOpenFileDialog,
  filesFromDialogResult,
  isImageFile,
} from "./state.js";
import {
  openMultiFileChooser,
  pickImageFiles,
  addFilesToBatchTab,
  extractBatchItemToTab,
  requestBatchDispatch,
} from "./batch.js";
import {
  showTabGhost,
  hideTabGhost,
  ingestImageFile,
} from "./tabs.js";
import { cancelProcessing } from "./segmentation.js";

/** Opens the image picker via native bridge or the hidden file input. */
export async function openImageDialog() {
  if (window.pywebview?.api?.open_image_dialog) {
    try {
      const res = await window.pywebview.api.open_image_dialog();
      if (res?.error) {
        setError(res.error);
        return;
      }
      const files = await filesFromDialogResult(res);
      if (files.length > 1) {
        openMultiFileChooser(files, "SELECTED");
      } else if (files.length === 1) {
        ingestImageFile(files[0]);
      }
      return;
    } catch (err) {
      console.warn("[OpenBGR] Native image dialog failed:", err);
    }
  }
  triggerOpenFileDialog();
}

/** Entry point for the Open action; routes to batch or single-image ingestion. */
export function requestOpenImage() {
  if (state.isProcessing) {
    openConfirmModal(
      {
        message:
          "This will stop the current image processing. Do you want to open a new image?",
      },
      () => {
        cancelProcessing();
        openImageDialog();
      }
    );
    return;
  }
  openImageDialog();
}

/** Hidden file input `change`: filters to images and routes batch, multi, or single picks. */
export function handleFileInputChange(e) {
  const picked = Array.from(e.target.files || []);
  const files = picked.filter(isImageFile);
  const expecting = state.expectingBatch;
  state.expectingBatch = false;
  if (picked.length && files.length === 0) {
    setError("Only image files can be processed.");
    return;
  }
  if (files.length < picked.length) {
    setError("Non-image files skipped.");
  }
  if (files.length === 0) return;
  if (expecting) {
    requestBatchDispatch(files);
    return;
  }
  if (files.length > 1) {
    openMultiFileChooser(files, "SELECTED");
    return;
  }
  if (state.isProcessing) cancelProcessing();
  files.forEach((f) => ingestImageFile(f));
}

/** Finishes a batch-row drag: the row becomes its own tab unless dropped back on the list. */
function dropBatchItem(item, target) {
  state.dragBatchItem = null;
  hideTabGhost();
  if (target?.closest?.(".batch-list")) return;
  const src = state.tabs.find((t) => t.id === item.tabId);
  if (src) extractBatchItemToTab(src, item.index);
}

/** Window `drop`: batch-row extraction, else image files into the batch, chooser, or a tab. */
export function handleWindowDrop(e) {
  e.preventDefault();
  dom.viewport.classList.remove("dragover");

  const item = state.dragBatchItem;
  if (item) {
    dropBatchItem(item, e.target);
    return;
  }

  const dropped = Array.from(e.dataTransfer?.files || []);
  if (dropped.length === 0) return;
  const files = dropped.filter(isImageFile);
  if (files.length === 0) {
    setError("Only image files can be processed.");
    return;
  }
  if (files.length < dropped.length) {
    setError("Non-image files skipped.");
  }

  const activeTab = getActiveTab();
  if (activeTab?.kind === "batch" && !state.batch.running) {
    addFilesToBatchTab(activeTab, files);
    return;
  }

  if (files.length > 1) {
    openMultiFileChooser(files, "DROPPED");
    return;
  }

  if (state.isProcessing) {
    openConfirmModal(
      {
        message:
          "This will stop the current image processing. Do you want to load the dropped image?",
      },
      () => {
        cancelProcessing();
        files.forEach((f) => ingestImageFile(f));
      }
    );
    return;
  }
  files.forEach((f) => ingestImageFile(f));
}

/** Tab bar `drop`: a batch row dropped on empty tab-bar space becomes a tab. */
export function handleTabBarDrop(e) {
  const item = state.dragBatchItem;
  if (!item) return;
  e.preventDefault();
  e.stopPropagation();
  dropBatchItem(item);
}

/**
 * Pulls image paths handed over by the OS (argv, Finder "Open With", Dock drops)
 * from the native bridge and loads them. Called on startup, on a poll interval,
 * and pushed by the backend whenever a new open-request arrives while running.
 */
export async function pullPendingFiles() {
  try {
    let res = null;
    if (window.pywebview?.api?.take_pending_files) {
      // The bridge drains the same Python queue as the HTTP endpoint, so an
      // empty bridge answer is definitive; no redundant POST needed.
      res = await window.pywebview.api.take_pending_files();
    } else {
      const httpRes = await apiFetch("/api/pending-files", { method: "POST" });
      if (httpRes.ok) res = await httpRes.json();
    }
    if (res?.error) {
      setError(res.error);
      return;
    }
    const files = await filesFromDialogResult(res);
    if (!files.length) return;
    if (state.isProcessing) cancelProcessing();
    if (files.length > 1) {
      openMultiFileChooser(files, "SELECTED");
    } else {
      ingestImageFile(files[0]);
    }
  } catch (err) {
    console.warn("[OpenBGR] Failed to pull pending files:", err);
  }
}

/**
 * Poll period for OS-delivered files. In desktop mode the backend pushes new
 * arrivals over evaluate_js, so the poll is only a safety net and can run
 * slowly; in browser mode the poll is the only channel, so it stays quick.
 */
export function pendingFilesPollMs() {
  return window.pywebview?.api?.take_pending_files ? 10000 : 2000;
}

/**
 * Ingests OS-delivered files once the bridge is up, then keeps polling so
 * files sent to an already-running instance arrive too. Returns the interval id.
 */
export function startPendingFilesPoll() {
  pullPendingFiles();
  return setInterval(pullPendingFiles, pendingFilesPollMs());
}

/** Wires the Open buttons, hidden file input, and window/tab-bar drop targets. */
export function initOpenFiles() {
  dom.emptyState.addEventListener("click", requestOpenImage);
  dom.btnOpen.addEventListener("click", requestOpenImage);

  dom.btnBatchAdd?.addEventListener("click", () => {
    const tab = getActiveTab();
    if (!tab || tab.kind !== "batch" || state.batch.running) return;
    pickImageFiles((files) => addFilesToBatchTab(tab, files));
  });

  dom.fileInput.addEventListener("change", handleFileInputChange);
  // Cancelling the file dialog must clear the batch dispatch intent, otherwise
  // the next normal Open would be routed into a batch queue.
  dom.fileInput.addEventListener("cancel", () => {
    state.expectingBatch = false;
  });

  window.addEventListener("dragover", (e) => {
    e.preventDefault();
    dom.viewport.classList.add("dragover");
  });
  window.addEventListener("dragleave", (e) => {
    // Only clear the highlight when the drag leaves the window entirely;
    // dragleave also fires while crossing between child elements.
    if (!e.relatedTarget) {
      dom.viewport.classList.remove("dragover");
    }
  });
  window.addEventListener("drop", handleWindowDrop);

  // Tab bar dropzone for dragging a batch row onto empty tab-bar space
  dom.tabBar?.addEventListener("dragover", (e) => {
    if (!state.dragBatchItem) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    const src = state.tabs.find((t) => t.id === state.dragBatchItem.tabId);
    const name = src?.batchFiles[state.dragBatchItem.index]?.name || "image";
    showTabGhost(name);
  });
  dom.tabBar?.addEventListener("dragleave", (e) => {
    if (!dom.tabBar.contains(e.relatedTarget)) hideTabGhost();
  });
  dom.tabBar?.addEventListener("drop", handleTabBarDrop);
}

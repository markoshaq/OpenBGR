/**
 * Animated export pre-encoding: a GIF's byte size is only knowable after a
 * real encode (palette quantization and inter-frame deltas decide it), so
 * once the export settings settle this module runs a hidden encode. The size
 * label gets the exact byte count and EXPORT reuses the cached blob instead
 * of re-encoding.
 * Importing this module has no side effects.
 */

import {
  state,
  dom,
  formatDiskBytes,
  saveStateToActiveTab,
} from "./state.js";
import {
  isAnimatedExport,
  exportSignature,
  currentExportSource,
  exportCacheMatches,
  callAnimatedExportBuilder,
} from "./export.js";

const ANIM_ENCODE_DEBOUNCE_MS = 1500;

let animExportTimer = null;
let animExportRunning = false;
let animExportQueued = false;

/** Debounced kick for `runAnimatedExportSize`; coalesces settings bursts. */
export function scheduleAnimatedExportSize() {
  if (!isAnimatedExport()) return;
  if (animExportTimer) clearTimeout(animExportTimer);
  animExportTimer = setTimeout(() => {
    animExportTimer = null;
    void runAnimatedExportSize();
  }, ANIM_ENCODE_DEBOUNCE_MS);
}

async function runAnimatedExportSize() {
  if (animExportRunning) {
    animExportQueued = true;
    return;
  }
  animExportRunning = true;
  try {
    do {
      animExportQueued = false;
      if (
        state.isProcessing ||
        !isAnimatedExport() ||
        exportCacheMatches()
      ) {
        return;
      }
      const tabId = state.activeTabId;
      const source = currentExportSource();
      if (!source) return;
      const sig = exportSignature();
      let blob;
      try {
        blob = await callAnimatedExportBuilder("gif", { showOverlay: false });
      } catch {
        // Unprocessed frames or a server hiccup: the explicit export path
        // surfaces the real error when the user clicks EXPORT.
        if (dom.exportSizeLabel) {
          dom.exportSizeLabel.textContent = "--";
        }
        return;
      }
      if (!blob) return;
      // Settings or the active tab moved on mid-encode: discard and
      // re-evaluate against the current signature.
      if (
        state.activeTabId !== tabId ||
        source !== currentExportSource() ||
        sig !== exportSignature()
      ) {
        continue;
      }
      state.exportCacheBlob = blob;
      state.exportCacheSignature = sig;
      state.exportCacheSource = source;
      if (dom.exportSizeLabel) {
        dom.exportSizeLabel.textContent = formatDiskBytes(blob.size);
      }
      saveStateToActiveTab();
    } while (animExportQueued || !exportCacheMatches());
  } finally {
    animExportRunning = false;
  }
}

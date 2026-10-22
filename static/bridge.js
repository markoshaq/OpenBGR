/**
 * The `window.openBGR` command bridge: one entry per app command, shared by
 * the in-app menu bar, keyboard shortcuts, and the pywebview native menus
 * (which call `window.openBGR.<name>()` through evaluate_js). Each command
 * checks its own preconditions, so callers can invoke it unconditionally.
 * Importing this module has no side effects; app.js calls `installBridge()`.
 */

import {
  state,
  dom,
  prefs,
  TIER_KEYS,
  setPref,
  getActiveTab,
  normalizeTierKey,
  openConfirmModal,
  openExternalUrl,
} from "./state.js";
import { setZoom } from "./stage.js";
import {
  exportActiveImage,
  copyActiveCutout,
  copyOriginalImage,
} from "./export-io.js";
import { openPrefsDialog, applyPreferences } from "./preferences.js";
import { requestBatch } from "./batch.js";
import {
  createBlankTab,
  requestCloseTab,
  reopenClosedTab,
  requestSwitchToTab,
  setViewMode,
  selectTier,
  toggleLoupe,
  syncMenuBarState,
} from "./tabs.js";
import { cancelProcessing, runSegmentation } from "./segmentation.js";
import { pasteImageFromClipboard } from "./clipboard.js";
import { requestOpenImage, pullPendingFiles } from "./open-files.js";
import { openRecentDialog } from "./recent.js";

// Menu bar & keyboard shortcut command bridge (also invoked by pywebview native menus)
export const commands = {
  pullPendingFiles: () => pullPendingFiles(),
  newTab: () => {
    if (!getActiveTab()) return;
    if (state.isProcessing) {
      openConfirmModal(
        {
          title: "STOP CURRENT IMAGE?",
          message: "Opening a new tab will stop the current image processing.",
          confirmText: "STOP & OPEN TAB",
          cancelText: "KEEP PROCESSING",
        },
        () => {
          cancelProcessing();
          createBlankTab();
        }
      );
      return;
    }
    createBlankTab();
  },
  openImage: () => requestOpenImage(),
  openRecent: () => openRecentDialog(),
  reopenClosedTab: () => {
    if (state.closedTabs.length) reopenClosedTab();
  },
  startBatch: () => requestBatch(),
  exportImage: () => {
    if (state.resultBlob && !state.isProcessing) exportActiveImage();
  },
  copyImage: () => {
    if (state.resultBlob && !state.isProcessing) copyActiveCutout();
  },
  copyOriginalImage: () => {
    if (state.sourceFile) copyOriginalImage();
  },
  closeActiveTab: () => {
    if (state.activeTabId) requestCloseTab(state.activeTabId);
  },
  switchToTabAt: (n) => {
    const tabs = state.tabs;
    const target = n === 9 ? tabs[tabs.length - 1] : tabs[n - 1];
    if (target && target.id !== state.activeTabId) requestSwitchToTab(target.id);
  },
  switchTabOffset: (delta) => {
    const tabs = state.tabs;
    const idx = tabs.findIndex((t) => t.id === state.activeTabId);
    if (idx < 0 || tabs.length < 2) return;
    const next = tabs[(idx + delta + tabs.length) % tabs.length];
    requestSwitchToTab(next.id);
  },
  pasteImage: () => pasteImageFromClipboard(),
  restartApp: () => {
    window.pywebview?.api?.restart_app?.();
  },
  setView: (mode) => {
    if (state.resultBlob && ["split", "cutout", "original"].includes(mode)) {
      setViewMode(mode);
    }
  },
  zoomIn: () => {
    if (state.sourceFile) setZoom(state.zoom + 0.25);
  },
  zoomOut: () => {
    if (state.sourceFile) setZoom(state.zoom - 0.25);
  },
  zoomReset: () => {
    if (state.sourceFile) setZoom(1);
  },
  toggleLoupe: () => {
    if (state.sourceFile) toggleLoupe();
  },
  toggleTheme: () => {
    setPref("theme", prefs.theme === "light" ? "dark" : "light");
    applyPreferences(syncMenuBarState);
  },
  toggleFullscreen: () => {
    if (window.pywebview?.api?.toggle_fullscreen) {
      window.pywebview.api.toggle_fullscreen();
    } else if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch((err) => {
        console.warn("[OpenBGR] Fullscreen request failed:", err);
      });
    } else {
      document.exitFullscreen?.().catch((err) => {
        console.warn("[OpenBGR] Exiting fullscreen failed:", err);
      });
    }
  },
  selectPreset: (tierKey) => {
    const norm = normalizeTierKey(tierKey);
    if (TIER_KEYS.includes(norm) && norm !== state.tier) {
      selectTier(norm);
    }
  },
  toggleDefringe: () => dom.btnDefringe.click(),
  toggleDespill: () => dom.btnDespill?.click(),
  rerunSegmentation: () => {
    if (state.sourceFile && !state.isProcessing) runSegmentation();
  },
  cancelProcessing: () => {
    if (state.isProcessing) cancelProcessing();
  },
  openSettings: (section) => openPrefsDialog(section),
  openGithub: () => openExternalUrl("https://github.com/markoshaq/OpenBGR"),
  quitApp: () => {
    if (window.pywebview?.api?.quit) {
      window.pywebview.api.quit();
    } else {
      window.close();
    }
  },
};

/** Publishes the command bridge as `window.openBGR`. */
export function installBridge() {
  window.openBGR = commands;
  return commands;
}

/** Routes target=_blank links through the native bridge when the app runs in a desktop window. */
export function initExternalLinks() {
  document.querySelectorAll('a[target="_blank"]').forEach((link) => {
    link.addEventListener("click", (e) => {
      if (window.pywebview?.api?.open_external) {
        e.preventDefault();
        openExternalUrl(link.href);
      }
    });
  });
}

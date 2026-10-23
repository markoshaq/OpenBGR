/**
 * OpenBGR - Frontend Entry Point
 * Boots the feature modules in order and applies the startup state.
 * Feature modules have no import side effects; only this file runs code at
 * load, so the modules stay importable under node --test.
 */

import { state } from "./state.js";
import { syncFormatButtons, applyBackdrop } from "./export-ui.js";
import {
  syncServerStatus,
  applyPreferences,
  initConnectivity,
} from "./preferences.js";
import {
  selectTier,
  syncMenuBarState,
  renderTabBar,
  closeTabImmediate,
  switchToTab,
  ingestImageFile,
  hideTabGhost,
  setViewMode,
} from "./tabs.js";
import { initBatch } from "./batch.js";
import { initBatchPanel } from "./batch-panel.js";
import { initBatchRun } from "./batch-run.js";
import { initSegmentation } from "./segmentation.js";
import { installBridge, initExternalLinks } from "./bridge.js";
import { initTooltips } from "./tooltips.js";
import { initTierDropdown } from "./tier-dropdown.js";
import { initBackdrop } from "./backdrop.js";
import { initStageInput } from "./stage-input.js";
import { initOpenFiles, startPendingFilesPoll } from "./open-files.js";
import { initClipboard } from "./clipboard.js";
import { initRecent } from "./recent.js";
import { initKeyboard } from "./keyboard.js";
import { initMenuBar } from "./menubar.js";
import { initModals } from "./modals.js";
import { initSettings } from "./settings.js";
import { initControls } from "./controls.js";
import { initAnimation } from "./animation.js";

// Startup initialization (order mirrors the old top-level wiring sequence).
// The workspace domain modules take their upward tab-strip calls as injected
// collaborators so the import graph stays acyclic. Each step runs inside
// `bootInits` so a failure in one module never aborts the rest of the boot.
function bootInits(steps) {
  for (const step of steps) {
    try {
      step();
    } catch (err) {
      console.error("[OpenBGR] Startup init step failed:", err);
    }
  }
}

bootInits([
  () => initSegmentation({ setViewMode, syncMenuBarState }),
  () => initBatchPanel({ renderTabBar, hideTabGhost, closeTabImmediate }),
  () => initBatchRun({ syncMenuBarState }),
  () => initBatch({ renderTabBar, closeTabImmediate, switchToTab, ingestImageFile }),
  initConnectivity,
  initModals,
  initSettings,
  initTierDropdown,
  initControls,
  initAnimation,
  initBackdrop,
  initStageInput,
  initOpenFiles,
  initRecent,
  initExternalLinks,
  installBridge,
  initKeyboard,
  initClipboard,
  initMenuBar,
  initTooltips,
  () => applyPreferences(syncMenuBarState),
  syncFormatButtons,
  () => applyBackdrop(state.activeBackdrop),
  () => syncServerStatus(true, selectTier),
  startPendingFilesPoll,
]);

/**
 * Settings modal wiring: nav panes, theme/accent/default picks, Quick Action
 * prefs, offline mode, model import/uninstall, and Reset to Defaults.
 * Importing this module has no side effects; app.js calls `initSettings()`.
 */

import { state, dom, prefs, setPref, resetPrefs } from "./state.js";
import { applyBackdrop, updateExportTelemetry } from "./export-ui.js";
import {
  selectPrefsPane,
  openPrefsDialog,
  closePrefsDialog,
  applyPreferences,
  uninstallModel,
  openCacheFolder,
  openLogsFolder,
  showModelContextMenu,
  syncQuickActionConfigToServer,
  toggleQuickActionInstall,
  toggleOfflineMode,
  chooseImportFolder,
  importModelFromFolder,
} from "./preferences.js";
import { selectTier, syncMenuBarState } from "./tabs.js";

/** Picks the app theme and re-applies it to the document and menu bar. */
export function setThemePref(theme) {
  setPref("theme", theme);
  applyPreferences(syncMenuBarState);
}

/** Picks the accent swatch and re-applies preferences. */
export function setAccentPref(accent) {
  setPref("accent", accent || "default");
  applyPreferences(syncMenuBarState);
}

/** Picks the default model; with no image loaded it also selects that tier now. */
export function pickDefaultTier(value) {
  setPref("defaultTier", value);
  if (!state.sourceFile) {
    const targetTier =
      prefs.defaultTier !== "auto"
        ? prefs.defaultTier
        : state.serverStatus?.recommended_tier || "general";
    selectTier(targetTier);
  }
}

/** Picks the default export format and applies it to an unprocessed image. */
export function pickDefaultFormat(value) {
  setPref("defaultFormat", value);
  if (!state.resultBlob) {
    state.exportFormat = prefs.defaultFormat;
    updateExportTelemetry();
  }
}

/** Picks the default backdrop and applies it to an unprocessed image. */
export function pickDefaultBackdrop(value) {
  setPref("defaultBackdrop", value);
  if (!state.resultBlob) {
    applyBackdrop(prefs.defaultBackdrop);
  }
}

/** Stores a Quick Action pref and pushes the config to the server. */
export function setQaPref(key, value) {
  setPref(key, value);
  syncQuickActionConfigToServer();
}

/** Toggles a Quick Action boolean pref and mirrors it on the button. */
export function toggleQaFlag(btn, key) {
  setPref(key, !prefs[key]);
  btn.classList.toggle("active", prefs[key]);
  syncQuickActionConfigToServer();
}

/** Toggles the close-tab confirmation and mirrors it on the button. */
export function toggleConfirmClose() {
  state.confirmCloseTab = !state.confirmCloseTab;
  setPref("confirmClose", state.confirmCloseTab);
  dom.btnToggleConfirmClose.classList.toggle("active", state.confirmCloseTab);
}

/** Restores factory prefs and re-applies them to prefs, UI, and idle workspace. */
export function resetAllPrefs() {
  resetPrefs();
  state.confirmCloseTab = prefs.confirmClose;
  applyPreferences(syncMenuBarState);
  syncQuickActionConfigToServer();
  if (!state.resultBlob) {
    state.exportFormat = prefs.defaultFormat;
    applyBackdrop(prefs.defaultBackdrop);
    selectTier(state.serverStatus?.recommended_tier || "general");
    updateExportTelemetry();
  }
}

/** Wires every Settings modal control. */
export function initSettings() {
  dom.btnInfo.addEventListener("click", () => openPrefsDialog());
  dom.btnInfoClose.addEventListener("click", () => closePrefsDialog());
  dom.btnPrefsCloseX?.addEventListener("click", () => closePrefsDialog());
  dom.infoModal.addEventListener("click", (e) => {
    if (e.target === dom.infoModal) closePrefsDialog();
  });
  dom.infoModal.querySelectorAll(".prefs-nav-item").forEach((item) => {
    item.addEventListener("click", () =>
      selectPrefsPane(item.getAttribute("data-pane"))
    );
  });

  dom.infoModal.querySelectorAll("[data-uninstall-model]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.getAttribute("data-uninstall-model");
      if (key) uninstallModel(key);
    });
  });

  document
    .getElementById("btnUninstallAllModels")
    ?.addEventListener("click", () => uninstallModel("all"));

  dom.btnOpenCacheDir?.addEventListener("click", () => openCacheFolder());
  dom.btnOpenLogsDir?.addEventListener("click", () => openLogsFolder());

  dom.infoModal.querySelectorAll(".model-row[data-model-key]").forEach((row) => {
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const key = row.getAttribute("data-model-key");
      if (key) showModelContextMenu(key, e.clientX, e.clientY);
    });
  });

  if (dom.btnToggleConfirmClose) {
    dom.btnToggleConfirmClose.classList.toggle("active", state.confirmCloseTab);
    dom.btnToggleConfirmClose.addEventListener("click", toggleConfirmClose);
  }

  dom.prefThemeDark?.addEventListener("click", () => setThemePref("dark"));
  dom.prefThemeLight?.addEventListener("click", () => setThemePref("light"));
  dom.accentSwatches?.querySelectorAll(".swatch").forEach((sw) => {
    sw.addEventListener("click", () =>
      setAccentPref(sw.getAttribute("data-accent"))
    );
  });

  dom.prefDefaultTier?.addEventListener("change", (e) =>
    pickDefaultTier(e.target.value)
  );
  dom.prefDefaultFormat?.addEventListener("change", (e) =>
    pickDefaultFormat(e.target.value)
  );
  dom.prefDefaultBackdrop?.addEventListener("change", (e) =>
    pickDefaultBackdrop(e.target.value)
  );

  dom.prefQaTier?.addEventListener("change", (e) =>
    setQaPref("qaTier", e.target.value)
  );
  dom.prefQaSaveMode?.addEventListener("change", (e) =>
    setQaPref("qaSaveMode", e.target.value)
  );
  dom.prefQaFormat?.addEventListener("change", (e) =>
    setQaPref("qaFormat", e.target.value)
  );
  dom.btnToggleQaEdgeRefine?.addEventListener("click", () =>
    toggleQaFlag(dom.btnToggleQaEdgeRefine, "qaEdgeRefine")
  );
  dom.btnToggleQaClipboard?.addEventListener("click", () =>
    toggleQaFlag(dom.btnToggleQaClipboard, "qaCopyClipboard")
  );
  dom.btnToggleQaNotify?.addEventListener("click", () =>
    toggleQaFlag(dom.btnToggleQaNotify, "qaNotify")
  );
  dom.btnQaInstallToggle?.addEventListener("click", () => {
    toggleQuickActionInstall();
  });
  dom.btnToggleOfflineMode?.addEventListener("click", () => {
    toggleOfflineMode();
  });
  dom.btnChooseImportFolder?.addEventListener("click", () => {
    chooseImportFolder();
  });
  dom.btnImportModel?.addEventListener("click", () => {
    importModelFromFolder();
  });
  dom.btnResetPrefs?.addEventListener("click", resetAllPrefs);
}

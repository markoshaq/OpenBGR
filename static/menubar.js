/**
 * In-app menu bar: dropdown open/close behavior, the `data-cmd` dispatch
 * table, non-Apple shortcut labels, and hiding the bar when the desktop
 * window has native OS menus. Commands defer to `window.openBGR`, so the
 * in-app and native menus share one implementation.
 * Importing this module has no side effects; app.js calls `initMenuBar()`.
 */

import { dom } from "./state.js";
import { syncMenuBarState } from "./tabs.js";
import { emit } from "./bus.js";
import {
  isApplePlatform,
  menuShortcutLabel,
  chipShortcutLabel,
} from "./shortcuts.js";

/** Menu item `data-cmd` values mapped to their `window.openBGR` commands. */
export const MENU_COMMANDS = {
  newTab: () => window.openBGR.newTab(),
  openImage: () => window.openBGR.openImage(),
  openRecent: () => window.openBGR.openRecent(),
  reopenClosedTab: () => window.openBGR.reopenClosedTab(),
  batchProcess: () => window.openBGR.startBatch(),
  exportImage: () => window.openBGR.exportImage(),
  closeActiveTab: () => window.openBGR.closeActiveTab(),
  preferences: () => window.openBGR.openSettings("preferences"),
  about: () => window.openBGR.openSettings("about"),
  quitApp: () => window.openBGR.quitApp(),
  copyImage: () => window.openBGR.copyImage(),
  copyOriginal: () => window.openBGR.copyOriginalImage(),
  pasteImage: () => window.openBGR.pasteImage(),
  cancelProcessing: () => window.openBGR.cancelProcessing(),
  restartApp: () => window.openBGR.restartApp(),
  viewSplit: () => window.openBGR.setView("split"),
  viewCutout: () => window.openBGR.setView("cutout"),
  viewOriginal: () => window.openBGR.setView("original"),
  zoomIn: () => window.openBGR.zoomIn(),
  zoomOut: () => window.openBGR.zoomOut(),
  zoomReset: () => window.openBGR.zoomReset(),
  toggleLoupe: () => window.openBGR.toggleLoupe(),
  toggleTheme: () => window.openBGR.toggleTheme(),
  toggleFullscreen: () => window.openBGR.toggleFullscreen(),
  presetLite: () => window.openBGR.selectPreset("lite"),
  presetGeneral: () => window.openBGR.selectPreset("general"),
  presetHr: () => window.openBGR.selectPreset("hr"),
  presetPortrait: () => window.openBGR.selectPreset("portrait"),
  presetMatting: () => window.openBGR.selectPreset("matting"),
  presetDynamic: () => window.openBGR.selectPreset("dynamic"),
  toggleDefringe: () => window.openBGR.toggleDefringe(),
  toggleDespill: () => window.openBGR.toggleDespill(),
  rerun: () => window.openBGR.rerunSegmentation(),
  manageModels: () => window.openBGR.openSettings("models"),
  shortcuts: () => window.openBGR.openSettings("shortcuts"),
  openGithub: () => window.openBGR.openGithub(),
};

/** Closes every open in-app menu dropdown. */
export function closeAllMenus() {
  dom.menuBar?.querySelectorAll(".menu-root.open").forEach((m) => {
    m.classList.remove("open");
  });
}

/** True while any in-app menu dropdown is open. */
export function isAnyMenuOpen() {
  return Boolean(dom.menuBar?.querySelector(".menu-root.open"));
}

/** Hides the in-app menu bar when the desktop window has a native OS menu bar attached. */
export async function syncNativeMenusMode() {
  if (!window.pywebview?.api?.native_menus_enabled) return;
  try {
    const res = await window.pywebview.api.native_menus_enabled();
    document.documentElement.classList.toggle("native-menus", Boolean(res?.enabled));
  } catch (_) {}
}

/** Rewrites the macOS-style shortcut hints as Ctrl+ labels on other platforms. */
export function localizeShortcutLabels() {
  if (isApplePlatform()) return;
  dom.menuBar?.querySelectorAll(".menu-kbd[data-shortcut]").forEach((el) => {
    el.textContent = menuShortcutLabel(el.getAttribute("data-shortcut") || "");
  });
  document.querySelectorAll("[data-shortcut-chip]").forEach((el) => {
    el.textContent = chipShortcutLabel(
      el.getAttribute("data-shortcut-chip") || "",
    );
  });
}

/** Trigger click: toggles this menu, refreshing item state before it opens. */
export function handleMenuTriggerClick(root) {
  const wasOpen = root.classList.contains("open");
  closeAllMenus();
  if (!wasOpen) {
    syncMenuBarState();
    emit("clipboard:probe");
    root.classList.add("open");
  }
}

/** Trigger hover: while another menu is open, moves the open state to this one. */
export function handleMenuTriggerHover(root) {
  const anyOpen = dom.menuBar.querySelector(".menu-root.open");
  if (anyOpen && anyOpen !== root) {
    closeAllMenus();
    syncMenuBarState();
    root.classList.add("open");
  }
}

/** Item click: runs the item's `data-cmd` unless it is disabled. */
export function handleMenuItemClick(item) {
  if (item.classList.contains("disabled")) return;
  const cmd = item.getAttribute("data-cmd");
  closeAllMenus();
  MENU_COMMANDS[cmd]?.();
}

/** Wires the native-menus probe, shortcut labels, triggers, items, and outside-click close. */
export function initMenuBar() {
  syncNativeMenusMode();
  window.addEventListener("pywebviewready", syncNativeMenusMode);

  if (!dom.menuBar) return;
  localizeShortcutLabels();

  dom.menuBar.querySelectorAll(".menu-root").forEach((root) => {
    const trigger = root.querySelector(".menu-trigger");
    trigger?.addEventListener("click", (e) => {
      e.stopPropagation();
      handleMenuTriggerClick(root);
    });
    trigger?.addEventListener("mouseenter", () => handleMenuTriggerHover(root));
  });

  dom.menuBar.querySelectorAll(".menu-item").forEach((item) => {
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      handleMenuItemClick(item);
    });
  });

  window.addEventListener("click", closeAllMenus);
}

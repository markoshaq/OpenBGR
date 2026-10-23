/**
 * In-app menu bar: declarative `MENUS` definition, DOM rendering, dropdown
 * open/close behavior, the `data-cmd` dispatch table, non-Apple shortcut
 * labels, and hiding the bar when the desktop window has native OS menus.
 * Commands defer to `window.openBGR`, so the in-app and native menus share
 * one implementation.
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

/** Declarative specification of the top-level menus and their items (`null` = separator). */
export const MENUS = [
  {
    id: "file",
    label: "FILE",
    items: [
      { cmd: "newTab", label: "New Tab", shortcut: "Mod+T", kbd: "⌘T", requires: "tab" },
      { cmd: "openImage", label: "Open Image…", shortcut: "Mod+O", kbd: "⌘O" },
      { cmd: "openRecent", label: "Open Recent…", requires: "native" },
      {
        cmd: "batchProcess",
        label: "Batch Process Images…",
        shortcut: "Mod+B",
        kbd: "⌘B",
      },
      null,
      {
        cmd: "exportImage",
        label: "Export Image…",
        shortcut: "Mod+E",
        kbd: "⌘E",
        requires: "result",
      },
      null,
      {
        cmd: "closeActiveTab",
        label: "Close Tab",
        shortcut: "Mod+W",
        kbd: "⌘W",
        requires: "tab",
      },
      {
        cmd: "reopenClosedTab",
        label: "Reopen Closed Tab",
        shortcut: "Shift+Mod+T",
        kbd: "⇧⌘T",
        requires: "closed-tab",
      },
      null,
      { cmd: "preferences", label: "Preferences…", shortcut: "Mod+,", kbd: "⌘," },
      null,
      { cmd: "restartApp", label: "Restart OpenBGR", requires: "native" },
      null,
      { cmd: "quitApp", label: "Quit OpenBGR", shortcut: "Mod+Q", kbd: "⌘Q" },
    ],
  },
  {
    id: "edit",
    label: "EDIT",
    items: [
      {
        cmd: "copyImage",
        label: "Copy Cutout to Clipboard",
        shortcut: "Shift+Mod+C",
        kbd: "⇧⌘C",
        requires: "result",
      },
      { cmd: "copyOriginal", label: "Copy Original Image", requires: "image" },
      {
        cmd: "pasteImage",
        label: "Paste Image from Clipboard",
        shortcut: "Mod+V",
        kbd: "⌘V",
        requires: "paste-image",
      },
      null,
      {
        cmd: "cancelProcessing",
        label: "Cancel Processing",
        kbd: "ESC",
        requires: "processing",
      },
    ],
  },
  {
    id: "view",
    label: "VIEW",
    items: [
      {
        cmd: "viewSplit",
        label: "Split Comparison",
        shortcut: "1",
        kbd: "1",
        check: "view:split",
        checked: true,
        requires: "result",
      },
      {
        cmd: "viewCutout",
        label: "Cutout Only",
        shortcut: "2",
        kbd: "2",
        check: "view:cutout",
        requires: "result",
      },
      {
        cmd: "viewOriginal",
        label: "Original Only",
        shortcut: "3",
        kbd: "3",
        check: "view:original",
        requires: "result",
      },
      null,
      { cmd: "zoomIn", label: "Zoom In", shortcut: "Mod++", kbd: "⌘+", requires: "image" },
      { cmd: "zoomOut", label: "Zoom Out", shortcut: "Mod+-", kbd: "⌘−", requires: "image" },
      {
        cmd: "zoomReset",
        label: "Actual Size",
        shortcut: "Mod+0",
        kbd: "⌘0",
        requires: "image",
      },
      null,
      {
        cmd: "toggleLoupe",
        label: "Toggle 4x Loupe",
        kbd: "Z",
        check: "loupe",
        requires: "image",
      },
      null,
      { cmd: "toggleTheme", label: "Light Mode", check: "theme:light" },
      {
        cmd: "toggleFullscreen",
        label: "Toggle Full Screen",
        shortcut: "Fullscreen",
        kbd: "⌃⌘F",
      },
    ],
  },
  {
    id: "model",
    label: "MODEL",
    items: [
      {
        cmd: "presetLite",
        label: "Lite - 1K Fast (BiRefNet_lite)",
        requires: "model-controls",
        check: "tier:lite",
      },
      {
        cmd: "presetGeneral",
        label: "General - 1K Studio (BiRefNet)",
        requires: "model-controls",
        check: "tier:general",
        checked: true,
      },
      {
        cmd: "presetHr",
        label: "Ultra HR - 2K Detail (BiRefNet_HR)",
        requires: "model-controls",
        check: "tier:hr",
      },
      {
        cmd: "presetPortrait",
        label: "Portrait - 1K People (BiRefNet-portrait)",
        requires: "model-controls",
        check: "tier:portrait",
      },
      {
        cmd: "presetMatting",
        label: "Matting - 2K Soft Alpha (BiRefNet_HR-matting)",
        requires: "model-controls",
        check: "tier:matting",
      },
      {
        cmd: "presetDynamic",
        label: "Dynamic - Native Ratio (BiRefNet_dynamic)",
        requires: "model-controls",
        check: "tier:dynamic",
      },
      null,
      {
        cmd: "toggleDefringe",
        label: "Defringe Edges",
        requires: "model-controls",
        check: "defringe",
        checked: true,
      },
      {
        cmd: "toggleDespill",
        label: "Suppress Color Spill",
        requires: "model-controls",
        check: "despill",
        checked: true,
      },
      null,
      {
        cmd: "rerun",
        label: "Re-Run Segmentation",
        shortcut: "Mod+R",
        kbd: "⌘R",
        requires: "image-idle",
      },
      null,
      { cmd: "manageModels", label: "Manage Model Storage…" },
    ],
  },
  {
    id: "help",
    label: "HELP",
    items: [
      { cmd: "shortcuts", label: "Keyboard Shortcuts…" },
      {
        cmd: "preferences",
        label: "Preferences & System Info…",
        shortcut: "Mod+,",
        kbd: "⌘,",
      },
      { cmd: "about", label: "About OpenBGR…" },
      null,
      { cmd: "openGithub", label: "OpenBGR on GitHub ↗" },
    ],
  },
];

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

/** Builds the menu bar DOM inside `container` from the declarative `MENUS` table. */
export function renderMenuBar(container = dom.menuBar) {
  if (!container) return;
  container.innerHTML = "";
  for (const menu of MENUS) {
    const root = document.createElement("div");
    root.className = "menu-root";
    root.setAttribute("data-menu", menu.id);

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "menu-trigger";
    trigger.textContent = menu.label;
    root.appendChild(trigger);

    const dropdown = document.createElement("div");
    dropdown.className = "menu-dropdown";

    for (const spec of menu.items) {
      if (!spec) {
        const sep = document.createElement("div");
        sep.className = "menu-sep";
        dropdown.appendChild(sep);
        continue;
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "menu-item";
      btn.setAttribute("data-cmd", spec.cmd);
      if (spec.requires) btn.setAttribute("data-requires", spec.requires);
      if (spec.check) btn.setAttribute("data-check", spec.check);

      const checkSpan = document.createElement("span");
      checkSpan.className = "menu-check";
      if (spec.checked) checkSpan.textContent = "✓";

      const labelSpan = document.createElement("span");
      labelSpan.className = "menu-label";
      labelSpan.textContent = spec.label;

      const kbdSpan = document.createElement("span");
      kbdSpan.className = "menu-kbd";
      if (spec.shortcut) kbdSpan.setAttribute("data-shortcut", spec.shortcut);
      if (spec.kbd) kbdSpan.textContent = spec.kbd;

      btn.appendChild(checkSpan);
      btn.appendChild(labelSpan);
      btn.appendChild(kbdSpan);
      dropdown.appendChild(btn);
    }

    root.appendChild(dropdown);
    container.appendChild(root);
  }
}

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

/** Wires the native-menus probe, menu DOM rendering, shortcut labels, triggers, items, and outside-click close. */
export function initMenuBar() {
  syncNativeMenusMode();
  window.addEventListener("pywebviewready", syncNativeMenusMode);

  if (!dom.menuBar) return;
  if (!dom.menuBar.querySelector(".menu-root")) {
    renderMenuBar(dom.menuBar);
  }
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

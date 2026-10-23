/**
 * Node unit tests for static/menubar.js: dropdown open/close, the data-cmd
 * dispatch table, native-menus mode, and non-Apple shortcut labels.
 *
 * Run with: node --test tests/
 */

import assert from "node:assert/strict";
import test from "node:test";
import { installDomShims, FakeElement } from "./dom-shim.mjs";

installDomShims();

const { state, dom } = await import("../static/state.js");
const { on } = await import("../static/bus.js");
const { refreshClipboardState } = await import("../static/clipboard.js");
on("clipboard:probe", refreshClipboardState);
const {
  MENUS,
  MENU_COMMANDS,
  renderMenuBar,
  closeAllMenus,
  isAnyMenuOpen,
  syncNativeMenusMode,
  localizeShortcutLabels,
  handleMenuTriggerClick,
  handleMenuTriggerHover,
  handleMenuItemClick,
} = await import("../static/menubar.js");

function menuRoot() {
  const root = new FakeElement("div");
  root.classList.add("menu-root");
  dom.menuBar.appendChild(root);
  return root;
}

function menuItem(cmd, { disabled = false, requires } = {}) {
  const item = new FakeElement("button");
  item.classList.add("menu-item");
  item.setAttribute("data-cmd", cmd);
  if (requires) item.setAttribute("data-requires", requires);
  if (disabled) item.classList.add("disabled");
  dom.menuBar.appendChild(item);
  return item;
}

const file = menuRoot();
const edit = menuRoot();

function reset() {
  file.classList.remove("open");
  edit.classList.remove("open");
  delete window.pywebview;
  window.openBGR = {};
}

test("MENUS table and MENU_COMMANDS stay in 1-to-1 sync and render cleanly", () => {
  const container = new FakeElement("nav");
  renderMenuBar(container);
  const renderedRoots = container.querySelectorAll(".menu-root");
  assert.equal(renderedRoots.length, MENUS.length);

  const cmds = new Set(
    container.querySelectorAll(".menu-item").map((el) => el.getAttribute("data-cmd"))
  );
  assert.ok(cmds.size > 0);
  for (const cmd of cmds) {
    assert.equal(typeof MENU_COMMANDS[cmd], "function", `missing command: ${cmd}`);
  }
  for (const key of Object.keys(MENU_COMMANDS)) {
    assert.ok(cmds.has(key), `unused MENU_COMMANDS entry: ${key}`);
  }
});

test("trigger click toggles its menu and refreshes item state on open", async () => {
  reset();
  state.clipboardHasImage = undefined;
  const paste = menuItem("pasteImage", { requires: "paste-image" });
  window.pywebview = { api: { has_clipboard_image: async () => ({ has_image: false }) } };

  handleMenuTriggerClick(file);
  assert.ok(file.classList.contains("open"));
  assert.equal(isAnyMenuOpen(), true);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(state.clipboardHasImage, false, "clipboard probed on open");
  assert.ok(paste.classList.contains("disabled"));

  handleMenuTriggerClick(file);
  assert.equal(isAnyMenuOpen(), false);
  paste.remove();
});

test("opening one menu closes the other", () => {
  reset();
  handleMenuTriggerClick(file);
  handleMenuTriggerClick(edit);
  assert.ok(!file.classList.contains("open"));
  assert.ok(edit.classList.contains("open"));
  closeAllMenus();
  assert.equal(isAnyMenuOpen(), false);
});

test("hover switches menus only while one is already open", () => {
  reset();
  handleMenuTriggerHover(edit);
  assert.equal(isAnyMenuOpen(), false, "hover alone never opens");

  file.classList.add("open");
  handleMenuTriggerHover(edit);
  assert.ok(!file.classList.contains("open"));
  assert.ok(edit.classList.contains("open"));
});

test("item click closes menus and dispatches through window.openBGR", () => {
  reset();
  const calls = [];
  window.openBGR = {
    setView: (m) => calls.push(`setView:${m}`),
    selectPreset: (k) => calls.push(`selectPreset:${k}`),
    openSettings: (s) => calls.push(`openSettings:${s}`),
  };
  file.classList.add("open");
  handleMenuItemClick(menuItem("viewCutout"));
  assert.equal(isAnyMenuOpen(), false);
  handleMenuItemClick(menuItem("presetHr"));
  handleMenuItemClick(menuItem("manageModels"));
  handleMenuItemClick(menuItem("noSuchCommand"));
  assert.deepEqual(calls, [
    "setView:cutout",
    "selectPreset:hr",
    "openSettings:models",
  ]);
});

test("disabled items do nothing and leave the menu open", () => {
  reset();
  let ran = false;
  window.openBGR = { newTab: () => (ran = true) };
  file.classList.add("open");
  handleMenuItemClick(menuItem("newTab", { disabled: true }));
  assert.equal(ran, false);
  assert.ok(file.classList.contains("open"));
});

test("syncNativeMenusMode toggles the native-menus root class", async () => {
  reset();
  await syncNativeMenusMode();
  assert.ok(!document.documentElement.classList.contains("native-menus"));

  window.pywebview = { api: { native_menus_enabled: async () => ({ enabled: true }) } };
  await syncNativeMenusMode();
  assert.ok(document.documentElement.classList.contains("native-menus"));

  window.pywebview.api.native_menus_enabled = async () => ({ enabled: false });
  await syncNativeMenusMode();
  assert.ok(!document.documentElement.classList.contains("native-menus"));
});

test("localizeShortcutLabels rewrites hints off Apple platforms only", () => {
  const kbd = new FakeElement("span");
  kbd.classList.add("menu-kbd");
  kbd.setAttribute("data-shortcut", "Shift+Mod+T");
  kbd.textContent = "⇧⌘T";
  dom.menuBar.appendChild(kbd);
  const chip = new FakeElement("span");
  chip.setAttribute("data-shortcut-chip", "Mod+O");
  chip.textContent = "⌘O";
  document.body.appendChild(chip);

  const nav = globalThis.navigator;
  const setNav = (value) =>
    Object.defineProperty(globalThis, "navigator", { value, configurable: true });
  try {
    setNav({ platform: "MacIntel", userAgent: "node-test" });
    localizeShortcutLabels();
    assert.equal(kbd.textContent, "⇧⌘T");
    assert.equal(chip.textContent, "⌘O");

    setNav({ platform: "Win32", userAgent: "node-test" });
    localizeShortcutLabels();
    assert.equal(kbd.textContent, "Ctrl+Shift+T");
    assert.equal(chip.textContent, "CTRL+O");
  } finally {
    setNav(nav);
  }
});

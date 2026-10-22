/**
 * Node unit tests for static/bridge.js: the `window.openBGR` command table
 * and the preconditions each command checks before acting.
 *
 * Run with: node --test tests/
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { installDomShims } from "./dom-shim.mjs";
import { wireRealTabOps } from "./workspace-deps.mjs";

installDomShims();
await wireRealTabOps();
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });

const { state, dom, prefs, createTabRecord } = await import(
  "../static/state.js"
);
const { commands, installBridge } = await import("../static/bridge.js");
const { MENU_COMMANDS } = await import("../static/menubar.js");
const { MOD_SHORTCUTS } = await import("../static/shortcuts.js");

function reset() {
  state.tabs = [];
  state.activeTabId = null;
  state.sourceFile = null;
  state.resultBlob = null;
  state.isProcessing = false;
  state.abortController = null;
  state.closedTabs = [];
  state.tier = "general";
  state.zoom = 1;
  state.viewMode = "original";
  state.loupeEnabled = false;
  state.pendingConfirmFn = null;
  dom.confirmModal.classList.remove("active");
  dom.infoModal.classList.remove("active");
  delete window.pywebview;
}

function addTabs(n) {
  const tabs = Array.from({ length: n }, (_, i) =>
    createTabRecord({ name: `T${i + 1}` })
  );
  state.tabs.push(...tabs);
  state.activeTabId = tabs[0].id;
  return tabs;
}

test("installBridge publishes the command table on window.openBGR", () => {
  assert.equal(installBridge(), commands);
  assert.equal(window.openBGR, commands);
});

test("every command the menus, shortcuts, and backend call exists", () => {
  installBridge();
  const called = new Set();
  const spy = new Proxy(
    {},
    {
      get: (_t, name) => () => called.add(name),
    }
  );
  window.openBGR = spy;
  Object.values(MENU_COMMANDS).forEach((run) => run());
  MOD_SHORTCUTS.forEach((s) => s.run({ key: "1", shiftKey: false }));
  installBridge();

  const py = ["desktop_bridge.py", "desktop_menus.py", "desktop_cocoa.py"]
    .map((f) => readFileSync(new URL(`../openbgr/${f}`, import.meta.url), "utf8"))
    .join("\n");
  for (const m of py.matchAll(/openBGR\.(\w+)/g)) called.add(m[1]);
  // Native menu actions are declared as call("name(...)") in desktop_menus.py.
  for (const m of py.matchAll(/\bcall\(\s*["'](\w+)\(/g)) called.add(m[1]);
  assert.ok(called.has("openSettings"), "native menu commands were scanned");

  for (const name of called) {
    assert.equal(typeof commands[name], "function", `missing command: ${name}`);
  }
});

test("switchToTabAt picks by 1-based index, with 9 meaning the last tab", () => {
  reset();
  const tabs = addTabs(4);
  commands.switchToTabAt(3);
  assert.equal(state.activeTabId, tabs[2].id);
  commands.switchToTabAt(9);
  assert.equal(state.activeTabId, tabs[3].id);
  commands.switchToTabAt(7);
  assert.equal(state.activeTabId, tabs[3].id, "out of range is a no-op");
});

test("switchTabOffset wraps around and needs two tabs", () => {
  reset();
  const [only] = addTabs(1);
  commands.switchTabOffset(1);
  assert.equal(state.activeTabId, only.id);

  reset();
  const tabs = addTabs(3);
  commands.switchTabOffset(-1);
  assert.equal(state.activeTabId, tabs[2].id);
  commands.switchTabOffset(1);
  assert.equal(state.activeTabId, tabs[0].id);
});

test("newTab needs an active tab and confirms while processing", () => {
  reset();
  commands.newTab();
  assert.equal(state.tabs.length, 0, "the first tab comes from opening an image");

  addTabs(1);
  commands.newTab();
  assert.equal(state.tabs.length, 2);

  state.isProcessing = true;
  commands.newTab();
  assert.equal(state.tabs.length, 2);
  assert.ok(dom.confirmModal.classList.contains("active"));
  state.pendingConfirmFn();
  assert.equal(state.isProcessing, false);
  assert.equal(state.tabs.length, 3);
});

test("setView requires a result and a known mode", () => {
  reset();
  commands.setView("split");
  assert.equal(state.viewMode, "original");
  state.resultBlob = new Blob(["x"]);
  commands.setView("bogus");
  assert.equal(state.viewMode, "original");
  commands.setView("cutout");
  assert.equal(state.viewMode, "cutout");
});

test("zoom and loupe commands require a loaded image", () => {
  reset();
  commands.zoomIn();
  commands.toggleLoupe();
  assert.equal(state.zoom, 1);
  assert.equal(state.loupeEnabled, false);

  state.sourceFile = new File(["x"], "a.png", { type: "image/png" });
  commands.zoomIn();
  assert.equal(state.zoom, 1.25);
  commands.zoomOut();
  assert.equal(state.zoom, 1);
  commands.toggleLoupe();
  assert.equal(state.loupeEnabled, true);
});

test("selectPreset normalizes aliases and ignores unknown keys", () => {
  reset();
  commands.selectPreset("lite");
  assert.equal(state.tier, "lite");
  commands.selectPreset("no-such-model");
  assert.equal(state.tier, "lite");
});

test("toggleTheme flips the theme pref", () => {
  reset();
  const before = prefs.theme;
  commands.toggleTheme();
  assert.notEqual(prefs.theme, before);
  commands.toggleTheme();
  assert.equal(prefs.theme, before);
});

test("native-only commands go through the bridge when present", () => {
  reset();
  const calls = [];
  window.pywebview = {
    api: {
      quit: () => calls.push("quit"),
      restart_app: () => calls.push("restart"),
      toggle_fullscreen: () => calls.push("fullscreen"),
      open_external: (url) => calls.push(`open:${url}`),
    },
  };
  commands.quitApp();
  commands.restartApp();
  commands.toggleFullscreen();
  commands.openGithub();
  assert.deepEqual(calls, [
    "quit",
    "restart",
    "fullscreen",
    "open:https://github.com/markoshaq/OpenBGR",
  ]);
});

test("openSettings opens the preferences modal", () => {
  reset();
  commands.openSettings("models");
  assert.ok(dom.infoModal.classList.contains("active"));
});

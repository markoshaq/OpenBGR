/**
 * Node unit tests for static/keyboard.js: the Escape dismiss cascade, F11,
 * the text-field gate, Cmd/Ctrl shortcut dispatch, and bare-key stage
 * controls.
 *
 * Run with: node --test tests/
 */

import assert from "node:assert/strict";
import test from "node:test";
import { installDomShims, FakeElement } from "./dom-shim.mjs";
import { wireRealTabOps } from "./workspace-deps.mjs";

installDomShims();
await wireRealTabOps();
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });

const { state, dom } = await import("../static/state.js");
await import("../static/batch.js"); // subscribes "context-menu:hide" on the bus
const { handleEscape, handleKeydown, handleKeyup } = await import(
  "../static/keyboard.js"
);

const menu = new FakeElement("div");
menu.classList.add("menu-root");
dom.menuBar.appendChild(menu);

let calls = [];

function reset() {
  calls = [];
  window.openBGR = {
    toggleFullscreen: () => calls.push("toggleFullscreen"),
    setView: (m) => calls.push(`setView:${m}`),
    newTab: () => calls.push("newTab"),
    switchToTabAt: (n) => calls.push(`switchToTabAt:${n}`),
  };
  menu.classList.remove("open");
  dom.tierDropdown.classList.remove("open");
  dom.infoModal.classList.remove("active");
  dom.recentModal.classList.remove("active");
  dom.confirmModal.classList.remove("active");
  dom.tabContextMenu.style.display = "block";
  state.isProcessing = false;
  state.loupeEnabled = false;
  state.sourceFile = null;
  state.resultBlob = null;
  state.spacePressed = false;
}

const key = (k, extra = {}) => {
  const ev = {
    key: k,
    code: "",
    target: new FakeElement("div"),
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    ...extra,
  };
  ev.preventDefault = () => {
    ev.defaultPrevented = true;
  };
  return ev;
};

test("Escape dismisses one layer per press, topmost first", () => {
  reset();
  menu.classList.add("open");
  dom.tierDropdown.classList.add("open");
  dom.infoModal.classList.add("active");
  dom.recentModal.classList.add("active");
  dom.confirmModal.classList.add("active");
  state.isProcessing = true;
  state.loupeEnabled = true;

  const order = [];
  for (let i = 0; i < 8; i++) order.push(handleEscape());
  assert.deepEqual(order, [
    "menu",
    "tierDropdown",
    "prefs",
    "recent",
    "confirm",
    "processing",
    "loupe",
    null,
  ]);
  assert.equal(state.isProcessing, false);
  assert.equal(state.loupeEnabled, false);
  assert.equal(dom.tierDropdownBtn.getAttribute("aria-expanded"), "false");
});

test("Escape always hides the tab context menu", () => {
  reset();
  handleKeydown(key("Escape"));
  assert.equal(dom.tabContextMenu.style.display, "none");
});

test("F11 toggles fullscreen even from a text field", () => {
  reset();
  const ev = key("F11", { target: new FakeElement("input") });
  handleKeydown(ev);
  assert.ok(ev.defaultPrevented);
  assert.deepEqual(calls, ["toggleFullscreen"]);
});

test("text fields swallow app shortcuts", () => {
  reset();
  state.sourceFile = {};
  state.resultBlob = {};
  const input = new FakeElement("input");
  handleKeydown(key("t", { metaKey: true, target: input }));
  handleKeydown(key("2", { target: input }));
  handleKeydown(key("z", { target: input }));
  assert.deepEqual(calls, []);
  assert.equal(state.loupeEnabled, false);
});

test("Cmd/Ctrl shortcuts dispatch and prevent the default only on a match", () => {
  reset();
  const hit = key("t", { metaKey: true });
  handleKeydown(hit);
  assert.ok(hit.defaultPrevented);
  assert.deepEqual(calls, ["newTab"]);

  const miss = key("k", { ctrlKey: true });
  handleKeydown(miss);
  assert.ok(!miss.defaultPrevented);

  state.resultBlob = {};
  handleKeydown(key("2", { metaKey: true }));
  assert.deepEqual(
    calls,
    ["newTab", "switchToTabAt:2"],
    "Cmd+digit switches tabs instead of view modes"
  );
});

test("Space holds the pan modifier until keyup", () => {
  reset();
  handleKeydown(key(" ", { code: "Space" }));
  assert.equal(state.spacePressed, true);
  handleKeyup({ code: "Space" });
  assert.equal(state.spacePressed, false);
});

test("Z toggles the loupe only with an image loaded", () => {
  reset();
  handleKeydown(key("z"));
  assert.equal(state.loupeEnabled, false);
  state.sourceFile = {};
  handleKeydown(key("Z"));
  assert.equal(state.loupeEnabled, true);
});

test("1/2/3 switch view modes only with a result and no Alt", () => {
  reset();
  handleKeydown(key("1"));
  assert.deepEqual(calls, []);
  state.resultBlob = {};
  handleKeydown(key("1"));
  handleKeydown(key("2"));
  handleKeydown(key("3"));
  handleKeydown(key("3", { altKey: true }));
  handleKeydown(key("4"));
  assert.deepEqual(calls, ["setView:split", "setView:cutout", "setView:original"]);
});

/**
 * Node unit tests for static/bus.js: synchronous emit/on/off, and the
 * "context-menu:hide" / "clipboard:probe" wiring between modules.
 *
 * Run with: node --test tests/
 */

import assert from "node:assert/strict";
import test from "node:test";
import { installDomShims } from "./dom-shim.mjs";

installDomShims();
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });

const { state, dom } = await import("../static/state.js");
const { on, off, emit } = await import("../static/bus.js");

test("emit calls subscribers in order; off removes them", () => {
  const calls = [];
  const a = () => calls.push("a");
  const b = () => calls.push("b");
  on("t", a);
  on("t", b);
  emit("t");
  assert.deepEqual(calls, ["a", "b"]);

  off("t", a);
  emit("t");
  assert.deepEqual(calls, ["a", "b", "b"]);

  emit("never-subscribed");
  const unsub = on("t", a);
  unsub();
  emit("t");
  assert.equal(calls.length, 4);
});

test("emit passes the detail payload through", () => {
  let seen;
  on("d", (x) => (seen = x));
  emit("d", 42);
  assert.equal(seen, 42);
});

test('emitting "context-menu:hide" hides the menu via the batch.js subscription', async () => {
  await import("../static/batch.js");
  dom.tabContextMenu.style.display = "block";
  emit("context-menu:hide");
  assert.equal(dom.tabContextMenu.style.display, "none");
});

test('"clipboard:probe" emit reaches the clipboard state probe', async () => {
  const { refreshClipboardState } = await import("../static/clipboard.js");
  on("clipboard:probe", refreshClipboardState);
  const probes = [];
  on("clipboard:probe", () => probes.push(1));
  window.pywebview = {
    api: { has_clipboard_image: async () => ({ has_image: true }) },
  };
  emit("clipboard:probe");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(state.clipboardHasImage, true);
  assert.equal(probes.length, 1, "emit reached subscribers besides the probe");
  delete window.pywebview;
  state.clipboardHasImage = null;
});

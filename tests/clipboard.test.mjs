/**
 * Node unit tests for static/clipboard.js: confirm-gated ingest, native and
 * Clipboard API image reads, the paste event handler, and the clipboard
 * probe behind Edit > Paste Image.
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
const {
  ingestWithConfirm,
  readNativeClipboardImage,
  handlePasteEvent,
  pasteImageFromClipboard,
  refreshClipboardState,
} = await import("../static/clipboard.js");

const enc = new TextEncoder();
const b64 = Buffer.from("img").toString("base64");
const pngFile = (name = "paste.png") =>
  new File([enc.encode("img")], name, { type: "image/png" });

function reset() {
  state.tabs = [];
  state.activeTabId = null;
  state.sourceFile = null;
  state.resultBlob = null;
  state.isProcessing = false;
  state.abortController = null;
  state.clipboardHasImage = undefined;
  state.pendingConfirmFn = null;
  dom.confirmModal.classList.remove("active");
  dom.errorToast.textContent = "";
  delete window.pywebview;
  delete navigator.clipboard;
}

test("ingestWithConfirm loads directly when idle", () => {
  reset();
  ingestWithConfirm(pngFile("a.png"));
  assert.equal(state.tabs.length, 1);
  assert.equal(state.sourceFile.name, "a.png");
});

test("ingestWithConfirm asks before replacing a processing image", () => {
  reset();
  state.isProcessing = true;
  ingestWithConfirm(pngFile("b.png"));
  assert.equal(state.tabs.length, 0);
  assert.ok(dom.confirmModal.classList.contains("active"));
  assert.match(dom.modalDesc.textContent, /pasted image/);

  state.pendingConfirmFn();
  assert.equal(state.isProcessing, false);
  assert.equal(state.sourceFile.name, "b.png");
});

test("readNativeClipboardImage decodes bridge images and tolerates failures", async () => {
  reset();
  assert.equal(await readNativeClipboardImage(), null, "no bridge");

  window.pywebview = {
    api: { read_clipboard_image: async () => ({ has_image: true, data_b64: b64 }) },
  };
  const file = await readNativeClipboardImage();
  assert.equal(file.name, "CLIPBOARD.PNG");
  assert.equal(file.type, "image/png");

  window.pywebview.api.read_clipboard_image = async () => ({ has_image: false });
  assert.equal(await readNativeClipboardImage(), null);

  window.pywebview.api.read_clipboard_image = async () => {
    throw new Error("boom");
  };
  assert.equal(await readNativeClipboardImage(), null);
});

test("handlePasteEvent ignores pastes into text fields", async () => {
  reset();
  const item = { type: "image/png", getAsFile: () => pngFile() };
  await handlePasteEvent({
    target: new FakeElement("input"),
    clipboardData: { items: [item] },
  });
  assert.equal(state.tabs.length, 0);
});

test("handlePasteEvent ingests the first image item", async () => {
  reset();
  const items = [
    { type: "text/plain", getAsFile: () => null },
    { type: "image/png", getAsFile: () => pngFile("event.png") },
  ];
  await handlePasteEvent({ target: new FakeElement("div"), clipboardData: { items } });
  assert.equal(state.sourceFile.name, "event.png");
});

test("handlePasteEvent falls back to the native clipboard", async () => {
  reset();
  window.pywebview = {
    api: {
      read_clipboard_image: async () => ({
        has_image: true,
        data_b64: b64,
        name: "native.png",
      }),
    },
  };
  await handlePasteEvent({ target: new FakeElement("div"), clipboardData: { items: [] } });
  assert.equal(state.sourceFile.name, "native.png");
});

test("pasteImageFromClipboard reads the Clipboard API without a bridge", async () => {
  reset();
  navigator.clipboard = {
    read: async () => [
      { types: ["text/plain"], getType: async () => null },
      { types: ["image/png"], getType: async () => pngFile("api.png") },
    ],
  };
  await pasteImageFromClipboard();
  assert.equal(state.sourceFile.name, "api.png");
});

test("pasteImageFromClipboard reports empty or unreadable clipboards", async () => {
  reset();
  navigator.clipboard = { read: async () => [{ types: ["text/plain"] }] };
  await pasteImageFromClipboard();
  assert.match(dom.errorToast.textContent, /does not contain an image\.$/);

  navigator.clipboard = {
    read: async () => {
      throw new Error("denied");
    },
  };
  await pasteImageFromClipboard();
  assert.match(dom.errorToast.textContent, /Cmd\/Ctrl\+V/);
  assert.equal(state.tabs.length, 0);
});

test("refreshClipboardState trusts only boolean bridge answers", async () => {
  reset();
  window.pywebview = { api: { has_clipboard_image: async () => ({ has_image: true }) } };
  await refreshClipboardState();
  assert.equal(state.clipboardHasImage, true);

  window.pywebview.api.has_clipboard_image = async () => ({ has_image: "yes" });
  await refreshClipboardState();
  assert.equal(state.clipboardHasImage, null);

  window.pywebview.api.has_clipboard_image = async () => {
    throw new Error("boom");
  };
  await refreshClipboardState();
  assert.equal(state.clipboardHasImage, null);
});

test("refreshClipboardState probes the Clipboard API in browser mode", async () => {
  reset();
  await refreshClipboardState();
  assert.equal(state.clipboardHasImage, null, "no Clipboard API");

  navigator.clipboard = { read: async () => [{ types: ["image/png"] }] };
  await refreshClipboardState();
  assert.equal(state.clipboardHasImage, true);

  navigator.clipboard = { read: async () => [{ types: ["text/plain"] }, {}] };
  await refreshClipboardState();
  assert.equal(state.clipboardHasImage, false);

  navigator.clipboard = {
    read: async () => {
      throw new Error("denied");
    },
  };
  await refreshClipboardState();
  assert.equal(state.clipboardHasImage, null);
});

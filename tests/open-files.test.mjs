/**
 * Node unit tests for static/open-files.js: the Open dialog routing, the
 * hidden file input filter, window and tab-bar drops, and the pending-files
 * pull from the bridge or `/api/pending-files`.
 *
 * Run with: node --test tests/
 */

import assert from "node:assert/strict";
import test from "node:test";
import { installDomShims, FakeElement } from "./dom-shim.mjs";
import { wireRealTabOps } from "./workspace-deps.mjs";

installDomShims();
await wireRealTabOps();
const fetchCalls = [];
let pendingHttp = { files: [] };
globalThis.fetch = async (url, opts = {}) => {
  fetchCalls.push({ url: String(url), method: opts.method || "GET" });
  return { ok: true, json: async () => pendingHttp };
};

const { state, dom, createTabRecord, getActiveTab } = await import(
  "../static/state.js"
);
const {
  openImageDialog,
  requestOpenImage,
  handleFileInputChange,
  handleWindowDrop,
  handleTabBarDrop,
  pullPendingFiles,
  pendingFilesPollMs,
} = await import("../static/open-files.js");

const enc = new TextEncoder();
const b64 = Buffer.from("img").toString("base64");
const pngFile = (name = "a.png") =>
  new File([enc.encode("img")], name, { type: "image/png" });
const txtFile = (name = "notes.txt") =>
  new File([enc.encode("x")], name, { type: "text/plain" });

let inputClicks = 0;
dom.fileInput.click = () => {
  inputClicks += 1;
};

function reset() {
  state.tabs = [];
  state.activeTabId = null;
  state.sourceFile = null;
  state.resultBlob = null;
  state.isProcessing = false;
  state.abortController = null;
  state.expectingBatch = false;
  state.dragBatchItem = null;
  state.batch.running = false;
  state.pendingConfirmFn = null;
  state.pendingAltFn = null;
  dom.confirmModal.classList.remove("active");
  dom.modalTitle.textContent = "";
  dom.modalDesc.textContent = "";
  dom.errorToast.textContent = "";
  dom.viewport.classList.remove("dragover");
  inputClicks = 0;
  fetchCalls.length = 0;
  pendingHttp = { files: [] };
  delete window.pywebview;
}

const dropEvent = (files, target = new FakeElement("div")) => ({
  target,
  dataTransfer: { files },
  preventDefault() {},
  stopPropagation() {},
});

test("openImageDialog falls back to the hidden file input", async () => {
  reset();
  await openImageDialog();
  assert.equal(inputClicks, 1);
});

test("openImageDialog ingests one native pick and offers a chooser for many", async () => {
  reset();
  window.pywebview = {
    api: { open_image_dialog: async () => ({ data_b64: b64, name: "one.png" }) },
  };
  await openImageDialog();
  assert.equal(state.sourceFile.name, "one.png");

  window.pywebview.api.open_image_dialog = async () => ({
    files: [
      { data_b64: b64, name: "x.png" },
      { data_b64: b64, name: "y.png" },
    ],
  });
  await openImageDialog();
  assert.match(dom.modalTitle.textContent, /2 IMAGES SELECTED/);

  window.pywebview.api.open_image_dialog = async () => ({ error: "Denied" });
  await openImageDialog();
  assert.match(dom.errorToast.textContent, /Denied/);
  assert.equal(inputClicks, 0);
});

test("requestOpenImage confirms before stopping a running job", async () => {
  reset();
  state.isProcessing = true;
  requestOpenImage();
  assert.equal(inputClicks, 0);
  assert.match(dom.modalDesc.textContent, /open a new image/);
  state.pendingConfirmFn();
  await Promise.resolve();
  assert.equal(state.isProcessing, false);
  assert.equal(inputClicks, 1);
});

test("handleFileInputChange rejects non-images and routes single picks", () => {
  reset();
  handleFileInputChange({ target: { files: [txtFile()] } });
  assert.match(dom.errorToast.textContent, /only image files/i);
  assert.equal(state.tabs.length, 0);

  handleFileInputChange({ target: { files: [pngFile("p.png"), txtFile()] } });
  assert.match(dom.errorToast.textContent, /non-image files skipped/i);
  assert.equal(state.sourceFile.name, "p.png");
});

test("handleFileInputChange consumes the batch intent", () => {
  reset();
  state.expectingBatch = true;
  handleFileInputChange({ target: { files: [pngFile("1.png"), pngFile("2.png")] } });
  assert.equal(state.expectingBatch, false);
  assert.equal(getActiveTab().kind, "batch");
  assert.equal(getActiveTab().batchFiles.length, 2);
});

test("handleFileInputChange offers the tabs/batch chooser for several images", () => {
  reset();
  handleFileInputChange({ target: { files: [pngFile("1.png"), pngFile("2.png")] } });
  assert.equal(state.tabs.length, 0);
  assert.match(dom.modalTitle.textContent, /2 IMAGES SELECTED/);
});

test("handleWindowDrop loads a single image and clears the highlight", () => {
  reset();
  dom.viewport.classList.add("dragover");
  handleWindowDrop(dropEvent([pngFile("drop.png")]));
  assert.ok(!dom.viewport.classList.contains("dragover"));
  assert.equal(state.sourceFile.name, "drop.png");
});

test("handleWindowDrop appends to an idle batch tab", () => {
  reset();
  const batch = createTabRecord({ kind: "batch", name: "BATCH" });
  state.tabs.push(batch);
  state.activeTabId = batch.id;
  handleWindowDrop(dropEvent([pngFile("1.png"), pngFile("2.png")]));
  assert.equal(batch.batchFiles.length, 2);
});

test("handleWindowDrop confirms while processing and rejects non-images", () => {
  reset();
  handleWindowDrop(dropEvent([txtFile()]));
  assert.match(dom.errorToast.textContent, /only image files/i);

  state.isProcessing = true;
  handleWindowDrop(dropEvent([pngFile("late.png")]));
  assert.match(dom.modalDesc.textContent, /dropped image/);
  assert.equal(state.tabs.length, 0);
  state.pendingConfirmFn();
  assert.equal(state.sourceFile.name, "late.png");
});

function batchWithRows(...names) {
  const tab = createTabRecord({
    kind: "batch",
    name: "BATCH",
    batchFiles: names.map((n) => ({ file: pngFile(n), name: n, status: "queued" })),
  });
  state.tabs.push(tab);
  state.activeTabId = tab.id;
  return tab;
}

test("dropping a batch row outside the list extracts it into a tab", () => {
  reset();
  const tab = batchWithRows("r1.png", "r2.png");
  state.dragBatchItem = { tabId: tab.id, index: 1 };
  handleWindowDrop(dropEvent([]));
  assert.equal(state.dragBatchItem, null);
  assert.equal(tab.batchFiles.length, 1);
  assert.equal(state.sourceFile.name, "r2.png");
});

test("dropping a batch row back on the list leaves the queue alone", () => {
  reset();
  const tab = batchWithRows("r1.png", "r2.png");
  const list = new FakeElement("div");
  list.classList.add("batch-list");
  const row = new FakeElement("div");
  list.appendChild(row);
  state.dragBatchItem = { tabId: tab.id, index: 0 };
  handleWindowDrop(dropEvent([], row));
  assert.equal(state.dragBatchItem, null);
  assert.equal(tab.batchFiles.length, 2);
});

test("handleTabBarDrop extracts dragged rows and ignores plain drops", () => {
  reset();
  let stopped = false;
  const ev = {
    preventDefault() {},
    stopPropagation() {
      stopped = true;
    },
  };
  handleTabBarDrop(ev);
  assert.equal(stopped, false, "file drops bubble to the window handler");

  const tab = batchWithRows("r1.png", "r2.png");
  state.dragBatchItem = { tabId: tab.id, index: 0 };
  handleTabBarDrop(ev);
  assert.equal(stopped, true);
  assert.equal(tab.batchFiles.length, 1);
  assert.equal(state.sourceFile.name, "r1.png");
});

test("pullPendingFiles drains the bridge queue without an HTTP POST", async () => {
  reset();
  window.pywebview = {
    api: { take_pending_files: async () => ({ files: [{ data_b64: b64, name: "os.png" }] }) },
  };
  await pullPendingFiles();
  assert.equal(state.sourceFile.name, "os.png");
  assert.ok(!fetchCalls.some((c) => c.url.includes("/api/pending-files")));
});

test("pullPendingFiles polls the HTTP endpoint in browser mode", async () => {
  reset();
  await pullPendingFiles();
  assert.deepEqual(
    fetchCalls.filter((c) => c.url.includes("/api/pending-files")),
    [{ url: "/api/pending-files", method: "POST" }]
  );
  assert.equal(state.tabs.length, 0, "empty queue is a no-op");

  pendingHttp = { error: "Queue unavailable" };
  await pullPendingFiles();
  assert.match(dom.errorToast.textContent, /Queue unavailable/);
});

test("pullPendingFiles cancels a running job before loading", async () => {
  reset();
  state.isProcessing = true;
  window.pywebview = {
    api: { take_pending_files: async () => ({ data_b64: b64, name: "argv.png" }) },
  };
  await pullPendingFiles();
  assert.equal(state.isProcessing, false);
  assert.equal(state.sourceFile.name, "argv.png");
});

test("pendingFilesPollMs is slow with the native bridge and quick without", () => {
  reset();
  assert.equal(pendingFilesPollMs(), 2000);
  window.pywebview = { api: { take_pending_files: async () => null } };
  assert.equal(pendingFilesPollMs(), 10000);
});

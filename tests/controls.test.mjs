/**
 * Node unit tests for static/controls.js: the process-button gate, edge
 * toggles and sliders, export format/scale/dims math, and download routing.
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
globalThis.fetch = async (url) => {
  fetchCalls.push(String(url));
  return { ok: true, json: async () => ({}) };
};

const { state, dom, createTabRecord } = await import("../static/state.js");
const {
  handleProcessClick,
  toggleDefringe,
  toggleDespill,
  handleShadowCutoffInput,
  handleEdgeShiftInput,
  handleEdgeFeatherInput,
  handleFormatPick,
  toggleAutoCrop,
  handleCropPaddingInput,
  handleBackdropBlurInput,
  handleExportScaleInput,
  toggleAspectLock,
  handleExportWidthInput,
  handleExportHeightInput,
  handleDownloadClick,
  handleBatchRetryClick,
} = await import("../static/controls.js");

function reset() {
  state.tabs = [];
  state.activeTabId = null;
  state.sourceFile = null;
  state.resultBlob = null;
  state.isProcessing = false;
  state.defringe = false;
  state.despill = false;
  state.shadowCutoff = 0;
  state.edgeShift = 0;
  state.edgeFeather = 0;
  state.autoCrop = false;
  state.aspectLocked = false;
  state.backdropBlur = 0;
  state.cropPadding = 5;
  state.exportScale = 1;
  state.exportWidth = 0;
  state.exportHeight = 0;
  state.naturalWidth = 0;
  state.naturalHeight = 0;
  state.exportFormat = "png";
  state.batch.running = false;
  fetchCalls.length = 0;
  dom.btnDefringe.classList.remove("active");
  dom.btnDespill?.classList.remove("active");
  dom.errorToast.textContent = "";
}

test("process button gates on a loaded, idle image", () => {
  reset();
  handleProcessClick();
  assert.equal(fetchCalls.length, 0, "no image: no request");

  state.isProcessing = true;
  state.sourceFile = new File(["x"], "a.png", { type: "image/png" });
  handleProcessClick();
  assert.equal(fetchCalls.length, 0, "busy: no request");

  state.isProcessing = false;
  handleProcessClick();
  assert.ok(
    fetchCalls.some((u) => u.includes("/api/remove-bg")),
    "idle image posts to remove-bg"
  );
});

test("defringe and despill toggles flip state and button classes", () => {
  reset();
  toggleDefringe();
  assert.equal(state.defringe, true);
  assert.ok(dom.btnDefringe.classList.contains("active"));
  toggleDefringe();
  assert.equal(state.defringe, false);
  assert.ok(!dom.btnDefringe.classList.contains("active"));

  toggleDespill();
  assert.equal(state.despill, true);
  assert.ok(dom.btnDespill.classList.contains("active"));
});

test("sliders update state and their labels", () => {
  reset();
  handleShadowCutoffInput("35");
  assert.equal(state.shadowCutoff, 35);
  assert.equal(dom.shadowCutoffLabel.textContent, "35%");

  handleEdgeShiftInput("-4");
  assert.equal(state.edgeShift, -4);
  assert.equal(dom.edgeShiftLabel.textContent, "-4px");
  handleEdgeShiftInput("4");
  assert.equal(dom.edgeShiftLabel.textContent, "+4px");

  handleEdgeFeatherInput("12");
  assert.equal(state.edgeFeather, 12);
  assert.equal(dom.edgeFeatherLabel.textContent, "12px");

  handleCropPaddingInput("9");
  assert.equal(state.cropPadding, 9);
  assert.equal(dom.cropPaddingLabel.textContent, "9%");

  handleBackdropBlurInput("50");
  assert.equal(state.backdropBlur, 50);
  assert.equal(dom.backdropBlurLabel.textContent, "50%");
});

test("format pick stores the format and refreshes the export button", () => {
  reset();
  const btn = new FakeElement("button");
  btn.setAttribute("data-format", "webp");
  handleFormatPick(btn);
  assert.equal(state.exportFormat, "webp");
  assert.match(dom.btnDownload.textContent, /WEBP/);
});

test("auto-crop toggle mirrors state on the switch and padding wrap", () => {
  reset();
  toggleAutoCrop();
  assert.equal(state.autoCrop, true);
  assert.ok(dom.btnAutoCrop.classList.contains("active"));
  assert.equal(dom.btnAutoCrop.getAttribute("aria-checked"), "true");
  assert.ok(!dom.cropPaddingWrap.classList.contains("disabled"));
  toggleAutoCrop();
  assert.ok(dom.cropPaddingWrap.classList.contains("disabled"));
});

test("scale slider applies percent-to-fraction scale", () => {
  reset();
  state.naturalWidth = 800;
  state.naturalHeight = 400;
  handleExportScaleInput("150");
  assert.equal(state.exportScale, 1.5);
  assert.equal(state.exportWidth, 1200);
  assert.equal(state.exportHeight, 600);
});

test("aspect lock links width and height through the scale", () => {
  reset();
  state.naturalWidth = 1000;
  state.naturalHeight = 500;
  toggleAspectLock();
  assert.equal(state.aspectLocked, true);
  assert.equal(dom.aspectLockBtn.getAttribute("aria-pressed"), "true");

  handleExportWidthInput("500");
  assert.equal(state.exportWidth, 500);
  assert.equal(state.exportScale, 0.5);
  assert.equal(state.exportHeight, 250);
  assert.equal(dom.exportHeightInput.value, "250");

  handleExportHeightInput("400");
  assert.equal(state.exportHeight, 400);
  assert.equal(state.exportWidth, 800);
  assert.equal(dom.exportWidthInput.value, "800");

  handleExportWidthInput("");
  // Cleared input means "auto": telemetry restores the scale-derived dims.
  assert.equal(state.exportWidth, 800);
  assert.equal(state.exportHeight, 400);
});

test("export dims clamp to 16384 and skip linking when unlocked", () => {
  reset();
  state.naturalWidth = 1000;
  state.naturalHeight = 500;
  handleExportWidthInput("99999");
  assert.equal(state.exportWidth, 16384);
  assert.equal(state.exportHeight, 500, "telemetry auto-fills the cleared height");
});

test("download routes to the batch queue or the image export", () => {
  reset();
  const batch = createTabRecord({
    kind: "batch",
    name: "BATCH",
    batchFiles: [{ file: {}, name: "a.png", status: "queued", selected: false }],
  });
  state.tabs.push(batch);
  state.activeTabId = batch.id;
  handleDownloadClick();
  assert.match(dom.errorToast.textContent, /select at least one/i);
});

test("retry posts only for batch tabs", () => {
  reset();
  const batch = createTabRecord({
    kind: "batch",
    name: "BATCH",
    batchFiles: [{ file: {}, name: "a.png", status: "done", selected: true }],
  });
  state.tabs.push(batch);
  state.activeTabId = batch.id;
  handleBatchRetryClick();
  assert.match(dom.errorToast.textContent, /no failed entries/i);
});

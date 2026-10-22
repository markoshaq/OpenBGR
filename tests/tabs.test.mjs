/**
 * Node unit tests for static/tabs.js: tab lifecycle (ingest, switch, close,
 * cancel) and the runSegmentation request/apply path against a stubbed
 * `/api/remove-bg`.
 *
 * Run with: node --test tests/
 */

import assert from "node:assert/strict";
import test from "node:test";
import { installDomShims } from "./dom-shim.mjs";
import { wireRealTabOps } from "./workspace-deps.mjs";

installDomShims();
await wireRealTabOps();
globalThis.createImageBitmap = async () => ({
  width: 320,
  height: 240,
  close() {},
});

const { state, dom, prefs, createTabRecord, getActiveTab } = await import(
  "../static/state.js"
);
const {
  ingestImageFile,
  createBlankTab,
  requestSwitchToTab,
  requestCloseTab,
  closeTabImmediate,
  switchToTab,
} = await import("../static/tabs.js");
const { cancelProcessing, runSegmentation } = await import(
  "../static/segmentation.js"
);

const enc = new TextEncoder();

function resetWorkspace() {
  state.tabs = [];
  state.activeTabId = null;
  state.sourceFile = null;
  state.originalObjectUrl = null;
  state.resultBlob = null;
  state.resultObjectUrl = null;
  state.previewBlob = null;
  state.previewObjectUrl = null;
  state.isProcessing = false;
  state.abortController = null;
  state.serverStatus = { tiers: {}, recommended_tier: "general" };
  state.tier = "general";
  state.edgeShift = 0;
  state.edgeFeather = 0;
  state.confirmCloseTab = true;
  Object.assign(state.batch, {
    running: false,
    tabId: null,
    total: 0,
    index: 0,
    failed: 0,
    cancelled: false,
    results: [],
    zipWriter: null,
  });
  dom.batchList.replaceChildren();
  dom.errorToast.classList.remove("visible");
  dom.errorToast.textContent = "";
  dom.confirmModal.classList.remove("active");
  state.pendingConfirmFn = null;
  state.pendingAltFn = null;
}

function pngFile(name = "photo.png") {
  return new File([enc.encode("img")], name, { type: "image/png" });
}

test("ingestImageFile creates a tab, loads the image, and names the stats", () => {
  resetWorkspace();
  ingestImageFile(pngFile("cat.jpg"));
  assert.equal(state.tabs.length, 1);
  const tab = getActiveTab();
  assert.equal(tab.name, "cat.jpg");
  assert.equal(tab.sourceFile, state.sourceFile);
  assert.equal(dom.statFile.textContent, "CAT.JPG");
  assert.equal(dom.statTime.textContent, "READY");
  assert.ok(dom.stage.classList.contains("visible"));
});

test("ingestImageFile rejects non-image files with an error toast", () => {
  resetWorkspace();
  ingestImageFile(new File([enc.encode("x")], "doc.txt", { type: "text/plain" }));
  assert.equal(state.tabs.length, 0);
  assert.match(dom.errorToast.textContent, /only image files/i);
});

test("createBlankTab appends a fresh tab and activates it", () => {
  resetWorkspace();
  createBlankTab();
  assert.equal(state.tabs.length, 1);
  assert.equal(getActiveTab().kind, "image");
  assert.equal(state.activeTabId, state.tabs[0].id);
});

test("switchToTab restores the target tab's mirrored fields", async () => {
  resetWorkspace();
  const a = createTabRecord({ name: "A", tier: "lite", despill: false, zoom: 3 });
  const b = createTabRecord({ name: "B", tier: "hr", despill: true, zoom: 1 });
  state.tabs.push(a, b);
  state.activeTabId = a.id;
  state.tier = "lite";

  await switchToTab(b.id);
  assert.equal(state.activeTabId, b.id);
  assert.equal(state.tier, "hr");
  assert.equal(state.despill, true);
  assert.equal(state.zoom, 1);
  const elB = document.querySelector(`[data-tab-id="${b.id}"]`);
  assert.ok(elB.classList.contains("active"));
});

test("requestSwitchToTab asks for confirmation while a job is processing", () => {
  resetWorkspace();
  const a = createTabRecord({ name: "A" });
  const b = createTabRecord({ name: "B" });
  state.tabs.push(a, b);
  state.activeTabId = a.id;
  state.isProcessing = true;

  requestSwitchToTab(b.id);
  assert.equal(state.activeTabId, a.id, "no switch before confirm");
  assert.ok(dom.confirmModal.classList.contains("active"));
  assert.match(dom.modalDesc.textContent, /"B"/);

  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
  state.pendingConfirmFn();
  assert.equal(state.activeTabId, b.id);
  assert.equal(state.isProcessing, false);
});

test("requestCloseTab prompts for content tabs and removes them on confirm", () => {
  resetWorkspace();
  const tab = createTabRecord({ name: "CAT.JPG", sourceFile: pngFile() });
  state.tabs.push(tab);
  state.activeTabId = tab.id;

  requestCloseTab(tab.id);
  assert.ok(dom.confirmModal.classList.contains("active"));
  assert.match(dom.modalTitle.textContent, /CLOSE IMAGE TAB/);

  state.pendingConfirmFn();
  assert.equal(state.tabs.length, 0);
  assert.equal(state.activeTabId, null);
  assert.equal(dom.statFile.textContent, "NONE");
});

test("requestCloseTab skips the prompt for empty tabs", () => {
  resetWorkspace();
  const tab = createTabRecord({ name: "NEW TAB" });
  const keeper = createTabRecord({ name: "KEEP", sourceFile: pngFile() });
  state.tabs.push(keeper, tab);
  state.activeTabId = keeper.id;

  requestCloseTab(tab.id);
  assert.ok(!dom.confirmModal.classList.contains("active"));
  assert.equal(state.tabs.length, 1);
  assert.equal(state.tabs[0].id, keeper.id);
});

test("cancelProcessing clears the job flags and stamps CANCELLED", () => {
  resetWorkspace();
  const tab = createTabRecord({ name: "A", sourceFile: pngFile() });
  state.tabs.push(tab);
  state.activeTabId = tab.id;
  state.sourceFile = tab.sourceFile;
  state.isProcessing = true;
  state.abortController = new AbortController();
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });

  cancelProcessing();
  assert.equal(state.isProcessing, false);
  assert.equal(state.abortController, null);
  assert.match(dom.statTime.textContent, /CANCELLED/);
  assert.ok(!dom.busyOverlay.classList.contains("active"));
});

test("runSegmentation posts the image and applies blob, dims, and job id", async () => {
  resetWorkspace();
  ingestImageFile(pngFile("dog.png"));
  assert.equal(state.sourceFile?.name, "dog.png");

  state.edgeShift = -2;
  state.edgeFeather = 4;
  let seenForm = null;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("/api/remove-bg")) {
      seenForm = opts.body;
      return {
        ok: true,
        headers: new Headers({
          "X-Inference-Time-Ms": "42",
          "X-Image-Width": "8",
          "X-Image-Height": "4",
          "X-Refine-Job-Id": "7",
        }),
        blob: async () => new Blob([new Uint8Array(9)], { type: "image/png" }),
      };
    }
    return { ok: true, json: async () => ({}), headers: new Headers() };
  };

  await runSegmentation();

  assert.ok(state.resultBlob instanceof Blob);
  assert.equal(state.refineJobId, 7);
  assert.equal(state.naturalWidth, 8);
  assert.equal(state.naturalHeight, 4);
  assert.equal(prefs.inferEstimates.general, 42);
  assert.equal(state.isProcessing, false);
  assert.ok(!dom.busyOverlay.classList.contains("active"));
  assert.ok(!dom.btnDownload.classList.contains("disabled"));
  assert.equal(seenForm.get("tier"), "general");
  assert.equal(seenForm.get("defringe"), "true");
  assert.equal(seenForm.get("edge_shift"), "-2");
  assert.equal(seenForm.get("edge_feather"), "4");
  state.edgeShift = 0;
  state.edgeFeather = 0;
});

test("runSegmentation surfaces the server detail on HTTP errors", async () => {
  resetWorkspace();
  ingestImageFile(pngFile());
  globalThis.fetch = async (url) => {
    if (String(url).includes("/api/remove-bg")) {
      return {
        ok: false,
        status: 400,
        json: async () => ({ detail: "Uploaded image file is empty." }),
      };
    }
    return { ok: true, json: async () => ({}), headers: new Headers() };
  };

  await runSegmentation();
  assert.equal(state.resultBlob, null);
  assert.match(dom.errorToast.textContent, /empty/i);
  assert.equal(dom.statTime.textContent, "ERROR");
});

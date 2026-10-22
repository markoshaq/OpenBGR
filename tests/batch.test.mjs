/**
 * Node unit tests for static/batch.js: queue management, panel row DOM,
 * and the sequential runBatch lifecycle against a stubbed `/api/remove-bg`.
 *
 * Run with: node --test tests/
 */

import assert from "node:assert/strict";
import test from "node:test";
import { installDomShims } from "./dom-shim.mjs";

installDomShims();
globalThis.createImageBitmap = async () => ({
  width: 320,
  height: 240,
  close() {},
});

const { state, dom, createTabRecord } = await import("../static/state.js");
const { addFilesToBatchTab, renderBatchPanel, runBatch } = await import(
  "../static/batch.js"
);

const enc = new TextEncoder();

function resetWorkspace() {
  state.tabs = [];
  state.activeTabId = null;
  state.sourceFile = null;
  state.resultBlob = null;
  state.isProcessing = false;
  state.abortController = null;
  state.outputDir = null;
  state.serverStatus = { tiers: {} };
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
}

function makeBatchTab(fileNames) {
  const files = fileNames.map(
    (n) => new File([enc.encode(`data-${n}`)], n, { type: "image/png" })
  );
  const tab = createTabRecord({
    kind: "batch",
    name: "BATCH",
    batchFiles: files.map((f) => ({
      file: f,
      name: f.name,
      size: f.size,
      status: "queued",
    })),
  });
  state.tabs.push(tab);
  state.activeTabId = tab.id;
  return tab;
}

/** Installs a fetch stub that answers /api/remove-bg per a caller's hook. */
function stubFetch(onRemoveBg) {
  let removeBgCalls = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/api/remove-bg")) {
      removeBgCalls++;
      return onRemoveBg(removeBgCalls);
    }
    return { ok: true, json: async () => ({}), headers: new Headers() };
  };
  return () => removeBgCalls;
}

const OK_RESPONSE = {
  ok: true,
  headers: new Headers({
    "X-Inference-Time-Ms": "10",
    "X-Image-Width": "8",
    "X-Image-Height": "8",
    "X-Refine-Job-Id": "3",
  }),
  blob: async () => new Blob([new Uint8Array(4)], { type: "image/png" }),
};

test("addFilesToBatchTab queues images, filters non-images, and reports skips", () => {
  resetWorkspace();
  const tab = makeBatchTab([]);
  addFilesToBatchTab(tab, [
    new File([enc.encode("a")], "a.png", { type: "image/png" }),
    new File([enc.encode("b")], "notes.txt", { type: "text/plain" }),
  ]);
  assert.equal(tab.batchFiles.length, 1);
  assert.equal(tab.batchFiles[0].name, "a.png");
  assert.equal(tab.batchFiles[0].status, "queued");
  assert.match(dom.errorToast.textContent, /non-image files skipped/i);
});

test("renderBatchPanel builds one row per entry and the check-all toggle flips all", () => {
  resetWorkspace();
  const tab = makeBatchTab(["a.png", "b.png"]);
  renderBatchPanel(tab);

  const rows = dom.batchList.querySelectorAll(".batch-row");
  assert.equal(rows.length, 2);
  assert.equal(
    rows[0].querySelector(".batch-row-name").textContent,
    "a.png"
  );
  assert.equal(rows[0].querySelector(".batch-row-status").textContent, "QUEUED");

  dom.batchCheckAll.click();
  assert.ok(tab.batchFiles.every((e) => e.selected === false));
  assert.ok(tab.batchFiles.every((e) => e.status === "skipped"));
  assert.ok(
    dom.batchList
      .querySelectorAll(".batch-row")
      .every((r) => r.classList.contains("off"))
  );

  dom.batchCheckAll.click();
  assert.ok(tab.batchFiles.every((e) => e.selected !== false));
  assert.ok(tab.batchFiles.every((e) => e.status === "queued"));
});

test("a row's checkbox toggles its selected state and status", () => {
  resetWorkspace();
  const tab = makeBatchTab(["a.png"]);
  renderBatchPanel(tab);
  const row = dom.batchList.querySelector(".batch-row");
  row.querySelector(".batch-check").click();
  assert.equal(tab.batchFiles[0].selected, false);
  assert.equal(tab.batchFiles[0].status, "skipped");
  row.querySelector(".batch-check").click();
  assert.equal(tab.batchFiles[0].selected, true);
  assert.equal(tab.batchFiles[0].status, "queued");
});

test("a row's remove button drops the entry and re-indexes the rest", () => {
  resetWorkspace();
  const tab = makeBatchTab(["a.png", "b.png", "c.png"]);
  renderBatchPanel(tab);
  dom.batchList
    .querySelectorAll(".batch-row")[0]
    .querySelector(".batch-row-remove")
    .click();
  assert.deepEqual(
    tab.batchFiles.map((e) => e.name),
    ["b.png", "c.png"]
  );
  const rows = dom.batchList.querySelectorAll(".batch-row");
  assert.equal(rows.length, 2);
  // data-idx is re-indexed so the next remove targets the right entry.
  rows[0].querySelector(".batch-row-remove").click();
  assert.deepEqual(
    tab.batchFiles.map((e) => e.name),
    ["c.png"]
  );
});

test("runBatch processes each selected entry and shows the completion summary", async () => {
  resetWorkspace();
  const calls = stubFetch(() => ({ ...OK_RESPONSE }));
  const tab = makeBatchTab(["a.png", "b.png"]);
  tab.batchFiles[1].selected = true;

  await runBatch(tab);

  assert.equal(calls(), 2);
  assert.ok(tab.batchFiles.every((e) => e.status === "done"));
  assert.equal(state.batch.running, false);
  assert.equal(state.isProcessing, false);
  assert.ok(dom.confirmModal.classList.contains("active"));
  assert.match(dom.modalDesc.textContent, /2 of 2 images processed/);
});

test("runBatch skips deselected entries and records save/HTTP failures per row", async () => {
  resetWorkspace();
  const calls = stubFetch(() => ({
    ok: false,
    status: 500,
    json: async () => ({ detail: "boom" }),
    headers: new Headers(),
  }));
  const tab = makeBatchTab(["a.png", "b.png"]);
  tab.batchFiles[1].selected = false;

  await runBatch(tab);

  assert.equal(calls(), 1, "only the selected entry is fetched");
  assert.equal(tab.batchFiles[0].status, "failed");
  assert.equal(tab.batchFiles[0].error, "boom");
  assert.equal(tab.batchFiles[1].status, "skipped");
  assert.match(dom.modalDesc.textContent, /0 of 1 image processed, 1 failed/);
});

test("runBatch honours a cancel flag set mid-run and restores queued statuses", async () => {
  resetWorkspace();
  stubFetch(() => {
    state.batch.cancelled = true;
    return { ...OK_RESPONSE };
  });
  const tab = makeBatchTab(["a.png", "b.png"]);

  await runBatch(tab);

  assert.ok(
    tab.batchFiles.every((e) => e.status === "queued"),
    "cancelled entries return to queued"
  );
  assert.match(tab.elapsedText, /^CANCELLED/);
  assert.ok(
    !dom.confirmModal.classList.contains("active"),
    "no completion modal on cancel"
  );
});

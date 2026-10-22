/**
 * Node unit tests for static/export-io.js: the output-folder picker, the
 * `/api/save` upload helper, the reveal action, and the export/copy paths
 * (filename composition, bridge vs browser fallbacks).
 *
 * Run with: node --test tests/
 */

import assert from "node:assert/strict";
import test from "node:test";
import { installDomShims } from "./dom-shim.mjs";

installDomShims();

globalThis.createImageBitmap = async () => ({
  width: 100,
  height: 80,
  close() {},
});

const { state, dom, createTabRecord } = await import("../static/state.js");
const {
  chooseOutputFolder,
  saveBatchFile,
  revealSavedPath,
  exportActiveImage,
  copyActiveCutout,
  copyOriginalImage,
} = await import("../static/export-io.js");

const enc = new TextEncoder();

function reset() {
  state.tabs = [];
  state.activeTabId = null;
  state.outputDir = null;
  state.sourceFile = null;
  state.resultBlob = null;
  state.exportFormat = "png";
  state.exportWidth = 0;
  state.exportHeight = 0;
  state.exportScale = 1;
  state.naturalWidth = 0;
  state.naturalHeight = 0;
  state.autoCrop = false;
  state.activeBackdrop = "checker";
  state.shadowCutoff = 0;
  delete window.pywebview;
  delete window.showSaveFilePicker;
  delete globalThis.fetch;
  dom.errorToast.classList.remove("visible", "success");
  dom.errorToast.textContent = "";
  delete dom.errorToast.dataset.kind;
}

test("chooseOutputFolder is a no-op without the native bridge", async () => {
  reset();
  await chooseOutputFolder();
  assert.equal(state.outputDir, null);
});

test("chooseOutputFolder stores the pick and updates a batch tab", async () => {
  reset();
  const tab = createTabRecord({ kind: "batch", name: "BATCH" });
  state.tabs = [tab];
  state.activeTabId = tab.id;
  window.pywebview = {
    api: { choose_output_dir: async () => ({ path: "/out/dir" }) },
  };
  const updates = [];
  await chooseOutputFolder((t) => updates.push(t.id));
  assert.equal(state.outputDir, "/out/dir");
  assert.equal(tab.outputDir, "/out/dir");
  assert.deepEqual(updates, [tab.id]);

  window.pywebview.api.choose_output_dir = async () => ({
    error: "picker broke",
  });
  await chooseOutputFolder();
  assert.match(dom.errorToast.textContent, /picker broke/);
});

test("saveBatchFile maps the response to {ok, detail}", async () => {
  reset();
  const blob = new Blob([enc.encode("x")], { type: "image/png" });

  globalThis.fetch = async () => ({ ok: true });
  assert.deepEqual(await saveBatchFile("/d", "a.png", blob), { ok: true });

  globalThis.fetch = async () => ({
    ok: false,
    status: 403,
    json: async () => ({ detail: "directory not granted" }),
  });
  assert.deepEqual(await saveBatchFile("/d", "a.png", blob), {
    ok: false,
    detail: "directory not granted",
  });

  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  assert.deepEqual(await saveBatchFile("/d", "a.png", blob), {
    ok: false,
    detail: "network down",
  });
});

test("revealSavedPath skips the bridge and reports failures", async () => {
  reset();
  const calls = [];
  window.pywebview = {
    api: { reveal_path: async (p) => (calls.push(p), { revealed: true }) },
  };
  revealSavedPath("");
  assert.deepEqual(calls, []);

  revealSavedPath("/d/a.png");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls, ["/d/a.png"]);
  assert.equal(dom.errorToast.textContent, "");

  window.pywebview.api.reveal_path = async () => ({ revealed: false });
  revealSavedPath("/d/a.png");
  await new Promise((r) => setTimeout(r, 0));
  assert.match(dom.errorToast.textContent, /Could not reveal/);
});

function seedPassthroughExport() {
  // Dims equal to natural size + checker backdrop hits buildExportBlob's
  // byte-exact passthrough, so no canvas decode is needed.
  state.naturalWidth = 100;
  state.naturalHeight = 80;
  state.exportWidth = 100;
  state.exportHeight = 80;
  state.resultBlob = new Blob([enc.encode("png-bytes")], { type: "image/png" });
  state.sourceFile = { name: "photo.png" };
}

test("exportActiveImage composes the Save-As filename and reveals", async () => {
  reset();
  seedPassthroughExport();
  const saves = [];
  window.pywebview = {
    api: {
      save_file: async (b64, name) => {
        saves.push(name);
        return { saved: true, path: `/pics/${name}` };
      },
    },
  };
  await exportActiveImage();
  assert.deepEqual(saves, ["photo-cutout.png"]);
  assert.match(dom.errorToast.textContent, /SAVED: photo-cutout\.png IN \/pics/);
  assert.equal(dom.errorToast.dataset.kind, "success");

  // Non-native dims get a size tag; mask format changes suffix and extension.
  state.exportWidth = 50;
  state.exportHeight = 40;
  state.exportFormat = "mask";
  await exportActiveImage();
  assert.deepEqual(saves, ["photo-cutout.png", "photo-mask-50x40.png"]);
});

test("exportActiveImage uploads to the output dir when one is set", async () => {
  reset();
  seedPassthroughExport();
  state.outputDir = "/exports";
  const posts = [];
  globalThis.fetch = async (url, opts) => {
    posts.push(url);
    return { ok: true, json: async () => ({ path: "/exports/photo-cutout.png" }) };
  };
  window.pywebview = { api: { choose_output_dir: async () => ({}) } };
  await exportActiveImage();
  assert.deepEqual(posts, ["/api/save"]);
  assert.match(dom.errorToast.textContent, /SAVED: photo-cutout\.png IN \/exports/);
});

test("exportActiveImage falls back to a silent download in the browser", async () => {
  reset();
  seedPassthroughExport();
  await exportActiveImage();
  assert.match(dom.errorToast.textContent, /DOWNLOADED: photo-cutout\.png/);
});

test("exportActiveImage treats picker abort as a quiet cancel", async () => {
  reset();
  seedPassthroughExport();
  window.showSaveFilePicker = async () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    throw err;
  };
  await exportActiveImage();
  assert.equal(dom.errorToast.textContent, "");
});

test("copyActiveCutout prefers the native clipboard and flags the button", async () => {
  reset();
  seedPassthroughExport();
  const sent = [];
  window.pywebview = {
    api: {
      copy_image: async (b64) => (sent.push(b64), { copied: true }),
    },
  };
  const original = dom.btnCopy.textContent;
  await copyActiveCutout();
  assert.equal(sent.length, 1);
  assert.equal(dom.btnCopy.textContent, "COPIED");
  dom.btnCopy.textContent = original;
});

test("copyActiveCutout reports an error when every path fails", async () => {
  reset();
  seedPassthroughExport();
  window.pywebview = { api: { copy_image: async () => ({ copied: false }) } };
  await copyActiveCutout();
  assert.match(dom.errorToast.textContent, /Clipboard PNG write/);
});

test("copyOriginalImage re-encodes the source and copies via the bridge", async () => {
  reset();
  state.sourceFile = new File([enc.encode("img")], "in.png", {
    type: "image/png",
  });
  const sent = [];
  window.pywebview = {
    api: { copy_image: async (b64) => (sent.push(b64), { copied: true }) },
  };
  await copyOriginalImage();
  assert.equal(sent.length, 1);
  assert.match(dom.errorToast.textContent, /COPIED: ORIGINAL IMAGE/);
});

/**
 * Node unit tests for the pure helpers in static/state.js. The module reads
 * `localStorage`, `document`, and `Image` at import time, so minimal shims
 * are installed before the dynamic import below.
 *
 * Run with: node --test tests/
 */

import assert from "node:assert/strict";
import test from "node:test";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.document = {
  getElementById: () => null,
  querySelector: () => null,
  createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
};
globalThis.Image = class {};

const {
  normalizeTierKey,
  formatDiskBytes,
  createByteSmoother,
  getDefaultPrefs,
  getTierDownloadText,
  clearResultState,
  createTabRecord,
  defaultTierForNewTab,
  state,
  prefs,
  DEFAULT_CROP_PADDING,
} = await import("../static/state.js");

test("normalizeTierKey resolves legacy aliases and passes canonical keys through", () => {
  assert.equal(normalizeTierKey("low"), "lite");
  assert.equal(normalizeTierKey("mid"), "general");
  assert.equal(normalizeTierKey("full"), "general");
  assert.equal(normalizeTierKey("high"), "hr");
  assert.equal(normalizeTierKey("Portrait"), "portrait");
  assert.equal(normalizeTierKey(""), "");
  assert.equal(normalizeTierKey(null), "");
});

test("formatDiskBytes formats KB/MB/GB ranges and the compact variant", () => {
  assert.equal(formatDiskBytes(0), "0 MB");
  assert.equal(formatDiskBytes(512 * 1024), "512 KB");
  assert.equal(formatDiskBytes(85 * 1024 * 1024), "85.0 MB");
  assert.equal(formatDiskBytes(1.5 * 1024 * 1024 * 1024), "1.50 GB");
  assert.equal(formatDiskBytes(85 * 1024 * 1024, true), "85.0MB");
});

test("createByteSmoother never exceeds the total and never regresses below downloaded", () => {
  const smooth = createByteSmoother();
  const tot = 1_000_000;
  const shown1 = smooth(500_000, tot);
  assert.ok(shown1 >= 500_000 && shown1 <= tot);
  const shown2 = smooth(900_000, tot);
  assert.ok(shown2 >= shown1);
  const done = smooth(1_000_000, tot);
  assert.equal(done, tot);
});

test("prefs fall back to the default snapshot when storage is empty or corrupt", () => {
  assert.deepEqual(prefs, { ...getDefaultPrefs(), inferEstimates: {} });

  store.set("openbgr_prefs", "{not json");
  // A fresh dynamic import re-reads storage; corrupt JSON must not throw.
  return import(`../static/state.js?corrupt=${Date.now()}`).then((mod) => {
    assert.equal(mod.prefs.theme, "dark");
    assert.equal(mod.prefs.defaultTier, "auto");
  });
});

test("stored preferences sanitize through the schema on load", async () => {
  store.set(
    "openbgr_prefs",
    JSON.stringify({ theme: "light", defaultTier: "bogus", qaFormat: "webp" })
  );
  const mod = await import(`../static/state.js?stored=${Date.now()}`);
  assert.equal(mod.prefs.theme, "light");
  assert.equal(mod.prefs.defaultTier, "auto");
  assert.equal(mod.prefs.qaFormat, "webp");
});

test("getTierDownloadText returns null for models with no active download", () => {
  assert.equal(getTierDownloadText("general"), null);
});

test("clearResultState resets every result, preview, and dimension field", () => {
  const blob = {};
  state.resultBlob = blob;
  state.refineJobId = 42;
  state.previewBlob = blob;
  state.previewSignature = "sig";
  state.previewSource = blob;
  state.resultObjectUrl = "blob:r";
  state.previewObjectUrl = "blob:p";
  state.naturalWidth = 800;
  state.naturalHeight = 600;
  state.exportWidth = 400;
  state.exportHeight = 300;

  clearResultState();

  for (const key of [
    "resultBlob",
    "refineJobId",
    "previewBlob",
    "previewSignature",
    "previewSource",
    "resultObjectUrl",
    "previewObjectUrl",
  ]) {
    assert.equal(state[key], null, `${key} should be null`);
  }
  for (const key of [
    "naturalWidth",
    "naturalHeight",
    "exportWidth",
    "exportHeight",
  ]) {
    assert.equal(state[key], 0, `${key} should be 0`);
  }
});

test("createTabRecord yields a well-formed image tab honoring overrides", () => {
  const a = createTabRecord();
  const b = createTabRecord({ name: "photo.png", kind: "batch" });
  assert.match(a.id, /^tab-\d+$/);
  assert.notEqual(a.id, b.id);
  assert.equal(b.name, "photo.png");
  assert.equal(b.kind, "batch");
  assert.equal(a.viewMode, "split");
  assert.equal(a.zoom, 1);
  assert.deepEqual(a.batchFiles, []);
  assert.equal(a.tier, state.tier);
  assert.equal(a.autoCrop, false);
  assert.equal(a.cropPadding, DEFAULT_CROP_PADDING);
  assert.equal(a.edgeShift, 0);
  assert.equal(a.edgeFeather, 0);
  assert.equal(a.activeBackdrop, state.activeBackdrop);
  assert.equal(a.backdropImg, state.backdropImg);
  assert.equal(a.backdropSeq, state.backdropSeq);
  assert.equal(a.backdropBlur, 50);
  assert.equal(a.aspectLocked, true);
  assert.equal(a.canvasFit, "fit");
  assert.equal(a.backdropColor, "#ffffff");
  assert.equal(a.exportCacheBlob, null);
});

test("defaultTierForNewTab prefers explicit pref, then recommended, then active", () => {
  const savedTier = prefs.defaultTier;
  const savedStatus = state.serverStatus;
  try {
    prefs.defaultTier = "hr";
    assert.equal(defaultTierForNewTab(), "hr");
    prefs.defaultTier = "auto";
    state.serverStatus = { recommended_tier: "lite" };
    assert.equal(defaultTierForNewTab(), "lite");
    state.serverStatus = null;
    assert.equal(defaultTierForNewTab(), state.tier);
  } finally {
    prefs.defaultTier = savedTier;
    state.serverStatus = savedStatus;
  }
});

/**
 * Node unit tests for static/anim-export.js: the debounced hidden encode
 * that lands an exact byte size on the FILE SIZE label before EXPORT and
 * warms the byte-exact export cache.
 *
 * Run with: node --test tests/
 */

import assert from "node:assert/strict";
import test from "node:test";
import { installDomShims } from "./dom-shim.mjs";

installDomShims();

const { state, dom, formatDiskBytes } = await import("../static/state.js");
const { setAnimatedExportBuilder, exactExportBlob } = await import(
  "../static/export.js"
);
const { scheduleAnimatedExportSize } = await import(
  "../static/anim-export.js"
);

function seedAnimated() {
  const cutout = new Blob([new Uint8Array(2048)], { type: "image/png" });
  state.isAnimated = true;
  state.frames = [
    {
      index: 0,
      durationMs: 100,
      resultBlob: cutout,
      sourceFile: null,
      originalObjectUrl: "blob:o0",
    },
    {
      index: 1,
      durationMs: 100,
      resultBlob: cutout,
      sourceFile: null,
      originalObjectUrl: "blob:o1",
    },
  ];
  state.currentFrameIndex = 0;
  state.startFrame = 1;
  state.endFrame = 2;
  state.resultBlob = cutout;
  state.exportFormat = "gif";
  state.isProcessing = false;
  state.exportWidth = 100;
  state.exportHeight = 100;
  state.shadowCutoff = 0;
  state.activeBackdrop = "checker";
  state.autoCrop = false;
  state.cropPadding = 0;
  state.canvasFit = "fit";
  state.exportCacheBlob = null;
  state.exportCacheSignature = null;
  state.exportCacheSource = null;
}

test("scheduleAnimatedExportSize encodes once and lands the exact size", async () => {
  seedAnimated();
  let calls = 0;
  const gifBlob = new Blob([new Uint8Array(4321)], { type: "image/gif" });
  setAnimatedExportBuilder(async () => {
    calls += 1;
    return gifBlob;
  });

  scheduleAnimatedExportSize();
  assert.equal(calls, 0, "the encode is debounced, not synchronous");
  await new Promise((resolve) => setTimeout(resolve, 1700));

  assert.equal(calls, 1);
  assert.equal(state.exportCacheBlob, gifBlob);
  assert.equal(
    dom.exportSizeLabel.textContent,
    formatDiskBytes(gifBlob.size)
  );
  assert.equal(exactExportBlob(), gifBlob, "EXPORT reuses the warm cache");
});

test("a burst of schedules collapses into a single encode", async () => {
  seedAnimated();
  let calls = 0;
  setAnimatedExportBuilder(async () => {
    calls += 1;
    return new Blob([new Uint8Array(100)], { type: "image/gif" });
  });

  scheduleAnimatedExportSize();
  scheduleAnimatedExportSize();
  scheduleAnimatedExportSize();
  await new Promise((resolve) => setTimeout(resolve, 1700));
  assert.equal(calls, 1);
});

test("scheduling is a no-op for still formats and mid-processing runs", async () => {
  seedAnimated();
  let calls = 0;
  setAnimatedExportBuilder(async () => {
    calls += 1;
    return new Blob(["x"]);
  });

  state.exportFormat = "png";
  scheduleAnimatedExportSize();

  state.exportFormat = "gif";
  state.isProcessing = true;
  scheduleAnimatedExportSize();
  await new Promise((resolve) => setTimeout(resolve, 1700));

  assert.equal(calls, 0);
  assert.equal(state.exportCacheBlob, null);
});

test("a failed hidden encode stores nothing and keeps the cache empty", async () => {
  seedAnimated();
  setAnimatedExportBuilder(async () => {
    throw new Error("Frame 2 is not processed yet.");
  });

  scheduleAnimatedExportSize();
  await new Promise((resolve) => setTimeout(resolve, 1700));

  assert.equal(state.exportCacheBlob, null);
  assert.equal(exactExportBlob(), null);
});

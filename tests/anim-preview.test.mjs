/**
 * Node unit tests for static/anim-preview.js: the background pass that
 * re-renders every processed frame's preview under the current export
 * settings, its signature-based skipping, and the schedule bus event.
 *
 * Run with: node --test tests/
 */

import assert from "node:assert/strict";
import test from "node:test";
import { installDomShims } from "./dom-shim.mjs";

installDomShims();

const { state, dom } = await import("../static/state.js");
const { on, emit } = await import("../static/bus.js");
const {
  initAnimatedPreviews,
  refreshAnimatedFramePreviews,
} = await import("../static/anim-preview.js");
const { expectedPreviewSignature } = await import("../static/export.js");

function reset() {
  state.isAnimated = true;
  state.frames = [];
  state.currentFrameIndex = 0;
  state.resultBlob = null;
  state.resultObjectUrl = null;
  state.previewBlob = null;
  state.previewObjectUrl = null;
  state.previewSignature = null;
  state.previewSource = null;
  state.naturalWidth = 100;
  state.naturalHeight = 80;
  state.exportWidth = 100;
  state.exportHeight = 80;
  state.exportScale = 1;
  state.autoCrop = false;
  state.cropPadding = 5;
  state.shadowCutoff = 0;
  state.activeBackdrop = "checker";
  state.backdropBlur = 50;
  state.exportFormat = "png";
  dom.afterImg.src = "";
}

test("refresh stamps previews on every processed frame and syncs the current one", async () => {
  reset();
  const blobA = new Blob(["a"], { type: "image/png" });
  const blobB = new Blob(["b"], { type: "image/png" });
  state.frames = [
    { resultBlob: blobA, resultObjectUrl: "blob:a", sourceFile: null },
    { resultBlob: null, resultObjectUrl: null, sourceFile: null },
    { resultBlob: blobB, resultObjectUrl: "blob:b", sourceFile: null },
  ];

  const updates = [];
  const off = on("animation:previews-updated", () => updates.push(1));
  await refreshAnimatedFramePreviews();

  const sig = expectedPreviewSignature();
  // Passthrough (checker, no cutoff): preview is the cutout itself.
  assert.equal(state.frames[0].previewSignature, sig);
  assert.equal(state.frames[0].previewObjectUrl, "blob:a");
  assert.equal(state.frames[0].previewBlob, blobA);
  // Unprocessed frames are skipped entirely.
  assert.equal(state.frames[1].previewSignature, undefined);
  assert.equal(state.frames[2].previewSignature, sig);
  // The current frame's preview is mirrored into shared state and the stage.
  assert.equal(state.previewObjectUrl, "blob:a");
  assert.equal(state.previewSource, blobA);
  assert.equal(dom.afterImg.src, "blob:a");
  assert.equal(updates.length, 1);

  // A second pass with unchanged signatures renders and emits nothing.
  await refreshAnimatedFramePreviews();
  assert.equal(updates.length, 1);
  off();
});

test("schedule event triggers a debounced refresh only for animated tabs", async () => {
  reset();
  initAnimatedPreviews();
  state.frames = [
    {
      resultBlob: new Blob(["a"], { type: "image/png" }),
      resultObjectUrl: "blob:a",
      sourceFile: null,
    },
    {
      resultBlob: new Blob(["b"], { type: "image/png" }),
      resultObjectUrl: "blob:b",
      sourceFile: null,
    },
  ];

  state.isAnimated = false;
  emit("animation:previews-scheduled");
  await new Promise((r) => setTimeout(r, 220));
  assert.equal(state.frames[0].previewSignature, undefined);

  state.isAnimated = true;
  emit("animation:previews-scheduled");
  await new Promise((r) => setTimeout(r, 220));
  assert.equal(state.frames[0].previewSignature, expectedPreviewSignature());
  assert.equal(state.frames[1].previewSignature, expectedPreviewSignature());
});

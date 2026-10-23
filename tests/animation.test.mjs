/**
 * Node unit tests for static/animation.js: frame extraction probing,
 * filmstrip rendering, frame selection, step back/forward, play/pause,
 * and start/end frame trim clamping.
 *
 * Run with: node --test tests/
 */

import assert from "node:assert/strict";
import test from "node:test";
import { installDomShims } from "./dom-shim.mjs";
import { wireRealTabOps } from "./workspace-deps.mjs";

installDomShims();
await wireRealTabOps();

const { state, dom, createTabRecord } = await import("../static/state.js");
const {
  isPotentiallyAnimatedFile,
  resetAnimationState,
  renderAnimationFilmstrip,
  selectAnimationFrame,
  stepAnimationFrame,
  startAnimationPlayback,
  stopAnimationPlayback,
  toggleAnimationPlayback,
  setAnimationTrimRange,
  probeAndLoadAnimationFrames,
  initAnimation,
} = await import("../static/animation.js");

initAnimation();

test("isPotentiallyAnimatedFile matches GIF and WebP by MIME or extension", () => {
  assert.equal(isPotentiallyAnimatedFile(null), false);
  assert.equal(
    isPotentiallyAnimatedFile({ name: "photo.png", type: "image/png" }),
    false
  );
  assert.equal(
    isPotentiallyAnimatedFile({ name: "clip.gif", type: "image/gif" }),
    true
  );
  assert.equal(
    isPotentiallyAnimatedFile({ name: "ANIM.WEBP", type: "" }),
    true
  );
});

test("probeAndLoadAnimationFrames populates frames, filmstrip, and default GIF format", async () => {
  resetAnimationState();
  const fakeFile = new File(["gif"], "dance.gif", { type: "image/gif" });
  const tab = createTabRecord({
    id: "tab-anim-1",
    name: "dance.gif",
    sourceFile: fakeFile,
    exportFormat: "png",
  });
  state.tabs = [tab];
  state.activeTabId = tab.id;
  state.sourceFile = fakeFile;
  state.exportFormat = "png";

  globalThis.fetch = async (url) => {
    if (String(url).includes("/api/extract-frames")) {
      return {
        ok: true,
        json: async () => ({
          animated: true,
          width: 32,
          height: 24,
          frame_count: 4,
          total_frames: 4,
          truncated: false,
          frames: [
            { index: 0, duration_ms: 60, data_b64: btoa("f0") },
            { index: 1, duration_ms: 80, data_b64: btoa("f1") },
            { index: 2, duration_ms: 90, data_b64: btoa("f2") },
            { index: 3, duration_ms: 100, data_b64: btoa("f3") },
          ],
        }),
      };
    }
    return { ok: true, json: async () => ({}) };
  };

  const ok = await probeAndLoadAnimationFrames(fakeFile, tab.id);
  assert.equal(ok, true);
  assert.equal(state.isAnimated, true);
  assert.equal(state.frames.length, 4);
  assert.equal(state.startFrame, 1);
  assert.equal(state.endFrame, 4);
  assert.equal(state.exportFormat, "gif");
  assert.equal(dom.appShell.classList.contains("is-animated"), true);
  assert.equal(
    dom.animFilmstrip.querySelectorAll(".anim-frame-item").length,
    4
  );
  assert.equal(dom.animFrameReadout.textContent, "FRAME 1 / 4");
  assert.equal(dom.animTrimReadout.textContent, "");
});

test("selectAnimationFrame, stepAnimationFrame, and setAnimationTrimRange update state and filmstrip", () => {
  selectAnimationFrame(2);
  assert.equal(state.currentFrameIndex, 2);
  assert.equal(dom.animFrameReadout.textContent, "FRAME 3 / 4");

  // Trim to frames 2..3; stepping wraps within the trimmed range.
  setAnimationTrimRange(2, 3);
  assert.equal(state.startFrame, 2);
  assert.equal(state.endFrame, 3);
  assert.equal(dom.animTrimReadout.textContent, "(TRIMMED TO 2-3)");
  const items = dom.animFilmstrip.querySelectorAll(".anim-frame-item");
  assert.equal(items[0].classList.contains("trimmed"), true);
  assert.equal(items[1].classList.contains("trimmed"), false);
  assert.equal(items[2].classList.contains("trimmed"), false);
  assert.equal(items[3].classList.contains("trimmed"), true);

  stepAnimationFrame(1);
  assert.equal(state.currentFrameIndex, 1, "wraps from frame 3 (idx 2) back to frame 2 (idx 1)");
  stepAnimationFrame(-1);
  assert.equal(state.currentFrameIndex, 2, "wraps backward from frame 2 (idx 1) to frame 3 (idx 2)");

  // Once processed, FILE SIZE shows a pending readout (the exact GIF size
  // needs a real encode) and never a frame count.
  const fakeCutout = new Blob([new Uint8Array(40960)], { type: "image/png" });
  state.frames.forEach((f) => {
    f.resultBlob = fakeCutout;
  });
  state.resultBlob = fakeCutout;
  setAnimationTrimRange(2, 3);
  assert.equal(state.exportSizeLabel !== null, true);
  assert.equal(dom.exportSizeLabel.textContent, "...");
  assert.doesNotMatch(dom.exportSizeLabel.textContent, /FRAME/);

  // Entering an end frame beyond the max replaces the input value with the max frame.
  dom.animEndFrameInput.value = "99";
  setAnimationTrimRange(undefined, "99");
  assert.equal(state.endFrame, 4);
  assert.equal(dom.animEndFrameInput.value, "4");
});

test("trim stepper buttons increment and decrement within clamped bounds", () => {
  setAnimationTrimRange(1, 3);

  dom.animEndFrameUp.click();
  assert.equal(state.endFrame, 4);
  assert.equal(dom.animEndFrameInput.value, "4");
  dom.animEndFrameUp.click();
  assert.equal(state.endFrame, 4, "end frame clamps at the frame count");
  dom.animEndFrameDown.click();
  assert.equal(state.endFrame, 3);
  assert.equal(dom.animEndFrameInput.value, "3");

  setAnimationTrimRange(2, 4);
  dom.animStartFrameDown.click();
  assert.equal(state.startFrame, 1);
  assert.equal(dom.animStartFrameInput.value, "1");
  dom.animStartFrameDown.click();
  assert.equal(state.startFrame, 1, "start frame clamps at 1");
  dom.animStartFrameUp.click();
  assert.equal(state.startFrame, 2);
  assert.equal(dom.animStartFrameInput.value, "2");
});

test("toggleAnimationPlayback starts and stops the playback timer cleanly", () => {
  assert.equal(state.animPlaying, false);
  toggleAnimationPlayback();
  assert.equal(state.animPlaying, true);
  assert.equal(dom.btnAnimPlay.classList.contains("active"), true);
  assert.match(dom.btnAnimPlay.innerHTML, />PAUSE</);

  startAnimationPlayback();
  assert.equal(state.animPlaying, true);
  stopAnimationPlayback();
  assert.equal(state.animPlaying, false);
  assert.equal(dom.btnAnimPlay.classList.contains("active"), false);
  assert.match(dom.btnAnimPlay.innerHTML, />PLAY</);

  resetAnimationState();
  assert.equal(state.isAnimated, false);
  assert.equal(dom.appShell.classList.contains("is-animated"), false);
});

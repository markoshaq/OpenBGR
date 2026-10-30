/**
 * Animated preview maintenance: when export settings change, re-renders every
 * processed frame's stage preview in the background so backdrop, cutoff, and
 * dimension changes apply to the whole animation instead of only the selected
 * frame. Triggered by the "animation:previews-scheduled" bus event (export.js
 * emits it from `updateLiveStagePreview`); emits "animation:previews-updated"
 * after frames change so animation.js can repaint the filmstrip.
 * Importing this module has no side effects; animation.js calls
 * `initAnimatedPreviews()` from `initAnimation()`.
 */

import {
  state,
  dom,
  masterCutoutImg,
  resolveFileBackdropSource,
} from "./state.js";
import { emit, on } from "./bus.js";
import {
  renderExportBlob,
  expectedPreviewSignature,
  previewNeedsRender,
  previewTargetSize,
  exportAspectMismatch,
  unionTrimmedFrameBox,
} from "./export.js";
import { warmBlobAlphaBBox } from "./alpha-bbox.js";
import { updateCropGuide } from "./export-ui.js";

// A generation counter retires in-flight refresh passes when settings change
// mid-pass, so a stale render never overwrites a newer signature.
let animPreviewTimer = null;
let animPreviewEpoch = 0;

/**
 * Debounced pass over the active tab's frames. Frames whose
 * `previewSignature` already matches are skipped, so schedules landing during
 * frame scrubbing cost a cheap loop and no renders.
 */
function scheduleAnimatedPreviewRefresh() {
  if (!state.isAnimated || state.frames.length <= 1) return;
  clearTimeout(animPreviewTimer);
  animPreviewTimer = setTimeout(() => {
    refreshAnimatedFramePreviews();
  }, 150);
}

/** Re-renders stale per-frame previews under the current export settings. */
export async function refreshAnimatedFramePreviews() {
  const epoch = ++animPreviewEpoch;
  const framesRef = state.frames;
  const sig = expectedPreviewSignature();
  const noRender = !previewNeedsRender();
  const srcW = state.naturalWidth || masterCutoutImg.naturalWidth;
  const srcH = state.naturalHeight || masterCutoutImg.naturalHeight;
  const { w, h } = previewTargetSize();
  const applyCrop = state.autoCrop && exportAspectMismatch();
  const previewFmt = state.exportFormat === "gif" ? "png" : state.exportFormat;
  let touched = false;

  // Warm every processed frame's alpha box up front so the union crop box is
  // complete before any frame renders: the animated export keeps the union,
  // so per-frame previews must share its framing, not each frame's own box.
  if (state.autoCrop) {
    for (let i = 0; i < framesRef.length; i++) {
      if (
        epoch !== animPreviewEpoch ||
        state.frames !== framesRef ||
        !state.isAnimated
      ) {
        return;
      }
      const frame = framesRef[i];
      if (!frame?.resultBlob) continue;
      await warmBlobAlphaBBox(
        frame.resultBlob,
        srcW,
        srcH,
        state.shadowCutoff
      );
    }
  }
  const unionBox = state.autoCrop
    ? unionTrimmedFrameBox(srcW, srcH)
    : null;

  for (let i = 0; i < framesRef.length; i++) {
    // Aborted by a newer refresh, a tab switch, or an animation reset.
    if (
      epoch !== animPreviewEpoch ||
      state.frames !== framesRef ||
      !state.isAnimated
    ) {
      return;
    }
    const frame = framesRef[i];
    if (!frame?.resultBlob) continue;
    if (frame.previewSignature === sig) continue;

    let blob = frame.resultBlob;
    if (!noRender) {
      const bmp = await createImageBitmap(frame.resultBlob);
      let bgBmp = null;
      try {
        const resolvedBackdrop = await resolveFileBackdropSource(
          state.activeBackdrop,
          frame.sourceFile,
          state.backdropImg
        );
        bgBmp = resolvedBackdrop.ownedBitmap;
        blob = await renderExportBlob(bmp, srcW, srcH, {
          format: previewFmt,
          targetW: w,
          targetH: h,
          shadowCutoff: state.shadowCutoff,
          backdrop: state.activeBackdrop,
          backdropSource: resolvedBackdrop.backdropSource,
          backdropBlur: state.backdropBlur,
          autoCrop: applyCrop,
          cropPadding: applyCrop ? state.cropPadding : 0,
          cropBox: unionBox,
          canvasFit: state.canvasFit,
        });
      } finally {
        bmp.close?.();
        bgBmp?.close?.();
      }
      if (epoch !== animPreviewEpoch || state.frames !== framesRef) return;
    }

    if (
      frame.previewObjectUrl &&
      frame.previewObjectUrl !== frame.resultObjectUrl
    ) {
      URL.revokeObjectURL(frame.previewObjectUrl);
    }
    frame.previewBlob = blob;
    frame.previewSignature = sig;
    frame.previewObjectUrl =
      blob === frame.resultBlob
        ? frame.resultObjectUrl
        : URL.createObjectURL(blob);
    touched = true;

    if (i === state.currentFrameIndex) {
      if (
        state.previewObjectUrl &&
        state.previewObjectUrl !== state.resultObjectUrl
      ) {
        URL.revokeObjectURL(state.previewObjectUrl);
      }
      state.previewBlob = blob;
      state.previewSignature = sig;
      state.previewSource = frame.resultBlob;
      state.previewObjectUrl = frame.previewObjectUrl;
      dom.afterImg.src = frame.previewObjectUrl;
    }
  }
  if (state.autoCrop) updateCropGuide();
  // animation.js owns the filmstrip; the bus keeps the import graph acyclic.
  if (touched) emit("animation:previews-updated");
}

/** Subscribes the schedule listener; called once from `initAnimation()`. */
export function initAnimatedPreviews() {
  on("animation:previews-scheduled", scheduleAnimatedPreviewRefresh);
}

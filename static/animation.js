/**
 * Multi-frame animation (GIF / animated WebP) support: frame extraction via
 * `/api/extract-frames`, the horizontal thumbnail filmstrip, the playback bar
 * (Play/Pause, step back/forward, Space/Arrow hotkeys), and start/end frame
 * trim controls.
 * Importing this module has no side effects; app.js calls `initAnimation()`.
 */

import {
  state,
  dom,
  apiFetch,
  base64ToBlob,
  masterCutoutImg,
  saveStateToActiveTab,
  setError,
} from "./state.js";
import {
  updateLiveStagePreview,
  setAnimatedExportBuilder,
  expectedPreviewSignature,
  getExportBaseDims,
} from "./export.js";
import {
  updateExportTelemetry,
  updateCropGuide,
  syncFormatButtons,
} from "./export-ui.js";
import { buildAnimatedExportBlob } from "./export-io.js";
import { initAnimatedPreviews } from "./anim-preview.js";
import { on } from "./bus.js";

const ANIM_EXT_RE = /\.(gif|webp)$/i;
const ICON_PLAY =
  '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3.5 2v8l5.5-4z"/></svg>';
const ICON_PAUSE =
  '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3.5 2h1.9v8H3.5zM6.6 2h1.9v8H6.6z"/></svg>';
let playTimer = null;

/** Swaps the play/pause glyph + label on the dock play button. */
function setAnimPlayButton(playing) {
  if (!dom.btnAnimPlay) return;
  dom.btnAnimPlay.classList.toggle("active", playing);
  dom.btnAnimPlay.innerHTML = `${playing ? ICON_PAUSE : ICON_PLAY}<span>${playing ? "PAUSE" : "PLAY"}</span>`;
}

/** True when `file` could be a multi-frame animation (GIF or WebP). */
export function isPotentiallyAnimatedFile(file) {
  if (!file) return false;
  const type = (file.type || "").toLowerCase();
  return (
    type === "image/gif" ||
    type === "image/webp" ||
    ANIM_EXT_RE.test(file.name || "")
  );
}

/** Stops the frame playback timer if running and syncs the Play/Pause button. */
export function stopAnimationPlayback() {
  if (playTimer) {
    clearTimeout(playTimer);
    playTimer = null;
  }
  state.animPlaying = false;
  setAnimPlayButton(false);
}

/** Clears animation state on workspace reset or static-image ingest. */
export function resetAnimationState() {
  stopAnimationPlayback();
  state.isAnimated = false;
  state.frames = [];
  state.currentFrameIndex = 0;
  state.startFrame = 1;
  state.endFrame = 1;
  dom.animFilmstrip?.replaceChildren();
  syncAnimationChrome();
}

/** Syncs `.is-animated` shell visibility, trim inputs, and playback readouts. */
export function syncAnimationChrome() {
  const active = Boolean(state.isAnimated && state.frames.length > 1);
  dom.appShell?.classList.toggle("is-animated", active);
  if (dom.btnProcess) {
    dom.btnProcess.textContent = active ? "PROCESS GIF" : "PROCESS IMAGE";
  }
  if (!active) return;

  const total = state.frames.length;
  const start = Math.max(1, Math.min(total, state.startFrame || 1));
  const end = Math.max(start, Math.min(total, state.endFrame || total));
  state.startFrame = start;
  state.endFrame = end;

  if (dom.animFrameReadout) {
    const cur = Math.min(total, Math.max(1, state.currentFrameIndex + 1));
    dom.animFrameReadout.textContent = `FRAME ${cur} / ${total}`;
  }
  if (dom.animTrimReadout) {
    dom.animTrimReadout.textContent =
      start === 1 && end === total ? "" : `(TRIMMED TO ${start}-${end})`;
  }
  if (
    dom.animStartFrameInput &&
    document.activeElement !== dom.animStartFrameInput
  ) {
    dom.animStartFrameInput.max = String(total);
    dom.animStartFrameInput.value = String(start);
  }
  if (
    dom.animEndFrameInput &&
    document.activeElement !== dom.animEndFrameInput
  ) {
    dom.animEndFrameInput.max = String(total);
    dom.animEndFrameInput.value = String(end);
  }
  setAnimPlayButton(state.animPlaying);
}

/** Updates `.active`, `.trimmed`, and thumbnail URLs on the filmstrip items. */
export function syncFilmstripSelection(scrollIntoView = true) {
  if (!dom.animFilmstrip || !state.isAnimated) return;
  const items = dom.animFilmstrip.querySelectorAll(".anim-frame-item");
  let activeEl = null;
  items.forEach((el) => {
    const idx = parseInt(el.getAttribute("data-frame-index") || "0", 10);
    const frame = state.frames[idx];
    const isCurrent = idx === state.currentFrameIndex;
    const frameNum = idx + 1;
    const isTrimmed =
      frameNum < state.startFrame || frameNum > state.endFrame;
    el.classList.toggle("active", isCurrent);
    el.classList.toggle("trimmed", isTrimmed);
    el.setAttribute("aria-selected", isCurrent ? "true" : "false");
    const img = el.querySelector(".anim-frame-thumb");
    const wantSrc =
      frame?.previewObjectUrl ||
      frame?.resultObjectUrl ||
      frame?.originalObjectUrl ||
      "";
    if (img && wantSrc && img.getAttribute("src") !== wantSrc) {
      img.setAttribute("src", wantSrc);
    }
    if (isCurrent) activeEl = el;
  });
  if (scrollIntoView && activeEl?.scrollIntoView) {
    activeEl.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  syncAnimationChrome();
}

/** Renders the horizontal scrollable filmstrip of frame thumbnails + numbers. */
export function renderAnimationFilmstrip() {
  if (!dom.animFilmstrip) return;
  dom.animFilmstrip.replaceChildren();
  if (!state.isAnimated || state.frames.length <= 1) {
    syncAnimationChrome();
    return;
  }

  state.frames.forEach((frame, idx) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "anim-frame-item";
    btn.setAttribute("data-frame-index", String(idx));
    btn.setAttribute("role", "option");
    btn.setAttribute(
      "aria-selected",
      idx === state.currentFrameIndex ? "true" : "false"
    );
    btn.title = `Frame ${idx + 1} (${frame.durationMs} ms)`;

    const thumbWrap = document.createElement("div");
    thumbWrap.className = "anim-frame-thumb-wrap checkerboard-canvas";
    const img = document.createElement("img");
    img.className = "anim-frame-thumb";
    img.alt = `Frame ${idx + 1}`;
    img.src =
      frame.previewObjectUrl ||
      frame.resultObjectUrl ||
      frame.originalObjectUrl;
    thumbWrap.appendChild(img);

    const num = document.createElement("span");
    num.className = "anim-frame-num";
    num.textContent = String(idx + 1);

    btn.appendChild(thumbWrap);
    btn.appendChild(num);
    btn.addEventListener("click", () => {
      stopAnimationPlayback();
      selectAnimationFrame(idx);
    });
    dom.animFilmstrip.appendChild(btn);
  });

  syncFilmstripSelection(true);
}

/**
 * Switches the viewer to frame `index` (0-based), mirroring its source and
 * cutout blobs onto `state` so the stage, split slider, loupe, and backdrop
 * preview operate on that frame.
 */
export function selectAnimationFrame(index, opts = {}) {
  if (!state.isAnimated || state.frames.length === 0) return;
  const total = state.frames.length;
  const clamped = Math.max(0, Math.min(total - 1, index | 0));

  const prev = state.frames[state.currentFrameIndex];
  if (prev && state.currentFrameIndex !== clamped) {
    prev.resultBlob = state.resultBlob;
    prev.resultObjectUrl = state.resultObjectUrl;
    // Only carry the shared preview when it was rendered from prev's own
    // result; a render that landed mid-switch belongs to another frame.
    if (state.previewSource === state.resultBlob) {
      prev.previewBlob = state.previewBlob;
      prev.previewObjectUrl = state.previewObjectUrl;
      prev.previewSignature = state.previewSignature;
    }
    prev.refineJobId = state.refineJobId;
  }

  state.currentFrameIndex = clamped;
  const frame = state.frames[clamped];
  if (!frame) return;

  // A preview rendered under older export settings must not leak back into
  // view; the background refresh pass re-renders it under current settings.
  const previewFresh = Boolean(
    frame.previewSignature &&
      frame.previewSignature === expectedPreviewSignature()
  );

  state.originalObjectUrl = frame.originalObjectUrl;
  state.resultBlob = frame.resultBlob || null;
  state.resultObjectUrl = frame.resultObjectUrl || null;
  state.previewBlob = previewFresh ? frame.previewBlob || null : null;
  state.previewObjectUrl = previewFresh ? frame.previewObjectUrl || null : null;
  state.previewSignature = previewFresh ? frame.previewSignature : null;
  state.previewSource = previewFresh ? frame.resultBlob : null;
  state.refineJobId = frame.refineJobId || null;

  dom.stageSizerImg.src = frame.originalObjectUrl;
  dom.beforeImg.src = frame.originalObjectUrl;

  if (frame.resultBlob && frame.resultObjectUrl) {
    const wantUrl = frame.resultObjectUrl;
    masterCutoutImg.onload = () => {
      if (state.currentFrameIndex !== clamped) return;
      updateCropGuide();
      if (!state.animPlaying) updateLiveStagePreview();
    };
    masterCutoutImg.src = wantUrl;
    dom.afterImg.src = state.previewObjectUrl || frame.resultObjectUrl;
    dom.appShell?.classList.remove("no-result");
    dom.btnDownload?.classList.remove("disabled");
    dom.btnCopy?.classList.remove("disabled");
    if (state.autoCrop && state.aspectLocked && state.naturalWidth > 0) {
      const baseDims = getExportBaseDims();
      state.exportWidth = Math.max(
        1,
        Math.round(baseDims.w * state.exportScale)
      );
      state.exportHeight = Math.max(
        1,
        Math.round(baseDims.h * state.exportScale)
      );
      if (document.activeElement !== dom.exportWidthInput) {
        dom.exportWidthInput.value = String(state.exportWidth);
      }
      if (document.activeElement !== dom.exportHeightInput) {
        dom.exportHeightInput.value = String(state.exportHeight);
      }
      const pct = Math.round(state.exportScale * 100);
      dom.statDim.textContent =
        pct === 100
          ? `${state.exportWidth}x${state.exportHeight} PX`
          : `${state.exportWidth}x${state.exportHeight} PX (${pct}%)`;
    }
    updateCropGuide();
    if (!opts.fromPlayback) {
      updateLiveStagePreview();
    }
  } else {
    dom.afterImg.src = frame.originalObjectUrl;
    updateCropGuide();
  }

  syncFilmstripSelection(opts.scrollIntoView !== false);
  saveStateToActiveTab();
}

/** Steps one frame backward (`delta = -1`) or forward (`delta = 1`), pausing playback. */
export function stepAnimationFrame(delta) {
  if (!state.isAnimated || state.frames.length <= 1) return;
  stopAnimationPlayback();
  const minIdx = Math.max(0, (state.startFrame || 1) - 1);
  const maxIdx = Math.min(
    state.frames.length - 1,
    (state.endFrame || state.frames.length) - 1
  );
  const span = Math.max(1, maxIdx - minIdx + 1);
  const offset =
    (((state.currentFrameIndex - minIdx + delta) % span) + span) % span;
  selectAnimationFrame(minIdx + offset);
}

/** Starts looping playback across the trimmed `[startFrame, endFrame]` range. */
export function startAnimationPlayback() {
  if (!state.isAnimated || state.frames.length <= 1) return;
  stopAnimationPlayback();
  state.animPlaying = true;
  syncAnimationChrome();

  const tick = () => {
    if (!state.animPlaying || !state.isAnimated || state.frames.length <= 1) {
      stopAnimationPlayback();
      return;
    }
    const minIdx = Math.max(0, (state.startFrame || 1) - 1);
    const maxIdx = Math.min(
      state.frames.length - 1,
      (state.endFrame || state.frames.length) - 1
    );
    let nextIdx = state.currentFrameIndex + 1;
    if (nextIdx < minIdx || nextIdx > maxIdx) {
      nextIdx = minIdx;
    }
    selectAnimationFrame(nextIdx, { fromPlayback: true, scrollIntoView: true });
    const delay = Math.max(
      20,
      Number(state.frames[nextIdx]?.durationMs) || 100
    );
    playTimer = setTimeout(tick, delay);
  };

  const currentDelay = Math.max(
    20,
    Number(state.frames[state.currentFrameIndex]?.durationMs) || 100
  );
  playTimer = setTimeout(tick, currentDelay);
}

/** Toggles animation playback on/off. */
export function toggleAnimationPlayback() {
  if (!state.isAnimated || state.frames.length <= 1 || state.isProcessing) {
    return;
  }
  if (state.animPlaying) {
    stopAnimationPlayback();
  } else {
    startAnimationPlayback();
  }
}

/** Updates `[startFrame, endFrame]` (1-based, inclusive) and refreshes trim UI. */
export function setAnimationTrimRange(startVal, endVal) {
  if (!state.isAnimated || state.frames.length <= 1) return;
  const total = state.frames.length;
  const rawStart = parseInt(String(startVal ?? state.startFrame), 10);
  const rawEnd = parseInt(String(endVal ?? state.endFrame), 10);
  let start = !Number.isFinite(rawStart) || rawStart < 1 ? 1 : rawStart;
  let end = !Number.isFinite(rawEnd) || rawEnd < 1 ? total : rawEnd;
  start = Math.max(1, Math.min(total, start));
  end = Math.max(1, Math.min(total, end));
  if (start > end) {
    if (startVal !== undefined && endVal === undefined) {
      end = start;
    } else {
      start = end;
    }
  }
  state.startFrame = start;
  state.endFrame = end;
  if (dom.animStartFrameInput && rawStart > total) {
    dom.animStartFrameInput.value = String(start);
  }
  if (dom.animEndFrameInput && rawEnd > total) {
    dom.animEndFrameInput.value = String(end);
  }
  state.exportCacheBlob = null;
  state.exportCacheSignature = null;

  const curNum = state.currentFrameIndex + 1;
  if (curNum < start) {
    selectAnimationFrame(start - 1);
  } else if (curNum > end) {
    selectAnimationFrame(end - 1);
  } else {
    syncFilmstripSelection(false);
    saveStateToActiveTab();
  }
  updateExportTelemetry();
}

/**
 * Sends a newly ingested GIF/WebP to `/api/extract-frames`; when it contains
 * multiple frames, populates the tab's frame strip and playback controls.
 */
export async function probeAndLoadAnimationFrames(file, tabId) {
  if (!isPotentiallyAnimatedFile(file)) return false;
  try {
    const fd = new FormData();
    fd.append("file", file);
    const res = await apiFetch("/api/extract-frames", {
      method: "POST",
      body: fd,
    });
    if (!res.ok) return false;
    const payload = await res.json();
    if (!payload?.animated || !Array.isArray(payload.frames) || payload.frames.length <= 1) {
      return false;
    }

    const tab = state.tabs.find((t) => t.id === tabId);
    if (!tab || tab.sourceFile !== file) return false;

    const baseStem = (file.name || "animation").replace(/\.[^/.]+$/, "");
    const frames = payload.frames.map((entry, idx) => {
      const pngBlob = base64ToBlob(entry.data_b64);
      const frameFile = new File([pngBlob], `${baseStem}-frame-${idx + 1}.png`, {
        type: "image/png",
      });
      return {
        index: idx,
        durationMs: Number(entry.duration_ms) || 100,
        sourceFile: frameFile,
        originalObjectUrl: URL.createObjectURL(frameFile),
        resultBlob: null,
        resultObjectUrl: null,
        previewBlob: null,
        previewObjectUrl: null,
        previewSignature: null,
        refineJobId: null,
      };
    });

    const animFormat = "gif";

    tab.isAnimated = true;
    tab.frames = frames;
    tab.currentFrameIndex = 0;
    tab.startFrame = 1;
    tab.endFrame = frames.length;
    if (tab.exportFormat === "png") {
      tab.exportFormat = animFormat;
    }

    if (state.activeTabId === tabId) {
      state.isAnimated = true;
      state.frames = frames;
      state.currentFrameIndex = 0;
      state.startFrame = 1;
      state.endFrame = frames.length;
      if (state.exportFormat === "png") {
        state.exportFormat = animFormat;
        syncFormatButtons();
      }
      renderAnimationFilmstrip();
      selectAnimationFrame(0, { scrollIntoView: false });
      updateExportTelemetry();
      if (payload.truncated) {
        setError(
          `Animation has ${payload.total_frames} frames; loaded the first ${frames.length} frames.`
        );
      }
    }
    return true;
  } catch (_) {
    return false;
  }
}

/** Nudges a trim field by `delta`, clamping through the normal trim path. */
function stepTrimInput(which, delta) {
  const isStart = which === "start";
  if (isStart) {
    setAnimationTrimRange(state.startFrame + delta, undefined);
    if (dom.animStartFrameInput) {
      dom.animStartFrameInput.value = String(state.startFrame);
    }
  } else {
    setAnimationTrimRange(undefined, state.endFrame + delta);
    if (dom.animEndFrameInput) {
      dom.animEndFrameInput.value = String(state.endFrame);
    }
  }
}

/** Wires the playback bar buttons and the start/end frame trim inputs. */
export function initAnimation() {
  setAnimatedExportBuilder(buildAnimatedExportBlob);
  initAnimatedPreviews();
  dom.btnAnimPrev?.addEventListener("click", () => stepAnimationFrame(-1));
  dom.btnAnimNext?.addEventListener("click", () => stepAnimationFrame(1));
  dom.btnAnimPlay?.addEventListener("click", () => toggleAnimationPlayback());

  dom.animStartFrameUp?.addEventListener("click", () =>
    stepTrimInput("start", 1)
  );
  dom.animStartFrameDown?.addEventListener("click", () =>
    stepTrimInput("start", -1)
  );
  dom.animEndFrameUp?.addEventListener("click", () =>
    stepTrimInput("end", 1)
  );
  dom.animEndFrameDown?.addEventListener("click", () =>
    stepTrimInput("end", -1)
  );

  dom.animStartFrameInput?.addEventListener("input", (e) => {
    setAnimationTrimRange(e.target.value, undefined);
  });
  dom.animStartFrameInput?.addEventListener("change", (e) => {
    setAnimationTrimRange(e.target.value, undefined);
    if (dom.animStartFrameInput) {
      dom.animStartFrameInput.value = String(state.startFrame);
    }
  });
  dom.animStartFrameInput?.addEventListener("blur", () => {
    if (dom.animStartFrameInput) {
      dom.animStartFrameInput.value = String(state.startFrame);
    }
  });
  dom.animEndFrameInput?.addEventListener("input", (e) => {
    setAnimationTrimRange(undefined, e.target.value);
  });
  dom.animEndFrameInput?.addEventListener("change", (e) => {
    setAnimationTrimRange(undefined, e.target.value);
    if (dom.animEndFrameInput) {
      dom.animEndFrameInput.value = String(state.endFrame);
    }
  });
  dom.animEndFrameInput?.addEventListener("blur", () => {
    if (dom.animEndFrameInput) {
      dom.animEndFrameInput.value = String(state.endFrame);
    }
  });

  // export.js re-renders per-frame previews in the background; re-paint the
  // thumbnails once that pass lands.
  on("animation:previews-updated", () => syncFilmstripSelection(false));
}

/**
 * Interactive stage viewport: split-plane comparison geometry, pan/zoom
 * transforms, and the 4x circular magnifier loupe.
 */

import { state, dom } from "./state.js";

/** Applies `max-width`/`max-height` constraints so the stage image fits the viewport. */
export function renderStageGeometry() {
  if (state.viewMode === "split") {
    dom.beforeClip.style.display = "block";
    dom.splitLine.style.display = "block";
    dom.lblLeft.style.display = "block";
    dom.lblRight.style.display = "block";
    dom.beforeClip.style.clipPath = `inset(0 ${100 - state.splitPercent}% 0 0)`;
    dom.splitLine.style.left = `${state.splitPercent}%`;
  } else if (state.viewMode === "cutout") {
    dom.beforeClip.style.display = "none";
    dom.splitLine.style.display = "none";
    dom.lblLeft.style.display = "none";
    dom.lblRight.style.display = "block";
  } else {
    dom.beforeClip.style.display = "block";
    dom.beforeClip.style.clipPath = "inset(0 0 0 0)";
    dom.splitLine.style.display = "none";
    dom.lblLeft.style.display = "block";
    dom.lblRight.style.display = "none";
  }
}

/** Writes `state.zoom`/`state.pan` onto the stage transform and updates the zoom readout. */
export function applyZoomTransform() {
  if (!dom.stage) return;
  if (state.zoom <= 1) {
    state.zoom = 1;
    state.panX = 0;
    state.panY = 0;
  }
  dom.stage.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
  if (dom.btnZoomReset) {
    dom.btnZoomReset.textContent = `${Math.round(state.zoom * 100)}%`;
  }
}

/** Clamps and applies a new zoom level, keeping the stage centered. */
export function setZoom(newZoom) {
  state.zoom = Math.max(1, Math.min(8, newZoom));
  applyZoomTransform();
}

let loupeCheckerPattern = null;
let loupeCheckerIsLight = null;

/**
 * Builds (and caches) the checkerboard tile pattern painted under the loupe.
 * Rebuilt only when the theme flips, so mousemove does not pay for
 * `getComputedStyle` plus hundreds of `fillRect`s on every event.
 */
function getLoupeCheckerPattern(ctx) {
  const isLight = document.documentElement.classList.contains("theme-light");
  if (loupeCheckerPattern && loupeCheckerIsLight === isLight) {
    return loupeCheckerPattern;
  }
  const cs = getComputedStyle(document.documentElement);
  const a = cs.getPropertyValue("--checker-a").trim() || "#16161a";
  const b = cs.getPropertyValue("--checker-b").trim() || "#0e0e11";
  const tile = document.createElement("canvas");
  tile.width = 20;
  tile.height = 20;
  const tctx = tile.getContext("2d");
  tctx.fillStyle = a;
  tctx.fillRect(0, 0, 10, 10);
  tctx.fillRect(10, 10, 10, 10);
  tctx.fillStyle = b;
  tctx.fillRect(10, 0, 10, 10);
  tctx.fillRect(0, 10, 10, 10);
  loupeCheckerIsLight = isLight;
  loupeCheckerPattern = ctx.createPattern(tile, "repeat");
  return loupeCheckerPattern;
}

/** Draws the 4x circular magnifier at the pointer, sampling the correct stage layer. */
export function renderLoupeAtPointer(clientX, clientY) {
  if (!state.loupeEnabled || !state.sourceFile || !dom.loupeCanvas) {
    dom.loupeCanvas?.classList.remove("visible");
    return;
  }

  const stageRect = dom.stage.getBoundingClientRect();
  const vpRect = dom.viewport.getBoundingClientRect();
  if (
    !stageRect.width ||
    clientX < stageRect.left ||
    clientX > stageRect.right ||
    clientY < stageRect.top ||
    clientY > stageRect.bottom
  ) {
    dom.loupeCanvas.classList.remove("visible");
    return;
  }

  dom.loupeCanvas.classList.add("visible");
  dom.loupeCanvas.style.left = `${clientX - vpRect.left}px`;
  dom.loupeCanvas.style.top = `${clientY - vpRect.top}px`;

  const normX = (clientX - stageRect.left) / stageRect.width;
  const normY = (clientY - stageRect.top) / stageRect.height;

  const size = 180;
  const zoomFactor = 4;
  const ctx = dom.loupeCanvas.getContext("2d");
  ctx.clearRect(0, 0, size, size);

  if (state.activeBackdrop === "checker") {
    ctx.fillStyle = getLoupeCheckerPattern(ctx);
  } else {
    ctx.fillStyle = state.activeBackdrop;
  }
  ctx.fillRect(0, 0, size, size);

  const drawMagnifiedSource = (imgEl) => {
    const imgW = imgEl.naturalWidth;
    const imgH = imgEl.naturalHeight;
    if (!imgW || !imgH) return;

    const sampleW = (size / stageRect.width) * (imgW / zoomFactor);
    const sampleH = (size / stageRect.height) * (imgH / zoomFactor);
    const sx = normX * imgW - sampleW / 2;
    const sy = normY * imgH - sampleH / 2;

    // "low" keeps a full-res 4x sample cheap enough to run per mousemove.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "low";
    ctx.drawImage(imgEl, sx, sy, sampleW, sampleH, 0, 0, size, size);
  };

  if (state.viewMode === "original") {
    drawMagnifiedSource(dom.beforeImg);
  } else if (state.viewMode === "split" && normX * 100 < state.splitPercent) {
    drawMagnifiedSource(dom.beforeImg);
  } else {
    drawMagnifiedSource(dom.afterImg);
  }
}

/** Repositions the split-view divider and clip path from a pointer x-coordinate. */
export function handleSplitDrag(clientX) {
  if (state.loupeEnabled || !state.isDraggingSplit || state.viewMode !== "split") return;
  const rect = dom.stage.getBoundingClientRect();
  if (!rect.width) return;

  const rawPct = ((clientX - rect.left) / rect.width) * 100;
  state.splitPercent = Math.max(0, Math.min(100, rawPct));
  renderStageGeometry();
}
